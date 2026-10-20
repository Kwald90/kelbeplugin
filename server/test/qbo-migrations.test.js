// Migration 0150 (docs/integrations/quickbooks.md 3.2, 11.3 W1): RLS enabled, forced and with a
// tenant policy on every tenant table; the permissive-read, own-write policies of qbo_realms and
// qbo_api_usage; one realm per tenant and one tenant per realm; the app grants; HQ's column grants
// (health and counts, never customer data) and its pause and release rights.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { createTenantWithOwner } from '../src/services/tenants.js';

const TENANT_TABLES = ['qbo_connections', 'qbo_links', 'qbo_outbox', 'qbo_inbox', 'qbo_conflicts', 'qbo_sync_log', 'qbo_mappings',
  'qbo_reference', 'qbo_candidates', 'stripe_payouts'];
const hash = () => randomBytes(32);

let t, A, B;
before(async () => {
  if (skip) return;
  t = await createTestDatabase('qbomig');
  const mk = async (name) => (await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: name } })).tenant.id;
  A = await mk('Alpha Electric');
  B = await mk('Bravo Electric');
});
after(async () => { await t?.close(); });

const asTenant = (tenantId, fn) => t.db.withTenant({ tenantId }, fn);
const hqTx = async (fn) => {
  const c = await t.hqPool.connect();
  try {
    await c.query('BEGIN READ WRITE');
    const r = await fn(c);
    await c.query('ROLLBACK');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
};

test('0150 is applied and every tenant table has RLS enabled, forced and a tenant policy', { skip }, async () => {
  const { rows: v } = await t.superPool.query("SELECT 1 FROM schema_migrations WHERE version = '0150'");
  assert.equal(v.length, 1);
  const { rows } = await t.superPool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [TENANT_TABLES]);
  assert.equal(rows.length, TENANT_TABLES.length);
  for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
  const { rows: pol } = await t.superPool.query("SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE tablename = ANY($1)", [TENANT_TABLES]);
  for (const table of TENANT_TABLES) {
    const p = pol.find((x) => x.policyname === `${table}_tenant`);
    assert.ok(p, `${table}_tenant`);
    assert.match(p.qual, /app_tenant_id\(\)/);
    assert.match(p.qual, /app_portal_client_id\(\) IS NULL/);
    assert.match(p.with_check, /app_tenant_id\(\)/);
  }
  const { rows: plat } = await t.superPool.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('qbo_realms', 'qbo_api_usage')");
  for (const r of plat) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
});

test('tenant tables are invisible across tenants', { skip }, async () => {
  await asTenant(A, (tx) => tx.query("INSERT INTO qbo_connections (tenant_id, environment, realm_hash, state) VALUES ($1, 'sandbox', $2, 'setup')", [A, hash()]));
  await asTenant(A, (tx) => tx.query("INSERT INTO qbo_sync_log (tenant_id, direction, outcome, action) VALUES ($1, 'system', 'info', 'connect')", [A]));
  assert.equal((await asTenant(B, (tx) => tx.query('SELECT * FROM qbo_connections'))).rows.length, 0);
  assert.equal((await asTenant(B, (tx) => tx.query('SELECT * FROM qbo_sync_log'))).rows.length, 0);
  assert.equal((await t.db.query('SELECT * FROM qbo_connections')).rows.length, 0, 'no tenant set: nothing');
  await assert.rejects(asTenant(B, (tx) => tx.query("INSERT INTO qbo_sync_log (tenant_id, direction, outcome, action) VALUES ($1, 'system', 'info', 'x')", [A])), /row-level security/);
  const u = await asTenant(B, (tx) => tx.query("UPDATE qbo_connections SET state = 'active' WHERE tenant_id = $1", [A]));
  assert.equal(u.rowCount, 0);
});

