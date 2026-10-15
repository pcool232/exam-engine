'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const exams = require('../src/models/exams');

test('cleanSubject trims and collapses whitespace', () => {
  assert.equal(exams.cleanSubject('  Maths   Paper  1  '), 'Maths Paper 1');
  assert.equal(exams.cleanSubject(null), '');
});

test('subjectKey is case-insensitive and falls back to NO_SUBJECT', () => {
  assert.equal(exams.subjectKey('Maths'), exams.subjectKey('maths'));
  assert.equal(exams.subjectKey(''), exams.NO_SUBJECT.toLowerCase());
});

test('groupBySubject groups papers, sorts subjects alphabetically, and puts "Other papers" last', () => {
  const groups = exams.groupBySubject([
    { id: 1, title: 'B Paper', subject: 'Science', question_count: 5, my_attempts: 0, best_percentage: null },
    { id: 2, title: 'A Paper', subject: 'Science', question_count: 5, my_attempts: 1, best_percentage: 80 },
    { id: 3, title: 'Loose Paper', subject: '', question_count: 5, my_attempts: 0, best_percentage: null },
    { id: 4, title: 'Art Paper', subject: 'Art', question_count: 5, my_attempts: 0, best_percentage: null },
  ]);

  assert.deepEqual(groups.map((g) => g.name), ['Art', 'Science', exams.NO_SUBJECT]);

  const science = groups.find((g) => g.name === 'Science');
  // Papers within a subject are sorted by title.
  assert.deepEqual(science.papers.map((p) => p.title), ['A Paper', 'B Paper']);
  assert.equal(science.paperCount, 2);
  assert.equal(science.attemptedCount, 1);
  assert.equal(science.bestAverage, 80);
  assert.equal(science.label, 'Science Exam Papers');

  const other = groups.find((g) => g.name === exams.NO_SUBJECT);
  assert.equal(other.label, exams.NO_SUBJECT); // no "Exam Papers" suffix for the catch-all
});

test('describe() uses the written description when there is one', () => {
  const text = exams.describe({ description: 'Hand-written blurb.' }, 10);
  assert.equal(text, 'Hand-written blurb.');
});

test('describe() falls back to a generated blurb with no written description', () => {
  const text = exams.describe({
    description: '', year: '2024', subject: 'Maths', duration_minutes: 60,
    questions_per_attempt: 0, show_answers: 1,
  }, 20);
  assert.match(text, /Practise the 2024 Maths paper under timed conditions\./);
  assert.match(text, /Answers and explanations follow as soon as you submit\./);
});

test('describe() mentions random draws only when fewer questions are served than exist', () => {
  const full = exams.describe({
    description: '', duration_minutes: 30, questions_per_attempt: 0, show_answers: 0,
  }, 15);
  assert.doesNotMatch(full, /drawn at random/);

  const partial = exams.describe({
    description: '', duration_minutes: 30, questions_per_attempt: 10, show_answers: 0,
  }, 40);
  assert.match(partial, /Each attempt draws 10 questions at random from a bank of 40\./);
});

test('isSamePaper matches titles ignoring case, spacing and punctuation, at the same level only', () => {
  const existing = { id: 11, title: 'Design and Technology Paper 1 (17/1) - October/November 2025', category: 'JC' };
  assert.equal(exams.isSamePaper({ title: 'design and technology paper 1 (17/1) – October / November 2025', category: 'jc' }, existing), true);
  assert.equal(exams.isSamePaper({ title: existing.title, category: 'BGCSE' }, existing), false);
  assert.equal(exams.isSamePaper({ title: 'Design and Technology Paper 1 (17/1) - October/November 2018', category: 'JC' }, existing), false);
});

test('isSamePaper matches the same subject, code and year under a different title', () => {
  const existing = { title: 'D&T 2025', subject: 'Design and Technology', exam_code: '17/1', year: 'October/November 2025', category: 'JC' };
  const incoming = { title: 'Design and Technology P1', subject: 'design and technology', examCode: '17/1', year: 'October/November 2025', category: 'JC' };
  assert.equal(exams.isSamePaper(incoming, existing), true);
  assert.equal(exams.isSamePaper({ ...incoming, year: 'October/November 2024' }, existing), false);
  // All three must be filled in -- a blank code is not evidence of a match.
  assert.equal(exams.isSamePaper({ ...incoming, examCode: '' }, { ...existing, exam_code: '' }), false);
});

test('DuplicateExamError names the exam it collides with', () => {
  const err = new exams.DuplicateExamError({ id: 11, title: 'Design and Technology Paper 1', category: 'JC' });
  assert.equal(err.code, 'DUPLICATE_EXAM');
  assert.match(err.message, /Design and Technology Paper 1.*\(JC\).*#11/);
});
