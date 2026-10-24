import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobOverview } from '../js/lib/job-overview.js';

const job = { id: 'job-1', clientId: 'client-1', status: 'in-progress', crewIds: ['crew-1'] };
const base = { job, day: '2026-10-21', employeeId: 'crew-1', manager: true, can: () => true, on: () => true, seesMoney: true };
const overview = (patch = {}) => jobOverview({ ...base, ...patch });
const task = { id: 'task-1', jobId: 'job-1', employeeId: 'crew-1', planId: 'plan-1', date: '2026-10-21', status: 'blocked', title: 'Shutdown needed', blocks: [{ reason: 'Wait for building manager' }] };

test('next crew visit combines the earliest date only and deduplicates people and notes', () => {
  const result = overview({ schedule: [
    { jobId: 'job-1', date: '2026-10-20', employeeId: 'past' },
    { jobId: 'other-job', date: '2026-10-21', employeeId: 'other' },
    { jobId: 'job-1', date: '2026-10-23', employeeId: 'later' },
    { jobId: 'job-1', date: '2026-10-22', employeeId: 'crew-1', note: 'Use rear entrance' },
    { jobId: 'job-1', date: '2026-10-22', employeeId: 'crew-1', note: 'Use rear entrance' },
    { jobId: 'job-1', date: '2026-10-22', employeeId: 'crew-2' },
  ] });
  assert.deepEqual(result.nextVisit, { date: '2026-10-22', crewIds: ['crew-1', 'crew-2'], notes: ['Use rear entrance'] });
  assert.equal(result.next.href, '#/jobs/job-1?tab=schedule');
});

test('crew see only their published job tasks and never draft or other-job blockers', () => {
  const result = overview({ manager: false, seesMoney: false, tasks: [task,
    { ...task, id: 'other-worker', employeeId: 'crew-2' }, { ...task, id: 'draft', status: 'draft' },
    { ...task, id: 'other-job', jobId: 'other' },
  ], can: (p) => ['jobs', 'today', 'drawings'].includes(p) });
  assert.deepEqual(result.blockers.map((t) => t.id), ['task-1']);
  assert.equal(result.blockers[0].href, '#/today');
  assert.equal(result.next.title, 'Clear the blocker');
  assert.equal(result.nextVisit, null);
  assert.deepEqual(overview({ manager: false, employeeId: null, tasks: [{ ...task, employeeId: null }] }).blockers, []);
});

test('work hold takes priority over blockers, requests and scheduling without exposing credit data', () => {
  const result = overview({ hold: true, tasks: [task], materials: [{ id: 'req', jobId: 'job-1', urgent: true }] });
  assert.equal(result.next.title, 'Confirm the job can proceed');
  assert.equal(result.next.href, '#/clients/client-1');
  const crew = overview({ hold: true, manager: false, can: (p) => p !== 'clients' });
  assert.equal(crew.next.href, null);
  assert.doesNotMatch(JSON.stringify(crew), /credit|balance|past.due/i);
});

test('unresolved blocker reason ignores resolved history and takes priority over urgent requests', () => {
  const result = overview({ tasks: [{ ...task, blocks: [{ reason: 'Old', resolvedAt: '2026-10-20' }, { reason: 'Power still on' }] }],
    materials: [{ jobId: 'job-1', urgent: true, status: 'requested' }] });
  assert.equal(result.next.href, '#/workplan/plan-1');
  assert.equal(result.blockers[0].reason, 'Power still on');
});

test('material needs include open statuses only and project no cost or price fields', () => {
  const result = overview({ materials: [
    { id: 'waiting', jobId: 'job-1', description: 'Connectors', costCents: 9999 },
    { id: 'urgent', jobId: 'job-1', description: 'Panel', status: 'ordered', urgent: true, unitCents: 8888 },
    { id: 'done', jobId: 'job-1', status: 'fulfilled' }, { id: 'cancelled', jobId: 'job-1', status: 'cancelled' },
    { id: 'other', jobId: 'other', status: 'sent' },
  ] });
  assert.deepEqual(result.needs.map((r) => r.id), ['urgent', 'waiting']);
  assert.equal(result.needs[1].status, 'requested');
  assert.equal(result.next.href, '#/jobs/job-1?tab=materials');
  assert.doesNotMatch(JSON.stringify(result), /9999|8888|costCents|unitCents/);
});

test('disabled modules and missing permissions suppress their records and links', () => {
  for (const key of ['can', 'on']) {
    const result = overview({ [key]: () => false, tasks: [task], materials: [{ jobId: 'job-1', urgent: true }],
      schedule: [{ jobId: 'job-1', date: '2026-10-22' }] });
    assert.equal(result.nextVisit, null);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.needs, []);
    assert.equal(result.next, null);
  }
});

test('final billing requires a completed job, money visibility, invoice permission and module', () => {
  const complete = { ...job, status: 'complete' };
  assert.equal(overview({ job: complete }).next.href, '#/jobs/job-1?tab=money');
  assert.equal(overview({ job: complete, seesMoney: false }).next, null);
  assert.equal(overview({ job: complete, can: (p) => p !== 'invoices' }).next, null);
  assert.equal(overview({ job: complete, on: (m) => m !== 'invoices' }).next, null);
  for (const status of ['invoiced', 'cancelled']) assert.equal(overview({ job: { ...job, status } }).next, null);
});

test('existing service kind changes the scheduling prompt; read-only never suggests booking', () => {
  const service = { ...job, kind: 'service' };
  assert.equal(overview({ job: service }).next.title, 'Book the service visit');
  assert.equal(overview().next.title, 'Plan the next visit');
  assert.notEqual(overview({ job: service, readOnly: true }).next.href, '#/schedule');
});

test('a worker gets their next published work before a general drawing shortcut', () => {
  const result = overview({ manager: false, can: (p) => ['jobs', 'today', 'drawings'].includes(p), tasks: [
    { ...task, status: 'todo', date: '2026-10-23' }, { ...task, id: 'first', status: 'in-progress', date: '2026-10-21' },
    { ...task, id: 'done', status: 'done' },
  ] });
  assert.equal(result.upcomingTasks[0].id, 'first');
  assert.equal(result.next.title, 'Your next task');
  assert.equal(result.next.href, '#/today');
});
