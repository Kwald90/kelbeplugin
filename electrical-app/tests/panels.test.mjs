// Run: node --test electrical-app/tests/
// Panel schedule additions (S26): breaker templates, whole-panel templates, and wire-colour
// codes. These are pure-function tests; the DOM wiring in js/modules/panels.js is exercised by
// hand. Phase maths / balance stay covered by electrical.test.mjs — re-checked here against the
// template helpers so the additive feature can't change the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PT from '../js/lib/panel-templates.js';
import * as S from '../js/lib/cec/systems.js';
import { occupancy, slotCount, placement, halfOf, isQuadInner, quadCircuits, bandIndexBySlot, completion, makeFullSpace, highlightFor, panelPrintSettings, PANEL_PRINT_DEFAULTS, PANEL_STATUSES, phaseBandClass, bandTextColor, panelTitleblock, PANEL_PRINT_TABLE_CLASS } from '../js/modules/panels.js';
import { panelUrl, qrSvg, qrMatrix } from '../js/lib/qr.js';
import { BRAND } from '../js/brand.js';

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

// ---------------------------------------------------------------------------
// Quad / space-saver (Eaton quad): one device = two outer single-pole breakers plus one inner
// handle-tied 2-pole across two adjacent spaces. The inner 2-pole is a half-space circuit with
// poles=2: it sits in this space's lower half ('B') and the next space's upper half ('A'); the
// two outer halves (this space's 'A', the next space's 'B') stay free for single-pole breakers.
// ---------------------------------------------------------------------------

test('isQuadInner: a B half with 2 poles is a quad inner; tandems and full breakers are not', () => {
  assert.equal(isQuadInner({ slot: 5, half: 'B', poles: 2 }), true);
  assert.equal(isQuadInner({ slot: 5, half: 'B', poles: 1 }), false); // normal tandem
  assert.equal(isQuadInner({ slot: 5, half: 'A', poles: 2 }), false); // inner always starts in the lower half
  assert.equal(isQuadInner({ slot: 5, poles: 2 }), false);            // full 2-pole
  assert.equal(isQuadInner({ slot: 5 }), false);
});

test('occupancy: a quad inner fills this space B and the next space A; outer singles sit in the outer halves', () => {
  // Quad at spaces 5 & 7: 5A single, inner 2-pole in 5B + 7A, 7B single.
  const inner = { slot: 5, half: 'B', poles: 2, loadVA: 5760, breakerType: 'standard' };
  const circuits = [
    { slot: 5, half: 'A', poles: 1, loadVA: 1440, breakerType: 'gfci' },
    inner,
    { slot: 7, half: 'B', poles: 1, loadVA: 800, breakerType: 'tandem' },
  ];
  const occ = occupancy(circuits);
  const s5 = occ.get(5), s7 = occ.get(7);
  assert.equal(s5.full, null);
  assert.equal(s5.A.breakerType, 'gfci');     // outer single
  assert.equal(s5.B, inner);                   // inner home
  assert.equal(s7.A, inner);                   // inner reaches into 7A (same object)
  assert.equal(s7.B.breakerType, 'tandem');    // outer single
  // the inner is the same object in both halves it occupies
  assert.ok(s5.B === s7.A);
});

test('slotCount / span: a quad inner reaches the next space down', () => {
  // A quad inner at the bottom pushes the panel to include the next space.
  assert.equal(slotCount({ circuits: [{ slot: 39, half: 'B', poles: 2 }] }), 42); // spans to 41 -> 42-space panel
  // but a normal tandem at 39 does not grow the panel the same way
  assert.equal(slotCount({ circuits: [{ slot: 39, half: 'B', poles: 1 }] }), 40);
});

