// Run: node --test electrical-app/tests/*.test.mjs
// Location while clocked in: distances, nearest site, radius checks, off-site flags, travel
// segments from a sequence of fixes and geofence events, the consent policy, the address lookup
// parser, and the clock's store writes (location only ever stored for an open shift).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../js/lib/geo.js';
import * as P from '../js/lib/location-policy.js';
import { parseGeolocator, geocodeUrl, geocodeAddress } from '../js/lib/geocode.js';
import { toFix, pickRegions } from '../js/lib/location.js';
import { store } from '../js/store.js';
import * as C from '../js/lib/clock.js';

// Two sites in Winnipeg about 4.2 km apart (north-south), plus a supply house between them.
const A = { id: 'jobA', lat: 49.8951, lng: -97.1384, radiusM: 150 };
const B = { id: 'jobB', lat: 49.8951 + 4.2 / 111.2, lng: -97.1384, radiusM: 150 };
const SITES = [A, B];
const offset = (p, northM, eastM = 0) => ({ lat: p.lat + northM / 111_195, lng: p.lng + eastM / (111_195 * Math.cos((p.lat * Math.PI) / 180)) });
const fix = (p, at, accuracyM = 10) => ({ ...p, at, accuracyM });
const T = (hhmm) => `2026-10-19T${hhmm}:00.000Z`;

describe('distances and sites', () => {
  test('haversine matches known distances', () => {
    assert.ok(Math.abs(G.distanceM(A, B) - 4200) < 15, String(G.distanceM(A, B)));
    assert.ok(Math.abs(G.distanceM(A, offset(A, 0, 1000)) - 1000) < 2);
    // Winnipeg to Toronto, about 1,500 km
    assert.ok(Math.abs(G.distanceM({ lat: 49.8951, lng: -97.1384 }, { lat: 43.6532, lng: -79.3832 }) / 1000 - 1505) < 10);
    assert.ok(Number.isNaN(G.distanceM({ lat: 91, lng: 0 }, A)));
  });

  test('siteOf reads job.site with the default radius and clamps it', () => {
    assert.equal(G.siteOf({ id: 'j', site: null }), null);
    assert.deepEqual(G.siteOf({ id: 'j', site: { lat: 49.9, lng: -97.1 } }, 200), { id: 'j', lat: 49.9, lng: -97.1, radiusM: 200 });
    assert.equal(G.siteOf({ id: 'j', site: { lat: 49.9, lng: -97.1, radiusM: 5 } }).radiusM, G.MIN_RADIUS_M);
    assert.equal(G.siteOf({ id: 'j', site: { lat: 49.9, lng: -97.1, radiusM: 99_999 } }).radiusM, G.MAX_RADIUS_M);
    assert.equal(G.sitesOf([{ id: 'a', site: { lat: 1, lng: 2 } }, { id: 'b' }]).length, 1);
  });

  test('inside the radius, with a little room for a poor fix, but never more than the radius', () => {
    assert.ok(G.insideSite(fix(offset(A, 140), T('07:00'), 5), A));
    assert.ok(!G.insideSite(fix(offset(A, 200), T('07:00'), 5), A));
    assert.ok(G.insideSite(fix(offset(A, 200), T('07:00'), 60), A), '60 m accuracy reaches 210 m');
    assert.ok(!G.insideSite(fix(offset(A, 400), T('07:00'), 2000), A), 'slack is capped at the radius/100 m');
    assert.ok(!G.leftSite(fix(offset(A, 170), T('07:00')), A), 'just outside is not "left" (exit margin)');
    assert.ok(G.leftSite(fix(offset(A, 300), T('07:00')), A));
  });

  test('nearest site and the job to suggest', () => {
    const near = G.nearestSites(fix(offset(B, 50), T('07:00')), SITES);
    assert.equal(near[0].site.id, 'jobB');
    assert.equal(near[0].inside, true);
    assert.deepEqual(G.suggestJob(fix(offset(A, 30), T('07:00')), SITES), { jobId: 'jobA', distanceM: 30, inside: true });
    const s = G.suggestJob(fix(offset(A, 600), T('07:00')), SITES);
    assert.equal(s.jobId, 'jobA');
    assert.equal(s.inside, false);
    assert.equal(G.suggestJob(fix(offset(A, -5000), T('07:00')), SITES), null, 'nothing within 1 km');
    assert.equal(G.suggestJob(fix(offset(A, 10), T('07:00'), 900), SITES), null, 'a cell-tower guess suggests nothing');
    assert.equal(G.siteAt(fix(offset(B, 20), T('07:00')), SITES).id, 'jobB');
  });

  test('distances read like a person would say them', () => {
    assert.equal(G.fmtDistance(42), '40 m');
    assert.equal(G.fmtDistance(350), '350 m');
    assert.equal(G.fmtDistance(4210), '4.2 km');
    assert.equal(G.fmtDistance(18_400), '18 km');
  });
});

