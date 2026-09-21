'use strict';

// node:sqlite is still flagged experimental - hide only that warning.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning.stack || warning.message);
});

const config = require('./src/config');
const { getDb, closeDb } = require('./src/db');
const { App, bodyParser } = require('./src/core/app');
const { TemplateEngine } = require('./src/core/template');
const { serveStatic } = require('./src/core/static');
const { sessionMiddleware } = require('./src/core/session');
const { loadUser, verifyCsrf } = require('./src/middleware/auth');
const authRoutes = require('./src/routes/auth');
const studentRoutes = require('./src/routes/student');
const adminRoutes = require('./src/routes/admin');
const users = require('./src/models/users');

const db = getDb();

const app = new App();

app.locals = {
  appName: config.appName,
  currentUser: null,
  flash: null,
  title: config.appName,
  layoutVariant: 'default',
};

app.setTemplates(new TemplateEngine(config.viewsDir, {
  cacheTemplates: config.isProduction,
}));

/* ------------------------------------------------------------ pipeline -- */

app.use(async (req, res, next) => {
  // Small security headers - safe defaults for a self-hosted app.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  await next();
});

app.use(serveStatic(config.publicDir, { urlPrefix: '/static', maxAge: config.isProduction ? 86400 : 0 }));
app.use(bodyParser);
app.use(sessionMiddleware(db, {
  ttlSeconds: config.sessionTtlSeconds,
  secure: config.cookieSecure,
}));
app.use(verifyCsrf);
app.use(loadUser);

/* -------------------------------------------------------------- routes -- */

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
});

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

authRoutes.register(app);
studentRoutes.register(app);
adminRoutes.register(app);

/* -------------------------------------------------------------- errors -- */

app.onNotFound((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    status: 404,
    message: 'We could not find that page.',
  });
});

app.onError((err, req, res) => {
  const status = err.statusCode || 500;
  res.status(status).render('error', {
    title: status === 403 ? 'Not allowed' : 'Something went wrong',
    status,
    message: status >= 500
      ? 'Something went wrong on our side. Please try again.'
      : err.message,
  });
});

/* ------------------------------------------------------------ start up -- */

function warnIfNoAdmin() {
  const { admins } = users.countAll();
  if (admins === 0) {
    console.warn(
      '\n  No administrator account exists yet.\n' +
      '  Run:  npm run seed\n'
    );
  }
}

const server = app.listen(config.port, config.host, () => {
  warnIfNoAdmin();
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  ${config.appName} is running`);
  console.log(`  →  http://${shown}:${config.port}`);
  console.log(`  Database: ${config.databaseFile}`);
  console.log(`  Mode: ${config.env}`);
  // Routes are fixed when the process starts, so this line tells you whether
  // what is running matches the files on disk. If you have just pulled in new
  // code and a page 404s, restart (or use `npm run dev`, which restarts itself).
  console.log(`  Started ${new Date().toLocaleTimeString()} with ${app.routes.length} routes\n`);
});

function shutdown(signal) {
  console.log(`\n${signal} received - shutting down.`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
