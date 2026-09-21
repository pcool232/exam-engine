'use strict';
/**
 * CSV import (RFC 4180 compliant reader, written from scratch).
 *
 * Expected header (order does not matter, extra columns are ignored):
 *   question, option_a, option_b, option_c, option_d, option_e, correct, explanation, type, marks
 *
 * Aliases accepted for the answer column: correct, answer, correct_answer, key.
 * Options may also be named a/b/c/... or option1/option2/...
 * The answer cell may contain "B", "A,C", "AC", or the full option text.
 */

const { resolveAnswerLabels } = require('./text');

const LABELS = 'ABCDEFGHIJ';

/** Split CSV text into rows of cells, honouring quotes and embedded newlines. */
function parseCsv(text) {
  const input = String(text || '').replace(/^﻿/, ''); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function normaliseHeader(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

function buildColumnMap(header) {
  const map = { options: [], question: null, correct: null, explanation: null, type: null, marks: null, image: null };

  header.forEach((rawName, index) => {
    const name = normaliseHeader(rawName);

    if (['question', 'question_text', 'q', 'text', 'stem'].includes(name)) {
      if (map.question === null) map.question = index;
      return;
    }
    if (['correct', 'answer', 'answers', 'correct_answer', 'correct_answers', 'key', 'correct_option'].includes(name)) {
      if (map.correct === null) map.correct = index;
      return;
    }
    if (['explanation', 'rationale', 'reason', 'note', 'notes'].includes(name)) {
      if (map.explanation === null) map.explanation = index;
      return;
    }
    if (['image', 'figure', 'diagram', 'image_url'].includes(name)) { map.image = index; return; }
    if (['type', 'question_type'].includes(name)) { map.type = index; return; }
    if (['marks', 'mark', 'points', 'score'].includes(name)) { map.marks = index; return; }

    // option_a / optiona / a / option1 / choice_a ...
    const letter = name.match(/^(?:option|choice|answer)?_?([a-j])$/);
    if (letter) { map.options.push({ index, label: letter[1].toUpperCase() }); return; }
    const numbered = name.match(/^(?:option|choice|answer)_?(\d{1,2})$/);
    if (numbered) {
      const n = Number(numbered[1]);
      if (n >= 1 && n <= 10) map.options.push({ index, label: LABELS[n - 1] });
    }
  });

  map.options.sort((a, b) => a.label.localeCompare(b.label));
  return map;
}

function parseCsvQuestions(text) {
  const rows = parseCsv(text);
  const questions = [];
  const issues = [];

  if (rows.length === 0) {
    issues.push({ reference: 'file', problem: 'The file is empty.' });
    return { questions, issues };
  }

  const map = buildColumnMap(rows[0]);

  if (map.question === null || map.options.length < 2 || map.correct === null) {
    issues.push({
      reference: 'header row',
      problem:
        'Could not find the required columns. A header row is needed with at least ' +
        '"question", two option columns (option_a, option_b, ...) and "correct".',
    });
    return { questions, issues };
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const reference = `row ${i + 1}`;
    const cell = (index) => (index === null || index === undefined ? '' : String(row[index] ?? '').trim());

    const questionText = cell(map.question);
    if (!questionText) {
      issues.push({ reference, problem: 'No question text - skipped.' });
      continue;
    }

    const options = map.options
      .map(({ index, label }) => ({ label, text: cell(index) }))
      .filter((option) => option.text !== '');

    if (options.length < 2) {
      issues.push({ reference, problem: 'Fewer than two options - skipped.' });
      continue;
    }

    const correctLabels = resolveAnswerLabels(cell(map.correct), options);
    if (correctLabels.length === 0) {
      issues.push({
        reference,
        problem: `Could not match the answer "${cell(map.correct)}" to any option - skipped.`,
      });
      continue;
    }

    const declaredType = cell(map.type).toLowerCase();
    const isMultiple = correctLabels.length > 1 ||
      ['multiple', 'multi', 'many', 'checkbox'].includes(declaredType);

    const marks = Number(cell(map.marks));

    questions.push({
      text: questionText,
      type: isMultiple ? 'multiple' : 'single',
      image: cell(map.image) || null,
      explanation: cell(map.explanation) || null,
      marks: Number.isFinite(marks) && marks > 0 ? marks : 1,
      options: options.map((option) => ({
        label: option.label,
        text: option.text,
        isCorrect: correctLabels.includes(option.label),
      })),
    });
  }

  return { questions, issues };
}

module.exports = { parseCsv, parseCsvQuestions };
