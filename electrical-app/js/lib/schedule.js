// Schedule logic (S16): the pure parts of the crew schedule, so they can be tested without a DOM.
//
// A schedule record is one person booked on one job for one day:
//   { jobId, employeeId, date: 'YYYY-MM-DD', startTime: 'HH:MM', endTime: 'HH:MM', hours, note }
// `hours` stays a number on every record because the job, employee, dashboard, safety and server code
// read it. An end time at or before the start time means the shift runs past midnight into the next
// day. Older records carry only `hours`: they read as starting at DEFAULT_START.

export const DEFAULT_START = '07:00';
export const DEFAULT_HOURS = 8;
export const VIEWS = ['day', 'week', 'month'];
const DAY_MIN = 1440;
const SNAP = 15;

// ---------- times ----------

/** 'HH:MM' (or 'H:MM') to minutes after midnight, or null when it is not a time. */
export function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Minutes (any whole number, wrapped to one day) to 'HH:MM'. */
export function toTime(min) {
  const m = ((Math.round(Number(min) || 0) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Length of a shift from start to end in minutes. An end before the start rolls to the next day
 * (22:00 to 06:00 is 8 h). Equal times are 0 (the form refuses them). null when either is not a time.
 */
export function spanMinutes(start, end) {
  const a = parseTime(start), b = parseTime(end);
  if (a == null || b == null) return null;
  return b >= a ? b - a : b + DAY_MIN - a;
}

/** Hours between two times, rounded to the hundredth (07:00 to 15:30 is 8.5). */
export function spanHours(start, end) {
  const m = spanMinutes(start, end);
  return m == null ? null : round2(m / 60);
}

/** True when the shift runs past midnight into the next day (ending at exactly 00:00 does not). */
export function isOvernight(start, end) {
  const a = parseTime(start), b = parseTime(end);
  return a != null && b != null && b < a && b > 0;
}

/**
 * The times of a record, filling in older hours-only records: start DEFAULT_START, end start + hours.
 * startMin is minutes after midnight on `date`; endMin is minutes after midnight on `date` too, so it is
 * above 1440 when the shift runs into the next day.
 */
export function entryTimes(s) {
  let start = parseTime(s?.startTime);
  let end = parseTime(s?.endTime);
  const stored = Number(s?.hours);
  if (start == null) start = parseTime(DEFAULT_START);
  let length;
  if (end != null && parseTime(s?.startTime) != null) length = end >= start ? end - start : end + DAY_MIN - start;
  else length = Math.round((Number.isFinite(stored) && stored > 0 ? Math.min(stored, 24) : (stored === 0 ? 0 : DEFAULT_HOURS)) * 60);
  return {
    startTime: toTime(start), endTime: toTime(start + length),
    startMin: start, endMin: start + length,
    hours: round2(length / 60),
    overnight: start + length > DAY_MIN,
    legacy: !s?.startTime || !s?.endTime,
  };
}

/** The fields a form save writes: the two times plus the numeric hours other screens read. */
export function timeFields(startTime, endTime) {
  const a = parseTime(startTime), b = parseTime(endTime);
  if (a == null || b == null) return null;
  return { startTime: toTime(a), endTime: toTime(b), hours: spanHours(startTime, endTime) };
}

/** Move a shift by `delta` minutes (snapped to 15), keeping its length. The start stays on the same day. */
export function shiftTimes(s, delta) {
  const t = entryTimes(s);
  const len = t.endMin - t.startMin;
  const snapped = Math.round((Number(delta) || 0) / SNAP) * SNAP;
  const start = Math.min(DAY_MIN - SNAP, Math.max(0, Math.round((t.startMin + snapped) / SNAP) * SNAP));
  return { startTime: toTime(start), endTime: toTime(start + len), hours: round2(len / 60) };
}

/** Snap a minute position to the nearest `step` minutes. */
export function snapMinutes(min, step = 30) {
  return Math.round((Number(min) || 0) / step) * step;
}

/** A compact clock label for chips: '7:00a' / '3:30p' on 12-hour devices, '07:00' / '15:30' otherwise. */
export function clockLabel(min, hour12 = false) {
  const t = toTime(min);
  if (!hour12) return t;
  const [hh, mm] = t.split(':').map(Number);
  const h = hh % 12 || 12;
  return `${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'a' : 'p'}`;
}

/** '7a–3:30p' for a record, with '+1' when it ends the next day. */
export function rangeLabel(s, hour12 = false) {
  const t = entryTimes(s);
  return `${clockLabel(t.startMin, hour12)}–${clockLabel(t.endMin, hour12)}${t.overnight ? ' +1' : ''}`;
}

/** Hours as a short label: 8 -> '8h', 8.5 -> '8.5h', 7.75 -> '7.75h'. */
export function hoursLabel(h) {
  return `${round2(Number(h) || 0)}h`;
}

// ---------- days ----------

function parseDay(day) { return new Date(String(day).slice(0, 10) + 'T00:00:00'); }
export function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(parseDay(s)); }

export function addDays(day, n) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

/** Monday of the week containing `day`. */
export function weekStart(day) {
  const d = parseDay(day);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d);
}

export function monthStart(day) { return String(day).slice(0, 8) + '01'; }

export function addMonths(day, n) {
  const d = parseDay(monthStart(day));
  d.setMonth(d.getMonth() + n);
  return localDay(d);
}

/** Every day of the month containing `day`, padded to whole Monday-first weeks: an array of weeks of 7 days. */
export function monthGrid(day) {
  const first = monthStart(day);
  const last = addDays(addMonths(first, 1), -1);
  const weeks = [];
  for (let w = weekStart(first); w <= last; w = addDays(w, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)));
  return weeks;
}

