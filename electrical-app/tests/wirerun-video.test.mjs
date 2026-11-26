// Run: node --test electrical-app/tests/
// Wire-run video: markers, attach-or-keep decisions, storage room, the device recordings list,
// resumable chunked uploads, and the AR result carrying a recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../js/lib/wirerun-video.js';
import * as R from '../js/lib/wirerun-recordings.js';
import * as W from '../js/lib/wireruns.js';
import * as AR from '../js/lib/ar-measure.js';

const MB = 1024 * 1024;

/** The bits of js/store.js the recordings helpers use. */
function fakeStore(runs = []) {
  const data = new Map(runs.map((r) => [r.id, structuredClone(r)]));
  const meta = new Map();
  return {
    actorId: 'u1',
    meta: (k) => structuredClone(meta.get(k)),
    setMeta: (k, v) => { if (v === undefined) meta.delete(k); else meta.set(k, structuredClone(v)); },
    get: (coll, id) => (coll === 'wireRuns' && data.has(id) ? structuredClone(data.get(id)) : null),
    list: () => [...data.values()].map((r) => structuredClone(r)),
    update: (coll, id, patch) => { const next = { ...data.get(id), ...structuredClone(patch) }; data.set(id, next); return structuredClone(next); },
  };
}

const arPath = () => ({
  totalM: 5, segments: [{ lengthM: 2 }, { lengthM: 3 }],
  points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 3, z: 0 }],
  pointTimesMs: [1200, 5400.4, 9100],
});

test('markers: one per point at the moment it was dropped, tied to the segment its leg became', () => {
  const split = V.markersFromPath(arPath(), { segIds: ['sA', 'sB'] });
  assert.deepEqual(split.map((m) => [m.atMs, m.label, m.segId, m.legM]), [[1200, 'Start', 'sA', null], [5400, 'Point 2', 'sA', 2], [9100, 'Point 3', 'sB', 3]]);
  const whole = V.markersFromPath(arPath(), { segIds: ['sAll'] });
  assert.ok(whole.every((m) => m.segId === 'sAll'));
  assert.deepEqual(V.markersFromPath({ ...arPath(), pointTimesMs: undefined }), [], 'no times, no markers');
});

test('markers are cleaned, ordered and clipped to the video; hand-set ones slot in by time', () => {
  const m = V.normalizeMarkers([{ atMs: 9000, label: 'b' }, { atMs: 'x' }, null, { atMs: -5, label: '' }, { atMs: 20000, label: 'late' }], 10000);
  assert.deepEqual(m.map((x) => [x.atMs, x.label]), [[0, 'Marker'], [9000, 'b'], [10000, 'late']]);
  const added = V.withMarker(m, { atMs: 4000, label: '  Box above door ' }, 10000);
  assert.deepEqual(added.map((x) => x.label), ['Marker', 'Box above door', 'b', 'late']);
  assert.equal(V.normalizeMarkers(Array.from({ length: 600 }, (_, i) => ({ atMs: i }))).length, V.MAX_MARKERS);
});

test('stepping between markers while the video plays', () => {
  const m = V.markersFromPath(arPath());
  assert.equal(V.markerAt(m, 0), -1, 'before the first point');
  assert.equal(V.markerAt(m, 1300), 0);
  assert.equal(V.markerAt(m, 9000), 2, 'within the slack before a marker counts as on it');
  assert.equal(V.stepMarker(m, 1200, 1), 1, 'next from the first marker');
  assert.equal(V.stepMarker(m, 9100, 1), -1, 'nothing after the last');
  assert.equal(V.stepMarker(m, 5500, -1), 0, 'previous, not the one just passed');
  assert.equal(V.stepMarker(m, 1000, -1), -1);
});

