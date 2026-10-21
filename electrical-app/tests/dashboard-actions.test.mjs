import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardActions, dashboardRouteAllowed } from '../js/lib/dashboard-actions.js';

const base = { settings: { labourRateCents: 10000 }, can: () => true, seesMoney: true, day: '2026-10-20', money: (c) => `$${c / 100}` };
const actions = (patch = {}) => dashboardActions({ ...base, ...patch });
const job = { id: 'job', title: 'Panel upgrade', status: 'in-progress', billingMode: 'tm' };
const entry = { id: 'time', jobId: 'job', employeeId: 'worker', clockIn: '2026-10-19T09:00:00Z', clockOut: '2026-10-19T10:00:00Z', approved: true };

test('shows a blocked task with its latest unresolved reason ahead of financial actions', () => {
  const rows = actions({ tasks: [{ id: 'task', title: 'Install panel', status: 'blocked', planId: 'plan', blocks: [
    { reason: 'Old reason', resolvedAt: '2026-10-19' }, { reason: 'Waiting for shutdown' },
  ] }], overdue: [{ id: 'invoice', number: 'INV-9', balanceCents: 50000 }] });
  assert.deepEqual(rows.map((r) => r.kind), ['blocked', 'overdue']);
  assert.equal(rows[0].detail, 'Waiting for shutdown');
  assert.equal(rows[0].href, '#/workplan/plan');
  assert.equal(rows[1].detail, '$500 outstanding');
});

test('does not expose money actions without both financial access and money visibility', () => {
  const data = { jobs: [job], tmSources: { timeEntries: [entry] }, overdue: [{ id: 'invoice', balanceCents: 10000 }] };
  assert.deepEqual(actions({ ...data, seesMoney: false }), []);
  assert.deepEqual(actions({ ...data, can: (p) => p !== 'invoices' }), []);
  assert.deepEqual(actions({ ...data, settings: { ...base.settings, modules: { invoices: false } } }), []);
});

test('creates an action only for an accepted quote without either kind of job link', () => {
  const estimates = [
    { id: 'accepted', status: 'accepted', title: 'New service' },
    { id: 'draft', status: 'draft' }, { id: 'sent', status: 'sent' },
    { id: 'linked', status: 'accepted', jobId: 'job' },
    { id: 'reverse', status: 'accepted' },
  ];
  const rows = actions({ estimates, jobs: [job, { id: 'other', estimateId: 'reverse', status: 'complete' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].href, '#/estimates/accepted');
  assert.equal(rows[0].action, 'Create job');
});

test('flags unscheduled accepted work once per job, respecting start dates, visits and completed work', () => {
  const jobs = [
    { id: 'missing', status: 'scheduled' }, { id: 'dated', status: 'scheduled', startDate: '2026-10-22' },
    { id: 'visit', status: 'scheduled' }, { id: 'complete', status: 'complete' },
    { id: 'active', status: 'in-progress' },
  ];
  const estimates = jobs.map((j) => ({ id: `quote-${j.id}`, jobId: j.id, status: 'accepted' }));
  estimates.push({ id: 'second', jobId: 'missing', status: 'accepted' });
  const rows = actions({ jobs, estimates, schedule: [
    { jobId: 'missing', date: '2026-10-19' }, { jobId: 'visit', date: '2026-10-20' },
  ] });
  assert.deepEqual(rows.map((r) => r.href), ['#/jobs/missing?tab=schedule']);
  assert.deepEqual(actions({ jobs, estimates, can: (p) => p !== 'schedule' }), []);
});

test('T&M actions use approved unbilled work and exclude work already invoiced', () => {
  assert.deepEqual(actions({ jobs: [job], tmSources: { timeEntries: [{ ...entry, approved: false }] } }), []);
  const rows = actions({ jobs: [job], tmSources: { timeEntries: [entry] } });
  assert.equal(rows[0].detail, '$100 ready to bill before tax');
  assert.equal(rows[0].href, '#/jobs/job?tab=money');
  assert.deepEqual(actions({ jobs: [job], tmSources: { timeEntries: [entry], invoices: [{ status: 'draft', tm: { timeEntryIds: ['time'] } }] } }), []);
  assert.deepEqual(actions({ jobs: [{ ...job, billingMode: 'fixed' }], tmSources: { timeEntries: [entry] } }), []);
});

test('material without a cost gets a price-review action rather than claiming zero due', () => {
  const rows = actions({ jobs: [job], tmSources: { materialRequests: [
    { id: 'request', jobId: 'job', status: 'fulfilled', qty: 1, description: 'Panel', fulfilledAt: '2026-10-19' },
  ] } });
  assert.equal(rows[0].kind, 'unbilled');
  assert.match(rows[0].detail, /needs a price/);
});

test('all actions respect disabled modules, role permissions and fallback routes', () => {
  const data = { tasks: [{ id: 'task', status: 'blocked' }], estimates: [{ id: 'estimate', status: 'accepted' }] };
  assert.deepEqual(actions({ ...data, can: () => false }), []);
  assert.deepEqual(actions({ ...data, settings: { modules: { workplan: false, estimates: false } } }), []);
  assert.deepEqual(actions({ tasks: data.tasks, can: (p) => p !== 'today' }), []);
  assert.equal(dashboardRouteAllowed({}, (p) => p === 'jobs', '#/materials'), true);
  assert.equal(dashboardRouteAllowed({ modules: { materials: false } }, () => true, '#/materials'), false);
  assert.equal(dashboardRouteAllowed({}, (p) => p !== 'invoices', '#/invoices/secret'), false);
  assert.equal(dashboardRouteAllowed({}, () => true, 'https://example.com'), false);
});

test('no false overdue action for a settled invoice or false blocker for completed work', () => {
  assert.deepEqual(actions({ overdue: [{ id: 'settled', balanceCents: 0 }], tasks: [{ id: 'done', status: 'done' }] }), []);
});
