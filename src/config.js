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
  // The database, via `pg` -- a PostgreSQL connection string. Supabase gives
  // you this under Project Settings -> Database -> Connection string.
  //
  // Use the *pooled* connection string (host has `pooler.supabase.com` and
  // the port is 6543, via PgBouncer) rather than the direct one (port 5432)
  // when deploying to Vercel or any other serverless platform -- a burst of
  // traffic there can spin up many function instances at once, each opening
  // its own connections, and Postgres itself only allows a limited number.
  // Locally, point this at any Postgres you have running (see .env.example).
  //
  // Accepts DATABASE_URL, or SUPABASE_DB_URL as an alternate name in case
  // that's what a Supabase/Vercel integration sets automatically.
  databaseUrl: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '',
  // Cap on concurrent connections this process opens to Postgres. Keep this
  // low on serverless (each function instance gets its own pool) -- 5 is a
  // safe default against Supabase's pooled connection string.
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX || 5),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_HOURS || 12) * 3600,
  // Set COOKIE_SECURE=true when serving over HTTPS.
  cookieSecure: String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true',
  appName: process.env.APP_NAME || 'Revision Engine',
  // Seed admin (used by `npm run seed`).
  seedAdminEmail: process.env.ADMIN_EMAIL || 'admin@revision.local',
  seedAdminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
  seedAdminName: process.env.ADMIN_NAME || 'System Administrator',
  allowRegistration: String(process.env.ALLOW_REGISTRATION || 'true').toLowerCase() !== 'false',
  // "Sign in with Google" is switched on by setting this. Leave blank and the
  // button simply does not appear -- email/password keeps working either way.
  googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
};

config.isProduction = config.env === 'production';

module.exports = config;
