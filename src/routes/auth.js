'use strict';

const users = require('../models/users');
const config = require('../config');
const { checkPasswordStrength } = require('../lib/password');
const { setFlash } = require('../middleware/auth');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function safeNext(value) {
  const target = String(value || '');
  // Only allow same-site relative paths.
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(target) ? target : null;
}

function landingFor(user) {
  return user.role === 'admin' ? '/admin' : '/dashboard';
}

function register(app) {
  /* ------------------------------------------------------------ login -- */

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(landingFor(req.user));
    res.render('auth/login', {
      title: 'Sign in',
      nextUrl: safeNext(req.query.next) || '',
      values: {},
      errors: [],
    });
  });

  app.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const nextUrl = safeNext(req.body.next);

    const user = users.authenticate(email, password);
    if (!user) {
      return res.status(401).render('auth/login', {
        title: 'Sign in',
        nextUrl: nextUrl || '',
        values: { email },
        errors: ['That email address and password combination is not correct.'],
      });
    }

    // New session id on privilege change guards against session fixation.
    req.regenerateSession({ userId: user.id });
    return res.redirect(nextUrl || landingFor(user));
  });

  /* --------------------------------------------------------- register -- */

  app.get('/register', (req, res) => {
    if (req.user) return res.redirect(landingFor(req.user));
    if (!config.allowRegistration) {
      return res.status(403).render('auth/login', {
        title: 'Sign in',
        nextUrl: '',
        values: {},
        errors: ['Self-registration is switched off. Ask your administrator for an account.'],
      });
    }
    res.render('auth/register', {
      title: 'Create an account', values: {}, errors: [], categories: users.CATEGORIES,
    });
  });

  app.post('/register', (req, res) => {
    if (!config.allowRegistration) {
      const err = new Error('Self-registration is switched off.');
      err.statusCode = 403;
      throw err;
    }

    const values = {
      fullName: String(req.body.fullName || '').trim(),
      email: String(req.body.email || '').trim(),
      studentNumber: String(req.body.studentNumber || '').trim(),
      category: String(req.body.category || '').trim(),
    };
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    const errors = [];
    if (values.fullName.length < 2) errors.push('Please enter your full name.');
    if (!EMAIL_PATTERN.test(values.email)) errors.push('Please enter a valid email address.');
    if (!users.cleanCategory(values.category)) errors.push('Choose which exam you are revising for: PSLE, JC or BGCSE.');
    const strength = checkPasswordStrength(password);
    if (strength) errors.push(strength);
    if (password !== confirmPassword) errors.push('The two passwords do not match.');
    if (errors.length === 0 && users.findByEmail(values.email)) {
      errors.push('An account with that email address already exists.');
    }

    if (errors.length > 0) {
      return res.status(400).render('auth/register', {
        title: 'Create an account', values, errors, categories: users.CATEGORIES,
      });
    }

    const user = users.create({
      fullName: values.fullName,
      email: values.email,
      password,
      studentNumber: values.studentNumber || null,
      category: values.category,
      role: 'student',
    });

    req.regenerateSession({ userId: user.id });
    setFlash(req, 'success', `Welcome, ${user.full_name}. Your account is ready.`);
    return res.redirect('/dashboard');
  });

  /* ----------------------------------------------------------- logout -- */

  app.post('/logout', (req, res) => {
    req.session.destroy();
    return res.redirect('/login');
  });

  /* -------------------------------------------------------- category -- */
  // Which exam a student is revising for. Every student needs one before they
  // can reach the dashboard -- for an email/password signup that happens on
  // the /register form itself; this page is the fallback for anyone who
  // doesn't have one yet (an older account from before this feature, or a
  // future social-login signup, which can't collect it during the OAuth step).

  app.get('/account/category', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'admin') return res.redirect('/admin');
    res.render('auth/choose-category', {
      title: req.user.category ? 'Change exam level' : 'Choose your exam',
      categories: users.CATEGORIES,
      isFirstTime: !req.user.category,
      errors: [],
    });
  });

  app.post('/account/category', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'admin') return res.redirect('/admin');

    const category = String(req.body.category || '').trim();
    if (!users.cleanCategory(category)) {
      return res.status(400).render('auth/choose-category', {
        title: req.user.category ? 'Change exam level' : 'Choose your exam',
        categories: users.CATEGORIES,
        isFirstTime: !req.user.category,
        errors: ['Choose PSLE, JC or BGCSE.'],
      });
    }

    users.setCategory(req.user.id, category);
    setFlash(req, 'success', `You're all set up for ${category}.`);
    return res.redirect('/dashboard');
  });

  /* -------------------------------------------------------- password -- */

  app.get('/account', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.render('auth/account', { title: 'My account', errors: [] });
  });

  app.post('/account/password', (req, res) => {
    if (!req.user) return res.redirect('/login');

    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    const confirm = String(req.body.confirmPassword || '');

    const errors = [];
    if (!users.authenticate(req.user.email, current)) errors.push('Your current password is not correct.');
    const strength = checkPasswordStrength(next);
    if (strength) errors.push(strength);
    if (next !== confirm) errors.push('The two new passwords do not match.');

    if (errors.length > 0) {
      return res.status(400).render('auth/account', { title: 'My account', errors });
    }

    users.updatePassword(req.user.id, next);
    setFlash(req, 'success', 'Your password has been changed.');
    return res.redirect('/account');
  });
}

module.exports = { register, landingFor };
