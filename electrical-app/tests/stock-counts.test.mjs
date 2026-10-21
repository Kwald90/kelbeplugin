// Inventory cost and count sheets (js/lib/stock-counts.js, docs/releases/r1-get-paid.md 8.4): the moving
// average, the average and the quantity as of a past day, valuation by location as of the cutoff, count
// sheets, and posting a count against the quantity at the moment it was counted.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/lib/stock-counts.js';

const item = { id: 'i1', name: 'Wire', costCents: 1000, stock: { shop: 10, van: 4 } };
const box = { id: 'i2', name: 'Box', costCents: 300, stock: { van: 0 } };
const moves = [
  { id: 'rc1', itemId: 'i1', toLocationId: 'shop', qty: 10, use: 'receive', unitCostCents: 1200, date: '2026-09-05', createdAt: '2026-09-05T15:00:00.000Z' },
  { id: 'use1', itemId: 'i1', fromLocationId: 'shop', qty: 4, jobId: 'j1', date: '2026-09-20', createdAt: '2026-09-20T15:00:00.000Z' },
  { id: 'rc2', itemId: 'i1', toLocationId: 'shop', qty: 6, use: 'receive', unitCostCents: 1500, date: '2026-10-05', createdAt: '2026-10-05T15:00:00.000Z' },
  { id: 'tr', itemId: 'i1', fromLocationId: 'shop', toLocationId: 'van', qty: 4, date: '2026-10-10', createdAt: '2026-10-10T15:00:00.000Z' },
];
const locations = [{ id: 'shop', name: 'Shop', kind: 'shop' }, { id: 'van', name: 'Van 1', kind: 'van' }];

describe('moving average', () => {
  test('(on hand x average + qty x cost) / (on hand + qty); nothing on hand takes the new cost', () => {
    assert.equal(S.movingAverage(10, 1000, 10, 2000), 1500);
    assert.equal(S.movingAverage(0, 1000, 5, 1300), 1300);
    assert.equal(S.movingAverage(-3, 1000, 5, 1300), 1300, 'negative stock (a count is due) never skews it');
    assert.equal(S.movingAverage(4, null, 5, 900), 900);
  });

  test('the average as of a past day replays the receipts in order', () => {
    // Before the moves: 14 - (10 - 4 + 6) = 2 on hand at the catalogue cost.
    assert.equal(S.avgCostAsOf(item, moves, '2026-09-30'), Math.round((2 * 1000 + 10 * 1200) / 12));
    const sep = Math.round((2 * 1000 + 10 * 1200) / 12);
    assert.equal(S.avgCostAsOf(item, moves), Math.round((8 * sep + 6 * 1500) / 14));
    assert.equal(S.avgCostAsOf({ id: 'x', costCents: 700, avgCostCents: 650 }, []), 650, 'never received: the server average, else the catalogue cost');
  });
});

describe('valuation as of a date', () => {
  test('quantity per location then (moves after it rolled back) x the average then', () => {
    assert.equal(S.qtyAt(item, 'shop', moves, '2026-09-30'), 8);
    assert.equal(S.qtyAt(item, 'van', moves, '2026-09-30'), 0);
    const v = S.valuationByLocation({ items: [item, box], stockMoves: moves, locations, asOf: '2026-09-30' });
    const shop = v.find((x) => x.locationId === 'shop');
    assert.equal(shop.valueCents, 8 * S.avgCostAsOf(item, moves, '2026-09-30'));
    assert.equal(v.find((x) => x.locationId === 'van').valueCents, 0);
    const now = S.valuationByLocation({ items: [item], stockMoves: moves, locations });
    assert.equal(now.find((x) => x.locationId === 'van').valueCents, 4 * S.avgCostAsOf(item, moves));
  });
});

describe('count sheets', () => {
  test('a sheet lists what should be at the location', () => {
    const sheet = S.countSheet({ items: [item, box], locationId: 'van', date: '2026-10-20' });
    assert.deepEqual(sheet.lines, [{ itemId: 'i1', expectedQty: 4, countedQty: null }]);
    assert.equal(sheet.status, 'draft');
    assert.equal(S.countSheet({ items: [item, box], locationId: 'van', date: '2026-10-20', all: true }).lines.length, 2);
  });

  test('posting compares with the quantity at countedAt, so a move made while counting does not skew it', () => {
    // Counted 3 at 15:00; at 17:00 one more went out of the van (stock now 3).
    const later = { id: 'late', itemId: 'i1', fromLocationId: 'van', qty: 1, jobId: 'j1', date: '2026-10-20', createdAt: '2026-10-20T17:00:00.000Z' };
    const live = { ...item, stock: { shop: 10, van: 3 } };
    const count = { id: 'c1', locationId: 'van', date: '2026-10-20', status: 'counted', countedAt: '2026-10-20T15:00:00.000Z', lines: [{ itemId: 'i1', expectedQty: 4, countedQty: 3 }] };
    const adj = S.countAdjustments(count, { items: [live], stockMoves: [...moves, later] });
    assert.equal(adj.length, 1);
    assert.equal(adj[0].diff, -1);
    assert.deepEqual({ ...adj[0].move, note: undefined }, { itemId: 'i1', qty: 1, use: 'adjust', countId: 'c1', date: '2026-10-20', jobId: null, fromLocationId: 'van', toLocationId: null, note: undefined });
    // Without countedAt the count would match today's 3 and miss the loss.
    assert.equal(S.countAdjustments({ ...count, countedAt: null }, { items: [live], stockMoves: [...moves, later] }).length, 0);
  });

  test('a count found more: a move into the location; its own adjustments are not counted twice', () => {
    const count = { id: 'c2', locationId: 'shop', date: '2026-10-20', status: 'counted', countedAt: '2026-10-20T15:00:00.000Z', lines: [{ itemId: 'i1', expectedQty: 10, countedQty: 12 }, { itemId: 'i2', expectedQty: 0, countedQty: null }] };
    const adj = S.countAdjustments(count, { items: [item, box], stockMoves: moves });
    assert.deepEqual(adj.map((a) => [a.itemId, a.diff, a.move.toLocationId]), [['i1', 2, 'shop']]);
    const posted = { ...adj[0].move, id: 'adj1', createdAt: '2026-10-20T16:00:00.000Z' };
    const after = { ...item, stock: { shop: 12, van: 4 } };
    assert.equal(S.countAdjustments(count, { items: [after, box], stockMoves: [...moves, posted] }).length, 0, 'posting twice adds nothing');
  });

  test('progress and problems', () => {
    const c = { locationId: 'van', status: 'draft', lines: [{ itemId: 'i1', expectedQty: 4, countedQty: 3 }, { itemId: 'i2', expectedQty: 1, countedQty: null }] };
    assert.deepEqual(S.countProgress(c), { lines: 2, counted: 1, differ: 1 });
    assert.deepEqual(S.countProblems(c), []);
    assert.ok(S.countProblems({ ...c, status: 'posted' }).length);
    assert.ok(S.countProblems({ ...c, lines: [{ itemId: 'i1', countedQty: null }] }).some((m) => /Nothing has been counted/.test(m)));
  });
});
