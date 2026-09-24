'use strict';

const config = require('./src/config');
const { getDb, closeDb } = require('./src/db');
const { buildApp } = require('./src/app');
const users = require('./src/models/users');

async function warnIfNoAdmin() {
  const { admins } = await users.countAll();
  if (admins === 0) {
    console.warn(
      '\n  No administrator account exists yet.\n' +
      '  Run:  npm run seed\n'
    );
  }
}

/** DATABASE_URL with the password blanked out, safe to print. */
function describeDatabaseUrl() {
  if (!config.databaseUrl) return '(not configured -- set DATABASE_URL)';
  try {
    const url = new URL(config.databaseUrl);
    if (url.password) url.password = '****';
    return url.toString();
  } catch {
    return '(configured)';
  }
}

async function main() {
  // Fails fast, with a clear message, if the schema/migrations can't run --
  // rather than the first request hitting a half-explained connection error.
  await getDb();

  const app = buildApp();

  const server = app.listen(config.port, config.host, async () => {
    await warnIfNoAdmin();
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`\n  ${config.appName} is running`);
    console.log(`  →  http://${shown}:${config.port}`);
    console.log(`  Database: ${describeDatabaseUrl()}`);
    console.log(`  Mode: ${config.env}`);
    // Routes are fixed when the process starts, so this line tells you whether
    // what is running matches the files on disk. If you have just pulled in new
    // code and a page 404s, restart (or use `npm run dev`, which restarts itself).
    console.log(`  Started ${new Date().toLocaleTimeString()} with ${app.routes.length} routes\n`);
  });

  function shutdown(signal) {
    console.log(`\n${signal} received - shutting down.`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server };
}

const ready = main().catch((err) => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});

module.exports = ready;
