'use strict';
/**
 * Vercel serverless entrypoint. vercel.json rewrites every path (including
 * /static/*) to this one function.
 *
 * `app` is built once per warm function instance (module scope is cached
 * between invocations on the same instance, same as any other Node
 * serverless platform), not once per request -- so the route table and
 * template cache are reused, and src/db.js's connection pool and schema
 * readiness promise persist across invocations too, the same way they
 * would in the local `server.js` process.
 *
 * buildApp() itself only wires up routes/middleware (see src/app.js) and
 * shouldn't normally throw, but it used to run directly at module scope,
 * outside of any try/catch. If it -- or one of the requires above it --
 * ever threw for any reason (even a transient one), this module would fail
 * to finish loading. A module that fails to load never gets to
 * `module.exports = ...`, so Vercel has nothing to invoke for that
 * container: it answers with its own bare 404 (empty body, no doctype)
 * before any of our code, including our own error pages, runs. That
 * failure is also sticky -- Node caches a throwing module, so the *same*
 * warm container would keep failing on every request routed to it until
 * Vercel eventually recycled it, which is exactly the "works for some
 * students, blank 404 for others, and it comes and goes" shape this bug
 * had.
 *
 * Building lazily inside the handler, with the failure caught and retried
 * on the next request instead of cached, removes that single point of
 * failure and makes any future build error show up as our own logged 500
 * page instead of a silent platform 404.
 */

const { buildApp } = require('../src/app');

let app = null;

// Deliberately doesn't cache a build failure -- only a successful build is
// remembered, so a request that hits a failed build gets a clean retry on
// the very next invocation instead of being wedged for this container's
// lifetime.
function getApp() {
  if (!app) app = buildApp();
  return app;
}

module.exports = (req, res) => {
  let instance;
  try {
    instance = getApp();
  } catch (err) {
    console.error('[fatal] app failed to build:', err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Internal server error');
    }
    return;
  }
  instance.handle(req, res).catch((err) => {
    console.error('[fatal]', err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
};
