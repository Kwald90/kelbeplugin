// AR tape measure record helpers (lib/measurements.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMeasurement, sortMeasurements, measurementTitle, validLength, fmtArea, validArea } from '../js/lib/measurements.js';
import { polygonArea, closedPerimeter } from '../js/lib/ar-measure.js';

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

test('polygonArea: unit square in a plane = 1 m², any orientation', () => {
  // 1x1 square on the floor (y=0, the x/z plane)
  const floor = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }];
  assert.ok(Math.abs(polygonArea(floor) - 1) < 1e-9);
  // the same square stood up on a wall (z=0, the x/y plane) — still 1 m²
  const wall = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }];
  assert.ok(Math.abs(polygonArea(wall) - 1) < 1e-9);
  // a 3x4 right triangle on the floor = 6 m²
  const tri = [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }];
  assert.ok(Math.abs(polygonArea(tri) - 6) < 1e-9);
  assert.equal(polygonArea([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]), 0); // < 3 points
});

test('closedPerimeter sums the loop including last->first', () => {
  const sq = [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 2 }, { x: 0, y: 0, z: 2 }];
  assert.ok(Math.abs(closedPerimeter(sq) - 8) < 1e-9);
  assert.equal(closedPerimeter([{ x: 0, y: 0, z: 0 }]), 0);
});

test('fmtArea gives both m² and ft², the preferred unit first', () => {
  const metric = fmtArea(10, { units: 'metric' });
  assert.equal(metric.primary, '10.00 m²');
  assert.match(metric.other, /107\.6 ft²/);
  const imperial = fmtArea(10, { units: 'imperial' });
  assert.match(imperial.primary, /107\.6 ft²/);
  assert.equal(imperial.other, '10.00 m²');
});

test('newMeasurement area keeps areaM2 + perimeterM; length keeps lengthM', () => {
  const area = newMeasurement({ kind: 'area', areaM2: 12.5, perimeterM: 14, unit: 'metric' });
  assert.equal(area.kind, 'area');
  assert.equal(area.areaM2, 12.5);
  assert.equal(area.perimeterM, 14);
  const len = newMeasurement({ kind: 'length', lengthM: 3.2 });
  assert.equal(len.kind, 'length');
  assert.equal(len.lengthM, 3.2);
  assert.equal(len.areaM2, null);
});

test('validArea accepts positive sane areas only', () => {
  assert.equal(validArea(12.5), true);
  assert.equal(validArea(0), false);
  assert.equal(validArea(-2), false);
  assert.equal(validArea(2e7), false);
});