test('placement: a quad goes in free inner halves and refuses every collision', () => {
  const total = 24;
  // empty: a quad at 5 is fine (needs all four halves: 5A + 5B/7A + 7B)
  assert.equal(placement([], { slot: 5, half: 'B', poles: 2 }, total).ok, true);
  // a quad now creates its own outer singles too, so it owns all four halves: refuse if an outer is taken
  const outerA = [{ slot: 5, half: 'A', poles: 1 }];
  const rOuterA = placement(outerA, { slot: 5, half: 'B', poles: 2 }, total);
  assert.equal(rOuterA.ok, false);
  assert.match(rOuterA.reason, /5A|quad/i);
  const outerB = [{ slot: 7, half: 'B', poles: 1 }];
  const rOuterB = placement(outerB, { slot: 5, half: 'B', poles: 2 }, total);
  assert.equal(rOuterB.ok, false);
  assert.match(rOuterB.reason, /7B|quad/i);
  // refuse when this space's B half is taken
  const bTaken = [{ slot: 5, half: 'B', poles: 1 }];
  assert.equal(placement(bTaken, { slot: 5, half: 'B', poles: 2 }, total).ok, false);
  // refuse when the next space's A half is taken
  const aNextTaken = [{ slot: 7, half: 'A', poles: 1 }];
  const r = placement(aNextTaken, { slot: 5, half: 'B', poles: 2 }, total);
  assert.equal(r.ok, false);
  assert.match(r.reason, /7A|quad/i);
  // refuse when a full breaker sits in either space
  assert.equal(placement([{ slot: 5, poles: 1 }], { slot: 5, half: 'B', poles: 2 }, total).ok, false);
  assert.equal(placement([{ slot: 7, poles: 1 }], { slot: 5, half: 'B', poles: 2 }, total).ok, false);
  // refuse past the end of the panel
  assert.equal(placement([], { slot: 23, half: 'B', poles: 2 }, total).ok, false);
  // refuse an inner asked for the upper half (the inner always starts in the lower half)
  assert.equal(placement([], { slot: 5, half: 'A', poles: 2 }, total).ok, false);
});

test('placement: a full breaker is refused where a quad inner already sits', () => {
  const total = 24;
  const quad = [{ slot: 5, half: 'B', poles: 2 }]; // fills 5B + 7A
  // a full 1-pole at 5 clashes with 5B
  assert.equal(placement(quad, { slot: 5, poles: 1 }, total).ok, false);
  // a full 2-pole at 5 (needs 5 & 7) clashes
  assert.equal(placement(quad, { slot: 5, poles: 2 }, total).ok, false);
  // a full 1-pole at 7 clashes with 7A
  assert.equal(placement(quad, { slot: 7, poles: 1 }, total).ok, false);
  // a tandem in the still-free outer halves is allowed
  assert.equal(placement(quad, { slot: 5, half: 'A' }, total).ok, true);
  assert.equal(placement(quad, { slot: 7, half: 'B' }, total).ok, true);
  // but a tandem in the inner halves is refused
  assert.equal(placement(quad, { slot: 5, half: 'B' }, total).ok, false);
  assert.equal(placement(quad, { slot: 7, half: 'A' }, total).ok, false);
});

test('makeFullSpace: a quad inner becomes a full 2-pole only when the outer halves are empty', () => {
  // lone quad inner (no outer singles) -> full 2-pole at the same slot, poles kept at 2
  const alone = [{ slot: 5, half: 'B', poles: 2, breakerType: 'standard' }];
  assert.equal(makeFullSpace(alone, alone[0]), true);
  assert.equal(halfOf(alone[0]), null);
  assert.equal(alone[0].poles, 2);
  // with an outer single present, conversion is refused
  const withOuter = [{ slot: 5, half: 'A', poles: 1 }, { slot: 5, half: 'B', poles: 2 }];
  assert.equal(makeFullSpace(withOuter, withOuter[1]), false);
  assert.equal(isQuadInner(withOuter[1]), true);
  // an outer single on the next space's B half also blocks it
  const withNextOuter = [{ slot: 5, half: 'B', poles: 2 }, { slot: 7, half: 'B', poles: 1 }];
  assert.equal(makeFullSpace(withNextOuter, withNextOuter[0]), false);
});

