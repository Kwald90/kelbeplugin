// Conduit thermal expansion (lib/conduit-expansion.js): dL = coefficient x length x dT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expansionMm, needsExpansionFitting, inPerInF, deltaFtoC, CONDUIT_MATERIALS, FITTING_THRESHOLD_MM } from '../js/lib/conduit-expansion.js';

const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('PVC coefficient matches 3.38e-5 in/in/F', () => {
  close(inPerInF(CONDUIT_MATERIALS[0].mmPerMC), 3.38e-5, 1e-7);
});

test('PVC 30 m over a 60 C swing', () => {
  close(expansionMm({ material: 'pvc', lengthM: 30, deltaC: 60 }), 0.0608 * 30 * 60);
});

test('matches the 4.06 in per 100 ft per 100 F rule of thumb', () => {
  const mm = expansionMm({ material: 'pvc', lengthM: 100 * 0.3048, deltaC: deltaFtoC(100) });
  close(mm / 25.4, 4.06, 0.02);
});

test('contraction is negative; metals move less than PVC', () => {
  assert.ok(expansionMm({ lengthM: 10, deltaC: -20 }) < 0);
  assert.ok(expansionMm({ material: 'steel', lengthM: 10, deltaC: 20 }) < expansionMm({ material: 'al', lengthM: 10, deltaC: 20 }));
  assert.ok(expansionMm({ material: 'al', lengthM: 10, deltaC: 20 }) < expansionMm({ material: 'pvc', lengthM: 10, deltaC: 20 }));
});

test('fitting threshold is about 6 mm', () => {
  assert.equal(FITTING_THRESHOLD_MM, 6);
  assert.equal(needsExpansionFitting(5.9), false);
  assert.equal(needsExpansionFitting(-6.1), true);
});

test('bad input throws', () => {
  assert.throws(() => expansionMm({ material: 'x', lengthM: 1, deltaC: 1 }));
  assert.throws(() => expansionMm({ lengthM: -1, deltaC: 1 }));
});
