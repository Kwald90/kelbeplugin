// Work plans and daily task lists: dates, spreading, capacity, publishing, the worker's
// task transitions, and the write rules for tasks. Pure and DOM-free: the API imports the
// rules from here (server/src/auth/access.js), like plans.js, so a phone that worked
// offline and the server agree on what a worker may change and when a task counts as done.
//
// Records (collections in js/store.js, schemas in js/schema/):
//   workPlans      a job broken into phases over a date range, with the days already published
//   workTasks      one task for ONE worker on ONE day (several assignees = one task each,
//                  sharing a groupId), so each person checks off their own work
//   taskTemplates  reusable task definitions
//   huddles        the morning meeting: when, who led it, who tapped "Got it"

export const TASK_STATUSES = ['draft', 'todo', 'in-progress', 'blocked', 'done'];
export const OPEN_STATUSES = ['todo', 'in-progress', 'blocked'];
export const PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
export const DEFAULT_DAY_HOURS = 8;
export const MAX_PHOTOS = 6;
/** Evidence photos are JPEG data URLs until object storage lands; each is capped. */
export const PHOTO_MAX_BYTES = 300 * 1024;
export const PHOTO_MAX_SIDE = 1280;

export const BLOCK_REASONS = [
  'Waiting on material', 'Waiting on another trade', 'No access to the area', 'Missing drawing or information',
  'Waiting on inspection', 'Tool or equipment problem', 'Safety concern', 'Other',
];

/**
 * Fields the assignee owns: their progress. Last writer wins on this group by `progressAt`,
 * separately from the foreman's fields, so an offline completion and a foreman's edit made
 * meanwhile both survive.
 */
export const PROGRESS_FIELDS = ['status', 'startedAt', 'completedAt', 'actualHours', 'qtyDone', 'note', 'blocks', 'photos', 'progressAt', 'progressBy'];
/** Set once and never cleared by an older copy: seen ("new" badge) and "Got it". */
export const STICKY_FIELDS = ['seenAt', 'ackAt', 'ackVia'];
/** Everything an electrician or apprentice may change on their own task. */
export const WORKER_FIELDS = [...PROGRESS_FIELDS, ...STICKY_FIELDS];
const BOOKKEEPING = new Set(['id', 'createdAt', 'updatedAt']);

// ---------- dates (YYYY-MM-DD, calendar arithmetic in UTC so DST never shifts a day) ----------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
export const isDay = (s) => typeof s === 'string' && DAY_RE.test(s);
const toUTC = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUTC = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const addDays = (day, n) => fromUTC(toUTC(day) + n * 86_400_000);
export const dayOfWeek = (day) => new Date(toUTC(day)).getUTCDay();
export const isWeekend = (day) => { const w = dayOfWeek(day); return w === 0 || w === 6; };
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86_400_000);
/** The local calendar day of a timestamp (ISO string or Date). */
export function localDay(t = new Date()) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- holidays ----------

