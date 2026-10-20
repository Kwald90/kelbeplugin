// The shift tracker: everything location does while someone is clocked in, and nothing otherwise.
//
// - Clock in / out, start travel, arrive (the time clock's buttons and the suggestion bar both use
//   these flows). Each flow opens or changes the shift first and only then takes a fix, so a fix is
//   never taken off the clock.
// - In the browser (foreground only): while a shift is open and the app is visible, a fix every few
//   minutes and whenever the app comes back to the front. Leaving the job site's circle suggests
//   "Start travel"; arriving inside another site suggests "Start work here".
// - In the iOS app: the FishtapeGeofence plugin watches the job sites while the shift is open
//   (region monitoring and significant location changes, low power) and is stopped at clock-out.
//   What it saw while the app was closed is turned into work and travel parts (lib/geo.js
//   buildTravelSegments) and offered as one "Update my time" suggestion.
// Suggestions are never applied without a tap.
import { openEntry, clockIn, attachFix, closeEntry, switchTo, recordPoint, applySegments } from './clock.js';
import { sitesOf, suggestJob, travelSuggestion, buildTravelSegments, fmtDistance } from './geo.js';
import { getFix, fixProblem, isNative, startGeofence, stopGeofence, drainGeofenceEvents, pickRegions } from './location.js';
import { locationSettings, locationState, expiredPoints } from './location-policy.js';
import { ensureConsent } from './location-ui.js';
import { moduleOn } from './modules.js';

export const CHECK_EVERY_MS = 3 * 60_000;

let ctx = null;
let timer = null;
let bar = null;
let geofenceShift = null;
let busy = false;
const dismissed = new Set();
const listeners = new Set();

const me = () => ctx?.auth.current().id || null;
const sites = () => sitesOf(ctx.store.list('jobs'), locationSettings(ctx.store.settings()).defaultRadiusM);
const job = (id) => (id ? ctx.store.get('jobs', id) : null);
const jobLabel = (id) => { const j = job(id); return j ? `${j.number} · ${j.title}` : 'no job'; };
// Off when the company switched the time clock off (Settings > Modules), whatever the consent.
const granted = () => moduleOn(ctx.store.settings(), 'time') && locationState(ctx.store.list('locationConsents'), me(), ctx.store.settings()) === 'granted';
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** A fix for the open shift, or null (consent, permission and the open shift are all checked). */
async function shiftFix(entry) {
  if (!entry || !granted()) return { fix: null, reason: 'declined' };
  // A fresh fix every time: a cached one from minutes ago would hide a departure or an arrival.
  const r = await getFix({ maximumAgeMs: 0 });
  const still = ctx.store.get('timeEntries', entry.id);
  if (!still || still.clockOut) return { fix: null, reason: 'closed' }; // clocked out meanwhile: drop it
  return r.ok ? { fix: r.fix } : { fix: null, reason: r.reason };
}

// ---- flows -------------------------------------------------------------------------------

/** Clock in, then (with consent) take one fix, suggest the job and flag an off-site clock-in. */
export async function clockInFlow(c, { jobId = null, kind = 'work', note = '' } = {}) {
  ctx = ctx || c;
  const { store, ui } = c;
  const emp = c.auth.current().id;
  if (!emp || openEntry(store, emp)) return null;
  const state = locationSettings(store.settings()).enabled ? await ensureConsent(c, emp) : 'off';
  let entry = clockIn(store, { employeeId: emp, jobId, kind, note, locStatus: state === 'granted' ? 'pending' : state === 'later' ? 'declined' : state });
  if (!entry) return null;
  ui.toast(kind === 'travel' ? `Clocked in · travelling${jobId ? ` to ${job(jobId)?.number || 'the job'}` : ''}` : 'Clocked in', 'success');
  refresh();
  if (state !== 'granted') return entry;
  const { fix, reason } = await shiftFix(entry);
  if (!fix) { if (reason !== 'closed') { store.update('timeEntries', entry.id, { locStatus: reason }, { silent: true }); ui.toast(fixProblem(reason), 'info', 4000); } return store.get('timeEntries', entry.id); }
  const s = sites();
  if (kind !== 'travel') {
    const sug = suggestJob(fix, s);
    if (!entry.jobId && sug?.inside) {
      entry = store.update('timeEntries', entry.id, { jobId: sug.jobId }, { silent: true });
      ui.toast(`You're at ${jobLabel(sug.jobId)}: clocked in to it`, 'success', 3500);
    } else if (entry.jobId && sug?.inside && sug.jobId !== entry.jobId) {
      offer({ key: `switch:${entry.id}:${sug.jobId}`, text: `You're at ${jobLabel(sug.jobId)}, not ${job(entry.jobId)?.number || 'the job you picked'}.`, primary: 'Switch to this job',
        run: () => { const cur = ctx.store.get('timeEntries', entry.id); ctx.store.update('timeEntries', cur.id, { jobId: sug.jobId }); attachFix(ctx.store, cur.id, fix, 'in', sites(), { source: 'arrive' }); } });
    }
  }
  entry = attachFix(store, entry.id, fix, 'in', kind === 'travel' ? [] : s);
  if (entry.flag) ui.toast(`Clocked in ${entry.flag.text}. Your foreman will see this on your timesheet.`, 'error', 5000);
  refresh();
  return entry;
}

