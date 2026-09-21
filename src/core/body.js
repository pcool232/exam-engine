'use strict';
/**
 * Request body parsing with no dependencies:
 *  - application/x-www-form-urlencoded
 *  - application/json
 *  - multipart/form-data (fields + uploaded files held in memory)
 *
 * Repeated field names collapse into arrays, so `<input name="answer" multiple>`
 * and checkbox groups work the way you would expect.
 */

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB

function addField(target, rawName, value) {
  // "answers[]" and "answers" are treated as the same field name.
  const name = rawName.endsWith('[]') ? rawName.slice(0, -2) : rawName;
  const forceArray = rawName.endsWith('[]');
  if (Object.prototype.hasOwnProperty.call(target, name)) {
    const existing = target[name];
    if (Array.isArray(existing)) existing.push(value);
    else target[name] = [existing, value];
  } else {
    target[name] = forceArray ? [value] : value;
  }
}

function parseUrlEncoded(text) {
  const out = Object.create(null);
  const params = new URLSearchParams(text);
  for (const [key, value] of params.entries()) addField(out, key, value);
  return out;
}

function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        req.pause();
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('Request aborted')));
  });
}

function parseContentDisposition(headerValue) {
  const result = {};
  for (const part of headerValue.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    result[key] = value;
  }
  return result;
}

/** Split a multipart body into { fields, files }. */
function parseMultipart(buffer, boundary) {
  const fields = Object.create(null);
  const files = Object.create(null);
  const delimiter = Buffer.from(`--${boundary}`);

  let position = buffer.indexOf(delimiter);
  if (position === -1) return { fields, files };

  while (position !== -1) {
    let start = position + delimiter.length;
    // End of body: "--boundary--"
    if (buffer.slice(start, start + 2).toString() === '--') break;
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;

    const headerText = buffer.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(delimiter, bodyStart);
    if (nextBoundary === -1) break;

    // The CRLF immediately before the next delimiter belongs to the delimiter.
    let bodyEnd = nextBoundary;
    if (buffer.slice(bodyEnd - 2, bodyEnd).toString() === '\r\n') bodyEnd -= 2;
    const content = buffer.slice(bodyStart, bodyEnd);

    const headers = Object.create(null);
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition'] || '');
    if (disposition.name) {
      if (disposition.filename !== undefined) {
        if (disposition.filename !== '') {
          addField(files, disposition.name, {
            fieldName: disposition.name,
            filename: disposition.filename,
            mimeType: headers['content-type'] || 'application/octet-stream',
            size: content.length,
            buffer: content,
          });
        }
      } else {
        addField(fields, disposition.name, content.toString('utf8'));
      }
    }

    position = nextBoundary;
  }

  return { fields, files };
}

/** Middleware: populates req.body and req.files. */
async function parseBody(req) {
  req.body = Object.create(null);
  req.files = Object.create(null);

  if (req.method === 'GET' || req.method === 'HEAD') return;

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return;
    const boundary = (match[1] || match[2]).trim();
    const raw = await readRawBody(req);
    const { fields, files } = parseMultipart(raw, boundary);
    req.body = fields;
    req.files = files;
    return;
  }

  const raw = await readRawBody(req);
  if (raw.length === 0) return;

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      req.body = parsed && typeof parsed === 'object' ? parsed : Object.create(null);
    } catch {
      const err = new Error('Invalid JSON body');
      err.statusCode = 400;
      throw err;
    }
    return;
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    req.body = parseUrlEncoded(raw.toString('utf8'));
  }
}

module.exports = { parseBody, parseUrlEncoded, parseMultipart, readRawBody, MAX_BODY_BYTES };
