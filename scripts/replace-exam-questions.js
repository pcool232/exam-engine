#!/usr/bin/env node
'use strict';
/**
 * Replace an existing exam's questions in place, instead of creating a
 * duplicate exam. Use this when you re-import a corrected version of a
 * paper you already imported (e.g. fixed images, corrected answers).
 *
 * It finds the existing exam by matching "exam.examCode" + "exam.category"
 * from the JSON against what's already in the database (falling back to an
 * exact title match if no code is set), then:
 *   1. updates the exam's own settings (title, description, timing, etc.)
 *   2. deletes all of its current questions
 *   3. inserts the questions from the file as the new set
 *
 * The exam keeps the same id/URL, so nothing else needs to change.
 * If no matching exam exists yet, it creates one instead (same as
 * import-exam.js).
 *
 * Usage:
 *   node scripts/replace-exam-questions.js exams/some-paper.json
 *   node scripts/replace-exam-questions.js exams/some-paper.json --exam-id 3
 *   node scripts/replace-exam-questions.js exams/some-paper.json --draft
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const filePath = args.find((a) => !a.startsWith('--'));
const examIdFlagIndex = args.indexOf('--exam-id');
const forcedExamId = examIdFlagIndex !== -1 ? Number(args[examIdFlagIndex + 1]) : null;

if (!filePath) {
  console.error('Usage: node scripts/replace-exam-questions.js <exam.json> [--exam-id N] [--draft|--publish]');
  process.exit(1);
}

const resolved = path.resolve(process.cwd(), filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const { parseQuestions } = require('../src/lib/parsers');
const exams = require('../src/models/exams');

const buffer = fs.readFileSync(resolved);

let parsed;
try {
  parsed = parseQuestions(buffer, { filename: path.basename(resolved), format: 'auto' });
} catch (err) {
  console.error(`Could not read that file: ${err.message}`);
  process.exit(1);
}

if (parsed.questions.length === 0) {
  console.error('No usable questions were found in that file.');
  for (const issue of parsed.issues.slice(0, 10)) {
    console.error(`  - ${issue.reference}: ${issue.problem}`);
  }
  process.exit(1);
}

const settings = parsed.exam || {};
if (!settings.title) {
  console.error('This file has no "exam.title" of its own, so it has nothing to create an exam with.');
  process.exit(1);
}

const VALID_CATEGORIES = new Set(['PSLE', 'JC', 'BGCSE']);
const category = String(settings.category || '').trim().toUpperCase();
if (!VALID_CATEGORIES.has(category)) {
  console.error(`This file's "exam.category" is missing or not one of PSLE / JC / BGCSE (got: ${settings.category || '(none)'}).`);
  process.exit(1);
}

let isPublished = true;
if (flags.has('--draft')) isPublished = false;
if (flags.has('--publish')) isPublished = true;

const examData = {
  title: settings.title,
  examCode: settings.examCode,
  subject: settings.subject,
  category,
  year: settings.year,
  description: settings.description,
  durationMinutes: settings.durationMinutes,
  passMark: settings.passMark,
  questionsPerAttempt: settings.questionsPerAttempt,
  shuffleQuestions: settings.shuffleQuestions,
  shuffleOptions: settings.shuffleOptions,
  showAnswers: settings.showAnswers,
  isPublished,
};

function findMatch() {
  if (forcedExamId) {
    const byId = exams.findExam(forcedExamId);
    if (!byId) {
      console.error(`No exam with id ${forcedExamId} exists.`);
      process.exit(1);
    }
    return byId;
  }

  const all = exams.listExams({});
  const code = String(settings.examCode || '').trim().toLowerCase();
  if (code) {
    const byCode = all.find(
      (e) => String(e.exam_code || '').trim().toLowerCase() === code && e.category === category
    );
    if (byCode) return byCode;
  }
  const title = String(settings.title || '').trim().toLowerCase();
  const byTitle = all.find((e) => String(e.title || '').trim().toLowerCase() === title);
  if (byTitle) return byTitle;

  return null;
}

const existing = findMatch();

if (existing) {
  exams.updateExam(existing.id, examData);
  exams.deleteAllQuestions(existing.id);
  const saved = exams.addQuestionsBulk(existing.id, parsed.questions);
  console.log(`Replaced questions on "${existing.title}" (exam #${existing.id}): now ${saved} question${saved === 1 ? '' : 's'}.`);
  console.log(isPublished ? 'Published -- students can see it now.' : 'Saved as a draft -- publish it from the admin site when ready.');
} else {
  const exam = exams.createExam(examData, null);
  const saved = exams.addQuestionsBulk(exam.id, parsed.questions);
  console.log(`No existing exam matched, so a new one was created: "${exam.title}" (exam #${exam.id}) with ${saved} question${saved === 1 ? '' : 's'}.`);
  console.log(isPublished ? 'Published -- students can see it now.' : 'Saved as a draft -- publish it from the admin site when ready.');
}

if (parsed.issues.length) {
  console.log(`\n${parsed.issues.length} question${parsed.issues.length === 1 ? '' : 's'} had issues and were skipped:`);
  for (const issue of parsed.issues.slice(0, 10)) {
    console.log(`  - ${issue.reference}: ${issue.problem}`);
  }
}
