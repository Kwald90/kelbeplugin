// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../js/lib/workplan.js';

const ids = () => { let n = 0; return () => `t${++n}`; };

describe('dates and working days', () => {
  test('adds days across month ends and DST without drifting', () => {
    assert.equal(W.addDays('2026-02-27', 2), '2026-03-01');
    assert.equal(W.addDays('2026-03-07', 2), '2026-03-09'); // spring forward weekend
    assert.equal(W.addDays('2026-11-01', -1), '2026-10-31');
    assert.equal(W.daysBetween('2026-10-19', '2026-11-02'), 14);
    assert.equal(W.dayOfWeek('2026-10-19'), 1); // Monday
  });

  test('a 35-working-day plan skips weekends and holidays', () => {
    const start = '2026-10-19';
    const holidays = W.holidaysBetween(start, '2027-01-31', 'ON').map((h) => h.date);
    const end = W.endAfterWorkDays(start, 35, { skipWeekends: true, holidays });
    const days = W.workDays({ startDate: start, endDate: end, skipWeekends: true, holidays });
    assert.equal(days.length, 35);
    assert.equal(days[0], start);
    assert.equal(days.at(-1), end);
    assert.ok(days.every((d) => !W.isWeekend(d)));
    assert.equal(end, '2026-12-04', 'no Ontario holidays in these seven weeks');
    const bcHolidays = W.holidaysBetween(start, '2027-01-31', 'BC').map((h) => h.date);
    assert.ok(bcHolidays.includes('2026-11-11'));
    assert.equal(W.endAfterWorkDays(start, 35, { holidays: bcHolidays }), '2026-12-07', 'Remembrance Day is off in BC');
    const winter = W.workDays({ startDate: '2026-12-21', endDate: '2027-01-08', holidays });
    assert.ok(!winter.includes('2026-12-25') && !winter.includes('2026-12-28') && !winter.includes('2027-01-01'), 'Christmas, Boxing Day (observed) and New Year off');
    assert.equal(winter.length, 12);
    // Weekends kept: 35 calendar days
    assert.equal(W.endAfterWorkDays(start, 35, { skipWeekends: false }), '2026-11-22');
  });

  test('provincial holidays, with weekend dates observed on the next weekday', () => {
    const on = W.holidaysFor(2026, 'ON');
    const names = Object.fromEntries(on.map((h) => [h.name, h.date]));
    assert.equal(names['Good Friday'], '2026-04-03');
    assert.equal(names['Victoria Day'], '2026-05-18');
    assert.equal(names['Family Day'], '2026-02-16');
    assert.equal(names.Thanksgiving, '2026-10-12');
    assert.equal(names['Christmas Day'], '2026-12-25');
    assert.equal(names['Boxing Day'], '2026-12-28', 'Dec 26 2026 is a Saturday');
    const bc = W.holidaysFor(2027, 'BC').map((h) => h.name);
    assert.ok(bc.includes('National Day for Truth and Reconciliation'));
    assert.ok(!W.holidaysFor(2027, 'ON').some((h) => h.name.includes('Truth')));
    const c2027 = W.holidaysFor(2027, 'ON');
    assert.equal(c2027.find((h) => h.name === 'Christmas Day').date, '2027-12-27', 'Saturday → Monday');
    assert.equal(c2027.find((h) => h.name === 'Boxing Day').date, '2027-12-28', 'Sunday → Tuesday');
  });

  test('next working day skips the weekend', () => {
    assert.equal(W.nextWorkDay('2026-10-23'), '2026-10-26');
    assert.equal(W.nextWorkDay('2026-10-23', { skipWeekends: false }), '2026-10-24');
  });
});

