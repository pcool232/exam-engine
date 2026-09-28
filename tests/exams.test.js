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
