'use strict';
/**
 * Builds the App (middleware + routes), but does not start listening.
 * Shared by server.js (local dev / a normal Node host: calls app.listen())
 * and api/index.js (the Vercel serverless entrypoint: calls app.handle()
 * directly, once per request, against a process that Vercel itself keeps
 * warm between invocations).
 */

const config = require('./config');
const { App, bodyParser } = require('./core/app');
const { TemplateEngine } = require('./core/template');
const { serveStatic } = require('./core/static');
const { sessionMiddleware } = require('./core/session');
const { loadUser, verifyCsrf } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');
const { categoryIcon, categoryLabel, subjectIcon } = require('./lib/icons');

function buildApp() {
  const app = new App();

  app.locals = {
    appName: config.appName,
    currentUser: null,
    flash: null,
    title: config.appName,
    layoutVariant: 'default',
    categoryIcon,
    categoryLabel,
    subjectIcon,
    googleClientId: config.googleClientId,
    resetTokenTtlMinutes: config.resetTokenTtlMinutes,
    nextUrl: '', // overridden by /login when it has a "next" target to preserve
    // Set by a route to a number of seconds to have the layout auto-reload
    // the page (see partials/layout.html) -- for pages showing live-ish
    // data (the admin dashboard, results) that an admin would otherwise
    // have to manually refresh to see change.
    autoRefreshSeconds: null,
  };

  app.setTemplates(new TemplateEngine(config.viewsDir, {
    cacheTemplates: config.isProduction,
  }));

  /* ---------------------------------------------------------- pipeline -- */

  app.use(async (req, res, next) => {
    // Small security headers - safe defaults for a self-hosted app.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    // Every dynamic response here depends on session/auth state (or is a
    // state-changing POST), so none of it is safe for a browser or CDN edge
    // to cache -- a cached sign-in redirect or stale CSRF/session page is
    // exactly the kind of thing that looks like an intermittent, unrelated
    // bug later. serveStatic() (registered next) overwrites this for actual
    // static files with its own Cache-Control, so this only affects the
    // dynamic routes below it.
    res.setHeader('Cache-Control', 'no-store');
    await next();
  });

  app.use(serveStatic(config.publicDir, { urlPrefix: '/static', maxAge: config.isProduction ? 86400 : 0 }));
  app.use(bodyParser);
  app.use(sessionMiddleware({
    ttlSeconds: config.sessionTtlSeconds,
    secure: config.cookieSecure,
  }));
  app.use(verifyCsrf);
  app.use(loadUser);

  /* ------------------------------------------------------------ routes -- */

  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  authRoutes.register(app);
  studentRoutes.register(app);
  adminRoutes.register(app);

  /* ------------------------------------------------------------ errors -- */

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

  return app;
}

module.exports = { buildApp };