describe('off-site flags', () => {
  test('clocked in 4.2 km from the job site is flagged with the distance', () => {
    const c = G.siteCheck(fix(offset(B, 0), T('07:00'), 12), 'jobA', SITES);
    assert.equal(c.jobId, 'jobA');
    assert.equal(c.inside, false);
    assert.ok(Math.abs(c.distanceM - 4200) < 20);
    assert.equal(c.nearestJobId, 'jobB');
    assert.equal(c.flag.kind, 'off-site');
    assert.equal(c.flag.text, '4.2 km from the job site');
  });

  test('at the site: no flag; a poor fix outside: shown, not flagged', () => {
    const ok = G.siteCheck(fix(offset(A, 60), T('07:00')), 'jobA', SITES);
    assert.equal(ok.inside, true);
    assert.equal(ok.flag, undefined);
    const vague = G.siteCheck(fix(offset(A, 800), T('07:00'), 400), 'jobA', SITES);
    assert.equal(vague.inside, false);
    assert.equal(vague.flag, undefined, 'accuracy 400 m is too poor to accuse anyone');
  });

  test('no job (or a job without a site): flagged only when outside every site', () => {
    const shop = G.siteCheck(fix(offset(A, -3000), T('07:00')), null, SITES);
    assert.match(shop.flag.text, /^not at a job site \(nearest 3\.0 km away\)$/);
    assert.equal(G.siteCheck(fix(offset(B, 10), T('07:00')), null, SITES).flag, undefined);
    assert.equal(G.siteCheck(fix(A, T('07:00')), 'jobA', []), null, 'no sites: nothing to compare');
  });
});

