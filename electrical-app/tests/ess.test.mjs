// Battery energy storage (ESS) basics (lib/ess.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableKwh, nominalKwh, sizeEss, CONT_FACTOR } from '../js/lib/ess.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('usable energy is load kW x hours', () => {
  assert.equal(usableKwh({ loadKw: 5, hours: 8 }), 40);
});

test('nominal capacity divides by depth of discharge and derate', () => {
  // 40 kWh usable at 90% DoD, 100% derate -> 44.44 kWh
  assert.ok(near(nominalKwh({ loadKw: 5, hours: 8, dodPct: 90, deratePct: 100 }), 44.44, 0.01));
  // add a 95% round-trip derate -> 46.78 kWh
  assert.ok(near(nominalKwh({ loadKw: 5, hours: 8, dodPct: 90, deratePct: 95 }), 46.78, 0.02));
});

test('sizeEss returns energy, AC and DC sizing', () => {
  const r = sizeEss({ loadKw: 5, hours: 8, dodPct: 90, inverterKw: 6, acVolts: 240, acPhase: 1, dcVolts: 48, material: 'cu' });
  assert.equal(r.energy.usableKwh, 40);
  assert.ok(r.energy.nominalKwh > 40, 'nominal is larger than usable');
  // AC: 6000/240 = 25 A continuous; x1.25 = 31.25 design
  assert.ok(near(r.ac.continuousAmps, 25, 1e-9));
  assert.ok(near(r.ac.designAmps, 31.25, 1e-9));
  assert.ok(r.ac.ocpd >= 31.25);
  assert.ok(r.ac.size, 'AC conductor chosen');
  // DC: 6000/48 = 125 A continuous; x1.25 = 156.25 design
  assert.ok(near(r.dc.continuousAmps, 125, 1e-9));
  assert.ok(near(r.dc.designAmps, 156.25, 1e-9));
  assert.ok(r.dc.ocpd >= 156.25);
  assert.ok(r.dc.size, 'DC conductor chosen');
});

test('inverter kW defaults to the backup load', () => {
  const r = sizeEss({ loadKw: 5, hours: 4, acVolts: 240, acPhase: 1 });
  assert.equal(r.ac.inverterKw, 5);
});

test('default DoD is 90% when not given', () => {
  const r = sizeEss({ loadKw: 5, hours: 8, acVolts: 240 });
  assert.equal(r.energy.dodPct, 90);
});

test('missing load or hours throws', () => {
  assert.throws(() => sizeEss({ hours: 8, acVolts: 240 }), /load/);
  assert.throws(() => sizeEss({ loadKw: 5, acVolts: 240 }), /time|hours/);
});

test('continuous factor is 125%', () => {
  assert.equal(CONT_FACTOR, 1.25);
});
