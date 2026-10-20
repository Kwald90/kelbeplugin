// HQ and QuickBooks (docs/integrations/quickbooks.md section 9): the health block on a company
// has counts only (never the QuickBooks company name, record ids, messages or the realm), pause
// and release are audited in the company's own log and need a reason, closing a company runs
// the QuickBooks housekeeping at once, the developer page and the env settings.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, testConfig } from './support/app.js';
import { hqUser, startHqApp } from './support/hq.js';
import { envSettings } from '../src/services/hq-settings.js';

// Distinctive values that must never reach HQ.
const COMPANY = 'Zebra Quokka Books Ltd';
const RECORD = 'inv-hidden-4471';
const MESSAGE = 'Customer Pat Quokka-Customer is a duplicate name';
const REALM = randomBytes(32);

let t, app, A, B, C, admin, staff;
const hq = (token, url, opts = {}) => call(app, { url, token, ...opts });
const events = async (tenantId, action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows;
const conn = async (tenantId) => (await t.superPool.query('SELECT * FROM qbo_connections WHERE tenant_id = $1', [tenantId])).rows[0];
const jobs = async (kind, tenantId) => (await t.superPool.query('SELECT * FROM jobs_queue WHERE kind = $1 AND tenant_id = $2', [kind, tenantId])).rows;
const month = `${new Date().toISOString().slice(0, 7)}-01`;

async function connect(tenantId, { state = 'active', pauseReason = null } = {}) {
  const s = t.superPool;
  await s.query(
    `INSERT INTO qbo_connections (tenant_id, environment, realm_hash, state, pause_reason, paused_since, company_name, features, connected_at, last_pull_at, last_push_at,
                                  refresh_expires_at, refresh_hard_expires_at, lease_epoch, lease_until, lease_by)
     VALUES ($1, 'production', $2, $3, $4, CASE WHEN $3 = 'paused' THEN now() END, $5, $6, now() - interval '3 days', now() - interval '5 minutes', now() - interval '6 minutes',
             now() + interval '90 days', now() + interval '5 years', 7, now() + interval '1 minute', 'worker-1')`,
    [tenantId, tenantId === A.tenantId ? REALM : randomBytes(32), state, pauseReason, COMPANY, { edition: 'QuickBooks Online Plus', salesTax: true }]);
  await s.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) SELECT realm_hash, tenant_id, 'production' FROM qbo_connections WHERE tenant_id = $1", [tenantId]);
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('hqqbo');
  ({ app } = await startHqApp(t));
  A = await ownerTenant(t, app, 'Alpha Wiring');
  B = await ownerTenant(t, app, 'Bravo Power');
  C = await ownerTenant(t, app, 'Charlie Lights');
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
  await connect(A.tenantId);
  const s = t.superPool;
  const realm = (await conn(A.tenantId)).realm_hash;
  // Links in several states, with record ids and QuickBooks ids that HQ must not see.
  for (const [i, state] of ['synced', 'synced', 'synced', 'pending', 'error', 'blocked', 'needs_review'].entries()) {
    await s.query(
      `INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state, reason, last_error, snapshot)
       VALUES ($1, $2, 'invoices', $3, 'Invoice', $4, $5, $6, $7, $8)`,
      [A.tenantId, realm, `${RECORD}-${i}`, String(9000 + i), state, state === 'error' ? 'duplicate_name' : null, state === 'error' ? MESSAGE : null, { label: COMPANY }]);
  }
  const link = (await s.query("SELECT id FROM qbo_links WHERE tenant_id = $1 AND state = 'needs_review'", [A.tenantId])).rows[0].id;
  await s.query("INSERT INTO qbo_conflicts (tenant_id, link_id, kind, collection, record_id, label, reason) VALUES ($1, $2, 'review', 'invoices', $3, $4, 'origin')", [A.tenantId, link, RECORD, `Invoice for ${COMPANY}`]);
  await s.query(
    `INSERT INTO qbo_sync_log (tenant_id, direction, outcome, action, collection, record_id, label, message, error_code, intuit_tid)
     VALUES ($1, 'push', 'error', 'create', 'invoices', $2, $3, $4, '6240', '1-abc-intuit'), ($1, 'push', 'error', 'create', 'invoices', $2, $3, $4, '6240', '1-def-intuit'),
            ($1, 'pull', 'ok', 'update', 'clients', $2, $3, 'fine', NULL, NULL)`, [A.tenantId, RECORD, COMPANY, MESSAGE]);
  await s.query("INSERT INTO qbo_sync_log (tenant_id, at, direction, outcome, action, message) VALUES ($1, now() - interval '2 days', 'push', 'error', 'create', 'old')", [A.tenantId]);
  await s.query("INSERT INTO qbo_inbox (tenant_id, realm_hash, entity, qbo_id, op, event_time) VALUES ($1, $2, 'TimeActivity', '55', 'updated', now())", [A.tenantId, realm]);
  await s.query("INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, rank, enqueued_at) VALUES ($1, 'invoices', $2, 'upsert', 40, now() - interval '1 hour'), ($1, 'clients', 'c-9', 'upsert', 10, now())", [A.tenantId, RECORD]);
  await s.query(
    `INSERT INTO qbo_api_usage (month, tenant_id, environment, core_calls, coreplus_calls, throttled, errors)
     VALUES ($1, $2, 'production', 812, 1430, 1, 2), ($1, $2, 'sandbox', 5, 9, 0, 0)`, [month, A.tenantId]);
});
after(async () => { await app?.close(); await t?.close(); });

