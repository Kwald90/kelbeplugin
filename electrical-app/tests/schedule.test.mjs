// Run: node --test electrical-app/tests/*.test.mjs
// Schedule (S16): start/end times with the numeric hours other screens read, Day/Week/Month ranges,
// the Day timeline's segments and lanes, drag-to-move patches and where the screen opens.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../js/lib/schedule.js';

describe('start and end times', () => {
  test('parses and formats clock times', () => {
    assert.equal(S.parseTime('07:30'), 450);
    assert.equal(S.parseTime('7:05'), 425);
    assert.equal(S.parseTime('24:00'), null);
    assert.equal(S.parseTime('12:60'), null);
    assert.equal(S.parseTime(''), null);
    assert.equal(S.parseTime(undefined), null);
    assert.equal(S.toTime(450), '07:30');
    assert.equal(S.toTime(1440 + 120), '02:00', 'wraps past midnight');
    assert.equal(S.toTime(-30), '23:30');
  });

  test('hours between a start and an end, rolling past midnight', () => {
    assert.equal(S.spanHours('07:00', '15:30'), 8.5);
    assert.equal(S.spanHours('07:00', '15:45'), 8.75);
    assert.equal(S.spanHours('22:00', '06:00'), 8, 'a night shift ends the next morning');
    assert.equal(S.spanHours('16:00', '00:00'), 8);
    assert.equal(S.spanHours('07:00', '07:00'), 0, 'equal times are refused by the form, not read as 24 h');
    assert.equal(S.spanHours('7', '15:00'), null);
    assert.equal(S.isOvernight('22:00', '06:00'), true);
    assert.equal(S.isOvernight('16:00', '00:00'), false, 'ending at midnight is still the same day');
    assert.equal(S.isOvernight('07:00', '15:00'), false);
  });

  test('a form save writes both times and a numeric hours field', () => {
    assert.deepEqual(S.timeFields('7:00', '15:30'), { startTime: '07:00', endTime: '15:30', hours: 8.5 });
    assert.deepEqual(S.timeFields('19:00', '03:30'), { startTime: '19:00', endTime: '03:30', hours: 8.5 });
    assert.equal(typeof S.timeFields('06:00', '14:00').hours, 'number');
    assert.equal(S.timeFields('', '14:00'), null);
  });

  test('hours-only records read as 07:00 plus their hours', () => {
    const t = S.entryTimes({ date: '2026-11-25', hours: 8 });
    assert.equal(t.startTime, '07:00');
    assert.equal(t.endTime, '15:00');
    assert.equal(t.hours, 8);
    assert.equal(t.legacy, true);
    assert.equal(S.entryTimes({ hours: 10.5 }).endTime, '17:30');
    assert.equal(S.entryTimes({ hours: 18 }).overnight, true, '07:00 + 18 h runs past midnight');
    assert.equal(S.entryTimes({}).hours, S.DEFAULT_HOURS, 'no hours at all reads as a normal day');
    assert.equal(S.entryTimes({ hours: '6' }).endTime, '13:00', 'a string hours value still reads');
  });

  test('records with times use them, overnight included', () => {
    const t = S.entryTimes({ startTime: '21:00', endTime: '05:00', hours: 8 });
    assert.deepEqual([t.startMin, t.endMin, t.hours, t.overnight, t.legacy], [1260, 1740, 8, true, false]);
    assert.equal(S.entryTimes({ startTime: '06:30', endTime: '15:00', hours: 99 }).hours, 8.5, 'the times win over a stale hours');
  });

  test('chip labels in 12- and 24-hour styles', () => {
    assert.equal(S.clockLabel(420, true), '7a');
    assert.equal(S.clockLabel(930, true), '3:30p');
    assert.equal(S.clockLabel(720, true), '12p');
    assert.equal(S.clockLabel(0, true), '12a');
    assert.equal(S.clockLabel(930, false), '15:30');
    assert.equal(S.rangeLabel({ startTime: '07:00', endTime: '15:30' }, true), '7a–3:30p');
    assert.equal(S.rangeLabel({ startTime: '22:00', endTime: '06:00' }), '22:00–06:00 +1');
    assert.equal(S.rangeLabel({ hours: 8 }), '07:00–15:00');
    assert.equal(S.hoursLabel(8), '8h');
    assert.equal(S.hoursLabel(7.75), '7.75h');
    assert.equal(S.hoursLabel(null), '0h');
  });

  test('shifting a bar keeps its length, snaps to 15 minutes and stays on its day', () => {
    assert.deepEqual(S.shiftTimes({ startTime: '07:00', endTime: '15:00' }, 62), { startTime: '08:00', endTime: '16:00', hours: 8 });
    assert.deepEqual(S.shiftTimes({ startTime: '07:00', endTime: '15:00' }, -500), { startTime: '00:00', endTime: '08:00', hours: 8 });
    assert.deepEqual(S.shiftTimes({ hours: 4 }, 30), { startTime: '07:30', endTime: '11:30', hours: 4 }, 'hours-only records gain times');
    assert.equal(S.shiftTimes({ startTime: '20:00', endTime: '04:00' }, 10000).startTime, '23:45');
    assert.equal(S.snapMinutes(437, 30), 450);
  });

  test('the usual hours on this device, with a safe default', () => {
    assert.deepEqual(S.rememberedTimes(null), { startTime: '07:00', endTime: '15:00' });
    assert.deepEqual(S.rememberedTimes('{"startTime":"6:30","endTime":"15:00"}'), { startTime: '06:30', endTime: '15:00' });
    assert.deepEqual(S.rememberedTimes('{"startTime":"07:00","endTime":"07:00"}'), { startTime: '07:00', endTime: '15:00' }, 'a zero-length pair is ignored');
    assert.deepEqual(S.rememberedTimes('not json'), { startTime: '07:00', endTime: '15:00' });
  });
});

