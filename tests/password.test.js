'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword, verifyPassword, checkPasswordStrength,
  generateResetToken, hashResetToken,
} = require('../src/lib/password');

test('hashPassword + verifyPassword round-trip', () => {
  const hash = hashPassword('Correct1Horse');
  assert.equal(verifyPassword('Correct1Horse', hash), true);
  assert.equal(verifyPassword('WrongPassword1', hash), false);
});

test('hashPassword salts each hash differently', () => {
  const a = hashPassword('SamePassword1');
  const b = hashPassword('SamePassword1');
  assert.notEqual(a, b, 'two hashes of the same password should not be identical');
  assert.equal(verifyPassword('SamePassword1', a), true);
  assert.equal(verifyPassword('SamePassword1', b), true);
});

test('verifyPassword rejects malformed stored hashes instead of throwing', () => {
  assert.equal(verifyPassword('anything', 'not-a-real-hash'), false);
  assert.equal(verifyPassword('anything', null), false);
  assert.equal(verifyPassword('anything', undefined), false);
});

test('checkPasswordStrength enforces length, a letter, and a number', () => {
  assert.equal(checkPasswordStrength('short1'), 'Password must be at least 8 characters long.');
  assert.equal(checkPasswordStrength('nonumbershere'), 'Password must contain at least one number.');
  assert.equal(checkPasswordStrength('12345678'), 'Password must contain at least one letter.');
  assert.equal(checkPasswordStrength('GoodPass1'), null);
});

test('generateResetToken produces a token whose hash matches hashResetToken', () => {
  const { token, hash } = generateResetToken();
  assert.equal(hashResetToken(token), hash);
});

test('generateResetToken never repeats a token', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const { token } = generateResetToken();
    assert.equal(seen.has(token), false, 'reset token collided');
    seen.add(token);
  }
});
