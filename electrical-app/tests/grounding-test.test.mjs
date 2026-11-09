// Grounding electrode / fall-of-potential test record (lib/grounding-test.js). Stateless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { potentialProbeDistance, evaluateTest, FOP_RATIO, DEFAULT_TARGET_OHMS, TARGETS } from '../js/lib/grounding-test.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('62% rule places the potential probe at 61.8% of the current-probe distance', () => {
  assert.ok(near(potentialProbeDistance(30), 30 * FOP_RATIO, 1e-9));
  assert.equal(potentialProbeDistance(0), null);
});

test('median reading at or below target passes', () => {
  const r = evaluateTest({ readings: [18, 19, 20], targetOhms: 25 });
  assert.equal(r.resultOhms, 19);
  assert.equal(r.pass, true);
  assert.ok(r.notes[0].startsWith('PASS'));
});

test('median above target fails with remediation advice', () => {
  const r = evaluateTest({ readings: [40, 42, 44], targetOhms: 25 });
  assert.equal(r.pass, false);
  assert.ok(r.notes[0].startsWith('FAIL'));
  assert.ok(r.notes.some((n) => /rod|electrode|ring/i.test(n)));
});

test('wide spread in three+ readings is flagged', () => {
  const r = evaluateTest({ readings: [10, 20, 40], targetOhms: 25 });
  assert.ok(r.spreadPct > 30);
  assert.ok(r.notes.some((n) => /vary by/i.test(n)));
});

test('default target is used when none given', () => {
  const r = evaluateTest({ readings: [10] });
  assert.equal(r.targetOhms, DEFAULT_TARGET_OHMS);
});

test('no readings returns a prompt, not a crash', () => {
  const r = evaluateTest({ readings: [] });
  assert.equal(r.resultOhms, null);
  assert.equal(r.pass, null);
});

test('every target option is a positive resistance', () => {
  for (const t of TARGETS) assert.ok(t.value > 0 && t.label);
});
