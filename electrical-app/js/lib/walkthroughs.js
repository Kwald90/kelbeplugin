// Site walkthroughs: a free-form video+photo record of a job site (the "CompanyCam walkthrough").
// Pure logic, shared by the module (modules/walkthroughs.js) and its tests; the capture UI reuses
// lib/safety-capture.js for stills and lib/walkthrough-recorder.js for the video + transcript.
//
// A walkthrough belongs to a job and carries the job's clientId (denormalised) so that when it is
// shared it can reach the client portal — the server RLS gates on client_id + the sharedWithClient
// flag (collections.js portal: 'clientShared'). Internal by default.
//
// The shape is deliberately NOT a fixed room-by-room checklist: every job and site is different.
// You walk the site talking, it records video + audio, stills are grabbed during the walk, and
// afterwards you divide the stills into groups you name on the spot ("panel room", "attic", …) —
// or leave them as one reel. The audio is transcribed (on-device speech or Gemini); the transcript
// and the stills sync, while the full video stays on the device until a blob store is added.

export const STATUSES = ['active', 'complete'];

/** Caps that keep a synced record under the collection's maxBytes (collections.js, 64 MB). */
export const MAX_CAPTURES = 240;   // stills, each a downscaled JPEG data URL
export const MAX_GROUPS = 40;

/** Where a transcript came from (for the report footer + to know if it can be re-run). */
export const TRANSCRIPT_SOURCES = ['ios-speech', 'gemini', 'manual'];

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
const clampStr = (s, n) => String(s ?? '').slice(0, n);

/**
 * A new, empty walkthrough for a job. No stops, no template — captures and groups are added as the
 * walk happens and are organised afterwards.
 * @param {{ job?: object|null, title?: string, by?: string|null, date?: string|null }} opts
 */