test('grid render-sanity: the quad home half shows fields, the reached half is a continuation', () => {
  // The grid decides home vs continuation by isQuadInner(hc) && hc.slot !== slot. Assert that logic
  // against the occupancy it reads, so the inner's amp/type/desc render exactly once.
  const inner = { slot: 5, half: 'B', poles: 2 };
  const occ = occupancy([inner]);
  // at space 5, the B half is the inner's home (slot matches) -> fields
  assert.ok(isQuadInner(occ.get(5).B) && occ.get(5).B.slot === 5);
  // at space 7, the A half is the inner reaching down (slot differs) -> continuation
  assert.ok(isQuadInner(occ.get(7).A) && occ.get(7).A.slot !== 7);
});

test('backward compatible: a panel with tandems but no quads is unchanged', () => {
  // Two ordinary tandems in one space: both single-pole, no reach into the next space.
  const circuits = [
    { slot: 1, half: 'A', poles: 1, loadVA: 1000, breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, loadVA: 500, breakerType: 'tandem' },
  ];
  assert.equal(isQuadInner(circuits[1]), false);
  const occ = occupancy(circuits);
  assert.equal(occ.get(1).A.loadVA, 1000);
  assert.equal(occ.get(1).B.loadVA, 500);
  assert.equal(occ.get(3), undefined); // nothing reaches into space 3
  // a legacy full 2-pole is still a full breaker, never a quad
  assert.equal(isQuadInner({ slot: 2, poles: 2 }), false);
});

test('quad built-in template places the inner 2-pole (poles 2, marked quad)', () => {
  const q = PT.BUILT_IN_BREAKERS.find((t) => t.id === 'quad-30');
  assert.ok(q);
  assert.equal(q.quad, true);
  assert.equal(q.poles, 2);
  assert.equal(q.amps, 30);
  // applying it yields a 2-pole the editor then stamps with half 'B'
  const c = PT.applyBreakerTemplate(q, { slot: 5, poles: 1, amps: 20, loadVA: 0 });
  assert.equal(c.poles, 2);
  assert.equal(c.breakerType, 'standard');
});

test('quadCircuits: placing a quad makes exactly three circuits — single / 2-pole / single', () => {
  const q = quadCircuits(5);
  assert.equal(q.length, 3);
  const [top, inner, bottom] = q;
  // top outer single: this space's upper half, 1-pole
  assert.equal(top.slot, 5);
  assert.equal(top.half, 'A');
  assert.equal(top.poles, 1);
  assert.notEqual(top.breakerType, 'quad');
  // inner handle-tied 2-pole: this space's lower half, poles 2, typed 'quad' (NOT a tandem)
  assert.equal(inner.slot, 5);
  assert.equal(inner.half, 'B');
  assert.equal(inner.poles, 2);
  assert.equal(inner.breakerType, 'quad');
  assert.notEqual(inner.breakerType, 'tandem');
  assert.equal(isQuadInner(inner), true);
  // bottom outer single: the next space's lower half, 1-pole
  assert.equal(bottom.slot, 7);
  assert.equal(bottom.half, 'B');
  assert.equal(bottom.poles, 1);
  assert.notEqual(bottom.breakerType, 'quad');
  // exactly two 1-pole singles and one 2-pole
  assert.equal(q.filter((c) => Number(c.poles) === 1).length, 2);
  assert.equal(q.filter((c) => Number(c.poles) === 2).length, 1);
});

test('a placed quad occupies the four half-positions and refuses collisions', () => {
  const total = 24;
  const q = quadCircuits(5); // 5A single, 5B/7A inner 2-pole, 7B single
  const occ = occupancy(q);
  const s5 = occ.get(5), s7 = occ.get(7);
  assert.equal(s5.full, null);
  assert.equal(s5.A, q[0]);       // top single
  assert.equal(s5.B, q[1]);       // inner home
  assert.equal(s7.A, q[1]);       // inner reaches down (same object)
  assert.equal(s7.B, q[2]);       // bottom single
  assert.ok(s5.B === s7.A);
  // the inner's two halves are refused to any further breaker
  assert.equal(placement(q, { slot: 5, half: 'B' }, total).ok, false);
  assert.equal(placement(q, { slot: 7, half: 'A' }, total).ok, false);
  // a full breaker can't go into either of the quad's spaces
  assert.equal(placement(q, { slot: 5, poles: 1 }, total).ok, false);
  assert.equal(placement(q, { slot: 7, poles: 1 }, total).ok, false);
  assert.equal(placement(q, { slot: 5, poles: 2 }, total).ok, false);
});

