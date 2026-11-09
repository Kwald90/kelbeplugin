// Generator / optional-standby sizing + ATS (lib/generator.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardKw, generatorFla, sizeGenerator, CONT_FACTOR, KW_SIZES } from '../js/lib/generator.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('standard kW rounds up to a catalogue size', () => {
  assert.equal(standardKw(33), 35);
  assert.equal(standardKw(50), 50);
  assert.ok(KW_SIZES.includes(standardKw(90)));
});

test('three-phase generator FLA uses sqrt(3)', () => {
  // 50 kW, pf 0.8 -> 62.5 kVA; /(1.732*208) = 173.5 A
  assert.ok(near(generatorFla({ kw: 50, pf: 0.8, volts: 208, phase: 3 }), 173.5, 0.5));
});

test('single-phase generator FLA is kVA/V', () => {
  // 10 kW, pf 1.0, 240 V -> 10000/240 = 41.67 A
  assert.ok(near(generatorFla({ kw: 10, pf: 1.0, volts: 240, phase: 1 }), 41.67, 0.1));
});

test('sizeGenerator picks a catalogue genset, feeder and ATS', () => {
  const r = sizeGenerator({ connectedKw: 48, pf: 0.8, volts: 208, phase: 3, material: 'cu' });
  assert.equal(r.generator.kw, 50, 'rounds 48 up to 50 kW');
  assert.ok(r.generator.fla > 0);
  assert.ok(r.feeder.designAmps > r.generator.fla, 'feeder at 125% is above FLA');
  assert.ok(r.feeder.ocpd >= r.feeder.designAmps);
  assert.ok(r.feeder.size, 'feeder conductor chosen');
  assert.ok(r.ats.rating >= r.generator.fla, 'ATS at or above generator FLA');
});

test('optional-standby demand factor reduces the required kW', () => {
  const r = sizeGenerator({ connectedKw: 100, demandPct: 75, pf: 0.8, volts: 208, phase: 3 });
  assert.equal(r.load.requiredKw, 75);
  assert.equal(r.generator.kw, 80); // 75 -> next catalogue size
});

test('largest motor adds a starting-margin warning', () => {
  const r = sizeGenerator({ connectedKw: 50, volts: 208, phase: 3, largestMotorKw: 15 });
  assert.ok(r.warnings.some((w) => /starting/.test(w)));
});

test('missing voltage or load throws', () => {
  assert.throws(() => sizeGenerator({ connectedKw: 50, phase: 3 }), /voltage/);
  assert.throws(() => sizeGenerator({ volts: 208, phase: 3 }), /load/);
});

test('continuous factor is 125%', () => {
  assert.equal(CONT_FACTOR, 1.25);
});
