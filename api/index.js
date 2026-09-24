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
 */

const { buildApp } = require('../src/app');

const app = buildApp();

module.exports = (req, res) => {
  app.handle(req, res).catch((err) => {
    console.error('[fatal]', err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });
};
