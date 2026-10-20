// Weekly timesheets from time entries: work and travel hours per job and day, overtime by
// province, break reminders, approval state, and payroll CSV rows (Wagepoint, QuickBooks Online
// Payroll Canada, generic). Pure (no DOM): the time clock, the dashboard and the tests use it.
//
// A time entry: { id, employeeId, jobId, kind: 'work'|'travel' (missing = work), clockIn, clockOut,
// breakMins, approved, approvedAt, approvedBy, flag? }. Hours are net of breaks. A shift belongs
// to the day it started (local time), the usual payroll convention; one that runs past midnight
// is not split.
//
// Overtime rules cite the employment standards law of each launch province (docs/field/timesheets.md
// lists them with the date checked). They are the general rules: collective agreements, averaging
// agreements, and industry orders (construction in some provinces) can differ, and the payroll
// provider has the final say. Overtime hours are reported; pay rates are the payroll software's job.
import { toCSV } from './csv.js';
import { isTravel } from './tm.js';

/**
 * mode:
 *   'daily+weekly'  hours over `daily` in a day are overtime; of the rest, hours over `weekly` in the week too;
 *                   each hour counted once (MB, BC)
 *   'greater'       the greater of the daily total and the weekly total (AB, SK)
 *   'weekly'        only hours over `weekly` in the week (ON, NS, NB, PE, NL)
 * double: hours over this in a day are double time (BC).
 * basis: what the 1.5x applies to: the employee's regular wage, or the provincial minimum wage.
 * meal: the meal break owed after `afterH` hours of work in a row (a reminder, not a deduction).
 * Checked 2026-10-19 against each government's own page (docs/field/timesheets.md). VERIFY marks
 * what could not be confirmed there.
 */
