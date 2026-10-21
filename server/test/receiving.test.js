// Field receiving without prices (docs/releases/r1-get-paid.md 6.6, 8.4): the crew list and receive open
// purchase-order lines without ever seeing a price; the server writes as system:receiving, so the moves
// carry the PO price, the location's stock goes up and the item's moving average moves; material for
// a job goes onto the job; drafts, missing lines and stock lines without an item are refused; another
// company can't touch the order; and a later issue move is stamped at the new average.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import receivingRoutes from '../src/routes/v1/receiving.js';

async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/receiving' })) await app.register(receivingRoutes, { db: t.db, records, config });
  await app.ready();
  return { app };
}

let t, app, A, B, office, sam, officeB;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: mutations.map(mut) } });
const get = (token, url) => call(app, { url, token });
const receive = (token, poId, body) => call(app, { method: 'POST', url: `/api/v1/receiving/${poId}`, token, body });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('receiving');
  ({ app } = await startR1App(t));
  A = await ownerTenant(t, app, 'Receiving Electric');
  B = await ownerTenant(t, app, 'Elsewhere Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  officeB = await addMember(t, app, B.tenantId, { role: 'office' });
  const r = await push(A.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Receiving Electric', province: 'MB' } } },
    { collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1', title: 'Clinic', status: 'in-progress' } },
    { collection: 'locations', id: 'shop', op: 'upsert', data: { name: 'Shop', kind: 'shop' } },
    { collection: 'items', id: 'i1', op: 'upsert', data: { name: 'Wire', costCents: 1000, priceCents: 2000, stock: {} } },
    { collection: 'vendors', id: 'v1', op: 'upsert', data: { name: 'Wholesaler' } },
    { collection: 'purchaseOrders', id: 'po-1', op: 'upsert', data: { number: 'PO-5001', vendorId: 'v1', status: 'sent', date: '2026-10-01', lines: [
      { itemId: 'i1', description: 'Wire', qty: 10, unit: 'm', unitCents: 1200 },
      { description: 'Light fixture', qty: 2, unit: 'ea', unitCents: 5000, jobId: 'job-1' },
    ] } },
    { collection: 'purchaseOrders', id: 'po-2', op: 'upsert', data: { number: 'PO-5002', vendorId: 'v1', status: 'open', date: '2026-10-02', lines: [{ itemId: 'i1', description: 'Wire', qty: 4, unit: 'm', unitCents: 1500 }] } },
    { collection: 'purchaseOrders', id: 'po-draft', op: 'upsert', data: { number: 'PO-5003', vendorId: 'v1', status: 'draft', lines: [{ itemId: 'i1', description: 'Wire', qty: 1, unitCents: 1 }] } },
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('field receiving', { skip }, () => {
  test('the crew list open lines with quantities and never a price', async () => {
    const r = await get(sam.token, '/api/v1/receiving');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.lines.map((l) => [l.poId, l.index, l.ordered, l.received]), [['po-1', 0, 10, 0], ['po-1', 1, 2, 0], ['po-2', 0, 4, 0]]);
    assert.equal(r.body.lines[0].supplier, 'Wholesaler');
    assert.ok(!JSON.stringify(r.body).includes('Cents'), 'no price anywhere');
    assert.deepEqual((await get(sam.token, '/api/v1/receiving?jobId=job-1')).body.lines.map((l) => l.index), [1]);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('receiving into stock: the move at the PO price, stock up, the moving average set; the crew sees none of it', async () => {
    const r = await receive(sam.token, 'po-1', { lines: [{ index: 0, qty: 4 }], toLocationId: 'shop' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('Cents'));
    assert.deepEqual(r.body.lines[0], { index: 0, description: 'Wire', ordered: 10, received: 4, over: false });
    const item = (await get(A.token, '/api/v1/items/i1')).body;
    assert.equal(item.stock.shop, 4);
    assert.equal(item.avgCostCents, 1200, 'nothing on hand before: the PO price');
    const move = (await get(A.token, `/api/v1/stockMoves/${r.body.moveIds[0]}`)).body;
    assert.deepEqual([move.use, move.poId, move.poLineIndex, move.unitCostCents, move.toLocationId], ['receive', 'po-1', 0, 1200, 'shop']);
    const crewView = (await get(sam.token, `/api/v1/stockMoves/${r.body.moveIds[0]}`)).body;
    assert.equal(crewView.unitCostCents, undefined, 'the move cost is stripped for the crew');
    assert.equal((await get(sam.token, '/api/v1/items/i1')).body.avgCostCents, undefined);
    const po = (await get(A.token, '/api/v1/purchaseOrders/po-1')).body;
    assert.equal(po.lines[0].receivedQty, 4);
    assert.ok(po.lines[0].receivedAt);
    const { rows } = await t.superPool.query("SELECT actor_type, action FROM audit_events WHERE tenant_id = $1 AND action = 'receiving.receive'", [A.tenantId]);
    assert.equal(rows.length, 1);
  });

  test('a second receipt at another price moves the average', async () => {
    const r = await receive(office.token, 'po-2', { lines: [{ index: 0, qty: 4 }], toLocationId: 'shop' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const item = (await get(A.token, '/api/v1/items/i1')).body;
    assert.equal(item.stock.shop, 8);
    assert.equal(item.avgCostCents, Math.round((4 * 1200 + 4 * 1500) / 8));
    // A later issue move by the office is stamped at the new average (write guards).
    const m = await push(office.token, [{ collection: 'stockMoves', id: 'issue-1', op: 'upsert', data: { itemId: 'i1', fromLocationId: 'shop', toLocationId: null, qty: 1, jobId: 'job-1', date: '2026-10-20', unitCostCents: 1 } }]);
    assert.equal(m.body.results[0].status, 'ok', JSON.stringify(m.body));
    assert.equal((await get(A.token, '/api/v1/stockMoves/issue-1')).body.unitCostCents, 1350, 'a device cannot set the cost');
  });

  test('a line for a job goes onto the job, not into stock', async () => {
    const r = await receive(sam.token, 'po-1', { lines: [{ index: 1, qty: 2 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const move = (await get(A.token, `/api/v1/stockMoves/${r.body.moveIds[0]}`)).body;
    assert.deepEqual([move.jobId, move.toLocationId, move.unitCostCents], ['job-1', null, 5000]);
    assert.equal((await get(A.token, '/api/v1/items/i1')).body.stock.shop, 8, 'stock unchanged by a job receipt');
  });

  test('refused: a draft order, a line that does not exist, a non-item line into stock, a line with nowhere to go', async () => {
    assert.equal((await receive(sam.token, 'po-draft', { lines: [{ index: 0, qty: 1 }], toLocationId: 'shop' })).body.error.code, 'po_not_open');
    assert.equal((await receive(sam.token, 'po-1', { lines: [{ index: 7, qty: 1 }], toLocationId: 'shop' })).body.error.code, 'no_line');
    assert.equal((await receive(sam.token, 'po-1', { lines: [{ index: 1, qty: 1 }], toLocationId: 'shop' })).body.error.code, 'no_item');
    assert.equal((await receive(sam.token, 'po-2', { lines: [{ index: 0, qty: 1 }] })).body.error.code, 'no_destination');
    assert.equal((await receive(sam.token, 'po-1', { lines: [{ index: 0, qty: 1 }], toLocationId: 'nowhere' })).body.error.code, 'no_location');
    assert.equal((await receive(sam.token, 'po-1', { lines: [{ index: 0, qty: 0 }], toLocationId: 'shop' })).status, 400, 'schema: quantity above zero');
    assert.equal((await get(A.token, '/api/v1/purchaseOrders/po-1')).body.lines[0].receivedQty, 4, 'a refused receipt changes nothing');
  });

  test('another company cannot see or receive the order', async () => {
    assert.deepEqual((await get(officeB.token, '/api/v1/receiving')).body.lines, []);
    const r = await receive(officeB.token, 'po-1', { lines: [{ index: 0, qty: 1 }], toLocationId: 'shop' });
    assert.equal(r.status, 404);
  });
});
