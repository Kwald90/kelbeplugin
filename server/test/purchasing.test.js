// Purchasing on the server (docs/integrations/quickbooks.md 3.5, 11.3 W5): suppliers, bills and
// receipts, purchase orders. Office roles create, read, change and delete them over REST and
// sync; foremen, field crews, crew PIN sessions and other companies get nothing (403 on REST,
// nothing in /sync/pull); the JSON Schemas and size limit hold; the Purchasing switch and the plan
// gate writes while reads stay open; and migration 0151 is the generator's output with RLS.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, apiKey, call, ownerTenant, startApp } from './support/app.js';
import { outputs, laterFile, LATER } from '../scripts/gen-collections-sql.js';
import { collectionDef } from '../src/collections.js';
import { COLLECTION_FEATURES } from '../src/services/entitlements.js';
import { nextModules } from '../../electrical-app/js/lib/modules.js';
import { FEATURE_PLAN } from '../../electrical-app/js/plans.js';

const PURCHASING = ['vendors', 'bills', 'purchaseOrders'];
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

let t, app, A, B, office, foreman, sam, keyA;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const pushOne = async (token, m) => (await push(token, [mut(m)])).body.results[0];
async function pullAll(token) {
  const out = [];
  let since = 0;
  for (let i = 0; i < 50; i++) {
    const r = await call(app, { url: `/api/v1/sync/pull?since=${since}&limit=1000`, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    out.push(...r.body.changes);
    since = r.body.cursor;
    if (!r.body.more) break;
  }
  return out;
}
const getSettings = async (token) => (await call(app, { url: '/api/v1/settings/settings', token })).body;
async function setModules(token, patch) {
  const cur = await getSettings(token);
  const r = await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token, body: { modules: nextModules(cur, patch) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const vendor = { name: 'Nedco Winnipeg', companyName: 'Nedco', email: 'orders@nedco.example', phone: '204-555-0140', accountNumber: 'TG-4410', terms: 'Net 30', t5018: false, active: true };
const billRec = (o = {}) => ({
  kind: 'bill', vendorId: 'v-nedco', number: 'INV-2231', date: '2026-10-20', dueDate: '2026-11-19', jobId: 'job-1', status: 'open',
  lines: [
    { description: 'Two-hole strap 3/4"', qty: 50, unitCents: 25, amountCents: 1250, itemId: null, jobId: null, costType: 'material' },
    { description: '3/4" EMT', qty: 20, unitCents: 1000, amountCents: 20000, costType: 'material', poLine: { purchaseOrderId: 'po-1', index: 0 } },
  ],
  taxes: [{ id: 'GST', label: 'GST', cents: 1063 }, { id: 'RST', label: 'RST', cents: 1488 }],
  taxProvince: 'MB', totalCents: 23801, notes: 'Back order on the straps', purchaseOrderId: 'po-1', materialRequestIds: ['mr-1'],
  receipt: { dataUrl: JPEG, name: 'nedco.jpg', takenAt: '2026-10-20T15:00:00.000Z' },
  ...o,
});
const poRec = (o = {}) => ({
  number: 'PO-5001', vendorId: 'v-nedco', jobId: 'job-1', date: '2026-10-19', expectedDate: '2026-10-22', status: 'open',
  lines: [{ itemId: null, description: '3/4" EMT', qty: 20, unit: 'sticks', unitCents: 1000, jobId: 'job-1', materialRequestIds: ['mr-1'] }],
  shipTo: '12 Elm St, Winnipeg', notes: 'Call on arrival', sentAt: null, closedAt: null, ...o,
});

before(async () => {
  if (skip) return;
  t = await createTestDatabase('purchasing');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Electric');
  B = await ownerTenant(t, app, 'Bravo Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-fore', 'Fran Foreman', 'foreman'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  keyA = await apiKey(app, A.token, ['*:write']);
  const r = await push(A.token, [
    mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Alpha Electric', province: 'MB' } } }),
    mut({ collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1001', title: 'Shop rewire', status: 'in-progress', address: '12 Elm St' } }),
    mut({ collection: 'materialRequests', id: 'mr-1', op: 'upsert', data: { jobId: 'job-1', description: '3/4" EMT', qty: 20, unit: 'sticks', status: 'sent', employeeId: 'emp-sam' } }),
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('the registry and migration 0151', () => {
  test('office-only collections in their own generated migration, gated by the purchasing feature', () => {
    for (const c of PURCHASING) {
      const d = collectionDef(c);
      assert.deepEqual([d.read, d.write, d.portal, d.migration], [['invoices'], ['invoices'], null, '0151'], c);
      assert.deepEqual(COLLECTION_FEATURES[c], ['purchasing'], c);
    }
    assert.equal(collectionDef('bills').maxBytes, 3 * 1024 * 1024);
    assert.deepEqual(collectionDef('bills').gen.map((g) => g.col), ['vendor_id', 'job_id', 'status', 'day', 'purchase_order_id']);
    assert.deepEqual(collectionDef('purchaseOrders').gen.map((g) => g.col), ['vendor_id', 'job_id', 'status', 'number']);
    assert.equal(collectionDef('purchaseOrders').table, 'purchase_orders');
    assert.equal(LATER['0151'], '0151_purchasing.sql');
  });

  test('the committed 0151_purchasing.sql is exactly the generator output', () => {
    const o = outputs().find((x) => x.name === '0151');
    assert.ok(o, 'outputs() includes 0151');
    assert.equal(readFileSync(laterFile('0151'), 'utf8').replace(/\r\n/g, '\n'), o.sql);
    for (const table of ['vendors', 'bills', 'purchase_orders']) {
      assert.match(o.sql, new RegExp(`CREATE TABLE ${table} \\(`));
      assert.match(o.sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
      assert.match(o.sql, new RegExp(`CREATE POLICY ${table}_tenant ON ${table}\\n {2}USING \\(tenant_id = app_tenant_id\\(\\) AND app_portal_client_id\\(\\) IS NULL\\)`), `${table}: no portal reads`);
    }
  });

  test('the tables exist with row-level security enabled and forced', { skip }, async () => {
    const { rows } = await t.superPool.query(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)",
      [['vendors', 'bills', 'purchase_orders']]);
    assert.equal(rows.length, 3);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
  });
});

describe('office roles keep the books', { skip }, () => {
  test('the office adds a supplier, a purchase order and a bill with its photo over REST', async () => {
    const v = await call(app, { method: 'POST', url: '/api/v1/vendors', token: office.token, body: { id: 'v-nedco', ...vendor } });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal(v.body.accountNumber, 'TG-4410');
    const po = await call(app, { method: 'POST', url: '/api/v1/purchaseOrders', token: office.token, body: { id: 'po-1', ...poRec() } });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    const b = await call(app, { method: 'POST', url: '/api/v1/bills', token: office.token, body: { id: 'bill-1', ...billRec() } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.receipt.dataUrl, JPEG);
    assert.equal(b.body.lines[1].poLine.purchaseOrderId, 'po-1');
    const stored = (await t.superPool.query("SELECT vendor_id, job_id, status, day, purchase_order_id FROM bills WHERE tenant_id = $1 AND id = 'bill-1'", [A.tenantId])).rows[0];
    assert.deepEqual({ ...stored }, { vendor_id: 'v-nedco', job_id: 'job-1', status: 'open', day: '2026-10-20', purchase_order_id: 'po-1' });
    const n = (await t.superPool.query("SELECT number FROM purchase_orders WHERE tenant_id = $1 AND id = 'po-1'", [A.tenantId])).rows[0].number;
    assert.equal(n, 'PO-5001');
  });

  test('a supplier refund is a receipt with negative amounts', async () => {
    const refund = { kind: 'receipt', vendorId: 'v-nedco', number: 'CR-77', date: '2026-10-21', status: 'paid', paidWith: 'card',
      lines: [{ description: 'Returned breakers', qty: 2, unitCents: -1500, amountCents: -3000, costType: 'material' }],
      taxes: [{ id: 'GST', label: 'GST', cents: -150 }, { id: 'RST', label: 'RST', cents: -210 }], totalCents: -3360, taxProvince: 'MB',
      receipt: { dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK', name: 'credit.pdf', takenAt: '2026-10-21T16:00:00.000Z' } };
    const r = await call(app, { method: 'POST', url: '/api/v1/bills', token: A.token, body: { id: 'bill-refund', ...refund } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.totalCents, -3360);
  });

  test('lists filter by supplier, job, status, date and purchase order', async () => {
    const q = async (qs) => (await call(app, { url: `/api/v1/bills?${qs}&limit=50`, token: office.token })).body.data.map((x) => x.id).sort();
    assert.deepEqual(await q('vendorId=v-nedco'), ['bill-1', 'bill-refund']);
    assert.deepEqual(await q('purchaseOrderId=po-1'), ['bill-1']);
    assert.deepEqual(await q('status=paid'), ['bill-refund']);
    assert.deepEqual(await q('jobId=job-1'), ['bill-1']);
    assert.deepEqual(await q('date=2026-10-21'), ['bill-refund']);
    const pos = await call(app, { url: '/api/v1/purchaseOrders?number=PO-5001', token: office.token });
    assert.deepEqual(pos.body.data.map((x) => x.id), ['po-1']);
    const list = await call(app, { url: '/api/v1/vendors', token: office.token });
    assert.equal(list.headers['cache-control'], 'no-store');
  });

  test('the office changes and deletes them; the PO and its material requests change in one push', async () => {
    const paid = await call(app, { method: 'PATCH', url: '/api/v1/bills/bill-1', token: office.token, body: { status: 'paid' } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'paid');
    const r = await push(office.token, [
      mut({ collection: 'purchaseOrders', id: 'po-2', op: 'upsert', data: poRec({ number: 'PO-5002', status: 'open', lines: [{ description: 'Rags', qty: 3, unit: 'bags', unitCents: 0, materialRequestIds: ['mr-1'] }] }) }),
      mut({ collection: 'materialRequests', id: 'mr-1', op: 'upsert', data: { jobId: 'job-1', description: '3/4" EMT', qty: 20, unit: 'sticks', status: 'ordered', orderedAt: new Date().toISOString(), employeeId: 'emp-sam' } }),
    ]);
    assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'ok'], JSON.stringify(r.body.results));
    const del = await call(app, { method: 'DELETE', url: '/api/v1/purchaseOrders/po-2', token: office.token });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.deleted, true);
    assert.equal((await call(app, { url: '/api/v1/purchaseOrders/po-2', token: office.token })).status, 404);
    // An API key a company admin scoped sees and writes them (it sees money, like the office).
    const k = await call(app, { method: 'PATCH', url: '/api/v1/vendors/v-nedco', token: keyA, body: { terms: 'Net 45' } });
    assert.equal(k.status, 200, JSON.stringify(k.body));
    assert.equal((await call(app, { url: '/api/v1/bills/bill-1', token: keyA })).body.totalCents, 23801);
  });

  test('the schemas hold: kinds, statuses, tax ids, receipt types, 200 lines, 3 MB', async () => {
    const bad = async (coll, body, code = 'validation_failed', status = 400) => {
      const r = await call(app, { method: 'POST', url: `/api/v1/${coll}`, token: office.token, body });
      assert.equal(r.status, status, `${coll} ${JSON.stringify(body).slice(0, 80)} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.error.code, code);
    };
    await bad('bills', billRec({ kind: 'invoice' }));
    await bad('bills', billRec({ status: 'overdue' }));
    await bad('bills', billRec({ paidWith: 'bitcoin' }));
    await bad('bills', billRec({ taxes: [{ id: 'VAT', label: 'VAT', cents: 1 }] }));
    await bad('bills', billRec({ lines: [{ description: 'x', qty: 1, unitCents: 1.5 }] }), 'validation_failed');
    await bad('bills', billRec({ receipt: { dataUrl: 'data:image/gif;base64,R0lGODlh', name: 'x.gif' } }));
    await bad('bills', billRec({ receipt: { dataUrl: 'https://example.com/receipt.jpg' } }));
    await bad('bills', billRec({ lines: Array.from({ length: 201 }, () => ({ description: 'x', qty: 1, unitCents: 1, amountCents: 1 })) }));
    await bad('purchaseOrders', poRec({ status: 'shipped' }));
    await bad('purchaseOrders', poRec({ lines: [{ description: 'x', qty: -1 }] }));
    await bad('vendors', { ...vendor, name: 'x'.repeat(101) });
    // Under the schema's caps but over the record limit: a near-2.5 MB photo plus 200 long lines.
    const big = billRec({ receipt: { dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(2_600_000), name: 'big.jpg' },
      lines: Array.from({ length: 200 }, () => ({ description: 'y'.repeat(3000), qty: 1, unitCents: 1, amountCents: 1 })) });
    await bad('bills', big, 'too_large', 413);
    // A photo at the cap on its own fits.
    const ok = await call(app, { method: 'POST', url: '/api/v1/bills', token: office.token, body: billRec({ id: 'bill-big-photo', receipt: { dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(2_600_000), name: 'big.jpg' } }) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 300));
  });
});

describe('field crews, foremen and other companies never see costs', { skip }, () => {
  test('foremen and electricians get 403 on every purchasing route, reads and writes', async () => {
    for (const who of [foreman, sam]) {
      for (const c of PURCHASING) {
        assert.equal((await call(app, { url: `/api/v1/${c}`, token: who.token })).status, 403, `${c} list`);
        assert.equal((await call(app, { url: `/api/v1/${c}/${c === 'vendors' ? 'v-nedco' : c === 'bills' ? 'bill-1' : 'po-1'}`, token: who.token })).status, 403, `${c} get`);
        assert.equal((await call(app, { method: 'POST', url: `/api/v1/${c}`, token: who.token, body: c === 'vendors' ? vendor : c === 'bills' ? billRec() : poRec() })).status, 403, `${c} create`);
      }
      assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/bills/bill-1', token: who.token, body: { totalCents: 1 } })).status, 403);
      assert.equal((await call(app, { method: 'DELETE', url: '/api/v1/vendors/v-nedco', token: who.token })).status, 403);
    }
  });

  test('their sync pull holds none of it, and their pushes are refused', async () => {
    for (const who of [foreman, sam]) {
      const changes = await pullAll(who.token);
      assert.ok(changes.length > 0, 'they do get their own collections');
      assert.deepEqual(changes.filter((c) => PURCHASING.includes(c.collection)), []);
      const text = JSON.stringify(changes);
      for (const s of ['Nedco', 'TG-4410', 'INV-2231', 'PO-5001', '23801', JPEG.slice(30)]) assert.ok(!text.includes(s), `${s} leaked to ${who === foreman ? 'foreman' : 'electrician'}`);
      const w = await pushOne(who.token, { collection: 'bills', id: 'bill-crew', op: 'upsert', data: billRec() });
      assert.equal(w.status, 'rejected');
      assert.equal(w.error.code, 'forbidden');
    }
    // The office's pull has them.
    const officePull = await pullAll(office.token);
    for (const c of PURCHASING) assert.ok(officePull.some((x) => x.collection === c), c);
  });

  test('an owner signing in with a crew PIN (capped at foreman) gets 403', async () => {
    const d = await call(app, { method: 'POST', url: '/api/v1/devices', token: A.token, body: { name: 'Shop iPad' } });
    assert.equal(d.status, 201);
    const ownerMembership = (await t.superPool.query('SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2', [A.userId, A.tenantId])).rows[0].id;
    assert.equal((await call(app, { method: 'PUT', url: `/api/v1/members/${ownerMembership}/pin`, token: A.token, body: { pin: '9137' } })).status, 204);
    const s = await call(app, { method: 'POST', url: '/api/v1/devices/crew/sign-in', headers: { 'x-fishtape-device': d.body.deviceToken }, body: { membershipId: ownerMembership, pin: '9137', mode: 'bearer' } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    for (const c of PURCHASING) assert.equal((await call(app, { url: `/api/v1/${c}`, token: s.body.token })).status, 403, c);
    assert.ok(!(await pullAll(s.body.token)).some((x) => PURCHASING.includes(x.collection)));
  });

  test('another company sees none of it', async () => {
    for (const [c, id] of [['vendors', 'v-nedco'], ['bills', 'bill-1'], ['purchaseOrders', 'po-1']]) {
      assert.equal((await call(app, { url: `/api/v1/${c}/${id}`, token: B.token })).status, 404, c);
      assert.deepEqual((await call(app, { url: `/api/v1/${c}?limit=50`, token: B.token })).body.data, [], c);
    }
    assert.ok(!(await pullAll(B.token)).some((x) => PURCHASING.includes(x.collection)));
    // B writing the same id makes B's own row; A's is untouched.
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/vendors', token: B.token, body: { id: 'v-nedco', name: 'Bravo supplier' } })).status, 201);
    assert.equal((await call(app, { url: '/api/v1/vendors/v-nedco', token: office.token })).body.name, 'Nedco Winnipeg');
  });
});

describe('the Purchasing switch and the plan', { skip }, () => {
  test('switch off: writes refused with module_turned_off (people, sync, API keys); reads still work', async () => {
    await setModules(A.token, { purchasing: false });
    const r = await call(app, { method: 'POST', url: '/api/v1/vendors', token: office.token, body: { name: 'Westburne' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'module_turned_off');
    assert.match(r.body.error.message, /^Purchasing is turned off/);
    const s = await pushOne(office.token, { collection: 'bills', id: 'bill-off', op: 'upsert', data: billRec() });
    assert.equal(s.error?.code, 'module_turned_off');
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/purchaseOrders/po-1', token: keyA, body: { status: 'closed' } })).body.error.code, 'module_turned_off');
    assert.equal((await call(app, { url: '/api/v1/bills/bill-1', token: office.token })).status, 200, 'reads stay open');
    assert.ok((await call(app, { url: '/api/v1/vendors', token: office.token })).body.data.length >= 1);
    await setModules(A.token, { purchasing: true });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/vendors', token: office.token, body: { id: 'v-west', name: 'Westburne' } })).status, 201);
  });

  test('purchasing taken out of the plan: writes refused with feature_not_in_plan, reads still work', async () => {
    await t.superPool.query(`UPDATE tenants SET plan_overrides = '{"purchasing": false}' WHERE id = $1`, [A.tenantId]);
    try {
      for (const c of PURCHASING) {
        const r = await call(app, { method: 'POST', url: `/api/v1/${c}`, token: office.token, body: c === 'vendors' ? { name: 'Anixter' } : c === 'bills' ? billRec() : poRec() });
        assert.equal(r.status, 403, c);
        assert.equal(r.body.error.code, 'feature_not_in_plan', c);
        assert.equal(r.body.error.details.feature, 'purchasing');
      }
      assert.equal((await call(app, { url: '/api/v1/purchaseOrders/po-1', token: office.token })).status, 200, 'a downgrade never hides the company’s own records');
      const me = await call(app, { url: '/api/v1/me', token: office.token });
      assert.ok(!me.body.entitlements.features.includes('purchasing') || !Object.hasOwn(FEATURE_PLAN, 'purchasing'));
    } finally {
      await t.superPool.query(`UPDATE tenants SET plan_overrides = '{}' WHERE id = $1`, [A.tenantId]);
    }
  });

  test('Starter has no purchasing; Pro does (plans.js, W1)', { skip: skip || (!Object.hasOwn(FEATURE_PLAN, 'purchasing') && 'waits for plans.js purchasing (W1)') }, async () => {
    try {
      await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [A.tenantId]);
      const r = await call(app, { method: 'POST', url: '/api/v1/bills', token: office.token, body: billRec() });
      assert.equal(r.body.error?.code, 'feature_not_in_plan');
      await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
      assert.equal((await call(app, { method: 'POST', url: '/api/v1/bills', token: office.token, body: billRec({ id: 'bill-pro' }) })).status, 201);
    } finally {
      await t.superPool.query("UPDATE tenants SET plan = 'trial' WHERE id = $1", [A.tenantId]);
    }
  });
});