export const OT_RULES = {
  MB: {
    name: 'Manitoba', mode: 'daily+weekly', daily: 8, weekly: 40, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Employment Standards Code (C.C.S.M. c. E110): standard hours 8/day, 40/week; overtime 1.5x regular, each hour counted once; 30 min unpaid meal break after 5 h',
    url: 'https://www.gov.mb.ca/labour/standards/doc,overtime,factsheet.html',
    note: 'Industrial, commercial and institutional (ICI) construction uses 10 h/day and 40 h/week: pick "Manitoba ICI construction".',
  },
  'MB-ICI': {
    name: 'Manitoba ICI construction', mode: 'daily+weekly', daily: 10, weekly: 40, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Construction Industry Wages Act, ICI construction regulation: overtime after 10 h/day or 40 h/week',
    url: 'https://www.gov.mb.ca/labour/standards/doc,ici-wage,factsheet.pdf',
  },
  SK: {
    name: 'Saskatchewan', mode: 'greater', daily: 8, weekly: 40, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'The Saskatchewan Employment Act ss. 2-14, 2-18: overtime after 8 h/day (10 on scheduled 10-hour days) or 40 h/week (32 in a week with a public holiday), whichever is greater, 1.5x; 30 min unpaid in every 5 h',
    url: 'https://www.saskatchewan.ca/business/employment-standards/hours-of-work-and-overtime',
    note: 'Weeks with a public holiday (32 h) and 10-hour-day schedules are not applied automatically. VERIFY those weeks by hand.',
  },
  BC: {
    name: 'British Columbia', mode: 'daily+weekly', daily: 8, double: 12, weekly: 40, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Employment Standards Act s. 40: 1.5x over 8 h/day, 2x over 12 h/day, 1.5x over 40 h/week (only the first 8 h of a day count toward 40); s. 32: 30 min meal break after 5 h',
    url: 'https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards/hours/overtime-pay',
    note: 'The overtime week runs Sunday to Saturday: set the payroll week to start on Sunday.',
  },
  AB: {
    name: 'Alberta', mode: 'greater', daily: 8, weekly: 44, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Employment Standards Code ss. 21-22: overtime is the greater of over 8 h/day or over 44 h/week, 1.5x; a 30 min break in each shift over 5 h',
    url: 'https://www.alberta.ca/overtime-hours-overtime-pay',
  },
  ON: {
    name: 'Ontario', mode: 'weekly', daily: null, weekly: 44, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Employment Standards Act, 2000 s. 22: 1.5x over 44 h/week, no daily overtime; s. 20: 30 min eating period, never more than 5 h in a row',
    url: 'https://www.ontario.ca/document/your-guide-employment-standards-act-0/overtime-pay',
    note: 'Construction is exempt from the daily and weekly hour limits, not from overtime. Averaging agreements are not applied.',
  },
  NS: {
    name: 'Nova Scotia', mode: 'weekly', daily: null, weekly: 48, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Labour Standards Code and the Minimum Wage Order (General): 1.5x the regular wage over 48 h/week; 30 min break, never more than 5 h in a row',
    url: 'https://novascotia.ca/lae/employmentrights/docs/labourstandardscodeguide.pdf',
    note: 'Construction businesses: overtime after 110 h in two weeks, and registered apprentices are excluded from overtime. Neither is applied automatically. VERIFY.',
  },
  NB: {
    name: 'New Brunswick', mode: 'weekly', daily: null, weekly: 44, rate: 1.5, basis: 'minimum', meal: { afterH: 5, mins: 30 },
    source: 'Employment Standards Act, Minimum Wage Regulation: 1.5x the minimum wage over 44 h/week',
    url: 'https://www.gnb.ca/en/topic/jobs-workplaces/labour-market-workforce/employment-standards/wage-pay.html',
    note: 'Meal break after 5 h: VERIFY.',
  },
  PE: {
    name: 'Prince Edward Island', mode: 'weekly', daily: null, weekly: 44, rate: 1.5, basis: 'regular', meal: { afterH: 5, mins: 30 },
    source: 'Employment Standards Act as amended (Bill 76, in force 2026-06-30): 1.5x the regular wage over 44 h/week (was 48)',
    url: 'https://www.princeedwardisland.ca/en/information/workforce-and-advanced-learning/changes-to-the-employment-standards-act',
    note: 'The 44-hour week and any construction exemption under the new Act: VERIFY.',
  },
  NL: {
    name: 'Newfoundland and Labrador', mode: 'weekly', daily: null, weekly: 40, rate: 1.5, basis: 'minimum', meal: { afterH: 5, mins: 60 },
    source: 'Labour Standards Act and Minimum Wage Order: 1.5x the minimum wage over 40 h/week, no daily overtime; one hour unpaid meal break after 5 h',
    url: 'https://www.gov.nl.ca/gs/files/Your-Rights-At-Work.pdf',
  },
};

/** Rules people can pick in Time clock > Settings (province default, or a variant). */
export const OT_RULE_CHOICES = Object.entries(OT_RULES).map(([id, r]) => ({ id, label: r.name }));

/** The rule for a province code, Ontario's when unknown (the app's default province). */
export const otRule = (province) => OT_RULES[String(province || '').toUpperCase()] || OT_RULES.ON;

/** One-line summary: "Over 8 h a day or 40 h a week at 1.5x (Manitoba)". */
export function ruleText(rule) {
  const r = rule || OT_RULES.ON;
  const d = r.daily ? `${r.daily} h a day` : null;
  const w = `${r.weekly} h a week`;
  const when = r.mode === 'weekly' ? `Over ${w}` : r.mode === 'greater' ? `Over ${d} or ${w}, whichever is more,` : `Over ${d} or ${w}`;
  const dbl = r.double ? `; double time over ${r.double} h a day` : '';
  return `${when} at ${r.rate}x ${r.basis === 'minimum' ? 'the minimum wage' : 'the regular wage'}${dbl} (${r.name})`;
}

/** 'travel' or 'work' (lib/tm.js isTravel: kind, or the older travel flag). */
export const kindOf = (e) => (isTravel(e) ? 'travel' : 'work');
const MIN = 60_000;

