'use strict';

const crypto = require('node:crypto');
const users = require('../models/users');

/** Attaches req.user (or null) from the session. */
async function loadUser(req, res, next) {
  req.user = null;
  if (req.session?.userId) {
    const user = await users.findById(req.session.userId);
    if (user && user.is_active) {
      req.user = user;
    } else {
      delete req.session.userId;
      req.session.save();
    }
  }
  res.locals.currentUser = req.user;
  res.locals.flash = takeFlash(req);
  await next();
}

/** One-shot messages that survive a redirect. */
function setFlash(req, type, message) {
  req.session.flash = { type, message };
  req.session.save();
}

function takeFlash(req) {
  const flash = req.session?.flash || null;
  if (flash) {
    delete req.session.flash;
    req.session.save();
  }
  return flash;
}

function requireAuth(req, res, next) {
  if (!req.user) {
    const target = encodeURIComponent(req.pathname + (Object.keys(req.query).length
      ? `?${new URLSearchParams(req.query)}` : ''));
    return res.redirect(`/login?next=${target}`);
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    const err = new Error('You do not have permission to view that page.');
    err.statusCode = 403;
    throw err;
  }
  return next();
}

function requireStudent(req, res, next) {
  if (!req.user) return res.redirect('/login');
  // A student without an exam level (an older account, or the gap between a
  // future social-login signup and them picking one) can't see any papers --
  // send them to set it before anything else in the student area.
  if (req.user.role === 'student' && !req.user.category && req.pathname !== '/account/category') {
    return res.redirect('/account/category');
  }
  return next();
}

/** Rejects POSTs whose CSRF token does not match the session. */
async function verifyCsrf(req, res, next) {
  if (req.method !== 'POST') return next();

  const sent = req.body?._csrf || req.headers['x-csrf-token'];
  const expected = req.session?.csrfToken;

  const valid =
    typeof sent === 'string' &&
    typeof expected === 'string' &&
    sent.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));

  if (!valid) {
    const err = new Error('Your session expired or the form was stale. Please try again.');
    err.statusCode = 403;
    throw err;
  }
  return next();
}

module.exports = { loadUser, requireAuth, requireAdmin, requireStudent, verifyCsrf, setFlash };
