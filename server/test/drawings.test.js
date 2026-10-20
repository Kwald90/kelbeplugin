// Collaborative drawings on the server: the object-level merge of drawing writes, the cost
// impact route (prices for money roles only), price fields stripped for crew everywhere they
// read them (items, jobs' change orders, settings), crew writes that cannot wipe prices, and
// tenant isolation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';

let t, app, A, B, office, foreman, crew;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const pushOne = async (token, m) => (await push(token, [mut(m)])).body.results[0];
const at = (min) => new Date(Date.now() - (60 - min) * 60_000).toISOString();
const JACK = { id: 'emp-crew', name: 'Jackson Reid' };
const MONEY_KEYS = /"(priceCents|costCents|amountCents|unitCents|materialCents|labourCents|markupCents|totalCents|labourRateCents|markupPct|labourHours)"/;

async function pullAll(token) {
  const out = [];
  let since = '0';
  for (let i = 0; i < 50; i++) {
    const r = await call(app, { url: `/api/v1/sync/pull?since=${since}&limit=1000`, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    out.push(...r.body.changes);
    since = r.body.cursor;
    if (!r.body.more) break;
  }
  return out;
}
const rec = (id, x, by, min, symbol = 'receptacle') => ({ id, layer: 'L2', symbol, x, y: 0, rotation: 0, scale: 1, by, at: at(min) });
const drawingBody = (o = {}) => ({
  name: 'Smith reno · E1.0', jobId: 'job-1', paper: 'grid', scale: 24, layers: [{ id: 'L1', name: 'Plan' }, { id: 'L2', name: 'Power' }],
  strokes: [], objects: [], texts: [], rooms: [], tombstones: {}, history: [], updatedAt: at(1), ...o,
});

before(async () => {
  if (skip) return;
  t = await createTestDatabase('drawings');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Draw Co A');
  B = await ownerTenant(t, app, 'Draw Co B');
  for (const [id, name, role] of [['emp-office', 'Olive Office', 'office'], ['emp-fore', 'Fran Foreman', 'foreman'], ['emp-crew', 'Jackson Reid', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-office' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  crew = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-crew' });

  const seed = await push(A.token, [
    mut({ collection: 'items', id: 'i-rec', op: 'upsert', data: { sku: 'REC', name: 'Duplex receptacle', category: 'Devices', unit: 'ea', costCents: 245, priceCents: 1200, labourHours: 0.45, symbol: 'receptacle' } }),
    mut({ collection: 'items', id: 'i-jb', op: 'upsert', data: { sku: 'JB', name: 'Junction box', category: 'Boxes', unit: 'ea', costCents: 300, priceCents: 900, labourHours: 0.3, symbol: 'junction' } }),
    mut({ collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1001', title: 'Smith reno', status: 'in-progress', estimateId: 'est-1', crewIds: ['emp-crew'], changeOrders: [{ id: 'co-0', title: 'Extra pot lights', amountCents: 45000, status: 'approved', date: '2026-10-01' }] } }),
    mut({ collection: 'estimates', id: 'est-1', op: 'upsert', data: { number: 'E-2001', jobId: 'job-1', title: 'Smith reno', status: 'accepted', labourRateCents: 9500, markupPct: 10, taxPct: 5,
      lines: [{ itemId: 'i-rec', description: 'Duplex receptacle', qty: 2, unitCents: 1200, labourHours: 0.45, kind: 'material' }, { itemId: 'i-jb', description: 'Junction box', qty: 1, unitCents: 900, labourHours: 0.3, kind: 'material' }] } }),
    mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { labourRateCents: 9500, markupPct: 20, nextNumbers: { job: 1002, estimate: 2002, invoice: 3001 } } }),
    mut({ collection: 'drawings', id: 'dw-1', op: 'upsert', data: drawingBody({ objects: [rec('o1', 0, { id: 'emp-office', name: 'Olive Office' }, 1), rec('o2', 40, { id: 'emp-office', name: 'Olive Office' }, 1), rec('j1', 80, { id: 'emp-office', name: 'Olive Office' }, 1, 'junction')] }) }),
  ]);
  for (const x of seed.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('drawings merge object by object', { skip }, () => {
  test('two devices editing different objects both survive a stale push', async () => {
    const got = await call(app, { url: '/api/v1/drawings/dw-1', token: crew.token });
    assert.equal(got.status, 200);
    const base = got.body;
    // device 1 (crew): adds 4 receptacles; device 2 (office): deletes the junction box. Both from version `base.version`.
    const crewCopy = drawingBody({
      objects: [...base.objects, ...[1, 2, 3, 4].map((i) => rec(`n${i}`, 100 + i * 40, JACK, 30 + i))],
      history: [{ id: 'h-crew', by: JACK, at: at(31), until: at(34), add: { receptacle: 4 }, del: {}, move: {}, edit: {}, box: [100, -20, 280, 20], ids: ['n1', 'n2', 'n3', 'n4'], ch: [] }],
      updatedAt: at(34),
    });
    const officeCopy = drawingBody({
      objects: base.objects.filter((o) => o.id !== 'j1'), tombstones: { j1: { at: at(40), by: 'emp-office' } },
      history: [{ id: 'h-office', by: { id: 'emp-office', name: 'Olive Office' }, at: at(40), until: at(40), add: {}, del: { junction: 1 }, move: {}, edit: {}, box: [60, -20, 100, 20], ids: [], ch: [] }],
      updatedAt: at(40),
    });
    const r1 = await pushOne(office.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', baseVersion: base.version, data: officeCopy });
    assert.equal(r1.status, 'ok', JSON.stringify(r1));
    // the crew device was offline: its push is stale and older, but nothing of either is lost
    const r2 = await pushOne(crew.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', baseVersion: base.version, data: crewCopy });
    assert.equal(r2.status, 'conflict', 'the device gets the merged copy back');
    const ids = r2.server.data.objects.map((o) => o.id).sort();
    assert.deepEqual(ids, ['n1', 'n2', 'n3', 'n4', 'o1', 'o2']);
    assert.ok(r2.server.data.tombstones.j1);
    assert.deepEqual(r2.server.data.history.map((h) => h.id), ['h-crew', 'h-office']);
    const now = await call(app, { url: '/api/v1/drawings/dw-1', token: office.token });
    assert.deepEqual(now.body.objects.map((o) => o.id).sort(), ids);
    assert.equal(now.body.objects.find((o) => o.id === 'n1').by.name, 'Jackson Reid', 'attribution kept');
    // pushing the merged copy back is a clean write
    const r3 = await pushOne(crew.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', baseVersion: r2.server.version, data: r2.server.data });
    assert.equal(r3.status, 'ok', JSON.stringify(r3));
  });

  test('crew can draw: a crew session writes drawings', async () => {
    const r = await pushOne(crew.token, { collection: 'drawings', id: 'dw-crew', op: 'upsert', data: drawingBody({ name: 'Crew sketch', jobId: null, objects: [rec('c1', 0, JACK, 50)] }) });
    assert.equal(r.status, 'ok', JSON.stringify(r));
  });
});

describe('cost impact: prices for money roles only', { skip }, () => {
  test('office sees the priced delta; crew sees what changed and who, never a price', async () => {
    const o = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: office.token });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.prices, true);
    assert.deepEqual(o.body.lines.map((l) => [l.symbol, l.diff]), [['receptacle', 4], ['junction', -1]]);
    assert.equal(o.body.totals.materialCents, 4800 - 900);
    assert.equal(o.body.totals.markupCents, 390, 'the estimate markup (10%)');
    assert.equal(o.body.totals.labourHours, 1.5);
    assert.deepEqual(o.body.who.receptacle.map((g) => [g.who.name, g.n]), [['Jackson Reid', 4]]);
    assert.deepEqual(o.body.who.junction.map((g) => [g.who.name, g.n]), [['Olive Office', 1]]);

    const c = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: crew.token });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.prices, false);
    assert.deepEqual(c.body.lines.map((l) => [l.symbol, l.diff]), [['receptacle', 4], ['junction', -1]]);
    assert.ok(!MONEY_KEYS.test(JSON.stringify(c.body)), JSON.stringify(c.body));
    assert.ok(!c.body.totals);
  });

  test('foremen see money only when the company allows it', async () => {
    const before = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: foreman.token });
    assert.equal(before.body.prices, false);
    assert.ok(!MONEY_KEYS.test(JSON.stringify(before.body)));
    const items = await call(app, { url: '/api/v1/items?limit=50', token: foreman.token });
    assert.ok(items.body.data.every((i) => !('priceCents' in i) && i.pricesHidden), 'inventory without prices');
    const s = await call(app, { url: '/api/v1/settings/settings', token: A.token });
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { foremanSeesCosts: true }, headers: { 'if-match': String(s.body.version) } })).status, 200);
    const allowed = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: foreman.token });
    assert.equal(allowed.body.prices, true);
    assert.equal(allowed.body.totals.materialCents, 3900);
    const items2 = await call(app, { url: '/api/v1/items?limit=50', token: foreman.token });
    assert.ok(items2.body.data.every((i) => i.priceCents > 0));
    // still never for electricians
    const crewItems = await call(app, { url: '/api/v1/items?limit=50', token: crew.token });
    assert.ok(crewItems.body.data.every((i) => !('priceCents' in i) && !('costCents' in i)));
    await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { foremanSeesCosts: false } });
  });

  test('crew never receive price fields: sync pull, list and get', async () => {
    const changes = await pullAll(crew.token);
    const json = JSON.stringify(changes);
    assert.ok(changes.some((c) => c.collection === 'items'), 'crew still read the price book (symbols)');
    assert.ok(changes.some((c) => c.collection === 'jobs'));
    assert.ok(changes.some((c) => c.collection === 'drawings' && c.id === 'dw-1'));
    assert.ok(!/"(priceCents|costCents|amountCents|unitCents|labourRateCents|markupPct)"/.test(json), 'no price field anywhere in a crew pull');
    assert.ok(!changes.some((c) => c.collection === 'estimates'), 'estimates stay with the office');
    const job = await call(app, { url: '/api/v1/jobs/job-1', token: crew.token });
    assert.equal(job.body.changeOrders[0].title, 'Extra pot lights');
    assert.ok(!('amountCents' in job.body.changeOrders[0]));
    const settings = await call(app, { url: '/api/v1/settings/settings', token: crew.token });
    assert.ok(!('labourRateCents' in settings.body) && !('markupPct' in settings.body));
    // the office and owner do see them
    const officeJob = await call(app, { url: '/api/v1/jobs/job-1', token: office.token });
    assert.equal(officeJob.body.changeOrders[0].amountCents, 45000);
    const officeItems = (await pullAll(office.token)).filter((c) => c.collection === 'items');
    assert.ok(officeItems.every((c) => c.data.priceCents > 0));
  });

  test('a change order with lines: crew see the change, not the money', async () => {
    const j = await call(app, { url: '/api/v1/jobs/job-1', token: office.token });
    const co = { id: 'co-dw', title: 'Drawing changes: +4 duplex receptacles, −1 junction box', amountCents: 4290, status: 'pending', date: '2026-10-19', source: 'drawing', drawingIds: ['dw-1'],
      createdBy: { id: 'emp-office', name: 'Olive Office' }, note: '4 duplex receptacles added by Jackson Reid',
      lines: [{ symbol: 'receptacle', itemId: 'i-rec', description: 'Duplex receptacle', qty: 4, unitCents: 1200, labourHours: 0.45, kind: 'material' }, { symbol: 'junction', itemId: 'i-jb', description: 'Junction box', qty: -1, unitCents: 900, labourHours: 0.3, kind: 'material' }] };
    const r = await pushOne(office.token, { collection: 'jobs', id: 'job-1', op: 'upsert', baseVersion: j.body.version, data: { ...j.body, changeOrders: [...j.body.changeOrders, co] } });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    const after = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: office.token });
    assert.deepEqual(after.body.lines, [], 'covered by the change order now');
    const crewJob = await call(app, { url: '/api/v1/jobs/job-1', token: crew.token });
    const seen = crewJob.body.changeOrders.find((c) => c.id === 'co-dw');
    assert.equal(seen.lines[0].qty, 4);
    assert.ok(!MONEY_KEYS.test(JSON.stringify(crewJob.body).replace(/"labourHours"/g, '"h"')), JSON.stringify(crewJob.body));
  });

  test('writes from readers without money cannot wipe or change prices', async () => {
    // the foreman (no money) edits the price book entry and the job: prices stay as stored
    const item = await call(app, { url: '/api/v1/items/i-rec', token: foreman.token });
    assert.ok(!('priceCents' in item.body));
    const w = await pushOne(foreman.token, { collection: 'items', id: 'i-rec', op: 'upsert', baseVersion: item.body.version, data: { ...item.body, name: 'Duplex receptacle TR', priceCents: 1 } });
    assert.equal(w.status, 'ok', JSON.stringify(w));
    const job = await call(app, { url: '/api/v1/jobs/job-1', token: foreman.token });
    const jw = await pushOne(foreman.token, { collection: 'jobs', id: 'job-1', op: 'upsert', baseVersion: job.body.version, data: { ...job.body, title: 'Smith reno (phase 2)' } });
    assert.equal(jw.status, 'ok', JSON.stringify(jw));
    const ownerItem = await call(app, { url: '/api/v1/items/i-rec', token: A.token });
    assert.equal(ownerItem.body.name, 'Duplex receptacle TR');
    assert.equal(ownerItem.body.priceCents, 1200);
    assert.equal(ownerItem.body.costCents, 245);
    assert.ok(!('pricesHidden' in ownerItem.body));
    const ownerJob = await call(app, { url: '/api/v1/jobs/job-1', token: A.token });
    assert.equal(ownerJob.body.title, 'Smith reno (phase 2)');
    assert.equal(ownerJob.body.changeOrders.find((c) => c.id === 'co-0').amountCents, 45000);
    assert.equal(ownerJob.body.changeOrders.find((c) => c.id === 'co-dw').lines[0].unitCents, 1200);
  });

  test('a drawing not on a job has nothing to compare', async () => {
    await pushOne(A.token, { collection: 'drawings', id: 'dw-free', op: 'upsert', data: drawingBody({ jobId: null }) });
    const r = await call(app, { url: '/api/v1/drawings/dw-free/cost-impact', token: office.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.ready, false);
    assert.equal(r.body.reason, 'no-job');
  });
});

