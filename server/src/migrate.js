// Migrator: applies migrations/NNNN_name.sql in order, each in its own transaction,
// as the owner role (MIGRATE_DATABASE_URL). Applied files are recorded with a checksum
// in schema_migrations; editing an applied file is an error (add a new file instead).
//   npm run migrate            apply pending migrations
//   npm run migrate -- --status  list applied and pending
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvFile, readConfig } from './config.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** @returns {{ version: string, name: string, file: string, sql: string, checksum: string }[]} */
export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(dir + file, 'utf8');
      return {
        version: file.slice(0, 4),
        name: file.slice(5, -4),
        file,
        sql,
        checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
      };
    });
}

/** Latest migration version shipped with this build. */
export function latestMigrationVersion(dir = MIGRATIONS_DIR) {
  const files = migrationFiles(dir);
  return files.length ? files[files.length - 1].version : null;
}

const LOCK_KEY = 'fishtape:migrate';

/**
 * @param {pg.Client|pg.PoolClient} client connected as the owner role
 * @param {{ dir?: string, log?: (msg: string) => void }} [opts]
 * @returns {Promise<string[]>} versions applied by this run
 */
export async function migrate(client, opts = {}) {
  const log = opts.log || (() => {});
  const files = migrationFiles(opts.dir);
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fishtape_app') THEN GRANT SELECT ON schema_migrations TO fishtape_app; END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fishtape_hq') THEN GRANT SELECT ON schema_migrations TO fishtape_hq; END IF;
    END $$`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const done = [];
    for (const m of files) {
      if (applied.has(m.version)) {
        if (applied.get(m.version) !== m.checksum) throw new Error(`migration ${m.file} was edited after it was applied; add a new migration instead`);
        continue;
      }
      log(`applying ${m.file}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        e.message = `${m.file}: ${e.message}`;
        throw e;
      }
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
  }
}

/** Versions applied in the database vs files on disk (used by /api/readyz). */
export async function migrationStatus(queryable, dir) {
  const files = migrationFiles(dir);
  let applied = [];
  try {
    applied = (await queryable.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  } catch {
    applied = [];
  }
  const set = new Set(applied);
  const pending = files.filter((f) => !set.has(f.version)).map((f) => f.file);
  return { current: applied[applied.length - 1] || null, latest: files.length ? files[files.length - 1].version : null, pending };
}

async function main() {
  loadEnvFile();
  const config = readConfig();
  const url = config.migrateDatabaseUrl;
  if (!url) {
    console.error('MIGRATE_DATABASE_URL (the fishtape_owner role) is required to migrate.');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url, application_name: 'fishtape-migrate' });
  await client.connect();
  try {
    if (process.argv.includes('--status')) {
      const s = await migrationStatus(client);
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    const done = await migrate(client, { log: (m) => console.log(m) });
    console.log(done.length ? `applied ${done.length} migration(s): ${done.join(', ')}` : 'database is up to date');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
