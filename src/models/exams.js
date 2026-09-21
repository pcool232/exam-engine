'use strict';

const { getDb, transaction } = require('../db');
const { CATEGORIES, cleanCategory } = require('./users');

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolInt(value) {
  return value === true || value === 1 || value === '1' || value === 'on' || value === 'true' ? 1 : 0;
}

/* ----------------------------------------------------------- exams ----- */

function createExam(data, createdBy) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO exams (title, exam_code, subject, category, description, year, duration_minutes, pass_mark,
                       questions_per_attempt, shuffle_questions, shuffle_options, show_answers,
                       is_published, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    createdBy || null
  );
  return findExam(result.lastInsertRowid);
}

function updateExam(id, data) {
  getDb().prepare(`
    UPDATE exams SET title = ?, exam_code = ?, subject = ?, category = ?, description = ?, year = ?,
                     duration_minutes = ?, pass_mark = ?, questions_per_attempt = ?,
                     shuffle_questions = ?, shuffle_options = ?, show_answers = ?,
                     is_published = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
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
    Number(id)
  );
  return findExam(id);
}

function findExam(id) {
  return getDb().prepare('SELECT * FROM exams WHERE id = ?').get(Number(id)) || null;
}

function deleteExam(id) {
  getDb().prepare('DELETE FROM exams WHERE id = ?').run(Number(id));
}

function setPublished(id, published) {
  getDb()
    .prepare("UPDATE exams SET is_published = ?, updated_at = datetime('now') WHERE id = ?")
    .run(published ? 1 : 0, Number(id));
}

function listExams({ publishedOnly = false, search = '' } = {}) {
  const like = `%${search.trim()}%`;
  return getDb().prepare(`
    SELECT e.*,
           (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
           (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'submitted') AS attempt_count
    FROM exams e
    WHERE (? = 0 OR e.is_published = 1)
      AND (? = '' OR e.title LIKE ? COLLATE NOCASE OR IFNULL(e.exam_code,'') LIKE ? COLLATE NOCASE
           OR IFNULL(e.subject,'') LIKE ? COLLATE NOCASE)
    ORDER BY e.updated_at DESC, e.id DESC
  `).all(publishedOnly ? 1 : 0, search.trim(), like, like, like);
}

/**
 * Exams a student can see, with that student's best result attached.
 *
 * Hard-filtered by category: a JC student's list never includes a BGCSE
 * paper, even by direct request -- there is no "show all levels" toggle.
 * A student with no category set yet (pre-category account, or mid-signup)
 * sees nothing until one is chosen.
 */
function listExamsForStudent(userId, category) {
  const clean = cleanCategory(category);
  if (!clean) return [];
  return getDb().prepare(`
    SELECT e.*,
           (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
           (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'submitted') AS my_attempts,
           (SELECT MAX(a.percentage) FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'submitted') AS best_percentage,
           (SELECT a.id FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ? AND a.status = 'in_progress'
             ORDER BY a.id DESC LIMIT 1) AS open_attempt_id
    FROM exams e
    WHERE e.is_published = 1
      AND e.category = ?
      AND (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) > 0
    ORDER BY e.title COLLATE NOCASE
  `).all(Number(userId), Number(userId), Number(userId), clean);
}

/* ------------------------------------------------------- questions ----- */

function nextPosition(examId) {
  const row = getDb()
    .prepare('SELECT IFNULL(MAX(position), 0) AS p FROM questions WHERE exam_id = ?')
    .get(Number(examId));
  return (row?.p || 0) + 1;
}

/**
 * Insert one question with its options.
 * options: [{ text, isCorrect, label? }]
 */
function addQuestion(examId, { text, type = 'single', explanation = null, marks = 1, options = [], position = null, image = null }) {
  const db = getDb();
  const questionType = type === 'multiple' ? 'multiple' : 'single';
  const pos = position === null ? nextPosition(examId) : toInt(position, 0);

  const result = db.prepare(`
    INSERT INTO questions (exam_id, question_text, question_type, image, explanation, marks, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(examId),
    String(text).trim(),
    questionType,
    image ? String(image).trim() : null,
    explanation ? String(explanation).trim() : null,
    Number(marks) > 0 ? Number(marks) : 1,
    pos
  );

  const questionId = Number(result.lastInsertRowid);
  const insertOption = db.prepare(`
    INSERT INTO options (question_id, label, option_text, is_correct, position)
    VALUES (?, ?, ?, ?, ?)
  `);
  options.forEach((option, index) => {
    insertOption.run(
      questionId,
      option.label || LABELS[index] || String(index + 1),
      String(option.text).trim(),
      option.isCorrect ? 1 : 0,
      index + 1
    );
  });

  touchExam(examId);
  return questionId;
}

/** Replace a question and all of its options. */
function updateQuestion(questionId, { text, type, explanation, marks, options, image = null }) {
  return transaction((db) => {
    const existing = db.prepare('SELECT exam_id FROM questions WHERE id = ?').get(Number(questionId));
    if (!existing) throw new Error('Question not found');

    db.prepare(`
      UPDATE questions SET question_text = ?, question_type = ?, image = ?, explanation = ?, marks = ?
      WHERE id = ?
    `).run(
      String(text).trim(),
      type === 'multiple' ? 'multiple' : 'single',
      image ? String(image).trim() : null,
      explanation ? String(explanation).trim() : null,
      Number(marks) > 0 ? Number(marks) : 1,
      Number(questionId)
    );

    db.prepare('DELETE FROM options WHERE question_id = ?').run(Number(questionId));
    const insertOption = db.prepare(`
      INSERT INTO options (question_id, label, option_text, is_correct, position)
      VALUES (?, ?, ?, ?, ?)
    `);
    options.forEach((option, index) => {
      insertOption.run(
        Number(questionId),
        option.label || LABELS[index] || String(index + 1),
        String(option.text).trim(),
        option.isCorrect ? 1 : 0,
        index + 1
      );
    });

    db.prepare("UPDATE exams SET updated_at = datetime('now') WHERE id = ?").run(existing.exam_id);
    return existing.exam_id;
  });
}

/** Bulk insert (used by the importer). Returns the number of questions saved. */
function addQuestionsBulk(examId, questions) {
  return transaction(() => {
    let saved = 0;
    let position = nextPosition(examId);
    for (const question of questions) {
      addQuestion(examId, { ...question, position: position++ });
      saved++;
    }
    return saved;
  });
}

function findQuestion(questionId) {
  const db = getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(questionId));
  if (!question) return null;
  question.options = db
    .prepare('SELECT * FROM options WHERE question_id = ? ORDER BY position, id')
    .all(Number(questionId));
  return question;
}

function listQuestions(examId) {
  const db = getDb();
  const questions = db
    .prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY position, id')
    .all(Number(examId));
  if (questions.length === 0) return [];

  const options = db
    .prepare(`SELECT o.* FROM options o
              JOIN questions q ON q.id = o.question_id
              WHERE q.exam_id = ? ORDER BY o.position, o.id`)
    .all(Number(examId));

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

function deleteQuestion(questionId) {
  const db = getDb();
  const row = db.prepare('SELECT exam_id FROM questions WHERE id = ?').get(Number(questionId));
  db.prepare('DELETE FROM questions WHERE id = ?').run(Number(questionId));
  if (row) touchExam(row.exam_id);
}

function deleteAllQuestions(examId) {
  getDb().prepare('DELETE FROM questions WHERE exam_id = ?').run(Number(examId));
  touchExam(examId);
}

function moveQuestion(questionId, direction) {
  return transaction((db) => {
    const current = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(questionId));
    if (!current) return;
    const neighbour = db.prepare(`
      SELECT * FROM questions
      WHERE exam_id = ? AND position ${direction === 'up' ? '<' : '>'} ?
      ORDER BY position ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1
    `).get(current.exam_id, current.position);
    if (!neighbour) return;
    const update = db.prepare('UPDATE questions SET position = ? WHERE id = ?');
    update.run(neighbour.position, current.id);
    update.run(current.position, neighbour.id);
  });
}

function touchExam(examId) {
  getDb().prepare("UPDATE exams SET updated_at = datetime('now') WHERE id = ?").run(Number(examId));
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
function subjectsInUse({ publishedOnly = false } = {}) {
  const rows = getDb().prepare(`
    SELECT DISTINCT TRIM(subject) AS subject FROM exams
    WHERE TRIM(IFNULL(subject, '')) <> ''
      AND (? = 0 OR is_published = 1)
    ORDER BY subject COLLATE NOCASE
  `).all(publishedOnly ? 1 : 0);
  return rows.map((row) => row.subject);
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
 */
function describe(exam, questionCount) {
  const written = String(exam.description || '').trim();
  if (written) return written;

  const total = Number.isFinite(questionCount)
    ? questionCount
    : (exam.question_count !== undefined ? Number(exam.question_count) : countQuestions(exam.id));

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

function countQuestions(examId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM questions WHERE exam_id = ?')
    .get(Number(examId)).n;
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
