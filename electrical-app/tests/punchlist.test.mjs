// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPunchItem, isOpen, isOverdue, resolvePatch, reopenPatch, filterItems, sortItems, groupByArea, summarize, severityRank, severityLabel, punchLabel } from '../js/lib/punchlist.js';

test('a new punch item is open, tied to a job, with a valid severity', () => {
  const it = newPunchItem({ job: { id: 'j1', clientId: 'c1' }, by: 'u1', date: '2026-11-08' });
  assert.equal(it.jobId, 'j1');
  assert.equal(it.clientId, 'c1');
  assert.equal(it.status, 'open');
  assert.equal(it.severity, 'medium');
  assert.equal(isOpen(it), true);
  assert.equal(newPunchItem({ severity: 'nonsense' }).severity, 'medium');
  assert.equal(newPunchItem({ severity: 'high' }).severity, 'high');
});

test('resolving closes and stamps who/when; reopening clears it', () => {
  const it = newPunchItem({});
  const r = resolvePatch(it, { by: 'u2', at: '2026-11-08T12:00:00.000Z' });
  assert.deepEqual(r, { status: 'closed', resolvedAt: '2026-11-08T12:00:00.000Z', resolvedBy: 'u2' });
  Object.assign(it, r);
  assert.equal(isOpen(it), false);
  const o = reopenPatch();
  assert.deepEqual(o, { status: 'open', resolvedAt: null, resolvedBy: null });
});

test('overdue only applies to open items past their due date', () => {
  const it = { ...newPunchItem({}), dueDate: '2026-11-01' };
  assert.equal(isOverdue(it, '2026-11-08'), true);
  assert.equal(isOverdue(it, '2026-10-30'), false);
  assert.equal(isOverdue({ ...it, status: 'closed' }, '2026-11-08'), false);
  assert.equal(isOverdue({ ...newPunchItem({}), dueDate: null }, '2026-11-08'), false);
});

test('filterItems narrows by job and status', () => {
  const items = [
    { id: 'a', jobId: 'j1', status: 'open' },
    { id: 'b', jobId: 'j1', status: 'closed' },
    { id: 'c', jobId: 'j2', status: 'open' },
    { id: 'd', jobId: null, status: 'open' },
  ];
  assert.deepEqual(filterItems(items, { jobId: 'j1' }).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(filterItems(items, { jobId: 'j1', status: 'open' }).map((x) => x.id), ['a']);
  assert.deepEqual(filterItems(items, { status: 'open' }).map((x) => x.id), ['a', 'c', 'd']);
  assert.deepEqual(filterItems(items, { jobId: '__none' }).map((x) => x.id), ['d']);
});

test('sortItems: open before closed, then severity worst first, then due date', () => {
  const items = [
    { id: 'closedHigh', status: 'closed', severity: 'high', dueDate: null },
    { id: 'openLow', status: 'open', severity: 'low', dueDate: '2026-12-01' },
    { id: 'openHighSoon', status: 'open', severity: 'high', dueDate: '2026-11-10' },
    { id: 'openHighLater', status: 'open', severity: 'high', dueDate: '2026-11-20' },
  ];
  assert.deepEqual(sortItems(items).map((x) => x.id), ['openHighSoon', 'openHighLater', 'openLow', 'closedHigh']);
  assert.ok(severityRank('high') > severityRank('medium') && severityRank('medium') > severityRank('low'));
});

test('groupByArea buckets by area, blank area labelled and last', () => {
  const items = [
    { id: 'a', area: 'Level 2', status: 'open', severity: 'low' },
    { id: 'b', area: '', status: 'open', severity: 'high' },
    { id: 'c', area: 'Level 1', status: 'open', severity: 'medium' },
    { id: 'd', area: 'Level 2', status: 'open', severity: 'high' },
  ];
  const groups = groupByArea(items);
  assert.deepEqual(groups.map((g) => g.area), ['Level 1', 'Level 2', 'No area']);
  // Within Level 2, high comes before low.
  assert.deepEqual(groups[1].items.map((x) => x.id), ['d', 'a']);
});

test('summarize counts open/closed, severities and overdue', () => {
  const items = [
    { status: 'open', severity: 'high', dueDate: '2026-11-01' },
    { status: 'open', severity: 'low', dueDate: null },
    { status: 'closed', severity: 'high' },
  ];
  const s = summarize(items, '2026-11-08');
  assert.equal(s.total, 3);
  assert.equal(s.open, 2);
  assert.equal(s.closed, 1);
  assert.equal(s.high, 1);
  assert.equal(s.low, 1);
  assert.equal(s.overdue, 1);
});

test('labels fall back gracefully', () => {
  assert.equal(severityLabel('high'), 'High');
  assert.equal(punchLabel({ description: 'Missing cover plate' }), 'Missing cover plate');
  assert.equal(punchLabel({ description: '', area: 'Level 2' }), 'Deficiency · Level 2');
  assert.equal(punchLabel({}), 'Deficiency');
});