export function newWalkthrough({ job = null, title = '', by = null, date = null } = {}) {
  return {
    id: newId('wt'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    title: clampStr(title || 'Site walkthrough', 200),
    status: 'active',
    date: date || null,
    recording: null,        // device-local video ref: { localId, durationMs, mimeType, startedAt }
    transcript: '',         // the audio, transcribed
    transcriptSource: null, // one of TRANSCRIPT_SOURCES
    captures: [],           // free-form stills, in capture order
    groups: [],             // user-named groups, created on the fly
    sharedWithClient: false,
    sharedAt: null,
    sharedBy: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    createdBy: by || null,
  };
}

/**
 * A still grabbed during the walk.
 * @param {{ photo: string, atMs?: number|null, label?: string, groupId?: string|null }} opts
 *   photo: a downscaled JPEG data URL (from safety-capture).
 *   atMs:  offset into the recording when it was taken, if there is a recording (else null).
 */
export function newCapture({ photo, atMs = null, label = '', groupId = null } = {}) {
  return {
    id: newId('cap'),
    kind: 'photo',
    photo: String(photo || ''),
    at: new Date().toISOString(),
    atMs: Number.isFinite(atMs) ? Math.max(0, Math.round(atMs)) : null,
    label: clampStr(label, 140),
    groupId: groupId || null,
  };
}

/** A fresh group (section) from a name. */
export function newGroup(name = '') {
  return { id: newId('grp'), name: clampStr(name, 120) };
}

// --- helpers that return new arrays/records (pure; the module saves the result) ---------------

const caps = (w) => (Array.isArray(w?.captures) ? w.captures : []);
const grps = (w) => (Array.isArray(w?.groups) ? w.groups : []);

/** Add a still. Returns the new captures array (capped at MAX_CAPTURES). */
export function withCapture(w, capture) {
  return [...caps(w), capture].slice(-MAX_CAPTURES);
}

/** Remove a still by id. */
export function withoutCapture(w, captureId) {
  return caps(w).filter((c) => c.id !== captureId);
}

/** Move a still into a group (or out of all groups when groupId is null). Returns new captures. */
export function assignCapture(w, captureId, groupId = null) {
  const valid = groupId == null || grps(w).some((g) => g.id === groupId);
  return caps(w).map((c) => (c.id === captureId ? { ...c, groupId: valid ? groupId : null } : c));
}

/** Set a still's label. Returns new captures. */
export function relabelCapture(w, captureId, label) {
  return caps(w).map((c) => (c.id === captureId ? { ...c, label: clampStr(label, 140) } : c));
}

/** Add a named group. Returns the new groups array, or the existing one if the name is empty/at cap. */
export function withGroup(w, name) {
  const n = clampStr(name, 120).trim();
  if (!n || grps(w).length >= MAX_GROUPS) return grps(w);
  return [...grps(w), newGroup(n)];
}

/** Rename a group. Returns new groups. */
export function renameGroup(w, groupId, name) {
  return grps(w).map((g) => (g.id === groupId ? { ...g, name: clampStr(name, 120) } : g));
}

/**
 * Remove a group and return { groups, captures } with its members moved back to ungrouped, so a
 * delete never orphans a still.
 */
export function withoutGroup(w, groupId) {
  return {
    groups: grps(w).filter((g) => g.id !== groupId),
    captures: caps(w).map((c) => (c.groupId === groupId ? { ...c, groupId: null } : c)),
  };
}

/**
 * The captures organised for display: one entry per group in order, then an "Ungrouped" entry last
 * (only when something is ungrouped). Always returns the ungrouped bucket with group=null.
 * @returns {{ group: object|null, captures: object[] }[]}
 */
export function groupsWithCaptures(w) {
  const list = caps(w);
  const out = grps(w).map((g) => ({ group: g, captures: list.filter((c) => c.groupId === g.id) }));
  const ungrouped = list.filter((c) => !c.groupId || !grps(w).some((g) => g.id === c.groupId));
  if (ungrouped.length || !out.length) out.push({ group: null, captures: ungrouped });
  return out;
}

/** Attach / replace the device-local video recording reference. Returns a patch. */
export function setRecording({ localId, durationMs = 0, mimeType = 'video/mp4', startedAt = null } = {}) {
  if (!localId) return { recording: null };
  return { recording: { localId, durationMs: Math.max(0, Math.round(durationMs)), mimeType, startedAt: startedAt || new Date().toISOString() } };
}

/** Set the transcript and where it came from. Returns a patch. */
export function setTranscript(text, source = 'manual') {
  return { transcript: clampStr(text, 60000), transcriptSource: TRANSCRIPT_SOURCES.includes(source) ? source : 'manual' };
}

export const hasVideo = (w) => Boolean(w?.recording?.localId);
export const hasTranscript = (w) => Boolean(String(w?.transcript || '').trim());
export const captureCount = (w) => caps(w).length;

/** { captures, groups, grouped, ungrouped, hasVideo, hasTranscript }. */
export function progress(w) {
  const list = caps(w);
  const grouped = list.filter((c) => c.groupId && grps(w).some((g) => g.id === c.groupId)).length;
  return {
    captures: list.length,
    groups: grps(w).length,
    grouped,
    ungrouped: list.length - grouped,
    hasVideo: hasVideo(w),
    hasTranscript: hasTranscript(w),
  };
}

/** Sharable with the client once it is tied to a client and has something to show. */
export function canShare(w) {
  return Boolean(w?.clientId) && (captureCount(w) > 0 || hasVideo(w) || hasTranscript(w));
}

/** A short label for lists and the report header. */
export function walkthroughLabel(w) {
  return `${w?.title || 'Walkthrough'}${w?.date ? ` · ${w.date}` : ''}`;
}

/**
 * Back-compat: a walkthrough saved under the old room-by-room model has `stops` with photos. Flatten
 * them into capture-like objects (with the stop name as the group) so old records still display.
 * Returns null when there is nothing to migrate.
 */
export function legacyCaptures(w) {
  const stops = Array.isArray(w?.stops) ? w.stops : [];
  if (!stops.length) return null;
  const groups = [];
  const captures = [];
  for (const s of stops) {
    const photos = Array.isArray(s?.photos) ? s.photos : [];
    if (!photos.length) continue;
    const g = newGroup(s?.name || 'Area');
    groups.push(g);
    for (const p of photos) captures.push({ ...newCapture({ photo: typeof p === 'string' ? p : p?.photo || '', label: s?.note || '' }), groupId: g.id });
  }
  return captures.length ? { groups, captures } : null;
}
