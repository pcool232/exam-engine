'use strict';

const { get, all, run, transaction } = require('../db');
const { CATEGORIES, cleanCategory } = require('./users');

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Postgres equivalent of SQLite's `datetime('now')`, same string shape. */
const NOW_SQL = "TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolInt(value) {
  return value === true || value === 1 || value === '1' || value === 'on' || value === 'true' ? 1 : 0;
}

/* ----------------------------------------------------------- exams ----- */

async function createExam(data, createdBy) {
  const result = await run(
    `INSERT INTO exams (title, exam_code, subject, category, description, year, duration_minutes, pass_mark,
                        questions_per_attempt, shuffle_questions, shuffle_options, show_answers,
                        is_published, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      String(data.title || '').trim(),
      data.examCode ? String(data.examCode).trim() : null,
      cleanSubject(data.subject) || null,
      cleanCategory(data.category),
      data.description ? String(data.description).trim() : null,
      data.year ? String(data.year).trim() : null,
      Math.max(0, toInt(data.durationMinutes, 60)),
      Math.min(100, Math.max(0, toInt(data.passMark, 50))),
      Math.max(0, toInt(data.questionsPerAttempt, 0)),
      boolInt(data.shuffleQuestions),
      boolInt(data.shuffleOptions),
      boolInt(data.showAnswers),
      boolInt(data.isPublished),
      createdBy || null,
    ]
  );
  return findExam(result.lastInsertRowid);
}

async function updateExam(id, data) {
  await run(
    `UPDATE exams SET title = ?, exam_code = ?, subject = ?, category = ?, description = ?, year = ?,
                      duration_minutes = ?, pass_mark = ?, questions_per_attempt = ?,
                      shuffle_questions = ?, shuffle_options = ?, show_answers = ?,
                      is_published = ?, updated_at = ${NOW_SQL}
     WHERE id = ?`,
    [
      String(data.title || '').trim(),
      data.examCode ? String(data.examCode).trim() : null,
      cleanSubject(data.subject) || null,
      cleanCategory(data.category),
      data.description ? String(data.description).trim() : null,
      data.year ? String(data.year).trim() : null,
      Math.max(0, toInt(data.durationMinutes, 60)),
      Math.min(100, Math.max(0, toInt(data.passMark, 50))),
      Math.max(0, toInt(data.questionsPerAttempt, 0)),
      boolInt(data.shuffleQuestions),
      boolInt(data.shuffleOptions),
      boolInt(data.showAnswers),
      boolInt(data.isPublished),
      Number(id),
    ]
  );
  return findExam(id);
}

async function findExam(id) {
  return (await get('SELECT * FROM exams WHERE id = ?', [Number(id)])) || null;
}

async function deleteExam(id) {
  await run('DELETE FROM exams WHERE id = ?', [Number(id)]);
}

async function setPublished(id, published) {
  await run(`UPDATE exams SET is_published = ?, updated_at = ${NOW_SQL} WHERE id = ?`, [published ? 1 : 0, Number(id)]);
}

async function listExams({ publishedOnly = false, search = '' } = {}) {
  const like = `%${search.trim()}%`;
  return all(
    `SELECT e.*,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
            (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'submitted') AS attempt_count
     FROM exams e
     WHERE (? = 0 OR e.is_published = 1)
       AND (? = '' OR e.title ILIKE ? OR COALESCE(e.exam_code,'') ILIKE ?
            OR COALESCE(e.subject,'') ILIKE ?)
     ORDER BY e.updated_at DESC, e.id DESC`,
    [publishedOnly ? 1 : 0, search.trim(), like, like, like]
  );
}

/**
 * Exams a student can see, with that student's best result attached.
 *
 * Hard-filtered by category: a JC student's list never includes a BGCSE
 * paper, even by direct request -- there is no "show all levels" toggle.
 * A student with no category set yet (pre-category account, or mid-signup)
 * sees nothing until one is chosen.
 */
async function listExamsForStudent(userId, category) {
  const clean = cleanCategory(category);
  if (!clean) return [];
  return all(
    `SELECT e.*,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
            (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'submitted') AS my_attempts,
            (SELECT MAX(a.percentage) FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'submitted') AS best_percentage,
            (SELECT a.id FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'in_progress'
              ORDER BY a.id DESC LIMIT 1) AS open_attempt_id
     FROM exams e
     WHERE e.is_published = 1
       AND e.category = ?
       AND (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) > 0
     ORDER BY LOWER(e.title)`,
    [Number(userId), Number(userId), Number(userId), clean]
  );
}

/* ------------------------------------------------------- questions ----- */

/** `db` is an optional { get, all, run } -- pass a transaction's handle to
 *  keep this call inside that transaction (see addQuestionsBulk). */
async function nextPosition(examId, db = { get, all, run }) {
  const row = await db.get('SELECT COALESCE(MAX(position), 0) AS p FROM questions WHERE exam_id = ?', [Number(examId)]);
  return (row?.p || 0) + 1;
}

async function touchExam(examId, db = { get, all, run }) {
  await db.run(`UPDATE exams SET updated_at = ${NOW_SQL} WHERE id = ?`, [Number(examId)]);
}

/**
 * Insert one question with its options.
 * options: [{ text, isCorrect, label? }]
 * `db` is an optional { get, all, run } -- pass a transaction's handle to
 * keep this call inside that transaction (see addQuestionsBulk).
 */
async function addQuestion(examId, { text, type = 'single', explanation = null, marks = 1, options = [], position = null, image = null }, db = { get, all, run }) {
  const questionType = type === 'multiple' ? 'multiple' : 'single';
  const pos = position === null ? await nextPosition(examId, db) : toInt(position, 0);

  const result = await db.run(
    `INSERT INTO questions (exam_id, question_text, question_type, image, explanation, marks, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      Number(examId),
      String(text).trim(),
      questionType,
      image ? String(image).trim() : null,
      explanation ? String(explanation).trim() : null,
      Number(marks) > 0 ? Number(marks) : 1,
      pos,
    ]
  );

  const questionId = Number(result.lastInsertRowid);
  let index = 0;
  for (const option of options) {
    await db.run(
      `INSERT INTO options (question_id, label, option_text, is_correct, position)
       VALUES (?, ?, ?, ?, ?)`,
      [
        questionId,
        option.label || LABELS[index] || String(index + 1),
        String(option.text).trim(),
        option.isCorrect ? 1 : 0,
        index + 1,
      ]
    );
    index++;
  }

  await touchExam(examId, db);
  return questionId;
}