/** Net minutes of an entry (breaks taken off), an open one counted up to `now`. */
export function entryMinutes(e, now = Date.now()) {
  if (!e?.clockIn) return 0;
  const start = Date.parse(e.clockIn);
  const end = e.clockOut ? Date.parse(e.clockOut) : (typeof now === 'number' ? now : Date.parse(now));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  let breakMin = Number(e.breakMins) || 0;
  if (!e.clockOut && e.breakStart) breakMin += Math.max(0, (end - Date.parse(e.breakStart)) / MIN);
  return Math.max(0, Math.round((end - start) / MIN - breakMin));
}

const pad = (n) => String(n).padStart(2, '0');
/** Local YYYY-MM-DD of an ISO time (the device's time zone). */
export const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
/** Monday (weekStartsOn 1) or Sunday (0) of the week holding `day`. */
export function weekOf(day, weekStartsOn = 1) {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, -((dow - weekStartsOn + 7) % 7));
}

/**
 * Split each entry's minutes into regular, overtime and double time under a province rule.
 * Entries are one person's for one week. Returns Map(entryId -> { reg, ot, dt }) in minutes.
 */
export function allocateOvertime(entries, rule, { dayOf = localDay, now } = {}) {
  const r = rule || OT_RULES.ON;
  const list = [...entries].filter((e) => e.clockIn).sort((a, b) => a.clockIn.localeCompare(b.clockIn));
  const mins = new Map(list.map((e) => [e.id, entryMinutes(e, now)]));

  const daily = () => {
    const out = new Map();
    const perDay = new Map();
    for (const e of list) {
      const day = dayOf(e.clockIn);
      let used = perDay.get(day) || 0;
      let left = mins.get(e.id);
      const a = { reg: 0, ot: 0, dt: 0 };
      const take = (cap, key) => { const n = cap == null ? left : Math.max(0, Math.min(left, cap - used)); a[key] += n; used += n; left -= n; };
      if (r.daily) take(r.daily * 60, 'reg'); else take(null, 'reg');
      if (left > 0) take(r.double ? r.double * 60 : null, 'ot');
      if (left > 0) take(null, 'dt');
      perDay.set(day, used);
      out.set(e.id, a);
    }
    return out;
  };
  const weekly = (base) => {
    const out = new Map();
    let reg = 0;
    for (const e of list) {
      const a = base ? { ...base.get(e.id) } : { reg: mins.get(e.id), ot: 0, dt: 0 };
      const room = Math.max(0, r.weekly * 60 - reg);
      const over = Math.max(0, a.reg - room);
      a.reg -= over; a.ot += over; reg += a.reg;
      out.set(e.id, a);
    }
    return out;
  };
  const sum = (m) => [...m.values()].reduce((s, a) => s + a.ot + a.dt, 0);

  if (r.mode === 'weekly') return weekly(null);
  if (r.mode === 'greater') {
    const d = daily();
    const w = weekly(null);
    return sum(d) >= sum(w) ? d : w;
  }
  return weekly(daily());
}

/**
 * One person's week.
 * @param {object[]} entries  time entries (any people, any dates: filtered here)
 * @param {{ employeeId: string, weekStart: string, province?: string, now?: number, dayOf?: Function }} o
 */
