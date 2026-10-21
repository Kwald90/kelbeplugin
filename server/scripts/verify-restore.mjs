#!/usr/bin/env node
// Check a RESTORED Fishtape database (never the live one): the migration version, row counts per
// tenant for the main tables, and that encrypted columns decrypt with SECRETS_MASTER_KEY, one
// sample per kind (integration secrets, QuickBooks tokens, MFA secrets, pending QuickBooks
// revokes). deploy/<env>/offsite-drill.sh --verify-secrets runs it against the scratch container
// restore-test.sh made (docs/runbooks/offsite-backups.md).
//
//   printf 'SECRETS_MASTER_KEY=%s\n' "$KEY" | node server/scripts/verify-restore.mjs --container <name>
//   printf 'SECRETS_MASTER_KEY=%s\n' "$KEY" | node server/scripts/verify-restore.mjs --database-url <url>
//
// --container runs psql inside that Docker container (the scratch database has no network);
// --database-url connects with pg from server/node_modules (tests, or a scratch database you made).
// The key is read from stdin only (a line SECRETS_MASTER_KEY=<base64>, or the bare value) and is
// never printed, logged or written anywhere; neither are decrypted values.
//
// Output: a summary on stderr and one JSON line on stdout (counts and tenant ids, no names, no data).
// Exit codes: 0 ok, 1 a check failed, 2 bad usage or a bad key, 5 an encrypted value did not decrypt.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSealer } from '../src/lib/crypto.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Tables counted per tenant, when they exist in the restored database. */
export const MAIN_TABLES = ['memberships', 'clients', 'jobs', 'estimates', 'invoices', 'payments', 'employees', 'time_entries', 'audit_events', 'tenant_secrets'];

/** One sample query per kind of encrypted value, and how to open it (same AAD as the code that sealed it). */
export const SECRET_KINDS = [
  {
    kind: 'integration_secrets', table: 'tenant_secrets',
    sql: "SELECT tenant_id::text AS tenant_id, name, value_enc AS v FROM tenant_secrets WHERE name NOT LIKE 'qbo.%' ORDER BY updated_at DESC LIMIT 3",
    open: (s, r) => { try { s.envelopeOpen(r.v, `tenant_secret:${r.tenant_id}:${r.name}`); return true; } catch { return false; } },
  },
  {
    kind: 'quickbooks_tokens', table: 'tenant_secrets',
    sql: "SELECT tenant_id::text AS tenant_id, name, value_enc AS v FROM tenant_secrets WHERE name LIKE 'qbo.%' ORDER BY updated_at DESC LIMIT 3",
    open: (s, r) => { try { s.envelopeOpen(r.v, `tenant_secret:${r.tenant_id}:${r.name}`); return true; } catch { return false; } },
  },
  {
    kind: 'mfa_secrets', table: 'mfa_factors',
    sql: 'SELECT user_id::text AS user_id, secret_enc AS v FROM mfa_factors WHERE confirmed_at IS NOT NULL ORDER BY created_at DESC LIMIT 3',
    open: (s, r) => s.open('mfa-totp', r.v, r.user_id) !== null,
  },
  {
    kind: 'quickbooks_revokes', table: 'qbo_revoke_pending',
    sql: 'SELECT id::text AS id, token_sealed AS v FROM qbo_revoke_pending ORDER BY created_at DESC LIMIT 3',
    open: (s, r) => s.open('qbo-revoke', r.v, `qbo-revoke:${r.id}`) !== null,
  },
];

export class UsageError extends Error {}

/** The master key from stdin text: a SECRETS_MASTER_KEY=... line, or one bare value. */
export function parseMasterKey(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const named = lines.find((l) => l.startsWith('SECRETS_MASTER_KEY='));
  let v = named ? named.slice('SECRETS_MASTER_KEY='.length) : lines.length === 1 ? lines[0] : '';
  v = v.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!v) throw new UsageError('no SECRETS_MASTER_KEY on stdin');
  if (Buffer.from(v, 'base64').length !== 32) throw new UsageError('SECRETS_MASTER_KEY on stdin is not base64 of 32 bytes');
  return v;
}

export function parseArgs(argv) {
  const o = { container: '', databaseUrl: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--container') o.container = argv[++i] || '';
    else if (a === '--database-url') o.databaseUrl = argv[++i] || '';
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(`unknown option: ${a}`);
  }
  if (o.help) return o;
  if (Boolean(o.container) === Boolean(o.databaseUrl)) throw new UsageError('give exactly one of --container <name> or --database-url <url>');
  if (o.container && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(o.container)) throw new UsageError('--container: letters, digits, _ . - only');
  return o;
}

/** A query runner over `docker exec <container> psql`: each query returns its rows as objects. */
function containerRunner(name) {
  return {
    async rows(sql) {
      const wrapped = `SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q`;
      const r = spawnSync('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', 'fishtape', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', wrapped],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`psql in ${name} failed: ${String(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
      return JSON.parse(r.stdout.trim() || '[]');
    },
    async close() {},
  };
}

async function urlRunner(url) {
  let pg;
  try { pg = (await import('pg')).default; } catch { throw new UsageError('--database-url needs server/node_modules (npm install in server/)'); }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    async rows(sql) {
      const { rows } = await client.query(`SELECT coalesce(json_agg(q), '[]'::json) AS j FROM (${sql}) q`);
      return rows[0].j;
    },
    close: () => client.end(),
  };
}

