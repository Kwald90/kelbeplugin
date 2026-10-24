// Run: node --test electrical-app/tests/
// Panel schedule additions (S26): breaker templates, whole-panel templates, and wire-colour
// codes. These are pure-function tests; the DOM wiring in js/modules/panels.js is exercised by
// hand. Phase maths / balance stay covered by electrical.test.mjs — re-checked here against the
// template helpers so the additive feature can't change the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PT from '../js/lib/panel-templates.js';
import * as S from '../js/lib/cec/systems.js';
import { occupancy, slotCount, placement, halfOf } from '../js/modules/panels.js';

// A tiny in-memory store standing in for js/store.js (settings() / saveSettings()).
function fakeStore(initial = {}) {
  let settings = { codeBook: 'CEC-2024', ...initial };
  return {
    settings: () => JSON.parse(JSON.stringify(settings)),
    saveSettings: (patch) => { settings = { ...settings, ...patch }; return settings; },
  };
}

test('breaker types enum has labels for every key', () => {
  for (const k of PT.BREAKER_TYPE_KEYS) assert.equal(typeof PT.BREAKER_TYPES[k], 'string');
  assert.ok(PT.BREAKER_TYPE_KEYS.includes('gfci'));
  assert.ok(PT.BREAKER_TYPE_KEYS.includes('dual'));
  assert.ok(PT.BREAKER_TYPE_KEYS.includes('tandem'));
  assert.equal(PT.breakerTypeLabel('afci'), 'AFCI');
  assert.equal(PT.breakerTypeLabel('nope'), 'Standard'); // falls back
});

test('built-in breaker library covers the required set', () => {
  const ids = PT.BUILT_IN_BREAKERS.map((t) => t.id);
  for (const id of ['recept-15', 'recept-20-gfci', 'light-15-afci', 'laundry-20', 'dryer-30', 'range-40', 'ev-50', 'hottub-60-gfci', 'subfeed-100', 'spare', 'space']) {
    assert.ok(ids.includes(id), `missing template ${id}`);
  }
  const dryer = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'dryer-30');
  assert.equal(dryer.poles, 2);
  const tub = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'hottub-60-gfci');
  assert.equal(tub.breakerType, 'gfci');
  assert.equal(tub.amps, 60);
  const feed = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'subfeed-100');
  assert.equal(feed.subFeed, true);
  assert.equal(feed.loadVA, null); // feeder load depends on the sub-panel
});

test('applyBreakerTemplate fills poles / amps / loadVA / description / type', () => {
  const range = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'range-40');
  const c = PT.applyBreakerTemplate(range, { slot: 5, amps: 20, loadVA: 0, poles: 1 });
  assert.equal(c.poles, 2);
  assert.equal(c.amps, 40);
  assert.equal(c.loadVA, 8000);
  assert.equal(c.description, 'Range');
  assert.equal(c.breakerType, 'standard');

  // A null-amps template (space) keeps the current amps rather than wiping it.
  const space = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'space');
  const kept = PT.applyBreakerTemplate(space, { amps: 30, loadVA: 100 });
  assert.equal(kept.amps, 30);
  assert.equal(kept.loadVA, 0); // space contributes no load

  // Sub-feed template carries the subFeed flag through.
  const feed = PT.applyBreakerTemplate(PT.BUILT_IN_BREAKERS.find((t) => t.id === 'subfeed-100'), {});
  assert.equal(feed.subFeed, true);
});