describe('spreading and capacity', () => {
  test('400 boxes over 10 days by a crew of 4: 10 each, hours from the rate', () => {
    const days = W.workDays({ startDate: '2026-10-19', endDate: '2026-10-30' });
    assert.equal(days.length, 10);
    const tasks = W.spreadTask({ base: { title: 'Mount boxes', unit: 'boxes' }, days, workers: ['a', 'b', 'c', 'd'], totalQty: 400, ratePerHour: 8, groupId: 'g1' });
    assert.equal(tasks.length, 40);
    assert.ok(tasks.every((t) => t.qty === 10 && t.estHours === 1.25 && t.status === 'draft' && t.groupId === 'g1'));
    assert.equal(tasks.reduce((s, t) => s + t.qty, 0), 400);
    assert.deepEqual([...new Set(tasks.map((t) => t.employeeId))], ['a', 'b', 'c', 'd']);
  });

  test('remainders go to the first slots; nothing-left slots are skipped', () => {
    assert.deepEqual(W.splitEven(10, 3, { integer: true }), [4, 3, 3]);
    assert.deepEqual(W.splitEven(10, 3), [3.33, 3.33, 3.34]);
    const t = W.spreadTask({ days: ['2026-10-19', '2026-10-20'], workers: ['a', 'b'], totalQty: 3, totalHours: 6 });
    assert.deepEqual(t.map((x) => [x.date, x.employeeId, x.qty]), [['2026-10-19', 'a', 1], ['2026-10-19', 'b', 1], ['2026-10-20', 'a', 1]]);
    assert.equal(t.reduce((s, x) => s + x.estHours, 0), 4.5, 'hours split over the four slots, the empty one dropped');
    const hoursOnly = W.spreadTask({ days: ['2026-10-19'], workers: ['a', 'b'], totalHours: 7 });
    assert.deepEqual(hoursOnly.map((x) => x.estHours), [3.5, 3.5]);
  });

  test('capacity warnings when planned hours exceed the day', () => {
    const tasks = [
      { employeeId: 'a', date: '2026-10-19', estHours: 6 }, { employeeId: 'a', date: '2026-10-19', estHours: 3 },
      { employeeId: 'b', date: '2026-10-19', estHours: 8 }, { employeeId: null, date: '2026-10-19', estHours: 20 },
    ];
    assert.deepEqual(W.capacityWarnings(tasks), [{ employeeId: 'a', date: '2026-10-19', hours: 9, capacity: 8, overBy: 1 }]);
    assert.deepEqual(W.capacityWarnings(tasks, (id) => (id === 'b' ? 6 : 10)).map((w) => w.employeeId), ['b']);
  });
});

