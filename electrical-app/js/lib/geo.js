// Job sites and location fixes: distances, "which site am I at", off-site flags and travel
// segments built from a sequence of fixes or geofence events. Pure (no DOM, no network), shared
// by the time clock, the job screen, the shift tracker and the tests.
//
// A fix:  { at: ISO, lat, lng, accuracyM }           (accuracy = 68 % radius, metres)
// A site: { id (the job id), lat, lng, radiusM }     (from job.site, see siteOf)
// An event from the iOS geofence plugin: { at, type: 'enter' | 'exit', siteId, lat?, lng?, accuracyM? }

/** Default site radius in metres when a job has none (settings.location.defaultRadiusM wins). */
export const DEFAULT_RADIUS_M = 150;
export const MIN_RADIUS_M = 30;
export const MAX_RADIUS_M = 2000;
/** Fixes worse than this are ignored for site decisions (cell-tower guesses). */
export const MAX_USEFUL_ACCURACY_M = 500;
/** An accuracy this poor makes an "outside the site" result uncertain: shown, not flagged. */
export const UNCERTAIN_ACCURACY_M = 250;
/** How far beyond its radius someone must be before they count as having left a site. */
export const exitMarginM = (radiusM) => Math.max(25, 0.2 * radiusM);
/** Travel shorter than this that ends back where it started is noise, not travel. */
export const MIN_TRAVEL_MIN = 3;
/** The nearest site is still suggested (not "inside") within this distance. */
export const NEAR_M = 1000;

const R = 6371008.8; // mean Earth radius, metres (IUGG)
const rad = (d) => (d * Math.PI) / 180;

export const validLatLng = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/** Great-circle distance in metres (haversine). */
export function distanceM(a, b) {
  if (!validLatLng(a) || !validLatLng(b)) return NaN;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const clampRadius = (r, fallback = DEFAULT_RADIUS_M) => {
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(n))) : fallback;
};

/** A job's site as { id, lat, lng, radiusM }, or null when the job has no location yet. */
export function siteOf(job, defaultRadiusM = DEFAULT_RADIUS_M) {
  const s = job?.site;
  if (!job?.id || !validLatLng(s)) return null;
  return { id: job.id, lat: s.lat, lng: s.lng, radiusM: clampRadius(s.radiusM, clampRadius(defaultRadiusM)) };
}

/** Every job with a site, as sites. */
export const sitesOf = (jobs, defaultRadiusM) => (jobs || []).map((j) => siteOf(j, defaultRadiusM)).filter(Boolean);

const slack = (fix, radiusM) => Math.min(Number(fix?.accuracyM) || 0, radiusM, 100);

/** Is the fix inside the site? Accuracy widens the circle a little (never more than the radius or 100 m). */
export function insideSite(fix, site) {
  const d = distanceM(fix, site);
  return Number.isFinite(d) && d <= site.radiusM + slack(fix, site.radiusM);
}

/** Clearly outside: beyond the radius, the exit margin and the fix's own uncertainty. */
export function leftSite(fix, site) {
  const d = distanceM(fix, site);
  return Number.isFinite(d) && d > site.radiusM + exitMarginM(site.radiusM) + slack(fix, site.radiusM);
}

const usable = (fix) => validLatLng(fix) && !(Number(fix.accuracyM) > MAX_USEFUL_ACCURACY_M);

/** Sites by distance from the fix: [{ site, distanceM, inside }], nearest first. */
export function nearestSites(fix, sites) {
  if (!validLatLng(fix)) return [];
  return (sites || []).map((site) => ({ site, distanceM: distanceM(fix, site), inside: insideSite(fix, site) }))
    .filter((x) => Number.isFinite(x.distanceM))
    .sort((a, b) => (b.inside - a.inside) || (a.distanceM - b.distanceM));
}

/** The site the fix is inside (the nearest if several overlap), or null. */
export function siteAt(fix, sites) {
  if (!usable(fix)) return null;
  const n = nearestSites(fix, sites)[0];
  return n?.inside ? n.site : null;
}

/**
 * The job to suggest for a clock-in fix: the site it is inside, else the nearest site within
 * NEAR_M. Returns { jobId, distanceM, inside } or null.
 */
export function suggestJob(fix, sites, { nearM = NEAR_M } = {}) {
  if (!usable(fix)) return null;
  const n = nearestSites(fix, sites)[0];
  if (!n || (!n.inside && n.distanceM > nearM)) return null;
  return { jobId: n.site.id, distanceM: Math.round(n.distanceM), inside: n.inside };
}

