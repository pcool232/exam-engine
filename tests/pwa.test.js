'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAssetLinks } = require('../src/app');

const publicDir = path.join(__dirname, '..', 'public');

test('assetlinks is an inert [] until a signing fingerprint is configured', () => {
  assert.deepEqual(buildAssetLinks({ androidPackageName: 'app.rivaesa', androidCertFingerprints: [] }), []);
  assert.deepEqual(buildAssetLinks({ androidPackageName: '', androidCertFingerprints: ['AA:BB'] }), []);
});

test('assetlinks names the Android package and every signing fingerprint', () => {
  const links = buildAssetLinks({ androidPackageName: 'app.rivaesa', androidCertFingerprints: ['AA:BB', 'CC:DD'] });
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(links[0].target.namespace, 'android_app');
  assert.equal(links[0].target.package_name, 'app.rivaesa');
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, ['AA:BB', 'CC:DD']);
});

test('web manifest is valid JSON, opens at /app, and every icon it lists exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.start_url, /^\/app\b/);
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const file = path.join(publicDir, icon.src.replace(/^\/static\//, ''));
    assert.ok(fs.existsSync(file), `missing icon ${icon.src}`);
  }
});

test('service worker precaches the offline page and never intercepts POSTs', () => {
  const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  assert.match(sw, /'\/offline\.html'/);
  assert.match(sw, /request\.method !== 'GET'\) return/);
});
