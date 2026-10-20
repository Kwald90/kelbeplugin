// Collaborative drawings on the server: the object-level merge of drawing writes, the cost
// impact route (prices for money roles only), price fields stripped for crew everywhere they
// read them (items, jobs' change orders, settings), crew writes that cannot wipe prices, and
// tenant isolation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, apiKey, call, ownerTenant, startApp } from './support/app.js';

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
    const r1 = await pushOne(office.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', baseVersion: base.version, itemMerge: true, data: officeCopy });
    assert.equal(r1.status, 'ok', JSON.stringify(r1));
    // the crew device was offline: its push is stale and older, but nothing of either is lost
    const r2 = await pushOne(crew.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', baseVersion: base.version, itemMerge: true, data: crewCopy });
    assert.equal(r2.status, 'conflict', 'the device gets the merged copy back');
    const ids = r2.server.data.objects.map((o) => o.id).sort();
    assert.deepEqual(ids, ['n1', 'n2', 'n3', 'n4', 'o1', 'o2']);
    assert.ok(r2.server.data.tombstones.j1);
    assert.deepEqual(r2.server.data.history.map((h) => h.id), ['h-crew', 'h-office']);
    const now = await call(app, { url: '/api/v1/drawings/dw-1', token: office.token });
    assert.deepEqual(now.body.objects.map((o) => o.id).sort(), ids);
    assert.equal(now.body.objects.find((o) => o.id === 'n1').by.name, 'Jackson Reid', 'attribution kept');
    // pushing the merged copy back is a clean write
    const r3 = await pushOne(crew.token, { collection: 'drawings', id: 'dw-1', op: 'upsert', baseVersion: r2.server.version, itemMerge: true, data: r2.server.data });
    assert.equal(r3.status, 'ok', JSON.stringify(r3));
  });

  test('an older app (no itemMerge) is last-writer-wins: a stale copy never replaces newer work, a fresh delete sticks', async () => {
    const OLIVE = { id: 'emp-office', name: 'Olive Office' };
    const c = await pushOne(office.token, { collection: 'drawings', id: 'dw-old', op: 'upsert', itemMerge: true, data: drawingBody({ jobId: null, objects: [rec('o1', 0, OLIVE, 1), rec('o2', 40, OLIVE, 1)] }) });
    assert.equal(c.status, 'ok', JSON.stringify(c));
    // a new-app device adds 5 receptacles at minute 20
    const newer = drawingBody({ jobId: null, objects: [rec('o1', 0, OLIVE, 1), rec('o2', 40, OLIVE, 1), ...[1, 2, 3, 4, 5].map((i) => rec(`n${i}`, 80 + i * 40, JACK, 20))],
      history: [{ id: 'h-n', by: JACK, at: at(20), until: at(20), add: { receptacle: 5 }, del: {}, move: {}, edit: {}, box: null, ids: [], ch: [] }], updatedAt: at(20) });
    const w = await pushOne(crew.token, { collection: 'drawings', id: 'dw-old', op: 'upsert', baseVersion: c.version, itemMerge: true, data: newer });
    assert.equal(w.status, 'ok', JSON.stringify(w));
    const ids = (d) => d.objects.map((o) => o.id).sort();

    // an iPad on the app from before tracking edited its version-1 copy offline at minute 10 (no tombstones field)
    const legacy = drawingBody({ jobId: null, objects: [rec('o1', 5, OLIVE, 1)], updatedAt: at(10) });
    delete legacy.tombstones; delete legacy.history;
    const r1 = await pushOne(office.token, { collection: 'drawings', id: 'dw-old', op: 'upsert', baseVersion: c.version, data: legacy });
    assert.equal(r1.status, 'conflict', 'the newer server copy wins, as before tracking');
    assert.deepEqual(ids(r1.server.data), ['n1', 'n2', 'n3', 'n4', 'n5', 'o1', 'o2']);
    assert.deepEqual(r1.server.data.history.map((h) => h.id), ['h-n'], 'history kept');
    assert.ok(r1.server.data.tombstones, 'tombstones kept');
    // the same stale copy without tombstones from a new app (a drawing never opened since tracking) is no different
    const r2 = await pushOne(office.token, { collection: 'drawings', id: 'dw-old', op: 'upsert', baseVersion: c.version, itemMerge: true, data: legacy });
    assert.equal(r2.status, 'conflict');
    assert.deepEqual(ids(r2.server.data), ids(r1.server.data));

    // the older app pulled the current copy (tombstones and history carried over) and deletes n1 and o2:
    // its deletes stick instead of being merged back from the stored copy
    const cur = await call(app, { url: '/api/v1/drawings/dw-old', token: office.token });
    const { id: _id, version, ...data } = cur.body;
    void _id;
    const oldApp = { ...data, objects: data.objects.filter((o) => o.id !== 'n1' && o.id !== 'o2'), updatedAt: at(30) };
    const r3 = await pushOne(office.token, { collection: 'drawings', id: 'dw-old', op: 'upsert', baseVersion: version, data: oldApp });
    assert.equal(r3.status, 'ok', JSON.stringify(r3));
    const after = await call(app, { url: '/api/v1/drawings/dw-old', token: office.token });
    assert.deepEqual(ids(after.body), ['n2', 'n3', 'n4', 'n5', 'o1']);
    // the same kind of write from a tracking app (an item left out with no tombstone) keeps the union, as designed
    const t = await pushOne(office.token, { collection: 'drawings', id: 'dw-old', op: 'upsert', baseVersion: after.body.version, itemMerge: true,
      data: { ...oldApp, objects: oldApp.objects.filter((o) => o.id !== 'n2'), updatedAt: at(31) } });
    assert.equal(t.status, 'conflict', 'an item left out without a tombstone comes back');
    assert.ok(t.server.data.objects.some((o) => o.id === 'n2'));
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

  test("a drawing change order's markup line: crew see neither the rate nor its words", async () => {
    const j = await call(app, { url: '/api/v1/jobs/job-1', token: office.token });
    const co = { id: 'co-mk', title: 'Drawing changes: +2 duplex receptacles', amountCents: 2880, status: 'pending', date: '2026-10-19', source: 'drawing',
      lines: [{ symbol: null, itemId: null, description: 'Markup on material', markupPct: 20, qty: 1, unitCents: 480, labourHours: 0, kind: 'other' },
        // as raised by v0.7.0, with the rate in the words
        { symbol: null, itemId: null, description: 'Markup 12.5% on material', qty: 1, unitCents: 300, labourHours: 0, kind: 'other' }] };
    const r = await pushOne(office.token, { collection: 'jobs', id: 'job-1', op: 'upsert', baseVersion: j.body.version, data: { ...j.body, changeOrders: [...j.body.changeOrders, co] } });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    const crewJob = await call(app, { url: '/api/v1/jobs/job-1', token: crew.token });
    const seen = crewJob.body.changeOrders.find((x) => x.id === 'co-mk');
    assert.deepEqual(seen.lines.map((l) => l.description), ['Markup on material', 'Markup on material']);
    assert.ok(!/%|markupPct/.test(JSON.stringify(seen)), JSON.stringify(seen));
    const crewPull = (await pullAll(crew.token)).find((x) => x.collection === 'jobs' && x.id === 'job-1');
    assert.ok(!/\d%|markupPct/.test(JSON.stringify(crewPull)), 'nor in a sync pull');
    const officeJob = await call(app, { url: '/api/v1/jobs/job-1', token: office.token });
    const full = officeJob.body.changeOrders.find((x) => x.id === 'co-mk');
    assert.equal(full.lines[0].markupPct, 20);
    assert.equal(full.lines[1].description, 'Markup 12.5% on material', 'stored as written');
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

describe('API keys, bill rates and a change of money access', { skip }, () => {
  test('an API key gets cost-impact prices only when its scopes cover where they come from', async () => {
    const drawingsOnly = await apiKey(app, A.token, ['drawings:read'], 'plan viewer');
    const r = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: drawingsOnly });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.prices, false);
    assert.ok(!MONEY_KEYS.test(JSON.stringify(r.body)), JSON.stringify(r.body));
    assert.equal((await call(app, { url: '/api/v1/items/i-rec', token: drawingsOnly })).status, 403, 'the same key reading the price book directly');
    const everything = await apiKey(app, A.token, ['*:read'], 'reporting');
    const all = await call(app, { url: '/api/v1/drawings/dw-1/cost-impact', token: everything });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.prices, true);
    assert.equal(all.body.estimate.labourRateCents, 9500);
  });

  test("bill rates (a T&M job's own, the company travel rate, an employee's) stay with money roles", async () => {
    const job = await call(app, { method: 'PATCH', url: '/api/v1/jobs/job-1', token: A.token, body: { billingMode: 'tm', labourRateCents: 14500, travelRateCents: 12000, markupPct: 15 } });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { billing: { defaultMode: 'tm', travelRateCents: 9000 } } })).status, 200);
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/employees/emp-crew', token: A.token, body: { rateCents: 4000, billRateCents: 9800 } })).status, 200);

    const crewJob = (await call(app, { url: '/api/v1/jobs/job-1', token: crew.token })).body;
    assert.equal(crewJob.billingMode, 'tm');
    for (const k of ['labourRateCents', 'travelRateCents', 'markupPct']) assert.ok(!(k in crewJob), k);
    assert.equal(crewJob.pricesHidden, true);
    const crewSettings = (await call(app, { url: '/api/v1/settings/settings', token: crew.token })).body;
    assert.equal(crewSettings.billing.defaultMode, 'tm');
    assert.ok(!('travelRateCents' in crewSettings.billing));
    const crewEmp = (await call(app, { url: '/api/v1/employees/emp-crew', token: crew.token })).body;
    assert.equal(crewEmp.name, 'Jackson Reid');
    assert.ok(!('rateCents' in crewEmp) && !('billRateCents' in crewEmp));
    const pulled = JSON.stringify(await pullAll(crew.token));
    assert.ok(!/"(labourRateCents|travelRateCents|markupPct|rateCents|billRateCents)"/.test(pulled), 'no rate anywhere in a crew pull');
    const foremanJob = (await call(app, { url: '/api/v1/jobs/job-1', token: foreman.token })).body;
    assert.ok(!('labourRateCents' in foremanJob), 'a foreman without costs');

    // A foreman without money access can't change them either.
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/jobs/job-1', token: foreman.token, body: { labourRateCents: 100, travelRateCents: null } })).status, 200);
    const fs = (await call(app, { url: '/api/v1/settings/settings', token: foreman.token })).body;
    assert.ok(!('travelRateCents' in fs.billing));
    const bump = await pushOne(foreman.token, { collection: 'settings', id: 'settings', op: 'upsert', baseVersion: fs.version, data: { ...fs, nextNumbers: { ...fs.nextNumbers, job: fs.nextNumbers.job + 1 } } });
    assert.equal(bump.status, 'ok', 'the stripped billing rate is not a settings change');
    const owner = (await call(app, { url: '/api/v1/jobs/job-1', token: A.token })).body;
    assert.equal(owner.labourRateCents, 14500);
    assert.equal(owner.travelRateCents, 12000);
    assert.equal(owner.markupPct, 15);
    assert.equal((await call(app, { url: '/api/v1/settings/settings', token: A.token })).body.billing.travelRateCents, 9000);
  });

  test("a foreman given costs after their device synced doesn't wipe the prices it never got", async () => {
    // The foreman's device pulled these while the company hid costs from foremen.
    const job = (await call(app, { url: '/api/v1/jobs/job-1', token: foreman.token })).body;
    const rec = (await call(app, { url: '/api/v1/items/i-rec', token: foreman.token })).body;
    const jb = (await call(app, { url: '/api/v1/items/i-jb', token: foreman.token })).body;
    assert.ok(job.pricesHidden && rec.pricesHidden && !('amountCents' in job.changeOrders[0]));
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { foremanSeesCosts: true } })).status, 200);
    try {
      // Unchanged records are not pulled again; the foreman now writes from those copies.
      const coNew = { id: 'co-new', title: 'Extra circuit', amountCents: 7000, status: 'pending', date: '2026-10-20' };
      const rs = (await push(foreman.token, [
        mut({ collection: 'jobs', id: 'job-1', op: 'upsert', baseVersion: job.version, data: { ...job, changeOrders: [...job.changeOrders, coNew] } }),
        mut({ collection: 'items', id: 'i-rec', op: 'upsert', baseVersion: rec.version, data: { ...rec, name: 'Duplex receptacle 15A' } }),
        mut({ collection: 'items', id: 'i-jb', op: 'upsert', baseVersion: jb.version, data: { ...jb, priceCents: 950 } }),
      ])).body.results;
      for (const x of rs) assert.equal(x.status, 'ok', JSON.stringify(x));
      const ownerJob = (await call(app, { url: '/api/v1/jobs/job-1', token: A.token })).body;
      const co = (id) => ownerJob.changeOrders.find((c) => c.id === id);
      assert.equal(co('co-0').amountCents, 45000);
      assert.equal(co('co-dw').amountCents, 4290);
      assert.equal(co('co-dw').lines[0].unitCents, 1200);
      assert.equal(co('co-new').amountCents, 7000, 'what they set themselves stays');
      assert.equal(ownerJob.labourRateCents, 14500);
      assert.ok(!('pricesHidden' in ownerJob));
      const ownerRec = (await call(app, { url: '/api/v1/items/i-rec', token: A.token })).body;
      assert.equal(ownerRec.name, 'Duplex receptacle 15A');
      assert.equal(ownerRec.priceCents, 1200);
      assert.equal(ownerRec.costCents, 245);
      const ownerJb = (await call(app, { url: '/api/v1/items/i-jb', token: A.token })).body;
      assert.equal(ownerJb.priceCents, 950, 'a price they typed in is kept');
      assert.equal(ownerJb.costCents, 300);
    } finally {
      await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { foremanSeesCosts: false } });
    }
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