describe('publishing and moving', () => {
  const plan = { id: 'p', published: { '2026-10-19': { at: 'x' } } };

  test('publish a day: assigned drafts go out; unassigned and past days do not', () => {
    const tasks = [
      { id: '1', date: '2026-10-20', status: 'draft', employeeId: 'a', title: 'Boxes' },
      { id: '2', date: '2026-10-20', status: 'draft', employeeId: null, title: 'Spare' },
      { id: '3', date: '2026-10-20', status: 'todo', employeeId: 'a', title: 'Already out' },
      { id: '4', date: '2026-10-21', status: 'draft', employeeId: 'a', title: 'Next day' },
    ];
    const r = W.publishDay(tasks, '2026-10-20', { now: '2026-10-19T21:00:00Z', by: 'f', today: '2026-10-19' });
    assert.deepEqual(r.patches.map((p) => p.id), ['1']);
    assert.deepEqual(r.patches[0].patch, { status: 'todo', publishedAt: '2026-10-19T21:00:00Z', publishedBy: 'f', baselineDate: '2026-10-20', lateAdd: false });
    assert.deepEqual(r.skipped, [{ id: '2', reason: 'unassigned' }]);
    assert.match(W.publishDay(tasks, '2026-10-18', { today: '2026-10-19' }).error, /over/);
  });

  test('a task added to a published day goes out at once with a "new" badge', () => {
    const p = W.placement(plan, '2026-10-19', { now: 'n', by: 'f' });
    assert.equal(p.status, 'todo');
    assert.equal(p.lateAdd, true);
    assert.equal(W.placement(plan, '2026-10-20').status, 'draft');
    assert.ok(W.isNew({ ...p, seenAt: null }));
    assert.ok(!W.isNew({ ...p, seenAt: 'later' }));
  });

  test('moving: drafts onto a published day are published; done tasks stay put', () => {
    assert.equal(W.moveTask({ status: 'draft' }, '2026-10-19', plan).patch.status, 'todo');
    assert.deepEqual(W.moveTask({ status: 'todo' }, '2026-10-22', plan).patch, { date: '2026-10-22' });
    assert.ok(W.moveTask({ status: 'done' }, '2026-10-22', plan).error);
  });

  test('reassigning: drafts change hands; published tasks are replaced; started work stays', () => {
    assert.deepEqual(W.reassign({ id: '1', status: 'draft', employeeId: 'a' }, 'b').patch, { employeeId: 'b' });
    const r = W.reassign({ id: '1', status: 'todo', employeeId: 'a', title: 'X', seenAt: 'y', createdAt: 'c' }, 'b', { newId: '2', now: 'n', by: 'f' });
    assert.equal(r.replace.removeId, '1');
    assert.equal(r.replace.add.id, '2');
    assert.equal(r.replace.add.employeeId, 'b');
    assert.equal(r.replace.add.seenAt, null);
    assert.equal(r.replace.add.movedFrom, '1');
    assert.equal(r.replace.add.createdAt, undefined);
    assert.ok(W.reassign({ id: '1', status: 'in-progress', employeeId: 'a', startedAt: 'x' }, 'b').error);
  });

  test('copy a day and order a day', () => {
    const src = [{ id: 'a', date: '2026-10-19', title: 'Late', order: 2, status: 'done', photos: [{ dataUrl: 'x' }] }, { id: 'b', date: '2026-10-19', title: 'First', order: 1, priority: 'high' }];
    const c = W.copyDay(src, '2026-10-19', '2026-10-20');
    assert.deepEqual(c.map((t) => [t.title, t.date, t.status, t.photos.length]), [['First', '2026-10-20', 'draft', 0], ['Late', '2026-10-20', 'draft', 0]]);
    assert.deepEqual(W.copyDay(src, '2026-10-19', '2026-10-20', { keepAssignees: false }).map((t) => t.employeeId), [null, null]);
  });

  test('dependencies by task or group id', () => {
    const all = [{ id: 'a', groupId: 'g', status: 'todo' }, { id: 'b', groupId: 'g', status: 'done' }, { id: 'c', status: 'todo', dependsOn: ['g'] }];
    assert.deepEqual(W.waitingOn(all[2], all).map((t) => t.id), ['a']);
  });
});

