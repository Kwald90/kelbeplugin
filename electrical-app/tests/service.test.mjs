// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newAgreement, newAsset, intervalMonths, addMonths, isDue, logVisitPatch, warrantyState } from '../js/lib/service.js';

test('interval months from frequency, with a custom fallback', () => {
  assert.equal(intervalMonths({ frequency: 'monthly' }), 1);
  assert.equal(intervalMonths({ frequency: 'quarterly' }), 3);
  assert.equal(intervalMonths({ frequency: 'annual' }), 12);
  assert.equal(intervalMonths({ frequency: 'custom', intervalMonths: 4 }), 4);
  assert.equal(intervalMonths({ frequency: 'custom' }), 12);
});

test('addMonths advances a date and clamps to the month length', () => {
  assert.equal(addMonths('2026-01-15', 3), '2026-04-15');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', 'clamps Jan 31 + 1mo to Feb 28');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
});

test('a visit is due only for active agreements on or before the date', () => {
  const a = newAgreement({ startDate: '2026-11-01' });
  assert.equal(isDue(a, '2026-11-01'), true);
  assert.equal(isDue(a, '2026-10-31'), false);
  assert.equal(isDue({ ...a, status: 'paused' }, '2026-12-01'), false);
  assert.equal(isDue({ ...a, nextDueDate: null }, '2026-12-01'), false);
});

test('logging a visit records it and moves the due date one interval on', () => {
  const a = newAgreement({ startDate: '2026-11-01' }); // quarterly
  const patch = logVisitPatch(a, { jobId: 'j1', note: 'done' });
  assert.equal(patch.nextDueDate, '2027-02-01', 'quarterly: +3 months');
  assert.equal(patch.visits.length, 1);
  assert.equal(patch.visits[0].jobId, 'j1');
  assert.ok(patch.lastVisitAt);
});

test('warranty state: expired, expiring soon, ok, or none', () => {
  const asset = (until) => ({ ...newAsset({ name: 'Panel' }), warrantyUntil: until });
  assert.equal(warrantyState(asset(null), '2026-11-02'), null);
  assert.equal(warrantyState(asset('2026-10-01'), '2026-11-02'), 'expired');
  assert.equal(warrantyState(asset('2026-12-15'), '2026-11-02'), 'expiring');
  assert.equal(warrantyState(asset('2028-01-01'), '2026-11-02'), 'ok');
});

test('a new asset defaults to a valid type and in-service status', () => {
  assert.equal(newAsset({ type: 'nonsense' }).type, 'other');
  assert.equal(newAsset({ type: 'generator' }).type, 'generator');
  assert.equal(newAsset({}).status, 'in-service');
});