test('a NEW quad is refused over an occupied outer half (no silent overwrite)', () => {
  // Regression: a quad now creates THREE breakers filling all four halves (top single 5A, inner
  // 2-pole 5B/7A, bottom single 7B). If any outer half is already taken, placing the quad there
  // would push a blank single onto the same half and occupancy() would keep only the last — the
  // pre-existing breaker would vanish from the grid/print while still living in the saved data.
  // placement() must refuse so addQuad()/placeTemplate() never overwrite it.
  const total = 24;
  // (1) a tandem already in the TOP outer half (5A): a quad at 5 is refused
  const topTaken = [{ slot: 5, half: 'A', poles: 1, description: 'Hall lights', breakerType: 'tandem' }];
  const r1 = placement(topTaken, { slot: 5, half: 'B', poles: 2 }, total);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /5A|quad/i);
  // (2) a tandem already in the BOTTOM outer half (7B): a quad at 5 is refused
  const bottomTaken = [{ slot: 7, half: 'B', poles: 1, description: 'Existing bathroom', breakerType: 'tandem' }];
  const r2 = placement(bottomTaken, { slot: 5, half: 'B', poles: 2 }, total);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /7B|quad/i);
  // the pre-existing breaker is untouched (placement is pure — it never mutates)
  assert.equal(topTaken.length, 1);
  assert.equal(bottomTaken.length, 1);
});

test('a placed quad splits phases: each outer single on its space phase, inner across both (240 V)', () => {
  // On 120/240, space 5 is phase A and space 7 is phase B.
  const q = quadCircuits(5).map((c) => ({ ...c, loadVA: c.poles === 2 ? 5760 : 1200 }));
  // phases of each circuit
  assert.equal(S.circuitPhases(q[0].slot, 1, '120/240 1ph'), 'A');  // top single -> A
  assert.equal(S.circuitPhases(q[1].slot, 2, '120/240 1ph'), 'A-B'); // inner 2-pole -> A-B
  assert.equal(S.circuitPhases(q[2].slot, 1, '120/240 1ph'), 'B');  // bottom single -> B
  const b = S.phaseBalance(q, '120/240 1ph');
  // A: top single 1200 + half the inner 5760/2=2880 = 4080; B: bottom 1200 + 2880 = 4080
  assert.equal(b.perPhase.A, 1200 + 2880);
  assert.equal(b.perPhase.B, 1200 + 2880);
  assert.equal(b.totalVA, 1200 + 5760 + 1200);
});

test('a quad inner selects as a real 2-pole, never a tandem; quad is not a dropdown construction type', () => {
  // The grid/options type dropdowns offer CONSTRUCTION_TYPE_KEYS, which excludes 'quad' but keeps 'tandem'.
  assert.ok(PT.CONSTRUCTION_TYPE_KEYS.includes('tandem'));
  assert.ok(!PT.CONSTRUCTION_TYPE_KEYS.includes('quad'));
  // 'quad' is a known type with its own label, shown as a fixed 2-pole label.
  assert.equal(PT.breakerTypeLabel('quad'), 'Quad 2-pole (space-saver)');
  assert.ok(PT.BREAKER_TYPE_KEYS.includes('quad'));
});