test('attach now or keep for later: size, memory and connection decide, and say why', () => {
  assert.equal(V.attachDecision({ bytes: 12 * MB, online: true, deviceMemoryGb: 4 }).action, 'attach');
  const big = V.attachDecision({ bytes: 63 * MB, online: true });
  assert.equal(big.action, 'keep'); assert.equal(big.reason, 'big'); assert.match(big.message, /63 MB/);
  assert.equal(V.attachDecision({ bytes: 200 * MB }).reason, 'too-big');
  assert.equal(V.attachDecision({ bytes: 5 * MB, deviceMemoryGb: 2 }).reason, 'memory');
  assert.equal(V.attachDecision({ bytes: 5 * MB, deviceMemoryGb: null }).action, 'attach', 'unknown memory is not low memory');
  const off = V.attachDecision({ bytes: 5 * MB, online: false });
  assert.equal(off.reason, 'offline'); assert.match(off.message, /offline/i);
});

test('room for a recording, with headroom; unknown quota does not block', () => {
  assert.equal(V.roomFor(50 * MB, null).ok, true);
  assert.equal(V.roomFor(50 * MB, { quota: 1000 * MB, usage: 100 * MB }).ok, true);
  const full = V.roomFor(50 * MB, { quota: 1000 * MB, usage: 900 * MB });
  assert.equal(full.ok, false);
  assert.match(full.message, /100 MB free/);
});

test('sizes and times read the way people say them', () => {
  assert.equal(V.fmtBytes(512), '1 KB');
  assert.equal(V.fmtBytes(1.5 * MB), '1.5 MB');
  assert.equal(V.fmtBytes(63.4 * MB), '63 MB');
  assert.equal(V.fmtBytes(2.25 * 1024 * MB), '2.3 GB');
  assert.equal(V.fmtClock(65_400), '1:05');
  assert.equal(V.fmtClock(3_725_000), '1:02:05');
  assert.equal(V.fmtClock(1_850, { tenths: true }), '0:01.8');
  assert.equal(V.fmtBytes(0), '0 KB');
});

test('recordings follow the "Working on" job', () => {
  const recs = [{ id: 'a', jobId: 'j1' }, { id: 'b', jobId: 'j2' }, { id: 'c', jobId: null }];
  assert.deepEqual(V.recordingsForFocus(recs, ''), { shown: recs, hidden: 0 });
  const f = V.recordingsForFocus(recs, 'j1');
  assert.deepEqual(f.shown.map((r) => r.id), ['a']);
  assert.equal(f.hidden, 2);
});

test('run videos: cleaned, patched one at a time, upload rules and status words', () => {
  const rec = V.newRecording({ localId: 'blob-1', bytes: 8 * MB, durationMs: 30_000, mimeType: 'video/webm', source: 'ar-webxr', markers: V.markersFromPath(arPath()), label: 'Kitchen' });
  const v = V.runVideoFrom(rec, { attachedBy: 'u1' });
  assert.equal(v.status, 'local'); assert.equal(v.mediaId, null); assert.equal(v.markers.length, 3); assert.equal(v.localId, 'blob-1');
  const list = V.normalizeVideos([v, { id: 'junk', status: 'weird', mediaId: 'm9' }, null]);
  assert.equal(list.length, 2);
  assert.equal(list[1].status, 'processing', 'an unknown status with a server id reads as processing');
  const patched = V.patchVideoList(list, v.id, { status: 'uploading', mediaId: 'm1', error: null });
  assert.equal(patched[0].status, 'uploading'); assert.ok(!('error' in patched[0]));
  assert.equal(V.needsUpload(v, { hasLocal: true }), true);
  assert.equal(V.needsUpload(v, { hasLocal: false }), false, 'bytes on another device');
  assert.equal(V.needsUpload({ ...v, status: 'ready', mediaId: 'm1' }, { hasLocal: true }), false);
  assert.equal(V.needsUpload({ ...v, bytes: 300 * MB }, { hasLocal: true }), false, 'over the server cap');
  assert.equal(V.videoStatus(v, { hasLocal: false }).label, 'on another device');
  assert.equal(V.videoStatus({ ...v, status: 'uploading' }, { hasLocal: false }).label, 'uploading from another device');
  assert.equal(V.videoStatus({ ...v, status: 'ready' }).tone, 'success');
});