describe('travel', () => {
  test('a suggestion when a worker leaves their site, and when they arrive at another', () => {
    const working = { kind: 'work', jobId: 'jobA' };
    assert.equal(G.travelSuggestion(working, fix(offset(A, 50), T('10:00')), SITES), null);
    const left = G.travelSuggestion(working, fix(offset(A, 900), T('10:05')), SITES);
    assert.equal(left.type, 'left');
    assert.equal(left.jobId, 'jobA');
    const travelling = { kind: 'travel', jobId: null, travelFromJobId: 'jobA' };
    assert.equal(G.travelSuggestion(travelling, fix(offset(A, 2000), T('10:15')), SITES), null);
    const arr = G.travelSuggestion(travelling, fix(offset(B, -40), T('10:30')), SITES);
    assert.deepEqual(arr, { type: 'arrived', jobId: 'jobB', at: T('10:30'), fromJobId: 'jobA' });
    // Working at A but the fix is inside B (they drove without tapping Travel).
    assert.equal(G.travelSuggestion(working, fix(B, T('11:00')), SITES).type, 'arrived');
  });

  test('segments from fixes: work at A, travel to B (billed to B), work at B', () => {
    const fixes = [
      fix(offset(A, 20), T('07:05')), fix(offset(A, -30), T('09:00')),
      fix(offset(A, 600), T('10:12')), fix(offset(A, 2100), T('10:25')),
      fix(offset(B, 30), T('10:40')), fix(offset(B, -20), T('13:00')),
    ];
    const segs = G.buildTravelSegments(fixes, SITES, { start: { at: T('07:00'), kind: 'work', jobId: 'jobA' }, end: T('15:30') });
    assert.deepEqual(segs, [
      { kind: 'work', jobId: 'jobA', start: T('07:00'), end: T('10:12') },
      { kind: 'travel', jobId: 'jobB', fromJobId: 'jobA', start: T('10:12'), end: T('10:40') },
      { kind: 'work', jobId: 'jobB', start: T('10:40'), end: T('15:30') },
    ]);
  });

  test('segments from iOS geofence events, including a supply-house run back to the same site', () => {
    const events = [
      { type: 'exit', siteId: 'jobA', at: T('09:30') },
      { type: 'enter', siteId: 'jobA', at: T('10:05') },
      { type: 'exit', siteId: 'jobA', at: T('12:00') },
      { type: 'enter', siteId: 'jobB', at: T('12:20') },
    ];
    const segs = G.buildTravelSegments(events, SITES, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('15:00') });
    assert.deepEqual(segs.map((s) => [s.kind, s.jobId, s.start.slice(11, 16), s.end.slice(11, 16)]), [
      ['work', 'jobA', '07:00', '09:30'],
      ['travel', 'jobA', '09:30', '10:05'], // supply house and back: travel billed to A
      ['work', 'jobA', '10:05', '12:00'],
      ['travel', 'jobB', '12:00', '12:20'],
      ['work', 'jobB', '12:20', '15:00'],
    ]);
  });

  test('jitter: a quick step outside and back is not travel; bad fixes are ignored', () => {
    const fixes = [fix(offset(A, 300), T('09:00')), fix(offset(A, 10), T('09:02')), fix(offset(A, 9000), T('09:30'), 1500)];
    const segs = G.buildTravelSegments(fixes, SITES, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('10:00') });
    assert.deepEqual(segs, [{ kind: 'work', jobId: 'jobA', start: T('07:00'), end: T('10:00') }]);
  });

  test('starting with travel to the first site; travel still running keeps no job', () => {
    const segs = G.buildTravelSegments([fix(B, T('07:40'))], SITES, { start: { at: T('07:00'), kind: 'travel', jobId: null }, end: T('12:00') });
    assert.deepEqual(segs.map((s) => [s.kind, s.jobId]), [['travel', 'jobB'], ['work', 'jobB']]);
    const open = G.buildTravelSegments([fix(offset(A, 900), T('09:00'))], SITES, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('09:20') });
    assert.deepEqual(open.at(-1), { kind: 'travel', jobId: null, fromJobId: 'jobA', start: T('09:00'), end: T('09:20') });
  });

  test('sparse fixes: seen at A, next seen at B, travel runs from the last fix at A', () => {
    const segs = G.buildTravelSegments([fix(A, T('09:00')), fix(B, T('10:00'))], SITES, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('11:00') });
    assert.deepEqual(segs.map((s) => [s.kind, s.jobId, s.start.slice(11, 16)]), [['work', 'jobA', '07:00'], ['travel', 'jobB', '09:00'], ['work', 'jobB', '10:00']]);
  });

  test('segments become entry writes: the open entry closes, the rest are new, the last stays open', () => {
    const segs = G.buildTravelSegments([fix(offset(A, 600), T('10:12')), fix(B, T('10:40'))], SITES, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('12:00') });
    const { update, create } = G.entriesForSegments({ id: 'e1', employeeId: 'emp', clockIn: T('07:00'), jobId: 'jobA' }, segs);
    assert.deepEqual(update, { kind: 'work', jobId: 'jobA', clockOut: T('10:12'), breakMins: 0, breakStart: null });
    assert.equal(create.length, 2);
    assert.equal(create[0].kind, 'travel');
    assert.equal(create[0].jobId, 'jobB');
    assert.equal(create[0].travelFromJobId, 'jobA');
    assert.equal(create[1].clockOut, null);
    assert.equal(create[1].source, 'auto-split');
  });

  test('the break goes with the segments: lunch at B stays at B, a running break keeps running', () => {
    // 07:00 at A, left 07:20, at B from 07:45; a 30-minute lunch was taken (at B), now 13:00.
    const segs = G.buildTravelSegments([{ type: 'exit', siteId: 'jobA', at: T('07:20') }, { type: 'enter', siteId: 'jobB', at: T('07:45') }], SITES, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('13:00') });
    assert.equal(segs.length, 3);
    const open = { id: 'e1', employeeId: 'emp', clockIn: T('07:00'), jobId: 'jobA', breakMins: 30, breakStart: null };
    const { update, create } = G.entriesForSegments(open, segs);
    assert.deepEqual([update.breakMins, create[0].breakMins, create[1].breakMins], [0, 0, 30], 'not 30 minutes of break on a 20-minute stop at A');
    const paid = (s, b) => (Date.parse(s.end) - Date.parse(s.start)) / 60000 - b;
    assert.equal(paid(segs[0], update.breakMins) + paid(segs[1], create[0].breakMins) + paid(segs[2], create[1].breakMins), 360 - 30, 'the shift still pays 5.5 h');
    // On break since 12:30 when the update is applied: the open entry keeps the break running.
    const onBreak = G.entriesForSegments({ ...open, breakMins: 0, breakStart: T('12:30') }, segs);
    assert.equal(onBreak.update.breakStart, null);
    assert.equal(onBreak.create[1].breakStart, T('12:30'));
    // A break started at A at 07:10 and still running: A gets its 10 minutes, travel all of its 25, B runs from 07:45.
    const long = G.entriesForSegments({ ...open, breakMins: 0, breakStart: T('07:10') }, segs);
    assert.deepEqual([long.update.breakMins, long.create[0].breakMins, long.create[1].breakStart], [10, 25, T('07:45')]);
    // More recorded break than the work segments hold: nothing is lost.
    const big = G.splitBreak({ breakMins: 400 }, segs);
    assert.equal(big.reduce((s, b) => s + b.breakMins, 0), 400);
    assert.ok(big[0].breakMins <= 20 && big[1].breakMins <= 25);
  });
});

