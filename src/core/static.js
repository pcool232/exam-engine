'use strict';
/** Static file middleware (no dependencies). */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

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

    res.setHeader('Content-Type', MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', maxAge > 0 ? `public, max-age=${maxAge}` : 'no-cache');

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
