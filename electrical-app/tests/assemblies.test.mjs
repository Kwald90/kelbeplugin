// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newAssembly, newComponent, materialUnitCents, labourUnitHours, explodeAssembly, unitSellCents, activeAssemblies } from '../js/lib/assemblies.js';

// A duplex receptacle: box + device + plate + 12 ft of wire, 0.35 h labour.
function receptacle() {
  const a = newAssembly({ name: 'Duplex receptacle', category: 'Devices', by: 'u1' });
  a.labourHours = 0.35;
  a.components = [
    { id: 'c1', itemId: 'box', description: 'Device box', qty: 1, unitCents: 180 },
    { id: 'c2', itemId: 'dev', description: '15A receptacle', qty: 1, unitCents: 240 },
    { id: 'c3', itemId: 'plate', description: 'Cover plate', qty: 1, unitCents: 60 },
    { id: 'c4', itemId: 'wire', description: '14/2 NMD90', qty: 12, unitCents: 35 },
  ];
  return a;
}

test('material cost per unit sums the components (qty x unit cost)', () => {
  assert.equal(materialUnitCents(receptacle()), 180 + 240 + 60 + 12 * 35); // 900
  assert.equal(materialUnitCents(newAssembly({ name: 'empty' })), 0);
});

test('explode makes a priced material line plus a labour line at the estimate rate', () => {
  const a = receptacle();
  const lines = explodeAssembly(a, 40, { labourRateCents: 9500 });
  assert.equal(lines.length, 2);
  const [mat, lab] = lines;
  assert.equal(mat.kind, 'material');
  assert.equal(mat.qty, 40);
  assert.equal(mat.unitCents, 900);
  assert.equal(mat.labourHours, 0.35, 'material line carries labour hours for scheduling');
  assert.equal(mat.assemblyId, a.id);
  assert.equal(lab.kind, 'labour');
  assert.equal(lab.qty, 14, '0.35 h x 40 = 14 h');
  assert.equal(lab.unitCents, 9500);
});

test('no labour line when the assembly has no hours or no rate is given', () => {
  const a = receptacle(); a.labourHours = 0;
  assert.equal(explodeAssembly(a, 10, { labourRateCents: 9500 }).length, 1);
  assert.equal(explodeAssembly(receptacle(), 10, {}).length, 1, 'no rate: material only');
});

test('unit sell applies material markup and labour rate', () => {
  const s = unitSellCents(receptacle(), { labourRateCents: 10000, markupPct: 20 });
  assert.equal(s.materialCents, Math.round(900 * 1.2)); // 1080
  assert.equal(s.labourCents, Math.round(0.35 * 10000)); // 3500
  assert.equal(s.totalCents, 1080 + 3500);
});

test('newComponent pulls material cost from an item (cost before sell), and defaults', () => {
  assert.equal(newComponent({ id: 'i', name: 'Box', sku: 'B1', costCents: 150, priceCents: 400 }).unitCents, 150);
  assert.equal(newComponent({ id: 'i', name: 'Box', priceCents: 400 }).unitCents, 400, 'falls back to sell price');
  assert.equal(newComponent().unitCents, 0);
  assert.equal(labourUnitHours(newAssembly({})), 0);
});

test('activeAssemblies hides archived ones unless asked', () => {
  const list = [receptacle(), { ...receptacle(), id: 'old', archived: true }];
  assert.equal(activeAssemblies(list).length, 1);
  assert.equal(activeAssemblies(list, { includeArchived: true }).length, 2);
});