describe('the worker\'s day', () => {
  const task = W.newTask({ id: 't', employeeId: 'e', date: '2026-10-19', status: 'todo', requiresPhoto: true, minPhotos: 1, qty: 40, estHours: 6 });

  test('a photo-required task cannot be completed without its photo', () => {
    const r = W.completeTask(task, { now: '2026-10-19T20:00:00Z', by: 'e' });
    assert.match(r.error, /photo/);
    const ok = W.completeTask({ ...task, photos: [{ id: 'p', dataUrl: 'data:image/jpeg;base64,AA' }] }, { now: '2026-10-19T20:00:00Z', by: 'e', actualHours: '5.5', qtyDone: 38 });
    assert.equal(ok.patch.status, 'done');
    assert.equal(ok.patch.actualHours, 5.5);
    assert.equal(ok.patch.qtyDone, 38);
    assert.equal(ok.patch.progressAt, '2026-10-19T20:00:00Z');
    assert.equal(W.completeTask({ ...task, evidenceWaived: { by: 'f' } }).patch.status, 'done', 'a foreman waiver stands in');
    assert.equal(W.photosNeeded({ requiresPhoto: true, minPhotos: 3 }), 3);
    assert.match(W.evidenceProblem({ requiresPhoto: true, minPhotos: 2, photos: [{ dataUrl: 'x' }] }), /2 photos.*1 so far/);
  });

  test('block, unblock, start, undo and reopen', () => {
    const b = W.blockTask(task, 'Waiting on material', { now: '2026-10-19T15:00:00Z', by: 'e', note: 'No boxes on site' });
    assert.equal(b.status, 'blocked');
    assert.equal(b.blocks.length, 1);
    assert.equal(b.blocks[0].resolvedAt, null);
    const u = W.unblockTask({ ...task, ...b }, { now: '2026-10-19T17:00:00Z' });
    assert.equal(u.status, 'in-progress');
    assert.equal(u.blocks[0].resolvedAt, '2026-10-19T17:00:00Z');
    const s = W.startTask(task, { now: 'n' });
    assert.equal(s.startedAt, 'n');
    assert.equal(W.undoComplete({ ...task, status: 'done' }).status, 'in-progress');
    const r = W.reopenTask({ ...task, status: 'done' }, 'Missing bonding jumper', { now: 'n', by: 'f' });
    assert.equal(r.reopens.length, 1);
    assert.equal(r.completedAt, null);
  });

  test('my day: published tasks only, in order, plus carry-over', () => {
    const all = [
      { id: '1', employeeId: 'e', date: '2026-10-19', status: 'todo', order: 2 },
      { id: '2', employeeId: 'e', date: '2026-10-19', status: 'draft', order: 1 },
      { id: '3', employeeId: 'e', date: '2026-10-19', status: 'done', order: 1 },
      { id: '4', employeeId: 'x', date: '2026-10-19', status: 'todo' },
      { id: '5', employeeId: 'e', date: '2026-10-16', status: 'blocked' },
      { id: '6', employeeId: 'e', date: '2026-10-16', status: 'done' },
    ];
    assert.deepEqual(W.tasksFor(all, 'e', '2026-10-19').map((t) => t.id), ['3', '1']);
    assert.deepEqual(W.carriedOver(all, 'e', '2026-10-19').map((t) => t.id), ['5']);
  });
});

