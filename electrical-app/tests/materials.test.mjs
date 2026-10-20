// Material requests (js/lib/materials.js): the daily send time in the company's zone (across DST),
// the combined list grouped by job, the purchase list and the stock hint.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as MR from '../js/lib/materials.js';

const W = 'America/Winnipeg';
const iso = (d) => d.toISOString();

describe('the daily send time', () => {
  test('time zone from the province; Manitoba is Winnipeg; settings can override', () => {
    assert.equal(MR.requestSettings({ company: { province: 'MB' } }).timeZone, W);
    assert.equal(MR.requestSettings({ company: { province: 'SK' } }).timeZone, 'America/Regina');
    assert.equal(MR.requestSettings({}).timeZone, 'America/Toronto');
    assert.equal(MR.requestSettings({ company: { province: 'MB' }, materialRequests: { timeZone: 'America/Edmonton' } }).timeZone, 'America/Edmonton');
    assert.equal(MR.requestSettings({ company: { province: 'MB' }, materialRequests: { timeZone: 'Mars/Olympus' } }).timeZone, W, 'an unknown zone falls back');
    const d = MR.requestSettings({ company: { province: 'MB', email: 'office@tg.example' } });
    assert.equal(d.sendAt, '15:00', 'default 3:00 pm');
    assert.equal(d.emailTo, 'office@tg.example');
    assert.equal(MR.requestSettings({ materialRequests: { sendAt: '25:00' } }).sendAt, '15:00');
    for (const tz of Object.values(MR.PROVINCE_TZ)) assert.ok(MR.validTimeZone(tz), tz);
  });

  test('3:00 pm in Winnipeg is 21:00 UTC in winter (CST) and 20:00 UTC in summer (CDT)', () => {
    assert.equal(iso(MR.zonedToUtc('2026-01-15', '15:00', W)), '2026-01-15T21:00:00.000Z');
    assert.equal(iso(MR.zonedToUtc('2026-07-15', '15:00', W)), '2026-07-15T20:00:00.000Z');
    assert.equal(iso(MR.zonedToUtc('2026-07-15', '15:00', 'America/Regina')), '2026-07-15T21:00:00.000Z', 'Saskatchewan never changes');
  });

  test('across the spring change (2026-03-08): the day before, the day of, the day after', () => {
    const s = { sendAt: '15:00', timeZone: W };
    // Saturday 3:30 pm CST: next is Sunday 3:00 pm, which is already CDT.
    const sat = MR.nextSendAt(new Date('2026-03-07T21:30:00Z'), s);
    assert.equal(sat.day, '2026-03-08');
    assert.equal(iso(sat.at), '2026-03-08T20:00:00.000Z');
    // Sunday 9 am CDT: today at 3 pm.
    const sun = MR.nextSendAt(new Date('2026-03-08T14:00:00Z'), s);
    assert.equal(iso(sun.at), '2026-03-08T20:00:00.000Z');
    // Exactly at the send: the next one is tomorrow.
    assert.equal(iso(MR.nextSendAt(new Date('2026-03-08T20:00:00Z'), s).at), '2026-03-09T20:00:00.000Z');
    // A time inside the skipped hour (2:30 am never happens) moves to 3:30 am CDT.
    assert.equal(iso(MR.zonedToUtc('2026-03-08', '02:30', W)), '2026-03-08T08:30:00.000Z');
  });

  test('across the fall change (2026-11-01)', () => {
    const s = { sendAt: '15:00', timeZone: W };
    const sat = MR.nextSendAt(new Date('2026-10-31T21:00:00Z'), s); // Sat 4 pm CDT
    assert.equal(sat.day, '2026-11-01');
    assert.equal(iso(sat.at), '2026-11-01T21:00:00.000Z', 'Sunday 3 pm is CST again');
    // 1:30 am happens twice: the first one (CDT).
    assert.equal(iso(MR.zonedToUtc('2026-11-01', '01:30', W)), '2026-11-01T06:30:00.000Z');
    // Late on Sunday evening local, already Monday in UTC: next is Monday 3 pm local.
    const late = MR.nextSendAt(new Date('2026-11-02T04:30:00Z'), s); // Sun 10:30 pm CST
    assert.equal(late.day, '2026-11-02');
    assert.equal(iso(late.at), '2026-11-02T21:00:00.000Z');
  });

  test('the local day is the company’s, not UTC’s; month and year roll over', () => {
    assert.equal(MR.localDayIn(new Date('2026-11-02T04:30:00Z'), W), '2026-11-01');
    assert.equal(MR.addDay('2026-12-31'), '2027-01-01');
    assert.equal(MR.addDay('2028-02-28'), '2028-02-29');
    assert.equal(iso(MR.nextSendAt(new Date('2026-12-31T22:00:00Z'), { sendAt: '15:00', timeZone: W }).at), '2027-01-01T21:00:00.000Z');
    assert.equal(MR.fmtSendAt('15:00'), '3:00 pm');
    assert.equal(MR.fmtSendAt('00:05'), '12:05 am');
    assert.equal(MR.fmtSendAt('12:30'), '12:30 pm');
  });
});

