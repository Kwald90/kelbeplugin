// Arc-flash incident energy (lib/arc-flash.js): IEEE 1584-2002 empirical model + Lee method.
// These pin the equations to hand calculations so the safety-critical math can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcingCurrent, incidentEnergyEmpirical, incidentEnergyLee, arcFlash, ppeFor, EQUIPMENT, CONFIGS, DANGER_CAL } from '../js/lib/arc-flash.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('arcing current, 600 V box config, matches IEEE 1584-2002 eq. 1 by hand', () => {
  // lgIa = -0.097 + 0.662*lg20 + 0.0966*0.6 + 0.000526*32 + 0.5588*0.6*lg20 - 0.00304*32*lg20
  const r = arcingCurrent({ faultKa: 20, voltKv: 0.6, gapMm: 32, config: 'box' });
  assert.ok(near(r.arcKa, 14.09, 0.1), `arcKa ${r.arcKa}`);
});

test('arcing current at/above 1 kV is config-independent (eq. 2)', () => {
  const box = arcingCurrent({ faultKa: 20, voltKv: 4.16, gapMm: 104, config: 'box' });
  const open = arcingCurrent({ faultKa: 20, voltKv: 4.16, gapMm: 104, config: 'open' });
  assert.equal(box.arcKa, open.arcKa);
  // lgIa = 0.00402 + 0.983*lg20
  assert.ok(near(box.arcKa, 10 ** (0.00402 + 0.983 * Math.log10(20)), 1e-6));
});

test('incident energy, 600 V LV switchgear, 20 kA, 0.2 s, 610 mm ≈ 6.1 cal/cm²', () => {
  const ac = arcingCurrent({ faultKa: 20, voltKv: 0.6, gapMm: 32, config: 'box' });
  const e = incidentEnergyEmpirical({ arcKa: ac.arcKa, voltKv: 0.6, gapMm: 32, workingMm: 610, x: EQUIPMENT['lv-switchgear'].x, config: 'box', grounding: 'grounded', clearSec: 0.2 });
  assert.ok(near(e.cal, 6.1, 0.3), `cal ${e.cal}`);
});

test('incident energy scales linearly with time and with the distance exponent', () => {
  const base = { arcKa: 14, voltKv: 0.6, gapMm: 32, x: 1.473, config: 'box', grounding: 'grounded' };
  const e1 = incidentEnergyEmpirical({ ...base, workingMm: 610, clearSec: 0.2 });
  const e2 = incidentEnergyEmpirical({ ...base, workingMm: 610, clearSec: 0.4 });
  assert.ok(near(e2.cal / e1.cal, 2, 1e-6), 'doubling time doubles energy');
  const far = incidentEnergyEmpirical({ ...base, workingMm: 1220, clearSec: 0.2 });
  assert.ok(far.cal < e1.cal, 'farther = less energy');
});

test('Lee method form: E = 2.142e6 V Ibf (t/D^2), J/cm^2', () => {
  const r = incidentEnergyLee({ voltKv: 0.6, faultKa: 20, workingMm: 610, clearSec: 0.2 });
  const expectJ = 2.142e6 * 0.6 * 20 * (0.2 / (610 * 610));
  assert.ok(near(r.joules, expectJ, 1e-6));
  assert.ok(near(r.cal, expectJ / 4.184, 1e-6));
});

test('PPE bands follow CSA Z462 arc-rating breakpoints', () => {
  assert.equal(ppeFor(0.8).category, 0);
  assert.equal(ppeFor(3).category, 1);
  assert.equal(ppeFor(6).category, 2);
  assert.equal(ppeFor(20).category, 3);
  assert.equal(ppeFor(35).category, 4);
  const danger = ppeFor(DANGER_CAL + 5);
  assert.equal(danger.danger, true);
  assert.equal(danger.category, null);
});

test('arcFlash() returns a governing energy, boundary, PPE and warnings', () => {
  const r = arcFlash({ faultKa: 25, voltV: 600, equipment: 'lv-switchgear', config: 'box', grounding: 'grounded', clearSec: 0.2 });
  assert.ok(r.cal > 0 && Number.isFinite(r.cal));
  assert.ok(r.boundaryMm > 0);
  assert.ok(r.ppe.category != null || r.ppe.danger);
  assert.ok(r.warnings.some((w) => /2018/.test(w)), 'warns the 2018 model is not applied');
  assert.ok(r.arcKa > 0 && r.arcKa < 25, 'arcing current below the bolted fault');
});

test('out-of-range inputs fall back to the conservative Lee method with a warning', () => {
  const r = arcFlash({ faultKa: 20, voltV: 25000, equipment: 'mv-switchgear-15', config: 'box', grounding: 'grounded', clearSec: 0.2 });
  assert.ok(/Lee/.test(r.method));
  assert.ok(r.warnings.some((w) => /outside/.test(w)));
});

test('missing inputs throw clear errors', () => {
  assert.throws(() => arcFlash({ voltV: 600, clearSec: 0.2 }), /fault current/);
  assert.throws(() => arcFlash({ faultKa: 20, clearSec: 0.2 }), /voltage/);
  assert.throws(() => arcFlash({ faultKa: 20, voltV: 600 }), /clearing time/);
});

test('every equipment class and config has the constants the model needs', () => {
  for (const k of Object.keys(EQUIPMENT)) {
    assert.ok(EQUIPMENT[k].gapMm > 0 && EQUIPMENT[k].x > 0 && EQUIPMENT[k].workingMm > 0, k);
  }
  for (const k of Object.keys(CONFIGS)) {
    assert.ok(typeof CONFIGS[k].K === 'number' && typeof CONFIGS[k].K1 === 'number' && CONFIGS[k].Cf > 0, k);
  }
});
