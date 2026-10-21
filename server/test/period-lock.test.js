// The period lock (docs/releases/r1-get-paid.md 2.6, 8.1; docs/office/period-lock.md): late
// arrivals are accepted and posted on the first open day (REST, sync and the QuickBooks system
// actor); locked records refuse edits and deletes except their safe fields; drafts are never locked;
// change orders approved in a closed period are frozen; the closing routes check roles, two-step
// sign-in and reasons; the pre-close checklist counts what is open; a lock move waits for writes in
// flight; refused writes are listed; devices cannot write settings.closing or postedOn.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { setLock, loadLocks } from '../src/services/period-lock.js';
import { systemPrincipal, systemWho } from '../src/integrations/state.js';
import closingRoutes from '../src/routes/v1/closing.js';
import rulesRoutes from '../src/routes/v1/rules.js';
import { addDay, dayIn, endOfLastMonth } from '../../electrical-app/js/lib/closing.js';

/** The app with the Release 1 routes (the Lead adds them to app.js; registered here until then). */
async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/closing' })) await app.register(closingRoutes, { db: t.db, records, config });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/rules/effective' })) await app.register(rulesRoutes, { db: t.db, records, config });
  await app.ready();
  return { app, config, records };
}

const ZONE = 'America/Winnipeg';
const today = dayIn(new Date().toISOString(), ZONE);
const THROUGH = endOfLastMonth(today);
const INSIDE = addDay(THROUGH, -5);
const AFTER = addDay(THROUGH, 1);
let t, app, records, A, office, foreman, sam;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const pushOne = async (token, m) => (await push(token, [mut(m)])).body.results[0];
const get = async (token, coll, id) => (await call(app, { url: `/api/v1/${coll}/${id}`, token })).body;
const post = (token, coll, body) => call(app, { method: 'POST', url: `/api/v1/${coll}`, token, body });
const patch = (token, coll, id, body) => call(app, { method: 'PATCH', url: `/api/v1/${coll}/${id}`, token, body });
const closeBooks = (token, through, reason) => call(app, { method: 'PUT', url: '/api/v1/closing/books', token, body: { through, ...(reason ? { reason } : {}) } });
const iso = (day, h = 15) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
const qbo = (tenantId) => { const p = systemPrincipal(tenantId, 'qbo', 'QuickBooks sync'); return { p, who: systemWho(p) }; };

before(async () => {
  if (skip) return;
  t = await createTestDatabase('periodlock');
  ({ app, records } = await startR1App(t));
  A = await ownerTenant(t, app, 'Lockwood Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-fore', 'Fred Foreman', 'foreman'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await post(A.token, 'employees', { id, name, role })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  const r = await push(A.token, [
    mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Lockwood Electric', province: 'MB' } } }),
    mut({ collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1', title: 'Clinic', status: 'in-progress', changeOrders: [{ id: 'co-sep', title: 'Extra pots', amountCents: 50000, status: 'approved', approvedOn: INSIDE }] } }),
    mut({ collection: 'invoices', id: 'inv-sent', op: 'upsert', data: { number: 'INV-1', status: 'sent', issueDate: INSIDE, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'GST', pct: 5 }, { id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 1, unitCents: 10000 }] } }),
    mut({ collection: 'invoices', id: 'inv-nonum', op: 'upsert', data: { number: null, status: 'sent', issueDate: INSIDE, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 1, unitCents: 100 }] } }),
    mut({ collection: 'invoices', id: 'inv-draft', op: 'upsert', data: { number: 'INV-3', status: 'draft', issueDate: INSIDE, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 1, unitCents: 100 }] } }),
    mut({ collection: 'payments', id: 'pay-sep', op: 'upsert', data: { invoiceId: 'inv-sent', amountCents: 5000, date: INSIDE, method: 'cheque' } }),
    mut({ collection: 'bills', id: 'bill-sep', op: 'upsert', data: { number: 'B-1', date: INSIDE, status: 'open', lines: [{ description: 'Wire', qty: 1, unitCents: 1000, amountCents: 1000 }] } }),
    mut({ collection: 'timeEntries', id: 'te-sep', op: 'upsert', data: { employeeId: 'emp-sam', jobId: 'job-1', clockIn: iso(INSIDE, 13), clockOut: iso(INSIDE, 21), breakMins: 0, approved: true } }),
    mut({ collection: 'payments', id: 'pay-del', op: 'upsert', data: { invoiceId: 'inv-sent', amountCents: 700, date: INSIDE, method: 'cheque' } }),
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
  // Deleted before the close; QuickBooks puts it back after (a restore).
  const d = await call(app, { method: 'DELETE', url: '/api/v1/payments/pay-del', token: A.token });
  assert.ok(d.status < 300, JSON.stringify(d.body));
  const c = await closeBooks(A.token, THROUGH, 'Month-end close for the test period');
  assert.equal(c.status, 200, JSON.stringify(c.body));
});
after(async () => { await app?.close(); await t?.close(); });