describe('tenant isolation', { skip }, () => {
  test("another company cannot read a drawing's cost impact or the drawing", async () => {
    for (const url of ['/api/v1/drawings/dw-1/cost-impact', '/api/v1/drawings/dw-1']) {
      const r = await call(app, { url, token: B.token });
      assert.equal(r.status, 404, url);
      assert.ok(!JSON.stringify(r.body).includes('Smith'), url);
    }
    const pulled = await pullAll(B.token);
    assert.ok(!pulled.some((c) => c.id === 'dw-1' || c.id === 'job-1' || c.id === 'i-rec'));
  });

  test("a push to the same id from another company never merges into A's drawing", async () => {
    const r = await pushOne(B.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', data: drawingBody({ name: 'B copy', objects: [rec('b1', 0, { id: 'x', name: 'B person' }, 55)] }) });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    const a = await call(app, { url: '/api/v1/drawings/dw-1', token: A.token });
    assert.ok(!a.body.objects.some((o) => o.id === 'b1'));
    assert.equal(a.body.name, 'Smith reno · E1.0');
    const b = await call(app, { url: '/api/v1/drawings/dw-1', token: B.token });
    assert.deepEqual(b.body.objects.map((o) => o.id), ['b1']);
    const bi = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: B.token });
    assert.equal(bi.status, 200);
    assert.equal(bi.body.ready, false, "B's drawing points at a job B does not have");
  });

  test('an anonymous request is refused', async () => {
    const r = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact' });
    assert.equal(r.status, 401);
  });
});
