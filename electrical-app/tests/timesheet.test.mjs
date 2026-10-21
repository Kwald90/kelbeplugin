// Run: node --test electrical-app/tests/*.test.mjs
// Weekly timesheets: work and travel per job and day, overtime by province (rules checked
// 2026-10-19, docs/field/timesheets.md), break reminders, approvals, payroll CSV rows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/lib/timesheet.js';
import { parseCSV } from '../js/lib/csv.js';

const dayOf = (iso) => iso.slice(0, 10); // tests run in any time zone
const WEEK = '2026-10-19'; // a Monday
let n = 0;
/** An entry on day `d` (0 = Monday) from `from` to `to` hours (decimal), net of `brk` minutes. */
const e = (d, from, to, o = {}) => {
  const day = S.addDays(WEEK, d);
  const t = (h) => `${day}T${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}:00.000Z`;
  return { id: `e${++n}`, employeeId: 'emp', jobId: 'j1', clockIn: t(from), clockOut: t(to), breakMins: 0, approved: false, ...o };
};
const sheet = (entries, province) => S.weekSheet(entries, { employeeId: 'emp', weekStart: WEEK, province, dayOf, now: Date.parse('2026-10-26T00:00:00Z') });
const ot = (entries, province) => { const s = sheet(entries, province); return [S.hrs(s.totals.reg), S.hrs(s.totals.ot), S.hrs(s.totals.dt)]; };
const days = (hours) => hours.map((h, i) => e(i, 7, 7 + h));

