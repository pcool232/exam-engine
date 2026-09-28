'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clientIp, retryMessage } = require('../src/lib/rate-limit');

test('clientIp prefers the first hop of X-Forwarded-For', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientIp(req), '203.0.113.5');
});

test('clientIp falls back to the socket address with no X-Forwarded-For', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req), '127.0.0.1');
});

test('clientIp falls back to "unknown" with neither available', () => {
  const req = { headers: {}, socket: {} };
  assert.equal(clientIp(req), 'unknown');
});

test('retryMessage rounds up to whole minutes and pluralises correctly', () => {
  assert.equal(retryMessage(1), 'Please wait 1 minute and try again.');
  assert.equal(retryMessage(59 * 1000), 'Please wait 1 minute and try again.');
  assert.equal(retryMessage(61 * 1000), 'Please wait 2 minutes and try again.');
  assert.equal(retryMessage(15 * 60 * 1000), 'Please wait 15 minutes and try again.');
});