describe('maps and fixes', () => {
  test('web mercator round trip and scale', () => {
    const p = G.project(A.lat, A.lng, 15);
    const back = G.unproject(p.x, p.y, 15);
    assert.ok(Math.abs(back.lat - A.lat) < 1e-9 && Math.abs(back.lng - A.lng) < 1e-9);
    assert.ok(Math.abs(G.metresPerPixel(49.9, 16) - 1.53) < 0.02);
  });
  test('a fix keeps 6 decimals and whole-metre accuracy', () => {
    const f = toFix({ latitude: 49.123456789, longitude: -97.987654321, accuracy: 12.6 }, Date.parse(T('07:00')), 'browser');
    assert.deepEqual(f, { at: T('07:00'), lat: 49.123457, lng: -97.987654, accuracyM: 13, source: 'browser' });
  });
  test('the nearest 18 sites get the iOS regions', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `j${i}`, lat: A.lat + i * 0.01, lng: A.lng, radiusM: 150 }));
    const picked = pickRegions(many, { lat: A.lat + 0.29, lng: A.lng });
    assert.equal(picked.length, 18);
    assert.equal(picked[0].id, 'j29');
  });

  test('a map of people\'s points fetches tiles only around job sites, never around a point at home', async () => {
    const M = await import('../js/lib/minimap.js');
    const home = { lat: A.lat - 0.1, lng: A.lng - 0.1 }; // about 13 km from either site
    const at = (p, z) => { const q = G.project(p.lat, p.lng, z); return [Math.floor(q.x / G.TILE), Math.floor(q.y / G.TILE)]; };
    assert.ok(M.tileNearSites(15, ...at(A, 15), SITES), 'the site\'s own tile');
    assert.ok(!M.tileNearSites(15, ...at(home, 15), SITES), 'not the tile at home');
    assert.ok(!M.tileNearSites(15, ...at(home, 15), []), 'no sites, no tiles');
    // The real map, drawn with a stand-in DOM: which tile URLs would the browser request?
    const imgs = [];
    const node = () => ({ style: {}, dataset: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {}, closest: () => null });
    const h = (tag) => { const n = node(); if (tag === 'img') imgs.push(n); return n; };
    const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame };
    globalThis.document = { createElementNS: () => node() };
    globalThis.requestAnimationFrame = () => 0;
    try {
      const tiles = (center, tilesNear) => { imgs.length = 0; M.miniMap({ h, center, zoom: 16, height: 220, tilesNear }).setView(); return imgs.map((i) => i.src); };
      assert.ok(tiles(home, undefined).length > 0, 'the job screen\'s map loads every tile');
      assert.deepEqual(tiles(home, SITES), [], 'My location at home: no tile request at all');
      const nearA = tiles(A, SITES);
      const [tx, ty] = at(A, 15);
      assert.ok(nearA.some((u) => u.endsWith(`/tile/15/${ty}/${tx}`)), 'at the site the map still loads');
    } finally { globalThis.document = saved.document; globalThis.requestAnimationFrame = saved.raf; }
  });
});

