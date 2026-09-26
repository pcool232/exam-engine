'use strict';
/**
 * Database connection + schema, via `pg` (node-postgres), for a PostgreSQL
 * database -- Supabase in production, any Postgres locally.
 *
 * The schema and query text elsewhere in this app (src/models/*.js) were
 * originally written for SQLite. This file is the one place that absorbs
 * the dialect differences so the model files stay close to their original
 * shape:
 *   - `?` placeholders in query text are auto-converted to Postgres's
 *     `$1, $2, ...` here, so callers keep writing `?`.
 *   - `RETURNING id` is required in Postgres for INSERTs that want the new
 *     row's id back (there's no `lastInsertRowid`); the handful of INSERTs
 *     that need it have `RETURNING id` added directly in their SQL, and the
 *     `run()` wrapper below extracts `rows[0].id` into `lastInsertRowid` so
 *     calling code sees the same `{changes, lastInsertRowid}` shape it did
 *     under SQLite/libSQL.
 *   - `changes` is derived from `rowCount` (INSERT/UPDATE/DELETE) the same
 *     way `rowsAffected` was under libSQL.
 *
 * Every call is a network round trip (even against a local Postgres in
 * dev), so every db call in this app is async -- see src/models/ and
 * src/core/session.js.
 *
 * Connection: config.databaseUrl must be a `postgresql://` connection
 * string. For Supabase, use the *pooled* (PgBouncer, port 6543) connection
 * string in production -- see .env.example -- since a serverless platform
 * can spin up many short-lived function instances, each holding its own
 * connection.
 */

const { Pool, types } = require('pg');
const config = require('./config');

// COUNT(*) etc. come back as Postgres's `bigint` (OID 20), which the driver
// returns as a string by default (a bigint can exceed JS's safe integer
// range). This app's counts never get remotely that large, and callers
// already expect plain numbers (as they did under SQLite/libSQL), so parse
// bigint columns as JS numbers.
types.setTypeParser(20, (value) => parseInt(value, 10));
// `numeric`/`decimal` (OID 1700) -- e.g. ROUND(...) results in statistics
// queries -- similarly comes back as a string by default (it can hold more
// precision than a JS number); this app only ever uses it for percentages
// and averages, so parse it as a plain number to match pre-Postgres behaviour.
types.setTypeParser(1700, (value) => (value === null ? null : parseFloat(value)));

// Bump this whenever SCHEMA_STATEMENTS or COLUMN_MIGRATIONS below changes.
// ensureReady() uses it as a fast-path: once a warm-enough instance (or a
// previous cold start) has recorded this version, later cold starts skip
// straight past all 17 CREATE-TABLE/migration round trips with a single
// SELECT instead of re-running (and re-checking) every one of them.
const CURRENT_SCHEMA_VERSION = 4;