describe('write rules shared with the API', () => {
  const worker = { isManager: false, employeeId: 'e' };
  const foreman = { isManager: true, employeeId: 'f' };
  const stored = W.newTask({ id: 't', employeeId: 'e', date: '2026-10-19', status: 'todo', title: 'Mount boxes', requiresPhoto: true });

  test('a worker records progress on their own published task, nothing else', () => {
    assert.equal(W.taskWriteProblem(worker, stored, { ...stored, status: 'in-progress', note: 'started' }), null);
    assert.match(W.taskWriteProblem(worker, stored, { ...stored, title: 'Easier task' }), /progress/);
    assert.match(W.taskWriteProblem(worker, { ...stored, employeeId: 'x' }, { ...stored, employeeId: 'x', note: 'hi' }), /own tasks/);
    assert.match(W.taskWriteProblem(worker, null, stored), /foreman/);
    assert.match(W.taskWriteProblem(worker, stored, null), /foreman/);
    assert.match(W.taskWriteProblem(worker, { ...stored, status: 'draft' }, { ...stored, status: 'todo' }), /not been published/);
    assert.match(W.taskWriteProblem(worker, stored, { ...stored, status: 'draft' }), /draft/);
    assert.match(W.taskWriteProblem({ isManager: false, employeeId: null }, stored, stored), /not linked/);
  });

  test('completion without the photo is refused for everyone; a foreman can waive it', () => {
    assert.match(W.taskWriteProblem(worker, stored, { ...stored, status: 'done' }), /photo/);
    assert.match(W.taskWriteProblem(foreman, stored, { ...stored, status: 'done' }), /photo/);
    assert.equal(W.taskWriteProblem(foreman, stored, { ...stored, status: 'done', evidenceWaived: { by: 'f', reason: 'Camera broke' } }), null);
    assert.equal(W.taskWriteProblem(worker, stored, { ...stored, status: 'done', photos: [{ id: 'p', dataUrl: 'data:image/jpeg;base64,AA' }] }), null);
    assert.equal(W.taskWriteProblem(foreman, null, { ...stored, status: 'draft' }), null);
  });

  test('merge: a worker\'s offline completion survives a foreman\'s later edit, and vice versa', () => {
    const foremanEdit = { ...stored, title: 'Mount boxes, level 2', updatedAt: '2026-10-19T16:00:00Z' };
    const workerCopy = { ...stored, status: 'done', completedAt: '2026-10-19T15:00:00Z', progressAt: '2026-10-19T15:00:00Z', photos: [{ id: 'p', dataUrl: 'x' }], title: 'Mount boxes' };
    const m = W.mergeTask(foremanEdit, workerCopy, { worker: true });
    assert.equal(m.title, 'Mount boxes, level 2', "the worker's stale title is ignored");
    assert.equal(m.status, 'done', 'the completion is kept');
    assert.equal(W.taskWriteProblem(worker, foremanEdit, m), null);
    // The foreman's stale copy (from before the completion) does not undo it.
    const stale = { ...stored, description: 'Use 4" square boxes' };
    const m2 = W.mergeTask(m, stale);
    assert.equal(m2.status, 'done');
    assert.equal(m2.description, 'Use 4" square boxes');
    // A foreman's reopen is newer progress and wins over the worker's older copy.
    const reopened = { ...m, ...W.reopenTask(m, 'Redo', { now: '2026-10-19T18:00:00Z', by: 'f' }) };
    assert.equal(W.mergeTask(reopened, workerCopy, { worker: true }).status, 'in-progress');
    // "Got it" and "seen" are kept once set; publishing can't be undone by an old draft copy.
    assert.equal(W.mergeTask({ ...stored, ackAt: 'a' }, { ...stored, ackAt: null }).ackAt, 'a');
    assert.equal(W.mergeTask(stored, { ...stored, status: 'draft' }).status, 'todo');
  });

  test('events: published and blocked', () => {
    assert.deepEqual(W.taskEvents({ status: 'draft' }, { status: 'todo', employeeId: 'e', date: 'd', title: 'X' }).map((e) => e.kind), ['published']);
    assert.deepEqual(W.taskEvents(null, { status: 'todo', lateAdd: true }).map((e) => e.lateAdd), [true]);
    const b = W.taskEvents({ status: 'todo' }, { status: 'blocked', blocks: [{ reason: 'No access to the area' }] });
    assert.deepEqual(b.map((e) => [e.kind, e.reason]), [['blocked', 'No access to the area']]);
    assert.deepEqual(W.taskEvents({ status: 'todo' }, { status: 'in-progress' }), []);
  });
});

describe('plans and the demo', () => {
  test('new plan from a start date and 35 working days', () => {
    const p = W.newPlan({ jobId: 'j', startDate: '2026-10-19', workingDays: 35, crewIds: ['a'] });
    assert.equal(W.planDays(p).length, 35);
    assert.equal(p.phases.length, W.DEFAULT_PHASES.length);
    assert.deepEqual(p.published, {});
  });

  test('demo plan seeds published days and finished work', () => {
    const rows = new Map();
    const next = ids();
    const store = {
      add(c, f) { const r = { ...structuredClone(f), id: f.id || next(), createdAt: 'c' }; rows.set(r.id, { c, r }); return structuredClone(r); },
      update(c, id, p) { Object.assign(rows.get(id).r, structuredClone(p)); },
    };
    const plan = W.seedDemoPlan(store, { today: '2026-10-21', employees: [{ id: 'e1' }, { id: 'e2' }] });
    const tasks = [...rows.values()].filter((x) => x.c === 'workTasks').map((x) => x.r);
    assert.ok(tasks.length > 10);
    assert.ok(tasks.some((t) => t.date === '2026-10-21' && t.status === 'todo'));
    assert.ok(tasks.some((t) => t.date < '2026-10-21' && t.status === 'done'));
    assert.ok(rows.get(plan.id).r.published['2026-10-22'], 'tomorrow is published');
  });
});