test('company-saved breaker templates round-trip through settings', () => {
  const store = fakeStore();
  assert.equal(PT.listBreakerTemplates(store.settings()).filter((t) => t.custom).length, 0);

  const id = PT.saveBreakerTemplate(store, { label: 'Shop plug', poles: 1, amps: 20, loadVA: 1800, breakerType: 'standard', descriptionDefault: 'Shop plug', group: 'Company' });
  const list = PT.listBreakerTemplates(store.settings());
  const saved = list.find((t) => t.id === id);
  assert.ok(saved && saved.custom === true);
  assert.equal(saved.amps, 20);
  // built-ins still present and marked not-custom
  assert.ok(list.some((t) => t.id === 'range-40' && t.custom === false));

  // Saving with the same id replaces, not duplicates.
  PT.saveBreakerTemplate(store, { id, label: 'Shop plug v2', poles: 1, amps: 15, loadVA: 1800 });
  const after = PT.listBreakerTemplates(store.settings()).filter((t) => t.id === id);
  assert.equal(after.length, 1);
  assert.equal(after[0].amps, 15);

  PT.removeBreakerTemplate(store, id);
  assert.equal(PT.listBreakerTemplates(store.settings()).filter((t) => t.id === id).length, 0);
  // removing a company template does not disturb a sibling custom one or the built-ins
  assert.ok(PT.listBreakerTemplates(store.settings()).some((t) => t.id === 'spare'));
});

test('panel templates: residential 200 A and commercial presets', () => {
  const store = fakeStore();
  const panels = PT.listPanelTemplates(store.settings());
  const res = panels.find((p) => p.id === 'res-200');
  assert.equal(res.voltage, '120/240 1ph');
  assert.equal(res.mainType, 'MB');
  assert.equal(res.mainAmps, 200);
  assert.equal(res.slots, 40);

  const comm = panels.find((p) => p.id === 'comm-225-208');
  assert.equal(comm.voltage, '208/120 3ph');
  assert.equal(comm.mainType, 'MLO');
  assert.equal(comm.slots, 42);

  const dist = panels.find((p) => p.id === 'comm-600-600');
  assert.equal(dist.voltage, '347/600 3ph');
  assert.equal(dist.feedThrough, true);

  // every preset names a system that exists in PANEL_SYSTEMS
  for (const p of panels) assert.ok(S.PANEL_SYSTEMS[p.voltage], `${p.id} -> unknown system ${p.voltage}`);
});

test('wire colours: CEC defaults, mandated vs convention, and NEC switch', () => {
  // CEC 120/208 3ph: A/B/C = Red/Black/Blue (convention), neutral/bond mandated.
  const cec = S.systemColours('CEC-2024', '208/120 3ph');
  assert.equal(cec.phases.A.name, 'Red');
  assert.equal(cec.phases.B.name, 'Black');
  assert.equal(cec.phases.C.name, 'Blue');
  assert.equal(cec.phases.A.mandated, false);
  assert.equal(cec.neutral.mandated, true);
  assert.equal(cec.bond.mandated, true);
  assert.match(cec.neutral.name, /white/i);
  assert.match(cec.bond.name, /green/i);

  // 120/240 1ph exposes only A and B.
  const single = S.systemColours('CEC-2024', '120/240 1ph');
  assert.deepEqual(Object.keys(single.phases), ['A', 'B']);
  assert.equal(single.phases.A.name, 'Black');
  assert.equal(single.phases.B.name, 'Red');

  // NEC 120/208: A/B/C = Black/Red/Blue.
  const nec = S.systemColours('NEC-2023', '208/120 3ph');
  assert.equal(nec.phases.A.name, 'Black');
  assert.equal(nec.phases.B.name, 'Red');
  assert.equal(nec.book, 'NEC-2023');

  // 347/600 NEC-side uses the brown/orange/yellow 600 V trade set.
  const hv = S.systemColours('NEC-2023', '347/600 3ph');
  assert.equal(hv.phases.A.name, 'Brown');
  assert.equal(hv.phases.C.name, 'Yellow');

  // unknown book falls back to CEC, not a crash.
  assert.equal(S.systemColours('XYZ', '120/240 1ph').book, 'CEC-2024');
});

test('wire colours: company override per phase and reset', () => {
  const overrides = { 'CEC-2024': { '208/120 3ph': { A: '#00ff00' }, neutral: '#cccccc' } };
  const c = S.systemColours('CEC-2024', '208/120 3ph', overrides);
  assert.equal(c.phases.A.hex, '#00ff00');
  assert.equal(c.phases.A.name, 'Custom');
  assert.equal(c.phases.B.name, 'Black'); // untouched phase keeps its default
  assert.equal(c.neutral.hex, '#cccccc');
  assert.equal(c.neutral.mandated, true); // neutral stays mandated even when recoloured

  // phaseColour helper agrees with systemColours
  assert.equal(S.phaseColour('CEC-2024', '208/120 3ph', 'A', overrides).hex, '#00ff00');

  // mandatedColours returns neutral + bond defaults for the book
  const m = S.mandatedColours('CEC-2024');
  assert.match(m.neutral.name, /white/i);
  assert.ok(m.bond.ref);
});