export function weekSheet(entries, { employeeId, weekStart, province, now = Date.now(), dayOf = localDay } = {}) {
  const rule = otRule(province);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const end = days[6];
  const mine = (entries || []).filter((e) => e.employeeId === employeeId && e.clockIn && dayOf(e.clockIn) >= weekStart && dayOf(e.clockIn) <= end)
    .sort((a, b) => a.clockIn.localeCompare(b.clockIn));
  const split = allocateOvertime(mine, rule, { dayOf, now });
  const byDay = new Map(days.map((d) => [d, { date: d, work: 0, travel: 0, total: 0, reg: 0, ot: 0, dt: 0, breakMin: 0, longestRun: 0, jobs: {} }]));
  const byJob = new Map();
  const totals = { work: 0, travel: 0, total: 0, reg: 0, ot: 0, dt: 0, breakMin: 0 };
  let open = 0, approved = 0, pending = 0, flagged = 0;
  for (const e of mine) {
    const day = byDay.get(dayOf(e.clockIn));
    const m = entryMinutes(e, now);
    const k = kindOf(e);
    const a = split.get(e.id) || { reg: m, ot: 0, dt: 0 };
    day[k] += m; day.total += m; day.reg += a.reg; day.ot += a.ot; day.dt += a.dt;
    day.breakMin += Number(e.breakMins) || 0;
    const jk = e.jobId || '';
    day.jobs[jk] = day.jobs[jk] || { work: 0, travel: 0 };
    day.jobs[jk][k] += m;
    if (!byJob.has(jk)) byJob.set(jk, { jobId: e.jobId || null, work: 0, travel: 0, total: 0, days: {} });
    const j = byJob.get(jk);
    j[k] += m; j.total += m;
    j.days[day.date] = j.days[day.date] || { work: 0, travel: 0 };
    j.days[day.date][k] += m;
    totals[k] += m; totals.total += m; totals.reg += a.reg; totals.ot += a.ot; totals.dt += a.dt; totals.breakMin += Number(e.breakMins) || 0;
    if (!e.clockOut) open++; else if (e.approved) approved++; else pending++;
    if (e.flag && !e.flag.reviewedAt) flagged++;
  }
  // Break reminder: a day with more than `afterH` hours on the clock and less break than the rule.
  for (const d of byDay.values()) {
    d.breakShort = !!rule.meal && d.total > rule.meal.afterH * 60 && d.breakMin < rule.meal.mins;
  }
  return {
    employeeId, weekStart, weekEnd: end, rule, days: [...byDay.values()], jobs: [...byJob.values()].sort((a, b) => b.total - a.total),
    totals, entries: mine, split, counts: { entries: mine.length, open, approved, pending, flagged },
    approvedAll: mine.length > 0 && open === 0 && pending === 0,
  };
}

/** Hours with two decimals from minutes (payroll files take decimal hours). */
export const hrs = (min) => Math.round(((Number(min) || 0) / 60) * 100) / 100;
/** "7.50" */
export const fmtH = (min) => hrs(min).toFixed(2);

/** The approval patch for every closed, unapproved entry of a sheet: [{ id, patch }]. */
export function approvePatches(sheet, { by, at = new Date().toISOString() } = {}) {
  return sheet.entries.filter((e) => e.clockOut && !e.approved).map((e) => ({ id: e.id, patch: { approved: true, approvedAt: at, approvedBy: by || null } }));
}

// ---- payroll exports --------------------------------------------------------------------
//
// Checked 2026-10-19 (sources in docs/field/timesheets.md):
//   wagepoint  Wagepoint's "Import hours (CSV)": one row per employee per job, `Employee ID`,
//              `Employee Name`, `Job ID`, `Job Name`, then one column per hourly income code; decimal
//              hours, no dates. Wagepoint generates the template per pay group and the income-code
//              headers are the company's own (VERIFY against a real template), so the best path is
//              fillWagepointTemplate(): upload the downloaded template and Fishtape fills it.
//   qbo        QuickBooks Online Payroll (Canada) has NO hours import (only QuickBooks Time or typing
//              hours in Run payroll). This is an entry sheet in Run-payroll order: person, day, job,
//              regular and overtime hours.
//   generic    one row per person, day, job and kind, decimal hours: any payroll or a spreadsheet.
// Only closed entries are exported; open shifts and unapproved entries come back as warnings.

export const PAYROLL_FORMATS = {
  wagepoint: { label: 'Wagepoint (hours import)', file: 'wagepoint-hours', note: 'Upload in Wagepoint: Hours and incomes > Hours > Import hours. Best: use "Fill my Wagepoint template" so the income-code columns match yours.' },
  qbo: { label: 'QuickBooks Online Payroll (entry sheet)', file: 'quickbooks-payroll-hours', note: 'QuickBooks Online Payroll in Canada has no hours import. Use this sheet to type hours in Run payroll, or connect QuickBooks Time.' },
  generic: { label: 'Generic CSV', file: 'payroll-hours', note: 'One row per person, day, job and type. Opens in any spreadsheet or payroll import that maps columns.' },
};

