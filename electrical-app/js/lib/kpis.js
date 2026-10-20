// Crew and job KPIs from work tasks. Pure and DOM-free (the API's /api/v1/kpis uses it too).
//
// These numbers describe what was recorded, not how good anyone is: weather, deliveries,
// other trades, the mix of tasks and changes to the plan all move them. The screens say so.
//
// Definitions (one task = one worker, one day):
//   assigned        published tasks planned in the range
//   completed       of those, done
//   on time         done on or before the day it was first published for (baselineDate)
//   planned hours   estimated hours of the completed tasks; actual hours are what workers logged
//   qty per hour    quantity done / hours logged, per task type, only where both were recorded
//   blocked hours   time between "blocked" and its resolution (or now, while still blocked)
//   evidence        completed tasks that needed photos: how many had them (a waiver is not a photo)
//   rework          tasks a foreman reopened after they were done
import { localDay, planDays, workDays, endAfterWorkDays, isPublished } from './workplan.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, d = 2) => { const k = 10 ** d; return Math.round(v * k) / k; };
const pct = (a, b) => (b > 0 ? round((100 * a) / b, 1) : null);
const HOUR = 3_600_000;

/** Tasks planned in [from, to] (YYYY-MM-DD, either may be empty). */
export function inRange(tasks, from, to) {
  return (tasks || []).filter((t) => t.date && (!from || t.date >= from) && (!to || t.date <= to));
}

/** Hours a task spent blocked (open blocks count up to `now`). */
export function blockedHours(task, now = new Date()) {
  const end = now instanceof Date ? now.getTime() : Date.parse(now);
  let ms = 0;
  for (const b of task?.blocks || []) {
    const a = Date.parse(b.at);
    const z = b.resolvedAt ? Date.parse(b.resolvedAt) : (task.completedAt ? Date.parse(task.completedAt) : end);
    if (Number.isFinite(a) && Number.isFinite(z) && z > a) ms += z - a;
  }
  return round(ms / HOUR);
}

/** Was a done task finished on or before its first published day? */
export function onTime(task) {
  if (task?.status !== 'done' || !task.completedAt) return false;
  const due = task.baselineDate || task.date;
  const doneDay = localDay(task.completedAt);
  return Boolean(due && doneDay && doneDay <= due);
}

/** The key KPIs group "quantity per hour" by: the task type, else the unit. */
export const typeKey = (t) => String(t.taskType || t.unit || 'Other').trim() || 'Other';

/**
 * KPIs for a set of tasks (one worker, or a crew).
 * @returns {{ assigned: number, completed: number, completionPct: number|null, onTime: number, onTimePct: number|null,
 *   plannedHours: number, plannedHoursDone: number, actualHours: number, hoursRatio: number|null,
 *   byType: { type: string, unit: string, qty: number, hours: number, perHour: number|null, tasks: number }[],
 *   blockedHours: number, blockedTasks: number, blockReasons: { reason: string, count: number, hours: number }[],
 *   evidenceRequired: number, evidenceProvided: number, evidenceWaived: number, evidencePct: number|null,
 *   reopened: number, reopenCount: number, reworkPct: number|null }}
 */