describe('the combined list', () => {
  const jobs = [{ id: 'j2', number: 'J-1002', title: 'Brewhouse', address: '9 Hop Rd' }, { id: 'j1', number: 'J-1001', title: 'Shop rewire', address: '' }];
  const items = new Map([['i1', { id: 'i1', name: 'Two-hole strap 3/4"', unit: 'ea', costCents: 25 }], ['i2', { id: 'i2', name: '3/4" EMT', unit: 'stick', costCents: 1000 }]]);
  const employees = new Map([['e1', { name: 'Sam Sparks' }], ['e2', { name: 'Ana Apprentice' }]]);
  const reqs = [
    { id: 'r1', jobId: 'j2', itemId: 'i1', description: 'x', qty: 50, unit: 'ea', employeeId: 'e1', createdAt: '2026-10-19T15:00:00Z', costCents: 25 },
    { id: 'r2', jobId: 'j1', itemId: 'i2', qty: 20, unit: 'sticks', employeeId: 'e2', createdAt: '2026-10-19T16:00:00Z', urgent: true, note: 'by 7 am' },
    { id: 'r3', jobId: 'j1', itemId: null, description: 'PVC 1in', qty: 3, unit: 'lengths', employeeId: 'e1', createdAt: '2026-10-19T14:00:00Z' },
    { id: 'r4', jobId: 'j2', itemId: 'i1', qty: 25, unit: 'ea', employeeId: 'e2', createdAt: '2026-10-19T17:00:00Z' },
    { id: 'r5', jobId: null, description: 'Shop rags', qty: 1, unit: 'box', employeeId: 'e1', createdAt: '2026-10-19T17:00:00Z' },
  ];

  test('grouped by job in job-number order, urgent first, no-job last', () => {
    const g = MR.groupByJob(reqs, jobs);
    assert.deepEqual(g.map((x) => x.label), ['J-1001 · Shop rewire', 'J-1002 · Brewhouse', 'No job']);
    assert.deepEqual(g[0].requests.map((r) => r.id), ['r2', 'r3'], 'urgent first, then oldest');
  });

  test('one message for the office: every item, who asked, no prices', () => {
    const text = MR.combinedText({ company: 'TG Electrical', dayLabel: 'Mon, Oct 19', groups: MR.groupByJob(reqs, jobs), items, employees, link: 'https://app.example/#/materials' });
    assert.match(text, /^Material requests for TG Electrical, Mon, Oct 19: 5 items for 3 jobs \(1 urgent\)\./);
    assert.match(text, /J-1001 · Shop rewire\n {2}- 20 sticks {2}3\/4" EMT {2}\(Ana Apprentice · URGENT · "by 7 am"\)\n {2}- 3 lengths {2}PVC 1in {2}\(Sam Sparks\)/);
    assert.match(text, /J-1002 · Brewhouse \(9 Hop Rd\)/);
    assert.match(text, /Open the list: https:\/\/app\.example\/#\/materials/);
    assert.doesNotMatch(text, /\$|cost|price/i, 'never a price or cost');
  });

  test('purchase list adds the same item up across jobs', () => {
    const p = MR.purchaseList(reqs, { items, jobs });
    const strap = p.find((x) => x.itemId === 'i1');
    assert.equal(strap.qty, 75);
    assert.deepEqual(strap.jobs, ['J-1002']);
    assert.deepEqual(strap.requestIds, ['r1', 'r4']);
    assert.equal(p.length, 4);
  });

  test('stock hint: "you have 12 in Van 2"', () => {
    const locations = [{ id: 'shop', name: 'Shop' }, { id: 'v2', name: 'Van 2' }, { id: 'v1', name: 'Van 1' }];
    assert.equal(MR.stockHint({ stock: { v2: 12, shop: 0 } }, locations), 'You have 12 in Van 2');
    assert.equal(MR.stockHint({ stock: { v2: 12, shop: 40, v1: 3 } }, locations), 'You have 40 in Shop, 12 in Van 2, 3 in Van 1');
    assert.equal(MR.stockHint({ stock: {} }, locations), null);
    assert.equal(MR.stockHint(null, locations), null);
  });

  test('price-book matching from typed text', () => {
    const list = [...items.values(), { id: 'i3', name: 'PVC coupling 1"', unit: 'ea' }];
    assert.equal(MR.matchItems('two-hole 3/4', list)[0].id, 'i1');
    assert.equal(MR.matchItems('emt', list)[0].id, 'i2');
    assert.deepEqual(MR.matchItems('', list), []);
    assert.equal(MR.qtyText({ qty: 2.5, unit: 'ft' }), '2.5 ft');
    assert.equal(MR.withoutMoney({ id: 'r', costCents: 5 }).costCents, undefined);
  });
});

describe('undoing a "From stock" move', () => {
  test('the request opens again at the step it had reached', () => {
    assert.deepEqual(MR.reopenAfterUndo({ status: 'fulfilled', sentAt: 'x', orderedAt: 'y', stockMoveId: 'm' }), { status: 'ordered', fulfilledAt: null, stockMoveId: null, fromLocationId: null });
    assert.equal(MR.reopenAfterUndo({ status: 'fulfilled', sentAt: 'x' }).status, 'sent');
    assert.equal(MR.reopenAfterUndo({ status: 'fulfilled' }).status, 'requested');
  });

  test('Undo move puts the stock back, removes the move and reopens its request', async () => {
    globalThis.document ??= { addEventListener() {} };
    const { store } = await import('../js/store.js');
    const { applyMove, undoMove } = await import('../js/modules/inventory.js');
    const { unbilledTm } = await import('../js/lib/tm.js');
    await store.open({ kind: 'demo' });
    const it = store.add('items', { name: 'Undo test strap', unit: 'ea', costCents: 25, stock: { vanU: 10 } });
    const job = store.add('jobs', { title: 'Undo test', billingMode: 'tm' });
    const r = store.add('materialRequests', { jobId: job.id, itemId: it.id, qty: 4, status: 'sent', sentAt: '2026-10-19T20:00:00.000Z' });
    const { move } = applyMove(store, { type: 'use', itemId: it.id, fromLocationId: 'vanU', qty: 4, jobId: job.id, date: '2026-10-20' });
    store.update('materialRequests', r.id, { status: 'fulfilled', fulfilledAt: '2026-10-20T15:00:00.000Z', stockMoveId: move.id, fromLocationId: 'vanU' });
    assert.equal(store.get('items', it.id).stock.vanU, 6);
    assert.equal(undoMove(store, store.get('stockMoves', move.id)), 1);
    assert.equal(store.get('items', it.id).stock.vanU, 10);
    assert.equal(store.get('stockMoves', move.id), null);
    const back = store.get('materialRequests', r.id);
    assert.deepEqual([back.status, back.stockMoveId, back.fulfilledAt], ['sent', null, null]);
    const src = { timeEntries: [], stockMoves: store.list('stockMoves'), materialRequests: store.list('materialRequests'), items: store.list('items') };
    assert.equal(unbilledTm({ job: store.get('jobs', job.id), settings: {}, ...src }).materials.length, 0, 'nothing used, nothing billed');
  });
});
