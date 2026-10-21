// The receivables jobs (docs/releases/r1-get-paid.md 4.5, 4.7, 4.8, 7.5, 7.6, 10.1): the daily run is
// idempotent (reminders once by outbox id, alarms and notices once by ref), the hold is patched as the
// system actor `receivables` and is visible to the crew without the credit limit, a payment and the
// recheck route lift it, the schedule queues 07:00 in the company's zone once per day, and the routes
// check the permission and the company.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import receivablesRoutes from '../src/routes/v1/receivables.js';
import { runReceivablesDaily, createReceivablesHandlers, scheduleReceivablesDaily, nextDailyRun, zonedInstant, ordinal } from '../src/services/receivables.js';
import { REMINDER_PRESETS } from '../../electrical-app/js/lib/receivables.js';
import { dayIn, addDay } from '../../electrical-app/js/lib/closing.js';

/** The app with the R1-D routes (the Lead adds them to app.js; registered here until then). */
async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'POST', url: '/api/v1/receivables/recheck/:clientId' })) await app.register(receivablesRoutes, { db: t.db, records, config });
  await app.ready();
  return { app, config, records };
}

const ZONE = 'America/Winnipeg';
const today = dayIn(new Date().toISOString(), ZONE);
let t, app, records, A, B, office, sam;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: mutations.map(mut) } });
const get = (token, coll, id) => call(app, { url: `/api/v1/${coll}/${id}`, token });
const q = async (sql, args) => (await t.superPool.query(sql, args)).rows;
const lines = (cents) => [{ kind: 'labour', description: 'Work', qty: 1, unitCents: cents }];
const notes = async (tenantId, kind) => (await q('SELECT ref FROM notifications WHERE tenant_id = $1 AND kind = $2', [tenantId, kind])).map((r) => r.ref);

