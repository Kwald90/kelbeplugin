// HQ alerts for QuickBooks (docs/integrations/quickbooks.md section 9, server/src/qbo/alerts.js):
// each rule fires at its threshold and not below it, emails go to HQ_NOTIFY_EMAIL at most once
// per alert an hour (budgets once per threshold a month), and the job keeps its 10-minute chain
// only while QuickBooks is on.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skip, createTestDatabase } from './support/db.js';
import { RULES, createQboAlertHandlers, qboBudgets, qboEnabled, runQboAlerts, scheduleQboAlerts, tenantBudget } from '../src/qbo/alerts.js';
import { createTenantWithOwner } from '../src/services/tenants.js';

/**
 * Migration 0150 belongs to W1. Until it is merged, build its tables from the contract's own
 * DDL (docs/integrations/quickbooks.md 3.2), so these tests run against what W1 ships.
 * Does nothing once 0150 exists.
 */
async function ensureQboTables(t) {
  if ((await t.superPool.query("SELECT to_regclass('public.qbo_connections') IS NOT NULL AS ok")).rows[0].ok) return;
  const doc = readFileSync(fileURLToPath(new URL('../../docs/integrations/quickbooks.md', import.meta.url)), 'utf8');
  const ddl = /```sql\r?\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('### 3.2')))[1];
  const policies = ['qbo_links', 'qbo_outbox', 'qbo_inbox', 'qbo_conflicts', 'qbo_sync_log', 'qbo_mappings', 'qbo_reference', 'qbo_candidates', 'stripe_payouts']
    .map((tb) => `ALTER TABLE ${tb} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${tb} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${tb}_tenant ON ${tb} USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
        WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);`).join('\n');
  // The contract's own event list has intuit_5xx, which its CHECK (^[a-z_]{2,40}$) refuses: digits
  // are allowed here, as asked of W1 in the W6 merge report.
  const kinds = "ALTER TABLE qbo_platform_events DROP CONSTRAINT qbo_platform_events_kind_check, ADD CONSTRAINT qbo_platform_events_kind_check CHECK (kind ~ '^[a-z0-9_]{2,40}$');";
  const c = await t.ownerPool.connect();
  try { await c.query(`${ddl}\n${policies}\n${kinds}`); } finally { c.release(); }
}

const NOTIFY = 'hq-alerts@fishtape.test';
const ENV = { QBO_ENVIRONMENT: 'production' };
let t;
const tenants = [];
const rule = (kind) => RULES.find((r) => r.kind === kind);
const check = (kind, env = ENV) => rule(kind).check(t.db, { env });
const month = `${new Date().toISOString().slice(0, 7)}-01`;

/** Platform events of a kind, `minutesAgo` each (one row per entry). */
async function events(kind, minutesAgo, tenantId = null) {
  for (const m of minutesAgo) {
    await t.superPool.query("INSERT INTO qbo_platform_events (kind, at, environment, tenant_id) VALUES ($1, now() - make_interval(secs => $2), 'production', $3)", [kind, Math.round(m * 60), tenantId]);
  }
}
const times = (n, every = 0.5) => Array.from({ length: n }, (_, i) => i * every);

before(async () => {
  if (skip) return;
  t = await createTestDatabase('qboalerts');
  await ensureQboTables(t);
  for (const name of ['Alpha Wiring', 'Bravo Power', 'Charlie Lights', 'Delta Volts']) {
    const { tenant } = await createTenantWithOwner(t.db, { name, owner: { email: `${name.split(' ')[0].toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`, password: `pw-${randomBytes(12).toString('hex')}`, displayName: name } });
    tenants.push(tenant.id);
  }
});
after(async () => { await t?.close(); });

describe('QuickBooks alert rules', { skip }, () => {
  beforeEach(async () => {
    await t.superPool.query('DELETE FROM qbo_platform_events');
    await t.superPool.query('DELETE FROM email_outbox');
  });

  test('platform credentials, webhook signatures, safety brake, realm mismatch, revoke given up: any in the last hour', async () => {
    for (const [kind, event] of [['qbo_platform_credentials', 'platform_credentials'], ['qbo_webhook_signature', 'webhook_signature'],
      ['qbo_safety_brake', 'safety_brake'], ['qbo_realm_mismatch', 'realm_mismatch'], ['qbo_revoke_gave_up', 'revoke_gave_up']]) {
      await events(event, [75]);
      assert.deepEqual(await check(kind), [], `${kind}: an event over an hour old does not fire`);
      await events(event, [3], tenants[0]);
      const f = await check(kind);
      assert.equal(f.length, 1, kind);
      assert.equal(f[0].count, 1);
      if (kind === 'qbo_safety_brake') assert.deepEqual(f[0].companies, ['Alpha Wiring']);
    }
  });

  test('mass revoke: 5 invalid_grant within 15 minutes, not 4, not 5 spread out', async () => {
    await events('invalid_grant', [1, 2, 3, 4]);
    assert.deepEqual(await check('qbo_mass_revoke'), []);
    await t.superPool.query('DELETE FROM qbo_platform_events');
    await events('invalid_grant', [1, 9, 18, 27, 36]);
    assert.deepEqual(await check('qbo_mass_revoke'), [], 'spread over 35 minutes');
    await events('invalid_grant', [5, 10, 12]);
    const f = await check('qbo_mass_revoke');
    assert.equal(f.length, 1);
    assert.equal(f[0].count, 5, 'the most in any 15-minute window');
  });

  test('reconnect spike: 3 different companies in an hour', async () => {
    await events('reconnect_needed', [5, 6, 7], tenants[0]);
    await events('reconnect_needed', [8], tenants[1]);
    assert.deepEqual(await check('qbo_reconnect_spike'), [], 'one company three times is not a spike');
    await events('reconnect_needed', [70], tenants[2]);
    assert.deepEqual(await check('qbo_reconnect_spike'), [], 'the third was over an hour ago');
    await events('reconnect_needed', [9], tenants[2]);
    const f = await check('qbo_reconnect_spike');
    assert.equal(f[0].count, 3);
    assert.deepEqual(f[0].companies, ['Alpha Wiring', 'Bravo Power', 'Charlie Lights']);
  });

  test('Intuit 5xx: more than 20 in 10 minutes', async () => {
    await events('intuit_5xx', times(20, 0.4));
    assert.deepEqual(await check('qbo_intuit_5xx'), []);
    await events('intuit_5xx', [0.1]);
    assert.equal((await check('qbo_intuit_5xx'))[0].count, 21);
  });

  test('failing jobs: 5 failed qbo_* jobs in an hour', async () => {
    const fail = (kind, minutesAgo = 5) => t.superPool.query(
      "INSERT INTO jobs_queue (kind, status, finished_at, last_error) VALUES ($1, 'failed', now() - make_interval(mins => $2), 'QuickBooks rejected a duplicate name')", [kind, minutesAgo]);
    for (let i = 0; i < 4; i++) await fail('qbo_sync');
    await fail('qbo_cdc', 90);
    await fail('integrations_send');
    await fail('qboxsync');
    assert.deepEqual(await check('qbo_jobs_failing'), [], 'four recent ones; the others are old or not QuickBooks jobs');
    await fail('qbo_check');
    assert.equal((await check('qbo_jobs_failing'))[0].count, 5);
    await t.superPool.query('DELETE FROM jobs_queue');
  });

  test('inbox backlog: an active company dirty for more than 2 hours', async () => {
    const add = (tenantId, state, dirtyHours) => t.superPool.query(
      `INSERT INTO qbo_connections (tenant_id, environment, realm_hash, state, pause_reason, dirty_at) VALUES ($1, 'production', $2, $3, $4, now() - make_interval(hours => $5))`, [tenantId, randomBytes(32), state, state === 'paused' ? 'user' : null, dirtyHours]);
    await add(tenants[0], 'active', 1);
    await add(tenants[1], 'paused', 5);
    await add(tenants[2], 'active', 3);
    // The dispatcher's list of connected companies.
    await t.superPool.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) SELECT realm_hash, tenant_id, 'production' FROM qbo_connections");
    const f = await check('qbo_inbox_backlog');
    assert.equal(f.length, 1);
    assert.deepEqual(f[0].companies, ['Charlie Lights']);
    await t.superPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenants[2]]);
    assert.deepEqual(await check('qbo_inbox_backlog'), [], 'suspended companies are not synced, so not alerted');
    await t.superPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenants[2]]);
    await t.superPool.query('DELETE FROM qbo_realms; DELETE FROM qbo_connections;');
  });

  test('budget: the workspace at 70% and 90%, a company at half its budget', async () => {
    const use = (tenantId, coreplus, environment = 'production') => t.superPool.query(
      `INSERT INTO qbo_api_usage (month, tenant_id, environment, coreplus_calls) VALUES ($1, $2, $3, $4)
       ON CONFLICT (month, tenant_id, environment) DO UPDATE SET coreplus_calls = EXCLUDED.coreplus_calls`, [month, tenantId, environment, coreplus]);
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = ANY($1)", [[tenants[0], tenants[1]]]);
    await use(tenants[0], 9_999);
    await use(tenants[1], 300_000, 'sandbox');
    assert.deepEqual(await check('qbo_budget'), [], 'under half, and sandbox never counts');
    await use(tenants[3], 2_500); // on trial: half of 5,000
    let f = await check('qbo_budget');
    assert.deepEqual(f.map((x) => x.companies), [['Delta Volts']]);
    await use(tenants[0], 304_000); // with Delta: 306,500 of 450,000 = 68%
    f = await check('qbo_budget');
    assert.ok(!f.some((x) => x.key.startsWith('workspace')));
    await use(tenants[0], 312_500); // 315,000 = 70%
    f = await check('qbo_budget');
    assert.ok(f.some((x) => x.key === `workspace:70:${month.slice(0, 7)}`));
    assert.deepEqual(f.filter((x) => x.key.startsWith('tenant')).map((x) => x.companies[0]).sort(), ['Alpha Wiring', 'Delta Volts']);
    await use(tenants[0], 402_500); // 405,000 = 90%
    assert.ok((await check('qbo_budget')).some((x) => x.key === `workspace:90:${month.slice(0, 7)}`));
    assert.ok((await check('qbo_budget', { ...ENV, QBO_READ_BUDGET: '1000000' })).every((x) => !x.key.startsWith('workspace')), 'QBO_READ_BUDGET is honoured');
    await t.superPool.query('DELETE FROM qbo_api_usage');
  });

  test('budgets and the on/off switch read the environment with the contract\'s defaults', () => {
    assert.deepEqual(qboBudgets({}), { workspace: 450000, tenant: 20000, trial: 5000 });
    assert.deepEqual(qboBudgets({ QBO_READ_BUDGET: '100', QBO_TENANT_READ_BUDGET: 'x', QBO_TRIAL_READ_BUDGET: '-1' }), { workspace: 100, tenant: 20000, trial: 5000 });
    assert.equal(tenantBudget({ plan: 'trial' }, qboBudgets({})), 5000);
    assert.equal(tenantBudget({ plan: 'pro', billing_status: 'trialing' }, qboBudgets({})), 5000);
    assert.equal(tenantBudget({ plan: 'pro', billing_status: 'active' }, qboBudgets({})), 20000);
    assert.equal(qboEnabled({}), false);
    assert.equal(qboEnabled({ QBO_ENVIRONMENT: ' ' }), false);
    assert.equal(qboEnabled({ QBO_ENVIRONMENT: 'sandbox' }), true);
  });
});

describe('QuickBooks alert emails and the job', { skip }, () => {
  beforeEach(async () => {
    await t.superPool.query('DELETE FROM qbo_platform_events');
    await t.superPool.query('DELETE FROM email_outbox');
    await t.superPool.query('DELETE FROM jobs_queue');
  });
  const outbox = async () => (await t.superPool.query('SELECT to_address, template, subject, text_body FROM email_outbox ORDER BY created_at')).rows;

  test('one email per alert an hour, to HQ_NOTIFY_EMAIL, with first steps and no customer data', async () => {
    await events('safety_brake', [2], tenants[0]);
    await events('webhook_signature', [1, 2]);
    const r = await runQboAlerts({ db: t.db, notifyEmail: NOTIFY, hqLink: 'https://hq.fishtape.test/#/developer/quickbooks', env: ENV });
    assert.deepEqual(r.fired.sort(), ['qbo_safety_brake', 'qbo_webhook_signature']);
    assert.equal(r.emailed, 2);
    assert.deepEqual(r.broken, []);
    let mail = await outbox();
    assert.equal(mail.length, 2);
    const brake = mail.find((m) => m.template === 'hq-qbo-alert:qbo_safety_brake');
    assert.equal(brake.to_address, NOTIFY);
    assert.match(brake.subject, /^QuickBooks alert: /);
    assert.match(brake.text_body, /Companies: Alpha Wiring/);
    assert.match(brake.text_body, /First steps:\n- /);
    assert.match(brake.text_body, /docs\/runbooks\/quickbooks-support\.md/);
    assert.match(brake.text_body, /https:\/\/hq\.fishtape\.test\/#\/developer\/quickbooks/);

    // Still firing ten minutes later: no new email within the hour.
    await events('safety_brake', [1], tenants[1]);
    assert.equal((await runQboAlerts({ db: t.db, notifyEmail: NOTIFY, env: ENV })).emailed, 0);
    // An hour after the last email it goes out again.
    await t.superPool.query("UPDATE email_outbox SET created_at = now() - interval '61 minutes'");
    assert.equal((await runQboAlerts({ db: t.db, notifyEmail: NOTIFY, env: ENV })).emailed, 2);
    mail = await outbox();
    assert.equal(mail.length, 4);
  });

  test('a budget threshold is emailed once a month; nothing is sent without HQ_NOTIFY_EMAIL', async () => {
    await t.superPool.query("INSERT INTO qbo_api_usage (month, tenant_id, environment, coreplus_calls) VALUES ($1, $2, 'production', 320000)", [month, tenants[0]]);
    const first = await runQboAlerts({ db: t.db, notifyEmail: NOTIFY, env: ENV, rules: [rule('qbo_budget')] });
    assert.equal(first.emailed, 2, 'the workspace at 70% and Alpha over half its budget');
    await t.superPool.query("UPDATE email_outbox SET created_at = now() - interval '3 hours'");
    assert.equal((await runQboAlerts({ db: t.db, notifyEmail: NOTIFY, env: ENV, rules: [rule('qbo_budget')] })).emailed, 0, 'not again this month');
    await t.superPool.query('DELETE FROM email_outbox');
    const quiet = await runQboAlerts({ db: t.db, notifyEmail: '', env: ENV, rules: [rule('qbo_budget')] });
    assert.equal(quiet.fired.length, 2);
    assert.equal(quiet.emailed, 0);
    assert.equal((await outbox()).length, 0);
    await t.superPool.query('DELETE FROM qbo_api_usage');
  });

  test('a broken rule does not stop the others', async () => {
    await events('realm_mismatch', [1]);
    const broken = { kind: 'qbo_broken', title: 'x', steps: [], check: async () => { throw new Error('boom'); } };
    const r = await runQboAlerts({ db: t.db, notifyEmail: NOTIFY, env: ENV, rules: [broken, rule('qbo_realm_mismatch')] });
    assert.deepEqual(r.broken, ['qbo_broken']);
    assert.deepEqual(r.fired, ['qbo_realm_mismatch']);
  });

  test('the job runs every 10 minutes while QuickBooks is on, and not at all when it is off', async () => {
    const at = new Date('2026-10-20T15:04:00Z');
    await scheduleQboAlerts(t.db, at, {});
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM jobs_queue WHERE kind = 'qbo_alerts'")).rows[0].n, 0, 'off: nothing scheduled');
    await scheduleQboAlerts(t.db, at, ENV);
    await scheduleQboAlerts(t.db, at, ENV);
    const queued = (await t.superPool.query("SELECT dedupe_key FROM jobs_queue WHERE kind = 'qbo_alerts'")).rows;
    assert.deepEqual(queued.map((j) => j.dedupe_key), ['qbo_alerts:2026-10-20T15:00'], 'one job per 10-minute slot');

    await t.superPool.query('DELETE FROM jobs_queue');
    const handlers = createQboAlertHandlers({ env: { ...ENV, HQ_NOTIFY_EMAIL: NOTIFY, APP_ENV: 'test', SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), PUBLIC_ORIGIN: 'https://app.fishtape.test' }, now: () => at });
    await events('revoke_gave_up', [1]);
    const r = await handlers.qbo_alerts({ db: t.db, job: { payload: {} } });
    assert.deepEqual(r.fired, ['qbo_revoke_gave_up']);
    assert.equal(r.emailed, 1);
    assert.match((await outbox())[0].text_body, /https:\/\/app\.fishtape\.test\/hq\/#\/developer\/quickbooks/);
    const next = (await t.superPool.query("SELECT dedupe_key, run_at FROM jobs_queue WHERE kind = 'qbo_alerts'")).rows;
    assert.deepEqual(next.map((j) => j.dedupe_key), ['qbo_alerts:2026-10-20T15:10']);
    assert.equal(new Date(next[0].run_at).toISOString(), '2026-10-20T15:14:00.000Z');

    await t.superPool.query('DELETE FROM jobs_queue');
    const off = createQboAlertHandlers({ env: {}, now: () => at });
    assert.deepEqual(await off.qbo_alerts({ db: t.db, job: { payload: {} } }), { skipped: 'QuickBooks is off on this server' });
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM jobs_queue WHERE kind = 'qbo_alerts'")).rows[0].n, 0, 'the chain stops while QuickBooks is off');
  });
});
