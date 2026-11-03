// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTestReport, newReading, readingPasses, resultFrom, calibrationStale, typeOf } from '../js/lib/testing.js';

test('a reading passes by direction against its limit, or is manual when it cannot be judged', () => {
  assert.equal(readingPasses({ value: 500, limit: 1, direction: 'min' }), true, 'insulation 500 MΩ ≥ 1');
  assert.equal(readingPasses({ value: 0.5, limit: 1, direction: 'min' }), false);
  assert.equal(readingPasses({ value: 0.2, limit: 0.5, direction: 'max' }), true, 'continuity 0.2 Ω ≤ 0.5');
  assert.equal(readingPasses({ value: 40, limit: 25, direction: 'max' }), false, 'trip 40 ms > 25');
  assert.equal(readingPasses({ value: 5, direction: null, limit: null }), null, 'torque is recorded only');
  assert.equal(readingPasses({ value: 5, direction: null, limit: null, pass: true }), true, 'manual pass respected');
});

test('overall result is fail if any reading fails, else pass', () => {
  const r = newTestReport({ type: 'insulation-resistance' });
  r.readings = [{ value: 500, limit: 1, direction: 'min' }, { value: 800, limit: 1, direction: 'min' }];
  assert.equal(resultFrom(r), 'pass');
  r.readings.push({ value: 0.2, limit: 1, direction: 'min' });
  assert.equal(resultFrom(r), 'fail');
});

test('a new reading inherits the test type unit and limit direction', () => {
  assert.deepEqual([newReading('insulation-resistance').unit, newReading('insulation-resistance').direction], ['MΩ', 'min']);
  assert.deepEqual([newReading('gfci-trip').unit, newReading('gfci-trip').direction], ['ms', 'max']);
  assert.equal(newReading('torque').direction, null);
});

test('a new report is tied to a job and carries the type label as its title', () => {
  const r = newTestReport({ job: { id: 'j1', clientId: 'c1' }, type: 'continuity', by: 'u1' });
  assert.equal(r.jobId, 'j1');
  assert.equal(r.clientId, 'c1');
  assert.equal(r.title, typeOf('continuity').label);
  assert.equal(r.result, 'pass');
});

test('calibration is stale when more than a year past the cal date', () => {
  assert.equal(calibrationStale({ instrumentCalDate: '2024-01-01' }, '2026-11-02'), true);
  assert.equal(calibrationStale({ instrumentCalDate: '2026-06-01' }, '2026-11-02'), false);
  assert.equal(calibrationStale({ instrumentCalDate: null }, '2026-11-02'), false);
});
