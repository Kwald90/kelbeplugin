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

const EVENT = 'ft:jobfocus';
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
  if (!job || ['complete', 'invoiced', 'cancelled'].includes(job.status)) return '';
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
