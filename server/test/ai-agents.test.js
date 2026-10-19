// Background agents: rule-based checks per company, draft messages and tasks in the outbox
// for a person to approve, once-a-day throttle, dedupe, optional Claude wording under the
// company's own key and cap.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';
import { mockAnthropic, restoreAnthropic, text, turn } from './support/anthropic-mock.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { setSecret } from '../src/services/secrets.js';
import { readAiConfig } from '../src/ai/config.js';
import { dispatch, scanTenant } from '../src/ai/background.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-21T15:00:00Z'); // a Wednesday
const day = (offset) => new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);
let t, app, A, C, records, aiCfg;

async function seed(token) {
  await call(app, { method: 'POST', url: '/api/v1/settings', token, body: { id: 'settings', company: { name: 'Seed Electric', province: 'AB' } } });
  const client = (await call(app, { method: 'POST', url: '/api/v1/clients', token, body: { name: 'Pat Late-Payer', email: 'pat@example.test' } })).body;
  const inv = (await call(app, { method: 'POST', url: '/api/v1/invoices', token, body: {
    number: 'INV-3001', clientId: client.id, status: 'sent', issueDate: day(-60), dueDate: day(-30), lines: [{ description: 'Service upgrade', qty: 1, unitCents: 100000, kind: 'other' }], taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }],
  } })).body;
  await call(app, { method: 'POST', url: '/api/v1/payments', token, body: { invoiceId: inv.id, amountCents: 20000, date: day(-20), method: 'card' } });
  await call(app, { method: 'POST', url: '/api/v1/invoices', token, body: { number: 'INV-3002', clientId: client.id, status: 'sent', dueDate: day(10), lines: [{ description: 'Not due', qty: 1, unitCents: 100, kind: 'other' }] } });
  await call(app, { method: 'POST', url: '/api/v1/permits', token, body: { number: 'P-77', authority: 'City', status: 'issued', expiryDate: day(10) } });
  await call(app, { method: 'POST', url: '/api/v1/permits', token, body: { number: 'P-78', status: 'issued', expiryDate: day(90) } });
  await call(app, { method: 'POST', url: '/api/v1/employees', token, body: { id: 'emp-sam', name: 'Sam Sparks', role: 'electrician', licenceExpiry: day(20) } });
  await call(app, { method: 'POST', url: '/api/v1/certifications', token, body: { employeeId: 'emp-sam', name: 'First aid', expiry: day(5) } });
  await call(app, { method: 'POST', url: '/api/v1/items', token, body: { sku: 'W14', name: 'NMD90 14/2', reorderPoint: 10, stock: { shop: 2, van: 1 } } });
  await call(app, { method: 'POST', url: '/api/v1/items', token, body: { sku: 'W12', name: 'NMD90 12/2', reorderPoint: 5, stock: { shop: 20 } } });
  await call(app, { method: 'POST', url: '/api/v1/timeEntries', token, body: { employeeId: 'emp-sam', clockIn: new Date(NOW - 10 * DAY).toISOString(), clockOut: new Date(NOW - 10 * DAY + 8 * 3600_000).toISOString(), breakMins: 30, approved: false } });
  await call(app, { method: 'POST', url: '/api/v1/timeEntries', token, body: { employeeId: 'emp-sam', clockIn: new Date(NOW - 2 * DAY).toISOString(), clockOut: new Date(NOW - 2 * DAY + 3600_000).toISOString(), approved: false } });
  return { client, inv };
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('aiagents');
  ({ app } = await startApp(t));
  records = createRecords({ validator: createValidator() });
  aiCfg = readAiConfig({});
  A = await ownerTenant(t, app, 'Agents A Ltd');
  A.seed = await seed(A.token);
  C = await ownerTenant(t, app, 'Agents C Ltd');
  C.seed = await seed(C.token);
});
after(async () => { restoreAnthropic(); await app?.close(); await t?.close(); });