export function summarize(tasks, { now = new Date() } = {}) {
  const pub = (tasks || []).filter(isPublished);
  const done = pub.filter((t) => t.status === 'done');
  const ot = done.filter(onTime).length;
  const plannedHours = pub.reduce((s, t) => s + num(t.estHours), 0);
  const plannedHoursDone = done.reduce((s, t) => s + num(t.estHours), 0);
  const withActual = done.filter((t) => t.actualHours != null && t.actualHours !== '');
  const actualHours = pub.reduce((s, t) => s + num(t.actualHours), 0);
  const plannedForActual = withActual.reduce((s, t) => s + num(t.estHours), 0);
  const actualForRatio = withActual.reduce((s, t) => s + num(t.actualHours), 0);

  const types = new Map();
  for (const t of pub) {
    const q = num(t.qtyDone), hrs = num(t.actualHours);
    if (!(q > 0) || !(hrs > 0)) continue;
    const k = typeKey(t);
    const e = types.get(k) || { type: k, unit: t.unit || '', qty: 0, hours: 0, tasks: 0 };
    e.qty += q; e.hours += hrs; e.tasks++;
    if (!e.unit && t.unit) e.unit = t.unit;
    types.set(k, e);
  }
  const byType = [...types.values()].map((e) => ({ ...e, qty: round(e.qty), hours: round(e.hours), perHour: e.hours > 0 ? round(e.qty / e.hours) : null }))
    .sort((a, b) => a.type.localeCompare(b.type));

  const reasons = new Map();
  let blocked = 0, blockedTasks = 0;
  for (const t of pub) {
    const bh = blockedHours(t, now);
    if ((t.blocks || []).length) blockedTasks++;
    blocked += bh;
    for (const b of t.blocks || []) {
      const r = b.reason || 'Other';
      const e = reasons.get(r) || { reason: r, count: 0, hours: 0 };
      e.count++;
      e.hours += blockedHours({ ...t, blocks: [b] }, now);
      reasons.set(r, e);
    }
  }
  const blockReasons = [...reasons.values()].map((e) => ({ ...e, hours: round(e.hours) })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const needEvidence = done.filter((t) => t.requiresPhoto);
  const provided = needEvidence.filter((t) => (t.photos || []).filter((p) => p?.dataUrl).length >= Math.max(1, num(t.minPhotos) || 1)).length;
  const waived = needEvidence.filter((t) => t.evidenceWaived).length;
  const reopened = pub.filter((t) => (t.reopens || []).length > 0);

  return {
    assigned: pub.length, completed: done.length, completionPct: pct(done.length, pub.length),
    onTime: ot, onTimePct: pct(ot, done.length),
    plannedHours: round(plannedHours), plannedHoursDone: round(plannedHoursDone), actualHours: round(actualHours),
    hoursRatio: plannedForActual > 0 ? round(actualForRatio / plannedForActual) : null,
    byType,
    blockedHours: round(blocked), blockedTasks, blockReasons,
    evidenceRequired: needEvidence.length, evidenceProvided: provided, evidenceWaived: waived, evidencePct: pct(provided, needEvidence.length),
    reopened: reopened.length, reopenCount: reopened.reduce((s, t) => s + t.reopens.length, 0), reworkPct: pct(reopened.length, done.length),
  };
}

/**
 * Per-worker KPIs over a date range, plus the crew total.
 * @param {object[]} tasks
 * @param {{ from?: string, to?: string, employeeIds?: string[], now?: Date }} [o]
 * @returns {{ workers: ({ employeeId: string } & ReturnType<typeof summarize>)[], crew: ReturnType<typeof summarize> }}
 */
export function crewKpis(tasks, { from = '', to = '', employeeIds = null, now = new Date() } = {}) {
  const scoped = inRange(tasks, from, to).filter((t) => t.employeeId && (!employeeIds || employeeIds.includes(t.employeeId)));
  const by = new Map();
  for (const t of scoped) { if (!by.has(t.employeeId)) by.set(t.employeeId, []); by.get(t.employeeId).push(t); }
  for (const id of employeeIds || []) if (!by.has(id)) by.set(id, []);
  const workers = [...by].map(([employeeId, list]) => ({ employeeId, ...summarize(list, { now }) }));
  return { workers, crew: summarize(scoped, { now }) };
}

/** Earned hours of a task: its estimate when done, a share of it for partial quantity. */
export function earnedHours(t) {
  const est = num(t.estHours);
  if (t.status === 'done') return est;
  if (num(t.qty) > 0 && num(t.qtyDone) > 0) return est * Math.min(1, num(t.qtyDone) / num(t.qty));
  return 0;
}

/** The day earned hours count on: completion, else the last progress update. */
const earnedDay = (t) => localDay(t.status === 'done' ? (t.completedAt || t.progressAt) : t.progressAt);

/**
 * Job progress against its plan: % complete overall and by phase (by estimated hours),
 * a burn-up of planned vs earned hours per working day, and a forecast finish at the
 * pace so far.
 * @param {object} plan workPlans record
 * @param {object[]} tasks the plan's tasks (drafts count as planned scope)
 * @param {{ today?: string }} [o]
 */
export function jobProgress(plan, tasks, { today = localDay() } = {}) {
  const list = (tasks || []).filter((t) => !plan?.id || t.planId === plan.id);
  const total = list.reduce((s, t) => s + num(t.estHours), 0);
  const earned = list.reduce((s, t) => s + earnedHours(t), 0);
  const phases = (plan?.phases || []).map((p) => ({ id: p.id, name: p.name, tasks: [] }));
  const other = { id: null, name: 'No phase', tasks: [] };
  for (const t of list) (phases.find((p) => p.id === t.phaseId) || other).tasks.push(t);
  if (other.tasks.length) phases.push(other);
  const phaseRows = phases.map((p) => {
    const tot = p.tasks.reduce((s, t) => s + num(t.estHours), 0);
    const ear = p.tasks.reduce((s, t) => s + earnedHours(t), 0);
    return { id: p.id, name: p.name, taskCount: p.tasks.length, done: p.tasks.filter((t) => t.status === 'done').length, totalHours: round(tot), earnedHours: round(ear), pct: pct(ear, tot) };
  });

  const days = planDays(plan);
  const opts = { skipWeekends: plan?.skipWeekends !== false, holidays: plan?.holidays || [] };
  const plannedByDay = new Map(), earnedByDay = new Map();
  for (const t of list) {
    if (t.date) plannedByDay.set(t.date, (plannedByDay.get(t.date) || 0) + num(t.estHours));
    const e = earnedHours(t);
    if (e > 0) { const d = earnedDay(t) || t.date; earnedByDay.set(d, (earnedByDay.get(d) || 0) + e); }
  }
  // Cumulative per working day. Work done on a day off (a Saturday catch-up) counts from the
  // next working day; work done after the plan's last day counts on the last point.
  const axis = days.length ? days : [...new Set([...plannedByDay.keys()])].sort();
  const earnedThrough = (d) => [...earnedByDay].reduce((s, [k, v]) => (k <= d ? s + v : s), 0);
  let cp = 0;
  const burnup = axis.map((d, i) => {
    cp += plannedByDay.get(d) || 0;
    const through = i === axis.length - 1 && today > d ? today : d;
    return { date: d, planned: round(cp), actual: d <= today ? round(earnedThrough(through)) : null };
  });

  // Forecast: remaining hours at the pace of the working days elapsed so far.
  const remaining = Math.max(0, total - earned);
  const elapsed = plan?.startDate && today >= plan.startDate ? workDays({ startDate: plan.startDate, endDate: today, ...opts }).length : 0;
  let forecastFinish = null;
  if (total > 0 && remaining <= 1e-9) {
    forecastFinish = list.map((t) => earnedDay(t) || t.date).filter(Boolean).sort().at(-1) || null;
  } else if (elapsed > 0 && earned > 0) {
    const perDay = earned / elapsed;
    const need = Math.ceil(remaining / perDay - 1e-9);
    forecastFinish = endAfterWorkDays(today, need + (workDays({ startDate: today, endDate: today, ...opts }).length ? 1 : 0), opts);
  }
  const plannedToDate = burnup.filter((b) => b.date <= today).at(-1)?.planned ?? 0;
  const lateBy = forecastFinish && plan?.endDate && forecastFinish > plan.endDate
    ? workDays({ startDate: plan.endDate, endDate: forecastFinish, ...opts }).length - (workDays({ startDate: plan.endDate, endDate: plan.endDate, ...opts }).length ? 1 : 0)
    : 0;
  return {
    totalHours: round(total), earnedHours: round(earned), pct: pct(earned, total),
    plannedToDate: round(plannedToDate), aheadBy: round(earned - plannedToDate),
    taskCount: list.length, done: list.filter((t) => t.status === 'done').length,
    phases: phaseRows, burnup, plannedFinish: plan?.endDate || null, forecastFinish, lateBy: Math.max(0, lateBy),
    workingDays: days.length, elapsedDays: elapsed,
  };
}

// ---------- CSV ----------

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  // A leading = + - @ would run as a formula in a spreadsheet: quote it with a leading apostrophe.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/**
 * KPI table as CSV rows. `name(employeeId)` labels each worker.
 * @param {ReturnType<typeof crewKpis>} k
 */
export function kpiCsv(k, { name = (id) => id, from = '', to = '' } = {}) {
  const head = ['Worker', 'From', 'To', 'Assigned', 'Completed', 'Completion %', 'On time', 'On time %', 'Planned h (all)', 'Planned h (done)', 'Actual h', 'Actual / planned',
    'Qty per hour by type', 'Blocked h', 'Blocked tasks', 'Block reasons', 'Evidence needed', 'Evidence provided', 'Evidence waived', 'Evidence %', 'Reopened', 'Rework %'];
  const row = (label, s) => [label, from, to, s.assigned, s.completed, s.completionPct, s.onTime, s.onTimePct, s.plannedHours, s.plannedHoursDone, s.actualHours, s.hoursRatio,
    s.byType.map((b) => `${b.type}: ${b.perHour ?? '-'} ${b.unit || ''}/h`.replace(/\s+\/h/, '/h')).join('; '),
    s.blockedHours, s.blockedTasks, s.blockReasons.map((r) => `${r.reason} (${r.count})`).join('; '),
    s.evidenceRequired, s.evidenceProvided, s.evidenceWaived, s.evidencePct, s.reopened, s.reworkPct];
  return toCsv([head, ...k.workers.map((w) => row(name(w.employeeId), w)), row('Crew total', k.crew)]);
}

/** Every task in a range as CSV (one row per task). */
export function tasksCsv(tasks, { name = (id) => id, job = () => '' } = {}) {
  const head = ['Date', 'Job', 'Phase', 'Task', 'Type', 'Worker', 'Status', 'Est h', 'Actual h', 'Qty', 'Qty done', 'Unit', 'Photo needed', 'Photos', 'On time', 'Blocked h', 'Reopened', 'Completed at'];
  return toCsv([head, ...tasks.map((t) => [t.date, job(t.jobId), t.phaseName, t.title, t.taskType, name(t.employeeId), t.status, t.estHours, t.actualHours, t.qty, t.qtyDone, t.unit,
    t.requiresPhoto ? 'yes' : 'no', (t.photos || []).length, t.status === 'done' ? (onTime(t) ? 'yes' : 'no') : '', blockedHours(t), (t.reopens || []).length, t.completedAt || ''])]);
}