describe('late arrivals are posted, never refused', { skip }, () => {
  test('sync: a phone syncing hours from the closed period on a later day: accepted, posted on the first open day', async () => {
    const r = await pushOne(sam.token, { collection: 'timeEntries', id: 'te-late', op: 'upsert', data: { employeeId: 'emp-sam', jobId: 'job-1', clockIn: iso(THROUGH, 14), clockOut: iso(THROUGH, 22), breakMins: 0, approved: false } });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    const e = await get(A.token, 'timeEntries', 'te-late');
    assert.equal(e.postedOn, AFTER);
    assert.equal(e.late, true);
    assert.equal(e.clockIn, iso(THROUGH, 14), 'the document date stays as typed');
  });

  test('REST: a bill dated in the closed period keyed today; an open-period bill is not late', async () => {
    const b = await post(A.token, 'bills', { id: 'bill-late', number: 'B-9', date: INSIDE, status: 'open', lines: [] });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.postedOn, AFTER);
    assert.equal(b.body.late, true);
    const ok = await post(A.token, 'bills', { id: 'bill-now', number: 'B-10', date: today, status: 'open', lines: [] });
    assert.equal(ok.body.postedOn, today);
    assert.equal(ok.body.late, false);
  });

  test('the QuickBooks pull: a payment dated in the closed period is created late', async () => {
    const { p, who } = qbo(A.tenantId);
    const rec = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.createRecord(tx, p, 'payments', { id: 'pay-qbo', invoiceId: 'inv-sent', amountCents: 100, date: INSIDE, method: 'cheque' }, who));
    assert.equal(rec.postedOn, AFTER);
    assert.equal(rec.late, true);
    const n = await t.superPool.query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND kind = 'late_posting'", [A.tenantId]);
    assert.ok(n.rows[0].n >= 1, 'the office was told (once a day)');
  });

  test('devices cannot write postedOn, late or settings.closing', async () => {
    const r = await pushOne(A.token, { collection: 'payments', id: 'pay-forged', op: 'upsert', data: { invoiceId: 'inv-sent', amountCents: 1, date: INSIDE, method: 'cash', postedOn: INSIDE, late: false } });
    assert.equal(r.status, 'ok');
    const pay = await get(A.token, 'payments', 'pay-forged');
    assert.equal(pay.postedOn, AFTER);
    assert.equal(pay.late, true);
    const p2 = await patch(A.token, 'bills', 'bill-now', { postedOn: '2001-01-01', late: true });
    assert.equal(p2.status, 200);
    assert.equal(p2.body.postedOn, today, 'postedOn never changes after create');
    assert.equal(p2.body.late, false);
    const s = await pushOne(A.token, { collection: 'settings', id: 'settings', op: 'upsert', baseVersion: null, data: { company: { name: 'Lockwood Electric', province: 'MB' }, closing: { booksThrough: '2000-01-01' } } });
    assert.ok(['ok', 'conflict'].includes(s.status));
    const set = await get(A.token, 'settings', 'settings');
    assert.equal(set.closing.booksThrough, THROUGH);
  });
});