before(async () => {
  if (skip) return;
  t = await createTestDatabase('receivables');
  ({ app, records } = await startR1App(t));
  A = await ownerTenant(t, app, 'Collections Electric');
  B = await ownerTenant(t, app, 'Other Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  const r = await call(app, { method: 'PUT', url: '/api/v1/integrations/resend', token: A.token, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'Collections Electric <office@collections.test>' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const late = addDay(today, -70);
  const res = await push(A.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Collections Electric', province: 'MB' }, collections: { reminders: REMINDER_PRESETS, holdAfterDays: 60, holdOverLimit: true, cutoffNoticeDays: 3 }, closeout: { remindAfterDays: 14 } } },
    { collection: 'clients', id: 'gc', op: 'upsert', data: { name: 'Prairie Builders', email: 'ap@prairie.test', credit: { limitCents: 900000000, statementEmail: 'statements@prairie.test' } } },
    { collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1042', title: 'Clinic', clientId: 'gc', status: 'complete', changeOrders: [],
      contract: { role: 'prime', signedOn: '2025-05-01', properInvoiceRequired: true, valueCents: 5000000, billingCutoffDay: Number(today.slice(8)), substantialPerformanceOn: addDay(today, -5), holdbackReleaseOn: addDay(today, -1), completedOn: addDay(today, -20) } } },
    { collection: 'invoices', id: 'inv-late', op: 'upsert', data: { number: 'INV-3010', clientId: 'gc', jobId: 'job-1', status: 'sent', issueDate: addDay(late, -30), dueDate: late, taxes: [], lines: lines(200000),
      properInvoice: true, promptPayment: { deliveredOn: addDay(today, -40) } } },
    { collection: 'invoices', id: 'inv-prog', op: 'upsert', data: { number: 'INV-3011', clientId: 'gc', jobId: 'job-1', status: 'sent', kind: 'progress', issueDate: addDay(today, -10), dueDate: addDay(today, 20), taxes: [], lines: lines(1000000), holdback: { pct: 10, deferTaxIds: [] }, promptPayment: { deliveredOn: addDay(today, -9) } } },
  ]);
  for (const x of res.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('the daily run', { skip }, () => {
  test('reminders once by id, alarms and notices once by ref, the hold patched as the system', async () => {
    const first = await runReceivablesDaily(t.db, A.tenantId, { records });
    assert.equal(first.reminders, 1, JSON.stringify(first));
    assert.equal(first.holds, 1);
    const second = await runReceivablesDaily(t.db, A.tenantId, { records });
    assert.equal(second.reminders, 0, 'a second run never doubles');
    assert.equal(second.holds, 0, 'the hold is written only when it changes');
    const ob = await q("SELECT id, data FROM outbox WHERE tenant_id = $1 AND data->>'kind' = 'invoice_reminder'", [A.tenantId]);
    assert.deepEqual(ob.map((r) => r.id), ['rem-inv-late-r4'], '70 days late: the 30-day step only');
    assert.equal(ob[0].data.to, 'statements@prairie.test');
    assert.match(ob[0].data.body, /\$2,000\.00/);
    const jobs = await q("SELECT count(*)::int AS n FROM jobs_queue WHERE kind = 'integrations_send' AND payload->>'outboxId' = 'rem-inv-late-r4'");
    assert.equal(jobs[0].n, 1, 'the send is queued');
    // Prompt payment: delivered 40 days ago on a prime contract: day 14 and day 28 for the late invoice.
    const pp = await notes(A.tenantId, 'prompt_payment');
    assert.ok(pp.includes('pp:inv-late:day14') && pp.includes('pp:inv-late:day28'), JSON.stringify(pp));
    assert.ok(!pp.some((r) => r.startsWith('pp:inv-prog')), 'nine days in: nothing yet');
    const owners = (await q("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role IN ('owner', 'admin', 'office') AND status = 'active'", [A.tenantId]))[0].n;
    assert.equal(pp.filter((r) => r === 'pp:inv-late:day28').length, owners, 'once per person');
    for (const [kind, ref] of [['gst_due', 'gst:job-1'], ['billing_cutoff', `cutoff:job-1:${today.slice(0, 7)}`], ['closeout_due', 'closeout:job-1'], ['holdback_due', 'holdback_due:job-1'], ['credit_hold', `credit_hold:gc:on:${today}`]]) {
      const refs = await notes(A.tenantId, kind);
      assert.equal(refs.filter((r) => r === ref).length, owners, `${kind} once per person`);
    }
    const cutoff = (await q("SELECT title FROM notifications WHERE tenant_id = $1 AND kind = 'billing_cutoff' LIMIT 1", [A.tenantId]))[0].title;
    assert.match(cutoff, new RegExp(`^J-1042: GC billing cutoff on the ${ordinal(Number(today.slice(8)))}; \\d+ items? ready to bill$`));
    for (const r of await q('SELECT title, body FROM notifications WHERE tenant_id = $1', [A.tenantId])) assert.doesNotMatch(`${r.title} ${r.body || ''}`, /\$\d/, 'no amounts in notifications');
    const row = (await q("SELECT data, updated_by FROM clients WHERE tenant_id = $1 AND id = 'gc'", [A.tenantId]))[0];
    assert.equal(row.data.credit.hold.on, true);
    assert.equal(row.data.credit.hold.reason, 'past_due');
    assert.equal(row.updated_by, 'system:receivables');
    assert.equal(row.data.credit.limitCents, 900000000, 'the rest of the credit card is kept');
  });

  test('the crew sees the hold flag, never the limit; nobody else can set the hold', async () => {
    const c = (await get(sam.token, 'clients', 'gc')).body;
    assert.equal(c.credit.hold.on, true);
    assert.equal(c.credit.limitCents, undefined);
    const forged = await call(app, { method: 'PATCH', url: '/api/v1/clients/gc', token: office.token, body: { credit: { limitCents: 900000000, hold: { on: false } } } });
    assert.equal(forged.status, 200);
    assert.equal((await get(A.token, 'clients', 'gc')).body.credit.hold.on, true, 'the hold is server-written');
  });

  test('a payment and the recheck route lift the hold', async () => {
    const r = await push(office.token, [{ collection: 'payments', id: 'pay-1', op: 'upsert', data: { invoiceId: 'inv-late', amountCents: 200000, date: today, method: 'cheque' } }]);
    assert.equal(r.body.results[0].status, 'ok');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/receivables/recheck/gc', token: sam.token })).status, 403, 'office only');
    const rc = await call(app, { method: 'POST', url: '/api/v1/receivables/recheck/gc', token: office.token });
    assert.equal(rc.status, 202);
    assert.equal(rc.body.queued, true);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/receivables/recheck/gc', token: office.token })).body.queued, false, 'one waits already');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/receivables/recheck/gc', token: B.token })).status, 404, 'another company');
    const job = (await q("SELECT * FROM jobs_queue WHERE kind = 'receivables_client' AND tenant_id = $1 AND status = 'queued'", [A.tenantId]))[0];
    const out = await createReceivablesHandlers({ records }).receivables_client({ db: t.db, job });
    assert.equal(out.changed, 1);
    assert.equal((await get(A.token, 'clients', 'gc')).body.credit.hold.on, false);
  });
});

describe('the schedule', { skip }, () => {
  test('07:00 in the company zone, once a day', async () => {
    const at = zonedInstant('2026-10-20', 7, 'America/Winnipeg');
    assert.equal(at.toISOString(), '2026-10-20T12:00:00.000Z', 'CDT is UTC-5');
    assert.equal(zonedInstant('2026-12-01', 7, 'America/Winnipeg').toISOString(), '2026-12-01T13:00:00.000Z', 'CST is UTC-6');
    assert.equal(nextDailyRun(new Date('2026-10-20T11:00:00Z'), 'America/Winnipeg').day, '2026-10-20');
    assert.equal(nextDailyRun(new Date('2026-10-20T12:00:01Z'), 'America/Winnipeg').day, '2026-10-21');
    await scheduleReceivablesDaily(t.db, new Date(), { tenantId: A.tenantId });
    await scheduleReceivablesDaily(t.db, new Date(), { tenantId: A.tenantId });
    const n = await q("SELECT count(*)::int AS n FROM jobs_queue WHERE kind = 'receivables_daily' AND tenant_id = $1", [A.tenantId]);
    assert.equal(n[0].n, 1);
  });
});
