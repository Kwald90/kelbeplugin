// Job costing reports (docs/releases/r1-get-paid.md 6, 11): job profit, WIP, the RST worksheet and the
// break-even rates through /api/v1/reports, computed with the PWA's own libraries. Office money roles
// only (the invoices permission), WIP behind its plan feature, the module switch, CSV, no-store, and no
// company ever sees another's numbers.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import reportRoutes from '../src/routes/v1/reports.js';
import receivingRoutes from '../src/routes/v1/receiving.js';

/** The app with the R1-E routes (the Lead adds them to app.js; registered here until then). */
async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/reports/wip' })) await app.register(reportRoutes, { db: t.db, records, config });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/receiving' })) await app.register(receivingRoutes, { db: t.db, records, config });
  await app.ready();
  return { app };
}

let t, app, A, B, office, foreman, sam, officeB;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: mutations.map(mut) } });
const get = (token, url) => call(app, { url, token });
const mbTax = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }, { id: 'RST', label: 'RST', pct: 7, applies: { material: true, labour: true, other: true } }] };

before(async () => {
  if (skip) return;
  t = await createTestDatabase('reports');
  ({ app } = await startR1App(t));
  A = await ownerTenant(t, app, 'Costing Electric');
  B = await ownerTenant(t, app, 'Other Electric');
  for (const [id, name, role, extra] of [['emp-off', 'Olive Office', 'office'], ['emp-fore', 'Fred Foreman', 'foreman'], ['emp-sam', 'Sam Sparks', 'electrician', { rateCents: 4000, burden: { vacationPct: 0, holidayPct: 0 } }]]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role, ...extra } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  officeB = await addMember(t, app, B.tenantId, { role: 'office' });
  const r = await push(A.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Costing Electric', province: 'MB' }, labourRateCents: 9000, costing: { statutoryPctFallback: 10, annualHours: 2000, nonProductivePctDefault: 10, priceVariancePct: 2 } } },
    { collection: 'jobs', id: 'job-a', op: 'upsert', data: { number: 'J-1', title: 'Clinic', status: 'in-progress', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 80000 } } },
    { collection: 'jobs', id: 'job-w', op: 'upsert', data: { number: 'J-2', title: 'Warranty call', status: 'in-progress', kind: 'warranty', billable: false } },
    { collection: 'vendors', id: 'v1', op: 'upsert', data: { name: 'Wholesaler' } },
    { collection: 'items', id: 'i1', op: 'upsert', data: { name: 'Panel', costCents: 10000, priceCents: 20000, stock: { shop: 3 } } },
    { collection: 'locations', id: 'shop', op: 'upsert', data: { name: 'Shop', kind: 'shop' } },
    { collection: 'bills', id: 'bill-1', op: 'upsert', data: { kind: 'bill', vendorId: 'v1', status: 'open', date: '2026-09-10', jobId: 'job-a', lines: [{ description: 'Wire', costType: 'material', qty: 1, unitCents: 40000, amountCents: 40000 }], taxes: [{ id: 'GST', label: 'GST', cents: 2000 }, { id: 'RST', label: 'RST', cents: 2800 }], totalCents: 44800 } },
    { collection: 'invoices', id: 'inv-a', op: 'upsert', data: { number: 'INV-1', jobId: 'job-a', status: 'sent', issueDate: '2026-09-15', ...mbTax, lines: [{ kind: 'other', description: 'Progress', qty: 1, unitCents: 60000 }] } },
    { collection: 'stockMoves', id: 'mv-w', op: 'upsert', data: { itemId: 'i1', fromLocationId: 'shop', toLocationId: null, qty: 1, jobId: 'job-w', date: '2026-09-12' } },
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
  const rb = await push(B.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Other Electric', province: 'MB' } } },
    { collection: 'jobs', id: 'job-b', op: 'upsert', data: { number: 'J-9', title: 'Theirs', status: 'in-progress', contract: { valueCents: 5000 } } },
  ]);
  for (const x of rb.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('reports', { skip }, () => {
  test('job profit for the office: revenue gross of tax, resale RST not cost, margin and budget margin; never cached', async () => {
    const r = await get(office.token, '/api/v1/reports/job-profit?from=2026-09-01&to=2026-09-30');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const a = r.body.jobs.find((x) => x.jobId === 'job-a');
    assert.equal(a.revenueCents, 60000);
    assert.equal(a.costCents, 40000, 'the RST the wholesaler charged on resale material is recoverable, not cost');
    assert.equal(a.grossProfitCents, 20000);
    assert.equal(a.marginPct, 33.33);
    assert.equal(a.budgetMarginPct, 20);
    const w = r.body.jobs.find((x) => x.jobId === 'job-w');
    assert.equal(w.costCents, 10000 + 700, 'warranty material at the stamped cost plus self-assessed RST');
    const one = await get(office.token, '/api/v1/reports/job-profit?to=2026-09-30&jobId=job-a');
    assert.deepEqual(one.body.jobs.map((x) => x.jobId), ['job-a']);
  });

  test('field roles and the foreman never get numbers', async () => {
    for (const u of [sam, foreman]) {
      for (const url of ['/api/v1/reports/job-profit', '/api/v1/reports/wip', '/api/v1/reports/rst', '/api/v1/reports/break-even']) {
        const r = await get(u.token, url);
        assert.equal(r.status, 403, `${url} ${JSON.stringify(r.body)}`);
        assert.ok(!JSON.stringify(r.body).includes('Cents'));
      }
    }
  });

  test('CSV downloads', async () => {
    const r = await get(office.token, '/api/v1/reports/job-profit?to=2026-09-30&format=csv');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /job-profit-2026-09-30\.csv/);
    assert.match(r.raw.body, /^Job,Title,Revenue/);
    assert.match(r.raw.body, /J-1,Clinic,600\.00/);
    const w = await get(office.token, '/api/v1/reports/wip?asOf=2026-09-30&format=csv');
    assert.match(w.raw.body, /Completed this fiscal year/);
  });

  test('WIP: over billed on the fixed-price job; behind the reports.wip plan feature', async () => {
    const r = await get(office.token, '/api/v1/reports/wip?asOf=2026-09-30');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = r.body.rows.find((x) => x.jobId === 'job-a');
    assert.equal(a.pct, 0.5);
    assert.equal(a.earnedCents, 50000);
    assert.equal(a.overBilledCents, 10000);
    assert.equal(r.body.rows.find((x) => x.jobId === 'job-w'), undefined, 'warranty work is not WIP');
    await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [A.tenantId]);
    try {
      const gated = await get(office.token, '/api/v1/reports/wip?asOf=2026-09-30');
      assert.equal(gated.status, 403);
      assert.equal(gated.body.error.code, 'feature_not_in_plan');
      assert.equal((await get(office.token, '/api/v1/reports/job-profit?to=2026-09-30')).status, 200, 'job profit is in every plan');
    } finally {
      await t.superPool.query("UPDATE tenants SET plan = 'trial' WHERE id = $1", [A.tenantId]);
    }
  });

  test('the RST worksheet: own-use material to self-assess, the supplier credit to claim', async () => {
    const r = await get(office.token, '/api/v1/reports/rst?from=2026-09-01&to=2026-09-30');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.selfAssess.map((x) => [x.id, x.costCents, x.rstCents]), [['mv-w', 10000, 700]]);
    assert.deepEqual(r.body.resaleCredits.map((x) => [x.billId, x.rstCents]), [['bill-1', 2800]]);
    const csv = await get(office.token, '/api/v1/reports/rst?from=2026-09-01&to=2026-09-30&format=csv');
    assert.match(csv.raw.body, /Supplier credit to claim,2026-09-10,bill,,Wholesaler: Wire/);
    assert.equal((await get(office.token, '/api/v1/reports/rst?from=2026-09-30&to=2026-09-01')).status, 400);
  });

  test('break-even: field roles at their burdened cost, labour cost only without overhead', async () => {
    const r = await get(office.token, '/api/v1/reports/break-even');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rows.map((x) => x.employeeId), ['emp-sam']);
    assert.equal(r.body.burdenedCostPerProductiveHourCents, Math.round((4000 * 1.1) / 0.9));
    assert.equal(r.body.labourOnly, true);
    assert.equal(r.body.labourRateCents, 9000);
  });

  test('the module switch turns the reports off', async () => {
    const s = await push(A.token, [{ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Costing Electric', province: 'MB' }, labourRateCents: 9000, costing: { statutoryPctFallback: 10 }, modules: { reports: false } } }]);
    assert.equal(s.body.results[0].status, 'ok', JSON.stringify(s.body));
    try {
      const r = await get(office.token, '/api/v1/reports/job-profit');
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'module_turned_off');
    } finally {
      await push(A.token, [{ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Costing Electric', province: 'MB' }, labourRateCents: 9000, costing: { statutoryPctFallback: 10, annualHours: 2000, nonProductivePctDefault: 10 }, modules: { reports: true } } }]);
    }
  });

  test('another company sees only its own jobs', async () => {
    const r = await get(officeB.token, '/api/v1/reports/job-profit?to=2026-12-31');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.jobs.some((x) => x.jobId.startsWith('job-a') || x.jobId === 'job-w'));
    const one = await get(officeB.token, '/api/v1/reports/job-profit?jobId=job-a');
    assert.deepEqual(one.body.jobs, []);
    const w = await get(officeB.token, '/api/v1/reports/wip');
    assert.ok(w.body.rows.every((x) => x.jobId === 'job-b'));
    const rst = await get(officeB.token, '/api/v1/reports/rst?from=2026-09-01&to=2026-09-30');
    assert.deepEqual([rst.body.selfAssess.length, rst.body.resaleCredits.length], [0, 0]);
  });
});
