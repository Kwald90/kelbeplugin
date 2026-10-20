// The shift tracker (js/lib/shift-tracker.js) in the iOS app, with stand-in native plugins: the
// geofence is stopped whenever there is no open shift (also after a relaunch and at sign-out),
// and Clock out is stamped at the tap, not when the location fix arrives.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const calls = { start: [], stop: 0 };
let position = null; // the next getCurrentPosition answer: () => Promise<{ coords, timestamp }>
globalThis.document ??= { addEventListener() {}, visibilityState: 'visible' };
globalThis.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    FishtapeGeofence: {
      async start(o) { calls.start.push(o.shiftId); return { tracking: true }; },
      async stop() { calls.stop++; return {}; },
      async events() { return { events: [] }; },
      async status() { return { tracking: false }; },
    },
    Geolocation: {
      async checkPermissions() { return { location: 'granted' }; },
      async requestPermissions() { return { location: 'granted' }; },
      getCurrentPosition() { return position(); },
    },
  },
};

const { store } = await import('../js/store.js');
const tracker = await import('../js/lib/shift-tracker.js');
const C = await import('../js/lib/clock.js');
const { consentRecord } = await import('../js/lib/location-policy.js');

const EMP = 'emp-tracker';
const ctx = { store, auth: { current: () => ({ id: EMP }) }, ui: { toast() {}, h() { return { remove() {} }; }, icon() {}, button() {}, fmtTime: (x) => x } };
const tick = (msec) => new Promise((r) => setTimeout(r, msec));
const coords = { latitude: 49.8951, longitude: -97.1384, accuracy: 9 };

describe('the shift tracker in the iOS app', () => {
  before(async () => { await store.open({ kind: 'demo' }); });

  test('a launch with no open shift stops a geofence left running by an earlier page', async () => {
    assert.equal(C.openEntry(store, EMP), null);
    tracker.startShiftTracker(ctx);
    await tick(0);
    assert.equal(calls.stop, 1, 'stopped once, though this page never started it');
    tracker.refresh();
    assert.equal(calls.stop, 1, 'only once while nothing changes');
  });

  test('sign-out (and a company switch) stops it while the shift is still open', async () => {
    store.add('locationConsents', consentRecord(EMP, store.settings(), 'granted'));
    const open = C.clockIn(store, { employeeId: EMP, jobId: null });
    await tick(0);
    assert.deepEqual(calls.start, [open.id], 'watching the open shift');
    const before = calls.stop;
    await tracker.api.stop();
    assert.equal(calls.stop, before + 1);
    assert.equal(tracker.api.watching, false);
    C.closeEntry(store, open.id);
  });

  test('Clock out is stamped at the tap; the fix that comes later does not move it', async () => {
    const open = C.clockIn(store, { employeeId: EMP, jobId: null, at: new Date(Date.now() - 3600_000).toISOString() });
    let answer;
    position = () => new Promise((r) => { answer = r; });
    const tapBefore = Date.now();
    const out = tracker.clockOutFlow(ctx, { note: 'done' });
    const tapAfter = Date.now();
    assert.equal(await tracker.clockOutFlow(ctx, {}), null, 'a second tap while the fix is coming does nothing');
    await tick(120); // a slow fix
    assert.equal(store.get('timeEntries', open.id).clockOut, null, 'still open while the fix is coming');
    answer({ coords, timestamp: Date.now() });
    const done = await out;
    const t = Date.parse(done.clockOut);
    assert.ok(t >= tapBefore && t <= tapAfter, `clock-out ${done.clockOut} is the tap, not ${new Date().toISOString()}`);
    assert.equal(done.note, 'done');
    assert.equal(done.clockOutLoc.lat, 49.8951, 'the clock-out fix is kept');
  });

  test('a fix that only comes when the app is opened again is not the clock-out location', async () => {
    const open = C.clockIn(store, { employeeId: EMP, jobId: null, at: new Date(Date.now() - 3600_000).toISOString() });
    position = async () => ({ coords, timestamp: Date.now() + 9 * 3600_000 }); // phone locked until morning
    const tap = Date.now();
    const done = await tracker.clockOutFlow(ctx, {});
    assert.ok(Date.parse(done.clockOut) - tap < 1000);
    assert.equal(done.clockOutLoc, undefined);
    assert.equal(store.get('timeEntries', open.id).clockOut, done.clockOut);
  });
});
