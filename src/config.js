'use strict';
/** Configuration, read from environment variables with sensible defaults. */

const path = require('node:path');
const fs = require('node:fs');

// Minimal .env loader (no dependencies). Existing environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const rootDir = path.resolve(__dirname, '..');
loadDotEnv(path.join(rootDir, '.env'));

const config = {
  rootDir,
  viewsDir: path.join(rootDir, 'views'),
  publicDir: path.join(rootDir, 'public'),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  databaseFile: process.env.DATABASE_FILE
    ? path.resolve(rootDir, process.env.DATABASE_FILE)
    : path.join(rootDir, 'data', 'revision-engine.db'),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_HOURS || 12) * 3600,
  // Set COOKIE_SECURE=true when serving over HTTPS.
  cookieSecure: String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true',
  appName: process.env.APP_NAME || 'Revision Engine',
  // Seed admin (used by `npm run seed`).
  seedAdminEmail: process.env.ADMIN_EMAIL || 'admin@revision.local',
  seedAdminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
  seedAdminName: process.env.ADMIN_NAME || 'System Administrator',
  allowRegistration: String(process.env.ALLOW_REGISTRATION || 'true').toLowerCase() !== 'false',
};

config.isProduction = config.env === 'production';

module.exports = config;