describe('locked records', { skip }, () => {
  test('edits and deletes are refused; safe fields and allowed status moves go through', async () => {
    let r = await patch(A.token, 'payments', 'pay-sep', { amountCents: 4000 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'period_locked');
    assert.match(r.body.error.message, new RegExp(`closed period \\(through ${THROUGH}\\)`));
    r = await call(app, { method: 'DELETE', url: '/api/v1/payments/pay-sep', token: A.token });
    assert.equal(r.body.error.code, 'period_locked');
    r = await patch(A.token, 'payments', 'pay-sep', { stripe: { feeCents: 30 } });
    assert.equal(r.status, 200, 'the Stripe fee still lands');
    r = await patch(A.token, 'invoices', 'inv-sent', { lines: [] });
    assert.equal(r.body.error.code, 'period_locked');
    r = await patch(A.token, 'invoices', 'inv-sent', { status: 'paid', sentAt: new Date().toISOString() });
    assert.equal(r.status, 200, 'a payment today still marks a September invoice paid');
    r = await patch(A.token, 'invoices', 'inv-sent', { status: 'void' });
    assert.equal(r.body.error.code, 'period_locked');
    r = await patch(A.token, 'bills', 'bill-sep', { status: 'paid' });
    assert.equal(r.status, 200);
    r = await patch(A.token, 'timeEntries', 'te-sep', { breakMins: 30 });
    assert.equal(r.body.error.code, 'period_locked');
  });

  test('a stale offline edit syncs and is rejected, and Books lists it', async () => {
    const r = await pushOne(office.token, { collection: 'invoices', id: 'inv-sent', op: 'upsert', baseVersion: 2, data: { number: 'INV-1', status: 'paid', issueDate: INSIDE, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'GST', pct: 5 }, { id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 2, unitCents: 10000 }], updatedAt: new Date().toISOString() } });
    assert.equal(r.status, 'rejected');
    assert.equal(r.error.code, 'period_locked');
    const list = await call(app, { url: '/api/v1/closing/rejections', token: office.token });
    assert.equal(list.status, 200);
    const row = list.body.data.find((x) => x.recordId === 'inv-sent' && x.code === 'period_locked');
    assert.ok(row, JSON.stringify(list.body));
    assert.equal(JSON.stringify(list.body).includes('10000'), false, 'never the data');
    const st = await call(app, { url: '/api/v1/closing', token: office.token });
    assert.ok(st.body.rejections.open >= 1);
    const res = await call(app, { method: 'POST', url: `/api/v1/closing/rejections/${row.id}/resolve`, token: office.token });
    assert.equal(res.status, 200);
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/closing/rejections/${row.id}/resolve`, token: office.token })).status, 404);
    assert.equal((await call(app, { url: '/api/v1/closing/rejections', token: foreman.token })).status, 403);
  });

  test('REST refusals are recorded too (in their own transaction)', async () => {
    const before = (await t.superPool.query("SELECT count(*)::int AS n FROM sync_rejections WHERE tenant_id = $1 AND record_id = 'bill-sep' AND code = 'period_locked'", [A.tenantId])).rows[0].n;
    const p = systemPrincipal(A.tenantId, 'tester', 'Test');
    await assert.rejects(t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.patchRecord(tx, p, 'bills', 'bill-sep', { number: 'B-1x' }, null, systemWho(p))), /closed period/);
    const n = (await t.superPool.query("SELECT count(*)::int AS n FROM sync_rejections WHERE tenant_id = $1 AND record_id = 'bill-sep' AND code = 'period_locked'", [A.tenantId])).rows[0].n;
    assert.equal(n, before + 1);
  });

  test('drafts: edit and re-date freely; sending while dated in the closed period is refused', async () => {
    let r = await patch(A.token, 'invoices', 'inv-draft', { notes: 'still a draft' });
    assert.equal(r.status, 200);
    r = await patch(A.token, 'invoices', 'inv-draft', { status: 'sent' });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /Re-date this invoice to today/);
    r = await patch(A.token, 'invoices', 'inv-draft', { status: 'sent', issueDate: today });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = await post(A.token, 'invoices', { id: 'inv-sent-new', status: 'sent', issueDate: INSIDE, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 1, unitCents: 1 }] });
    assert.equal(c.body.error.code, 'period_locked', 'a device never creates a sent invoice in a closed period');
  });

  test('number is safe only for the QuickBooks push; its history import may predate its own close', async () => {
    let r = await patch(A.token, 'invoices', 'inv-nonum', { number: 'INV-77' });
    assert.equal(r.body.error.code, 'period_locked');
    const { p, who } = qbo(A.tenantId);
    const out = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.patchRecord(tx, p, 'invoices', 'inv-nonum', { number: 'INV-77' }, null, who));
    assert.equal(out.number, 'INV-77');
    // QuickBooks' own close date: a pulled sent invoice on or before it is history, allowed.
    await t.superPool.query(
      `INSERT INTO qbo_connections (tenant_id, environment, realm_hash, state, features) VALUES ($1, 'sandbox', decode(repeat('ab', 32), 'hex'), 'active', $2)`,
      [A.tenantId, { bookCloseDate: THROUGH }]);
    try {
      const doc = { status: 'sent', issueDate: INSIDE, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 1, unitCents: 1 }] };
      const ok = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.createRecord(tx, p, 'invoices', { id: 'inv-hist', ...doc }, who));
      assert.equal(ok.status, 'sent');
      await t.superPool.query("UPDATE qbo_connections SET features = $2 WHERE tenant_id = $1", [A.tenantId, { bookCloseDate: addDay(INSIDE, -1) }]);
      await assert.rejects(t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.createRecord(tx, p, 'invoices', { id: 'inv-hist2', ...doc }, who)), /closed period/);
    } finally {
      await t.superPool.query('DELETE FROM qbo_connections WHERE tenant_id = $1', [A.tenantId]);
    }
  });

  test('change orders approved in the closed period are frozen; a new one corrects them', async () => {
    const job = await get(A.token, 'jobs', 'job-1');
    let r = await patch(A.token, 'jobs', 'job-1', { changeOrders: [{ ...job.changeOrders[0], amountCents: 40000 }] });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /new change order with a negative amount/);
    r = await patch(A.token, 'jobs', 'job-1', { changeOrders: [] });
    assert.equal(r.body.error.code, 'period_locked');
    r = await patch(A.token, 'jobs', 'job-1', { title: 'Clinic (renamed)', changeOrders: [...job.changeOrders, { id: 'co-fix', title: 'Credit on extra pots', amountCents: -10000, status: 'approved', approvedOn: today }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe('nothing moves into a closed period', { skip }, () => {
  test('a sent invoice cannot be re-dated into the closed period', async () => {
    const c = await post(A.token, 'invoices', { id: 'inv-oct', number: 'INV-3050', status: 'sent', issueDate: today, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'RST', pct: 7 }], lines: [{ kind: 'labour', qty: 1, unitCents: 100 }] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await patch(A.token, 'invoices', 'inv-oct', { issueDate: INSIDE });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'period_locked');
    assert.equal((await get(A.token, 'invoices', 'inv-oct')).issueDate, today);
  });

  test('a change order cannot be approved or back-dated into the closed period', async () => {
    assert.equal((await post(A.token, 'jobs', { id: 'job-2', number: 'J-2', title: 'Shop', status: 'in-progress', changeOrders: [] })).status, 201);
    let r = await patch(A.token, 'jobs', 'job-2', { changeOrders: [{ id: 'co-back', title: 'Back-dated', amountCents: 1000, status: 'approved', approvedOn: INSIDE }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'period_locked');
    r = await patch(A.token, 'jobs', 'job-2', { changeOrders: [{ id: 'co-now', title: 'Today', amountCents: 1000, status: 'approved', approvedOn: today }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await patch(A.token, 'jobs', 'job-2', { changeOrders: [{ id: 'co-now', title: 'Today', amountCents: 1000, status: 'approved', approvedOn: INSIDE }] });
    assert.equal(r.body.error.code, 'period_locked', 'approval day moved back');
  });

  test('a record deleted before the close and restored after comes back posted late, not in the closed month', async () => {
    const { p, who } = qbo(A.tenantId);
    const rec = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.restoreRecord(tx, p, 'payments', 'pay-del', who));
    assert.equal(rec.date, INSIDE, 'the document date stays');
    assert.equal(rec.postedOn, AFTER);
    assert.equal(rec.late, true);
  });
});

describe('the closing routes', { skip }, () => {
  test('who may read and move the lock', async () => {
    assert.equal((await call(app, { url: '/api/v1/closing', token: office.token })).status, 200);
    assert.equal((await call(app, { url: '/api/v1/closing', token: foreman.token })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/closing', token: sam.token })).status, 403);
    assert.equal((await closeBooks(office.token, THROUGH)).status, 403, 'office cannot close');
    assert.equal((await closeBooks(sam.token, THROUGH)).status, 403);
    assert.equal((await call(app, { url: `/api/v1/closing/preflight?through=${THROUGH}`, token: office.token })).status, 403);
    const st = await call(app, { url: '/api/v1/closing', token: A.token });
    assert.equal(st.body.books.through, THROUGH);
    assert.ok(st.body.history.length >= 1);
    assert.ok(st.body.latePostings.count >= 2);
    assert.equal(st.body.quickbooks.connected, false);
  });

  test('reasons: moving back or clearing needs one; a future date is refused', async () => {
    let r = await closeBooks(A.token, addDay(THROUGH, -10));
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'reason_required');
    r = await closeBooks(A.token, today, 'closing today is not allowed at all');
    assert.equal(r.body.error.code, 'lock_in_future');
    r = await closeBooks(A.token, null);
    assert.equal(r.body.error.code, 'reason_required');
    r = await closeBooks(A.token, addDay(THROUGH, -10), 'Accountant found a September bill');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.books.previous, THROUGH);
    const s = await get(A.token, 'settings', 'settings');
    assert.equal(s.closing.booksThrough, addDay(THROUGH, -10), 'the mirror follows');
    r = await closeBooks(A.token, THROUGH, 'Back to month end after the fix');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('the pre-close checklist counts what is still open (no money), and closing over it needs a reason', async () => {
    const day = addDay(THROUGH, 3);
    assert.ok(day < today || true);
    const r = await push(A.token, [
      mut({ collection: 'invoices', id: 'pf-draft', op: 'upsert', data: { status: 'draft', issueDate: AFTER, lines: [{ qty: 1, unitCents: 777 }] } }),
      mut({ collection: 'timeEntries', id: 'pf-open', op: 'upsert', data: { employeeId: 'emp-sam', clockIn: iso(AFTER, 14), clockOut: null } }),
      mut({ collection: 'bills', id: 'pf-bill', op: 'upsert', data: { status: 'draft', date: AFTER, lines: [] } }),
      mut({ collection: 'stockCounts', id: 'pf-count', op: 'upsert', data: { locationId: 'loc-x', date: AFTER, status: 'counted', lines: [] } }),
      mut({ collection: 'invoices', id: 'pf-disp', op: 'upsert', data: { status: 'draft', issueDate: today, disputes: [{ id: 'd1', cents: 120000, reason: 'short pay', status: 'open' }] } }),
    ]);
    for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
    if (AFTER >= today) return; // the first open day is today: nothing to close yet
    const pf = await call(app, { url: `/api/v1/closing/preflight?through=${AFTER}`, token: A.token });
    assert.equal(pf.status, 200);
    assert.equal(pf.body.counts.draftInvoices, 1);
    assert.equal(pf.body.counts.timeOpen >= 1, true);
    assert.equal(pf.body.counts.draftBills, 1);
    assert.equal(pf.body.counts.countsNotPosted, 1);
    assert.equal(pf.body.counts.openDisputes, 1);
    assert.equal(JSON.stringify(pf.body).includes('777'), false);
    assert.equal(JSON.stringify(pf.body).includes('120000'), false);
    const no = await closeBooks(A.token, AFTER);
    assert.equal(no.status, 409);
    assert.equal(no.body.error.code, 'preflight_open');
  });
});

describe('concurrency', { skip }, () => {
  test('a lock move waits for a write in flight (advisory lock)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let writeDone = false;
    const p = systemPrincipal(A.tenantId, 'tester', 'Test');
    const writer = t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      await records.createRecord(tx, p, 'payments', { id: 'pay-race', invoiceId: 'inv-sent', amountCents: 1, date: today, method: 'cash' }, systemWho(p));
      await gate;
      writeDone = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    let moved = false;
    const mover = t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      await setLock(tx, { kind: 'payroll', through: addDay(today, -1), actor: { type: 'system', id: 'tester' } });
      moved = true;
      assert.equal(writeDone, true, 'the write committed first');
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(moved, false, 'the lock move waits');
    release();
    await writer;
    await mover;
    assert.equal(moved, true);
    const locks = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => loadLocks(tx));
    assert.equal(locks.payrollThrough, addDay(today, -1));
  });
});
