// Migrations apply cleanly, are idempotent, and leave the roles and tables the
// backend contract asks for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { migrate, migrationFiles, migrationStatus } from '../src/migrate.js';
import { TABLE_COLLECTIONS, collectionDef } from '../src/collections.js';

let t;
before(async () => { if (!skip) t = await createTestDatabase('migrations'); });
after(async () => { await t?.close(); });

test('all migrations are applied and a second run is a no-op', { skip }, async () => {
  const status = await migrationStatus(t.db);
  assert.deepEqual(status.pending, []);
  assert.equal(status.current, migrationFiles().at(-1).version);
  const c = await t.ownerPool.connect();
  try { assert.deepEqual(await migrate(c), []); } finally { c.release(); }
});

test('role attributes: app cannot bypass RLS, hq can, none are superusers', { skip }, async () => {
  const { rows } = await t.superPool.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'fishtape_%' ORDER BY rolname");
  const by = Object.fromEntries(rows.map((r) => [r.rolname, r]));
  assert.equal(by.fishtape_app.rolbypassrls, false);
  assert.equal(by.fishtape_app.rolsuper, false);
  assert.equal(by.fishtape_owner.rolbypassrls, false);
  assert.equal(by.fishtape_owner.rolsuper, false);
  assert.equal(by.fishtape_hq.rolbypassrls, true);
  assert.equal(by.fishtape_hq.rolsuper, false);
  for (const r of rows) assert.equal(r.rolcanlogin, true);
});

test('the API pool really runs as fishtape_app', { skip }, async () => {
  const { rows } = await t.appPool.query('SELECT current_user AS u');
  assert.equal(rows[0].u, 'fishtape_app');
});

test('every collection table has RLS enabled and forced, with a policy', { skip }, async () => {
  const tables = [...TABLE_COLLECTIONS.map((c) => collectionDef(c).table), 'audit_events', 'sync_mutations', 'record_history', 'tenant_secrets'];
  const { rows } = await t.superPool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [tables]);
  assert.equal(rows.length, tables.length);
  for (const r of rows) {
    assert.ok(r.relrowsecurity, `${r.relname} RLS enabled`);
    assert.ok(r.relforcerowsecurity, `${r.relname} RLS forced`);
    assert.ok(r.policies > 0, `${r.relname} has a policy`);
  }
});

test('policies use both USING and WITH CHECK on the tenant setting', { skip }, async () => {
  const { rows } = await t.superPool.query(
    `SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [TABLE_COLLECTIONS.map((c) => collectionDef(c).table)]);
  assert.equal(rows.length, TABLE_COLLECTIONS.length);
  for (const r of rows) {
    assert.match(r.qual, /app_tenant_id\(\)/, `${r.tablename} USING`);
    assert.match(r.with_check, /app_tenant_id\(\)/, `${r.tablename} WITH CHECK`);
  }
});

test('the app role cannot update or delete audit events, even its own', { skip }, async () => {
  const { rows } = await t.superPool.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'fishtape_app' AND table_name = 'audit_events' ORDER BY privilege_type`);
  assert.deepEqual(rows.map((r) => r.privilege_type), ['INSERT', 'SELECT']);
});

test('the app role has no DELETE on tenant tables (soft delete only)', { skip }, async () => {
  const { rows } = await t.superPool.query(
    `SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'fishtape_app' AND privilege_type = 'DELETE' AND table_name = ANY($1)`,
    [TABLE_COLLECTIONS.map((c) => collectionDef(c).table)]);
  assert.deepEqual(rows, []);
});
