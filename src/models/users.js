'use strict';

const crypto = require('node:crypto');
const { get, all, run } = require('../db');
const { hashPassword, verifyPassword } = require('../lib/password');

/** The exam levels Botswana students revise for. */
const CATEGORIES = ['PSLE', 'JC', 'BGCSE'];

function cleanCategory(value) {
  const v = String(value || '').trim().toUpperCase();
  return CATEGORIES.includes(v) ? v : null;
}

async function findByEmail(email) {
  return (await get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [String(email || '').trim()])) || null;
}

async function findById(id) {
  return (await get('SELECT * FROM users WHERE id = ?', [Number(id)])) || null;
}

async function findByGoogleSub(sub) {
  if (!sub) return null;
  return (await get('SELECT * FROM users WHERE google_sub = ?', [String(sub)])) || null;
}

async function create({ fullName, email, password, role = 'student', studentNumber = null, category = null }) {
  const result = await run(
    `INSERT INTO users (full_name, email, password_hash, role, student_number, category)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      String(fullName).trim(),
      String(email).trim().toLowerCase(),
      hashPassword(password),
      role,
      studentNumber ? String(studentNumber).trim() : null,
      cleanCategory(category),
    ]
  );
  return findById(result.lastInsertRowid);
}

/**
 * Creates a student account from a verified Google sign-in. There is no
 * password to set, so a random, unguessable one is stored in its place --
 * the account simply can't be signed into with a password until the
 * student sets one (not offered yet; Google sign-in is the only way in for
 * these accounts today).
 */
async function createFromGoogle({ fullName, email, googleSub }) {
  const unusablePassword = crypto.randomBytes(32).toString('hex');
  const result = await run(
    `INSERT INTO users (full_name, email, password_hash, role, google_sub)
     VALUES (?, ?, ?, 'student', ?)
     RETURNING id`,
    [
      String(fullName || email).trim(),
      String(email).trim().toLowerCase(),
      hashPassword(unusablePassword),
      String(googleSub),
    ]
  );
  return findById(result.lastInsertRowid);
}

/** Links a Google account to an existing (email/password) user record. */
async function linkGoogleSub(userId, googleSub) {
  await run('UPDATE users SET google_sub = ? WHERE id = ?', [String(googleSub), Number(userId)]);
  return findById(userId);
}

/** Sets or changes a student's exam level. */
async function setCategory(userId, category) {
  const clean = cleanCategory(category);
  if (!clean) return null;
  await run('UPDATE users SET category = ? WHERE id = ?', [clean, Number(userId)]);
  return findById(userId);
}

async function authenticate(email, password) {
  const user = await findByEmail(email);
  if (!user) {
    // Constant-ish work even when the account does not exist.
    verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
    return null;
  }
  if (!user.is_active) return null;
  return verifyPassword(password, user.password_hash) ? user : null;
}

async function updatePassword(userId, newPassword) {
  // Also clears any outstanding "forgot password" reset link -- a password
  // changed by any route (this one, the admin's direct reset, or a reset
  // link itself) should invalidate every other pending way to change it.
  await run(
    'UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?',
    [hashPassword(newPassword), Number(userId)]
  );
}

/** Stores the hash of a "forgot password" reset token and when it expires
 *  (epoch ms). See lib/password.js#generateResetToken. */
async function setResetToken(userId, tokenHash, expiresAt) {
  await run(
    'UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?',
    [tokenHash, Number(expiresAt), Number(userId)]
  );
}

/** Looks a user up by the hash of a reset token, honouring its expiry.
 *  Returns null for an unknown, already-used, or expired token. */
async function findByResetTokenHash(tokenHash) {
  const user = await get('SELECT * FROM users WHERE reset_token_hash = ?', [String(tokenHash)]);
  if (!user || !user.reset_token_expires || Number(user.reset_token_expires) < Date.now()) return null;
  return user;
}

async function clearResetToken(userId) {
  await run('UPDATE users SET reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?', [Number(userId)]);
}

async function setRole(userId, role) {
  await run('UPDATE users SET role = ? WHERE id = ?', [role, Number(userId)]);
}

async function setActive(userId, isActive) {
  await run('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, Number(userId)]);
}

async function remove(userId) {
  await run('DELETE FROM users WHERE id = ?', [Number(userId)]);
}

async function listStudents({ search = '' } = {}) {
  const like = `%${search.trim()}%`;
  return all(
    `SELECT u.*,
            (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted') AS attempt_count,
            (SELECT ROUND(AVG(a.percentage)::numeric, 1) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted') AS average_score
     FROM users u
     WHERE u.role = 'student'
       AND (? = '' OR u.full_name ILIKE ? OR u.email ILIKE ?
            OR COALESCE(u.student_number,'') ILIKE ?)
     ORDER BY u.created_at DESC`,
    [search.trim(), like, like, like]
  );
}

async function listAdmins() {
  return all("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at");
}

async function countAll() {
  const students = await get("SELECT COUNT(*) AS n FROM users WHERE role = 'student'");
  const admins = await get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  return { students: students.n, admins: admins.n };
}

module.exports = {
  findByEmail, findById, findByGoogleSub, create, createFromGoogle, linkGoogleSub,
  authenticate, updatePassword,
  setResetToken, findByResetTokenHash, clearResetToken,
  setRole, setActive, remove, listStudents, listAdmins, countAll,
  setCategory, cleanCategory, CATEGORIES,
};
