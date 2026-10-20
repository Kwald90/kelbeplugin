// Address -> coordinates for job sites, with Natural Resources Canada's Geolocator
// (https://geolocator.api.geo.ca, the replacement for the geogratis geolocation service, which shuts
// down 2027-03-31). Free, no key, CORS open, Canadian street addresses ("locate" source). Checked
// 2026-10-19: the service says it is free for typical public, government and research use and asks
// high-volume users to write to geo@nrcan-rncan.gc.ca; commercial SaaS use is not spelled out.
// VERIFY with NRCan before launch (docs/field/timesheets.md). A manager can always drop a pin on the
// map instead, and one lookup per job is all the app ever does (no autocomplete).
//
// Privacy: the job's address (not a person's location) is sent to a Government of Canada service.
export const GEOCODER = 'https://geolocator.api.geo.ca/';

/**
 * Parse the Geolocator's answer: a flat array of
 * { key, name, province, category, lat, lng, bbox, tag }.
 * @returns {{ lat: number, lng: number, label: string, kind: string, approximate: boolean }[]}
 */
export function parseGeolocator(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((r) => r && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)))
    .map((r) => ({
      lat: Math.round(Number(r.lat) * 1e6) / 1e6, lng: Math.round(Number(r.lng) * 1e6) / 1e6,
      label: String(r.name || '').slice(0, 300), kind: String(r.category || r.key || ''),
      approximate: (r.tag || []).includes?.('INTERPOLATED_POSITION') || !/street|address/i.test(String(r.category || '')),
    }))
    .slice(0, 5);
}

/** The lookup URL for an address (French when lang is 'fr'). */
export const geocodeUrl = (address, lang = 'en') => `${GEOCODER}?q=${encodeURIComponent(String(address).slice(0, 200))}&lang=${lang === 'fr' ? 'fr' : 'en'}&keys=locate`;

/**
 * Look up an address. Resolves candidates (best first) or throws a plain-English error.
 * @param {string} address
 * @param {{ fetch?: typeof fetch, province?: string }} [o]
 */
export async function geocodeAddress(address, { fetch: f = globalThis.fetch, province } = {}) {
  const q = String(address || '').trim();
  if (q.length < 4) throw new Error('Type the street address first.');
  const withProv = province && !new RegExp(`\\b${province}\\b`, 'i').test(q) ? `${q}, ${province}` : q;
  let res;
  try {
    res = await f(geocodeUrl(withProv), { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new Error("Couldn't reach the address lookup. Drop a pin on the map instead.");
  }
  if (!res.ok) throw new Error(`The address lookup didn't answer (${res.status}). Drop a pin on the map instead.`);
  const out = parseGeolocator(await res.json());
  if (!out.length) throw new Error('No match for that address. Check it, or drop a pin on the map.');
  return out;
}