test('qbo_realms: everyone reads; a tenant inserts and deletes only its own; one realm per tenant and one tenant per realm', { skip }, async () => {
  const hA = hash();
  await asTenant(A, (tx) => tx.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, 'sandbox')", [hA, A]));
  const seen = await asTenant(B, (tx) => tx.query('SELECT tenant_id FROM qbo_realms WHERE realm_hash = $1', [hA]));
  assert.equal(seen.rows[0].tenant_id, A, 'B can find who holds a realm (realm_in_use, webhooks)');
  assert.equal((await t.db.query('SELECT tenant_id FROM qbo_realms WHERE realm_hash = $1', [hA])).rows.length, 1, 'platform read');
  await assert.rejects(asTenant(B, (tx) => tx.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, 'sandbox')", [hash(), A])), /row-level security/);
  await assert.rejects(asTenant(B, (tx) => tx.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, 'sandbox')", [hA, B])), /duplicate key|qbo_realms_pkey/);
  await assert.rejects(asTenant(A, (tx) => tx.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, 'sandbox')", [hash(), A])), /duplicate key/);
  assert.equal((await asTenant(B, (tx) => tx.query('DELETE FROM qbo_realms WHERE realm_hash = $1', [hA]))).rowCount, 0);
  await assert.rejects(asTenant(A, (tx) => tx.query('UPDATE qbo_realms SET environment = $2 WHERE realm_hash = $1', [hA, 'production'])), /permission denied/);
  assert.equal((await asTenant(A, (tx) => tx.query('DELETE FROM qbo_realms WHERE realm_hash = $1', [hA]))).rowCount, 1);
  await assert.rejects(asTenant(A, (tx) => tx.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, 'sandbox')", [Buffer.alloc(8), A])), /check constraint/);
});

test('qbo_api_usage: everyone reads (workspace totals); a tenant writes only its own rows', { skip }, async () => {
  await asTenant(A, (tx) => tx.query("INSERT INTO qbo_api_usage (month, tenant_id, environment, coreplus_calls) VALUES ('2026-10-01', $1, 'production', 7)", [A]));
  const sum = await asTenant(B, (tx) => tx.query("SELECT sum(coreplus_calls)::int AS n FROM qbo_api_usage WHERE month = '2026-10-01'"));
  assert.equal(sum.rows[0].n, 7);
  await assert.rejects(asTenant(B, (tx) => tx.query("INSERT INTO qbo_api_usage (month, tenant_id, environment) VALUES ('2026-10-01', $1, 'sandbox')", [A])), /row-level security/);
  assert.equal((await asTenant(B, (tx) => tx.query('UPDATE qbo_api_usage SET coreplus_calls = 0 WHERE tenant_id = $1', [A]))).rowCount, 0);
  assert.equal((await asTenant(B, (tx) => tx.query('DELETE FROM qbo_api_usage WHERE tenant_id = $1', [A]))).rowCount, 0);
  await assert.rejects(asTenant(A, (tx) => tx.query("INSERT INTO qbo_api_usage (month, tenant_id, environment) VALUES ('2026-10-02', $1, 'sandbox')", [A])), /check constraint/);
});

test('platform tables: oauth states, revoke queue and platform events are usable by the app', { skip }, async () => {
  const { rows: u } = await t.db.query("SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner'", [A]);
  await t.db.query("INSERT INTO qbo_oauth_states (tenant_id, user_id, stage, ticket_hash, return_to, expires_at) VALUES ($1, $2, 'ticket', $3, 'web', now())", [A, u[0].user_id, hash()]);
  await t.db.query("INSERT INTO qbo_revoke_pending (environment, token_sealed) VALUES ('sandbox', 'v1.x')");
  await t.db.query("INSERT INTO qbo_platform_events (kind, environment, tenant_id) VALUES ('webhook_signature', 'sandbox', NULL)");
  await assert.rejects(t.db.query("INSERT INTO qbo_platform_events (kind) VALUES ('Bad Kind!')"), /check constraint/);
  await assert.rejects(t.db.query('UPDATE qbo_platform_events SET kind = $1', ['x_y']), /permission denied/);
});

test('HQ: health columns only, never company names, snapshots or messages; pause and release rights', { skip }, async () => {
  await hqTx(async (c) => {
    const r = await c.query('SELECT tenant_id, state, pause_reason, features, lease_epoch, last_pull_at FROM qbo_connections WHERE tenant_id = $1', [A]);
    assert.equal(r.rows.length, 1, 'BYPASSRLS sees every tenant');
  });
  for (const sql of [
    'SELECT company_name FROM qbo_connections', 'SELECT snapshot FROM qbo_links', 'SELECT message FROM qbo_sync_log', 'SELECT label FROM qbo_conflicts',
    'SELECT data FROM qbo_reference', 'SELECT * FROM qbo_mappings', 'SELECT * FROM qbo_candidates', 'SELECT token_sealed FROM qbo_revoke_pending',
    'SELECT realm_hash FROM qbo_realms', 'SELECT qbo_id FROM qbo_inbox', 'SELECT record_id FROM qbo_outbox', 'SELECT * FROM qbo_oauth_states',
  ]) {
    await assert.rejects(hqTx((c) => c.query(sql)), /permission denied/, sql);
  }
  await hqTx(async (c) => {
    await c.query('SELECT tenant_id, collection, state, reason, updated_at FROM qbo_links');
    await c.query('SELECT tenant_id, at, direction, outcome, action, actor_type, collection, error_code, intuit_tid FROM qbo_sync_log');
    await c.query('SELECT tenant_id, environment FROM qbo_realms');
    await c.query('SELECT * FROM qbo_api_usage');
    await c.query('SELECT * FROM qbo_platform_events');
    const p = await c.query(
      "UPDATE qbo_connections SET state = 'paused', state_before = state, pause_reason = 'hq', paused_since = now(), lease_epoch = lease_epoch + 1, lease_until = NULL, updated_at = now() WHERE tenant_id = $1 RETURNING lease_epoch", [A]);
    assert.equal(p.rows[0].lease_epoch, 1);
    await c.query('DELETE FROM qbo_realms WHERE tenant_id = $1', [A]);
  });
  await assert.rejects(hqTx((c) => c.query("UPDATE qbo_connections SET company_name = 'x'")), /permission denied/);
  await assert.rejects(hqTx((c) => c.query('DELETE FROM qbo_links')), /permission denied/);
});

test('deleting a tenant cascades its QuickBooks rows; the revoke queue survives on purpose', { skip }, async () => {
  const before = (await t.superPool.query('SELECT count(*)::int AS n FROM qbo_revoke_pending')).rows[0].n;
  await t.superPool.query('DELETE FROM tenants WHERE id = $1', [A]);
  for (const table of [...TENANT_TABLES, 'qbo_realms', 'qbo_api_usage', 'qbo_oauth_states']) {
    const { rows } = await t.superPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [A]);
    assert.equal(rows[0].n, 0, table);
  }
  assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM qbo_revoke_pending')).rows[0].n, before);
});
