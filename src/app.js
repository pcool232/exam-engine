'use strict';
/**
 * Builds the App (middleware + routes), but does not start listening.
 * Shared by server.js (local dev / a normal Node host: calls app.listen())
 * and api/index.js (the Vercel serverless entrypoint: calls app.handle()
 * directly, once per request, against a process that Vercel itself keeps
 * warm between invocations).
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const config = require('./config');
const { App, bodyParser } = require('./core/app');
const { TemplateEngine } = require('./core/template');
const { serveStatic } = require('./core/static');
const { sessionMiddleware } = require('./core/session');
const { loadUser, verifyCsrf } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');
const { categoryIcon, categoryLabel, subjectIcon, subjectColor } = require('./lib/icons');

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
    subjectColor,
    assetVersion: config.assetVersion,
    googleClientId: config.googleClientId,
    resetTokenTtlMinutes: config.resetTokenTtlMinutes,
    contactEmail: config.contactEmail,
    nextUrl: '', // overridden by /login when it has a "next" target to preserve
    inboxUnreadCount: 0, // overridden by middleware/auth.js#loadUser for signed-in students
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

  // A full year: every /static/... link now carries ?v={{ assetVersion }}
  // (see config.js), which changes on every deploy, so a long-lived cache
  // here can never serve last week's CSS by mistake -- and a hard cache hit
  // (no request at all, not even a 304 round trip) is what actually helps a
  // student on a slow or patchy connection revisiting the site.
  app.use(serveStatic(config.publicDir, { urlPrefix: '/static', maxAge: config.isProduction ? 31536000 : 0 }));
  app.use(bodyParser);
  app.use(sessionMiddleware({
    ttlSeconds: config.sessionTtlSeconds,
    secure: config.cookieSecure,
  }));
  app.use(verifyCsrf);
  app.use(loadUser);

  /* ------------------------------------------------------------ routes -- */

  app.get('/', (req, res) => {
    // Signed-out visitors get the public landing page (views/landing.html,
    // a full standalone document -- hence no layout); signed-in users go
    // straight to where they work, as before.
    if (!req.user) return res.render('landing', {}, null);
    return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  /*
   * These three live in public/ alongside everything serveStatic() already
   * covers, but are served from the *root* path rather than under /static/
   * on purpose:
   *   - /sw.js: a service worker's default scope (what pages it can
   *     control) is the directory it's served from -- at /static/sw.js
   *     that would be /static/ only, useless for controlling navigations
   *     to /dashboard, /attempts/..., etc. Serving it at the root gives it
   *     scope "/" with no extra header needed.
   *   - /manifest.webmanifest: conventionally fetched from the site root,
   *     and needs its own MIME type (serveStatic's table doesn't special-
   *     case it, since nothing else in this app uses it).
   *   - /offline.html: the service worker's own fallback page, fetched
   *     from a specific absolute path in sw.js -- keeping it off /static/
   *     just keeps those two in the same place conceptually.
   * No-store (the default set above) is actually what you want for
   * /sw.js specifically: browsers already special-case its own update
   * check, but never risk an HTTP cache delaying that further.
   */
  app.get('/sw.js', async (req, res) => {
    const body = await fsp.readFile(path.join(config.publicDir, 'sw.js'));
    return res.send(body, 'text/javascript; charset=utf-8');
  });
  app.get('/manifest.webmanifest', async (req, res) => {
    const body = await fsp.readFile(path.join(config.publicDir, 'manifest.webmanifest'));
    return res.send(body, 'application/manifest+json; charset=utf-8');
  });
  app.get('/offline.html', async (req, res) => {
    const body = await fsp.readFile(path.join(config.publicDir, 'offline.html'));
    return res.send(body, 'text/html; charset=utf-8');
  });

  // Digital Asset Links -- proves to Android that the Play Store app
  // (a Trusted Web Activity wrapper around this same site) is allowed to
  // open rivaesa.<domain> without browser chrome. Must live at exactly
  // this path (Android fetches it from the site root, not /static/).
  // Built from config (ANDROID_PACKAGE_NAME / ANDROID_SHA256_CERT_FINGERPRINTS)
  // rather than a checked-in file, so adding Play's app-signing fingerprint
  // after upload is a Vercel setting + redeploy, not a code change. With no
  // fingerprints configured it serves an inert [].
  app.get('/.well-known/assetlinks.json', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(buildAssetLinks(config));
  });

  // Where the installed app (Play Store or "Install app" in Chrome) opens:
  // straight to the student's or admin's home if signed in, otherwise the
  // sign-in page -- not the marketing landing page that "/" shows visitors.
  // Required by Google Play for any app with accounts: a public privacy
  // policy, and a public page explaining how to get an account deleted.
  app.get('/privacy', (req, res) => res.render('legal/privacy', { title: 'Privacy policy' }));
  app.get('/account-deletion', (req, res) => res.render('legal/account-deletion', { title: 'Delete your account' }));

  app.get('/app', (req, res) => {
    if (!req.user) return res.redirect('/login');
    return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  });

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

/**
 * The Digital Asset Links statement Android checks before letting the Play
 * Store app (a Trusted Web Activity) show this site without a URL bar.
 * Exported for tests.
 */
function buildAssetLinks({ androidPackageName, androidCertFingerprints }) {
  if (!androidPackageName || !androidCertFingerprints || !androidCertFingerprints.length) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: androidPackageName,
      sha256_cert_fingerprints: androidCertFingerprints,
    },
  }];
}

module.exports = { buildApp, buildAssetLinks };