test('storage use adds up recordings waiting and attached copies on this device', () => {
  const recs = [{ bytes: 10 * MB }, { bytes: 5 * MB }];
  const runs = [{ videos: [{ localId: 'here', bytes: 20 * MB }, { localId: 'elsewhere', bytes: 99 * MB }, { localId: null, bytes: 7 }] }];
  const u = V.storageUse(recs, runs, (id) => id === 'here');
  assert.deepEqual(u, { unattachedBytes: 15 * MB, unattachedCount: 2, attachedBytes: 20 * MB, attachedCount: 1, totalBytes: 35 * MB });
});

test('chunked upload resumes from the server offset, retries a dropped signal, stops at processing', async () => {
  const K = 64 * 1024; // the smallest chunk it sends
  const blob = new Blob([new Uint8Array(4 * K)]);
  const calls = [];
  let received = 0, dropped = false;
  const putChunk = async (offset, slice) => {
    calls.push(offset / K);
    if (offset > received) throw Object.assign(new Error('gap'), { code: 'offset_mismatch', details: { receivedBytes: received } });
    if (offset === K && !dropped) { dropped = true; throw Object.assign(new Error('offline'), { code: 'offline', status: 0 }); }
    received = Math.max(received, offset + slice.size);
    return { receivedBytes: received, status: received >= 4 * K ? 'processing' : 'uploading' };
  };
  const progress = [];
  const last = await V.runChunkedUpload({ blob, offset: 2 * K, chunkBytes: K, putChunk, onProgress: (s) => progress.push(s), wait: async () => {} });
  // started too far ahead -> told to go back to 0, then 1 (drops once, retried), 2, 3
  assert.deepEqual(calls, [2, 0, 1, 1, 2, 3]);
  assert.equal(last.status, 'processing');
  assert.equal(progress.at(-1), 4 * K);
});

test('chunked upload gives up on a refusal and after too many dropped attempts', async () => {
  const blob = new Blob([new Uint8Array(100)]);
  await assert.rejects(V.runChunkedUpload({ blob, chunkBytes: 64, putChunk: async () => { throw Object.assign(new Error('not a video'), { code: 'unsupported_media', status: 415 }); }, wait: async () => {} }), /not a video/);
  let n = 0;
  await assert.rejects(V.runChunkedUpload({ blob, chunkBytes: 64, retries: 2, putChunk: async () => { n++; throw Object.assign(new Error('down'), { code: 'unavailable', status: 503 }); }, wait: async () => {} }), /down/);
  assert.equal(n, 3, 'first try plus two retries');
});

test('the device list: attach moves a recording into the run with its markers; detach moves it back', async () => {
  const store = fakeStore([{ id: 'run-1', name: 'Kitchen', jobId: 'j1', videos: [] }, { id: 'run-2', name: 'Garage', videos: [] }]);
  const rec = V.newRecording({ localId: 'blob-1', bytes: 3 * MB, durationMs: 9000, markers: V.markersFromPath(arPath()), jobId: 'j1', runId: 'run-1', label: 'AR path' });
  store.setMeta(V.META_KEY, [rec]);
  assert.equal(R.listRecordings(store).length, 1);
  const v = R.attachRecording(store, rec.id, 'run-2', { actorId: 'u1' });
  assert.equal(R.listRecordings(store).length, 0, 'no longer waiting');
  const run2 = store.get('wireRuns', 'run-2');
  assert.equal(run2.videos.length, 1);
  assert.equal(run2.videos[0].localId, 'blob-1', 'same bytes');
  assert.equal(run2.videos[0].markers.length, 3);
  assert.equal(run2.videos[0].attachedBy, 'u1');
  assert.throws(() => R.attachRecording(store, rec.id, 'run-1'), (e) => e.code === 'gone');

  R.detachVideo(store, 'run-2', v.id);
  assert.equal(store.get('wireRuns', 'run-2').videos.length, 0);
  const back = R.listRecordings(store);
  assert.equal(back.length, 1);
  assert.equal(back[0].localId, 'blob-1');
  assert.equal(back[0].runId, 'run-2');

  // once uploaded, a video can't be detached (the server copy belongs to the run)
  const v2 = R.attachRecording(store, back[0].id, 'run-1');
  store.update('wireRuns', 'run-1', { videos: V.patchVideoList(store.get('wireRuns', 'run-1').videos, v2.id, { mediaId: 'm1', status: 'ready' }) });
  assert.throws(() => R.detachVideo(store, 'run-1', v2.id), (e) => e.code === 'uploaded');

  // removing it asks the server to delete its copy too
  const deleted = [];
  const out = await R.removeVideo(store, 'run-1', v2.id, { deleteServer: async (id) => { deleted.push(id); } });
  assert.deepEqual(deleted, ['m1']);
  assert.equal(out.serverError, null);
  assert.equal(store.get('wireRuns', 'run-1').videos.length, 0);
});

