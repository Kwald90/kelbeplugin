// Test database per test file, on the Postgres in TEST_DATABASE_URL (a superuser URL).
// Without TEST_DATABASE_URL every DB test is skipped (see `skip` below).
//
// Roles: if fishtape_owner/app/hq do not exist yet, db/bootstrap.sql is run with fresh
// passwords. Tests then log in as the real roles when the passwords are known
// (TEST_*_PASSWORD, set by scripts/with-embedded-pg.js), otherwise they connect as the
// superuser and SET ROLE, which applies the same privileges and RLS.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../src/migrate.js';
import { createDb, createPool } from '../../src/db.js';
import { runPsqlScript } from './psql-lite.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
export const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set (run `npm run test:embedded` or see server/README.md)';

const BOOTSTRAP = fileURLToPath(new URL('../../db/bootstrap.sql', import.meta.url));

function urlFor(database, user, password) {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = '/' + database;
  if (user) { u.username = user; u.password = password ? encodeURIComponent(password) : ''; }
  return u.toString();
}

let rolesReady = null;
async function ensureRoles() {
  if (rolesReady) return rolesReady;
  rolesReady = (async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('fishtape_owner','fishtape_app','fishtape_hq')");
      if (rows[0].n < 3) {
        const p = () => randomBytes(18).toString('base64url');
        const vars = { owner_password: p(), app_password: p(), hq_password: p() };
        await runPsqlScript(readFileSync(BOOTSTRAP, 'utf8'), TEST_DATABASE_URL, vars);
        process.env.TEST_OWNER_PASSWORD = vars.owner_password;
        process.env.TEST_APP_PASSWORD = vars.app_password;
        process.env.TEST_HQ_PASSWORD = vars.hq_password;
      }
    } finally {
      await admin.end();
    }
  })();
  return rolesReady;
}

function rolePool(database, role, envPassword, opts = {}) {
  const password = process.env[envPassword];
  if (password) return createPool(urlFor(database, role, password), opts);
  return createPool(urlFor(database), { ...opts, role });
}

/**
 * Create a fresh, migrated database for one test file.
 * @param {string} label short name for the database
 */
export async function createTestDatabase(label) {
  await ensureRoles();
  const name = `ft_test_${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} OWNER fishtape_owner TEMPLATE template0 ENCODING 'UTF8'`);
  await admin.query(`GRANT CONNECT ON DATABASE ${name} TO fishtape_app, fishtape_hq`);
  await admin.query(`ALTER ROLE fishtape_hq IN DATABASE ${name} SET default_transaction_read_only = on`);
  await admin.end();

  // Same schema setup as bootstrap.sql does for the real database.
  const superDb = new pg.Client({ connectionString: urlFor(name) });
  await superDb.connect();
  await superDb.query('ALTER SCHEMA public OWNER TO fishtape_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO fishtape_app, fishtape_hq;');
  await superDb.end();

  const ownerPool = rolePool(name, 'fishtape_owner', 'TEST_OWNER_PASSWORD', { max: 2 });
  const ownerClient = await ownerPool.connect();
  try { await migrate(ownerClient); } finally { ownerClient.release(); }

  const appPool = rolePool(name, 'fishtape_app', 'TEST_APP_PASSWORD', { max: 8 });
  const hqPool = rolePool(name, 'fishtape_hq', 'TEST_HQ_PASSWORD', { max: 2 });
  const superPool = createPool(urlFor(name), { max: 2 });
  const db = createDb({ app: appPool, hq: hqPool });

  return {
    name,
    db,
    ownerPool,
    appPool,
    hqPool,
    /** Superuser pool for test set-up and tampering only. */
    superPool,
    async close() {
      await Promise.allSettled([appPool.end(), hqPool.end(), ownerPool.end(), superPool.end()]);
      const a = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await a.connect();
      try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
    },
  };
}
