'use strict';
/** SQLite connection + schema. Uses Node's built-in node:sqlite (Node >= 22.5). */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error(
    '\nThis application needs the built-in SQLite module (node:sqlite),\n' +
    `which requires Node.js 22.5 or newer. You are running ${process.version}.\n` +
    'Please upgrade Node.js: https://nodejs.org/en/download\n'
  );
  process.exit(1);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name      TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  student_number TEXT,
  category       TEXT    CHECK (category IN ('PSLE','JC','BGCSE')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exams (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  title                 TEXT    NOT NULL,
  exam_code             TEXT,
  subject               TEXT,
  category              TEXT    CHECK (category IN ('PSLE','JC','BGCSE')),
  description           TEXT,
  year                  TEXT,
  duration_minutes      INTEGER NOT NULL DEFAULT 60,
  pass_mark             INTEGER NOT NULL DEFAULT 50,
  questions_per_attempt INTEGER NOT NULL DEFAULT 0,
  shuffle_questions     INTEGER NOT NULL DEFAULT 1,
  shuffle_options       INTEGER NOT NULL DEFAULT 1,
  show_answers          INTEGER NOT NULL DEFAULT 1,
  is_published          INTEGER NOT NULL DEFAULT 0,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_text TEXT    NOT NULL,
  question_type TEXT    NOT NULL DEFAULT 'single' CHECK (question_type IN ('single','multiple')),
  image         TEXT,
  explanation   TEXT,
  marks         REAL    NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  option_text TEXT    NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  expires_at   INTEGER,
  question_ids TEXT    NOT NULL DEFAULT '[]',
  option_order TEXT    NOT NULL DEFAULT '{}',
  score        REAL,
  total_marks  REAL,
  percentage   REAL,
  passed       INTEGER
);

CREATE TABLE IF NOT EXISTS answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected       TEXT    NOT NULL DEFAULT '[]',
  is_correct     INTEGER NOT NULL DEFAULT 0,
  marks_awarded  REAL    NOT NULL DEFAULT 0,
  UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_questions_exam    ON questions(exam_id, position);
CREATE INDEX IF NOT EXISTS idx_options_question  ON options(question_id, position);
CREATE INDEX IF NOT EXISTS idx_attempts_user     ON attempts(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_exam     ON attempts(exam_id);
CREATE INDEX IF NOT EXISTS idx_answers_attempt   ON answers(attempt_id);
`;

/**
 * Small forward-only migrations, for databases created by an earlier version.
 * Each entry adds a column if it is not already there.
 */
const COLUMN_MIGRATIONS = [
  { table: 'questions', column: 'image', definition: 'TEXT' },
  // Exam level: Primary Leaving (PSLE), Junior Certificate (JC), or BGCSE.
  // No NOT NULL here -- existing rows land as NULL and the app gates on that
  // (students are asked to pick one; exams with no category are hidden from
  // students until an administrator sets one).
  { table: 'users', column: 'category', definition: "TEXT CHECK (category IN ('PSLE','JC','BGCSE'))" },
  { table: 'exams', column: 'category', definition: "TEXT CHECK (category IN ('PSLE','JC','BGCSE'))" },
];

function applyMigrations(database) {
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[db] added ${table}.${column}`);
    }
  }
}

let db = null;

function getDb() {
  if (db) return db;

  const dir = path.dirname(config.databaseFile);
  fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(config.databaseFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

/** Run a function inside a transaction. */
function transaction(fn) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, transaction, closeDb, SCHEMA };
