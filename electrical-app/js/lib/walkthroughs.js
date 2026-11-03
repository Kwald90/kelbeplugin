// Site walkthroughs: a guided, room-by-room photo record of a job site (the "CompanyCam
// walkthrough"). Pure logic, shared by the module (modules/walkthroughs.js) and its tests;
// the capture UI reuses lib/safety-capture.js for the camera and photo downscaling.
//
// A walkthrough belongs to a job and carries the job's clientId (denormalised) so that when a
// walkthrough is shared it can reach the client portal — the server RLS gates on client_id +
// the sharedWithClient flag (collections.js portal: 'clientShared'). Internal by default.
//
// Shape: an ordered list of stops (checkpoints / areas). Each stop holds photos (downscaled
// JPEG data URLs for now; object storage later), a note and a doneAt stamp.

export const STATUSES = ['active', 'complete'];

/** Caps that keep a record under the collection's maxBytes (collections.js, 64 MB). */
export const MAX_STOPS = 20;
export const MAX_PHOTOS_PER_STOP = 6;

/**
 * Built-in checkpoint templates offered when starting a walkthrough. A company can save its
 * own in settings.walkthroughTemplates (owners/admins), which come first in the picker.
 */
export const BUILTIN_TEMPLATES = [
  { id: 'builtin:service', name: 'Service call', stops: ['Arrival / front of property', 'Panel', 'Problem area', 'Work done', 'Clean-up and sign-off'] },
  { id: 'builtin:rough-in', name: 'Residential rough-in', stops: ['Service and panel', 'Kitchen', 'Living areas', 'Bedrooms', 'Bathrooms', 'Basement / mechanical', 'Exterior'] },
  { id: 'builtin:panel', name: 'Panel change', stops: ['Existing panel', 'Meter and service', 'New panel', 'Grounding and bonding', 'Labelled directory', 'Final'] },
  { id: 'builtin:final', name: 'Final / pre-inspection', stops: ['Panel and directory', 'Devices', 'Fixtures', 'GFCI / AFCI test', 'Deficiencies', 'Overall'] },
  { id: 'builtin:blank', name: 'Blank (add your own stops)', stops: [] },
];

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** A fresh stop from a name. */
export function newStop(name = '') {
  return { id: newId('st'), name: String(name || '').slice(0, 200), note: '', photos: [], doneAt: null };
}

/** The company's own templates (settings.walkthroughTemplates) first, then the built-ins. */
export function templatesFrom(settings) {
  const custom = Array.isArray(settings?.walkthroughTemplates) ? settings.walkthroughTemplates : [];
  return [...custom.filter((t) => t && t.id && t.name), ...BUILTIN_TEMPLATES];
}

/** A template by id across custom + built-in, or null. */
export function templateById(settings, id) {
  if (!id) return null;
  return templatesFrom(settings).find((t) => t.id === id) || null;
}

/**
 * A new walkthrough record for a job, with stops from a template (or blank).
 * @param {{ job?: object|null, template?: object|null, title?: string, by?: string|null, date?: string|null }} opts
 */
export function newWalkthrough({ job = null, template = null, title = '', by = null, date = null } = {}) {
  const stops = (Array.isArray(template?.stops) ? template.stops : []).slice(0, MAX_STOPS).map(newStop);
  return {
    id: newId('wt'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    title: String(title || template?.name || 'Site walkthrough').slice(0, 200),
    templateId: template?.id || null,
    status: 'active',
    date: date || null,
    stops,
    sharedWithClient: false,
    sharedAt: null,
    sharedBy: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    createdBy: by || null,
  };
}

/** { done, total, photos, pct }. A stop counts as done once it is marked or has a photo. */
export function progress(w) {
  const stops = Array.isArray(w?.stops) ? w.stops : [];
  const total = stops.length;
  let done = 0;
  let photos = 0;
  for (const s of stops) {
    const n = Array.isArray(s?.photos) ? s.photos.length : 0;
    photos += n;
    if (s?.doneAt || n > 0) done++;
  }
  return { done, total, photos, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** Total photos across every stop. */
export const photoCount = (w) => progress(w).photos;

/** A walkthrough can be shared with the client once it is tied to a client and has a photo. */
export function canShare(w) {
  return Boolean(w?.clientId) && photoCount(w) > 0;
}

/** Is every stop done (and there is at least one)? Drives the "complete" prompt. */
export function allStopsDone(w) {
  const { done, total } = progress(w);
  return total > 0 && done === total;
}

/** A short label for lists and the report header. */
export function walkthroughLabel(w) {
  return `${w?.title || 'Walkthrough'}${w?.date ? ` · ${w.date}` : ''}`;
}