const get = (m, id) => (id == null ? null : (m instanceof Map ? m.get(id) : m?.[id]) || null);

/** Closed entries of every sheet, each with its regular/overtime split and context. */
function lines(sheets, ctx) {
  const out = [];
  for (const s of sheets) {
    const p = get(ctx.employees, s.employeeId) || { id: s.employeeId, name: 'Unknown' };
    for (const e of s.entries) {
      if (!e.clockOut) continue;
      const a = s.split.get(e.id) || { reg: entryMinutes(e), ot: 0, dt: 0 };
      const j = get(ctx.jobs, e.jobId);
      out.push({ p, e, a, j, c: j?.clientId ? get(ctx.clients, j.clientId) : null, day: localDay(e.clockIn), kind: kindOf(e) });
    }
  }
  return out;
}

function group(items, keyOf) {
  const m = new Map();
  for (const x of items) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, { ...x, reg: 0, ot: 0, dt: 0, min: 0, brk: 0, approved: true });
    const g = m.get(k);
    g.reg += x.a.reg; g.ot += x.a.ot; g.dt += x.a.dt; g.min += entryMinutes(x.e); g.brk += Number(x.e.breakMins) || 0; g.approved = g.approved && !!x.e.approved;
  }
  return [...m.values()];
}

function warningsFor(format, sheets, ctx) {
  const w = [];
  for (const s of sheets) {
    const p = get(ctx.employees, s.employeeId) || { name: 'Unknown' };
    if (s.counts.open) w.push(`${p.name} has ${s.counts.open} open shift${s.counts.open === 1 ? '' : 's'}; not exported.`);
    if (s.counts.pending) w.push(`${p.name} has ${s.counts.pending} unapproved entr${s.counts.pending === 1 ? 'y' : 'ies'}.`);
    if (format === 'wagepoint' && s.counts.entries && !p.payrollId) w.push(`${p.name} has no payroll ID (Wagepoint employee ID); add it on their employee record.`);
  }
  return w;
}

const jobCode = (j) => j?.number || '';
const jobName = (j) => (j ? j.title || '' : 'No job (shop / admin)');
// Person, then day, then the order the day happened in.
const byPersonDay = (a, b) => a.p.name.localeCompare(b.p.name) || a.day.localeCompare(b.day) || a.e.clockIn.localeCompare(b.e.clockIn);

/**
 * Rows (arrays, header first) for a payroll file.
 * @param {'wagepoint'|'qbo'|'generic'} format
 * @param {object[]} sheets  weekSheet() results, one per person
 * @param {{ employees: Map|object, jobs: Map|object, clients?: Map|object, periodStart: string, periodEnd: string }} ctx
 * @returns {{ rows: any[][], warnings: string[] }}
 */
export function payrollRows(format, sheets, ctx) {
  const warnings = warningsFor(format, sheets, ctx);
  const all = lines(sheets, ctx);
  if (format === 'wagepoint') {
    const rows = [['Employee ID', 'Employee Name', 'Job ID', 'Job Name', 'Regular Hours', 'Overtime Hours', 'Double Time Hours']];
    for (const g of group(all, (x) => `${x.p.id}|${x.e.jobId || ''}`).sort((a, b) => a.p.name.localeCompare(b.p.name) || jobCode(a.j).localeCompare(jobCode(b.j)))) {
      rows.push([g.p.payrollId || '', g.p.name, jobCode(g.j), jobName(g.j), hrs(g.reg), hrs(g.ot), hrs(g.dt)]);
    }
    return { rows, warnings };
  }
  const daily = group(all, (x) => `${x.p.id}|${x.day}|${x.e.jobId || ''}|${x.kind}`).sort(byPersonDay);
  if (format === 'qbo') {
    const rows = [['Employee', 'Employee ID', 'Date', 'Customer', 'Job', 'Type', 'Regular hours', 'Overtime hours', 'Double time hours']];
    for (const g of daily) {
      rows.push([g.p.name, g.p.payrollId || '', g.day, g.c?.name || '', g.j ? `${jobCode(g.j)} ${g.j.title || ''}`.trim() : '', g.kind === 'travel' ? 'Travel' : 'Work', hrs(g.reg), hrs(g.ot), hrs(g.dt)]);
    }
    return { rows, warnings };
  }
  const rows = [['employee_id', 'employee_name', 'period_start', 'period_end', 'work_date', 'job_code', 'job_name', 'customer', 'type', 'regular_hours', 'overtime_hours', 'double_time_hours', 'total_hours', 'break_minutes', 'approved']];
  for (const g of daily) {
    rows.push([g.p.payrollId || '', g.p.name, ctx.periodStart, ctx.periodEnd, g.day, jobCode(g.j), jobName(g.j), g.c?.name || '', g.kind,
      hrs(g.reg), hrs(g.ot), hrs(g.dt), hrs(g.min), g.brk, g.approved ? 'yes' : 'no']);
  }
  return { rows, warnings };
}

