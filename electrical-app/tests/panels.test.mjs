// Run: node --test electrical-app/tests/
// Panel schedule additions (S26): breaker templates, whole-panel templates, and wire-colour
// codes. These are pure-function tests; the DOM wiring in js/modules/panels.js is exercised by
// hand. Phase maths / balance stay covered by electrical.test.mjs — re-checked here against the
// template helpers so the additive feature can't change the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PT from '../js/lib/panel-templates.js';
import * as S from '../js/lib/cec/systems.js';

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
