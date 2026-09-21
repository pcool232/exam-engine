'use strict';
/** Attempts: starting an exam, saving answers, and automatic marking. */

const crypto = require('node:crypto');
const { getDb, transaction } = require('../db');
const exams = require('./exams');

/** Fisher-Yates using crypto randomness. */
function shuffle(items) {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Create an attempt. The selection and ordering of questions/options is frozen
 * at start time so a refresh never reshuffles the paper mid-exam.
 */
function startAttempt(userId, exam) {
  const all = exams.listQuestions(exam.id);
  if (all.length === 0) throw new Error('This exam has no questions yet.');

  let selected = exam.shuffle_questions ? shuffle(all) : all;
  if (exam.questions_per_attempt > 0 && exam.questions_per_attempt < selected.length) {
    selected = selected.slice(0, exam.questions_per_attempt);
  }

  const optionOrder = {};
  for (const question of selected) {
    const ordered = exam.shuffle_options ? shuffle(question.options) : question.options;
    optionOrder[question.id] = ordered.map((option) => option.id);
  }

  const expiresAt = exam.duration_minutes > 0
    ? Date.now() + exam.duration_minutes * 60 * 1000
    : null;

  const result = getDb().prepare(`
    INSERT INTO attempts (user_id, exam_id, status, expires_at, question_ids, option_order)
    VALUES (?, ?, 'in_progress', ?, ?, ?)
  `).run(
    Number(userId),
    Number(exam.id),
    expiresAt,
    JSON.stringify(selected.map((q) => q.id)),
    JSON.stringify(optionOrder)
  );

  return findAttempt(result.lastInsertRowid);
}

function findAttempt(id) {
  const attempt = getDb().prepare('SELECT * FROM attempts WHERE id = ?').get(Number(id));
  if (!attempt) return null;
  attempt.questionIds = parseJson(attempt.question_ids, []);
  attempt.optionOrder = parseJson(attempt.option_order, {});
  return attempt;
}

function findOpenAttempt(userId, examId) {
  const row = getDb().prepare(`
    SELECT id FROM attempts
    WHERE user_id = ? AND exam_id = ? AND status = 'in_progress'
    ORDER BY id DESC LIMIT 1
  `).get(Number(userId), Number(examId));
  return row ? findAttempt(row.id) : null;
}

/** Questions for an attempt, in the frozen order, with options in frozen order. */
function getAttemptQuestions(attempt) {
  if (attempt.questionIds.length === 0) return [];
  const db = getDb();
  const placeholders = attempt.questionIds.map(() => '?').join(',');
  const questions = db
    .prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`)
    .all(...attempt.questionIds);
  const options = db
    .prepare(`SELECT * FROM options WHERE question_id IN (${placeholders})`)
    .all(...attempt.questionIds);

  const optionsByQuestion = new Map();
  for (const option of options) {
    if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
    optionsByQuestion.get(option.question_id).push(option);
  }

  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = [];
  for (const questionId of attempt.questionIds) {
    const question = byId.get(questionId);
    if (!question) continue; // deleted after the attempt started
    const available = optionsByQuestion.get(questionId) || [];
    const frozenOrder = attempt.optionOrder[String(questionId)] || attempt.optionOrder[questionId];
    if (Array.isArray(frozenOrder)) {
      const optionById = new Map(available.map((o) => [o.id, o]));
      question.options = frozenOrder.map((id) => optionById.get(id)).filter(Boolean);
      // Any option added after the attempt started goes on the end.
      for (const option of available) {
        if (!frozenOrder.includes(option.id)) question.options.push(option);
      }
    } else {
      question.options = available.sort((a, b) => a.position - b.position);
    }
    ordered.push(question);
  }
  return ordered;
}

/** Answers already saved for an attempt, keyed by question id. */
function getSavedAnswers(attemptId) {
  const rows = getDb()
    .prepare('SELECT question_id, selected FROM answers WHERE attempt_id = ?')
    .all(Number(attemptId));
  const map = new Map();
  for (const row of rows) map.set(row.question_id, parseJson(row.selected, []));
  return map;
}

/** Store a student's selection for one question (no marking yet). */
function saveAnswer(attemptId, questionId, selectedOptionIds) {
  const selected = JSON.stringify(
    [...new Set((selectedOptionIds || []).map(Number).filter(Number.isFinite))]
  );
  getDb().prepare(`
    INSERT INTO answers (attempt_id, question_id, selected)
    VALUES (?, ?, ?)
    ON CONFLICT (attempt_id, question_id) DO UPDATE SET selected = excluded.selected
  `).run(Number(attemptId), Number(questionId), selected);
}

/**
 * Mark an attempt and store the result.
 * `responses` is a Map/object of questionId -> array of option ids.
 */
function submitAttempt(attempt, responses) {
  return transaction((db) => {
    const questions = getAttemptQuestions(attempt);
    const exam = exams.findExam(attempt.exam_id);

    const upsertAnswer = db.prepare(`
      INSERT INTO answers (attempt_id, question_id, selected, is_correct, marks_awarded)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (attempt_id, question_id) DO UPDATE SET
        selected = excluded.selected,
        is_correct = excluded.is_correct,
        marks_awarded = excluded.marks_awarded
    `);

    let score = 0;
    let totalMarks = 0;

    for (const question of questions) {
      const marks = Number(question.marks) || 1;
      totalMarks += marks;

      const rawSelection = responses instanceof Map
        ? responses.get(question.id)
        : responses[question.id];
      const selected = [...new Set((rawSelection || []).map(Number).filter(Number.isFinite))];

      const validIds = new Set(question.options.map((o) => o.id));
      const cleanSelection = selected.filter((id) => validIds.has(id));
      const correctIds = question.options.filter((o) => o.is_correct).map((o) => o.id);

      // Correct when the selection matches the correct set exactly.
      const isCorrect =
        correctIds.length > 0 &&
        cleanSelection.length === correctIds.length &&
        correctIds.every((id) => cleanSelection.includes(id));

      const awarded = isCorrect ? marks : 0;
      score += awarded;

      upsertAnswer.run(
        attempt.id,
        question.id,
        JSON.stringify(cleanSelection),
        isCorrect ? 1 : 0,
        awarded
      );
    }

    const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 1000) / 10 : 0;
    const passed = percentage >= (exam?.pass_mark ?? 50) ? 1 : 0;

    db.prepare(`
      UPDATE attempts
      SET status = 'submitted', submitted_at = datetime('now'),
          score = ?, total_marks = ?, percentage = ?, passed = ?
      WHERE id = ?
    `).run(score, totalMarks, percentage, passed, attempt.id);

    return { score, totalMarks, percentage, passed: Boolean(passed) };
  });
}

/** Full result detail for the review screen. */
function getAttemptResult(attemptId) {
  const attempt = findAttempt(attemptId);
  if (!attempt) return null;

  const exam = exams.findExam(attempt.exam_id);
  const questions = getAttemptQuestions(attempt);
  const answers = getDb()
    .prepare('SELECT * FROM answers WHERE attempt_id = ?')
    .all(Number(attemptId));
  const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

  const review = questions.map((question, index) => {
    const answer = answerByQuestion.get(question.id);
    const selected = answer ? parseJson(answer.selected, []) : [];
    return {
      number: index + 1,
      question,
      selected,
      isCorrect: Boolean(answer?.is_correct),
      answered: selected.length > 0,
      marksAwarded: answer?.marks_awarded ?? 0,
      options: question.options.map((option) => ({
        ...option,
        chosen: selected.includes(option.id),
        correct: Boolean(option.is_correct),
      })),
    };
  });

  return {
    attempt,
    exam,
    review,
    correctCount: review.filter((r) => r.isCorrect).length,
    incorrectCount: review.filter((r) => !r.isCorrect && r.answered).length,
    unansweredCount: review.filter((r) => !r.answered).length,
  };
}

function listAttemptsForUser(userId, limit = 50) {
  return getDb().prepare(`
    SELECT a.*, e.title AS exam_title, e.exam_code, e.pass_mark
    FROM attempts a
    JOIN exams e ON e.id = a.exam_id
    WHERE a.user_id = ? AND a.status = 'submitted'
    ORDER BY a.submitted_at DESC
    LIMIT ?
  `).all(Number(userId), Number(limit));
}

function listAllAttempts({ examId = null, userId = null, limit = 200 } = {}) {
  const exam = examId ? Number(examId) : null;
  const user = userId ? Number(userId) : null;
  return getDb().prepare(`
    SELECT a.*, e.title AS exam_title, e.exam_code, u.full_name, u.email, u.student_number
    FROM attempts a
    JOIN exams e ON e.id = a.exam_id
    JOIN users u ON u.id = a.user_id
    WHERE a.status = 'submitted'
      AND (? IS NULL OR a.exam_id = ?)
      AND (? IS NULL OR a.user_id = ?)
    ORDER BY a.submitted_at DESC
    LIMIT ?
  `).all(exam, exam, user, user, Number(limit));
}

function abandonAttempt(attemptId) {
  getDb().prepare("DELETE FROM attempts WHERE id = ? AND status = 'in_progress'").run(Number(attemptId));
}

function statistics() {
  const db = getDb();
  return {
    exams: db.prepare('SELECT COUNT(*) AS n FROM exams').get().n,
    publishedExams: db.prepare('SELECT COUNT(*) AS n FROM exams WHERE is_published = 1').get().n,
    questions: db.prepare('SELECT COUNT(*) AS n FROM questions').get().n,
    attempts: db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status = 'submitted'").get().n,
    averageScore: db.prepare("SELECT ROUND(AVG(percentage), 1) AS avg FROM attempts WHERE status = 'submitted'").get().avg,
    passRate: db.prepare("SELECT ROUND(100.0 * AVG(passed), 1) AS rate FROM attempts WHERE status = 'submitted'").get().rate,
  };
}

/** Per-question difficulty for an exam, useful to spot bad imports. */
function questionPerformance(examId) {
  return getDb().prepare(`
    SELECT q.id, q.question_text, q.position,
           COUNT(ans.id) AS times_answered,
           SUM(ans.is_correct) AS times_correct,
           CASE WHEN COUNT(ans.id) = 0 THEN NULL
                ELSE ROUND(100.0 * SUM(ans.is_correct) / COUNT(ans.id), 1) END AS correct_rate
    FROM questions q
    LEFT JOIN answers ans ON ans.question_id = q.id
    LEFT JOIN attempts a ON a.id = ans.attempt_id AND a.status = 'submitted'
    WHERE q.exam_id = ?
    GROUP BY q.id
    ORDER BY correct_rate IS NULL, correct_rate ASC
  `).all(Number(examId));
}

module.exports = {
  startAttempt, findAttempt, findOpenAttempt, getAttemptQuestions, getSavedAnswers,
  saveAnswer, submitAttempt, getAttemptResult, listAttemptsForUser, listAllAttempts,
  abandonAttempt, statistics, questionPerformance, shuffle,
};