/** "350 m", "4.2 km", "18 km". */
export function fmtDistance(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return `${Math.max(0, Math.round(n / 10) * 10)} m`;
  return n < 10_000 ? `${(n / 1000).toFixed(1)} km` : `${Math.round(n / 1000)} km`;
}

/**
 * Check a clock-in or clock-out fix against the entry's job site and every other site.
 * Returns what goes on the time entry:
 *   { jobId, distanceM, inside, accuracyM, at, nearestJobId?, nearestM?, flag? }
 * `flag` ({ kind: 'off-site', distanceM, jobId, text }) is set when the fix is clearly outside the
 * job's site (or outside every site when the entry has no job site), and the fix is good enough
 * to judge. Null when there is no fix or no site to compare with.
 */
export function siteCheck(fix, jobId, sites) {
  if (!validLatLng(fix)) return null;
  const all = nearestSites(fix, sites);
  if (!all.length) return null;
  const own = jobId ? all.find((x) => x.site.id === jobId) : null;
  const nearest = all[0];
  const accuracyM = Number.isFinite(fix.accuracyM) ? Math.round(fix.accuracyM) : null;
  const uncertain = !(accuracyM != null && accuracyM <= UNCERTAIN_ACCURACY_M);
  const out = { jobId: own ? jobId : null, accuracyM, at: fix.at || null };
  if (own) {
    out.distanceM = Math.round(own.distanceM);
    out.inside = own.inside;
  } else {
    out.distanceM = Math.round(nearest.distanceM);
    out.inside = nearest.inside;
  }
  if (!nearest.inside || (own && !own.inside)) {
    if (nearest.site.id !== (own?.site.id ?? null)) { out.nearestJobId = nearest.site.id; out.nearestM = Math.round(nearest.distanceM); }
  }
  const outside = own ? !own.inside && leftSite(fix, own.site) : !all.some((x) => x.inside) && leftSite(fix, nearest.site);
  if (outside && !uncertain) {
    const d = own ? own.distanceM : nearest.distanceM;
    out.flag = { kind: 'off-site', jobId: own ? jobId : nearest.site.id, distanceM: Math.round(d),
      text: own ? `${fmtDistance(d)} from the job site` : `not at a job site (nearest ${fmtDistance(d)} away)` };
  }
  return out;
}

/**
 * While someone is on the clock: does this new fix mean they left their site, or arrived at one?
 * `open` is the open time entry ({ kind, jobId }). Returns
 *   { type: 'left', jobId, at, distanceM }   working, now clearly outside their site
 *   { type: 'arrived', jobId, at, fromJobId } travelling (or working elsewhere) and now inside a site
 * or null.
 */
export function travelSuggestion(open, fix, sites) {
  if (!open || !usable(fix)) return null;
  const here = siteAt(fix, sites);
  if (open.kind === 'travel') {
    if (!here) return null;
    return { type: 'arrived', jobId: here.id, at: fix.at, fromJobId: open.travelFromJobId || null };
  }
  const own = (sites || []).find((s) => s.id === open.jobId);
  if (own && insideSite(fix, own)) return null;
  if (here && here.id !== open.jobId) return { type: 'arrived', jobId: here.id, at: fix.at, fromJobId: open.jobId || null };
  if (own && leftSite(fix, own)) return { type: 'left', jobId: own.id, at: fix.at, distanceM: Math.round(distanceM(fix, own)) };
  return null;
}

const ms = (iso) => Date.parse(iso);

/**
 * Turn a shift's fixes and geofence events into work and travel segments.
 *
 * @param {object[]} events  fixes and/or { type: 'enter'|'exit', siteId, at } events, any order
 * @param {object[]} sites   { id, lat, lng, radiusM }
 * @param {{ start: { at: string, kind?: 'work'|'travel', jobId?: string|null, fromJobId?: string|null }, end: string, minTravelMin?: number }} o
 * @returns {{ kind: 'work'|'travel', jobId: string|null, fromJobId?: string|null, start: string, end: string }[]}
 *
 * Working at a site, the first fix clearly outside it (or an exit event) starts travel; travel
 * ends at the first fix inside a site (or an enter event), which becomes the travel's job (travel
 * is billed to the job travelled to) and starts work there. Travel shorter than minTravelMin that
 * comes back to the same site is folded back into work. Travel still running at `end` keeps a
 * null job: the person picks where they were going.
 */
