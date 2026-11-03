// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifiedRows, certifiedCsv } from '../js/lib/certified-payroll.js';

const people = new Map([['e1', { id: 'e1', name: 'Kelvin', rateCents: 4200 }], ['e2', { id: 'e2', name: 'Travis' }]]);
const jobs = new Map([['j1', { id: 'j1', name: 'School reno' }], ['j2', { id: 'j2', name: 'City hall' }]]);
const levels = { L1: { id: 'L1', name: 'Journeyman', costCents: 4000 }, L2: { id: 'L2', name: 'Apprentice — 1st year', costCents: 2200 } };
const empLevel = { e1: 'L1', e2: 'L2' };
const ctx = {
  people, jobs,
  levelOf: (id) => levels[empLevel[id]] || null,
  rateFor: (id, level) => Number(people.get(id)?.rateCents) || (level?.costCents || 0),
};

test('rolls up to one row per job x worker x classification with hours and gross', () => {
  const entries = [
    { employeeId: 'e1', jobId: 'j1', minutes: 480 }, // 8 h
    { employeeId: 'e1', jobId: 'j1', minutes: 120 }, // +2 h same job/worker -> merges to 10 h
    { employeeId: 'e2', jobId: 'j1', minutes: 300 }, // 5 h apprentice
    { employeeId: 'e1', jobId: 'j2', minutes: 240 }, // 4 h other job
  ];
  const rows = certifiedRows(entries, ctx);
  assert.equal(rows.length, 3); // (j1,e1), (j1,e2), (j2,e1)
  const j1e1 = rows.find((r) => r.jobId === 'j1' && r.employeeId === 'e1');
  assert.equal(j1e1.hours, 10);
  assert.equal(j1e1.classification, 'Journeyman');
  assert.equal(j1e1.rateCents, 4200); // worker's own rate wins over the level cost
  assert.equal(j1e1.grossCents, 42000); // 10 h * $42
  const j1e2 = rows.find((r) => r.employeeId === 'e2');
  assert.equal(j1e2.rateCents, 2200); // no worker rate -> falls back to the level cost rate
  assert.equal(j1e2.classification, 'Apprentice — 1st year');
});

test('workers with no level show as Unassigned; entries with no job group under No job', () => {
  const rows = certifiedRows([{ employeeId: 'eX', jobId: null, minutes: 60 }], { ...ctx, levelOf: () => null, rateFor: () => 0 });
  assert.equal(rows[0].classification, 'Unassigned');
  assert.equal(rows[0].jobName, 'No job');
});

test('certifiedCsv has a header, a row per entry and a totals line', () => {
  const rows = certifiedRows([{ employeeId: 'e1', jobId: 'j1', minutes: 600 }], ctx);
  const csv = certifiedCsv(rows, { from: '2026-10-01', to: '2026-10-31' });
  const out = csv.split('\n');
  assert.match(out[0], /Certified payroll 2026-10-01 to 2026-10-31/);
  assert.match(out[1], /Project,Worker,Classification,Hours/);
  assert.match(out.at(-1), /^TOTAL,,,10\.00,,420\.00$/); // 10 h * $42/h = $420
});
