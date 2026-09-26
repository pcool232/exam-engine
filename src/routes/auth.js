'use strict';

const users = require('../models/users');
const inbox = require('../models/inbox');
const config = require('../config');
const { checkPasswordStrength, generateResetToken, hashResetToken } = require('../lib/password');
const { verifyGoogleIdToken } = require('../lib/google-auth');
const { sendMail } = require('../lib/mailer');
const { escapeHtml } = require('../core/template');
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

/** Drops the one-time welcome message into a new student's inbox (see
 *  models/inbox.js). Never blocks or fails account creation -- a missed
 *  welcome note isn't worth turning a successful signup into an error. */
async function sendWelcomeMessage(user) {
  if (user.role !== 'student') return;
  try {
    await inbox.send(user.id, {
      kind: 'welcome',
      title: `Welcome to ${config.appName}`,
      body: `Hi ${user.full_name}, your account is ready. `
        + `Head to your dashboard to start practising past papers`
        + (user.category ? ` for ${user.category}.` : ' -- choose an exam level first if you haven’t already.'),
    });
  } catch (err) {
    console.error('[auth] failed to send welcome inbox message:', err);
  }
}

/** Best-effort absolute origin for the current request, used to build a
 *  password reset link that works whether it's opened from localhost, a
 *  Vercel preview URL, or the real domain -- there's no single "the app's
 *  URL" to hard-code, since the same code runs behind all three. */
function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  return `${String(proto).split(',')[0].trim()}://${req.headers.host}`;
}

