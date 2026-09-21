#!/usr/bin/env node
'use strict';
/**
 * Import an exam JSON file straight into the database, no browser required.
 *
 * Usage:
 *   node scripts/import-exam.js exams/some-paper.json
 *   node scripts/import-exam.js exams/some-paper.json --publish
 *   node scripts/import-exam.js exams/some-paper.json --draft
 *
 * Runs the exact same parsing and validation as Admin -> Import an exam
 * file (src/lib/parsers + src/models/exams.js), so a file that would work
 * through the browser works the same way here. Uses the same DATABASE_FILE
 * (or .env) as the app, in WAL mode, so this is safe to run whether the
 * server is running or not -- no restart needed, the new exam shows up on
 * the next page load.
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node scripts/import-exam.js <exam.json> [--publish|--draft]');
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
  console.error('Add an "exam": { "title": "..." } block to the JSON, or use the browser import (which lets you type a title).');
  process.exit(1);
}

const VALID_CATEGORIES = new Set(['PSLE', 'JC', 'BGCSE']);
const category = String(settings.category || '').trim().toUpperCase();
if (!VALID_CATEGORIES.has(category)) {
  console.error(`This file's "exam.category" is missing or not one of PSLE / JC / BGCSE (got: ${settings.category || '(none)'}).`);
  console.error('Add "exam": { "category": "JC" } (or PSLE / BGCSE) to the JSON -- students only ever see papers for their own level, so an exam without one would never appear to anyone.');
  process.exit(1);
}

// --publish / --draft override the file; otherwise default to published, since
// that is the point of a one-step "upload and it's ready" import.
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

const exam = exams.createExam(examData, null);
const saved = exams.addQuestionsBulk(exam.id, parsed.questions);

console.log(`Created "${exam.title}" (exam #${exam.id}) with ${saved} question${saved === 1 ? '' : 's'}.`);
console.log(isPublished ? 'Published -- students can see it now.' : 'Saved as a draft -- publish it from the admin site when ready.');
if (parsed.issues.length) {
  console.log(`\n${parsed.issues.length} question${parsed.issues.length === 1 ? '' : 's'} had issues and were skipped:`);
  for (const issue of parsed.issues.slice(0, 10)) {
    console.log(`  - ${issue.reference}: ${issue.problem}`);
  }
}
console.log(`\nView it at http://localhost:3000/admin/exams/${exam.id} (no restart needed).`);
