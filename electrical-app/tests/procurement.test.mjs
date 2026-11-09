// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newProcurementItem, isDelivered, isOutstanding, atRiskReason, isAtRisk, riskLabel,
  markDeliveredPatch, reopenPatch, filterItems, sortItems, summarize, leadTimeLabel,
  procurementLabel, statusLabel, statusTone, statusRank, PROC_STATUSES,
} from '../js/lib/procurement.js';

test('a new item is to-order, tied to a job, not delivered', () => {
  const it = newProcurementItem({ job: { id: 'j1', clientId: 'c1' }, description: '600A switchgear', vendor: 'Schneider', quantity: 2, by: 'u1' });
  assert.equal(it.jobId, 'j1');
  assert.equal(it.clientId, 'c1');
  assert.equal(it.status, 'to-order');
  assert.equal(it.quantity, 2);
  assert.equal(it.delivered, false);
  assert.equal(it.purchaseOrderId, null);
  assert.equal(isDelivered(it), false);
  assert.equal(isOutstanding(it), true);
  assert.equal(newProcurementItem({ quantity: 'x' }).quantity, 1);
});

test('isDelivered counts either the flag or the delivered status', () => {
  assert.equal(isDelivered({ status: 'delivered' }), true);
  assert.equal(isDelivered({ delivered: true, status: 'shipped' }), true);
  assert.equal(isDelivered({ status: 'ordered' }), false);
});

test('at risk when the promised date is after the need-by date', () => {
  const it = { status: 'ordered', promisedDate: '2026-12-20', needByDate: '2026-12-01' };
  assert.equal(atRiskReason(it, '2026-11-09'), 'promised-after-need');
  assert.equal(isAtRisk(it, '2026-11-09'), true);
  // Promised on or before need-by is fine.
  assert.equal(atRiskReason({ status: 'ordered', promisedDate: '2026-11-25', needByDate: '2026-12-01' }, '2026-11-09'), null);
});

test('at risk when a promised or need-by date has already passed', () => {
  assert.equal(atRiskReason({ status: 'ordered', promisedDate: '2026-11-01' }, '2026-11-09'), 'promised-overdue');
  assert.equal(atRiskReason({ status: 'ordered', needByDate: '2026-11-01' }, '2026-11-09'), 'need-by-passed');
  assert.equal(atRiskReason({ status: 'ordered', needByDate: '2026-12-01' }, '2026-11-09'), null);
});

test('delivered items are never at risk', () => {
  const it = { status: 'delivered', delivered: true, promisedDate: '2026-12-20', needByDate: '2026-12-01' };
  assert.equal(atRiskReason(it, '2026-11-09'), null);
  assert.equal(isAtRisk(it, '2026-11-09'), false);
});

test('riskLabel is human text, empty for no reason', () => {
  assert.equal(riskLabel('promised-after-need'), 'Promised after it is needed');
  assert.equal(riskLabel('promised-overdue'), 'Promised date passed');
  assert.equal(riskLabel('need-by-passed'), 'Need-by date passed');
  assert.equal(riskLabel(null), '');
});

test('markDeliveredPatch sets the flag, status and date; reopen clears them', () => {
  const p = markDeliveredPatch({ date: '2026-11-09' });
  assert.deepEqual(p, { delivered: true, status: 'delivered', deliveredDate: '2026-11-09' });
  assert.deepEqual(reopenPatch(), { delivered: false, status: 'shipped', deliveredDate: null });
});

test('filterItems narrows by job and status, with outstanding/delivered buckets', () => {
  const items = [
    { id: 'a', jobId: 'j1', status: 'ordered' },
    { id: 'b', jobId: 'j1', status: 'delivered', delivered: true },
    { id: 'c', jobId: 'j2', status: 'to-order' },
    { id: 'd', jobId: null, status: 'shipped' },
  ];
  assert.deepEqual(filterItems(items, { jobId: 'j1' }).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(filterItems(items, { status: 'outstanding' }).map((x) => x.id), ['a', 'c', 'd']);
  assert.deepEqual(filterItems(items, { status: 'delivered' }).map((x) => x.id), ['b']);
  assert.deepEqual(filterItems(items, { status: 'to-order' }).map((x) => x.id), ['c']);
  assert.deepEqual(filterItems(items, { jobId: '__none' }).map((x) => x.id), ['d']);
});

test('sortItems: outstanding before delivered, at-risk first, then by need-by date', () => {
  const asOf = '2026-11-09';
  const items = [
    { id: 'delivered', status: 'delivered', delivered: true, needByDate: '2026-11-01' },
    { id: 'okLater', status: 'ordered', needByDate: '2026-12-20' },
    { id: 'atRisk', status: 'ordered', promisedDate: '2026-12-10', needByDate: '2026-12-01' },
    { id: 'okSooner', status: 'ordered', needByDate: '2026-12-05' },
  ];
  assert.deepEqual(sortItems(items, asOf).map((x) => x.id), ['atRisk', 'okSooner', 'okLater', 'delivered']);
});

test('summarize counts delivered, outstanding, at-risk and a per-status breakdown', () => {
  const asOf = '2026-11-09';
  const items = [
    { status: 'to-order' },
    { status: 'ordered', promisedDate: '2026-12-10', needByDate: '2026-12-01' },
    { status: 'delivered', delivered: true },
  ];
  const s = summarize(items, asOf);
  assert.equal(s.total, 3);
  assert.equal(s.delivered, 1);
  assert.equal(s.outstanding, 2);
  assert.equal(s.atRisk, 1);
  assert.equal(s.byStatus['to-order'], 1);
  assert.equal(s.byStatus.ordered, 1);
  assert.equal(s.byStatus.delivered, 1);
});

test('leadTimeLabel and labels', () => {
  assert.equal(leadTimeLabel(6), '6 weeks');
  assert.equal(leadTimeLabel(1), '1 week');
  assert.equal(leadTimeLabel(0), '');
  assert.equal(leadTimeLabel(null), '');
  assert.equal(statusLabel('ordered'), 'Ordered');
  assert.equal(statusTone('delivered'), 'success');
  assert.ok(statusRank('to-order') < statusRank('delivered'));
  assert.equal(PROC_STATUSES.length, 6);
  assert.equal(procurementLabel({ description: '600A switchgear' }), '600A switchgear');
  assert.equal(procurementLabel({ vendor: 'Schneider' }), 'Item from Schneider');
  assert.equal(procurementLabel({}), 'Long-lead item');
});
