// Location fixes for the time clock, in the browser and in the iOS app. Every call here is made
// for a shift that is already open: the time clock and the shift tracker check that first
// (docs/compliance/privacy.md: location only while clocked in).
//
//   browser   navigator.geolocation, foreground only (a web page gets nothing in the background)
//   iOS app   Capacitor's Geolocation plugin for one fix, plus our FishtapeGeofence plugin, which
//             watches the job sites (region monitoring + significant location changes) while a
//             shift is open, so arrivals and departures are noticed with the app closed
//
// FishtapeGeofence contract (mobile/ios/App/App/Plugins/FishtapeGeofencePlugin.swift):
//   start({ shiftId, regions: [{ id, lat, lng, radiusM }] }) -> { tracking, authorization }
//   stop() -> {}                                    always safe to call
//   events() -> { events: [{ at, type: 'enter'|'exit'|'significant', siteId?, lat?, lng?, accuracyM? }] }
//                                                   drains what was recorded since the last call
//   status() -> { tracking, shiftId?, authorization }
//   authorization: 'always' | 'whenInUse' | 'denied' | 'notDetermined' | 'restricted'

const cap = () => globalThis.Capacitor || null;
export const isNative = () => { try { return !!cap()?.isNativePlatform?.(); } catch { return false; } };
const plugin = (name) => cap()?.Plugins?.[name] || null;

/** iOS allows 20 monitored regions per app; keep a few spare. */
export const MAX_REGIONS = 18;

export function geoSupported() {
  if (isNative()) return !!plugin('Geolocation');
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
/** A fix as stored: 6 decimals (~0.1 m) is more precision than any phone has. */
export function toFix(coords, timestamp, source) {
  return {
    at: new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString(),
    lat: round(Number(coords.latitude), 6), lng: round(Number(coords.longitude), 6),
    accuracyM: Number.isFinite(coords.accuracy) ? Math.round(coords.accuracy) : null,
    source,
  };
}

const reason = (e) => {
  const code = e?.code;
  const msg = String(e?.message || e || '');
  if (code === 1 || /denied|permission|not authori[sz]ed/i.test(msg)) return 'denied';
  if (code === 3 || /time(d)? ?out/i.test(msg)) return 'timeout';
  return 'unavailable';
};

/**
 * One location fix. Resolves { ok: true, fix } or { ok: false, reason: 'denied'|'timeout'|'unavailable'|'unsupported' }.
 * Never rejects: a clock-in never fails because location did.
 */
export async function getFix({ timeoutMs = 15000, maximumAgeMs = 20000 } = {}) {
  if (!geoSupported()) return { ok: false, reason: 'unsupported' };
  const opts = { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs };
  try {
    if (isNative()) {
      const g = plugin('Geolocation');
      try {
        const p = await g.checkPermissions();
        if (p?.location === 'denied') return { ok: false, reason: 'denied' };
        if (p?.location !== 'granted') {
          const r = await g.requestPermissions({ permissions: ['location'] });
          if (r?.location === 'denied') return { ok: false, reason: 'denied' };
        }
      } catch { /* older plugin: getCurrentPosition asks itself */ }
      const pos = await g.getCurrentPosition(opts);
      return { ok: true, fix: toFix(pos.coords, pos.timestamp, 'native') };
    }
    const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, opts));
    return { ok: true, fix: toFix(pos.coords, pos.timestamp, 'browser') };
  } catch (e) {
    return { ok: false, reason: reason(e) };
  }
}

/** Plain words for a failed fix. */
export const fixProblem = (r) => ({
  denied: 'Location is blocked for Fishtape. Your time is saved without it; allow location in your browser or device settings to add it.',
  timeout: "Couldn't get a location fix in time. Your time is saved without it.",
  unavailable: "Location isn't available right now. Your time is saved without it.",
  unsupported: "This device can't share its location. Your time is saved without it.",
}[r] || 'No location this time.');

// ---- iOS background (region monitoring) ---------------------------------------------

export const nativeGeofence = () => (isNative() ? plugin('FishtapeGeofence') : null);

/** Start watching these sites for an open shift (iOS app only). Resolves the plugin's answer or null. */
export async function startGeofence(shiftId, sites) {
  const g = nativeGeofence();
  if (!g || !shiftId) return null;
  const regions = (sites || []).slice(0, MAX_REGIONS).map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, radiusM: s.radiusM }));
  try { return await g.start({ shiftId, regions }); } catch (e) { console.warn('geofence start', e?.message || e); return null; }
}

export async function stopGeofence() {
  const g = nativeGeofence();
  if (!g) return;
  try { await g.stop(); } catch { /* not running */ }
}

/** Events the iOS app recorded while in the background, oldest first (drained). */
export async function drainGeofenceEvents() {
  const g = nativeGeofence();
  if (!g) return [];
  try {
    const r = await g.events();
    return (r?.events || []).filter((e) => e && e.at).sort((a, b) => a.at.localeCompare(b.at));
  } catch { return []; }
}

/** Sites nearest a point first, so the closest ones get the limited iOS regions. */
export function pickRegions(sites, near) {
  if (!near) return (sites || []).slice(0, MAX_REGIONS);
  const d = (s) => (s.lat - near.lat) ** 2 + ((s.lng - near.lng) * Math.cos((near.lat * Math.PI) / 180)) ** 2;
  return [...(sites || [])].sort((a, b) => d(a) - d(b)).slice(0, MAX_REGIONS);
}
