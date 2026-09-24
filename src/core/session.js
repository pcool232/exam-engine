'use strict';
/**
 * Server-side sessions, stored in Postgres (see the `sessions` table in
 * src/db.js).
 *
 * The cookie holds only a 256-bit random identifier, so there is nothing
 * for a client to tamper with. Session rows carry a CSRF token that every
 * state-changing form must echo back.
 *
 * Every store operation here is a network round trip, so this whole
 * middleware -- including the `res.end` override that persists a session
 * before the response is flushed -- is async. That override's promise has
 * to actually reach the dispatch loop's `await handler(req, res, next)`
 * (via `return res.send/json/redirect/render(...)` in route handlers, and
 * `return res.end(...)` in those helpers -- see src/core/app.js) rather
 * than fire-and-forget: on a serverless platform, nothing guarantees
 * pending async work keeps running once a handler function returns, so an
 * un-awaited persist can silently lose session data.
 */

const crypto = require('node:crypto');
const { get, run } = require('../db');

const COOKIE_NAME = 'revsid';
const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function newId() {
  return crypto.randomBytes(32).toString('base64url');
}

const store = {
  async read(id) {
    if (!id) return null;
    const row = await get('SELECT data, expires_at FROM sessions WHERE id = ?', [id]);
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      await run('DELETE FROM sessions WHERE id = ?', [id]);
      return null;
    }
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  },
  async write(id, data, ttlSeconds) {
    const expires = Date.now() + ttlSeconds * 1000;
    const payload = JSON.stringify(data ?? {});
    await run(
      `INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      [id, payload, expires]
    );
  },
  async destroy(id) {
    if (id) await run('DELETE FROM sessions WHERE id = ?', [id]);
  },
  async purgeExpired() {
    await run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  },
};

/**
 * Session middleware. Adds req.session (a plain object), req.session.save(),
 * req.session.destroy() (async -- callers must await it), req.regenerateSession()
 * and res.locals.csrfToken.
 */
function sessionMiddleware({ ttlSeconds = DEFAULT_TTL_SECONDS, secure = false } = {}) {
  // Opportunistic cleanup, once an hour. Errors here shouldn't crash a
  // long-running process; on serverless this interval simply never fires
  // (the instance is torn down between invocations), which is fine -- an
  // expired session row is already ignored by read() above.
  const interval = setInterval(() => {
    store.purgeExpired().catch((err) => console.error('[session] purge failed:', err));
  }, 60 * 60 * 1000);
  if (typeof interval.unref === 'function') interval.unref();

  return async function session(req, res, next) {
    let id = req.cookies[COOKIE_NAME];
    let data = await store.read(id);
    let isNew = false;

    if (!data) {
      id = newId();
      data = { csrfToken: crypto.randomBytes(24).toString('base64url') };
      isNew = true;
    }

    let dirty = isNew;
    const original = JSON.stringify(data);

    req.sessionId = id;
    req.session = data;

    req.session.save = () => { dirty = true; };

    req.session.destroy = async () => {
      await store.destroy(id);
      res.clearCookie(COOKIE_NAME, { secure });
      dirty = false;
      req.session = { csrfToken: crypto.randomBytes(24).toString('base64url') };
    };

    /** Issue a brand new session id, keeping (optionally modified) data. */
    req.regenerateSession = async (carryOver = {}) => {
      await store.destroy(id);
      id = newId();
      req.sessionId = id;
      const csrfToken = crypto.randomBytes(24).toString('base64url');
      for (const key of Object.keys(req.session)) {
        if (typeof req.session[key] !== 'function') delete req.session[key];
      }
      Object.assign(req.session, carryOver, { csrfToken });
      dirty = true;
      return req.session;
    };

    // Always reflects the current session, even after regeneration.
    Object.defineProperty(res.locals, 'csrfToken', {
      get: () => req.session.csrfToken,
      enumerable: true,
      configurable: true,
    });

    const persist = async () => {
      const serialisable = {};
      for (const [key, value] of Object.entries(req.session)) {
        if (typeof value !== 'function') serialisable[key] = value;
      }
      if (!dirty && JSON.stringify(serialisable) === original) return;
      await store.write(req.sessionId, serialisable, ttlSeconds);
      res.setCookie(COOKIE_NAME, req.sessionId, {
        maxAge: ttlSeconds,
        httpOnly: true,
        secure,
        sameSite: 'Lax',
      });
    };

    // Persist before the response is flushed. res.end is called at most
    // once per response in practice, but this guards against a handler
    // that calls it more than once, and against overlapping calls before
    // the first persist has resolved -- both reuse the same in-flight
    // promise rather than double-persisting.
    const originalEnd = res.end.bind(res);
    let pending = null;
    res.end = (...args) => {
      if (!pending) {
        pending = persist()
          .catch((err) => console.error('[session] save failed:', err))
          .then(() => originalEnd(...args));
      }
      return pending;
    };

    await next();
  };
}

module.exports = { sessionMiddleware, COOKIE_NAME };
