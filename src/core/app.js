'use strict';
/**
 * A very small Express-shaped web framework built on node:http.
 * Enough for this app: middleware chain, routing with :params, response
 * helpers, template rendering, static files.
 */

const http = require('node:http');
const { parseBody } = require('./body');

function compilePath(pattern) {
  const keys = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([A-Za-z_][\w]*)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
  return { regex: new RegExp(`^${source}/?$`), keys };
}

function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

class App {
  constructor() {
    this.middleware = [];
    this.routes = [];
    this.templates = null;
    this.locals = {};
    this.errorHandler = null;
    this.notFoundHandler = null;
  }

  use(handler) {
    this.middleware.push(handler);
    return this;
  }

  route(method, pattern, ...handlers) {
    const { regex, keys } = compilePath(pattern);
    this.routes.push({ method, pattern, regex, keys, handlers });
    return this;
  }

  get(pattern, ...handlers) { return this.route('GET', pattern, ...handlers); }
  post(pattern, ...handlers) { return this.route('POST', pattern, ...handlers); }

  setTemplates(engine) { this.templates = engine; return this; }
  onError(handler) { this.errorHandler = handler; return this; }
  onNotFound(handler) { this.notFoundHandler = handler; return this; }

  decorate(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    req.pathname = decodeURIComponent(url.pathname);
    req.query = Object.fromEntries(url.searchParams.entries());
    req.cookies = parseCookies(req.headers.cookie);
    req.params = Object.create(null);
    req.app = this;

    res.locals = { ...this.locals };

    res.status = (code) => { res.statusCode = code; return res; };

    res.setCookie = (name, value, options = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`];
      parts.push(`Path=${options.path || '/'}`);
      if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
      if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
      if (options.httpOnly !== false) parts.push('HttpOnly');
      if (options.secure) parts.push('Secure');
      parts.push(`SameSite=${options.sameSite || 'Lax'}`);
      const existing = res.getHeader('Set-Cookie');
      const cookie = parts.join('; ');
      res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : [cookie]);
      return res;
    };

    res.clearCookie = (name, options = {}) =>
      res.setCookie(name, '', { ...options, maxAge: 0 });

    res.send = (body, contentType = 'text/html; charset=utf-8') => {
      if (res.writableEnded) return res;
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', payload.length);
      res.end(req.method === 'HEAD' ? undefined : payload);
      return res;
    };

    res.json = (data, code) => {
      if (code) res.statusCode = code;
      return res.send(JSON.stringify(data), 'application/json; charset=utf-8');
    };

    res.redirect = (location, code = 302) => {
      res.statusCode = code;
      res.setHeader('Location', location);
      res.end();
      return res;
    };

    res.render = (view, data = {}, layout = 'partials/layout') => {
      if (!this.templates) throw new Error('No template engine configured');
      const html = this.templates.render(view, { ...res.locals, ...data }, layout);
      return res.send(html);
    };
  }

  async handle(req, res) {
    this.decorate(req, res);

    const stack = [...this.middleware];
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let matchedPath = false;

    for (const route of this.routes) {
      const match = route.regex.exec(req.pathname);
      if (!match) continue;
      matchedPath = true;
      if (route.method !== method) continue;
      route.keys.forEach((key, i) => {
        req.params[key] = decodeURIComponent(match[i + 1]);
      });
      stack.push(...route.handlers);
      matchedPath = 'exact';
      break;
    }

    if (matchedPath !== 'exact') {
      stack.push(async (rq, rs) => {
        const err = new Error(matchedPath ? 'Method not allowed' : 'Page not found');
        err.statusCode = matchedPath ? 405 : 404;
        throw err;
      });
    }

    let index = 0;
    const next = async () => {
      if (index >= stack.length) return;
      const handler = stack[index++];
      await handler(req, res, next);
    };

    try {
      await next();
      if (!res.writableEnded) {
        // A handler finished without responding.
        const err = new Error('Page not found');
        err.statusCode = 404;
        throw err;
      }
    } catch (err) {
      await this.handleError(err, req, res);
    }
  }

  async handleError(err, req, res) {
    const status = err.statusCode || err.status || 500;
    if (status >= 500) {
      console.error(`[error] ${req.method} ${req.pathname}:`, err);
    }
    if (res.writableEnded) return;
    res.statusCode = status;
    try {
      if (status === 404 && this.notFoundHandler) {
        await this.notFoundHandler(req, res);
        return;
      }
      if (this.errorHandler) {
        await this.errorHandler(err, req, res);
        return;
      }
    } catch (handlerErr) {
      console.error('[error] error handler failed:', handlerErr);
    }
    if (!res.writableEnded) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(status === 500 ? 'Internal server error' : err.message);
    }
  }

  listen(port, host, callback) {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[fatal]', err);
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end('Internal server error');
        }
      });
    });
    server.listen(port, host, callback);
    return server;
  }
}

/** Middleware that fills req.body / req.files. */
const bodyParser = async (req, res, next) => {
  await parseBody(req);
  await next();
};

module.exports = { App, bodyParser, parseCookies };
