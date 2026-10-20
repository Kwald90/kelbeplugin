// The time clock's state changes, as store writes: clock in and out, travel, arriving at a job,
// attaching a location fix to an entry, applying travel segments found while the app was closed,
// and approving a week. No DOM; the time clock screen and the shift tracker call these.
//
// States: off the clock (no open entry) -> working (kind 'work', jobId) <-> travelling (kind
// 'travel', travelFromJobId, jobId = where they are going once known). Every change closes the
// open entry and opens the next at the same instant, so hours never overlap or go missing.
import { siteCheck, entriesForSegments } from './geo.js';

export const openEntry = (store, employeeId) => (employeeId ? store.list('timeEntries', (t) => t.employeeId === employeeId && t.clockIn && !t.clockOut)[0] || null : null);

const iso = (at) => (at ? new Date(at).toISOString() : new Date().toISOString());

/** Location fields for an entry from a fix (where it was taken and how it compares with the sites). */
export function locFields(fix, which, jobId, sites) {
  if (!fix) return {};
  const loc = { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? null, at: fix.at, source: fix.source || null };
  const check = siteCheck(fix, jobId, sites);
  const out = which === 'out' ? { clockOutLoc: loc, clockOutCheck: check || null } : { clockInLoc: loc, siteCheck: check || null };
  if (which === 'in') out.flag = check?.flag ? { ...check.flag, at: fix.at } : null;
  else if (check?.flag) out.clockOutFlag = { ...check.flag, at: fix.at };
  return out;
}

/**
 * Save a raw location point for an open shift. Refuses (returns null) when the entry is not this
 * person's open shift: location is never stored off the clock. `allowClosing` lets the clock-out
 * fix through (it is taken just before the entry closes).
 */
export function recordPoint(store, { entry, fix, source, siteId = null }) {
  if (!entry?.id || !fix) return null;
  const cur = store.get('timeEntries', entry.id);
  if (!cur || cur.clockOut || cur.employeeId !== entry.employeeId) return null;
  return store.add('locationPoints', {
    employeeId: cur.employeeId, timeEntryId: cur.id, jobId: siteId || cur.jobId || null,
    at: fix.at, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? null, source, device: fix.source || null,
  }, { silent: true });
}

/** Clock in. Returns the new entry. A second open shift for the same person is refused (null). */
export function clockIn(store, { employeeId, jobId = null, kind = 'work', travelFromJobId = null, at, note = '', locStatus = null }) {
  if (!employeeId || openEntry(store, employeeId)) return null;
  return store.add('timeEntries', {
    employeeId, jobId: jobId || null, kind: kind === 'travel' ? 'travel' : 'work', ...(kind === 'travel' ? { travelFromJobId: travelFromJobId || null } : {}),
    clockIn: iso(at), clockOut: null, breakMins: 0, breakStart: null, note: note || '', approved: false, source: 'clock', locStatus,
  });
}

/** Attach a clock-in or clock-out fix to an entry (and keep the raw point while the shift is open). */
export function attachFix(store, entryId, fix, which, sites, { source } = {}) {
  const cur = store.get('timeEntries', entryId);
  if (!cur || !fix) return cur;
  recordPoint(store, { entry: cur, fix, source: source || (which === 'out' ? 'clock-out' : 'clock-in') });
  return store.update('timeEntries', entryId, { ...locFields(fix, which, cur.jobId, sites), locStatus: 'captured' }, { silent: true });
}

/** Finish a running break and close the entry. */
export function closeEntry(store, entryId, { at, note } = {}) {
  const cur = store.get('timeEntries', entryId);
  if (!cur || cur.clockOut) return cur;
  const end = iso(at);
  let breakMins = Number(cur.breakMins) || 0;
  if (cur.breakStart) breakMins += Math.max(0, Math.round((Date.parse(end) - Date.parse(cur.breakStart)) / 60000));
  return store.update('timeEntries', cur.id, { clockOut: end, breakMins, breakStart: null, ...(note != null ? { note } : {}) });
}

/**
 * Switch an open shift to travel or to work at a job, at `at`. The open entry closes then; a
 * travel entry that ends at a job takes that job (travel is billed to the job travelled to).
 * Returns the new open entry.
 */
export function switchTo(store, open, { kind, jobId = null, at, note = '' }) {
  const cur = store.get('timeEntries', open?.id);
  if (!cur || cur.clockOut) return null;
  const when = iso(at);
  if (Date.parse(when) <= Date.parse(cur.clockIn)) {
    // Nothing recorded yet on this entry: change it in place instead of leaving a zero-length one.
    return store.update('timeEntries', cur.id, kind === 'travel'
      ? { kind: 'travel', travelFromJobId: cur.kind === 'travel' ? cur.travelFromJobId || null : cur.jobId || null, jobId: jobId || null }
      : { kind: 'work', jobId: jobId || null, travelFromJobId: null });
  }
  const patch = {};
  if (cur.kind === 'travel' && kind === 'work' && jobId && cur.jobId !== jobId) patch.jobId = jobId;
  if (Object.keys(patch).length) store.update('timeEntries', cur.id, patch, { silent: true });
  closeEntry(store, cur.id, { at: when });
  return store.add('timeEntries', {
    employeeId: cur.employeeId, jobId: jobId || null, kind: kind === 'travel' ? 'travel' : 'work',
    ...(kind === 'travel' ? { travelFromJobId: cur.kind === 'travel' ? cur.travelFromJobId || null : cur.jobId || null } : {}),
    clockIn: when, clockOut: null, breakMins: 0, breakStart: null, note, approved: false, source: 'clock', locStatus: cur.locStatus || null,
  });
}

/**
 * Apply work/travel segments (lib/geo.js buildTravelSegments) to the open shift: the open entry
 * becomes the first segment, later segments become new entries, and the last stays open.
 * Returns the new open entry.
 */
export function applySegments(store, open, segments) {
  const cur = store.get('timeEntries', open?.id);
  if (!cur || cur.clockOut || !segments?.length) return cur;
  const { update, create } = entriesForSegments(cur, segments, { keepOpen: true });
  // The break moves with the segments (geo.js splitBreak): a running one is never dropped.
  let last = store.update('timeEntries', cur.id, update);
  for (const c of create) last = store.add('timeEntries', { ...c, locStatus: cur.locStatus || null });
  return last;
}

/** A foreman's review of an off-site flag. */
export function reviewFlag(store, entryId, { by, note = '', at = new Date().toISOString() }) {
  const cur = store.get('timeEntries', entryId);
  if (!cur?.flag) return cur;
  return store.update('timeEntries', entryId, { flag: { ...cur.flag, reviewedAt: at, reviewedBy: by || null, reviewNote: note } }, { summary: 'reviewed off-site clock-in' });
}

/** Approve every closed, unapproved entry in `entries`. Returns how many changed. */
export function approveEntries(store, entries, { by, at = new Date().toISOString() } = {}) {
  let n = 0;
  for (const e of entries) {
    if (!e.clockOut || e.approved) continue;
    store.update('timeEntries', e.id, { approved: true, approvedAt: at, approvedBy: by || null }, { silent: true });
    n++;
  }
  return n;
}