describe('address lookup (NRCan Geolocator)', () => {
  const answer = [{ key: 'locate', name: '200 Main Street, Winnipeg, Manitoba', province: 'Manitoba', category: 'Street', lat: 49.8906, lng: -97.1359, bbox: null, tag: ['INTERPOLATED_POSITION'] }];
  test('parses the flat array and builds the URL', () => {
    assert.deepEqual(parseGeolocator(answer), [{ lat: 49.8906, lng: -97.1359, label: '200 Main Street, Winnipeg, Manitoba', kind: 'Street', approximate: true }]);
    assert.deepEqual(parseGeolocator({ error: 'x' }), []);
    assert.equal(geocodeUrl('200 Main St Winnipeg'), 'https://geolocator.api.geo.ca/?q=200%20Main%20St%20Winnipeg&lang=en&keys=locate');
  });
  test('adds the province, sends no credentials, explains failures', async () => {
    let seen;
    const f = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => answer }; };
    const r = await geocodeAddress('200 Main St, Winnipeg', { fetch: f, province: 'MB' });
    assert.equal(r[0].lat, 49.8906);
    assert.match(seen.url, /Winnipeg%2C%20MB&/);
    assert.equal(seen.init.credentials, 'omit');
    await assert.rejects(geocodeAddress('x', { fetch: f }), /street address/);
    await assert.rejects(geocodeAddress('1 Nowhere Rd', { fetch: async () => ({ ok: true, json: async () => [] }) }), /No match/);
    await assert.rejects(geocodeAddress('1 Nowhere Rd', { fetch: async () => { throw new TypeError('offline'); } }), /drop a pin/i);
  });
});

describe('consent and retention policy', () => {
  const settings = { company: { name: 'TG Electrical' } };
  test('defaults: on, 150 m, 90 days, no live map; retention clamped', () => {
    const s = P.locationSettings(settings);
    assert.equal(s.enabled, true);
    assert.equal(s.defaultRadiusM, 150);
    assert.equal(s.retentionDays, 90);
    assert.equal(s.liveCrewMap, false);
    assert.equal(P.locationSettings({ location: { retentionDays: 2 } }).retentionDays, 7);
    assert.equal(P.locationSettings({ location: { retentionDays: 5000 } }).retentionDays, 730);
  });
  test('the default notice names the company and says "only while clocked in"', () => {
    const t = P.policyTextFor(settings);
    assert.match(t, /^TG Electrical uses Fishtape/);
    assert.match(t, /only while you are clocked in/i);
    assert.match(P.policyFacts(settings).join(' '), /deleted after 90 days/);
    assert.match(P.policyFacts({ location: { liveCrewMap: true } }).join(' '), /Live crew map is ON/);
    assert.equal(P.policyTextFor({ location: { policyText: 'Our own words.' } }), 'Our own words.');
  });
  test('asked once per policy version; a new version asks again', () => {
    assert.equal(P.locationState([], 'e1', settings), 'ask');
    const yes = P.consentRecord('e1', settings, 'granted', { at: T('07:00') });
    assert.deepEqual(yes, { id: 'lc-e1-v1', employeeId: 'e1', policyVersion: 1, choice: 'granted', at: T('07:00'), via: 'web' });
    assert.equal(P.locationState([yes], 'e1', settings), 'granted');
    assert.equal(P.locationState([yes], 'e2', settings), 'ask', 'one person\'s answer is not another\'s');
    assert.equal(P.locationState([yes], 'e1', { location: { policyVersion: 2 } }), 'ask');
    assert.equal(P.locationState([P.consentRecord('e1', settings, 'declined')], 'e1', settings), 'declined');
    assert.equal(P.locationState([yes], 'e1', { location: { enabled: false } }), 'off');
    assert.equal(P.locationState([yes], null, settings), 'off');
  });
  test('points past retention', () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    const pts = [{ at: '2026-07-20T12:00:00Z' }, { at: '2026-07-21T13:00:00Z' }];
    assert.deepEqual(P.expiredPoints(pts, {}, now), [pts[0]]);
  });
});