const SCHEMA_STATEMENTS = [
  // Tracks which schema/migration version has already been applied, so a
  // fresh serverless instance can skip the full statement list below once
  // this matches CURRENT_SCHEMA_VERSION -- see ensureReady().
  `CREATE TABLE IF NOT EXISTS schema_meta (
    id      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    full_name      TEXT    NOT NULL,
    email          TEXT    NOT NULL UNIQUE,
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
    student_number TEXT,
    category       TEXT    CHECK (category IN ('PSLE','JC','BGCSE')),
    google_sub     TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT    NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
  )`,

  // Case-insensitive uniqueness/lookup on email (Postgres has no NOCASE
  // collation) -- the app already lowercases email on insert, this index
  // is belt-and-braces against anything that slips through.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))`,

  `CREATE TABLE IF NOT EXISTS exams (
    id                    SERIAL PRIMARY KEY,
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
    created_at            TEXT    NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
    updated_at            TEXT    NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
  )`,

  `CREATE TABLE IF NOT EXISTS questions (
    id            SERIAL PRIMARY KEY,
    exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_text TEXT    NOT NULL,
    question_type TEXT    NOT NULL DEFAULT 'single' CHECK (question_type IN ('single','multiple')),
    image         TEXT,
    explanation   TEXT,
    marks         REAL    NOT NULL DEFAULT 1,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
  )`,

  `CREATE TABLE IF NOT EXISTS options (
    id          SERIAL PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    label       TEXT    NOT NULL,
    option_text TEXT    NOT NULL,
    is_correct  INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS attempts (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    status       TEXT    NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted')),
    started_at   TEXT    NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
    submitted_at TEXT,
    expires_at   BIGINT,
    question_ids TEXT    NOT NULL DEFAULT '[]',
    option_order TEXT    NOT NULL DEFAULT '{}',
    score        REAL,
    total_marks  REAL,
    percentage   REAL,
    passed       INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS answers (
    id             SERIAL PRIMARY KEY,
    attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    selected       TEXT    NOT NULL DEFAULT '[]',
    is_correct     INTEGER NOT NULL DEFAULT 0,
    marks_awarded  REAL    NOT NULL DEFAULT 0,
    UNIQUE (attempt_id, question_id)
  )`,

  // Server-side sessions (src/core/session.js). The cookie holds only this
  // id, so there's nothing for a client to tamper with.
  `CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    data        TEXT NOT NULL DEFAULT '{}',
    expires_at  BIGINT NOT NULL
  )`,

  // Internal "mail" -- a welcome message dropped into a new student's inbox
  // when their account is created, and a notice dropped into every matching
  // student's inbox when an exam they can see is published. See
  // src/models/inbox.js.
  `CREATE TABLE IF NOT EXISTS inbox_messages (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL DEFAULT 'welcome' CHECK (kind IN ('welcome','exam')),
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    exam_id    INTEGER REFERENCES exams(id) ON DELETE SET NULL,
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
  )`,

  'CREATE INDEX IF NOT EXISTS idx_questions_exam    ON questions(exam_id, position)',
  'CREATE INDEX IF NOT EXISTS idx_options_question  ON options(question_id, position)',
  'CREATE INDEX IF NOT EXISTS idx_attempts_user     ON attempts(user_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_attempts_exam     ON attempts(exam_id)',
  'CREATE INDEX IF NOT EXISTS idx_inbox_user        ON inbox_messages(user_id, created_at DESC, id DESC)',
  `CREATE INDEX IF NOT EXISTS idx_inbox_unread ON inbox_messages(user_id) WHERE is_read = 0`,
  // At most one in-progress attempt per student per exam. Without this, a
  // double-click on "Start" (two POST /exams/:id/start requests landing
  // before either INSERT commits) can create two open attempts for the same
  // pair -- startAttempt() below catches the resulting unique-violation and
  // hands back the one that won the race instead of erroring.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_open
     ON attempts(user_id, exam_id) WHERE status = 'in_progress'`,
  'CREATE INDEX IF NOT EXISTS idx_answers_attempt   ON answers(attempt_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at)',
];

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
  // "Sign in with Google" -- the account's stable Google user id, once linked.
  { table: 'users', column: 'google_sub', definition: 'TEXT' },
  // Pass mark frozen at attempt-start time, same reasoning as question_ids/
  // option_order: without this, an admin editing an exam's pass mark while a
  // student has it open would grade that in-flight attempt against the new
  // threshold instead of the one shown when the student started. NULL on
  // attempts created before this column existed -- submitAttempt() falls
  // back to the exam's current pass_mark for those.
  { table: 'attempts', column: 'pass_mark', definition: 'INTEGER' },
  // "Forgot password?" reset links (see lib/mailer.js, routes/auth.js).
  // Only the SHA-256 hash of the token is stored, alongside when it expires
  // (epoch ms, same convention as attempts.expires_at); both are cleared as
  // soon as the token is used, or a password is changed any other way.
  { table: 'users', column: 'reset_token_hash', definition: 'TEXT' },
  { table: 'users', column: 'reset_token_expires', definition: 'BIGINT' },
];

/** Converts this app's `?` placeholders to Postgres's `$1, $2, ...`. */
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** INSERT/UPDATE/DELETE result shape this app expects, from a pg QueryResult. */
function normaliseRunResult(result) {
  return {
    changes: result.rowCount || 0,
    lastInsertRowid: result.rows && result.rows[0] && result.rows[0].id !== undefined
      ? result.rows[0].id
      : undefined,
  };
}

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error(
      'No database configured. Set DATABASE_URL to a PostgreSQL connection string ' +
      '(see .env.example -- a Supabase project gives you one under ' +
      'Project Settings -> Database -> Connection string).'
    );
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax || 5,
    // Fail fast rather than hang. On serverless, a connection attempt that
    // just hangs (network blip, Supabase project mid-wake-from-pause, a
    // transient DNS hiccup) would otherwise sit there until the platform's
    // own function timeout kills the whole invocation -- slow, unclear to
    // debug, and it burns the request without ever producing a real error.
    // 8s is generous for a normal connection but short enough that a genuine
    // problem surfaces as a proper error response instead.
    connectionTimeoutMillis: 8000,
    // The above only bounds *opening* a connection -- once a query is sent
    // over an already-open one, there was no limit at all on how long it
    // could sit waiting for a reply. Over Supabase's pooled (PgBouncer)
    // connection, a slot that goes stale between Vercel invocations can
    // accept a query and then never answer it, so the request just hangs
    // until Vercel's own platform timeout kills the function -- which is
    // exactly what a "white screen that never resolves" looks like from the
    // browser, however clean the code here is. Both of the following bound
    // that: query_timeout cancels client-side after 10s if Postgres hasn't
    // replied; statement_timeout tells Postgres itself to give up server-side
    // (belt and braces -- covers a query that reached the server but got
    // stuck there, which query_timeout alone wouldn't catch as cleanly).
    query_timeout: 10000,
    statement_timeout: 10000,
    // A connection that's sat idle in the pool for a while is more likely to
    // be one PgBouncer has already quietly dropped -- recycling it well
    // before that (default is 10 minutes) means the next checkout gets a
    // fresh connection instead of a stale one that immediately errors out.
    idleTimeoutMillis: 20000,
  });
  pool.on('error', (err) => {
    // An idle client emitting an error (e.g. connection dropped by the
    // server) shouldn't crash the process -- the pool creates a new one on
    // the next checkout.
    console.error('[db] idle client error:', err);
  });
  return pool;
}

// Internal helpers used only while creating the schema/running migrations --
// these bypass ensureReady() below (they run *during* readiness itself, so
// waiting on it here would deadlock).
async function rawQuery(sql, params = []) {
  // pg only uses its simple query protocol (which allows a semicolon-
  // separated string of several statements, as the schema/migration setup
  // above relies on) when `.query()` is called with no params argument at
  // all -- passing even an empty array switches it to the prepared-
  // statement protocol, which rejects multiple commands outright. Every
  // other caller here does pass real params and is unaffected.
  return params.length === 0
    ? getPool().query(convertPlaceholders(sql))
    : getPool().query(convertPlaceholders(sql), params);
}

async function columnExists(table, column) {
  const result = await rawQuery(
    'SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
    [table, column]
  );
  return result.rows.length > 0;
}

async function applyMigrations() {
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    if (!(await columnExists(table, column))) {
      await rawQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[db] added ${table}.${column}`);
    }
  }
  // Needs users.reset_token_hash to already exist, so this runs after the
  // migration loop above rather than living in SCHEMA_STATEMENTS (which runs
  // before it, and would fail on a database migrating up from version 2).
  await rawQuery(
    'CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token_hash) WHERE reset_token_hash IS NOT NULL'
  );
}

