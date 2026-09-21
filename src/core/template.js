'use strict';
/**
 * Tiny template engine (no dependencies).
 *
 * Syntax
 *   {{ expr }}                    escaped output
 *   {{{ expr }}}                  raw (unescaped) output
 *   {% if cond %} ... {% elif cond %} ... {% else %} ... {% endif %}
 *   {% for item in list %} ... {% endfor %}
 *   {% for item, i in list %} ... {% endfor %}
 *   {% set name = expr %}
 *   {% include "partials/foo.html" %}
 *   {# comment #}
 *
 * Templates are compiled once and cached (cache disabled when NODE_ENV!=production
 * so edits show up on refresh during development).
 */

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function quote(str) {
  return JSON.stringify(str);
}

/** Turn a template string into JavaScript source for a render function body. */
function compileToSource(input) {
  let src = "let __out = '';\nwith (__data) {\n";
  let cursor = 0;
  const openTag = /\{\{\{|\{\{|\{%|\{#/g;

  while (cursor < input.length) {
    openTag.lastIndex = cursor;
    const match = openTag.exec(input);
    if (!match) {
      src += `__out += ${quote(input.slice(cursor))};\n`;
      break;
    }
    if (match.index > cursor) {
      src += `__out += ${quote(input.slice(cursor, match.index))};\n`;
    }
    const tag = match[0];
    const closing = tag === '{{{' ? '}}}' : tag === '{{' ? '}}' : tag === '{%' ? '%}' : '#}';
    const end = input.indexOf(closing, match.index + tag.length);
    if (end === -1) {
      throw new Error(`Unclosed "${tag}" tag in template`);
    }
    const body = input.slice(match.index + tag.length, end).trim();

    if (tag === '{#') {
      // comment - emit nothing
    } else if (tag === '{{{') {
      src += `__out += (${body}) ?? '';\n`;
    } else if (tag === '{{') {
      src += `__out += __esc(${body});\n`;
    } else {
      src += compileStatement(body);
    }
    cursor = end + closing.length;
  }

  src += "}\nreturn __out;";
  return src;
}

function compileStatement(body) {
  const [keyword, ...restParts] = body.split(/\s+/);
  const rest = restParts.join(' ');

  switch (keyword) {
    case 'if':
      return `if (${rest}) {\n`;
    case 'elif':
      return `} else if (${rest}) {\n`;
    case 'else':
      return `} else {\n`;
    case 'endif':
    case 'endfor':
      return `}\n`;
    case 'for': {
      // "item in list"  |  "item, index in list"
      const m = rest.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?in\s+([\s\S]+)$/);
      if (!m) throw new Error(`Bad for-loop: {% for ${rest} %}`);
      const [, item, index, list] = m;
      const idx = index || '__idx';
      return `for (const [${idx}, ${item}] of Array.from((${list}) || []).entries()) {\n`;
    }
    case 'set':
      return `var ${rest};\n`;
    case 'include': {
      const m = rest.match(/^["']([^"']+)["']\s*(?:,\s*([\s\S]+))?$/);
      if (!m) throw new Error(`Bad include: {% include ${rest} %}`);
      const extra = m[2] ? `Object.assign({}, __data, ${m[2]})` : '__data';
      return `__out += __include(${quote(m[1])}, ${extra});\n`;
    }
    default:
      throw new Error(`Unknown template tag: {% ${body} %}`);
  }
}

class TemplateEngine {
  constructor(viewsDir, { cacheTemplates = true } = {}) {
    this.viewsDir = viewsDir;
    this.cacheTemplates = cacheTemplates;
    this.include = this.include.bind(this);
  }

  resolve(name) {
    const file = name.endsWith('.html') ? name : `${name}.html`;
    const full = path.join(this.viewsDir, file);
    const relative = path.relative(this.viewsDir, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Template path escapes views directory: ${name}`);
    }
    return full;
  }

  compile(name) {
    const file = this.resolve(name);
    if (this.cacheTemplates && cache.has(file)) return cache.get(file);

    const source = fs.readFileSync(file, 'utf8');
    let fn;
    try {
      // Non-strict function so that `with (__data)` is allowed.
      fn = new Function('__data', '__esc', '__include', compileToSource(source));
    } catch (err) {
      throw new Error(`Failed to compile template "${name}": ${err.message}`);
    }
    if (this.cacheTemplates) cache.set(file, fn);
    return fn;
  }

  /** Render a template without a layout. */
  include(name, data = {}) {
    const fn = this.compile(name);
    try {
      return fn(data, escapeHtml, this.include);
    } catch (err) {
      throw new Error(`Error rendering template "${name}": ${err.message}`);
    }
  }

  /**
   * Render a page template and wrap it in the layout.
   * The page output is available to the layout as `body`.
   */
  render(name, data = {}, layout = 'partials/layout') {
    const body = this.include(name, data);
    if (!layout) return body;
    return this.include(layout, { ...data, body });
  }
}

module.exports = { TemplateEngine, escapeHtml };