test('a run holds at most MAX_VIDEOS_PER_RUN videos; saving needs somewhere to store the bytes', async () => {
  const full = Array.from({ length: V.MAX_VIDEOS_PER_RUN }, (_, i) => ({ id: `v${i}`, localId: `b${i}`, status: 'local' }));
  const store = fakeStore([{ id: 'run-1', videos: full }]);
  store.setMeta(V.META_KEY, [V.newRecording({ localId: 'blob-x', bytes: 10 })]);
  assert.throws(() => R.attachRecording(store, R.listRecordings(store)[0].id, 'run-1'), (e) => e.code === 'full');
  // Node has no IndexedDB: a clear refusal, nothing half-saved
  await assert.rejects(R.saveRecording(store, new Blob([new Uint8Array(10)])), (e) => e.code === 'no_storage');
  await assert.rejects(R.saveRecording(store, new Blob([])), (e) => e.code === 'empty');
});

test('wire runs keep their videos, copies leave them behind, and frame measurements total on their own', () => {
  const run = W.normalizeRun({ id: 'r', segments: [{ id: 's1', lengthM: 4, source: 'video' }, { id: 's2', lengthM: 1, source: 'ar' }], videos: [{ id: 'v1', localId: 'b', status: 'local', markers: [{ atMs: 5 }] }] });
  assert.equal(run.videos.length, 1);
  assert.equal(run.segments[0].source, 'video');
  assert.equal(W.SOURCES.video, 'Video frame');
  assert.equal(W.duplicateRun(run).videos, undefined, 'a copy has no videos');
  const t = W.runTotals(run);
  assert.equal(t.bySource.video, 4);
  assert.equal(t.runM, 5);
});

test('AR results carry the point times and the native recording reference, checked', () => {
  const raw = { totalM: 2, points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], pointTimesMs: [100, 2500.6], video: { path: '/tmp/ar-run-1.mp4', bytes: 1234, durationMs: 3000.2, mimeType: 'video/mp4' } };
  const out = AR.normalizeResult(raw);
  assert.deepEqual(out.pointTimesMs, [100, 2501]);
  assert.deepEqual(out.videoRef, { path: '/tmp/ar-run-1.mp4', bytes: 1234, durationMs: 3000, mimeType: 'video/mp4' });
  const bad = AR.normalizeResult({ ...raw, pointTimesMs: [100], video: { path: '' } });
  assert.equal(bad.pointTimesMs, undefined, 'times must match the points one to one');
  assert.equal(bad.videoRef, undefined);
  assert.equal(AR.normalizeResult({ ...raw, video: { path: '/x.mp4', mimeType: 'text/html' } }).videoRef.mimeType, 'video/mp4');
});

test('WebXR recording: the best type the browser can write, and an even size capped at 1280', () => {
  assert.equal(AR.pickRecordMime((m) => m.startsWith('video/webm')), 'video/webm;codecs=vp9');
  assert.equal(AR.pickRecordMime((m) => m === 'video/mp4'), 'video/mp4');
  assert.equal(AR.pickRecordMime(null), '');
  assert.deepEqual(AR.recordSize(1920, 1440), { width: 1280, height: 960 });
  assert.deepEqual(AR.recordSize(480, 641), { width: 480, height: 642 });
  assert.deepEqual(AR.recordSize(1440, 1920), { width: 960, height: 1280 });
});
