// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRfi, nextNumber, answerPatch, closePatch, reopenPatch, filterRfis, sortRfis, summarize, isOpen, isAnswered, isClosed, isOverdue, rfiNo, rfiLabel } from '../js/lib/rfis.js';

test('RFI numbers run per job, starting at 1', () => {
  assert.equal(nextNumber([], 'j1'), 1);
  const items = [{ jobId: 'j1', number: 1 }, { jobId: 'j1', number: 2 }, { jobId: 'j2', number: 1 }];
  assert.equal(nextNumber(items, 'j1'), 3, 'next on job 1');
  assert.equal(nextNumber(items, 'j2'), 2, 'job 2 numbers independently');
  assert.equal(nextNumber(items, 'j3'), 1, 'a new job starts at 1');
  assert.equal(nextNumber(items, null), 1, 'the no-job group is its own sequence');
});

test('a new RFI is open, tied to a job and client, and takes the next job number', () => {
  const r = newRfi({ job: { id: 'j1', clientId: 'c1' }, items: [{ jobId: 'j1', number: 4 }], by: 'u1', date: '2026-11-09' });
  assert.equal(r.jobId, 'j1');
  assert.equal(r.clientId, 'c1');
  assert.equal(r.number, 5);
  assert.equal(r.status, 'open');
  assert.equal(r.dateRaised, '2026-11-09');
  assert.equal(r.createdBy, 'u1');
  assert.ok(isOpen(r) && !isAnswered(r) && !isClosed(r));
});

test('answering, closing and reopening move the status and stamp the answer date', () => {
  const r = newRfi({ job: { id: 'j1' } });
  const a = answerPatch(r, { by: 'eng', at: '2026-11-10' });
  assert.deepEqual(a, { status: 'answered', answeredDate: '2026-11-10', answeredBy: 'eng' });
  Object.assign(r, a);
  assert.ok(isAnswered(r));
  Object.assign(r, closePatch());
  assert.ok(isClosed(r));
  const re = reopenPatch();
  assert.deepEqual(re, { status: 'open', answeredDate: null, answeredBy: null });
  Object.assign(r, re);
  assert.ok(isOpen(r) && r.answeredDate === null);
});

test('an open RFI past its needed-by date is overdue; answered and closed ones are not', () => {
  assert.equal(isOverdue({ status: 'open', neededBy: '2026-11-01' }, '2026-11-09'), true);
  assert.equal(isOverdue({ status: 'open', neededBy: '2026-11-20' }, '2026-11-09'), false);
  assert.equal(isOverdue({ status: 'answered', neededBy: '2026-11-01' }, '2026-11-09'), false);
  assert.equal(isOverdue({ status: 'closed', neededBy: '2026-11-01' }, '2026-11-09'), false);
  assert.equal(isOverdue({ status: 'open', neededBy: null }, '2026-11-09'), false);
});

test('filter by job and status, with __none for RFIs not linked to a job', () => {
  const items = [
    { id: 'a', jobId: 'j1', status: 'open' },
    { id: 'b', jobId: 'j1', status: 'closed' },
    { id: 'c', jobId: 'j2', status: 'answered' },
    { id: 'd', jobId: null, status: 'open' },
  ];
  assert.deepEqual(filterRfis(items, { jobId: 'j1' }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(filterRfis(items, { jobId: 'j1', status: 'open' }).map((r) => r.id), ['a']);
  assert.deepEqual(filterRfis(items, { jobId: '__none' }).map((r) => r.id), ['d']);
  assert.deepEqual(filterRfis(items, { status: 'answered' }).map((r) => r.id), ['c']);
});

test('sort puts open first, then answered, then closed; higher numbers first within a status', () => {
  const items = [
    { number: 1, status: 'closed' },
    { number: 3, status: 'open' },
    { number: 2, status: 'open' },
    { number: 4, status: 'answered' },
  ];
  assert.deepEqual(sortRfis(items).map((r) => [r.status, r.number]), [['open', 3], ['open', 2], ['answered', 4], ['closed', 1]]);
});

test('summary counts by status and overdue open items', () => {
  const items = [
    { status: 'open', neededBy: '2026-11-01' },
    { status: 'open', neededBy: '2026-12-01' },
    { status: 'answered' },
    { status: 'closed' },
  ];
  assert.deepEqual(summarize(items, '2026-11-09'), { total: 4, open: 2, answered: 1, closed: 1, overdue: 1 });
});

test('the printable label shows a padded number and the subject', () => {
  assert.equal(rfiNo({ number: 3 }), 'RFI-003');
  assert.equal(rfiNo({ number: 0 }), 'RFI');
  assert.equal(rfiLabel({ number: 3, subject: 'Panel location' }), 'RFI-003 · Panel location');
  assert.equal(rfiLabel({ number: 3, subject: '' }), 'RFI-003');
});
