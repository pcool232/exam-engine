'use strict';
/**
 * A tiny fixed-window rate limiter backed by Postgres (see AGENTS.md -- `pg`
 * is the one dependency this app allows, and an in-memory counter wouldn't
 * work here anyway: this app runs as short-lived Vercel serverless
 * functions with no memory shared between invocations or instances).
 *
 * One row per limited key (e.g. "login:email:a@b.com", "login:ip:1.2.3.4").
 * A single INSERT ... ON CONFLICT does the read-check-write in one atomic
 * statement, so two concurrent requests for the same key can't both sneak
 * past the limit the way a separate SELECT-then-UPDATE could.
 */

const { run, all } = require('../db');

/**
 * Records one attempt for `key` and reports whether it's still allowed.
 * `limit` attempts are allowed per `windowMs`; the window resets the first
 * time a hit lands after the previous window has expired.
 * Returns { allowed, remaining, retryAfterMs }.
 */
async function hit(key, { limit, windowMs }) {
  const now = Date.now();
  const cutoff = now - windowMs;

  const rows = await all(
    `INSERT INTO rate_limits (key, count, window_start)
     VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= ? THEN ? ELSE rate_limits.window_start END
     RETURNING count, window_start`,
    [key, now, cutoff, cutoff, now]
  );
  const row = rows[0];

  // Opportunistic cleanup of keys nobody has hit in a day -- this table is
  // small and low-value, so a proper scheduled job would be overkill; doing
  // it inline (rarely) on a normal request keeps it from growing forever.
  if (Math.random() < 0.01) {
    await run('DELETE FROM rate_limits WHERE window_start < ?', [now - 24 * 60 * 60 * 1000]);
  }

  const allowed = row.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - row.count),
    retryAfterMs: allowed ? 0 : Math.max(0, row.window_start + windowMs - now),
  };
}

/** Clears a key's counter -- called on a successful login so a real user
 *  who mistyped their password a few times isn't left half-throttled. */
async function reset(key) {
  await run('DELETE FROM rate_limits WHERE key = ?', [key]);
}

/** Best-effort client IP: the first hop in X-Forwarded-For (set by Vercel's
 *  edge in production) or the raw socket address locally. Any single client
 *  can claim whatever X-Forwarded-For they like when talking to this app
 *  directly, but on Vercel that header is set by the platform itself, not
 *  passed through from the visitor -- this is a throttle against casual
 *  abuse, not a security boundary on its own (the CSRF token and per-email
 *  limit next to it in routes/auth.js are what actually protect an account).
 */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** A friendly "try again in N minutes" clause from a retryAfterMs value. */
function retryMessage(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`;
}

module.exports = { hit, reset, clientIp, retryMessage };
