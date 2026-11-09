// Overcurrent interrupting / SCCR quick-check (lib/sccr.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickCheck, selectivityNote, DEVICE_KINDS, KA_STANDARD } from '../js/lib/sccr.js';

test('rating above available fault current passes', () => {
  const r = quickCheck({ availableKa: 18, ratingKa: 22 });
  assert.equal(r.pass, true);
  assert.ok(r.notes[0].startsWith('PASS'));
  assert.ok(r.marginKa > 0);
});

test('rating below available fault current fails and suggests a standard rating', () => {
  const r = quickCheck({ availableKa: 30, ratingKa: 22 });
  assert.equal(r.pass, false);
  assert.ok(r.notes[0].startsWith('FAIL'));
  assert.ok(KA_STANDARD.includes(r.nextStandard));
  assert.ok(r.nextStandard >= 30);
});

test('a required margin raises the bar', () => {
  const noMargin = quickCheck({ availableKa: 22, ratingKa: 22 });
  assert.equal(noMargin.pass, true, 'equal is allowed at the code minimum');
  const withMargin = quickCheck({ availableKa: 22, ratingKa: 22, marginPct: 25 });
  assert.equal(withMargin.pass, false, '25% margin needs 27.5 kA');
  assert.ok(near(withMargin.requiredKa, 27.5, 1e-9));
});

test('series-rated note appears on a fail when the flag is set', () => {
  const r = quickCheck({ availableKa: 40, ratingKa: 22, seriesRated: true });
  assert.ok(r.notes.some((n) => /series-rated/i.test(n)));
});

test('selectivity note returns documented fuse and breaker behaviour', () => {
  const lines = selectivityNote({ availableKa: 25 });
  assert.ok(lines.length >= 3);
  assert.ok(lines.some((l) => /current-limiting fuse/i.test(l)));
  assert.ok(lines.some((l) => /NOT be selective|NOT selective/i.test(l) || /instantaneous/i.test(l)));
});

test('bad inputs throw', () => {
  assert.throws(() => quickCheck({ ratingKa: 22 }), /available/);
  assert.throws(() => quickCheck({ availableKa: 10 }), /rating/);
});

test('every device kind has a value and label', () => {
  for (const d of DEVICE_KINDS) assert.ok(d.value && d.label);
});

function near(a, b, tol) { return Math.abs(a - b) <= tol; }
