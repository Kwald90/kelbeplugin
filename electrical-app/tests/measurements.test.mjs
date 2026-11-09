// AR tape measure record helpers (lib/measurements.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMeasurement, sortMeasurements, measurementTitle, validLength } from '../js/lib/measurements.js';

test('newMeasurement builds a canonical metres record, trims and clamps', () => {
  const m = newMeasurement({ lengthM: 3.25, unit: 'imperial', method: 'ar', jobId: 'j1', label: '  panel to box  ', note: 'rough-in', by: 'u1' });
  assert.equal(m.lengthM, 3.25);
  assert.equal(m.unit, 'imperial');
  assert.equal(m.method, 'ar');
  assert.equal(m.jobId, 'j1');
  assert.equal(m.label, 'panel to box');
  assert.equal(m.note, 'rough-in');
  assert.equal(m.createdBy, 'u1');
  assert.ok(m.takenAt && m.createdAt);
});

test('newMeasurement defaults: metric, ar, no job, numeric length', () => {
  const m = newMeasurement({ lengthM: '2.5' });
  assert.equal(m.unit, 'metric');
  assert.equal(m.method, 'ar');
  assert.equal(m.jobId, null);
  assert.equal(m.lengthM, 2.5);
  const bad = newMeasurement({ lengthM: 'x', unit: 'nonsense', method: 'nonsense' });
  assert.equal(bad.lengthM, 0);
  assert.equal(bad.unit, 'metric');
  assert.equal(bad.method, 'ar');
});

test('sortMeasurements is newest first', () => {
  const list = [
    { id: 'a', takenAt: '2026-01-01T10:00:00Z' },
    { id: 'b', takenAt: '2026-01-03T10:00:00Z' },
    { id: 'c', takenAt: '2026-01-02T10:00:00Z' },
  ];
  assert.deepEqual(sortMeasurements(list).map((m) => m.id), ['b', 'c', 'a']);
  assert.deepEqual(sortMeasurements([]), []);
});

test('measurementTitle falls back when unlabelled', () => {
  assert.equal(measurementTitle({ label: 'Kitchen wall' }), 'Kitchen wall');
  assert.equal(measurementTitle({ label: '   ' }), 'Measurement');
  assert.equal(measurementTitle({}), 'Measurement');
});

test('validLength accepts positive sane lengths only', () => {
  assert.equal(validLength(3.25), true);
  assert.equal(validLength(0), false);
  assert.equal(validLength(-1), false);
  assert.equal(validLength(200000), false);
  assert.equal(validLength('x'), false);
});