function easterSunday(y) { // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}
/** nth weekday (0 = Sunday) of a month, n from 1. */
function nthWeekday(y, month, weekday, n) {
  const first = `${y}-${pad(month)}-01`;
  return addDays(first, ((weekday - dayOfWeek(first) + 7) % 7) + 7 * (n - 1));
}
const victoriaDay = (y) => { let d = `${y}-05-24`; while (dayOfWeek(d) !== 1) d = addDays(d, -1); return d; };

// Statutory holidays by province, from each province's employment standards rules.
// VERIFY each year and against your collective agreement: lists change (e.g. Sept 30) and
// some days are only commonly observed. The plan's holiday list stays editable.
const H = {
  newYear: ['New Year\'s Day', (y) => `${y}-01-01`, true],
  family: ['Family Day', (y) => nthWeekday(y, 2, 1, 3)],
  goodFriday: ['Good Friday', (y) => addDays(easterSunday(y), -2)],
  victoria: ['Victoria Day', victoriaDay],
  canada: ['Canada Day', (y) => `${y}-07-01`, true],
  civic: ['Civic holiday', (y) => nthWeekday(y, 8, 1, 1)],
  labour: ['Labour Day', (y) => nthWeekday(y, 9, 1, 1)],
  truth: ['National Day for Truth and Reconciliation', (y) => `${y}-09-30`, true],
  thanksgiving: ['Thanksgiving', (y) => nthWeekday(y, 10, 1, 2)],
  remembrance: ['Remembrance Day', (y) => `${y}-11-11`, true],
  christmas: ['Christmas Day', (y) => `${y}-12-25`, true],
  boxing: ['Boxing Day', (y) => `${y}-12-26`, true],
};
const PROVINCE_HOLIDAYS = {
  ON: ['newYear', 'family', 'goodFriday', 'victoria', 'canada', 'labour', 'thanksgiving', 'christmas', 'boxing'],
  BC: ['newYear', 'family', 'goodFriday', 'victoria', 'canada', 'civic', 'labour', 'truth', 'thanksgiving', 'remembrance', 'christmas'],
  AB: ['newYear', 'family', 'goodFriday', 'victoria', 'canada', 'labour', 'thanksgiving', 'remembrance', 'christmas'],
  SK: ['newYear', 'family', 'goodFriday', 'victoria', 'canada', 'civic', 'labour', 'thanksgiving', 'remembrance', 'christmas'],
  MB: ['newYear', 'family', 'goodFriday', 'victoria', 'canada', 'labour', 'truth', 'thanksgiving', 'christmas'],
  NB: ['newYear', 'family', 'goodFriday', 'canada', 'civic', 'labour', 'remembrance', 'christmas'],
  NS: ['newYear', 'family', 'goodFriday', 'canada', 'labour', 'remembrance', 'christmas'],
  PE: ['newYear', 'family', 'goodFriday', 'canada', 'labour', 'truth', 'remembrance', 'christmas'],
  NL: ['newYear', 'goodFriday', 'canada', 'labour', 'remembrance', 'christmas'],
};

/**
 * Days off for a province and year: [{ date, name }], sorted. A fixed-date holiday on a
 * weekend moves to the next free weekday (Christmas on a Saturday is observed Monday,
 * Boxing Day then Tuesday).
 */
export function holidaysFor(year, province = 'ON') {
  const keys = PROVINCE_HOLIDAYS[province] || PROVINCE_HOLIDAYS.ON;
  const taken = new Set();
  const out = [];
  for (const k of keys) {
    const [name, fn, fixed] = H[k];
    let date = fn(year);
    if (fixed) while (isWeekend(date) || taken.has(date)) date = addDays(date, 1);
    taken.add(date);
    out.push({ date, name });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Holidays between two days (inclusive), across years. */
export function holidaysBetween(from, to, province) {
  if (!isDay(from) || !isDay(to)) return [];
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const h of holidaysFor(y, province)) if (h.date >= from && h.date <= to) out.push(h);
  }
  return out;
}

// ---------- working days ----------

const offDay = (day, { skipWeekends = true, holidays = [] } = {}) => (skipWeekends && isWeekend(day)) || holidays.includes(day);

/** Working days from start to end inclusive. `holidays` is a list of YYYY-MM-DD. */
export function workDays({ startDate, endDate, skipWeekends = true, holidays = [] }) {
  if (!isDay(startDate) || !isDay(endDate) || endDate < startDate) return [];
  const out = [];
  for (let d = startDate, i = 0; d <= endDate && i < 3700; d = addDays(d, 1), i++) {
    if (!offDay(d, { skipWeekends, holidays })) out.push(d);
  }
  return out;
}

/** The day `count` working days long from `start` (start counts when it is a working day). */
export function endAfterWorkDays(start, count, opts = {}) {
  if (!isDay(start) || !(count >= 1)) return start;
  let d = start, n = 0;
  for (let i = 0; i < 3700; i++, d = addDays(d, 1)) {
    if (!offDay(d, opts)) { n++; if (n >= count) return d; }
  }
  return d;
}

/** The next working day after `day`. */
export function nextWorkDay(day, opts = {}) {
  let d = addDays(day, 1);
  for (let i = 0; i < 60 && offDay(d, opts); i++) d = addDays(d, 1);
  return d;
}

/** A plan's working days. */
export function planDays(plan) {
  return plan ? workDays({ startDate: plan.startDate, endDate: plan.endDate, skipWeekends: plan.skipWeekends !== false, holidays: plan.holidays || [] }) : [];
}

// ---------- tasks ----------

/** A task with every field defaulted. One task = one worker, one day. */
export function newTask(fields = {}) {
  return {
    planId: null, jobId: null, phaseId: null, phaseName: '', groupId: null,
    title: '', description: '', taskType: '', date: null, employeeId: null, order: 0,
    estHours: 0, qty: null, unit: '', priority: 'normal', requiresPhoto: false, minPhotos: 1,
    dependsOn: [], link: null,
    status: 'draft', publishedAt: null, publishedBy: null, baselineDate: null, lateAdd: false,
    seenAt: null, ackAt: null, ackVia: null,
    startedAt: null, completedAt: null, actualHours: null, qtyDone: null, note: '', blocks: [], photos: [],
    reopens: [], evidenceWaived: null, progressAt: null, progressBy: null,
    ...fields,
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round(v * 100) / 100;

/** Split a total into n parts that add back up exactly (whole numbers when `integer`). */
export function splitEven(total, n, { integer = false } = {}) {
  if (!(n > 0)) return [];
  const t = num(total);
  if (integer) {
    const whole = Math.round(t);
    const base = Math.floor(whole / n);
    let rest = whole - base * n;
    return Array.from({ length: n }, () => base + (rest-- > 0 ? 1 : 0));
  }
  const base = Math.floor((t / n) * 100) / 100;
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] = round2(t - base * (n - 1));
  return parts;
}

/**
 * "Spread across days": split a quantity (400 boxes) and its hours over days x workers.
 * Hours come from `ratePerHour` (qty / rate) when given, else `totalHours` is split the same way.
 * Slots that would get nothing are left out. Returns task fields (drafts), day by day.
 * @param {{ base?: object, days: string[], workers: (string|null)[], totalQty?: number|null, totalHours?: number, ratePerHour?: number, integer?: boolean, groupId?: string }} o
 */
export function spreadTask({ base = {}, days, workers, totalQty = null, totalHours = 0, ratePerHour = 0, integer = true, groupId = null }) {
  const people = workers?.length ? workers : [null];
  const slots = [];
  for (const date of days || []) for (const employeeId of people) slots.push({ date, employeeId });
  if (!slots.length) return [];
  const hasQty = totalQty != null && num(totalQty) > 0;
  const qtys = hasQty ? splitEven(totalQty, slots.length, { integer }) : slots.map(() => null);
  const hours = !hasQty || !(num(ratePerHour) > 0) ? splitEven(totalHours, slots.length) : null;
  const out = [];
  slots.forEach((s, i) => {
    const qty = qtys[i];
    const est = hours ? hours[i] : round2(qty / num(ratePerHour));
    if (hasQty && !(qty > 0)) return;
    if (!hasQty && !(est > 0) && num(totalHours) > 0) return;
    out.push(newTask({ ...base, groupId: groupId ?? base.groupId ?? null, date: s.date, employeeId: s.employeeId, qty: hasQty ? qty : (base.qty ?? null), estHours: est }));
  });
  return out;
}

/** Planned hours per worker per day: Map 'employeeId|date' -> hours (done tasks included). */
export function dayLoads(tasks) {
  const m = new Map();
  for (const t of tasks || []) {
    if (!t.employeeId || !t.date) continue;
    const k = `${t.employeeId}|${t.date}`;
    m.set(k, round2((m.get(k) || 0) + num(t.estHours)));
  }
  return m;
}

/**
 * Days where a worker's planned hours exceed their day.
 * @param {(employeeId: string, date: string) => number} [capacity] hours available (default 8)
 * @returns {{ employeeId: string, date: string, hours: number, capacity: number, overBy: number }[]}
 */
export function capacityWarnings(tasks, capacity = () => DEFAULT_DAY_HOURS) {
  const out = [];
  for (const [k, hours] of dayLoads(tasks)) {
    const [employeeId, date] = k.split('|');
    const cap = num(capacity(employeeId, date)) || DEFAULT_DAY_HOURS;
    if (hours > cap + 1e-9) out.push({ employeeId, date, hours, capacity: cap, overBy: round2(hours - cap) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId));
}

/** Sort for a day list: by day, then the foreman's order, then priority, then when added. */
export function sortTasks(tasks) {
  return [...(tasks || [])].sort((a, b) => (a.date || '').localeCompare(b.date || '')
    || num(a.order) - num(b.order)
    || (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
    || (a.createdAt || '').localeCompare(b.createdAt || ''));
}

/** Tasks this one waits on that are not done yet (dependsOn holds task ids or group ids). */
export function waitingOn(task, all) {
  const deps = new Set(task?.dependsOn || []);
  if (!deps.size) return [];
  return (all || []).filter((t) => t.id !== task.id && (deps.has(t.id) || (t.groupId && deps.has(t.groupId))) && t.status !== 'done');
}

// ---------- publishing ----------

export const isPublished = (t) => Boolean(t) && t.status !== 'draft';
export const isDayPublished = (plan, date) => Boolean(plan?.published?.[date]);

/**
 * Publish a day: every draft with an assignee becomes the worker's task (status todo).
 * A day that is over can't be published. Returns patches to apply, and what was skipped.
 * @returns {{ error?: string, patches: { id: string, patch: object }[], skipped: { id: string, reason: string }[] }}
 */
export function publishDay(tasks, date, { now = new Date().toISOString(), by = null, today = localDay() } = {}) {
  if (!isDay(date)) return { error: 'Pick a day to publish.', patches: [], skipped: [] };
  if (date < today) return { error: "That day is over. Move its tasks to a later day first.", patches: [], skipped: [] };
  const patches = [], skipped = [];
  for (const t of tasks || []) {
    if (t.date !== date || t.status !== 'draft') continue;
    if (!t.employeeId) { skipped.push({ id: t.id, reason: 'unassigned' }); continue; }
    if (!String(t.title || '').trim()) { skipped.push({ id: t.id, reason: 'untitled' }); continue; }
    patches.push({ id: t.id, patch: { status: 'todo', publishedAt: now, publishedBy: by, baselineDate: t.baselineDate || date, lateAdd: false } });
  }
  return { patches, skipped };
}

/**
 * State for a task added to (or moved onto) a day: a day that is already published gets it
 * straight away, flagged so the worker sees a "new" badge.
 */
export function placement(plan, date, { now = new Date().toISOString(), by = null, adHoc = false } = {}) {
  if (adHoc || isDayPublished(plan, date)) return { status: 'todo', publishedAt: now, publishedBy: by, baselineDate: date, lateAdd: true };
  return { status: 'draft' };
}

/** Move a task to another day. A draft landing on a published day is published. */
export function moveTask(task, date, plan, opts = {}) {
  if (task.status === 'done') return { error: 'This task is done. Reopen it before moving it.' };
  const patch = { date };
  if (task.status === 'draft') Object.assign(patch, placement(plan, date, opts));
  return { patch };
}

/**
 * Give a task to someone else. A draft just changes hands. A published task is replaced by a
 * copy for the new person (new id), so the first person's phone drops it on their next sync
 * and the second person's picks it up. Started or finished work stays with whoever did it.
 * @returns {{ patch?: object, replace?: { removeId: string, add: object }, error?: string }}
 */
export function reassign(task, employeeId, { newId, now = new Date().toISOString(), by = null } = {}) {
  if (task.employeeId === employeeId) return { patch: {} };
  if (task.status === 'draft') return { patch: { employeeId } };
  if (task.status !== 'todo' || task.startedAt) return { error: `${task.status === 'done' ? 'This task is done' : 'This task has been started'}. Add a new task for the rest of the work instead.` };
  const { id, createdAt, updatedAt, version, ...rest } = task;
  return { replace: { removeId: id, add: { ...rest, id: newId, employeeId, seenAt: null, ackAt: null, ackVia: null, lateAdd: true, publishedAt: now, publishedBy: by, movedFrom: id } } };
}

/** Copy one day's tasks to another day as drafts (progress and photos left behind). */
export function copyDay(tasks, from, to, { keepAssignees = true } = {}) {
  return sortTasks((tasks || []).filter((t) => t.date === from)).map((t) => newTask({
    planId: t.planId, jobId: t.jobId, phaseId: t.phaseId, phaseName: t.phaseName, title: t.title, description: t.description,
    taskType: t.taskType, date: to, employeeId: keepAssignees ? t.employeeId : null, order: t.order, estHours: t.estHours,
    qty: t.qty, unit: t.unit, priority: t.priority, requiresPhoto: t.requiresPhoto, minPhotos: t.minPhotos, link: t.link, copiedFrom: t.id,
  }));
}

/** Task fields from a saved template. */
export function fromTemplate(tpl, fields = {}) {
  return newTask({
    title: tpl?.title || tpl?.name || '', description: tpl?.description || '', taskType: tpl?.taskType || '', unit: tpl?.unit || '',
    qty: tpl?.qty ?? null, estHours: num(tpl?.estHours), priority: tpl?.priority || 'normal',
    requiresPhoto: Boolean(tpl?.requiresPhoto), minPhotos: tpl?.minPhotos || 1, phaseName: tpl?.phaseName || '', templateId: tpl?.id ?? null, ...fields,
  });
}

// ---------- the worker's day ----------

/** A worker's published tasks for a day, in order. */
export function tasksFor(tasks, employeeId, day) {
  return sortTasks((tasks || []).filter((t) => t.employeeId === employeeId && t.date === day && isPublished(t)));
}

/** Published, unfinished tasks from before `day` (they carry over). */
export function carriedOver(tasks, employeeId, day) {
  return sortTasks((tasks || []).filter((t) => t.employeeId === employeeId && t.date && t.date < day && OPEN_STATUSES.includes(t.status)));
}

/** "New" badge: added to a published list after the fact and not opened yet. */
export const isNew = (t) => Boolean(t?.lateAdd) && !t.seenAt && isPublished(t);

/** Photos a task needs before it can be checked off (0 when none). */
export function photosNeeded(task) {
  if (!task?.requiresPhoto) return 0;
  return Math.min(MAX_PHOTOS, Math.max(1, Math.round(num(task.minPhotos) || 1)));
}

/** Why the task can't be done yet, or null. A foreman's waiver stands in for the photos. */
export function evidenceProblem(task) {
  const need = photosNeeded(task);
  if (!need || task.evidenceWaived) return null;
  const have = (task.photos || []).filter((p) => p?.dataUrl).length;
  if (have >= need) return null;
  return need === 1 ? 'This task needs a photo before it can be checked off.' : `This task needs ${need} photos before it can be checked off (${have} so far).`;
}

const stamp = (now, by) => ({ progressAt: now, progressBy: by });
const closeBlocks = (blocks, now) => (blocks || []).map((b) => (b.resolvedAt ? b : { ...b, resolvedAt: now }));

export function startTask(task, { now = new Date().toISOString(), by = null } = {}) {
  return { status: 'in-progress', startedAt: task.startedAt || now, blocks: closeBlocks(task.blocks, now), seenAt: task.seenAt || now, ...stamp(now, by) };
}

export function blockTask(task, reason, { now = new Date().toISOString(), by = null, note = '' } = {}) {
  const blocks = closeBlocks(task.blocks, now);
  blocks.push({ reason: String(reason || 'Other').slice(0, 120), note: String(note || '').slice(0, 1000), at: now, resolvedAt: null, by });
  return { status: 'blocked', blocks, startedAt: task.startedAt || now, seenAt: task.seenAt || now, ...stamp(now, by) };
}

export function unblockTask(task, { now = new Date().toISOString(), by = null } = {}) {
  return { status: 'in-progress', blocks: closeBlocks(task.blocks, now), ...stamp(now, by) };
}

/** Check a task off. Refused (error) while required evidence is missing. */
export function completeTask(task, { now = new Date().toISOString(), by = null, actualHours, qtyDone, note } = {}) {
  const patch = {
    status: 'done', completedAt: now, startedAt: task.startedAt || now, blocks: closeBlocks(task.blocks, now), seenAt: task.seenAt || now,
    ...stamp(now, by),
  };
  if (actualHours != null && actualHours !== '') patch.actualHours = Math.max(0, round2(num(actualHours)));
  if (qtyDone != null && qtyDone !== '') patch.qtyDone = Math.max(0, num(qtyDone));
  if (note != null) patch.note = String(note).slice(0, 4000);
  const problem = evidenceProblem({ ...task, ...patch });
  return problem ? { error: problem } : { patch };
}

/** The worker's own "oops, not done": back to in progress, not counted as rework. */
export function undoComplete(task, { now = new Date().toISOString(), by = null } = {}) {
  return { status: 'in-progress', completedAt: null, ...stamp(now, by) };
}

/** A foreman sends finished work back (counted as rework in the KPIs). */
export function reopenTask(task, reason, { now = new Date().toISOString(), by = null } = {}) {
  return { status: 'in-progress', completedAt: null, reopens: [...(task.reopens || []), { at: now, by, reason: String(reason || '').slice(0, 500) }], ...stamp(now, by) };
}

// ---------- write rules (PWA and API) ----------

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merge an incoming copy of a task with the stored one, field group by field group:
 * - a worker's write only carries their fields (WORKER_FIELDS); the rest stays as stored;
 * - progress fields: the copy with the later `progressAt` wins (so a foreman's stale copy
 *   never wipes out a completion, and a worker's stale copy never wipes out a reopen);
 * - seen/"Got it": once set, kept.
 * @param {object|null} existing stored data (null when new)
 * @param {object} next incoming data
 * @param {{ worker?: boolean }} [o]
 */
export function mergeTask(existing, next, { worker = false } = {}) {
  if (!existing) return { ...next };
  const out = { ...next };
  if (worker) {
    const allowed = new Set([...WORKER_FIELDS, ...BOOKKEEPING]);
    for (const k of new Set([...Object.keys(existing), ...Object.keys(next)])) {
      if (allowed.has(k)) continue;
      if (k in existing) out[k] = existing[k]; else delete out[k];
    }
  }
  if (String(existing.progressAt || '') > String(next.progressAt || '')) {
    for (const k of PROGRESS_FIELDS) { if (k in existing) out[k] = existing[k]; else delete out[k]; }
  }
  for (const k of STICKY_FIELDS) if (existing[k] && !out[k]) out[k] = existing[k];
  // Publishing is one-way: a stale draft copy never un-publishes a task.
  if (existing.status && existing.status !== 'draft' && out.status === 'draft') out.status = existing.status;
  return out;
}

/**
 * Why this write to a task is refused, or null. `who` is the writer: managers (owner, admin,
 * office, foreman) plan; everyone else only records progress on their own published tasks.
 * @param {{ isManager: boolean, employeeId: string|null }} who
 */
export function taskWriteProblem(who, existing, next) {
  if (!who.isManager) {
    if (!who.employeeId) return 'Your account is not linked to an employee record, so it has no tasks.';
    if (!existing) return 'Only a foreman or manager can add tasks.';
    if (!next) return 'Only a foreman or manager can remove tasks.';
    if (existing.employeeId !== who.employeeId || next.employeeId !== who.employeeId) return 'You can only update your own tasks.';
    if (!existing.status || existing.status === 'draft') return 'This task has not been published yet.';
    if (next.status === 'draft') return 'Only a foreman can move a task back to draft.';
    const allowed = new Set([...WORKER_FIELDS, ...BOOKKEEPING]);
    const changed = [...new Set([...Object.keys(existing), ...Object.keys(next)])].filter((k) => !allowed.has(k) && !same(existing[k], next[k]));
    if (changed.length) return 'You can only record progress on your tasks.';
  }
  if (existing && next && existing.status && existing.status !== 'draft' && next.status === 'draft') {
    return "A published task can't go back to draft. Move it or remove it instead.";
  }
  if (next && next.status === 'done' && existing?.status !== 'done') {
    const p = evidenceProblem(next);
    if (p) return p;
  }
  return null;
}

/**
 * What a write means for the people involved (for notifications): a task reaching a
 * worker's list, or a task getting blocked (the foreman should hear about it).
 * @returns {{ kind: 'published'|'blocked', taskId?: string, employeeId: string|null, date: string|null, reason?: string }[]}
 */
export function taskEvents(before, after) {
  if (!after) return [];
  const out = [];
  const base = { employeeId: after.employeeId || null, date: after.date || null, title: after.title || '' };
  if (isPublished(after) && (!before || before.status === 'draft')) out.push({ kind: 'published', lateAdd: Boolean(after.lateAdd), ...base });
  if (after.status === 'blocked' && before?.status !== 'blocked') {
    const open = (after.blocks || []).filter((b) => !b.resolvedAt).at(-1);
    out.push({ kind: 'blocked', reason: open?.reason || '', ...base });
  }
  return out;
}

// ---------- plans ----------

export const DEFAULT_PHASES = ['Rough-in', 'Service', 'Panel terminations', 'Devices and trim', 'Testing and closeout'];

/** A new plan's fields. `workingDays` (e.g. 35) sets the end date when no end date is given. */
export function newPlan({ jobId = null, name = '', startDate, workingDays = 0, endDate = null, skipWeekends = true, holidays = [], dayHours = DEFAULT_DAY_HOURS, crewIds = [], phases = DEFAULT_PHASES, newId = (i) => `ph${i + 1}` } = {}) {
  const end = endDate || (workingDays > 0 ? endAfterWorkDays(startDate, workingDays, { skipWeekends, holidays }) : startDate);
  return {
    jobId, name, startDate, endDate: end, skipWeekends, holidays: [...holidays].sort(), dayHours: num(dayHours) || DEFAULT_DAY_HOURS,
    crewIds: [...crewIds], phases: phases.map((p, i) => (typeof p === 'string' ? { id: newId(i), name: p, order: i } : { order: i, ...p })),
    published: {}, status: 'active', notes: '',
  };
}

// ---------- demo data ----------

/**
 * A sample plan for the local demo (seed.js): a 35-working-day job with phases, today's and
 * tomorrow's tasks published, and some finished work so My day and the KPIs have something.
 * @param {object} store the store (add/list)
 * @param {{ today: string, jobId?: string|null, employees: { id: string }[] }} o
 */
export function seedDemoPlan(store, { today, jobId = null, employees = [] }) {
  const S = { silent: true };
  const crew = employees.slice(0, 4).map((e) => e.id);
  if (!crew.length) return null;
  const start = (() => { let d = addDays(today, -8); while (isWeekend(d)) d = addDays(d, -1); return d; })();
  const plan = store.add('workPlans', newPlan({ jobId, name: 'Main build', startDate: start, workingDays: 35, crewIds: crew,
    phases: ['Level 1 rough-in', 'Level 2 rough-in', 'Service', 'Panel terminations', 'Devices and trim'] }), S);
  const days = planDays(plan);
  const ph = plan.phases;
  const at = (day, h) => `${day}T${pad(h)}:00:00.000Z`;
  const published = {};
  const add = (day, i, f) => {
    const isPast = day < today;
    const pub = day <= addDays(today, 1);
    if (pub && !published[day]) published[day] = { at: at(day < today ? day : today, 6), by: crew[0] };
    const t = newTask({ planId: plan.id, jobId, date: day, employeeId: crew[i % crew.length], ...f, status: pub ? 'todo' : 'draft',
      publishedAt: pub ? at(day < today ? day : today, 6) : null, publishedBy: pub ? crew[0] : null, baselineDate: pub ? day : null });
    if (isPast) {
      const hrs = round2(num(f.estHours) * (i % 3 === 0 ? 1.2 : 0.9));
      Object.assign(t, { status: 'done', startedAt: at(day, 14), completedAt: at(day, 21), actualHours: hrs, qtyDone: f.qty ?? null, progressAt: at(day, 21),
        photos: [], evidenceWaived: f.requiresPhoto ? { by: crew[0], at: at(day, 22), reason: 'Demo data: photos not included' } : null });
    }
    return store.add('workTasks', t, S);
  };
  const L1 = ph[0], L2 = ph[1], SV = ph[2];
  days.slice(0, days.indexOf(today) >= 0 ? days.indexOf(today) + 2 : 8).forEach((day, d) => {
    crew.forEach((_, i) => add(day, i, d < 5
      ? { phaseId: L1.id, phaseName: L1.name, title: 'Mount boxes', taskType: 'Boxes', qty: 40, unit: 'boxes', estHours: 6, requiresPhoto: i === 0 }
      : { phaseId: L2.id, phaseName: L2.name, title: 'Pull home runs', taskType: 'Home runs', qty: 6, unit: 'runs', estHours: 5, requiresPhoto: false }));
    add(day, d, { phaseId: SV.id, phaseName: SV.name, title: 'Service prep and grounding', taskType: 'Service', estHours: 2, priority: 'high', requiresPhoto: true });
  });
  store.update('workPlans', plan.id, { published }, S);
  return plan;
}