/** The newest migration version in this checkout (the backup may be older; that is normal). */
export function checkoutLatest(dir = MIGRATIONS_DIR) {
  try { return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().at(-1)?.slice(0, 4) ?? null; } catch { return null; }
}

/**
 * Run every check. `db.rows(sql)` returns rows as plain objects.
 * @returns {Promise<{ ok: boolean, exitCode: number, report: object, lines: string[] }>}
 */
export async function verifyRestore(db, masterKey, { latest = checkoutLatest() } = {}) {
  const sealer = createSealer(masterKey);
  const failures = [];
  const lines = [];
  const exists = new Set((await db.rows(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).map((r) => r.name));

  // Migrations.
  let migration = null;
  let migrations = null;
  if (!exists.has('schema_migrations')) failures.push('no schema_migrations table');
  else {
    const [m] = await db.rows('SELECT max(version) AS version, count(*)::int AS n FROM schema_migrations');
    migration = m?.version ?? null;
    migrations = m?.n ?? 0;
    if (!migrations) failures.push('schema_migrations is empty');
  }
  lines.push(`migration         ${migration ?? 'none'} (${migrations ?? 0} applied; this checkout's newest: ${latest ?? 'unknown'})`);
  if (migration && latest && migration > latest) lines.push('note: the backup is newer than this checkout; pull before trusting the comparison');
  else if (migration && latest && migration < latest) lines.push('note: the backup is older than this checkout (normal when migrations shipped since it was taken)');

  // Tenants and rows per tenant.
  let tenants = [];
  if (!exists.has('tenants')) failures.push('no tenants table');
  else tenants = await db.rows('SELECT id::text AS id, status FROM tenants ORDER BY created_at, id');
  const tables = MAIN_TABLES.filter((t) => exists.has(t));
  const missing = MAIN_TABLES.filter((t) => !exists.has(t));
  if (missing.length) failures.push(`missing tables: ${missing.join(', ')}`);
  const perTenant = {};
  const totals = {};
  if (tables.length) {
    const union = tables.map((t) => `SELECT '${t}' AS t, tenant_id::text AS tenant, count(*)::int AS n FROM ${t} WHERE tenant_id IS NOT NULL GROUP BY tenant_id`).join(' UNION ALL ');
    for (const r of await db.rows(union)) {
      (perTenant[r.tenant] ||= {})[r.t] = r.n;
      totals[r.t] = (totals[r.t] || 0) + r.n;
    }
  }
  lines.push(`tenants           ${tenants.length} (${tenants.filter((x) => x.status === 'active').length} active)`);
  for (const t of tables) lines.push(`  ${t.padEnd(16)}${String(totals[t] || 0).padStart(8)} rows`);
  if (!tenants.length) lines.push('note: no tenants in this backup');

  // Encrypted values.
  const secrets = {};
  let decrypted = 0;
  let undecryptable = 0;
  for (const k of SECRET_KINDS) {
    if (!exists.has(k.table)) { secrets[k.kind] = { present: 0, ok: 0, failed: 0, table: 'missing' }; continue; }
    const rows = await db.rows(k.sql);
    const ok = rows.filter((r) => k.open(sealer, r)).length;
    secrets[k.kind] = { present: rows.length, ok, failed: rows.length - ok };
    decrypted += ok;
    undecryptable += rows.length - ok;
    lines.push(`secrets ${k.kind.padEnd(20)} ${rows.length ? `${ok}/${rows.length} decrypt` : 'none in this backup'}`);
  }
  if (undecryptable) failures.push(`${undecryptable} encrypted value(s) did not decrypt with this SECRETS_MASTER_KEY`);
  if (!decrypted && !undecryptable) lines.push('note: no encrypted values in this backup, so the key could not be checked');

  const exitCode = undecryptable ? 5 : failures.length ? 1 : 0;
  return {
    ok: exitCode === 0,
    exitCode,
    lines,
    report: {
      ok: exitCode === 0, migration, migrations, checkoutLatest: latest, tenants: tenants.length, rows: totals, perTenant, secrets, decrypted, failures,
    },
  };
}

async function main() {
  let args;
  let key;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stderr.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
      return 0;
    }
    key = parseMasterKey(readFileSync(0, 'utf8'));
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(`verify-restore: ${e.message}\n`); return 2; }
    throw e;
  }
  let db;
  try {
    db = args.container ? containerRunner(args.container) : await urlRunner(args.databaseUrl);
  } catch (e) {
    process.stderr.write(`verify-restore: ${e instanceof UsageError ? e.message : `cannot connect: ${e.message}`}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
  try {
    const r = await verifyRestore(db, key);
    key = null;
    process.stderr.write(`${r.lines.join('\n')}\n${r.ok ? 'verify-restore: PASS' : `verify-restore: FAIL: ${r.report.failures.join('; ')}`}\n`);
    process.stdout.write(`${JSON.stringify(r.report)}\n`);
    return r.exitCode;
  } catch (e) {
    process.stderr.write(`verify-restore: ${String(e.message).slice(0, 500)}\n`);
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`verify-restore: ${e.message}\n`); process.exitCode = 1; });
}
