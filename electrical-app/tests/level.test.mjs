import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilt, reading, isLevel } from '../js/lib/level.js';

test('tilt is 0 when flat and grows toward 90 as the phone stands up', () => {
  assert.equal(tilt(0, 0), 0);
  assert.equal(tilt(90, 0), 90);
  assert.equal(tilt(0, 90), 90);
  assert.equal(Math.round(tilt(45, 0)), 45);
  // a combined tilt is more than either axis alone
  assert.ok(tilt(30, 30) > 30);
});

test('reading subtracts the calibration zero on both axes', () => {
  const r = reading(12.4, -3.1, { beta: 2.4, gamma: -1.1 });
  assert.equal(r.pitch, 10);
  assert.equal(r.roll, -2);
  assert.ok(r.tilt >= 10);
});

test('reading rounds to one decimal and tolerates missing values', () => {
  const r = reading(1.23, undefined);
  assert.equal(r.pitch, 1.2);
  assert.equal(r.roll, 0);
});

test('isLevel only when both axes are within the tolerance', () => {
  assert.equal(isLevel({ pitch: 0.3, roll: -0.2 }, 0.5), true);
  assert.equal(isLevel({ pitch: 0.9, roll: 0 }, 0.5), false);
  assert.equal(isLevel({ pitch: 0, roll: 0.6 }, 0.5), false);
});
