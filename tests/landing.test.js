'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { TemplateEngine } = require('../src/core/template');

const views = path.join(__dirname, '..', 'views');

test('landing page renders standalone (no layout) with the app name and asset version', () => {
  const engine = new TemplateEngine(views, { cacheTemplates: false });
  const html = engine.render('landing', { appName: 'Rivaesa', assetVersion: 'abc123' }, null);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>Rivaesa — Practise today\. Walk into every exam ready\.<\/title>/);
  assert.match(html, /\/static\/css\/landing\.css\?v=abc123/);
  assert.match(html, /\/static\/js\/landing\.js\?v=abc123/);
  // Calls to action point at the app's own auth pages.
  assert.match(html, /href="\/register"/);
  assert.match(html, /href="\/login"/);
  // No layout chrome leaked in.
  assert.doesNotMatch(html, /class="topbar"/);
});

test('landing page escapes the app name', () => {
  const engine = new TemplateEngine(views, { cacheTemplates: false });
  const html = engine.render('landing', { appName: '<b>x</b>', assetVersion: '1' }, null);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('landing page <head> is well-formed, so the .rv wrapper survives parsing', () => {
  // Regression: a favicon <link> truncated at the first ">" inside its
  // data: URI left an unclosed href quote that swallowed </head><body> and
  // the <div class="rv"> wrapper, so none of the .rv font rules applied.
  const engine = new TemplateEngine(views, { cacheTemplates: false });
  const html = engine.render('landing', { appName: 'Rivaesa', assetVersion: '1' }, null);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.equal((head.match(/"/g) || []).length % 2, 0, 'unbalanced double quotes in <head>');
  assert.match(head, /<link rel="icon" href="data:image\/svg\+xml,[^"]*<\/svg>">/);
  assert.match(html, /<\/head>\s*<body>\s*<div class="rv">/);
});