describe('the clock keeps location to open shifts', () => {
  before(async () => { await store.open({ kind: 'demo' }); });
  const sites = SITES;

  test('clock in, attach the fix, flag off-site; points only for the open shift', () => {
    const e = C.clockIn(store, { employeeId: 'emp1', jobId: 'jobA', at: T('07:00') });
    assert.ok(e);
    assert.equal(C.clockIn(store, { employeeId: 'emp1', jobId: 'jobA' }), null, 'one open shift per person');
    const withFix = C.attachFix(store, e.id, fix(offset(B, 0), T('07:00'), 8), 'in', sites);
    assert.equal(withFix.flag.text, '4.2 km from the job site');
    assert.equal(withFix.clockInLoc.accuracyM, 8);
    assert.equal(store.list('locationPoints', (p) => p.timeEntryId === e.id).length, 1);
    const closed = C.closeEntry(store, e.id, { at: T('08:00') });
    assert.equal(closed.clockOut, T('08:00'));
    assert.equal(C.recordPoint(store, { entry: closed, fix: fix(A, T('08:05')), source: 'check' }), null, 'never after clock-out');
    assert.equal(C.recordPoint(store, { entry: { id: 'nope', employeeId: 'emp1' }, fix: fix(A, T('08:05')), source: 'check' }), null);
    assert.equal(store.list('locationPoints', (p) => p.timeEntryId === e.id).length, 1);
  });

  test('work, travel, arrive: two work entries and one travel entry billed to the second job', () => {
    let open = C.clockIn(store, { employeeId: 'emp2', jobId: 'jobA', at: T('07:00') });
    open = C.switchTo(store, open, { kind: 'travel', jobId: null, at: T('10:12') });
    assert.equal(open.kind, 'travel');
    assert.equal(open.travelFromJobId, 'jobA');
    open = C.switchTo(store, open, { kind: 'work', jobId: 'jobB', at: T('10:40') });
    C.closeEntry(store, open.id, { at: T('15:30') });
    const rows = store.list('timeEntries', (t) => t.employeeId === 'emp2').sort((a, b) => a.clockIn.localeCompare(b.clockIn));
    assert.deepEqual(rows.map((r) => [r.kind, r.jobId, r.clockIn.slice(11, 16), r.clockOut.slice(11, 16)]), [
      ['work', 'jobA', '07:00', '10:12'], ['travel', 'jobB', '10:12', '10:40'], ['work', 'jobB', '10:40', '15:30'],
    ]);
  });

  test('segments found in the background split the open shift', () => {
    const open = C.clockIn(store, { employeeId: 'emp3', jobId: 'jobA', at: T('07:00') });
    const segs = G.buildTravelSegments([{ type: 'exit', siteId: 'jobA', at: T('09:00') }, { type: 'enter', siteId: 'jobB', at: T('09:25') }], sites, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('11:00') });
    const last = C.applySegments(store, open, segs);
    assert.equal(last.clockOut, null);
    assert.equal(last.jobId, 'jobB');
    assert.equal(store.list('timeEntries', (t) => t.employeeId === 'emp3').length, 3);
  });

  test('applying segments during a break keeps the break running on the new open entry', () => {
    const open = C.clockIn(store, { employeeId: 'emp4', jobId: 'jobA', at: T('07:00') });
    store.update('timeEntries', open.id, { breakStart: T('12:30') });
    const segs = G.buildTravelSegments([{ type: 'exit', siteId: 'jobA', at: T('07:20') }, { type: 'enter', siteId: 'jobB', at: T('07:45') }], sites, { start: { at: T('07:00'), jobId: 'jobA' }, end: T('12:45') });
    const last = C.applySegments(store, store.get('timeEntries', open.id), segs);
    assert.equal(last.breakStart, T('12:30'));
    assert.equal(store.get('timeEntries', open.id).breakStart, null);
    const done = C.closeEntry(store, last.id, { at: T('13:00') });
    assert.equal(done.breakMins, 30, 'the break is unpaid, not lost');
  });

  test('approving a week and reviewing a flag', () => {
    const rows = store.list('timeEntries', (t) => t.employeeId === 'emp2');
    assert.equal(C.approveEntries(store, rows, { by: 'foreman' }), 3);
    assert.ok(store.list('timeEntries', (t) => t.employeeId === 'emp2').every((t) => t.approved && t.approvedBy === 'foreman'));
    const flagged = store.list('timeEntries', (t) => t.employeeId === 'emp1')[0];
    const r = C.reviewFlag(store, flagged.id, { by: 'foreman', note: 'Picked up material first' });
    assert.equal(r.flag.reviewedBy, 'foreman');
    assert.equal(r.flag.text, '4.2 km from the job site');
  });
});