/** The first and last day a view shows around `anchor`, and the days in it. */
export function viewRange(view, anchor) {
  if (view === 'day') return { from: anchor, to: anchor, days: [anchor] };
  if (view === 'month') {
    const weeks = monthGrid(anchor);
    const days = weeks.flat();
    return { from: days[0], to: days[days.length - 1], days, weeks };
  }
  const from = weekStart(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return { from, to: days[6], days };
}

/** The anchor one step back (dir -1) or forward (+1) in a view. */
export function stepAnchor(view, anchor, dir) {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'month') return addMonths(anchor, dir);
  return addDays(weekStart(anchor), 7 * dir);
}

export function normalizeView(v) { return VIEWS.includes(v) ? v : 'week'; }

/**
 * Where the screen opens: ?day= opens Day view, ?week= opens Week view on that week (the link the job
 * screens and older bookmarks use), ?month= opens Month view, ?view= picks a view; otherwise the
 * view saved on this device, on today.
 */
export function initialState(query = {}, saved, today) {
  if (isDay(query.day)) return { view: 'day', anchor: query.day };
  if (isDay(query.week)) return { view: 'week', anchor: weekStart(query.week) };
  if (isDay(query.month)) return { view: 'month', anchor: query.month };
  if (/^\d{4}-\d{2}$/.test(String(query.month || ''))) return { view: 'month', anchor: `${query.month}-01` };
  return { view: normalizeView(query.view || saved), anchor: today };
}

// ---------- records ----------

/** A store.list predicate for the filters: crew member and job ('' = all). */
export function entryFilter({ employeeId = '', jobId = '' } = {}) {
  return (s) => (!employeeId || s?.employeeId === employeeId) && (!jobId || s?.jobId === jobId);
}

/** Total hours of a set of records. */
export function totalHours(rows) {
  return round2((rows || []).reduce((n, s) => n + (Number(s?.hours) || entryTimes(s).hours || 0), 0));
}

/**
 * The pieces of shifts that fall on `day`, in minutes after that day's midnight: the day's own shifts
 * (cut at midnight, `continues` set when they run on) and the after-midnight tail of the previous day's
 * overnight shifts (`carried`).
 */
export function daySegments(rows, day) {
  const prev = addDays(day, -1);
  const out = [];
  for (const s of rows || []) {
    const t = entryTimes(s);
    if (s.date === day) out.push({ entry: s, start: t.startMin, end: Math.min(t.endMin, DAY_MIN), continues: t.endMin > DAY_MIN, carried: false });
    else if (s.date === prev && t.endMin > DAY_MIN) out.push({ entry: s, start: 0, end: t.endMin - DAY_MIN, continues: false, carried: true });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Put overlapping segments on separate lanes: each gets `lane`; returns the number of lanes used (at least 1). */
export function assignLanes(segments) {
  const ends = [];
  for (const seg of segments) {
    let lane = ends.findIndex((e) => e <= seg.start);
    if (lane < 0) { lane = ends.length; ends.push(seg.end); } else ends[lane] = seg.end;
    seg.lane = lane;
  }
  return Math.max(1, ends.length);
}

/**
 * The hours the Day timeline shows: 06:00 to 18:00, widened to whole hours around every segment.
 * Returns { from, to } in minutes.
 */
export function dayWindow(segments, base = { from: 6 * 60, to: 18 * 60 }) {
  let from = base.from, to = base.to;
  for (const s of segments || []) { from = Math.min(from, s.start); to = Math.max(to, s.end); }
  return { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(DAY_MIN, Math.ceil(to / 60) * 60) };
}

/**
 * Month cell summary: per job, how many people and hours on that day. Sorted most hours first.
 * Returns [{ jobId, people, hours }].
 */
export function jobsOnDay(rows, day) {
  const by = new Map();
  for (const s of rows || []) {
    if (s.date !== day) continue;
    const j = by.get(s.jobId) || { jobId: s.jobId, people: new Set(), hours: 0 };
    j.people.add(s.employeeId);
    j.hours += Number(s.hours) || 0;
    by.set(s.jobId, j);
  }
  return [...by.values()].map((j) => ({ jobId: j.jobId, people: j.people.size, hours: round2(j.hours) }))
    .sort((a, b) => b.hours - a.hours || String(a.jobId).localeCompare(String(b.jobId)));
}

/**
 * What a drag-and-drop move changes on a record: the day and/or the person, plus the times when the
 * record was hours-only (so the move writes them down). null when nothing changes.
 */
export function movePatch(s, { date, employeeId } = {}) {
  const patch = {};
  if (date && date !== s.date) patch.date = date;
  if (employeeId && employeeId !== s.employeeId) patch.employeeId = employeeId;
  if (!Object.keys(patch).length) return null;
  if (!s.startTime || !s.endTime) {
    const t = entryTimes(s);
    patch.startTime = t.startTime; patch.endTime = t.endTime; patch.hours = t.hours;
  }
  return patch;
}

/** Most recent start/end used on this device, so the next new assignment starts with the crew's usual hours. */
export function rememberedTimes(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (v && spanMinutes(v.startTime, v.endTime) > 0) return { startTime: toTime(parseTime(v.startTime)), endTime: toTime(parseTime(v.endTime)) };
  } catch { /* fall through */ }
  return { startTime: DEFAULT_START, endTime: toTime(parseTime(DEFAULT_START) + DEFAULT_HOURS * 60) };
}