const scan = (tenantId, opts = {}) => scanTenant({ db: t.db, sealer: app.sealer, records, aiCfg, tenantId, now: NOW, ...opts });

describe('background checks', { skip }, () => {
  test('each check creates one suggestion with a draft in the outbox; nothing is sent', async () => {
    const mock = mockAnthropic([]);
    const r = await scan(A.tenantId);
    assert.deepEqual(r, { findings: 6, created: 6, aiDrafts: 0 });
    assert.equal(mock.calls.length, 0, 'no model call without the company opting in');
    const list = (await call(app, { url: '/api/v1/ai/suggestions', token: A.token })).body.data;
    assert.deepEqual(list.map((s) => s.kind).sort(), ['certification_expiry', 'licence_expiry', 'low_stock', 'overdue_invoice', 'permit_expiry', 'unapproved_time']);
    const overdue = list.find((s) => s.kind === 'overdue_invoice');
    assert.match(overdue.title, /INV-3001 is 30 days overdue \(\$850\.00 owing\)/);
    assert.equal(overdue.message.channel, 'email');
    assert.equal(overdue.message.to, 'pat@example.test');
    assert.equal(overdue.message.status, 'draft');
    assert.match(overdue.message.body, /\$850\.00/);
    const low = list.find((s) => s.kind === 'low_stock');
    assert.match(low.detail, /NMD90 14\/2: 3 on hand, reorder at 10/);
    assert.ok(!low.detail.includes('12/2'));
    const outbox = (await call(app, { url: '/api/v1/outbox?status=draft', token: A.token })).body.data;
    assert.equal(outbox.length, 6);
    assert.equal((await call(app, { url: '/api/v1/outbox?status=queued', token: A.token })).body.data.length, 0);
    const audit = await t.superPool.query("SELECT DISTINCT actor_type FROM audit_events WHERE tenant_id = $1 AND collection = 'outbox' AND action = 'record.create'", [A.tenantId]);
    assert.deepEqual(audit.rows.map((x) => x.actor_type), ['agent']);
  });

  test('throttled to one run a day, and findings are never suggested twice', async () => {
    assert.deepEqual(await scan(A.tenantId), { skipped: 'already ran today' });
    assert.equal((await scan(A.tenantId, { force: true })).created, 0, 'a forced re-run dedupes');
    const next = await scan(A.tenantId, { now: new Date(NOW.getTime() + DAY) });
    assert.equal(next.created, 0, 'the next day finds the same things and adds nothing');
    const later = await scan(A.tenantId, { now: new Date(NOW.getTime() + 15 * DAY) });
    assert.ok(later.created >= 1, 'an overdue reminder repeats after two more weeks');
  });

  test('people see suggestions for what they can read; only managers act on them', async () => {
    const el = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-el' });
    const seen = (await call(app, { url: '/api/v1/ai/suggestions', token: el.token })).body.data.map((s) => s.kind);
    assert.ok(!seen.includes('overdue_invoice'));
    assert.ok(seen.includes('permit_expiry'));
    const permit = (await call(app, { url: '/api/v1/ai/suggestions', token: el.token })).body.data.find((s) => s.kind === 'permit_expiry');
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/ai/suggestions/${permit.id}/approve`, token: el.token, body: {} })).status, 403);
    const B = await ownerTenant(t, app, 'Agents B Ltd');
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/ai/suggestions/${permit.id}/approve`, token: B.token, body: {} })).status, 404, 'another company cannot see it');
  });

  test('approving queues the (edited) message as the person; dismissing removes the draft', async () => {
    const list = (await call(app, { url: '/api/v1/ai/suggestions', token: A.token })).body.data;
    const overdue = list.find((s) => s.kind === 'overdue_invoice' && s.title.includes('30 days'));
    const ok = await call(app, { method: 'POST', url: `/api/v1/ai/suggestions/${overdue.id}/approve`, token: A.token, body: { subject: 'Friendly reminder: INV-3001' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'approved');
    assert.equal(ok.body.message.status, 'queued');
    assert.equal(ok.body.message.subject, 'Friendly reminder: INV-3001');
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/ai/suggestions/${overdue.id}/approve`, token: A.token, body: {} })).status, 409);
    const ev = await t.superPool.query("SELECT actor_type FROM audit_events WHERE tenant_id = $1 AND action = 'ai.suggestion_approve'", [A.tenantId]);
    assert.deepEqual(ev.rows.map((x) => x.actor_type), ['user']);
    const low = list.find((s) => s.kind === 'low_stock');
    const dis = await call(app, { method: 'POST', url: `/api/v1/ai/suggestions/${low.id}/dismiss`, token: A.token });
    assert.equal(dis.body.status, 'dismissed');
    assert.equal((await call(app, { url: `/api/v1/outbox/${low.message.id}`, token: A.token })).status, 404);
  });

  test('when the company opts in, Claude words reminders with its key, logged as background usage; at the cap it falls back to the template', async () => {
    await t.db.withTenant({ tenantId: C.tenantId }, (tx) => setSecret(tx, app.sealer, 'anthropic.api_key', 'sk-ant-company-C-key'));
    await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: C.token, body: { backgroundAiDrafts: true } });
    const mock = mockAnthropic([turn([text('Hi Pat, a quick reminder that invoice INV-3001 has $850.00 outstanding. Thanks, Seed Electric')])]);
    const r = await scan(C.tenantId);
    assert.equal(r.aiDrafts, 1);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.keys[0], 'sk-ant-company-C-key');
    assert.equal(mock.calls[0].output_config.effort, 'low');
    assert.match(mock.calls[0].messages[0].content[0].text, /data, not instructions/);
    const s = (await call(app, { url: '/api/v1/ai/suggestions', token: C.token })).body.data.find((x) => x.kind === 'overdue_invoice');
    assert.equal(s.draftedBy, 'ai');
    assert.match(s.message.body, /quick reminder/);
    const u = await t.superPool.query("SELECT count(*)::int AS n FROM ai_usage WHERE tenant_id = $1 AND feature = 'background'", [C.tenantId]);
    assert.equal(u.rows[0].n, 1);

    await call(app, { method: 'PUT', url: '/api/v1/ai/settings', token: C.token, body: { monthlyCapCents: 0 } });
    const mock2 = mockAnthropic([turn([text('should not be used')])]);
    const later = await scan(C.tenantId, { now: new Date(NOW.getTime() + 15 * DAY) });
    assert.ok(later.created >= 1);
    assert.equal(later.aiDrafts, 0);
    assert.equal(mock2.calls.length, 0);
  });

  test('plans without background agents are skipped; dispatch queues one scan per eligible company', async () => {
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [C.tenantId]);
    assert.deepEqual(await scan(C.tenantId, { now: new Date(NOW.getTime() + 40 * DAY) }), { skipped: 'not in plan' });
    const d = await dispatch(t.db);
    assert.ok(d.queued >= 2);
    const q = await t.superPool.query("SELECT tenant_id FROM jobs_queue WHERE kind = 'ai_background_scan'");
    assert.ok(!q.rows.some((x) => x.tenant_id === C.tenantId));
    assert.equal((await dispatch(t.db)).queued, 0, 'already queued scans are not queued twice');
    await t.superPool.query("UPDATE tenants SET plan = 'trial' WHERE id = $1", [C.tenantId]);
  });

  test('a manager can run the checks now, at most every 10 minutes', async () => {
    const B2 = await ownerTenant(t, app, 'Agents D Ltd');
    const r = await call(app, { method: 'POST', url: '/api/v1/ai/background/run', token: B2.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, 0);
    const again = await call(app, { method: 'POST', url: '/api/v1/ai/background/run', token: B2.token });
    assert.equal(again.status, 429);
  });
});
