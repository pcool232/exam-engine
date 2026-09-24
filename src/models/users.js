'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db');
const { hashPassword, verifyPassword } = require('../lib/password');

/** The exam levels Botswana students revise for. */
const CATEGORIES = ['PSLE', 'JC', 'BGCSE'];

function cleanCategory(value) {
  const v = String(value || '').trim().toUpperCase();
  return CATEGORIES.includes(v) ? v : null;
}

function findByEmail(email) {
  return getDb()
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(String(email || '').trim()) || null;
}

function findById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

function findByGoogleSub(sub) {
  if (!sub) return null;
  return getDb().prepare('SELECT * FROM users WHERE google_sub = ?').get(String(sub)) || null;
}

function create({ fullName, email, password, role = 'student', studentNumber = null, category = null }) {
  const db = getDb();
  const result = db
    .prepare(`INSERT INTO users (full_name, email, password_hash, role, student_number, category)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      String(fullName).trim(),
      String(email).trim().toLowerCase(),
      hashPassword(password),
      role,
      studentNumber ? String(studentNumber).trim() : null,
      cleanCategory(category)
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
function createFromGoogle({ fullName, email, googleSub }) {
  const db = getDb();
  const unusablePassword = crypto.randomBytes(32).toString('hex');
  const result = db
    .prepare(`INSERT INTO users (full_name, email, password_hash, role, google_sub)
              VALUES (?, ?, ?, 'student', ?)`)
    .run(
      String(fullName || email).trim(),
      String(email).trim().toLowerCase(),
      hashPassword(unusablePassword),
      String(googleSub)
    );
  return findById(result.lastInsertRowid);
}

/** Links a Google account to an existing (email/password) user record. */
function linkGoogleSub(userId, googleSub) {
  getDb().prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(String(googleSub), Number(userId));
  return findById(userId);
}

/** Sets or changes a student's exam level. */
function setCategory(userId, category) {
  const clean = cleanCategory(category);
  if (!clean) return null;
  getDb().prepare('UPDATE users SET category = ? WHERE id = ?').run(clean, Number(userId));
  return findById(userId);
}

function authenticate(email, password) {
  const user = findByEmail(email);
  if (!user) {
    // Constant-ish work even when the account does not exist.
    verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
    return null;
  }
  if (!user.is_active) return null;
  return verifyPassword(password, user.password_hash) ? user : null;
}

function updatePassword(userId, newPassword) {
  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), Number(userId));
}

function setRole(userId, role) {
  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, Number(userId));
}

function setActive(userId, isActive) {
  getDb().prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, Number(userId));
}

function remove(userId) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(Number(userId));
}

function listStudents({ search = '' } = {}) {
  const db = getDb();
  const like = `%${search.trim()}%`;
  return db.prepare(`
    SELECT u.*,
           (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted') AS attempt_count,
           (SELECT ROUND(AVG(a.percentage), 1) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted') AS average_score
    FROM users u
    WHERE u.role = 'student'
      AND (? = '' OR u.full_name LIKE ? COLLATE NOCASE OR u.email LIKE ? COLLATE NOCASE
           OR IFNULL(u.student_number,'') LIKE ? COLLATE NOCASE)
    ORDER BY u.created_at DESC
  `).all(search.trim(), like, like, like);
}

function listAdmins() {
  return getDb().prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at").all();
}

function countAll() {
  const db = getDb();
  return {
    students: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n,
    admins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n,
  };
}

module.exports = {
  findByEmail, findById, findByGoogleSub, create, createFromGoogle, linkGoogleSub,
  authenticate, updatePassword,
  setRole, setActive, remove, listStudents, listAdmins, countAll,
  setCategory, cleanCategory, CATEGORIES,
};
