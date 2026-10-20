// Run: node --test electrical-app/tests/*.test.mjs
// Timestamps use local noon so "the day it was done" is the same day in every time zone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../js/lib/kpis.js';
import { newTask, newPlan } from '../js/lib/workplan.js';

const at = (day, h = 12) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`).toISOString();
const T = (f) => newTask({ status: 'todo', estHours: 4, ...f });

const tasks = [
  // a: two boxes tasks done (one late), one blocked for 3 h then done
  T({ id: 'a1', employeeId: 'a', date: '2026-10-19', baselineDate: '2026-10-19', status: 'done', completedAt: at('2026-10-19'), actualHours: 5, qty: 40, qtyDone: 40, unit: 'boxes', taskType: 'Boxes', requiresPhoto: true, photos: [{ id: 'p', dataUrl: 'data:x' }] }),
  T({ id: 'a2', employeeId: 'a', date: '2026-10-20', baselineDate: '2026-10-20', status: 'done', completedAt: at('2026-10-21'), actualHours: 3, qty: 20, qtyDone: 20, unit: 'boxes', taskType: 'Boxes', requiresPhoto: true, photos: [] , evidenceWaived: { by: 'f' } }),
  T({ id: 'a3', employeeId: 'a', date: '2026-10-21', status: 'done', completedAt: at('2026-10-21', 16), actualHours: 4, taskType: 'Home runs', qtyDone: 2, unit: 'runs',
    blocks: [{ reason: 'Waiting on material', at: at('2026-10-21', 9), resolvedAt: at('2026-10-21', 12) }], reopens: [{ at: 'x', by: 'f', reason: 'Redo' }] }),
  // b: one open, one blocked right now, one draft (ignored)
  T({ id: 'b1', employeeId: 'b', date: '2026-10-19', status: 'todo' }),
  T({ id: 'b2', employeeId: 'b', date: '2026-10-20', status: 'blocked', blocks: [{ reason: 'No access to the area', at: at('2026-10-20', 8), resolvedAt: null }] }),
  T({ id: 'b3', employeeId: 'b', date: '2026-10-20', status: 'draft' }),
  // outside the range
  T({ id: 'c1', employeeId: 'a', date: '2026-11-02', status: 'done', completedAt: at('2026-11-02') }),
];

describe('worker and crew KPIs', () => {
  const now = new Date(at('2026-10-20', 10));
  const k = K.crewKpis(tasks, { from: '2026-10-19', to: '2026-10-23', now });
  const a = k.workers.find((w) => w.employeeId === 'a');
  const b = k.workers.find((w) => w.employeeId === 'b');

  test('completed and on-time', () => {
    assert.equal(a.assigned, 3);
    assert.equal(a.completed, 3);
    assert.equal(a.onTime, 2, 'a2 was done the day after');
    assert.equal(a.onTimePct, 66.7);
    assert.equal(b.assigned, 2, 'drafts are not assigned work');
    assert.equal(b.completed, 0);
    assert.equal(b.onTimePct, null, 'nothing to measure, not 0%');
  });

  test('planned vs actual hours', () => {
    assert.equal(a.plannedHoursDone, 12);
    assert.equal(a.actualHours, 12);
    assert.equal(a.hoursRatio, 1);
    assert.equal(b.plannedHours, 8);
  });

  test('quantity per hour by task type', () => {
    assert.deepEqual(a.byType.map((x) => [x.type, x.qty, x.hours, x.perHour]), [['Boxes', 60, 8, 7.5], ['Home runs', 2, 4, 0.5]]);
  });

  test('blocked time and reasons (open blocks count up to now)', () => {
    assert.equal(a.blockedHours, 3);
    assert.deepEqual(a.blockReasons, [{ reason: 'Waiting on material', count: 1, hours: 3 }]);
    assert.equal(b.blockedHours, 2, 'blocked since 08:00, now 10:00');
    assert.equal(K.blockedHours(tasks[4], new Date(at('2026-10-20', 14))), 6);
  });

  test('evidence compliance (a waiver is not a photo) and rework', () => {
    assert.equal(a.evidenceRequired, 2);
    assert.equal(a.evidenceProvided, 1);
    assert.equal(a.evidenceWaived, 1);
    assert.equal(a.evidencePct, 50);
    assert.equal(a.reopened, 1);
    assert.equal(a.reworkPct, 33.3);
  });

  test('crew total and range', () => {
    assert.equal(k.crew.assigned, 5);
    assert.equal(k.crew.completed, 3);
    assert.ok(!k.workers.some((w) => w.employeeId === 'c'));
    const onlyB = K.crewKpis(tasks, { from: '2026-10-19', to: '2026-10-23', employeeIds: ['b', 'z'], now });
    assert.deepEqual(onlyB.workers.map((w) => [w.employeeId, w.assigned]), [['b', 2], ['z', 0]]);
  });

  test('CSV export: one row per worker plus the crew, formulas defused', () => {
    const csv = K.kpiCsv(k, { name: (id) => (id === 'a' ? '=Alex' : 'Bea, B.'), from: '2026-10-19', to: '2026-10-23' });
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^Worker,From,To,Assigned/);
    assert.match(lines[1], /^'=Alex,2026-10-19,2026-10-23,3,3,100,2,66.7/);
    assert.match(lines[2], /^"Bea, B\."/);
    assert.match(lines[3], /^Crew total/);
    const tcsv = K.tasksCsv(tasks.slice(0, 2), { name: () => 'A' });
    assert.equal(tcsv.split('\r\n').length, 3);
  });
});

describe('job progress', () => {
  const plan = { id: 'p', ...newPlan({ startDate: '2026-10-19', workingDays: 10, phases: [{ id: 'ph1', name: 'Rough-in' }, { id: 'ph2', name: 'Service' }] }) };
  const list = [];
  // 10 days x 8 h planned; first 3 days done, day 4 half done (qty)
  plan.endDate && ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].forEach((d, i) => {
    list.push(newTask({ id: `t${i}`, planId: 'p', phaseId: i < 5 ? 'ph1' : 'ph2', date: d, estHours: 8, qty: 10, status: i < 3 ? 'done' : 'todo',
      completedAt: i < 3 ? at(d) : null, qtyDone: i === 3 ? 5 : null, progressAt: i === 3 ? at(d) : (i < 3 ? at(d) : null) }));
  });

  test('% complete overall and by phase', () => {
    const j = K.jobProgress(plan, list, { today: '2026-10-22' });
    assert.equal(j.totalHours, 80);
    assert.equal(j.earnedHours, 28);
    assert.equal(j.pct, 35);
    assert.deepEqual(j.phases.map((p) => [p.name, p.pct]), [['Rough-in', 70], ['Service', 0]]);
  });

  test('burn-up vs plan and a forecast finish at the pace so far', () => {
    const j = K.jobProgress(plan, list, { today: '2026-10-22' });
    assert.equal(j.burnup.length, 10);
    assert.deepEqual(j.burnup.slice(0, 5).map((b) => [b.planned, b.actual]), [[8, 8], [16, 16], [24, 24], [32, 28], [40, null]]);
    assert.equal(j.plannedToDate, 32);
    assert.equal(j.aheadBy, -4);
    // 28 h in 4 working days = 7 h/day; 52 h left = 8 more days after today → Nov 3
    assert.equal(j.forecastFinish, '2026-11-03');
    assert.equal(j.plannedFinish, '2026-10-30');
    assert.equal(j.lateBy, 2);
  });

  test('no progress yet: no forecast; all done: finish is the last completion', () => {
    assert.equal(K.jobProgress(plan, list.map((t) => ({ ...t, status: 'todo', qtyDone: null })), { today: '2026-10-22' }).forecastFinish, null);
    const done = list.map((t) => ({ ...t, status: 'done', completedAt: at(t.date) }));
    assert.equal(K.jobProgress(plan, done, { today: '2026-10-30' }).forecastFinish, '2026-10-30');
  });

  test('work on a day off counts from the next working day', () => {
    const extra = [...list, newTask({ id: 'sat', planId: 'p', phaseId: 'ph2', date: '2026-10-26', estHours: 4, status: 'done', completedAt: at('2026-10-24') })];
    const j = K.jobProgress(plan, extra, { today: '2026-10-27' });
    const fri = j.burnup.find((b) => b.date === '2026-10-23');
    const mon = j.burnup.find((b) => b.date === '2026-10-26');
    assert.equal(fri.actual, 28);
    assert.equal(mon.actual, 32);
  });
});
