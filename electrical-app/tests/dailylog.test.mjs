// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDailyLog, findForDay, filterLogs, sortLogs, summarize, crewCount, hasContent } from '../js/lib/dailylog.js';

test('a new daily log is tied to a job and date with empty defaults', () => {
  const l = newDailyLog({ job: { id: 'j1', clientId: 'c1' }, date: '2026-11-08', by: 'u1' });
  assert.equal(l.jobId, 'j1');
  assert.equal(l.clientId, 'c1');
  assert.equal(l.date, '2026-11-08');
  assert.deepEqual(l.crewIds, []);
  assert.deepEqual(l.photos, []);
  assert.equal(crewCount(l), 0);
});

test('findForDay returns the one log for a job on a date, else null', () => {
  const logs = [
    { id: 'a', jobId: 'j1', date: '2026-11-07' },
    { id: 'b', jobId: 'j1', date: '2026-11-08' },
    { id: 'c', jobId: 'j2', date: '2026-11-08' },
  ];
  assert.equal(findForDay(logs, 'j1', '2026-11-08').id, 'b');
  assert.equal(findForDay(logs, 'j1', '2026-11-09'), null);
  assert.equal(findForDay(logs, null, '2026-11-08'), null);
});

test('filterLogs narrows by job, including the not-linked bucket', () => {
  const logs = [
    { id: 'a', jobId: 'j1' },
    { id: 'b', jobId: 'j2' },
    { id: 'c', jobId: null },
  ];
  assert.deepEqual(filterLogs(logs, { jobId: 'j1' }).map((x) => x.id), ['a']);
  assert.deepEqual(filterLogs(logs, { jobId: '__none' }).map((x) => x.id), ['c']);
  assert.deepEqual(filterLogs(logs, {}).map((x) => x.id), ['a', 'b', 'c']);
});

test('sortLogs is newest day first', () => {
  const logs = [{ id: 'a', date: '2026-11-01' }, { id: 'b', date: '2026-11-08' }, { id: 'c', date: '2026-11-05' }];
  assert.deepEqual(sortLogs(logs).map((x) => x.id), ['b', 'c', 'a']);
});

test('crewCount and summarize count days, crew and delays', () => {
  const logs = [
    { date: '2026-11-08', crewIds: ['e1', 'e2'], delays: 'Rain' },
    { date: '2026-11-07', crewIds: [], delays: '' },
    { date: '2026-11-06', crewIds: ['e1'], delays: '  ' },
  ];
  assert.equal(crewCount(logs[0]), 2);
  const s = summarize(logs);
  assert.equal(s.total, 3);
  assert.equal(s.withCrew, 2);
  assert.equal(s.withDelays, 1);
});

test('hasContent flags a blank opened day from a real one', () => {
  assert.equal(hasContent(newDailyLog({ date: '2026-11-08' })), false);
  assert.equal(hasContent({ ...newDailyLog({ date: '2026-11-08' }), weather: 'Clear' }), true);
  assert.equal(hasContent({ ...newDailyLog({ date: '2026-11-08' }), crewIds: ['e1'] }), true);
});