function register(app) {
  /* ------------------------------------------------------------ login -- */

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(landingFor(req.user));
    return res.render('auth/login', {
      title: 'Sign in',
      nextUrl: safeNext(req.query.next) || '',
      values: {},
      errors: [],
    });
  });

  app.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const nextUrl = safeNext(req.body.next);

    const user = await users.authenticate(email, password);
    if (!user) {
      return res.status(401).render('auth/login', {
        title: 'Sign in',
        nextUrl: nextUrl || '',
        values: { email },
        errors: ['That email address and password combination is not correct.'],
      });
    }

    // New session id on privilege change guards against session fixation.
    await req.regenerateSession({ userId: user.id });
    return res.redirect(nextUrl || landingFor(user));
  });

  /* -------------------------------------------------------- forgot pw -- */
  // Self-service reset via a one-time emailed link (see lib/mailer.js).
  // If this deployment has no SMTP configured, the link is logged to the
  // server console instead -- and an administrator can always reset a
  // student's password directly from /admin/students without email at all.

  app.get('/forgot-password', (req, res) => {
    if (req.user) return res.redirect(landingFor(req.user));
    return res.render('auth/forgot-password', {
      title: 'Forgot your password?',
      values: {}, errors: [], sent: false,
    });
  });

  app.post('/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim();

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).render('auth/forgot-password', {
        title: 'Forgot your password?',
        values: { email }, errors: ['Please enter a valid email address.'], sent: false,
      });
    }

    const user = await users.findByEmail(email);
    // Same response whether or not the address has an account -- so this
    // page can't be used to find out which emails are registered. A
    // Google-only account (users.createFromGoogle) has no usable password
    // to reset, so it's quietly skipped rather than sending a dead-end link.
    if (user && user.is_active && !user.google_sub) {
      const { token, hash } = generateResetToken();
      const expiresAt = Date.now() + config.resetTokenTtlMinutes * 60 * 1000;
      await users.setResetToken(user.id, hash, expiresAt);

      const resetUrl = `${requestOrigin(req)}/reset-password/${token}`;
      const name = escapeHtml(user.full_name);
      const appName = escapeHtml(config.appName);

      try {
        await sendMail({
          to: user.email,
          subject: `Reset your ${config.appName} password`,
          text: `Hi ${user.full_name},\n\n`
            + `Someone asked to reset the password on your ${config.appName} account. `
            + `If that was you, open this link within ${config.resetTokenTtlMinutes} minutes to choose a new password:\n\n${resetUrl}\n\n`
            + `If you didn't ask for this, you can ignore this email -- your password hasn't changed.`,
          html: `<p>Hi ${name},</p>`
            + `<p>Someone asked to reset the password on your ${appName} account. `
            + `If that was you, open this link within ${config.resetTokenTtlMinutes} minutes to choose a new password:</p>`
            + `<p><a href="${resetUrl}">${resetUrl}</a></p>`
            + `<p>If you didn't ask for this, you can ignore this email — your password hasn't changed.</p>`,
        });
      } catch (err) {
        // Never surface a delivery failure here -- it would tell a visitor
        // this email address exists. Logged for an administrator to notice
        // (e.g. SMTP credentials have gone stale).
        console.error('[auth] failed to send password reset email:', err);
      }
    }

    return res.render('auth/forgot-password', {
      title: 'Forgot your password?',
      values: {}, errors: [], sent: true,
    });
  });

  /* -------------------------------------------------------- reset pw -- */

  app.get('/reset-password/:token', async (req, res) => {
    const user = await users.findByResetTokenHash(hashResetToken(req.params.token));
    return res.status(user ? 200 : 400).render('auth/reset-password', {
      title: 'Reset your password',
      token: req.params.token,
      valid: Boolean(user),
      errors: [],
    });
  });

  app.post('/reset-password/:token', async (req, res) => {
    const user = await users.findByResetTokenHash(hashResetToken(req.params.token));
    if (!user) {
      return res.status(400).render('auth/reset-password', {
        title: 'Reset your password', token: req.params.token, valid: false, errors: [],
      });
    }

    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    const errors = [];
    const strength = checkPasswordStrength(password);
    if (strength) errors.push(strength);
    if (password !== confirmPassword) errors.push('The two passwords do not match.');

    if (errors.length > 0) {
      return res.status(400).render('auth/reset-password', {
        title: 'Reset your password', token: req.params.token, valid: true, errors,
      });
    }

    await users.updatePassword(user.id, password);
    await req.regenerateSession({ userId: user.id });
    setFlash(req, 'success', 'Your password has been changed.');
    return res.redirect(landingFor(user));
  });

  /* -------------------------------------------------------- google sso -- */
  // Posted by the hidden form in views/partials/google-signin.html once
  // Google's own button has produced a signed credential. Works whether the
  // visitor was on the login page or the register page -- either way, an
  // unrecognised Google account is simply created on the spot (there is
  // nothing else to ask it for; the exam-level gate in requireStudent picks
  // up from there).

  app.post('/auth/google', async (req, res) => {
    if (!config.googleClientId) {
      const err = new Error('Google sign-in is not set up on this site.');
      err.statusCode = 404;
      throw err;
    }

    const nextUrl = safeNext(req.body.next);
    const fail = (message) => {
      setFlash(req, 'error', message);
      return res.redirect(nextUrl ? `/login?next=${encodeURIComponent(nextUrl)}` : '/login');
    };

    const profile = await verifyGoogleIdToken(req.body.credential, config.googleClientId);
    if (!profile) {
      return fail('Google sign-in did not go through. Please try again.');
    }

    let user = await users.findByGoogleSub(profile.sub);
    if (!user) {
      const existing = await users.findByEmail(profile.email);
      if (existing) {
        user = await users.linkGoogleSub(existing.id, profile.sub);
      } else if (!config.allowRegistration) {
        return fail('Self-registration is switched off. Ask your administrator for an account.');
      } else {
        user = await users.createFromGoogle({ fullName: profile.name, email: profile.email, googleSub: profile.sub });
        await sendWelcomeMessage(user);
      }
    }

    if (!user.is_active) {
      return fail('This account has been disabled. Contact your administrator.');
    }

    await req.regenerateSession({ userId: user.id });
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
    return res.render('auth/register', {
      title: 'Create an account', values: {}, errors: [], categories: users.CATEGORIES,
    });
  });

  app.post('/register', async (req, res) => {
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
    if (errors.length === 0 && (await users.findByEmail(values.email))) {
      errors.push('An account with that email address already exists.');
    }

    if (errors.length > 0) {
      return res.status(400).render('auth/register', {
        title: 'Create an account', values, errors, categories: users.CATEGORIES,
      });
    }

    const user = await users.create({
      fullName: values.fullName,
      email: values.email,
      password,
      studentNumber: values.studentNumber || null,
      category: values.category,
      role: 'student',
    });
    await sendWelcomeMessage(user);

    await req.regenerateSession({ userId: user.id });
    setFlash(req, 'success', `Welcome, ${user.full_name}. Your account is ready.`);
    return res.redirect('/dashboard');
  });

  /* ----------------------------------------------------------- logout -- */

  app.post('/logout', async (req, res) => {
    await req.session.destroy();
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
    return res.render('auth/choose-category', {
      title: req.user.category ? 'Change exam level' : 'Choose your exam',
      categories: users.CATEGORIES,
      isFirstTime: !req.user.category,
      errors: [],
    });
  });

  app.post('/account/category', async (req, res) => {
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

    await users.setCategory(req.user.id, category);
    setFlash(req, 'success', `You're all set up for ${category}.`);
    return res.redirect('/dashboard');
  });

  /* -------------------------------------------------------- password -- */

  app.get('/account', (req, res) => {
    if (!req.user) return res.redirect('/login');
    return res.render('auth/account', { title: 'My account', errors: [] });
  });

  app.post('/account/password', async (req, res) => {
    if (!req.user) return res.redirect('/login');

    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    const confirm = String(req.body.confirmPassword || '');

    const errors = [];
    if (!(await users.authenticate(req.user.email, current))) errors.push('Your current password is not correct.');
    const strength = checkPasswordStrength(next);
    if (strength) errors.push(strength);
    if (next !== confirm) errors.push('The two new passwords do not match.');

    if (errors.length > 0) {
      return res.status(400).render('auth/account', { title: 'My account', errors });
    }

    await users.updatePassword(req.user.id, next);
    setFlash(req, 'success', 'Your password has been changed.');
    return res.redirect('/account');
  });
}

module.exports = { register, landingFor, sendWelcomeMessage };