/** Replace a question and all of its options. */
async function updateQuestion(questionId, { text, type, explanation, marks, options, image = null }) {
  return transaction(async (tx) => {
    const existing = await tx.get('SELECT exam_id FROM questions WHERE id = ?', [Number(questionId)]);
    if (!existing) throw new Error('Question not found');

    await tx.run(
      `UPDATE questions SET question_text = ?, question_type = ?, image = ?, explanation = ?, marks = ?
       WHERE id = ?`,
      [
        String(text).trim(),
        type === 'multiple' ? 'multiple' : 'single',
        image ? String(image).trim() : null,
        explanation ? String(explanation).trim() : null,
        Number(marks) > 0 ? Number(marks) : 1,
        Number(questionId),
      ]
    );

    await tx.run('DELETE FROM options WHERE question_id = ?', [Number(questionId)]);
    let index = 0;
    for (const option of options) {
      await tx.run(
        `INSERT INTO options (question_id, label, option_text, is_correct, position)
         VALUES (?, ?, ?, ?, ?)`,
        [
          Number(questionId),
          option.label || LABELS[index] || String(index + 1),
          String(option.text).trim(),
          option.isCorrect ? 1 : 0,
          index + 1,
        ]
      );
      index++;
    }

    await tx.run(`UPDATE exams SET updated_at = ${NOW_SQL} WHERE id = ?`, [existing.exam_id]);
    return existing.exam_id;
  });
}