/** Take the clock-out fix while the shift is still open, then close it. */
export async function clockOutFlow(c, { note } = {}) {
  ctx = ctx || c;
  const { store, ui } = c;
  const open = openEntry(store, c.auth.current().id);
  if (!open) return null;
  const { fix } = await shiftFix(open);
  if (fix) attachFix(store, open.id, fix, 'out', open.kind === 'travel' ? [] : sites());
  const done = closeEntry(store, open.id, { note });
  hideBar();
  refresh();
  return done;
}

/** Start travel now (or at `at`, when a suggestion saw them leave). */
export async function startTravelFlow(c, { toJobId = null, at, fix: given } = {}) {
  ctx = ctx || c;
  const open = openEntry(c.store, c.auth.current().id);
  if (!open) return null;
  const next = switchTo(c.store, open, { kind: 'travel', jobId: toJobId, at });
  hideBar();
  c.ui.toast(`Travelling${toJobId ? ` to ${job(toJobId)?.number}` : ''}. Tap Arrived when you get there.`, 'success', 3500);
  const fix = given || (await shiftFix(next)).fix;
  if (fix && next) attachFix(c.store, next.id, fix, 'in', [], { source: 'travel' });
  refresh();
  return next;
}

/** Arrived at a job: travel ends (and is billed to this job), work starts. */
export async function arriveFlow(c, { jobId, at, fix: given } = {}) {
  ctx = ctx || c;
  const open = openEntry(c.store, c.auth.current().id);
  if (!open) return null;
  const next = switchTo(c.store, open, { kind: 'work', jobId, at });
  hideBar();
  c.ui.toast(`Working at ${jobLabel(jobId)}`, 'success');
  const fix = given || (await shiftFix(next)).fix;
  if (fix && next) {
    const e = attachFix(c.store, next.id, fix, 'in', sites(), { source: 'arrive' });
    if (e?.flag) c.ui.toast(`Started work ${e.flag.text}. Your foreman will see this.`, 'error', 5000);
  }
  refresh();
  return next;
}

/** One fix now, for the Arrived sheet's job suggestion (open shift only). */
export async function suggestArrival(c) {
  ctx = ctx || c;
  const open = openEntry(c.store, c.auth.current().id);
  const { fix } = await shiftFix(open);
  return fix ? { fix, suggestion: suggestJob(fix, sites()) } : { fix: null, suggestion: null };
}

// ---- background checks --------------------------------------------------------------------

/** Take a fix now and look for a departure or an arrival (browser, foreground). */
export async function checkNow() {
  if (!ctx || busy) return null;
  const open = openEntry(ctx.store, me());
  if (!open || !granted() || !visible()) return null;
  busy = true;
  try {
    const { fix } = await shiftFix(open);
    if (!fix) return null;
    const cur = ctx.store.get('timeEntries', open.id);
    recordPoint(ctx.store, { entry: cur, fix, source: 'check' });
    const sug = travelSuggestion(cur, fix, sites());
    if (sug) suggest(cur, sug, fix);
    return sug;
  } finally { busy = false; }
}

function suggest(open, sug, fix) {
  if (sug.type === 'left') {
    offer({ key: `left:${open.id}`, text: `You left ${job(sug.jobId)?.number || 'the job site'} (${fmtDistance(sug.distanceM)} away) at ${ctx.ui.fmtTime(sug.at)}. Travelling?`,
      primary: 'Start travel', icon: 'truck', run: () => startTravelFlow(ctx, { at: sug.at, fix }) });
  } else if (sug.type === 'arrived') {
    offer({ key: `arr:${open.id}:${sug.jobId}`, text: `You're at ${jobLabel(sug.jobId)}. Start work here?`,
      primary: 'Start work here', icon: 'play', run: () => arriveFlow(ctx, { jobId: sug.jobId, at: sug.at, fix }) });
  }
}