describe('HQ QuickBooks block', { skip }, () => {
  test('a connected company shows health and counts, never QuickBooks data', async () => {
    const r = await hq(staff.token, `/api/hq/tenants/${A.tenantId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const q = r.body.quickbooks;
    assert.equal(q.connected, true);
    assert.equal(q.state, 'active');
    assert.equal(q.environment, 'production');
    assert.equal(q.edition, 'QuickBooks Online Plus');
    assert.deepEqual(q.links, { synced: 3, pending: 1, error: 1, blocked: 1, conflict: 0, needs_review: 1 });
    assert.equal(q.errors24h, 2, 'yesterday\'s error is older than 24 hours');
    assert.equal(q.conflictsOpen, 1);
    assert.equal(q.inboxBacklog, 1);
    assert.equal(q.outboxWaiting, 2);
    assert.ok(Date.now() - new Date(q.outboxOldestAt).getTime() > 3500_000);
    assert.deepEqual(q.usageThisMonth, { core: 812, coreplus: 1430, budget: 5000 }, 'a company on trial has the trial budget');
    for (const k of ['connectedAt', 'lastPullAt', 'lastPushAt', 'refreshExpiresAt', 'hardExpiresAt']) assert.ok(q[k], k);
    // Intuit transaction ids identify a request, not a customer: HQ needs them for Intuit support.
    assert.equal(q.recentErrors.length, 3);
    assert.deepEqual(Object.keys(q.recentErrors[0]).sort(), ['action', 'at', 'collection', 'direction', 'errorCode', 'intuitTid']);
    assert.deepEqual(q.recentErrors.map((e) => e.intuitTid).filter(Boolean).sort(), ['1-abc-intuit', '1-def-intuit']);
    const text = JSON.stringify(r.body);
    for (const s of [COMPANY, RECORD, MESSAGE, 'Quokka', '9000', REALM.toString('hex'), REALM.toString('base64')]) assert.ok(!text.includes(s), `HQ response holds ${s}`);
  });

  test('a paid company has the per-company budget; a company that never connected says so', async () => {
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
    assert.equal((await hq(staff.token, `/api/hq/tenants/${A.tenantId}`)).body.quickbooks.usageThisMonth.budget, 20000);
    assert.deepEqual((await hq(staff.token, `/api/hq/tenants/${B.tenantId}`)).body.quickbooks, { connected: false, state: 'not_connected' });
  });
});

describe('HQ QuickBooks actions', { skip }, () => {
  test('pause needs a reason, is audited in the company\'s log and fences a running pass', async () => {
    const url = `/api/hq/tenants/${A.tenantId}/quickbooks/pause`;
    assert.equal((await hq(staff.token, url, { method: 'POST', body: { paused: true } })).status, 400, 'reason required');
    assert.equal((await hq(staff.token, url, { method: 'POST', body: { paused: true, reason: 'x' } })).status, 400, 'reason too short');
    assert.equal((await hq(A.token, url, { method: 'POST', body: { paused: true, reason: 'Looks like a sync loop' } })).status, 403, 'a company owner cannot');
    const r = await hq(staff.token, url, { method: 'POST', body: { paused: true, reason: 'Looks like a sync loop' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'paused');
    assert.equal(r.body.pauseReason, 'hq');
    const c = await conn(A.tenantId);
    assert.equal(c.state_before, 'active');
    assert.ok(c.paused_since);
    assert.notEqual(Number(c.lease_epoch), 7, 'the epoch moved, so a running pass stops before its next write');
    assert.equal(c.lease_until, null);
    const ev = await events(A.tenantId, 'hq.qbo.pause');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor_type, 'hq');
    assert.match(ev[0].summary, /paused QuickBooks sync: Looks like a sync loop/);
    assert.deepEqual(ev[0].meta, { paused: true, from: { state: 'active', pauseReason: null } });
    // Pausing again changes nothing.
    assert.equal((await hq(staff.token, url, { method: 'POST', body: { paused: true, reason: 'Still looking' } })).body.pauseReason, 'hq');
    assert.equal((await events(A.tenantId, 'hq.qbo.pause')).length, 1);
  });

  test('only HQ resumes an HQ pause; resuming starts a pass', async () => {
    const url = `/api/hq/tenants/${A.tenantId}/quickbooks/pause`;
    const r = await hq(staff.token, url, { method: 'POST', body: { paused: false, reason: 'Loop fixed in 1.4.2' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'active');
    assert.equal(r.body.pauseReason, null);
    assert.equal(r.body.pausedSince, null);
    assert.equal((await conn(A.tenantId)).state_before, null);
    const [job] = await jobs('qbo_sync', A.tenantId);
    assert.ok(job, 'a pass is queued');
    // The sweep has its own dedupe key, so a plain qbo_sync already waiting cannot swallow it (2.5).
    assert.equal(job.dedupe_key, `qbo_sync:${A.tenantId}:sweep`);
    assert.equal(job.payload.sweep, true);
    assert.equal((await hq(staff.token, url, { method: 'POST', body: { paused: false, reason: 'Again please' } })).status, 409, 'not paused by HQ');
    assert.equal((await events(A.tenantId, 'hq.qbo.pause')).length, 2);
  });

  test('an HQ pause over the company\'s own pause gives that pause back', async () => {
    await connect(C.tenantId, { state: 'paused', pauseReason: 'brake' });
    const url = `/api/hq/tenants/${C.tenantId}/quickbooks/pause`;
    assert.equal((await hq(staff.token, url, { method: 'POST', body: { paused: true, reason: 'Investigating the brake' } })).body.pauseReason, 'hq');
    assert.equal((await conn(C.tenantId)).state_before, 'paused');
    const r = await hq(staff.token, url, { method: 'POST', body: { paused: false, reason: 'Done looking' } });
    assert.equal(r.body.state, 'paused');
    assert.equal(r.body.pauseReason, 'brake', 'the brake still needs the company\'s confirmation');
    assert.ok(r.body.pausedSince);
    assert.equal((await jobs('qbo_sync', C.tenantId)).length, 0);
    assert.equal((await hq(staff.token, `/api/hq/tenants/${B.tenantId}/quickbooks/pause`, { method: 'POST', body: { paused: true, reason: 'No connection here' } })).status, 404);
  });

  test('release is for HQ admins, needs a reason, frees the QuickBooks company and runs the housekeeping', async () => {
    const url = `/api/hq/tenants/${A.tenantId}/quickbooks/release`;
    assert.equal((await hq(staff.token, url, { method: 'POST', body: { reason: 'Former employee squatting' } })).status, 403);
    assert.equal((await hq(admin.token, url, { method: 'POST', body: {} })).status, 400);
    const epoch = Number((await conn(A.tenantId)).lease_epoch);
    const r = await hq(admin.token, url, { method: 'POST', body: { reason: 'Former employee squatting' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'disconnected');
    assert.equal(r.body.connected, false);
    assert.notEqual(Number((await conn(A.tenantId)).lease_epoch), epoch);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM qbo_realms WHERE tenant_id = $1', [A.tenantId])).rows[0].n, 0, 'another company can connect it now');
    const job = await jobs('qbo_token_housekeeping', A.tenantId);
    assert.equal(job.length, 1);
    assert.deepEqual(job[0].payload, { tenantId: A.tenantId });
    const ev = await events(A.tenantId, 'hq.qbo.release');
    assert.equal(ev.length, 1);
    assert.match(ev[0].summary, /released this company's QuickBooks connection: Former employee squatting/);
  });

  test('closing a company runs the QuickBooks housekeeping at once (revoke before the purge)', async () => {
    await connect(B.tenantId);
    await hq(admin.token, `/api/hq/tenants/${B.tenantId}/export`);
    const r = await hq(admin.token, `/api/hq/tenants/${B.tenantId}/delete`, { method: 'POST', body: { confirmSlug: 'bravo-power', reason: 'Customer asked to close' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const job = await jobs('qbo_token_housekeeping', B.tenantId);
    assert.equal(job.length, 1);
    assert.ok(new Date(job[0].run_at).getTime() <= Date.now() + 1000, 'now, not at the purge');
    // A company without QuickBooks gets no such job.
    const D = await ownerTenant(t, app, 'Delta Volts');
    await hq(admin.token, `/api/hq/tenants/${D.tenantId}/export`);
    await hq(admin.token, `/api/hq/tenants/${D.tenantId}/delete`, { method: 'POST', body: { confirmSlug: 'delta-volts', reason: 'Customer asked to close' } });
    assert.equal((await jobs('qbo_token_housekeeping', D.tenantId)).length, 0);
  });
});

describe('HQ developer and settings', { skip }, () => {
  test('the developer page has workspace totals, states and the top companies, counts only', async () => {
    const r = await hq(staff.token, '/api/hq/developer/quickbooks');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.month, month);
    assert.equal(r.body.intuitCap, 500000);
    assert.equal(r.body.budget, 450000);
    assert.deepEqual(r.body.production, { core: 812, coreplus: 1430, pct: 0.3 });
    assert.deepEqual(r.body.sandbox, { core: 5, coreplus: 9 });
    assert.equal(r.body.states.disconnected, 1);
    assert.equal(r.body.states['paused:brake'], 1);
    assert.equal(r.body.states.active, 1);
    assert.equal(r.body.top[0].tenantName, 'Alpha Wiring');
    assert.equal(r.body.top[0].coreplus, 1430);
    // Each company is measured against its own budget: the trial one while it is on a free trial.
    await t.superPool.query("UPDATE tenants SET plan = 'trial', billing_status = 'trialing' WHERE id = $1", [A.tenantId]);
    assert.equal((await hq(staff.token, '/api/hq/developer/quickbooks')).body.top[0].budget, 5000);
    await t.superPool.query("UPDATE tenants SET plan = 'pro', billing_status = 'active' WHERE id = $1", [A.tenantId]);
    assert.equal((await hq(staff.token, '/api/hq/developer/quickbooks')).body.top[0].budget, 20000);
    const text = JSON.stringify(r.body);
    for (const s of [COMPANY, RECORD, MESSAGE]) assert.ok(!text.includes(s), s);
    assert.equal((await hq(A.token, '/api/hq/developer/quickbooks')).status, 403);
  });

  test('settings show the QuickBooks switches and whether the Intuit credentials are set, never their values', async () => {
    const secret = `qbo-secret-${randomBytes(8).toString('hex')}`;
    const rows = envSettings(testConfig(), { QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: 'ABclientid', QBO_CLIENT_SECRET: secret, QBO_WEBHOOK_VERIFIER: secret, QBO_WRITES: 'off', QBO_READ_BUDGET: '300000' });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by.QBO_ENVIRONMENT.value, 'sandbox');
    assert.match(by.QBO_WRITES.value, /^off/);
    assert.match(by.QBO_READ_BUDGET.value, /^300,000/);
    assert.equal(by.QBO_TENANT_READ_BUDGET.value, '20,000');
    assert.equal(by.QBO_CLIENT_SECRET.value, 'set');
    assert.equal(by.QBO_WEBHOOK_VERIFIER_PREVIOUS.value, 'not set');
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.ok(!JSON.stringify(rows).includes('ABclientid'));
    const off = Object.fromEntries(envSettings(testConfig(), {}).map((r) => [r.key, r.value]));
    assert.match(off.QBO_ENVIRONMENT, /QuickBooks is off/);
    const r = await hq(staff.token, '/api/hq/settings');
    assert.ok(r.body.env.some((e) => e.key === 'QBO_CLIENT_SECRET'));
  });
});
