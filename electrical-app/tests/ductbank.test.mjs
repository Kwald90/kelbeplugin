// Underground duct-bank ampacity derating screening (lib/ductbank.js). All figures VERIFY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earthAmbientFactor, groupFactor, loadFactorAllowance, ductBankAmpacity, GROUP_FACTOR } from '../js/lib/ductbank.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('earth ambient factor is 1.0 at the 20 C base and drops as it warms', () => {
  assert.ok(near(earthAmbientFactor(20, 90), 1, 1e-9));
  assert.ok(earthAmbientFactor(30, 90) < 1);
  assert.ok(near(earthAmbientFactor(30, 90), Math.sqrt((90 - 30) / (90 - 20)), 1e-9));
});

test('group factor falls as more ducts are loaded', () => {
  assert.equal(groupFactor(1), 1.0);
  assert.ok(groupFactor(4) < groupFactor(2));
  assert.ok(groupFactor(12) <= GROUP_FACTOR[12]);
  // between table points holds the lower (more conservative) step
  assert.equal(groupFactor(5), GROUP_FACTOR[4]);
});

test('load factor allowance gives credit below 100%', () => {
  assert.equal(loadFactorAllowance(100), 1);
  assert.ok(loadFactorAllowance(50) > 1);
  assert.ok(near(loadFactorAllowance(50), 1.15, 1e-9));
});

test('ductBankAmpacity derates the CEC base ampacity by all three factors', () => {
  // 4/0 Cu at 90 C, raceway base ampacity = 260 A (CEC Table 2)
  const r = ductBankAmpacity({ size: '4/0', material: 'cu', conductorC: 90, earthAmbientC: 20, loadedDucts: 4, loadFactorPct: 100 });
  assert.equal(r.baseAmpacity, 260);
  const expect = 260 * 1 * groupFactor(4) * 1;
  assert.ok(near(r.deratedAmpacity, expect, 1e-6));
  assert.ok(r.deratedAmpacity < r.baseAmpacity);
});

test('an unknown conductor size throws', () => {
  assert.throws(() => ductBankAmpacity({ size: '9000', material: 'cu' }), /not in the CEC/);
});