test('backward compat: a legacy quad inner typed standard is still recognised as a 2-pole quad', () => {
  // Panels saved before the 'quad' type used breakerType 'standard' on the inner; geometry still rules.
  const legacy = { slot: 5, half: 'B', poles: 2, breakerType: 'standard' };
  assert.equal(isQuadInner(legacy), true);
  const occ = occupancy([legacy]);
  assert.equal(occ.get(7).A, legacy);
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

// ---------------------------------------------------------------------------
// Panel-print build (S27): colour bands, smoke/purpose highlight, status +
// completion, the breaker-size toggle, the offline QR deep link, and the
// tandem "make full-space" follow-up.
// ---------------------------------------------------------------------------

test('bandIndexBySlot alternates a band per breaker, down each column', () => {
  // Left column (odd): a 1-pole at 1, a 2-pole at 3 (spans 3 & 5), a 1-pole at 7.
  const circuits = [
    { slot: 1, poles: 1 },
    { slot: 3, poles: 2 },
    { slot: 7, poles: 1 },
  ];
  const band = bandIndexBySlot(circuits, 8);
  assert.equal(band.get(3), band.get(5), 'a multi-pole breaker is a single band');
  assert.notEqual(band.get(1), band.get(3), 'next breaker alternates');
  assert.notEqual(band.get(3), band.get(7), 'next breaker alternates again');
  for (const v of band.values()) assert.ok(v === 0 || v === 1);
});

test('bandIndexBySlot: two tandems in one space share the space band', () => {
  const circuits = [
    { slot: 1, half: 'A', poles: 1, breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, breakerType: 'tandem' },
    { slot: 3, poles: 1 },
  ];
  const band = bandIndexBySlot(circuits, 6);
  assert.notEqual(band.get(1), band.get(3));
});

test('bandIndexBySlot runs odd and even columns independently', () => {
  const band = bandIndexBySlot([{ slot: 1, poles: 1 }, { slot: 2, poles: 1 }], 4);
  assert.equal(band.get(1), 0);
  assert.equal(band.get(2), 0);
});

test('completion counts done over described circuits', () => {
  const panel = { circuits: [
    { slot: 1, description: 'Plugs', status: 'done' },
    { slot: 2, description: 'Lights', status: 'rough-in' },
    { slot: 3, description: 'Range', status: 'done' },
    { slot: 4, description: '', status: '' },
    { slot: 5, description: 'Spare' },
  ] };
  const c = completion(panel);
  assert.equal(c.described, 4);
  assert.equal(c.done, 2);
  assert.equal(c.pct, 50);
  assert.equal(c.tracked, 3);
});

test('completion is 0% with nothing described, 100% when every described circuit is done', () => {
  assert.equal(completion({ circuits: [] }).pct, 0);
  assert.equal(completion({ circuits: [{ slot: 1, description: 'A', status: 'done' }] }).pct, 100);
  assert.equal(completion({}).described, 0);
});

test('highlightFor: smoke / alarm purpose highlights red by default, editable, suppressible', () => {
  const pp = PANEL_PRINT_DEFAULTS;
  assert.equal(highlightFor({ purpose: 'smoke' }, pp), pp.smokeColor);
  assert.equal(highlightFor({ purpose: 'alarm' }, pp), pp.smokeColor);
  assert.equal(highlightFor({ purpose: 'Smoke detectors' }, pp), pp.smokeColor);
  assert.equal(highlightFor({ purpose: 'lighting' }, pp), null);
  assert.equal(highlightFor({ purpose: 'smoke', colorOverride: '#00ff00' }, pp), '#00ff00');
  assert.equal(highlightFor({ purpose: 'smoke', colorOverride: 'none' }, pp), null);
  assert.equal(highlightFor({ colorOverride: 'A' }, pp), null);
  assert.equal(highlightFor({}, pp), null);
});

test('highlightFor uses the company smoke colour from settings', () => {
  const pp = panelPrintSettings({ panelPrint: { smokeColor: '#123456' } });
  assert.equal(highlightFor({ purpose: 'smoke' }, pp), '#123456');
});

test('panelPrintSettings merges onto defaults and validates (breaker-size toggle included)', () => {
  const d = panelPrintSettings({});
  assert.deepEqual(d.bandColors, PANEL_PRINT_DEFAULTS.bandColors);
  assert.equal(d.showAmps, true);
  assert.equal(d.showStatus, false);
  const pp = panelPrintSettings({ panelPrint: { showAmps: false, showStatus: true, bandColors: ['#aabbcc', 'not-a-colour'], smokeColor: 'bad' } });
  assert.equal(pp.showAmps, false);
  assert.equal(pp.showStatus, true);
  assert.equal(pp.bandColors[0], '#aabbcc');
  assert.equal(pp.bandColors[1], PANEL_PRINT_DEFAULTS.bandColors[1]);
  assert.equal(pp.smokeColor, PANEL_PRINT_DEFAULTS.smokeColor);
});

test('PANEL_STATUSES is the fill-as-you-go vocabulary', () => {
  assert.deepEqual(PANEL_STATUSES.map((s) => s.key), ['planned', 'rough-in', 'connected', 'tested', 'done']);
});

test('makeFullSpace converts a lone tandem back to a full breaker, clearing half', () => {
  const circuits = [{ slot: 1, half: 'A', poles: 1, breakerType: 'tandem', amps: 15 }];
  assert.equal(makeFullSpace(circuits, circuits[0]), true);
  assert.equal(halfOf(circuits[0]), null);
  assert.equal(circuits[0].breakerType, 'standard');
});

test('makeFullSpace refuses when the sibling half is occupied, or when not a half', () => {
  const circuits = [
    { slot: 1, half: 'A', poles: 1, breakerType: 'tandem' },
    { slot: 1, half: 'B', poles: 1, breakerType: 'tandem' },
  ];
  assert.equal(makeFullSpace(circuits, circuits[0]), false);
  assert.equal(halfOf(circuits[0]), 'A');
  assert.equal(makeFullSpace([{ slot: 2, poles: 1 }], { slot: 2, poles: 1 }), false);
});

test('panelUrl is the canonical deep link to a panel (appOrigin + hash route)', () => {
  assert.equal(panelUrl({ id: 'abc123' }, 'https://app.fishtapehq.com'), 'https://app.fishtapehq.com/#/panels/abc123');
  assert.equal(panelUrl('xy-9', 'https://app.fishtapehq.com/'), 'https://app.fishtapehq.com/#/panels/xy-9');
  assert.ok(panelUrl({ id: 'p1' }).startsWith(BRAND.appOrigin + '/#/panels/p1'));
});

// ---------------------------------------------------------------------------
// Circuit-name type-ahead: a company-managed list bound to a native <datalist> on the description
// input (CSP-safe, offline). Default list when unset; the company's own list once set.
// ---------------------------------------------------------------------------

test('panelCircuitNames: ships the default list when unset', () => {
  const names = PT.panelCircuitNames({});
  assert.deepEqual(names, PT.DEFAULT_CIRCUIT_NAMES); // the default list verbatim (already unique)
  assert.ok(names.length >= 30);
  assert.ok(names.includes('Kitchen plugs'));
  assert.ok(names.includes('EV charger'));
  assert.ok(names.includes('Spare'));
  // same when the setting is missing or not an array
  assert.deepEqual(PT.panelCircuitNames(undefined), names);
  assert.deepEqual(PT.panelCircuitNames({ panelCircuitNames: 'nope' }), names);
  assert.deepEqual(PT.panelCircuitNames({ panelCircuitNames: [] }), names); // empty list falls back to default
});

test('panelCircuitNames: uses the company list when set, trimmed and de-duplicated', () => {
  const names = PT.panelCircuitNames({ panelCircuitNames: ['  Shop plugs  ', 'Welder', 'shop plugs', '', '  ', 'Welder'] });
  assert.deepEqual(names, ['Shop plugs', 'Welder']); // trimmed, case-insensitive dedupe, blanks dropped
  // a single-entry company list is honoured (not merged with defaults)
  assert.deepEqual(PT.panelCircuitNames({ panelCircuitNames: ['Only this'] }), ['Only this']);
});

// ---------------------------------------------------------------------------
// Engineered-schedule print redesign: a boxed titleblock, phase colour BANDS on the CCT cells
// (a class the CSS colours from the company palette — never a per-cell inline colour), and a dense
// table. These are the pure building blocks drawPrint() renders; the DOM wiring is proven by the
// headless-Chrome render in the task, and these assert the contract the DOM is built from.
// ---------------------------------------------------------------------------

test('panelTitleblock gives the boxed PANEL NAME / PANEL LOCATION cells and the service line', () => {
  const tb = panelTitleblock({ name: 'LP-2', location: 'Mechanical room' }, '120/240 V · 200 A · 1φ');
  assert.equal(tb.length, 3);
  assert.equal(tb[0].label, 'PANEL NAME');
  assert.equal(tb[0].value, 'LP-2');
  assert.equal(tb[1].label, 'PANEL LOCATION');
  assert.equal(tb[1].value, 'Mechanical room');
  assert.equal(tb[2].service, '120/240 V · 200 A · 1φ');
  assert.equal(tb[2].label, undefined); // the service row is not a label/value row
  // a missing name or location falls back to a dash, so a titleblock cell is never blank
  const empty = panelTitleblock({}, '');
  assert.equal(empty[0].value, '—');
  assert.equal(empty[1].value, '—');
  assert.equal(empty[2].service, '');
});

test('phaseBandClass puts a circuit cell on its phase band by CLASS (not an inline colour)', () => {
  assert.equal(phaseBandClass('A'), 'pp-ph-A');
  assert.equal(phaseBandClass('B'), 'pp-ph-B');
  assert.equal(phaseBandClass('C'), 'pp-ph-C');
  // On 120/240 the panel phases alternate by row, so the band alternates straight down the column.
  assert.equal(phaseBandClass(S.slotPhase(1, '120/240 1ph')), 'pp-ph-A'); // row 1
  assert.equal(phaseBandClass(S.slotPhase(3, '120/240 1ph')), 'pp-ph-B'); // row 2
  assert.equal(phaseBandClass(S.slotPhase(5, '120/240 1ph')), 'pp-ph-A'); // row 3
  assert.notEqual(phaseBandClass(S.slotPhase(1, '120/240 1ph')), phaseBandClass(S.slotPhase(3, '120/240 1ph')));
});

test('bandTextColor keeps the CCT number legible on its band (white on dark/red, dark on light)', () => {
  assert.equal(bandTextColor('#000000'), '#ffffff'); // black phase leg
  assert.equal(bandTextColor('#e2231a'), '#ffffff'); // red phase leg
  assert.equal(bandTextColor('#2563eb'), '#ffffff'); // blue phase leg
  assert.equal(bandTextColor('#ffffff'), '#111111'); // white
  assert.equal(bandTextColor('#eef2f7'), '#111111'); // light grey
  assert.equal(bandTextColor('not-a-colour'), '#111111'); // invalid -> safe default
  // agrees for the CEC 120/240 default legs (A black -> white text, B red -> white text)
  const single = S.systemColours('CEC-2024', '120/240 1ph');
  assert.equal(bandTextColor(single.phases.A.hex), '#ffffff');
  assert.equal(bandTextColor(single.phases.B.hex), '#ffffff');
});

test('the printed directory table carries the dense engineered-schedule class', () => {
  const classes = PANEL_PRINT_TABLE_CLASS.split(/\s+/);
  assert.ok(classes.includes('panel-print-table'));
  assert.ok(classes.includes('pp-dense'));
});

test('qrMatrix encodes text offline into a square module grid', () => {
  const m = qrMatrix('https://app.fishtapehq.com/#/panels/p1');
  assert.ok(m.count >= 21 && m.count % 2 === 1, 'a QR is an odd NxN grid, at least version 1 (21)');
  assert.equal(m.modules.length, m.count);
  assert.equal(m.modules[0].length, m.count);
  assert.equal(m.isDark(0, 0), true);
  assert.equal(m.modules[0][0], true);
});

test('qrSvg renders inline SVG with no script, eval, style attribute or external resource', () => {
  const svg = qrSvg('https://app.fishtapehq.com/#/panels/p1', { label: 'Open panel' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.includes('viewBox'));
  assert.ok(svg.includes('<path'));
  assert.ok(/role="img"/.test(svg));
  assert.ok(!/style=/.test(svg), 'no inline style attribute (CSP)');
  assert.ok(!/<script/i.test(svg), 'no script');
  assert.ok(!/on[a-z]+=/i.test(svg), 'no inline event handlers');
});
