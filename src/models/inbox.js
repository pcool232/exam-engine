'use strict';
/**
 * "Internal mail" -- messages the app itself drops into a student's inbox,
 * shown on their account page (views/auth/account.html). Two kinds today:
 *   - 'welcome', sent once when a student account is created (see
 *     routes/auth.js#/register and #/auth/google, and routes/admin.js#
 *     /admin/students/new).
 *   - 'exam', sent to every student in an exam's category when an admin
 *     publishes it (see routes/admin.js#/admin/exams/:id/publish).
 * This is separate from the SMTP mailer (lib/mailer.js), which sends real
 * email -- an inbox message always lands regardless of whether SMTP is
 * configured for this deployment.
 */

const { get, all, run, transaction } = require('../db');

/** One message to one student. */
async function send(userId, { kind, title, body, examId = null }) {
  await run(
    `INSERT INTO inbox_messages (user_id, kind, title, body, exam_id) VALUES (?, ?, ?, ?, ?)`,
    [Number(userId), kind, String(title), String(body), examId ? Number(examId) : null]
  );
}

// Batched the same way exams.js#addQuestionsBulk batches question inserts --
// one multi-row INSERT per chunk instead of one round trip per recipient, so
// publishing an exam to a few hundred students in one category doesn't cost
// a few hundred sequential network round trips to Postgres.
const BATCH_SIZE = 200;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/** The same message to many students at once (e.g. everyone in an exam's category). */
async function sendToMany(userIds, { kind, title, body, examId = null }) {
  const ids = userIds.map(Number).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return 0;

  return transaction(async (tx) => {
    let sent = 0;
    for (const batch of chunk(ids, BATCH_SIZE)) {
      const placeholders = [];
      const params = [];
      for (const userId of batch) {
        placeholders.push('(?, ?, ?, ?, ?)');
        params.push(userId, kind, String(title), String(body), examId ? Number(examId) : null);
      }
      await tx.run(
        `INSERT INTO inbox_messages (user_id, kind, title, body, exam_id) VALUES ${placeholders.join(', ')}`,
        params
      );
      sent += batch.length;
    }
    return sent;
  });
}

/** Most recent messages for a student's inbox view, newest first. */
async function listForUser(userId, limit = 50) {
  return all(
    'SELECT * FROM inbox_messages WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [Number(userId), limit]
  );
}

async function unreadCount(userId) {
  const row = await get('SELECT COUNT(*) AS n FROM inbox_messages WHERE user_id = ? AND is_read = 0', [Number(userId)]);
  return row.n;
}

/** Marks everything in a student's inbox as read (called when they view it). */
async function markAllRead(userId) {
  await run('UPDATE inbox_messages SET is_read = 1 WHERE user_id = ? AND is_read = 0', [Number(userId)]);
}

module.exports = { send, sendToMany, listForUser, unreadCount, markAllRead };
