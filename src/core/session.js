'use strict';
/**
 * Server-side sessions stored in SQLite.
 *
 * The cookie holds only a 256-bit random identifier, so there is nothing
 * for a client to tamper with. Session rows carry a CSRF token that every
 * state-changing form must echo back.
 */

const crypto = require('node:crypto');

const COOKIE_NAME = 'revsid';
const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function newId() {
  return crypto.randomBytes(32).toString('base64url');
}

function createSessionStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      data        TEXT NOT NULL DEFAULT '{}',
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  const statements = {
    get: db.prepare('SELECT data, expires_at FROM sessions WHERE id = ?'),
    insert: db.prepare('INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?)'),
    update: db.prepare('UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM sessions WHERE id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  return {
    read(id) {
      if (!id) return null;
      const row = statements.get.get(id);
      if (!row) return null;
      if (row.expires_at < Date.now()) {
        statements.remove.run(id);
        return null;
      }
      try {
        return JSON.parse(row.data);
      } catch {
        return null;
      }
    },
    write(id, data, ttlSeconds) {
      const expires = Date.now() + ttlSeconds * 1000;
      const payload = JSON.stringify(data ?? {});
      const result = statements.update.run(payload, expires, id);
      if (result.changes === 0) statements.insert.run(id, payload, expires);
    },
    destroy(id) {
      if (id) statements.remove.run(id);
    },
    purgeExpired() {
      statements.purge.run(Date.now());
    },
  };
}

/**
 * Session middleware. Adds req.session (a plain object), req.session.save(),
 * req.session.destroy(), req.regenerateSession() and res.locals.csrfToken.
 */
function sessionMiddleware(db, { ttlSeconds = DEFAULT_TTL_SECONDS, secure = false } = {}) {
  const store = createSessionStore(db);

  // Opportunistic cleanup, once an hour.
  setInterval(() => {
    try { store.purgeExpired(); } catch { /* ignore */ }
  }, 60 * 60 * 1000).unref();

  return async function session(req, res, next) {
    let id = req.cookies[COOKIE_NAME];
    let data = store.read(id);
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

    req.session.destroy = () => {
      store.destroy(id);
      res.clearCookie(COOKIE_NAME, { secure });
      dirty = false;
      req.session = { csrfToken: crypto.randomBytes(24).toString('base64url') };
    };

    /** Issue a brand new session id, keeping (optionally modified) data. */
    req.regenerateSession = (carryOver = {}) => {
      store.destroy(id);
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

    const persist = () => {
      const serialisable = {};
      for (const [key, value] of Object.entries(req.session)) {
        if (typeof value !== 'function') serialisable[key] = value;
      }
      if (!dirty && JSON.stringify(serialisable) === original) return;
      store.write(req.sessionId, serialisable, ttlSeconds);
      res.setCookie(COOKIE_NAME, req.sessionId, {
        maxAge: ttlSeconds,
        httpOnly: true,
        secure,
        sameSite: 'Lax',
      });
    };

    // Persist before the response is flushed.
    const originalEnd = res.end.bind(res);
    let persisted = false;
    res.end = (...args) => {
      if (!persisted) {
        persisted = true;
        try { persist(); } catch (err) { console.error('[session] save failed:', err); }
      }
      return originalEnd(...args);
    };

    await next();
  };
}

module.exports = { sessionMiddleware, COOKIE_NAME };