/** The payroll file: { text (RFC 4180, CRLF), warnings, count }. */
export function payrollCsv(format, sheets, ctx) {
  const { rows, warnings } = payrollRows(format, sheets, ctx);
  return { text: toCSV(rows), warnings, count: rows.length - 1 };
}

/**
 * Fill a template downloaded from Wagepoint (rows from parseCSV): rows are matched by Employee ID
 * (our payroll ID) and Job ID (our job number; blank for no job), and the regular, overtime and
 * double-time income-code columns are found by their header words. Other cells stay as they are;
 * rows with no time stay blank (Wagepoint then leaves those hours unchanged).
 * @returns {{ rows: string[][], filled: number, warnings: string[] }}
 */
export function fillWagepointTemplate(template, sheets, ctx) {
  const head = (template?.[0] || []).map((x) => String(x || '').trim());
  const col = (re, not) => head.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const iEmp = col(/^employee\s*id$/i);
  const iJob = col(/^job\s*id$/i);
  const iReg = col(/regular|^reg\b/i, /double|overtime|o\/t/i);
  const iDt = col(/double/i);
  const iOt = col(/overtime|o\/t|\bot\b/i, /double/i);
  if (iEmp < 0) return { rows: template || [], filled: 0, warnings: ['This file has no "Employee ID" column. Download the template from Wagepoint (Hours > Import hours > Download CSV template).'] };
  const warnings = [];
  if (iReg < 0) warnings.push('No regular-hours column found in the template; regular hours were not filled.');
  if (iOt < 0) warnings.push('No overtime column found in the template; overtime hours were not filled.');
  const groups = group(lines(sheets, ctx), (x) => `${x.p.payrollId || ''}|${jobCode(x.j)}`);
  const byKey = new Map(groups.map((g) => [`${g.p.payrollId || ''}|${jobCode(g.j)}`, g]));
  const used = new Set();
  let filled = 0;
  const rows = template.map((r, i) => {
    const out = [...r];
    if (i === 0) return out;
    const key = `${String(r[iEmp] || '').trim()}|${iJob >= 0 ? String(r[iJob] || '').trim() : ''}`;
    const g = byKey.get(key);
    if (!g) return out;
    used.add(key);
    if (iReg >= 0) out[iReg] = String(hrs(g.reg));
    if (iOt >= 0) out[iOt] = String(hrs(g.ot));
    if (iDt >= 0) out[iDt] = String(hrs(g.dt));
    else if (g.dt) warnings.push(`${g.p.name}: ${hrs(g.dt)} double-time hours have no column in the template.`);
    filled++;
    return out;
  });
  for (const [k, g] of byKey) {
    if (!used.has(k)) warnings.push(`${g.p.name}${g.j ? ` on ${jobCode(g.j)}` : ''}: ${hrs(g.reg + g.ot + g.dt)} h are not in the template (check the payroll ID and job ID).`);
  }
  return { rows, filled, warnings: [...warningsFor('wagepoint', sheets, ctx), ...warnings] };
}
