'use strict';
/**
 * JSON import.
 *
 * The file may carry the exam's own settings, so that a single upload creates
 * the exam and its questions together:
 *
 *   {
 *     "exam": {
 *       "title": "Design and Technology Paper 1",
 *       "code": "17/1", "subject": "Design and Technology", "category": "JC", "year": "Nov 2018",
 *       "durationMinutes": 60, "passMark": 50,
 *       "shuffleQuestions": false, "shuffleOptions": false, "showAnswers": true
 *     },
 *     "questions": [ ... ]
 *   }
 *
 * "exam" may also be a plain string, in which case it is the title.
 *
 * Accepts an array (or { questions: [...] }) where each entry looks like:
 *
 *   {
 *     "question": "What is 2 + 2?",
 *     "type": "single",                 // optional: single | multiple
 *     "options": ["3", "4", "5"],       // or [{ "text": "4", "correct": true }]
 *     "correct": ["B"],                 // labels, 0-based indexes, or full text
 *     "explanation": "Basic addition",  // optional
 *     "marks": 1,                       // optional
 *     "image": "data:image/jpeg;base64,…"  // optional: a diagram for the question
 *   }                                       (a "/static/…" or "https://…" URL also works)
 */

const { resolveAnswerLabels } = require('./text');

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return undefined;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  return fallback;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Exam settings carried by the file itself, so that one upload can create the
 * exam as well as its questions. `exam` may be a string (just the title) or an
 * object; the settings may also sit at the top level of the document.
 */
function readExamSettings(data) {
  if (Array.isArray(data) || !data || typeof data !== 'object') return null;

  const source = data.exam && typeof data.exam === 'object' ? data.exam : data;
  const title = String(
    (typeof data.exam === 'string' ? data.exam : null) ||
    firstDefined(source, ['title', 'name', 'exam_title', 'examTitle']) || ''
  ).trim();

  if (!title) return null;

  const settings = { title };

  const code = firstDefined(source, ['code', 'exam_code', 'examCode']);
  if (code !== undefined) settings.examCode = String(code).trim();

  const subject = firstDefined(source, ['subject', 'course']);
  if (subject !== undefined) settings.subject = String(subject).trim();

  // Which exam this paper belongs to: PSLE, JC or BGCSE.
  const category = firstDefined(source, ['category', 'level', 'examLevel', 'exam_level']);
  if (category !== undefined) settings.category = String(category).trim().toUpperCase();

  const year = firstDefined(source, ['year', 'sitting', 'session']);
  if (year !== undefined) settings.year = String(year).trim();

  const description = firstDefined(source, ['description', 'summary', 'notes']);
  if (description !== undefined) settings.description = String(description).trim();

  const duration = firstDefined(source, ['durationMinutes', 'duration_minutes', 'duration', 'timeLimit', 'time_limit']);
  if (duration !== undefined) settings.durationMinutes = Math.max(0, toNumber(duration, 60));

  const passMark = firstDefined(source, ['passMark', 'pass_mark', 'pass', 'passPercentage']);
  if (passMark !== undefined) settings.passMark = Math.min(100, Math.max(0, toNumber(passMark, 50)));

  const perAttempt = firstDefined(source, ['questionsPerAttempt', 'questions_per_attempt', 'perAttempt']);
  if (perAttempt !== undefined) settings.questionsPerAttempt = Math.max(0, toNumber(perAttempt, 0));

  for (const [key, names] of [
    ['shuffleQuestions', ['shuffleQuestions', 'shuffle_questions']],
    ['shuffleOptions', ['shuffleOptions', 'shuffle_options']],
    ['showAnswers', ['showAnswers', 'show_answers']],
  ]) {
    for (const name of names) {
      if (source[name] !== undefined) {
        settings[key] = toBool(source[name], true);
        break;
      }
    }
  }

  return settings;
}

function parseJsonQuestions(text) {
  const questions = [];
  const issues = [];

  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    issues.push({ reference: 'file', problem: `Invalid JSON: ${err.message}` });
    return { questions, issues };
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.questions) ? data.questions : null;

  if (!list) {
    issues.push({
      reference: 'file',
      problem: 'Expected a JSON array of questions, or an object with a "questions" array.',
    });
    return { questions, issues };
  }

  const exam = readExamSettings(data);

  list.forEach((entry, index) => {
    const reference = `item ${index + 1}`;
    if (!entry || typeof entry !== 'object') {
      issues.push({ reference, problem: 'Not an object - skipped.' });
      return;
    }

    const questionText = String(firstDefined(entry, ['question', 'question_text', 'text', 'stem']) || '').trim();
    if (!questionText) {
      issues.push({ reference, problem: 'No question text - skipped.' });
      return;
    }

    const rawOptions = firstDefined(entry, ['options', 'choices', 'answers']);
    if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
      issues.push({ reference, problem: 'Fewer than two options - skipped.' });
      return;
    }

    const options = [];
    const inlineCorrect = [];

    rawOptions.forEach((option, optionIndex) => {
      const label = LABELS[optionIndex] || String(optionIndex + 1);
      if (option && typeof option === 'object') {
        const optionText = String(firstDefined(option, ['text', 'option', 'value', 'label_text']) || '').trim();
        if (!optionText) return;
        options.push({ label: String(option.label || label).toUpperCase(), text: optionText });
        if (option.correct === true || option.is_correct === true || option.isCorrect === true) {
          inlineCorrect.push(String(option.label || label).toUpperCase());
        }
      } else {
        const optionText = String(option ?? '').trim();
        if (optionText) options.push({ label, text: optionText });
      }
    });

    if (options.length < 2) {
      issues.push({ reference, problem: 'Fewer than two usable options - skipped.' });
      return;
    }

    let correctLabels = [...inlineCorrect];
    const rawCorrect = firstDefined(entry, ['correct', 'answer', 'answers', 'correct_answer', 'correct_answers', 'key']);

    if (rawCorrect !== undefined) {
      const tokens = Array.isArray(rawCorrect) ? rawCorrect : [rawCorrect];
      for (const token of tokens) {
        // Numeric index (0-based) is common in exported question banks.
        if (typeof token === 'number' && Number.isInteger(token) && options[token]) {
          correctLabels.push(options[token].label);
          continue;
        }
        correctLabels.push(...resolveAnswerLabels(String(token), options));
      }
    }

    correctLabels = [...new Set(correctLabels.filter((label) => options.some((o) => o.label === label)))];

    if (correctLabels.length === 0) {
      issues.push({ reference, problem: 'No correct answer could be identified - skipped.' });
      return;
    }

    const declaredType = String(firstDefined(entry, ['type', 'question_type']) || '').toLowerCase();
    const isMultiple = correctLabels.length > 1 || ['multiple', 'multi', 'checkbox'].includes(declaredType);
    const marks = Number(firstDefined(entry, ['marks', 'mark', 'points']));

    const image = String(firstDefined(entry, ['image', 'figure', 'diagram', 'image_url', 'imageUrl']) || '').trim();

    questions.push({
      text: questionText,
      type: isMultiple ? 'multiple' : 'single',
      image: image || null,
      explanation: String(firstDefined(entry, ['explanation', 'rationale', 'reason']) || '').trim() || null,
      marks: Number.isFinite(marks) && marks > 0 ? marks : 1,
      options: options.map((option) => ({
        label: option.label,
        text: option.text,
        isCorrect: correctLabels.includes(option.label),
      })),
    });
  });

  return { questions, issues, exam };
}

module.exports = { parseJsonQuestions, readExamSettings };