test('phase maths and balance unchanged by the template helpers', () => {
  // A breaker placed from the 40 A range template balances exactly as a hand-built one.
  const range = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'range-40');
  const built = PT.applyBreakerTemplate(range, { slot: 1, poles: 1, amps: 20, loadVA: 0 });
  const circuit = { ...built, slot: 1 };
  const b = S.phaseBalance([circuit], '120/240 1ph');
  // 2-pole 8000 VA split across A and B -> 4000 each
  assert.equal(b.perPhase.A, 4000);
  assert.equal(b.perPhase.B, 4000);
  assert.equal(b.totalVA, 8000);
  // the breakerType / subFeed metadata does not leak into the maths
  const withMeta = { ...circuit, breakerType: 'gfci', subFeed: true, colorOverride: 'B' };
  assert.deepEqual(S.phaseBalance([withMeta], '120/240 1ph').perPhase, b.perPhase);

  // minPoles still enforced for a no-neutral system
  assert.equal(S.minPoles('600 3ph 3w'), 2);
  assert.equal(S.minPoles('120/240 1ph'), 1);
});

// ---------------------------------------------------------------------------
// Tandem / space-saver (half-space) breakers (js/modules/panels.js pure helpers).
// A space can hold two single-pole tandems (upper A, lower B) instead of one full breaker.
// ---------------------------------------------------------------------------

test('halfOf reads the half field, defaulting full breakers to null', () => {
  assert.equal(halfOf({ slot: 1, half: 'A' }), 'A');
  assert.equal(halfOf({ slot: 1, half: 'B' }), 'B');
  assert.equal(halfOf({ slot: 1 }), null);
  assert.equal(halfOf({ slot: 1, half: 'C' }), null); // only A/B are halves
  assert.equal(halfOf({ slot: 1, half: null }), null);
});

test('occupancy tracks two halves in one space, and a full breaker beside them', () => {
  const circuits = [
    { slot: 1, half: 'A', poles: 1, loadVA: 1000, breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, loadVA: 500, breakerType: 'tandem' },
    { slot: 2, poles: 1, loadVA: 0 },
  ];
  const occ = occupancy(circuits);
  const s1 = occ.get(1);
  assert.equal(s1.full, null);
  assert.equal(s1.A.loadVA, 1000);
  assert.equal(s1.B.loadVA, 500);
  const s2 = occ.get(2);
  assert.ok(s2.full && s2.start && !s2.A && !s2.B);
});

test('occupancy: an existing panel with no half field is unchanged (backward compatible)', () => {
  // A legacy panel: one 1-pole full and one 2-pole full. No halves anywhere.
  const legacy = [{ slot: 1, poles: 1, loadVA: 1000 }, { slot: 2, poles: 2, loadVA: 4000 }];
  const occ = occupancy(legacy);
  assert.equal(halfOf(legacy[0]), null);
  const s1 = occ.get(1);
  assert.ok(s1.full && s1.start && !s1.A && !s1.B);
  const s2 = occ.get(2);
  assert.ok(s2.full && s2.start);
  const s4 = occ.get(4); // the 2-pole's second leg (continuation, not a start)
  assert.ok(s4.full && !s4.start);
});