// Importing one question and its options at a time (the shape addQuestion()
// uses) means a paper of N questions costs roughly 1 + 5N awaited network
// round trips to Postgres -- fine locally, but easily enough to blow past a
// Vercel serverless function's execution time limit on a paper with more
// than a few dozen questions, since every round trip pays full network
// latency (Vercel's function region vs Supabase's database region). This
// bulk path instead inserts a whole batch of questions in one multi-row
// INSERT, and a whole batch of their options in a second one -- a handful of
// round trips total for the entire paper, not thousands.
const BULK_BATCH_SIZE = 200;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/** Bulk insert (used by the importer). Returns the number of questions saved. */
async function addQuestionsBulk(examId, questions) {
  if (questions.length === 0) return 0;

  return transaction(async (tx) => {
    let position = await nextPosition(examId, tx);
    let saved = 0;

    for (const batch of chunk(questions, BULK_BATCH_SIZE)) {
      // One multi-row INSERT for every question in this batch, in order --
      // Postgres returns RETURNING rows for a plain VALUES-list INSERT in
      // the same order the rows were listed, so questionRows[i] is batch[i].
      const qPlaceholders = [];
      const qParams = [];
      for (const question of batch) {
        const questionType = question.type === 'multiple' ? 'multiple' : 'single';
        qPlaceholders.push('(?, ?, ?, ?, ?, ?, ?)');
        qParams.push(
          Number(examId),
          String(question.text).trim(),
          questionType,
          question.image ? String(question.image).trim() : null,
          question.explanation ? String(question.explanation).trim() : null,
          Number(question.marks) > 0 ? Number(question.marks) : 1,
          position++,
        );
      }
      const questionRows = await tx.all(
        `INSERT INTO questions (exam_id, question_text, question_type, image, explanation, marks, position)
         VALUES ${qPlaceholders.join(', ')}
         RETURNING id`,
        qParams
      );

      // One multi-row INSERT for every option across every question in this
      // batch.
      const oPlaceholders = [];
      const oParams = [];
      batch.forEach((question, qi) => {
        const questionId = Number(questionRows[qi].id);
        (question.options || []).forEach((option, index) => {
          oPlaceholders.push('(?, ?, ?, ?, ?)');
          oParams.push(
            questionId,
            option.label || LABELS[index] || String(index + 1),
            String(option.text).trim(),
            option.isCorrect ? 1 : 0,
            index + 1,
          );
        });
      });
      if (oPlaceholders.length) {
        await tx.run(
          `INSERT INTO options (question_id, label, option_text, is_correct, position)
           VALUES ${oPlaceholders.join(', ')}`,
          oParams
        );
      }

      saved += questionRows.length;
    }

    await touchExam(examId, tx);
    return saved;
  });
}

async function findQuestion(questionId) {
  const question = await get('SELECT * FROM questions WHERE id = ?', [Number(questionId)]);
  if (!question) return null;
  question.options = await all('SELECT * FROM options WHERE question_id = ? ORDER BY position, id', [Number(questionId)]);
  return question;
}

async function listQuestions(examId) {
  const questions = await all('SELECT * FROM questions WHERE exam_id = ? ORDER BY position, id', [Number(examId)]);
  if (questions.length === 0) return [];

  const options = await all(
    `SELECT o.* FROM options o
     JOIN questions q ON q.id = o.question_id
     WHERE q.exam_id = ? ORDER BY o.position, o.id`,
    [Number(examId)]
  );

  const byQuestion = new Map();
  for (const option of options) {
    if (!byQuestion.has(option.question_id)) byQuestion.set(option.question_id, []);
    byQuestion.get(option.question_id).push(option);
  }
  for (const question of questions) {
    question.options = byQuestion.get(question.id) || [];
  }
  return questions;
}

async function deleteQuestion(questionId) {
  const row = await get('SELECT exam_id FROM questions WHERE id = ?', [Number(questionId)]);
  await run('DELETE FROM questions WHERE id = ?', [Number(questionId)]);
  if (row) await touchExam(row.exam_id);
}

async function deleteAllQuestions(examId) {
  await run('DELETE FROM questions WHERE exam_id = ?', [Number(examId)]);
  await touchExam(examId);
}

async function moveQuestion(questionId, direction) {
  return transaction(async (tx) => {
    const current = await tx.get('SELECT * FROM questions WHERE id = ?', [Number(questionId)]);
    if (!current) return;
    const neighbour = await tx.get(
      `SELECT * FROM questions
       WHERE exam_id = ? AND position ${direction === 'up' ? '<' : '>'} ?
       ORDER BY position ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1`,
      [current.exam_id, current.position]
    );
    if (!neighbour) return;
    await tx.run('UPDATE questions SET position = ? WHERE id = ?', [neighbour.position, current.id]);
    await tx.run('UPDATE questions SET position = ? WHERE id = ?', [current.position, neighbour.id]);
  });
}

const NO_SUBJECT = 'Other papers';