export function buildTravelSegments(events, sites, { start, end, minTravelMin = MIN_TRAVEL_MIN } = {}) {
  if (!start?.at || !end || ms(end) <= ms(start.at)) return [];
  const byId = new Map((sites || []).map((s) => [s.id, s]));
  const list = (events || []).filter((e) => e && e.at && ms(e.at) > ms(start.at) && ms(e.at) < ms(end)).sort((a, b) => ms(a.at) - ms(b.at));
  const segs = [];
  let cur = { kind: start.kind === 'travel' ? 'travel' : 'work', jobId: start.jobId ?? null, fromJobId: start.fromJobId ?? null, start: start.at };
  let lastInsideAt = cur.kind === 'work' ? start.at : null;

  const close = (at) => { if (ms(at) > ms(cur.start)) segs.push({ ...cur, end: at }); };
  const beginTravel = (at, from) => { close(at); cur = { kind: 'travel', jobId: null, fromJobId: from, start: at }; };
  const arrive = (at, siteId) => { cur.jobId = siteId; close(at); cur = { kind: 'work', jobId: siteId, fromJobId: null, start: at }; lastInsideAt = at; };

  for (const e of list) {
    if (e.type === 'enter' || e.type === 'exit') {
      if (!byId.has(e.siteId)) continue;
      if (e.type === 'exit' && cur.kind === 'work' && cur.jobId === e.siteId) beginTravel(e.at, cur.jobId);
      else if (e.type === 'enter' && cur.kind === 'travel') arrive(e.at, e.siteId);
      else if (e.type === 'enter' && cur.kind === 'work' && cur.jobId !== e.siteId) { beginTravel(lastInsideAt && ms(lastInsideAt) > ms(cur.start) ? lastInsideAt : e.at, cur.jobId); arrive(e.at, e.siteId); }
      else if (e.type === 'enter' && cur.kind === 'work') lastInsideAt = e.at;
      continue;
    }
    if (!usable(e)) continue;
    const here = siteAt(e, sites);
    if (cur.kind === 'work') {
      const own = byId.get(cur.jobId);
      if (here && here.id === cur.jobId) { lastInsideAt = e.at; continue; }
      if (here && here.id !== cur.jobId) {
        // Fixes too sparse to see the trip: travel ran from the last fix seen at the old site.
        beginTravel(lastInsideAt && ms(lastInsideAt) > ms(cur.start) ? lastInsideAt : e.at, cur.jobId);
        arrive(e.at, here.id);
      } else if (own && leftSite(e, own)) {
        beginTravel(e.at, cur.jobId);
      }
    } else if (here) {
      arrive(e.at, here.id);
    }
  }
  close(end);

  // Fold short round trips (left and came straight back) into the work around them.
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'work' && s.kind === 'travel' && s.jobId && s.jobId === prev.jobId && (ms(s.end) - ms(s.start)) / 60000 < minTravelMin) {
      prev.end = s.end;
      continue;
    }
    if (prev && prev.kind === 'work' && s.kind === 'work' && prev.jobId === s.jobId) { prev.end = s.end; continue; }
    out.push({ ...s });
  }
  return out.map((s) => (s.kind === 'work' ? { kind: 'work', jobId: s.jobId, start: s.start, end: s.end } : { kind: 'travel', jobId: s.jobId, fromJobId: s.fromJobId ?? null, start: s.start, end: s.end }));
}

/**
 * Time entries for segments of one open shift: the open entry is closed at the first segment's
 * end (and takes that segment's kind and job), every later segment becomes a new entry, and the
 * last one stays open when `keepOpen`. Pure: returns { update, create[] } for the caller to save.
 */
export function entriesForSegments(open, segments, { keepOpen = true } = {}) {
  if (!open || !segments?.length) return { update: null, create: [] };
  const first = segments[0];
  const one = (s) => ({ kind: s.kind, jobId: s.jobId ?? null, ...(s.kind === 'travel' ? { travelFromJobId: s.fromJobId ?? null } : {}) });
  const last = segments.length - 1;
  const update = { ...one(first), clockOut: last === 0 && keepOpen ? null : first.end };
  const create = segments.slice(1).map((s, i) => ({
    ...one(s), employeeId: open.employeeId, clockIn: s.start, clockOut: i + 1 === last && keepOpen ? null : s.end,
    breakMins: 0, breakStart: null, approved: false, source: 'auto-split', note: '',
  }));
  return { update, create };
}

// ---- Web Mercator (the small map) -----------------------------------------------------

export const TILE = 256;
/** World pixel coordinates at zoom z. */
export function project(lat, lng, z) {
  const s = TILE * 2 ** z;
  const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin(rad(lat))));
  return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
}
export function unproject(x, y, z) {
  const s = TILE * 2 ** z;
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
}
/** Metres per screen pixel at a latitude and zoom. */
export const metresPerPixel = (lat, z) => (Math.cos(rad(lat)) * 2 * Math.PI * R) / (TILE * 2 ** z);
