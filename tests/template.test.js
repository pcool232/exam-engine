'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TemplateEngine, escapeHtml } = require('../src/core/template');

test('escapeHtml escapes the five special characters and passes through null/undefined as ""', () => {
  assert.equal(escapeHtml(`<script>alert('x')&"y"</script>`), '&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

/** A throwaway views directory for the TemplateEngine tests below. */
function withViews(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-engine-templates-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return fn(new TemplateEngine(dir, { cacheTemplates: false }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('{{ }} escapes output, {{{ }}} does not', () => {
  withViews({ 'page.html': '{{ name }} / {{{ raw }}}' }, (engine) => {
    const out = engine.include('page', { name: '<b>x</b>', raw: '<b>x</b>' });
    assert.equal(out, '&lt;b&gt;x&lt;/b&gt; / <b>x</b>');
  });
});

test('{% if %}/{% elif %}/{% else %}/{% endif %} branches correctly', () => {
  withViews({
    'page.html': '{% if n === 1 %}one{% elif n === 2 %}two{% else %}many{% endif %}',
  }, (engine) => {
    assert.equal(engine.include('page', { n: 1 }), 'one');
    assert.equal(engine.include('page', { n: 2 }), 'two');
    assert.equal(engine.include('page', { n: 3 }), 'many');
  });
});

test('{% for item in list %} iterates in order', () => {
  withViews({ 'page.html': '{% for item in items %}[{{ item }}]{% endfor %}' }, (engine) => {
    assert.equal(engine.include('page', { items: ['a', 'b', 'c'] }), '[a][b][c]');
  });
});

test('{% for item, i in list %} exposes the index', () => {
  withViews({ 'page.html': '{% for item, i in items %}{{ i }}:{{ item }} {% endfor %}' }, (engine) => {
    assert.equal(engine.include('page', { items: ['x', 'y'] }), '0:x 1:y ');
  });
});

test('{% include %} pulls in a partial with the parent data', () => {
  withViews({
    'page.html': 'before {% include "partials/bit.html" %} after',
    'partials/bit.html': '[{{ name }}]',
  }, (engine) => {
    assert.equal(engine.include('page', { name: 'nested' }), 'before [nested] after');
  });
});

test('render() wraps the page in the layout, passing body through', () => {
  withViews({
    'page.html': 'PAGE-CONTENT',
    'partials/layout.html': 'LAYOUT[{{{ body }}}]',
  }, (engine) => {
    assert.equal(engine.render('page', {}), 'LAYOUT[PAGE-CONTENT]');
  });
});

test('a template path that tries to escape the views directory is rejected', () => {
  withViews({ 'page.html': 'x' }, (engine) => {
    assert.throws(() => engine.include('../../etc/passwd'), /escapes views directory/);
  });
});