/** iOS: turn what the geofence saw while the app was closed into one suggestion. */
async function catchUp() {
  if (!ctx || !isNative()) return;
  const open = openEntry(ctx.store, me());
  const events = await drainGeofenceEvents();
  if (!open || !events.length) return;
  for (const e of events) {
    if (Number.isFinite(e.lat) && Number.isFinite(e.lng) && e.at >= open.clockIn) {
      recordPoint(ctx.store, { entry: ctx.store.get('timeEntries', open.id), fix: { at: e.at, lat: e.lat, lng: e.lng, accuracyM: e.accuracyM ?? null, source: 'native' }, source: e.type === 'enter' || e.type === 'exit' ? e.type : 'significant', siteId: e.siteId || null });
    }
  }
  const segs = buildTravelSegments(events, sites(), {
    start: { at: open.clockIn, kind: open.kind === 'travel' ? 'travel' : 'work', jobId: open.jobId, fromJobId: open.travelFromJobId || null }, end: new Date().toISOString(),
  });
  if (segs.length < 2) return;
  const words = segs.map((s) => (s.kind === 'travel' ? `travel ${Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60000)} min` : `${job(s.jobId)?.number || 'work'} from ${ctx.ui.fmtTime(s.start)}`));
  offer({ key: `bg:${open.id}:${segs.length}:${segs.at(-1).start}`, text: `While the app was closed: ${words.join(', then ')}.`, primary: 'Update my time', icon: 'check',
    run: () => { applySegments(ctx.store, ctx.store.get('timeEntries', open.id), segs); ctx.ui.toast('Time updated from your arrivals and departures', 'success'); refresh(); } });
}

// ---- suggestion bar ------------------------------------------------------------------------

function offer(s) {
  if (dismissed.has(s.key)) return;
  const { h } = ctx.ui;
  hideBar();
  bar = h('div', { class: 'loc-suggest no-print', role: 'status', 'aria-live': 'polite', dataset: { key: s.key } },
    ctx.ui.icon('map-pin', 18), h('span', { class: 'grow' }, s.text),
    h('div', { class: 'row loc-suggest-actions' },
      ctx.ui.button('Not now', { variant: 'ghost', size: 'sm', onClick: () => { dismissed.add(s.key); hideBar(); } }),
      ctx.ui.button(s.primary, { variant: 'primary', size: 'sm', icon: s.icon, onClick: async () => { dismissed.add(s.key); hideBar(); await s.run(); } })));
  document.body.append(bar);
  for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } }
}
function hideBar() { bar?.remove(); bar = null; }

// ---- lifecycle -----------------------------------------------------------------------------

/** Start or stop watching to match the clock: on only while this person has an open shift. */
export function refresh() {
  if (!ctx) return;
  const open = openEntry(ctx.store, me());
  const on = !!open && granted();
  if (!on) {
    if (timer) { clearInterval(timer); timer = null; }
    if (geofenceShift) { geofenceShift = null; stopGeofence(); }
    if (!open) hideBar();
    return;
  }
  if (isNative()) {
    if (geofenceShift !== open.id) {
      geofenceShift = open.id;
      const last = ctx.store.list('locationPoints', (p) => p.timeEntryId === open.id).sort((a, b) => b.at.localeCompare(a.at))[0];
      startGeofence(open.id, pickRegions(sites(), last));
    }
  } else if (!timer) {
    timer = setInterval(() => { checkNow().catch(() => {}); }, CHECK_EVERY_MS);
  }
}

/** Drop this device's copies of points past the company's retention (not synced: the server does its own). */
function pruneLocal() {
  const old = expiredPoints(ctx.store.list('locationPoints'), ctx.store.settings());
  for (const p of old) ctx.store.applyRemote('locationPoints', p.id, null, ctx.store.version('locationPoints', p.id));
}

/** Called once by the app shell. */
export function startShiftTracker(c) {
  ctx = c;
  c.store.on('timeEntries', () => refresh());
  c.store.on('locationConsents', () => refresh());
  c.store.on('settings', () => refresh());
  document.addEventListener('visibilitychange', () => {
    if (!visible()) return;
    catchUp().catch(() => {});
    checkNow().catch(() => {});
  });
  try { pruneLocal(); } catch (e) { console.error(e); }
  refresh();
  catchUp().catch(() => {});
  return api;
}

export const api = {
  checkNow, refresh, clockInFlow, clockOutFlow, startTravelFlow, arriveFlow, suggestArrival,
  onSuggestion(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  get watching() { return !!timer || !!geofenceShift; },
};