test('placement: half/full collisions and two-tandem spaces', () => {
  const total = 24;
  // an empty space takes a first tandem (A), then the second (B)
  assert.equal(placement([], { slot: 1, half: 'A' }, total).ok, true);
  const oneHalf = [{ slot: 1, half: 'A', poles: 1 }];
  assert.equal(placement(oneHalf, { slot: 1, half: 'B' }, total).ok, true);
  // a second A in the same space clashes
  const clashA = placement(oneHalf, { slot: 1, half: 'A' }, total);
  assert.equal(clashA.ok, false);
  assert.match(clashA.reason, /tandem/i);
  // a full single where a half already sits is refused
  const fullOnHalf = placement(oneHalf, { slot: 1, poles: 1 }, total);
  assert.equal(fullOnHalf.ok, false);
  assert.match(fullOnHalf.reason, /taken/i);
  // a tandem where a full breaker sits is refused
  const occFull = [{ slot: 3, poles: 1 }];
  const tandemOnFull = placement(occFull, { slot: 3, half: 'A' }, total);
  assert.equal(tandemOnFull.ok, false);
  assert.match(tandemOnFull.reason, /full-size/i);
  // a tandem can sit in a free space
  assert.equal(placement(occFull, { slot: 5, half: 'A' }, total).ok, true);
  // a 2-pole can't land on a leg a half occupies (needs 1 & 3; 3 has a half)
  const halfAt3 = [{ slot: 3, half: 'A', poles: 1 }];
  assert.equal(placement(halfAt3, { slot: 1, poles: 2 }, total).ok, false);
  // a 2-pole past the end is refused
  assert.equal(placement([], { slot: 23, poles: 2 }, total).ok, false);
});

test('slotCount: a half takes only its own space; a full breaker still spans its poles', () => {
  // two tandems in space 1 don't push the panel past the 24-space default minimum
  assert.equal(slotCount({ circuits: [{ slot: 1, half: 'A', poles: 1 }, { slot: 1, half: 'B', poles: 1 }] }), 24);
  // a 2-pole at space 40 forces a 42-space panel, as before
  assert.equal(slotCount({ circuits: [{ slot: 40, poles: 2 }] }), 42);
  // a stored slot count is honoured verbatim
  assert.equal(slotCount({ slots: 30, circuits: [] }), 30);
});

test('both halves of a space land on the space phase and both count in phase balance', () => {
  // On 120/240, space 1 is phase A. Two tandems there are both on A.
  const circuits = [
    { slot: 1, half: 'A', poles: 1, loadVA: 1200, breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, loadVA: 800, breakerType: 'tandem' },
  ];
  for (const c of circuits) assert.equal(S.circuitPhases(c.slot, 1, '120/240 1ph'), 'A');
  const b = S.phaseBalance(circuits, '120/240 1ph');
  assert.equal(b.perPhase.A, 2000); // 1200 + 800
  assert.equal(b.perPhase.B, 0);
  assert.equal(b.totalVA, 2000);
});

test('a 2-pole breaker is never a half: phaseBalance splits it across both phases as before', () => {
  // A 2-pole 8000 VA at slot 1 occupies A and B (full spaces), split 4000/4000 — unaffected by tandems.
  const b = S.phaseBalance([{ slot: 1, poles: 2, loadVA: 8000 }], '120/240 1ph');
  assert.equal(b.perPhase.A, 4000);
  assert.equal(b.perPhase.B, 4000);
});

test('print cell derives both halves from occupancy (each half rendered on its own line)', () => {
  // The print table draws a line per half from occupancy; assert the data it reads is both halves.
  const occ = occupancy([
    { slot: 1, half: 'A', poles: 1, amps: 15, loadVA: 1000, description: 'Plugs', breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, amps: 20, loadVA: 1200, description: 'Lights', breakerType: 'tandem' },
  ]);
  const s1 = occ.get(1);
  assert.equal(s1.full, null);
  assert.equal(s1.A.description, 'Plugs');
  assert.equal(s1.A.amps, 15);
  assert.equal(s1.B.description, 'Lights');
  assert.equal(s1.B.amps, 20);
});

test('tandem templates in the built-in library carry breakerType tandem and apply as single-pole', () => {
  const t = PT.BUILT_IN_BREAKERS.find((x) => x.id === 'tandem-15');
  assert.ok(t);
  assert.equal(t.breakerType, 'tandem');
  assert.equal(t.poles, 1);
  const c = PT.applyBreakerTemplate(t, { slot: 1, poles: 1, amps: 20, loadVA: 0 });
  assert.equal(c.breakerType, 'tandem');
  assert.equal(c.amps, 15);
});
