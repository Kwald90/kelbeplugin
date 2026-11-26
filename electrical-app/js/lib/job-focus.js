// Job focus: the "Working on" choice from the Today screen. When a person picks one job, every screen
// that files things against a job (plans and drawings, material requests, daily logs, photos, time,
// schedule…) opens already filtered to it and new records default to it. "All jobs" (empty id) puts
// things back the way they were: each screen shows everything and asks which job.
//
// It is the person's own choice on this device: localStorage, keyed by user and company database,
// like the Today wheel prefs (lib/wheel.js). It never syncs and never changes anyone else's view.
//
// Screens use it like this:
//   import { jobFocus, setJobFocus, onJobFocus, focusFilter } from '../lib/job-focus.js';
//   const focus = jobFocus(store, auth);               // '' = all jobs, else a job id that exists
//   const rows = store.list('materialRequests', focusFilter(focus));
//   new-record form: { name: 'jobId', value: entry?.jobId || focus || '' }
//   const off = onJobFocus(() => draw());              // call off() when the screen unmounts
//
// Job pickers go most-used first: rankJobs(jobs) here, or `rank: 'jobs'` on a ui.field select.
// The shell counts a use whenever this person files a record against a job (usageFromChange).

import { noteUse, rankByUse } from './usage-rank.js';

const EVENT = 'ft:jobfocus';
/** Jobs in these states can't be the focus and drop out of the "Working on" list. */
export const CLOSED_STATUSES = ['complete', 'invoiced', 'cancelled'];
const key = (uid, db) => `ft.jobFocus.${db || 'local'}.${uid || 'local'}`;
const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const ids = (store, auth) => [auth?.current?.()?.id, store?.dbName];

/** The raw saved id for a user + database ('' when none or storage is blocked). */
export function readFocus(uid, db) {
  try { return String(storage()?.getItem(key(uid, db)) || ''); } catch { return ''; }
}

/** Save the focus ('' or null = all jobs) and tell open screens. */
export function writeFocus(uid, db, jobId) {
  const v = jobId ? String(jobId) : '';
  try {
    const s = storage();
    if (v) s?.setItem(key(uid, db), v); else s?.removeItem(key(uid, db));
  } catch { /* storage blocked: the choice lasts for this page only */ }
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { jobId: v } })); } catch { /* no DOM (tests) */ }
  return v;
}

/**
 * The focused job id for the signed-in person, or '' for all jobs. A saved id whose job was deleted
 * or closed out (complete / invoiced) reads as '' so nobody is stuck filtered to a job they cannot see.
 */
export function jobFocus(store, auth) {
  const [uid, db] = ids(store, auth);
  const id = readFocus(uid, db);
  if (!id) return '';
  const job = store?.get?.('jobs', id);
  if (!job || CLOSED_STATUSES.includes(job.status)) return '';
  return id;
}

/** The focused job record, or null. */
export function focusedJob(store, auth) {
  const id = jobFocus(store, auth);
  return id ? store.get('jobs', id) : null;
}

export function setJobFocus(store, auth, jobId) {
  const [uid, db] = ids(store, auth);
  return writeFocus(uid, db, jobId);
}

/** Run fn(jobId) whenever the focus changes. Returns an unsubscribe function. */
export function onJobFocus(fn) {
  const handler = (e) => fn(e?.detail?.jobId || '');
  try { globalThis.addEventListener?.(EVENT, handler); } catch { /* no DOM */ }
  return () => { try { globalThis.removeEventListener?.(EVENT, handler); } catch { /* ignore */ } };
}

/**
 * A store.list predicate for records filed under a job. With no focus it keeps everything. `field`
 * names the record's job id field (default 'jobId').
 */
export function focusFilter(jobId, field = 'jobId') {
  if (!jobId) return () => true;
  return (r) => r?.[field] === jobId;
}

/** Can this job be worked on (and so be the focus)? */
export const isOpenJob = (job) => Boolean(job) && !CLOSED_STATUSES.includes(job.status);

/** "1234 · Smith reno" */
export const jobLabel = (job) => (job ? [job.number, job.title].filter(Boolean).join(' · ') || 'Job' : '');

/**
 * Jobs most-used first, the rest in the order given. With `focus`, that job leads the list.
 * opts.uid as in usage-rank (defaults to the signed-in person).
 */
export function rankJobs(jobs, { focus = '', uid, now } = {}) {
  const ranked = rankByUse('jobs', jobs || [], (j) => j?.id, { uid, now });
  const i = focus ? ranked.findIndex((j) => j?.id === focus) : -1;
  return i > 0 ? [ranked[i], ...ranked.slice(0, i), ...ranked.slice(i + 1)] : ranked;
}

/** Choices for the "Working on" picker: All jobs, then the open jobs, most-used first. */
export function focusChoices(jobs, opts = {}) {
  const open = (jobs || []).filter(isOpenJob)
    .sort((a, b) => String(b.number || '').localeCompare(String(a.number || ''), undefined, { numeric: true }));
  return [{ value: '', label: 'All jobs' }, ...rankJobs(open, opts).map((j) => ({ value: j.id, label: jobLabel(j) }))];
}

/** Count one use of a job (picked, opened, focused or filed against). */
export function noteJobUse(jobId, opts = {}) { if (jobId) noteUse('jobs', jobId, opts); }

/** The job a list screen opens on: an explicit ?jobId wins, else the focus ('' = all). */
export function startingJob(store, auth, queryJobId) { return queryJobId || jobFocus(store, auth); }

/**
 * Which pick-lists a store change counts toward: [[list, id], ...]. Only this person's own new
 * records count (not edits, which autosave often, and not changes synced in from other devices).
 */
export function usageFromChange(change) {
  const { coll, type, record, remote } = change || {};
  if (remote || type !== 'add' || !record || !coll || coll === 'auditLog') return [];
  const out = [];
  if (coll === 'jobs') out.push(['jobs', record.id]);
  else if (record.jobId) out.push(['jobs', record.jobId]);
  if (coll === 'clients') out.push(['clients', record.id]);
  else if (record.clientId) out.push(['clients', record.clientId]);
  if (record.vendorId) out.push(['vendors', record.vendorId]);
  return out.filter(([, id]) => id != null && id !== '');
}
