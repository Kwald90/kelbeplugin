// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseMoneyCents, guessMapping, planUpdate, summarize } from '../js/lib/pricelist.js';

test('parseCsv handles quotes, commas in fields and CRLF', () => {
  const { headers, rows } = parseCsv('SKU,Description,Cost\r\nABC-1,"Box, 2-gang",3.50\r\nDEF-2,"Wire ""THHN""",0.42\n');
  assert.deepEqual(headers, ['SKU', 'Description', 'Cost']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['ABC-1', 'Box, 2-gang', '3.50']);
  assert.equal(rows[1][1], 'Wire "THHN"');
});

test('parseMoneyCents strips currency formatting', () => {
  assert.equal(parseMoneyCents('$1,234.56'), 123456);
  assert.equal(parseMoneyCents('0.42'), 42);
  assert.equal(parseMoneyCents(''), null);
  assert.equal(parseMoneyCents('n/a'), null);
});

test('guessMapping finds part number and prefers cost over list price', () => {
  const m = guessMapping(['Catalog #', 'Description', 'List Price', 'Net Cost']);
  assert.equal(m.sku, 0);
  assert.equal(m.description, 1);
  assert.equal(m.cost, 3, 'net cost beats list price');
  assert.equal(m.price, 2);
});

test('planUpdate matches by part number, flags changes, and collects new rows', () => {
  const items = [
    { id: 'i1', sku: 'ABC-1', name: 'Box', costCents: 300 },
    { id: 'i2', sku: 'OTHER', supplierSku: 'DEF-2', name: 'Wire', costCents: 42 },
  ];
  const { rows } = parseCsv('SKU,Description,Cost\nABC-1,Box,3.50\nDEF-2,Wire,0.42\nNEW-9,New part,9.99\n');
  const plan = planUpdate({ rows, mapping: { sku: 0, description: 1, cost: 2, price: -1 }, items });
  assert.equal(plan.matched.length, 2, 'matched by sku and by supplierSku');
  assert.equal(plan.matched.find((m) => m.sku === 'ABC-1').changed, true, '300 -> 350');
  assert.equal(plan.matched.find((m) => m.sku === 'DEF-2').changed, false, '42 unchanged');
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].sku, 'NEW-9');
  assert.equal(plan.changedCount, 1);
  assert.match(summarize(plan), /2 matched/);
});

test('rows missing a part number or cost are skipped, not matched', () => {
  const { rows } = parseCsv('SKU,Cost\n,3.00\nABC,\nABC,4.00\n');
  const plan = planUpdate({ rows, mapping: { sku: 0, description: -1, cost: 1, price: -1 }, items: [{ id: 'i', sku: 'ABC', costCents: 100 }] });
  assert.equal(plan.skipped, 2);
  assert.equal(plan.matched.length, 1);
});
