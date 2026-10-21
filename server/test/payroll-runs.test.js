// Payroll runs (docs/releases/r1-get-paid.md 2.6, 8.2): POST /api/v1/closing/payroll-runs checks
// every entry (exists, approved, closed, in the period; late entries before it), refuses entries
// already exported, lists entries the run leaves out unless the office acknowledges them, locks the
// run's entries by id (never by date), moves payrollThrough, and takes late hours and corrections in
// the next run; reopening (owner or admin) unlocks them.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import closingRoutes from '../src/routes/v1/closing.js';
import { addDay, dayIn } from '../../electrical-app/js/lib/closing.js';

async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/closing' })) await app.register(closingRoutes, { db: t.db, records, config });
  await app.ready();
  return { app };
}

const ZONE = 'America/Winnipeg';
const today = dayIn(new Date().toISOString(), ZONE);
const FROM = addDay(today, -20);
const TO = addDay(today, -14);
const NEXT_FROM = addDay(TO, 1);
const NEXT_TO = addDay(today, -7);
let t, app, A, office, foreman, sam;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const at = (day, h) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
const entry = (id, day, o = {}) => ({ collection: 'timeEntries', id, op: 'upsert', data: { employeeId: 'emp-sam', jobId: 'job-1', clockIn: at(day, 14), clockOut: at(day, 22), breakMins: 30, approved: true, ...o } });
const run = (token, body) => call(app, { method: 'POST', url: '/api/v1/closing/payroll-runs', token, body: { format: 'generic', from: FROM, to: TO, ...body } });
const patch = (token, id, body) => call(app, { method: 'PATCH', url: `/api/v1/timeEntries/${id}`, token, body });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('payrollruns');
  ({ app } = await startR1App(t));
  A = await ownerTenant(t, app, 'Payday Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-fore', 'Fred Foreman', 'foreman'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  const r = await push(A.token, [
    mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Payday Electric', province: 'MB' } } }),
    mut({ collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1', title: 'Clinic', status: 'in-progress' } }),
    mut(entry('te-1', FROM)), mut(entry('te-2', addDay(FROM, 1))), mut(entry('te-3', addDay(FROM, 2), { approved: false })),
    mut(entry('te-open', addDay(FROM, 3), { clockOut: null, approved: false })),
    mut(entry('te-old', addDay(FROM, -3))), mut(entry('te-next', NEXT_FROM)),
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('recording a run', { skip }, () => {
  test('only the employees permission records a run; devices never write runs', async () => {
    assert.equal((await run(foreman.token, { entryIds: ['te-1'] })).status, 403);
    assert.equal((await run(sam.token, { entryIds: ['te-1'] })).status, 403);
    const d = await push(A.token, [mut({ collection: 'payrollRuns', id: 'forged', op: 'upsert', data: { from: FROM, to: TO, entryIds: ['te-1'], status: 'exported' } })]);
    assert.equal(d.body.results[0].status, 'rejected');
  });

  test('validation: missing, unapproved, open and out-of-period entries are refused', async () => {
    const r = await run(office.token, { entryIds: ['te-1', 'te-3', 'te-open', 'te-next', 'nope'] });
    assert.equal(r.status, 422);
    const reasons = Object.fromEntries(r.body.error.details.entries.map((x) => [x.entryId, x.reason]));
    assert.equal(reasons['te-3'], 'unapproved');
    assert.equal(reasons['te-open'], 'open');
    assert.equal(reasons['te-next'], 'outside_period');
    assert.equal(reasons.nope, 'missing');
    const late = await run(office.token, { entryIds: ['te-1'], lateEntryIds: ['te-2'] });
    assert.equal(late.status, 422, 'a late entry must be from before the period');
  });

  test('locking leaves nothing out silently: it lists the entries first, then stores them when acknowledged', async () => {
    const r = await run(office.token, { entryIds: ['te-1', 'te-2'], lockThrough: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'unexported_entries');
    assert.deepEqual(r.body.error.details.entries.map((x) => [x.entryId, x.reason]).sort(), [['te-3', 'unapproved'], ['te-open', 'open']]);
    assert.match(r.body.error.message, /wait in Late hours/);
    const ok = await run(office.token, { id: 'run-1', entryIds: ['te-1', 'te-2'], lockThrough: true, leftOutAck: true, totals: { otMinutes: 0 } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.run.status, 'exported');
    assert.equal(ok.body.run.totals.minutes, 2 * 450);
    assert.equal(ok.body.run.leftOut.length, 2);
    assert.equal(ok.body.payrollThrough, TO);
    const st = await call(app, { url: '/api/v1/closing', token: office.token });
    assert.equal(st.body.payroll.through, TO);
    const s = await call(app, { url: '/api/v1/settings/settings', token: A.token });
    assert.equal(s.body.closing.payrollThrough, TO);
  });

  test('the run locks only its entries, by id; approval included; a foreman cannot edit them', async () => {
    let r = await patch(A.token, 'te-1', { breakMins: 15 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'payroll_locked');
    assert.match(r.body.error.message, /exported to payroll on \d{4}-\d{2}-\d{2}\. Add a correction instead\./);
    r = await patch(foreman.token, 'te-2', { approved: false });
    assert.equal(r.body.error.code, 'payroll_locked');
    // Same days, not in the run: still editable and approvable (late hours).
    r = await patch(foreman.token, 'te-3', { approved: true, approvedAt: new Date().toISOString() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await push(sam.token, [mut(entry('te-1', FROM, { breakMins: 0 }))]);
    assert.equal(p.body.results[0].status, 'rejected');
  });

  test('an entry already exported is refused in another run', async () => {
    const r = await run(office.token, { entryIds: ['te-1'] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'already_exported');
  });

  test('the next run takes late hours and a correction as prior-period entries', async () => {
    const c = await push(A.token, [mut({ collection: 'timeEntries', id: 'corr-1', op: 'upsert', data: { kind: 'correction', correctsId: 'te-1', workDay: FROM, adjustMinutes: 60, employeeId: 'emp-sam', jobId: 'job-1', approved: true, note: 'Missed hour' } })]);
    assert.equal(c.body.results[0].status, 'ok', JSON.stringify(c.body));
    const bad = await push(sam.token, [mut({ collection: 'timeEntries', id: 'corr-2', op: 'upsert', data: { kind: 'correction', correctsId: 'te-1', workDay: FROM, adjustMinutes: 60, employeeId: 'emp-sam' } })]);
    assert.equal(bad.body.results[0].status, 'rejected', 'only whoever approves time adds corrections');
    const r = await call(app, { method: 'POST', url: '/api/v1/closing/payroll-runs', token: office.token, body: {
      id: 'run-2', format: 'generic', from: NEXT_FROM, to: NEXT_TO, entryIds: ['te-next'], lateEntryIds: ['te-3', 'corr-1'], lockThrough: true,
    } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.run.lateEntryIds, ['te-3', 'corr-1']);
    assert.equal(r.body.run.totals.minutes, 450 + 450 + 60);
    assert.equal((await patch(A.token, 'te-3', { note: 'x' })).body.error.code, 'payroll_locked');
  });
});

describe('reopening a run', { skip }, () => {
  test('owners and admins only, with a reason; the entries unlock and payrollThrough moves back', async () => {
    const reopen = (token, id, reason) => call(app, { method: 'POST', url: `/api/v1/closing/payroll-runs/${id}/reopen`, token, body: { reason } });
    assert.equal((await reopen(office.token, 'run-2', 'Wrong hours for Sam')).status, 403);
    assert.equal((await reopen(A.token, 'run-2', 'short')).status, 400, 'a reason of at least 10 characters');
    const r = await reopen(A.token, 'run-2', 'Wrong hours for Sam on the 3rd');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.run.status, 'reopened');
    assert.equal(r.body.payrollThrough, addDay(NEXT_FROM, -1));
    assert.equal((await patch(A.token, 'te-next', { note: 'fixed' })).status, 200);
    assert.equal((await patch(A.token, 'te-1', { note: 'x' })).body.error.code, 'payroll_locked', 'run 1 is still exported');
    assert.equal((await reopen(A.token, 'run-2', 'Wrong hours for Sam on the 3rd')).status, 409);
    const n = await t.superPool.query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND kind = 'payroll_reopened'", [A.tenantId]);
    assert.ok(n.rows[0].n >= 2, 'owners, admins and office are told');
    const audit = await t.superPool.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'closing.%'", [A.tenantId]);
    const actions = audit.rows.map((x) => x.action);
    for (const a of ['closing.payroll_run', 'closing.payroll_reopen', 'closing.payroll']) assert.ok(actions.includes(a), a);
  });
});