/** Tidy a subject as typed: trim, and collapse runs of spaces. */
function cleanSubject(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

/** Case-insensitive key, so "maths" and "Maths" are the same subject. */
function subjectKey(value) {
  return cleanSubject(value).toLowerCase() || NO_SUBJECT.toLowerCase();
}

/** Every subject that has at least one exam, for pick-lists and filters. */
async function subjectsInUse({ publishedOnly = false } = {}) {
  const rows = await all(
    `SELECT DISTINCT TRIM(subject) AS subject FROM exams
     WHERE TRIM(COALESCE(subject, '')) <> ''
       AND (? = 0 OR is_published = 1)`,
    [publishedOnly ? 1 : 0]
  );
  // Sorted here rather than in SQL: Postgres requires a SELECT DISTINCT's
  // ORDER BY expressions to appear in the select list verbatim, so a
  // case-insensitive sort can't be expressed as `ORDER BY LOWER(subject)`
  // alongside `DISTINCT TRIM(subject)`.
  return rows.map((row) => row.subject).sort((a, b) => a.localeCompare(b));
}

/**
 * Gather a list of exams into subjects, keeping each subject's papers in
 * title order. One subject may hold many papers, and a paper without a
 * subject falls into "Other papers" rather than disappearing.
 */
function groupBySubject(list) {
  const groups = new Map();

  for (const exam of list) {
    const key = subjectKey(exam.subject);
    if (!groups.has(key)) {
      groups.set(key, { key, name: cleanSubject(exam.subject) || NO_SUBJECT, papers: [] });
    }
    groups.get(key).papers.push(exam);
  }

  return [...groups.values()]
    .map((group) => {
      const scored = group.papers
        .map((paper) => paper.best_percentage)
        .filter((value) => value !== null && value !== undefined);
      return {
        ...group,
        // "Design and Technology" -> "Design and Technology Exam Papers", but
        // the "Other papers" catch-all is left as-is (no subject to name).
        label: group.name === NO_SUBJECT ? group.name : `${group.name} Exam Papers`,
        papers: group.papers.sort((a, b) => a.title.localeCompare(b.title)),
        paperCount: group.papers.length,
        attemptedCount: group.papers.filter((paper) => paper.my_attempts > 0).length,
        questionCount: group.papers.reduce((sum, paper) => sum + (paper.question_count || 0), 0),
        bestAverage: scored.length
          ? Math.round((scored.reduce((sum, value) => sum + value, 0) / scored.length) * 10) / 10
          : null,
        openAttemptId: (group.papers.find((paper) => paper.open_attempt_id) || {}).open_attempt_id || null,
      };
    })
    .sort((a, b) => {
      // "Other papers" always last; everything else alphabetical.
      if (a.name === NO_SUBJECT) return 1;
      if (b.name === NO_SUBJECT) return -1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * What students read under an exam's title.
 *
 * Uses the description the administrator wrote; when that is blank, writes one
 * from the paper's own facts so the card is never empty. Worked out at display
 * time rather than stored, so it stays true if the settings change later.
 *
 * Synchronous -- every caller already has a question count in hand (either
 * passed in, or on `exam.question_count` from the query that loaded it), so
 * this never needs to touch the database itself.
 */
function describe(exam, questionCount) {
  const written = String(exam.description || '').trim();
  if (written) return written;

  const total = Number.isFinite(questionCount)
    ? questionCount
    : Number(exam.question_count) || 0;

  const sentences = [];

  // The card already shows the count, the time and the pass mark, so the
  // description says the things it does not.
  const paper = [String(exam.year || '').trim(), String(exam.subject || '').trim()]
    .filter(Boolean).join(' ');

  sentences.push(
    (paper ? `Practise the ${paper} paper` : 'Practise this paper') +
    (exam.duration_minutes > 0 ? ' under timed conditions.' : ' at your own pace.')
  );

  const served = exam.questions_per_attempt > 0
    ? Math.min(exam.questions_per_attempt, total)
    : total;
  if (total > 0 && served < total) {
    sentences.push(`Each attempt draws ${served} question${served === 1 ? '' : 's'} at random from a bank of ${total}.`);
  }

  if (exam.show_answers) {
    sentences.push('Answers and explanations follow as soon as you submit.');
  }

  return sentences.join(' ');
}

async function countQuestions(examId) {
  const row = await get('SELECT COUNT(*) AS n FROM questions WHERE exam_id = ?', [Number(examId)]);
  return row.n;
}

module.exports = {
  LABELS,
  createExam, updateExam, findExam, deleteExam, setPublished,
  listExams, listExamsForStudent,
  addQuestion, addQuestionsBulk, updateQuestion, findQuestion, listQuestions,
  deleteQuestion, deleteAllQuestions, moveQuestion, countQuestions, nextPosition,
  describe, groupBySubject, subjectsInUse, subjectKey, cleanSubject, NO_SUBJECT,
  CATEGORIES,
};
