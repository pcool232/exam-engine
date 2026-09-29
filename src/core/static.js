'use strict';
/** Static file middleware (no dependencies). */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

// Only worth gzip'ing text formats -- images/fonts are already compressed
// (or too small to bother), and gzip'ing them again just burns CPU for a
// file that comes back the same size or bigger.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.csv']);

// A student on a slow or patchy connection pays for every byte twice: once
// in time-to-first-render, and again in the odds a marginal link drops mid-
// transfer. Gzip shrinks this app's one CSS file and its small JS files by
// roughly 70% -- cheap to compute once and worth caching, since the same
// bytes go out on every cold cache / first visit / post-deploy reload.
// Keyed by absolute path; entries are revalidated against mtime+size below,
// so a changed file on disk (local dev editing app.css) is never served
// stale -- and nothing here needs an eviction policy, since this app ships
// a handful of static files totalling a few hundred KB.
const gzipCache = new Map();

async function gzippedFile(target, stat) {
  const cached = gzipCache.get(target);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.buffer;
  }
  const raw = await fsp.readFile(target);
  const buffer = await new Promise((resolve, reject) => {
    zlib.gzip(raw, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, out) => {
      if (err) reject(err); else resolve(out);
    });
  });
  gzipCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, buffer });
  return buffer;
}

function serveStatic(rootDir, { urlPrefix = '/', maxAge = 0 } = {}) {
  const root = path.resolve(rootDir);

  return async function staticMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!req.pathname.startsWith(urlPrefix)) return next();

    const relative = req.pathname.slice(urlPrefix.length).replace(/^\/+/, '');
    if (!relative) return next();

    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) return next();

    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();

    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }

    const ext = path.extname(target).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('ETag', etag);
    // `?v=` on every /static/... URL (see config.js#assetVersion) makes a
    // long cache safe: a new deploy is a new URL, so `immutable` -- skip
    // even the revalidation request entirely -- is safe to add once maxAge
    // is actually long-lived (a bare `no-cache`/dev run still revalidates
    // every time, which is what local editing needs).
    res.setHeader('Cache-Control', maxAge > 0
      ? `public, max-age=${maxAge}${maxAge >= 86400 ? ', immutable' : ''}`
      : 'no-cache');

    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const compress = acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 512;

    if (compress) {
      const gzipped = await gzippedFile(target, stat);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', gzipped.length);
      if (req.method === 'HEAD') return res.end();
      return res.end(gzipped);
    }

    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(target);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  };
}

module.exports = { serveStatic, MIME_TYPES };
