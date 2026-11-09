// Transformer sizing, CEC Section 26 (lib/transformer.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullLoadAmps, standardKva, primaryOcpd, sizeTransformer, KVA_3PH, KVA_1PH } from '../js/lib/transformer.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('three-phase full-load amps use sqrt(3)', () => {
  // 75 kVA, 600 V, 3φ -> 75000 / (1.732*600) = 72.2 A
  assert.ok(near(fullLoadAmps({ kva: 75, volts: 600, phase: 3 }), 72.17, 0.1));
  // 75 kVA, 208 V secondary -> 208.2 A
  assert.ok(near(fullLoadAmps({ kva: 75, volts: 208, phase: 3 }), 208.2, 0.3));
});

test('single-phase full-load amps are kVA/V', () => {
  assert.ok(near(fullLoadAmps({ kva: 25, volts: 240, phase: 1 }), 104.17, 0.1));
});

test('standard kVA rounds up to a catalogue size', () => {
  assert.equal(standardKva(60, 3), 75);
  assert.equal(standardKva(112.5, 3), 112.5);
  assert.equal(standardKva(20, 1), 25);
  assert.ok(KVA_3PH.includes(standardKva(500, 3)));
  assert.ok(KVA_1PH.includes(standardKva(1, 1)));
});

test('primary OCPD is 125% to the next standard rating', () => {
  const r = primaryOcpd(72.17); // 125% = 90.2 A -> next standard 100 A
  assert.equal(r.pct, 125);
  assert.ok(near(r.maxAmps, 90.2, 0.2));
  assert.equal(r.rating, 100);
});

test('sizeTransformer from kVA gives both full-load currents and a secondary conductor', () => {
  const r = sizeTransformer({ loadKva: 70, primaryV: 600, secondaryV: 208, phase: 3 });
  assert.equal(r.kva, 75, 'rounds 70 up to 75 kVA');
  assert.ok(near(r.primaryFla, 72.17, 0.2));
  assert.ok(near(r.secondaryFla, 208.2, 0.3));
  assert.ok(r.secondary.size, 'picks a secondary conductor');
  assert.ok(r.secondary.designAmps > r.secondaryFla, 'continuous adds 25%');
  assert.ok(r.ocpd.rating >= r.primaryFla);
});

test('sizeTransformer from secondary amps back-computes kVA', () => {
  const r = sizeTransformer({ loadAmps: 200, secondaryV: 208, primaryV: 600, phase: 3 });
  // 1.732*208*200/1000 = 72.0 kVA -> 75 kVA
  assert.equal(r.kva, 75);
});

test('impedance estimate and inrush band are returned', () => {
  const r = sizeTransformer({ loadKva: 75, primaryV: 600, secondaryV: 208, phase: 3, impedancePct: 5 });
  assert.equal(r.impedance.pct, 5);
  assert.ok(r.impedance.secFaultKa > 0, 'secondary fault estimate');
  assert.ok(r.inrush.highKa > r.inrush.lowKa);
  const assumed = sizeTransformer({ loadKva: 75, primaryV: 600, secondaryV: 208, phase: 3 });
  assert.equal(assumed.impedance.assumed, true, 'flags the default impedance');
});

test('missing voltages throw', () => {
  assert.throws(() => sizeTransformer({ loadKva: 75, primaryV: 600, phase: 3 }), /voltage/);
  assert.throws(() => sizeTransformer({ primaryV: 600, secondaryV: 208, phase: 3 }), /load/);
});
