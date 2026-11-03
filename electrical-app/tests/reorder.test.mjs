// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorderSuggestions, reorderLines, ordersFromReorder } from '../js/lib/reorder.js';

const onHandTotal = (it) => Object.values(it.stock || {}).reduce((s, n) => s + (Number(n) || 0), 0);

test('suggests only items below their reorder point, topped up to max', () => {
  const items = [
    { id: 'a', name: 'Marrette', reorderPoint: 100, maxStock: 500, costCents: 10, unit: 'ea', stock: { shop: 20, van: 10 } }, // 30 on hand, min 100
    { id: 'b', name: 'Fine', reorderPoint: 50, maxStock: 200, costCents: 5, stock: { shop: 60 } },                             // 60 >= 50: not low
    { id: 'c', name: 'No max', reorderPoint: 40, costCents: 3, stock: { shop: 10 } },                                          // low, no max -> to min
    { id: 'd', name: 'Untracked', reorderPoint: 0, stock: { shop: 0 } },                                                       // no reorder point: ignored
  ];
  const s = reorderSuggestions(items, { onHandTotal });
  assert.equal(s.length, 2);
  const a = s.find((x) => x.item.id === 'a');
  assert.equal(a.onHand, 30);
  assert.equal(a.need, 470); // 500 - 30
  const c = s.find((x) => x.item.id === 'c');
  assert.equal(c.need, 30); // 40 - 10 (no max -> restock to the min)
});

test('need is at least 1 even if on hand sits right at the max', () => {
  const s = reorderSuggestions([{ id: 'a', name: 'X', reorderPoint: 5, maxStock: 4, costCents: 1, stock: { shop: 3 } }], { onHandTotal });
  // max (4) < min (5) is nonsense; falls back to restocking to the min, so need = 5 - 3 = 2
  assert.equal(s[0].need, 2);
});

test('groups into one order per preferred supplier; no-supplier items share one', () => {
  const items = [
    { id: 'a', name: 'A', reorderPoint: 10, costCents: 100, unit: 'ea', preferredVendorId: 'eecol', stock: {} },
    { id: 'b', name: 'B', reorderPoint: 10, costCents: 200, unit: 'ft', preferredVendorId: 'eecol', stock: {} },
    { id: 'c', name: 'C', reorderPoint: 10, costCents: 300, preferredVendorId: 'westburne', stock: {} },
    { id: 'd', name: 'D', reorderPoint: 10, costCents: 400, stock: {} }, // no supplier
  ];
  const orders = ordersFromReorder(reorderSuggestions(items, { onHandTotal }));
  assert.equal(orders.length, 3); // eecol, westburne, no-supplier
  const eecol = orders.find((o) => o.vendorId === 'eecol');
  assert.equal(eecol.lines.length, 2);
  assert.equal(eecol.lines[0].itemId, 'a');
  assert.equal(eecol.lines[0].qty, 10); // 10 - 0 on hand
  assert.equal(eecol.lines[0].unitCents, 100);
  assert.ok(orders.some((o) => o.vendorId === null));
});

test('reorderLines carries item id, qty, unit and cost', () => {
  const lines = reorderLines([{ item: { id: 'x', name: 'Wire', unit: 'ft' }, need: 250, unitCents: 42 }]);
  assert.deepEqual(lines, [{ itemId: 'x', description: 'Wire', qty: 250, unit: 'ft', unitCents: 42, materialRequestIds: [] }]);
});