describe('overtime by province', () => {
  test('Manitoba: over 8 a day or 40 a week, each hour counted once', () => {
    assert.deepEqual(ot(days([10, 8, 8, 8, 8]), 'MB'), [40, 2, 0], 'a 10-hour Monday: 2 daily OT, 40 regular');
    assert.deepEqual(ot(days([8, 8, 8, 8, 8, 6]), 'MB'), [40, 6, 0], 'Saturday is all weekly OT');
    assert.deepEqual(ot(days([10, 10, 10, 10, 10]), 'MB'), [40, 10, 0]);
  });
  test('Manitoba ICI construction: 10 a day, 40 a week', () => {
    assert.deepEqual(ot(days([10, 10, 10, 10]), 'MB-ICI'), [40, 0, 0]);
    assert.deepEqual(ot(days([11, 10, 10, 10]), 'MB-ICI'), [40, 1, 0]);
  });
  test('Ontario: weekly only, over 44', () => {
    assert.deepEqual(ot(days([12, 12, 12, 12]), 'ON'), [44, 4, 0]);
    assert.deepEqual(ot(days([12, 12, 12]), 'ON'), [36, 0, 0], 'no daily overtime');
  });
  test('British Columbia: 1.5x over 8, 2x over 12 a day, 1.5x over 40 a week', () => {
    assert.deepEqual(ot(days([13]), 'BC'), [8, 4, 1]);
    assert.deepEqual(ot(days([9, 9, 9, 9, 9]), 'BC'), [40, 5, 0]);
    assert.deepEqual(ot(days([8, 8, 8, 8, 8, 4]), 'BC'), [40, 4, 0]);
  });
  test('Alberta: the greater of over 8 a day or over 44 a week', () => {
    assert.deepEqual(ot(days([10, 10, 10, 10]), 'AB'), [32, 8, 0], 'daily wins: 8 vs 0');
    assert.deepEqual(ot(days([8, 8, 8, 8, 8, 8]), 'AB'), [44, 4, 0], 'weekly wins: 4 vs 0');
    assert.deepEqual(ot(days([12, 12, 12, 12]), 'AB'), [32, 16, 0], 'daily 16 beats weekly 4');
  });
  test('Saskatchewan: the greater of over 8 a day or over 40 a week', () => {
    assert.deepEqual(ot(days([8, 8, 8, 8, 8, 4]), 'SK'), [40, 4, 0]);
    assert.deepEqual(ot(days([10, 10, 10]), 'SK'), [24, 6, 0]);
  });
  test('Atlantic: NS and PE (since 2026-06-30) and NB at their weekly limits', () => {
    assert.deepEqual(ot(days([10, 10, 10, 10, 10]), 'NS'), [48, 2, 0]);
    assert.deepEqual(ot(days([10, 10, 10, 10, 10]), 'PE'), [44, 6, 0]);
    assert.deepEqual(ot(days([10, 10, 10, 10, 10]), 'NB'), [44, 6, 0]);
    assert.deepEqual(ot(days([10, 10, 10, 10, 10]), 'NL'), [40, 10, 0]);
    assert.equal(S.otRule('NB').basis, 'minimum');
    assert.equal(S.otRule('NL').basis, 'minimum');
    assert.equal(S.otRule('NS').basis, 'regular');
  });
  test('every rule cites a government source; unknown provinces fall back to Ontario', () => {
    for (const [id, r] of Object.entries(S.OT_RULES)) {
      assert.ok(r.source && /^https:\/\/(www[0-9]?\.)?(gov\.mb\.ca|saskatchewan\.ca|gov\.bc\.ca|alberta\.ca|ontario\.ca|novascotia\.ca|gnb\.ca|princeedwardisland\.ca|gov\.nl\.ca)\//.test(r.url), id);
    }
    assert.equal(S.otRule('QC').name, 'Ontario');
    assert.equal(S.ruleText(S.otRule('MB')), 'Over 8 h a day or 40 h a week at 1.5x the regular wage (Manitoba)');
    assert.match(S.ruleText(S.otRule('AB')), /whichever is more/);
  });
});

describe('a person\'s week', () => {
  const week = [
    e(0, 7, 10.2, { jobId: 'j1' }), e(0, 10.2, 10.7, { jobId: 'j2', kind: 'travel', travelFromJobId: 'j1' }), e(0, 10.7, 15.5, { jobId: 'j2', breakMins: 30 }),
    e(1, 7, 15.5, { jobId: 'j2', breakMins: 30, approved: true }),
    e(2, 7, 13, { jobId: 'j1' }), // 6 h, no break: a reminder (MB 30 min after 5 h)
    { ...e(3, 7, 9), clockOut: null }, // still open
    e(1, 8, 9, { employeeId: 'someone-else' }),
  ];
  const s = sheet(week, 'MB');
  test('work and travel per day and per job', () => {
    const mon = s.days[0];
    assert.equal(S.hrs(mon.work), 7.5);
    assert.equal(S.hrs(mon.travel), 0.5);
    assert.deepEqual(Object.keys(mon.jobs).sort(), ['j1', 'j2']);
    const j2 = s.jobs.find((j) => j.jobId === 'j2');
    assert.equal(S.hrs(j2.travel), 0.5, 'travel billed to the job travelled to');
    assert.equal(S.hrs(j2.work), 12.3);
  });
  test('breaks, counts and the approval state', () => {
    assert.equal(s.days[2].breakShort, true);
    assert.equal(s.days[0].breakShort, false);
    assert.deepEqual(s.counts, { entries: 6, open: 1, approved: 1, pending: 4, flagged: 0 });
    assert.equal(s.approvedAll, false);
    const p = S.approvePatches(s, { by: 'fore', at: '2026-10-26T12:00:00Z' });
    assert.equal(p.length, 4, 'open shifts and approved entries are left alone');
    assert.deepEqual(p[0].patch, { approved: true, approvedAt: '2026-10-26T12:00:00Z', approvedBy: 'fore' });
  });
  test('weeks start Monday or Sunday', () => {
    assert.equal(S.weekOf('2026-10-22', 1), '2026-10-19');
    assert.equal(S.weekOf('2026-10-22', 0), '2026-10-18');
    assert.equal(S.weekOf('2026-10-18', 1), '2026-10-12');
  });
});

describe('payroll CSV', () => {
  const employees = new Map([['emp', { id: 'emp', name: 'Jackson Pike', payrollId: '1042' }], ['emp2', { id: 'emp2', name: 'Manny Ortiz' }]]);
  const jobs = new Map([['j1', { id: 'j1', number: 'J-1001', title: 'Clinic buildout', clientId: 'c1' }], ['j2', { id: 'j2', number: 'J-1002', title: 'Panel upgrade', clientId: 'c2' }]]);
  const clients = new Map([['c1', { name: 'Harbour Dental' }], ['c2', { name: 'Miller, J. "Jo"' }]]);
  const ctx = { employees, jobs, clients, periodStart: WEEK, periodEnd: S.addDays(WEEK, 6) };
  const entries = [
    e(0, 7, 17, { jobId: 'j1', approved: true }), e(0, 17, 17.5, { jobId: 'j2', kind: 'travel', approved: true }),
    e(1, 7, 15, { jobId: 'j2', approved: true }), e(2, 7, 15, { jobId: 'j2' }),
    { ...e(3, 7, 9, { jobId: 'j1' }), clockOut: null },
    e(0, 8, 12, { employeeId: 'emp2', jobId: 'j1', kind: 'travel', approved: true }),
  ];
  const sheets = ['emp', 'emp2'].map((id) => S.weekSheet(entries, { employeeId: id, weekStart: WEEK, province: 'MB', dayOf }));

  test('generic: one row per person, day, job and type with regular/overtime split', () => {
    const { rows, warnings } = S.payrollRows('generic', sheets, ctx);
    assert.deepEqual(rows[0], ['employee_id', 'employee_name', 'period_start', 'period_end', 'work_date', 'job_code', 'job_name', 'customer', 'type', 'regular_hours', 'overtime_hours', 'double_time_hours', 'total_hours', 'break_minutes', 'approved', 'late']);
    assert.deepEqual(rows.slice(1, 5).map((r) => [r[1], r[4], r[5], r[8], r[9], r[10], r[14]]), [
      ['Jackson Pike', '2026-10-19', 'J-1001', 'work', 8, 2, 'yes'],
      ['Jackson Pike', '2026-10-19', 'J-1002', 'travel', 0, 0.5, 'yes'], // the 10.5th hour of the day is overtime
      ['Jackson Pike', '2026-10-20', 'J-1002', 'work', 8, 0, 'yes'],
      ['Jackson Pike', '2026-10-21', 'J-1002', 'work', 8, 0, 'no'],
    ]);
    assert.equal(rows.length, 6, 'the open shift is not exported');
    assert.ok(warnings.some((w) => /Jackson Pike has 1 open shift/.test(w)));
    assert.ok(warnings.some((w) => /Jackson Pike has 1 unapproved/.test(w)));
  });

  test('Wagepoint: one row per employee per job, decimal hours, IDs first', () => {
    const { rows, warnings } = S.payrollRows('wagepoint', sheets, ctx);
    assert.deepEqual(rows, [
      ['Employee ID', 'Employee Name', 'Job ID', 'Job Name', 'Regular Hours', 'Overtime Hours', 'Double Time Hours'],
      ['1042', 'Jackson Pike', 'J-1001', 'Clinic buildout', 8, 2, 0],
      ['1042', 'Jackson Pike', 'J-1002', 'Panel upgrade', 16, 0.5, 0],
      ['', 'Manny Ortiz', 'J-1001', 'Clinic buildout', 4, 0, 0],
    ]);
    assert.ok(warnings.some((w) => /Manny Ortiz has no payroll ID/.test(w)));
  });

  test('QuickBooks Online Payroll entry sheet: per person and day, quoted safely', () => {
    const { text, count } = S.payrollCsv('qbo', sheets, ctx);
    const back = parseCSV(text);
    assert.equal(count, 5);
    assert.deepEqual(back[0], ['Employee', 'Employee ID', 'Date', 'Customer', 'Job', 'Type', 'Regular hours', 'Overtime hours', 'Double time hours', 'Late']);
    assert.deepEqual(back[2], ['Jackson Pike', '1042', '2026-10-19', 'Miller, J. "Jo"', 'J-1002 Panel upgrade', 'Travel', '0', '0.5', '0', '']);
    assert.match(text, /"Miller, J\. ""Jo"""/);
    assert.ok(text.endsWith('\r\n'));
  });

  test('a Wagepoint template is filled by employee ID and job ID', () => {
    const template = [
      ['Employee ID', 'Employee Name', 'Job ID', 'Job Name', 'Regular Pay (hrs)', 'Overtime 1.5x (hrs)', 'Stat Holiday (hrs)'],
      ['1042', 'Pike, Jackson', 'J-1001', 'Clinic', '', '', ''],
      ['1042', 'Pike, Jackson', 'J-1002', 'Panel', '', '', ''],
      ['2001', 'Someone Else', '', '', '', '', ''],
    ];
    const r = S.fillWagepointTemplate(template, sheets, ctx);
    assert.equal(r.filled, 2);
    assert.deepEqual(r.rows[1], ['1042', 'Pike, Jackson', 'J-1001', 'Clinic', '8', '2', '']);
    assert.deepEqual(r.rows[2].slice(4), ['16', '0.5', '']);
    assert.deepEqual(r.rows[3], template[3], 'other people stay blank (Wagepoint leaves their hours as they are)');
    assert.ok(r.warnings.some((w) => /Manny Ortiz on J-1001: 4 h are not in the template/.test(w)));
    assert.match(S.fillWagepointTemplate([['Name']], sheets, ctx).warnings[0], /no "Employee ID" column/);
  });
});

describe('corrections and late hours (docs/releases/r1-get-paid.md 2.6, 8.2)', () => {
  const corr = (workDay, adjustMinutes, o = {}) => ({ id: `c${++n}`, employeeId: 'emp', jobId: 'j1', kind: 'correction', correctsId: 'x', workDay, adjustMinutes, approved: true, ...o });

  test('a correction counts on its work day: +1 h on an 8-hour Monday is daily overtime in MB', () => {
    const base = days([8, 8, 8, 8, 8]);
    assert.deepEqual(ot(base, 'MB'), [40, 0, 0]);
    assert.deepEqual(ot([...base, corr(WEEK, 60)], 'MB'), [40, 1, 0]);
    assert.deepEqual(ot([...base, corr(WEEK, 60)], 'ON'), [41, 0, 0], 'no daily overtime in Ontario');
    const s = sheet([...base, corr(WEEK, 60)], 'MB');
    assert.equal(S.hrs(s.days[0].total), 9);
    assert.equal(s.counts.open, 0, 'a correction is never an open shift');
  });

  test('a negative correction takes hours off the top: overtime first', () => {
    const tenMon = days([10, 8, 8, 8, 8]);
    assert.deepEqual(ot(tenMon, 'MB'), [40, 2, 0]);
    assert.deepEqual(ot([...tenMon, corr(WEEK, -60)], 'MB'), [40, 1, 0]);
    assert.deepEqual(ot([...days([8, 8, 8, 8, 8]), corr(WEEK, -60)], 'MB'), [39, 0, 0]);
    assert.equal(S.entryMinutes(corr(WEEK, -90)), -90);
    assert.equal(S.entryDay(corr('2026-10-21', 30)), '2026-10-21');
    assert.equal(S.isCorrection({ kind: 'work' }), false);
  });

  test('late entries and corrections go in the payroll file as prior-period rows marked late', () => {
    const employees = new Map([['emp', { id: 'emp', name: 'Jackson Pike', payrollId: '1042' }]]);
    const jobs = new Map([['j1', { id: 'j1', number: 'J-1001', title: 'Clinic' }]]);
    const week = [e(0, 7, 15, { approved: true })];
    const sheets = [S.weekSheet(week, { employeeId: 'emp', weekStart: WEEK, province: 'MB', dayOf })];
    const lateEntry = { id: 'old1', employeeId: 'emp', jobId: 'j1', clockIn: '2026-10-09T13:00:00.000Z', clockOut: '2026-10-09T17:00:00.000Z', breakMins: 0, approved: true };
    const ctx = { employees, jobs, clients: new Map(), periodStart: WEEK, periodEnd: S.addDays(WEEK, 6), lateEntries: [lateEntry, corr('2026-10-08', 60)] };
    const { rows, warnings } = S.payrollRows('generic', sheets, ctx);
    assert.equal(rows.length, 4);
    const late = rows.filter((r) => r[15] === 'yes');
    assert.deepEqual(late.map((r) => [r[4], r[9]]).sort(), [['2026-10-08', 1], ['2026-10-09', 4]]);
    assert.ok(warnings.some((w) => /2 late entries/.test(w)));
    const wp = S.payrollRows('wagepoint', sheets, ctx).rows;
    assert.deepEqual(wp[1], ['1042', 'Jackson Pike', 'J-1001', 'Clinic', 13, 0, 0], 'Wagepoint has no dates: late hours join the job row');
  });

  test('a late correction is paid at overtime when its day was already full (counted on its own week)', () => {
    const employees = new Map([['emp', { id: 'emp', name: 'Jackson Pike', payrollId: '1042' }]]);
    const prev = '2026-10-12'; // the Monday of the week before
    const at = (day, h) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
    const paidMon = { id: 'p1', employeeId: 'emp', jobId: 'j1', clockIn: at(prev, 13), clockOut: at(prev, 21), breakMins: 0, approved: true };
    const ctx = { employees, jobs: new Map(), clients: new Map(), periodStart: WEEK, periodEnd: S.addDays(WEEK, 6), dayOf, province: 'MB',
      paidEntries: [paidMon], lateEntries: [corr(prev, 60)] };
    const rows = S.payrollRows('generic', [], ctx).rows.slice(1);
    assert.deepEqual(rows.map((r) => [r[4], r[9], r[10], r[15]]), [[prev, 0, 1, 'yes']], '+1 h on an 8 h Manitoba day is 1 h of overtime');
    // A 9 h Friday left out of last week's run (not approved in time) after four paid 8 h days.
    const paid = [0, 1, 2, 3].map((d) => ({ id: `p${d + 10}`, employeeId: 'emp', jobId: 'j1', clockIn: at(S.addDays(prev, d), 12), clockOut: at(S.addDays(prev, d), 20), breakMins: 0, approved: true }));
    const fri = { id: 'fri', employeeId: 'emp', jobId: 'j1', clockIn: at(S.addDays(prev, 4), 12), clockOut: at(S.addDays(prev, 4), 21), breakMins: 0, approved: true };
    const split = S.lateSplits([fri], paid, { province: 'MB', dayOf });
    assert.deepEqual(split.get('fri'), { reg: 480, ot: 60, dt: 0 });
    // Not counted against hours of another person or another week.
    const other = S.lateSplits([fri], paid.map((x) => ({ ...x, employeeId: 'someone' })), { province: 'MB', dayOf });
    assert.deepEqual(other.get('fri'), { reg: 480, ot: 60, dt: 0 }, 'a 9 h day alone is still 1 h of daily overtime');
    // A late shift that starts before the paid one on the same day still takes the overtime itself.
    const early = { id: 'early', employeeId: 'emp', jobId: 'j1', clockIn: at(prev, 10), clockOut: at(prev, 12), breakMins: 0, approved: true };
    assert.deepEqual(S.lateSplits([early], [paidMon], { province: 'MB', dayOf }).get('early'), { reg: 0, ot: 120, dt: 0 });
  });
});