describe('days, weeks and months', () => {
  test('week and month arithmetic across month and DST edges', () => {
    assert.equal(S.weekStart('2026-11-25'), '2026-11-23', 'Monday');
    assert.equal(S.weekStart('2026-11-29'), '2026-11-23', 'Sunday belongs to the week before');
    assert.equal(S.addDays('2026-03-07', 2), '2026-03-09');
    assert.equal(S.addDays('2026-11-01', -1), '2026-10-31');
    assert.equal(S.monthStart('2026-11-25'), '2026-11-01');
    assert.equal(S.addMonths('2026-01-31', 1), '2026-02-01');
    assert.equal(S.addMonths('2026-01-15', -1), '2025-12-01');
  });

  test('a month grid is whole Monday-first weeks covering every day', () => {
    const weeks = S.monthGrid('2026-11-25');
    assert.ok(weeks.every((w) => w.length === 7));
    assert.equal(weeks[0][0], '2026-10-26');
    assert.ok(weeks.flat().includes('2026-11-01') && weeks.flat().includes('2026-11-30'));
    assert.equal(weeks.at(-1)[6], '2026-12-06');
    assert.equal(S.monthGrid('2027-02-10').length, 4, 'Feb 2027 starts on a Monday and fills exactly four weeks');
  });

  test('the range each view shows, and the prev/next step', () => {
    assert.deepEqual(S.viewRange('day', '2026-11-25'), { from: '2026-11-25', to: '2026-11-25', days: ['2026-11-25'] });
    const w = S.viewRange('week', '2026-11-25');
    assert.equal(w.from, '2026-11-23'); assert.equal(w.to, '2026-11-29'); assert.equal(w.days.length, 7);
    const m = S.viewRange('month', '2026-11-25');
    assert.equal(m.from, '2026-10-26'); assert.equal(m.to, '2026-12-06'); assert.equal(m.weeks.length, 6);
    assert.equal(S.stepAnchor('day', '2026-11-30', 1), '2026-12-01');
    assert.equal(S.stepAnchor('week', '2026-11-25', -1), '2026-11-16');
    assert.equal(S.stepAnchor('month', '2026-11-25', 1), '2026-12-01');
  });

  test('where the screen opens: links first, then the view saved on the device', () => {
    const today = '2026-11-25';
    assert.deepEqual(S.initialState({ week: '2026-12-02' }, 'month', today), { view: 'week', anchor: '2026-11-30' }, 'the old ?week= link still opens that week');
    assert.deepEqual(S.initialState({ day: '2026-12-02' }, 'week', today), { view: 'day', anchor: '2026-12-02' });
    assert.deepEqual(S.initialState({ month: '2027-01' }, 'week', today), { view: 'month', anchor: '2027-01-01' });
    assert.deepEqual(S.initialState({}, 'month', today), { view: 'month', anchor: today });
    assert.deepEqual(S.initialState({ view: 'day' }, 'month', today), { view: 'day', anchor: today });
    assert.deepEqual(S.initialState({}, 'nonsense', today), { view: 'week', anchor: today });
    assert.deepEqual(S.initialState({ week: 'garbage' }, null, today), { view: 'week', anchor: today });
  });
});

