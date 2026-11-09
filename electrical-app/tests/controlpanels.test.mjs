// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newPanel, newComponent, newIoPoint, newWire, newNameplate,
  componentCostCents, bomTotals, ioCounts, estimateLines, panelLabel,
  IO_TYPE_IDS, ioTypeOf,
} from '../js/lib/controlpanels.js';

test('a new panel is tied to a job and starts with empty schedules', () => {
  const p = newPanel({ name: 'Main PLC', tag: 'CP-101', job: { id: 'j1', clientId: 'c1' }, by: 'u1' });
  assert.equal(p.name, 'Main PLC');
  assert.equal(p.tag, 'CP-101');
  assert.equal(p.jobId, 'j1');
  assert.equal(p.clientId, 'c1');
  assert.equal(p.createdBy, 'u1');
  assert.deepEqual([p.components, p.io, p.wiring, p.nameplates], [[], [], [], []]);
});

test('a component takes cost from the price-book item (cost before sell price)', () => {
  const c = newComponent({ id: 'it1', sku: 'ABB-A9', name: 'Contactor', manufacturer: 'ABB', costCents: 4200, priceCents: 7000 });
  assert.equal(c.itemId, 'it1');
  assert.equal(c.part, 'ABB-A9');
  assert.equal(c.description, 'Contactor');
  assert.equal(c.manufacturer, 'ABB');
  assert.equal(c.unitCents, 4200);
  // falls back to sell price when there is no cost
  assert.equal(newComponent({ id: 'it2', priceCents: 900 }).unitCents, 900);
  assert.equal(newComponent().unitCents, 0);
});

test('component extended cost is qty x unit, clamped at zero', () => {
  assert.equal(componentCostCents({ qty: 3, unitCents: 4200 }), 12600);
  assert.equal(componentCostCents({ qty: -2, unitCents: 500 }), 0);
  assert.equal(componentCostCents({ qty: 2, unitCents: -5 }), 0);
  assert.equal(componentCostCents({}), 0);
});

test('BOM totals roll up line count, pieces and material cost', () => {
  const p = newPanel({ name: 'P' });
  p.components = [
    newComponent({ costCents: 4200 }),            // qty 1 -> 4200
    { ...newComponent({ costCents: 1000 }), qty: 5 }, // 5000
  ];
  const t = bomTotals(p);
  assert.equal(t.lineCount, 2);
  assert.equal(t.totalQty, 6);
  assert.equal(t.materialCents, 9200);
});

test('I/O counts tally by type', () => {
  const p = newPanel({ name: 'P' });
  p.io = [newIoPoint('DI'), newIoPoint('DI'), newIoPoint('AO'), newIoPoint('DO')];
  const c = ioCounts(p);
  assert.deepEqual([c.DI, c.DO, c.AI, c.AO, c.total], [2, 1, 0, 1, 4]);
});

test('a new I/O point defaults to a valid type and rejects an unknown one', () => {
  assert.equal(newIoPoint('AI').type, 'AI');
  assert.equal(newIoPoint('bogus').type, 'DI', 'unknown type falls back to DI');
  assert.deepEqual(IO_TYPE_IDS, ['DI', 'DO', 'AI', 'AO']);
  assert.equal(ioTypeOf('AO').label, 'Analog output');
  assert.equal(ioTypeOf('nope'), null);
});

test('blank wiring and nameplate rows carry the expected fields', () => {
  assert.deepEqual(Object.keys(newWire()).sort(), ['colour', 'from', 'gauge', 'id', 'terminal', 'to', 'wire'].sort());
  assert.deepEqual(Object.keys(newNameplate()).sort(), ['colour', 'id', 'item', 'legend', 'size'].sort());
});

test('estimate lines drop zero-qty rows and tag the panel', () => {
  const p = newPanel({ name: 'P' });
  p.components = [
    { ...newComponent({ sku: 'X', name: 'Relay', costCents: 500 }), qty: 2 },
    { ...newComponent({ name: 'Scratch' }), qty: 0 },
  ];
  const lines = estimateLines(p);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 2);
  assert.equal(lines[0].unitCents, 500);
  assert.equal(lines[0].description, 'X — Relay');
  assert.equal(lines[0].controlPanelId, p.id);
  assert.equal(lines[0].kind, 'material');
});

test('panel label prefers tag · name', () => {
  assert.equal(panelLabel({ tag: 'CP-1', name: 'Pump' }), 'CP-1 · Pump');
  assert.equal(panelLabel({ name: 'Pump' }), 'Pump');
  assert.equal(panelLabel({}), 'Control panel');
});
