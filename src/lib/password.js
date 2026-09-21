'use strict';
/**
 * Password hashing with scrypt from node:crypto.
 * Format: scrypt$N$r$p$<salt base64>$<hash base64>
 */

const crypto = require('node:crypto');

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const derived = crypto.scryptSync(String(plain), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Basic strength check used at registration time. */
function checkPasswordStrength(plain) {
  const value = String(plain || '');
  if (value.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Za-z]/.test(value)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return null;
}

module.exports = { hashPassword, verifyPassword, checkPasswordStrength };