describe('records on the board', () => {
  const rows = [
    { id: 'a', jobId: 'j1', employeeId: 'e1', date: '2026-11-25', startTime: '07:00', endTime: '15:00', hours: 8 },
    { id: 'b', jobId: 'j2', employeeId: 'e1', date: '2026-11-25', startTime: '13:00', endTime: '17:00', hours: 4 },
    { id: 'c', jobId: 'j1', employeeId: 'e2', date: '2026-11-25', hours: 6 },
    { id: 'd', jobId: 'j3', employeeId: 'e2', date: '2026-11-24', startTime: '22:00', endTime: '04:30', hours: 6.5 },
    { id: 'e', jobId: 'j1', employeeId: 'e3', date: '2026-11-26', hours: 8 },
  ];

  test('filters by crew member and job', () => {
    assert.deepEqual(rows.filter(S.entryFilter({ employeeId: 'e1' })).map((r) => r.id), ['a', 'b']);
    assert.deepEqual(rows.filter(S.entryFilter({ jobId: 'j1' })).map((r) => r.id), ['a', 'c', 'e']);
    assert.deepEqual(rows.filter(S.entryFilter({ employeeId: 'e2', jobId: 'j1' })).map((r) => r.id), ['c']);
    assert.equal(rows.filter(S.entryFilter()).length, rows.length);
    assert.equal(S.totalHours(rows.slice(0, 3)), 18);
    assert.equal(S.totalHours([{ startTime: '07:00', endTime: '11:30' }]), 4.5, 'a record without hours totals from its times');
  });

  test('day segments include last night\'s shift running past midnight', () => {
    const segs = S.daySegments(rows, '2026-11-25');
    assert.deepEqual(segs.map((s) => [s.entry.id, s.start, s.end, s.carried]), [
      ['d', 0, 270, true], ['c', 420, 780, false], ['a', 420, 900, false], ['b', 780, 1020, false],
    ]);
    const night = S.daySegments(rows, '2026-11-24');
    assert.deepEqual(night.map((s) => [s.entry.id, s.start, s.end, s.continues]), [['d', 1320, 1440, true]]);
  });

  test('overlapping shifts get separate lanes', () => {
    const e1 = S.daySegments(rows.filter((r) => r.employeeId === 'e1'), '2026-11-25');
    assert.equal(S.assignLanes(e1), 2);
    assert.deepEqual(e1.map((s) => s.lane), [0, 1]);
    const back = [{ start: 420, end: 720 }, { start: 720, end: 900 }];
    assert.equal(S.assignLanes(back), 1, 'back-to-back shifts share a lane');
    assert.equal(S.assignLanes([]), 1);
  });

  test('the Day timeline window widens to whole hours around the shifts', () => {
    assert.deepEqual(S.dayWindow([]), { from: 360, to: 1080 });
    assert.deepEqual(S.dayWindow(S.daySegments(rows, '2026-11-25')), { from: 0, to: 1080 });
    assert.deepEqual(S.dayWindow([{ start: 330, end: 1170 }]), { from: 300, to: 1200 });
    assert.deepEqual(S.dayWindow([{ start: 1320, end: 1440 }]), { from: 360, to: 1440 });
  });

  test('month cells summarise jobs by people and hours', () => {
    assert.deepEqual(S.jobsOnDay(rows, '2026-11-25'), [{ jobId: 'j1', people: 2, hours: 14 }, { jobId: 'j2', people: 1, hours: 4 }]);
    assert.deepEqual(S.jobsOnDay(rows, '2026-12-25'), []);
  });

  test('a drag move patches only what changed and writes times onto hours-only records', () => {
    const a = rows[0];
    assert.equal(S.movePatch(a, { date: a.date, employeeId: a.employeeId }), null);
    assert.deepEqual(S.movePatch(a, { date: '2026-11-27' }), { date: '2026-11-27' });
    assert.deepEqual(S.movePatch(a, { employeeId: 'e9', date: '2026-11-25' }), { employeeId: 'e9' });
    assert.deepEqual(S.movePatch(rows[2], { date: '2026-11-26' }), { date: '2026-11-26', startTime: '07:00', endTime: '13:00', hours: 6 });
  });
});

test('the schedule schema accepts the new times and still accepts hours-only records', () => {
  const schema = JSON.parse(readFileSync(new URL('../js/schema/schedule.json', import.meta.url), 'utf8'));
  const p = schema.properties;
  const time = new RegExp(p.startTime.pattern);
  for (const ok of ['07:00', '23:59', '00:00', '']) assert.ok(time.test(ok), ok);
  for (const bad of ['7:00', '24:00', '12:60', '07:00:00']) assert.ok(!time.test(bad), bad);
  assert.equal(p.endTime.pattern, p.startTime.pattern);
  assert.deepEqual(p.hours.type, ['number', 'null']);
  assert.deepEqual(schema.required, ['id'], 'times stay optional: older records only have hours');
  assert.equal(schema.additionalProperties, true);
  // what the form writes always matches the schema
  const rec = S.timeFields('6:15', '2:45');
  assert.ok(time.test(rec.startTime) && time.test(rec.endTime) && typeof rec.hours === 'number');
});