let ready = null;

/**
 * Resolves once the schema exists and migrations have run (a no-op after
 * the first call). Every public db call waits on this first, so nothing has
 * to worry about start-up ordering -- including a cold-started serverless
 * function that's never touched the database before.
 *
 * (A batched, single-round-trip version of this was tried and reverted --
 * Supabase's Transaction pooler, which this app's DATABASE_URL points at,
 * has known restrictions around multi-statement queries under transaction
 * pooling, and there was no safe way to verify that against the real
 * pooler from the environment this was written in. One statement per
 * round trip is slower on a cold start but is the version actually proven
 * to work against production. If cold-start latency on the first request
 * to a fresh instance turns out to matter in practice, revisit this with
 * a way to test against the real Supabase pooler first.)
 *
 * Deliberately doesn't cache a *failed* attempt: `ready` used to be set
 * unconditionally on the first call and never touched again, so a single
 * transient failure here (a dropped connection during a cold start, the
 * database briefly unreachable) would wedge every future call on that same
 * warm serverless instance -- they'd all `await` the same already-rejected
 * promise forever, with no way to recover short of the platform eventually
 * recycling the container. Clearing `ready` on failure means the next call
 * gets a clean retry instead.
 */
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      // Fast path: a single query. schema_meta won't exist yet on a
      // brand-new database (a bare 42P01 "relation does not exist"), and
      // that -- like a version mismatch -- just falls through to the full
      // path below, so this can never wedge a fresh install.
      try {
        const row = await rawQuery('SELECT version FROM schema_meta WHERE id = 1')
          .then((r) => r.rows[0]);
        if (row && row.version === CURRENT_SCHEMA_VERSION) return;
      } catch {
        // schema_meta doesn't exist yet (or some other transient read
        // error) -- fall through and let the full path below create it.
      }

      for (const statement of SCHEMA_STATEMENTS) {
        await rawQuery(statement);
      }
      await applyMigrations();

      await rawQuery(
        `INSERT INTO schema_meta (id, version) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
        [CURRENT_SCHEMA_VERSION]
      );
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** One row, or null. */
async function get(sql, params = []) {
  await ensureReady();
  const result = await rawQuery(sql, params);
  return result.rows.length ? result.rows[0] : null;
}

/** All matching rows. */
async function all(sql, params = []) {
  await ensureReady();
  const result = await rawQuery(sql, params);
  return result.rows;
}

/** INSERT/UPDATE/DELETE. Returns { changes, lastInsertRowid }. */
async function run(sql, params = []) {
  await ensureReady();
  const result = await rawQuery(sql, params);
  return normaliseRunResult(result);
}

/** Waits for the database to be ready, then returns { get, all, run }. */
async function getDb() {
  await ensureReady();
  return { get, all, run };
}

/**
 * Runs a function inside a single atomic transaction. The function receives
 * { get, all, run } bound to that transaction -- use those inside it, not
 * the top-level get/all/run, so every statement is part of the same
 * transaction (a transaction is its own connection, separate from the
 * pool's top-level query()).
 */
async function transaction(fn) {
  await ensureReady();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const txHelpers = {
      get: async (sql, params = []) => {
        const result = await client.query(convertPlaceholders(sql), params);
        return result.rows.length ? result.rows[0] : null;
      },
      all: async (sql, params = []) => {
        const result = await client.query(convertPlaceholders(sql), params);
        return result.rows;
      },
      run: async (sql, params = []) => normaliseRunResult(await client.query(convertPlaceholders(sql), params)),
    };
    const result = await fn(txHelpers);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

async function closeDb() {
  if (pool) {
    const p = pool;
    pool = null;
    ready = null;
    await p.end();
  }
}

module.exports = { getDb, get, all, run, transaction, closeDb };
