// Residential must-have circuits: the reference list, its expansion into circuits, and the
// load-balanced panel layout (lib/panel-templates.js) shared by the estimate checklist and the
// panel-schedule fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residentialEssentials, expandResidentialEssentials, layoutResidentialCircuits } from '../js/lib/panel-templates.js';
import { phaseBalance, slotPhase } from '../js/lib/cec/systems.js';

test('each reference row resolves poles/amps/loadVA from a real breaker', () => {
  const rows = residentialEssentials();
  assert.ok(rows.length >= 15);
  for (const r of rows) {
    assert.ok(r.id && r.label && r.tier, `row ${r.id} is complete`);
    assert.ok(r.poles >= 1 && r.amps >= 1, `${r.id} has poles/amps`);
    assert.equal(r.defaultOn, r.tier !== 'optional');
  }
});

test('default expansion is required + recommended, numbered, no optional', () => {
  const specs = expandResidentialEssentials();
  // optional items (EV, A/C, sump) are left out by default
  assert.ok(!specs.some((s) => /EV charger|A\/C|Sump/i.test(s.description)));
  // multi-count items are numbered
  assert.ok(specs.some((s) => s.description === 'Kitchen counter plugs 1'));
  assert.ok(specs.some((s) => s.description === 'Kitchen counter plugs 2'));
  // a single-count item is not numbered
  assert.ok(specs.some((s) => s.description === 'Laundry'));
  // the general-receptacle circuits carry the AFCI override
  assert.ok(specs.filter((s) => /General receptacles/.test(s.description)).every((s) => s.breakerType === 'afci'));
});

test('selecting ids includes exactly those (optional included on request)', () => {
  const specs = expandResidentialEssentials(['ev', 'laundry']);
  assert.equal(specs.length, 2);
  assert.ok(specs.some((s) => /EV charger/.test(s.description)));
  assert.ok(specs.some((s) => s.description === 'Laundry'));
});

test('layout fills real slots with no two circuits in the same slot', () => {
  const placed = layoutResidentialCircuits(expandResidentialEssentials(), { system: '120/240 1ph', slots: 40 });
  const slots = placed.map((c) => c.slot);
  assert.equal(new Set(slots).size, slots.length, 'no duplicate slots');
  // a 2-pole also implicitly occupies slot+2, which must not be taken by anything else
  const taken = new Set(slots);
  for (const c of placed.filter((c) => c.poles >= 2)) {
    assert.ok(!taken.has(c.slot + 2), `2-pole at ${c.slot} leaves ${c.slot + 2} free for its second pole`);
  }
  assert.ok(placed.every((c) => c.slot >= 1 && c.slot <= 40));
});

test('layout drops what will not fit a small panel, never overflows', () => {
  const placed = layoutResidentialCircuits(expandResidentialEssentials(), { system: '120/240 1ph', slots: 12 });
  assert.ok(placed.every((c) => c.slot >= 1 && c.slot <= 12 && c.slot + (c.poles >= 2 ? 2 : 0) <= 12));
  const slots = placed.map((c) => c.slot);
  assert.equal(new Set(slots).size, slots.length);
});

test('layout leaves occupied slots alone (fills around existing breakers)', () => {
  const occupied = [1, 2, 3, 4];
  const placed = layoutResidentialCircuits(expandResidentialEssentials(), { system: '120/240 1ph', slots: 40, occupied });
  for (const c of placed) {
    assert.ok(!occupied.includes(c.slot), `nothing placed in occupied slot ${c.slot}`);
    if (c.poles >= 2) assert.ok(!occupied.includes(c.slot + 2), `2-pole second pole ${c.slot + 2} not in an occupied slot`);
  }
});

test('layout keeps the panel well balanced (imbalance under 10%)', () => {
  const placed = layoutResidentialCircuits(expandResidentialEssentials(), { system: '120/240 1ph', slots: 40 });
  // stamp phases the way the panel editor does, then measure
  const withPhase = placed.map((c) => ({ ...c, phase: Array.from({ length: c.poles }, (_, k) => slotPhase(c.slot + 2 * k, '120/240 1ph')).join('-') }));
  const bal = phaseBalance(withPhase, '120/240 1ph');
  assert.ok(bal.imbalancePct < 10, `imbalance ${bal.imbalancePct.toFixed(1)}% should be under 10%`);
});
