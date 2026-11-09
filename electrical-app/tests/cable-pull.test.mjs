// Cable-pulling tension and sidewall pressure (lib/cable-pull.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { straightTension, bendTension, sidewallPressure, maxTension, pull, LBF_PER_N, FT_PER_M, CMIL_PER_MM2 } from '../js/lib/cable-pull.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('straight horizontal tension is w*L*mu plus incoming', () => {
  // 10 N/m, 30 m, mu 0.5 -> 150 N
  assert.ok(near(straightTension({ tensionInN: 0, weightNPerM: 10, lengthM: 30, mu: 0.5 }), 150, 1e-6));
  assert.ok(near(straightTension({ tensionInN: 50, weightNPerM: 10, lengthM: 30, mu: 0.5 }), 200, 1e-6));
});

test('incline adds the sin component', () => {
  const flat = straightTension({ weightNPerM: 10, lengthM: 10, mu: 0.3, inclineDeg: 0 });
  const up = straightTension({ weightNPerM: 10, lengthM: 10, mu: 0.3, inclineDeg: 90 });
  // 90 deg: mu*cos=0, sin=1 -> w*L = 100 N
  assert.ok(near(up, 100, 1e-6));
  assert.ok(up > flat);
});

test('bend multiplies tension by e^(mu*alpha) (capstan)', () => {
  // 90 deg = pi/2 rad, mu 0.5 -> factor e^(0.5*1.5708) = e^0.7854 = 2.193
  const r = bendTension({ tensionInN: 100, mu: 0.5, bendDeg: 90 });
  assert.ok(near(r, 100 * Math.exp(0.5 * Math.PI / 2), 1e-6));
  assert.ok(near(r, 219.3, 0.5));
});

test('sidewall pressure is tension(lbf) / radius(ft)', () => {
  // 1000 N out, 0.3 m radius -> 1000*0.224809 lbf / (0.3*3.28084 ft)
  const swbp = sidewallPressure({ tensionOutN: 1000, radiusM: 0.3 });
  assert.ok(near(swbp, (1000 * LBF_PER_N) / (0.3 * FT_PER_M), 1e-6));
});

test('max tension is 0.008 lbf/cmil for copper, 0.006 for aluminium', () => {
  const cu = maxTension({ areaMm2: 107.2, conductors: 3, material: 'cu' }); // 4/0
  const expect = 0.008 * 3 * (107.2 * CMIL_PER_MM2);
  assert.ok(near(cu.lbf, expect, 1e-3));
  const al = maxTension({ areaMm2: 107.2, conductors: 3, material: 'al' });
  assert.ok(al.lbf < cu.lbf);
});

test('pull() flags a tension or sidewall-pressure failure', () => {
  // a hard pull: heavy, long, high friction, a 90 deg bend on a tight radius
  const r = pull({ weightNPerM: 30, lengthM: 100, mu: 0.5, bendDeg: 90, radiusM: 0.2, areaMm2: 107.2, conductors: 3, material: 'cu', swbpLimitLbfFt: 500 });
  assert.ok(r.tensionAfterBendN > r.tensionBeforeBendN, 'bend raises tension');
  assert.ok(r.swbpLbfFt > 0);
  assert.equal(typeof r.tensionPass, 'boolean');
  assert.equal(typeof r.swbpPass, 'boolean');
});

test('an easy pull passes both checks', () => {
  const r = pull({ weightNPerM: 5, lengthM: 20, mu: 0.3, bendDeg: 45, radiusM: 0.6, areaMm2: 53.5, conductors: 3, material: 'cu' });
  assert.equal(r.tensionPass, true);
  assert.equal(r.swbpPass, true);
});

test('no bend gives no sidewall pressure', () => {
  const r = pull({ weightNPerM: 5, lengthM: 20, mu: 0.3, bendDeg: 0, areaMm2: 53.5, conductors: 3 });
  assert.equal(r.hasBend, false);
  assert.equal(r.swbpLbfFt, null);
});

test('zero friction throws', () => {
  assert.throws(() => pull({ weightNPerM: 5, lengthM: 20, mu: 0 }), /friction/);
});
