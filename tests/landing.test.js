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
