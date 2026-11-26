// Wire-run video (migration 0184): pure helpers, then the resumable upload routes against a real
// Postgres (skipped without TEST_DATABASE_URL). No ffmpeg: the transcode job is only checked to be queued.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, logCapture, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createValidator } from '../src/schemas.js';
import {
  CHUNK_BYTES, MAX_VIDEOS_PER_RUN, checkNewUpload, chunkVerdict, readChunk, sniffVideoHead, uploadPartName, uploadPartPath, wireRunMediaView,
} from '../src/services/wirerun-media.js';

const mp4 = (n = 2048) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(n, 7)]);

describe('wire-run media helpers', () => {
  test('partial upload names are dot-files nginx never serves, and paths cannot escape the media dir', () => {
    const n = uploadPartName();
    assert.match(n, /^\.upload-[a-f0-9]{32}\.part$/);
    assert.ok(uploadPartPath('/m', n).endsWith(n));
    for (const bad of ['../.upload-' + 'a'.repeat(32) + '.part', 'a'.repeat(32) + '.mp4', '.upload-x.part', null, '']) assert.equal(uploadPartPath('/m', bad), null);
  });

  test('a new upload states a size within the cap and an MP4 or WebM type', () => {
    assert.deepEqual(checkNewUpload({ bytes: 5000, mimeType: 'video/mp4;codecs=avc1' }, { maxVideoBytes: 10_000 }), { totalBytes: 5000, mime: 'video/mp4' });
    assert.deepEqual(checkNewUpload({ bytes: 5000 }, { maxVideoBytes: 10_000 }), { totalBytes: 5000, mime: null });
    assert.throws(() => checkNewUpload({ bytes: 20_000, mimeType: 'video/mp4' }, { maxVideoBytes: 10_000 }), (e) => e.statusCode === 413);
    assert.throws(() => checkNewUpload({ bytes: 10, mimeType: 'video/mp4' }, { maxVideoBytes: 10_000 }), (e) => e.statusCode === 400);
    assert.throws(() => checkNewUpload({ bytes: 5000, mimeType: 'video/quicktime' }, { maxVideoBytes: 10_000 }), (e) => e.statusCode === 415);
  });

  test('chunk offsets: resends overlap and are fine, gaps and overruns are refused', () => {
    assert.equal(chunkVerdict({ offset: 0, length: 10, received: 0, total: 30 }), 'write');
    assert.equal(chunkVerdict({ offset: 10, length: 10, received: 10, total: 30 }), 'write');
    assert.equal(chunkVerdict({ offset: 0, length: 10, received: 20, total: 30 }), 'write', 'a resend after a lost reply');
    assert.equal(chunkVerdict({ offset: 25, length: 10, received: 20, total: 30 }), 'gap');
    assert.equal(chunkVerdict({ offset: 20, length: 20, received: 20, total: 30 }), 'over');
    assert.equal(chunkVerdict({ offset: 0, length: 0, received: 0, total: 30 }), 'empty');
    assert.equal(chunkVerdict({ offset: NaN, length: 5, received: 0, total: 30 }), 'gap');
    assert.equal(chunkVerdict({ offset: -1, length: 5, received: 0, total: 30 }), 'gap');
  });

  test('only video heads pass the sniff, and they must match the declared type', () => {
    assert.equal(sniffVideoHead(mp4(64)), 'video/mp4');
    assert.equal(sniffVideoHead(mp4(64), 'video/mp4'), 'video/mp4');
    assert.throws(() => sniffVideoHead(mp4(64), 'video/webm'), (e) => e.statusCode === 415);
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(60)]);
    assert.equal(sniffVideoHead(mov), 'video/mp4', 'an iPhone QuickTime movie goes up as MP4 for the transcoder');
    assert.throws(() => sniffVideoHead(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(60)])), (e) => e.statusCode === 415, 'a JPEG is not a video');
    assert.throws(() => sniffVideoHead(Buffer.from('<!doctype html><script>x</script>'.padEnd(64))), (e) => e.statusCode === 415);
  });

  test('readChunk collects a body and refuses one over the cap', async () => {
    const buf = await readChunk(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 10);
    assert.equal(buf.toString(), 'abcdef');
    await assert.rejects(readChunk(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10), (e) => e.statusCode === 413);
  });

  test('the view shows upload progress, never file names, and no walkthrough transcript fields', () => {
    const up = wireRunMediaView({ id: 'm1', walkthrough_id: 'run-1', status: 'uploading', bytes: 4096, upload_total: 9000, upload_mime: 'video/mp4', upload_file: '.upload-' + 'a'.repeat(32) + '.part' });
    assert.equal(up.wireRunId, 'run-1');
    assert.equal(up.receivedBytes, 4096);
    assert.equal(up.totalBytes, 9000);
    assert.equal(up.chunkBytes, CHUNK_BYTES);
    assert.equal(up.url, null);
    assert.equal(up.mimeType, 'video/mp4');
    assert.ok(!('transcript' in up) && !('walkthroughId' in up));
    assert.ok(!JSON.stringify(up).includes('.upload-'));
    const sign = ({ mediaId, kind }) => ({ url: `/signed/${mediaId}/${kind}`, expiresAt: '2026-11-25T12:00:00.000Z' });
    const ready = wireRunMediaView({ id: 'm1', walkthrough_id: 'run-1', status: 'ready', bytes: 9000, output_file: 'b'.repeat(32) + '.mp4', poster_file: 'c'.repeat(32) + '.jpg', original_mime: 'video/webm' }, { sign });
    assert.equal(ready.url, '/signed/m1/video');
    assert.equal(ready.posterUrl, '/signed/m1/poster');
    assert.ok(!JSON.stringify(ready).includes('b'.repeat(32)), 'never a file name');
    assert.equal(ready.totalBytes, 9000);
    assert.equal(ready.chunkBytes, null);
  });
});

describe('wire runs carrying videos sync', () => {
  const validator = createValidator();
  const run = (videos, segSource = 'video') => ({
    id: 'r1', name: 'Kitchen', wiringMethod: 'cable', segments: [{ id: 's1', label: 'Frame', lengthM: 2.1, source: segSource, note: '' }], videos,
  });
  const video = (o = {}) => ({
    id: 'vid-1', label: 'AR path', localId: 'blob-abc', mediaId: '5f0c2d1e-8a7b-4c3d-9e2f-1a2b3c4d5e6f', status: 'uploading', bytes: 31_457_280, durationMs: 95_000,
    mimeType: 'video/mp4', source: 'ar-native', recordedAt: '2026-11-25T14:03:00.000Z', attachedAt: '2026-11-25T14:05:00.000Z', attachedBy: 'u1',
    markers: [{ atMs: 1200, pointIndex: 0, label: 'Start', segId: 's1', legM: null }, { atMs: 5400, pointIndex: 1, label: 'Point 2', segId: 's1', legM: 2.1 }],
    ...o,
  });

  test('a run with videos and a frame-measured segment is valid', () => {
    assert.equal(validator.validate('wireRuns', run([video()])), null);
    assert.equal(validator.validate('wireRuns', run([], 'ar')), null);
    assert.equal(validator.validate('wireRuns', run(null)), null, 'older records have none');
  });

  test('unknown statuses, sources and too many videos are refused', () => {
    assert.notEqual(validator.validate('wireRuns', run([video({ status: 'done' })])), null);
    assert.notEqual(validator.validate('wireRuns', run([video({ source: 'drone' })])), null);
    assert.notEqual(validator.validate('wireRuns', run([video()], 'laser')), null);
    assert.notEqual(validator.validate('wireRuns', run(Array.from({ length: 13 }, (_, i) => video({ id: `v${i}` })))), null);
    assert.notEqual(validator.validate('wireRuns', run([video({ markers: [{ atMs: -1 }] })])), null);
  });
});

describe('wire-run media routes', { skip }, () => {
  let t, app, A, B, crew, mediaDir;
  const files = () => readdirSync(mediaDir);
  const start = (token, body) => call(app, { method: 'POST', url: '/api/v1/wirerun-media', token, body });
  const chunk = (token, id, offset, buf) => app.inject({
    method: 'PUT', url: `/api/v1/wirerun-media/${id}/data`, payload: buf,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset) },
  }).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

  before(async () => {
    t = await createTestDatabase('wirerun_media');
    mediaDir = mkdtempSync(join(tmpdir(), 'fishtape-wrmedia-'));
    const config = testConfig();
    config.media = { dir: mediaDir, maxVideoBytes: 200_000, maxImageBytes: 50_000 };
    app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
    await app.ready();
    A = await ownerTenant(t, app, 'Wire Video A');
    B = await ownerTenant(t, app, 'Wire Video B');
    crew = await addMember(t, app, A.tenantId, { role: 'electrician' });
  });
  after(async () => {
    await app?.close(); await t?.close();
    if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
  });

  test('a video goes up in chunks, resumes after a gap, and is queued for transcoding', async () => {
    const video = mp4(10_000);
    const s = await start(A.token, { wireRunId: 'run-1', bytes: video.length, mimeType: 'video/mp4', durationMs: 4200 });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.status, 'uploading');
    assert.equal(s.body.receivedBytes, 0);
    assert.equal(s.body.totalBytes, video.length);
    const id = s.body.id;
    assert.ok(files().some((f) => /^\.upload-[a-f0-9]{32}\.part$/.test(f)), 'a partial file waits');

    let r = await chunk(A.token, id, 0, video.subarray(0, 4000));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.receivedBytes, 4000);
    // the reply was "lost": the same chunk again is harmless
    r = await chunk(A.token, id, 0, video.subarray(0, 4000));
    assert.equal(r.body.receivedBytes, 4000);
    // a chunk past what arrived is refused with the offset to resume from
    r = await chunk(A.token, id, 8000, video.subarray(8000));
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'offset_mismatch');
    assert.equal(r.body.error.details.receivedBytes, 4000);
    // the GET says the same, so a restarted app can resume
    const g = await call(app, { url: `/api/v1/wirerun-media/${id}`, token: crew.token });
    assert.equal(g.status, 200);
    assert.equal(g.body.receivedBytes, 4000);

    r = await chunk(A.token, id, 4000, video.subarray(4000));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'processing');
    assert.equal(r.body.receivedBytes, video.length);
    assert.match(r.body.url, new RegExp(String.raw`^/api/v1/media/${id}/video\?c=[0-9a-f-]{36}&e=\d+&s=[A-Za-z0-9_-]{43}$`), 'an MP4 plays (signed) while it is optimised');
    const name = (await t.superPool.query('SELECT original_file FROM walkthrough_media WHERE id = $1', [id])).rows[0].original_file;
    assert.equal(statSync(join(mediaDir, name)).size, video.length);
    const played = await app.inject({ method: 'GET', url: r.body.url, headers: { range: 'bytes=0-99' } });
    assert.equal(played.statusCode, 206, 'the signed url streams the upload');
    assert.equal(played.rawPayload.length, 100);
    assert.ok(!files().some((f) => f.endsWith('.part')), 'no partial left');
    const q = await t.superPool.query("SELECT count(*)::int AS n FROM jobs_queue WHERE kind = 'walkthrough_transcode' AND payload->>'mediaId' = $1", [id]);
    assert.equal(q.rows[0].n, 1);
    // a resend of the last chunk after it finished just reports the state
    r = await chunk(A.token, id, 4000, video.subarray(4000));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'processing');

    // the walkthrough routes do not see wire-run rows
    assert.equal((await call(app, { url: `/api/v1/walkthrough-media/${id}`, token: A.token })).status, 404);

    const d = await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${id}`, token: A.token });
    assert.equal(d.status, 204);
    assert.ok(!files().includes(name), 'the file went with the row');
  });

  test('a file that is not a video is refused at the first chunk and never stored', async () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>'.padEnd(500, ' '));
    const s = await start(A.token, { wireRunId: 'run-2', bytes: html.length, mimeType: 'video/mp4' });
    assert.equal(s.status, 201);
    const r = await chunk(A.token, s.body.id, 0, html);
    assert.equal(r.status, 415);
    const g = await call(app, { url: `/api/v1/wirerun-media/${s.body.id}`, token: A.token });
    assert.equal(g.body.receivedBytes, 0);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${s.body.id}`, token: A.token })).status, 204);
    assert.ok(!files().some((f) => f.endsWith('.part')), 'delete removes the partial file');
  });

  test('sizes, types and overruns are checked', async () => {
    assert.equal((await start(A.token, { wireRunId: 'run-3', bytes: 300_000, mimeType: 'video/mp4' })).status, 413);
    assert.equal((await start(A.token, { wireRunId: 'run-3', bytes: 3000, mimeType: 'video/quicktime' })).status, 415);
    assert.equal((await start(A.token, { wireRunId: '../x', bytes: 3000 })).status, 400);
    const s = await start(A.token, { wireRunId: 'run-3', bytes: 3000, mimeType: 'video/mp4' });
    const r = await chunk(A.token, s.body.id, 0, mp4(5000));
    assert.equal(r.status, 400, 'runs past the declared size');
    await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${s.body.id}`, token: A.token });
  });

  test('another company cannot see, feed or delete the upload; the crew can watch it', async () => {
    const s = await start(A.token, { wireRunId: 'run-4', bytes: 3000, mimeType: 'video/mp4' });
    const id = s.body.id;
    assert.equal((await call(app, { url: `/api/v1/wirerun-media/${id}`, token: B.token })).status, 404);
    assert.equal((await chunk(B.token, id, 0, mp4(2000))).status, 404);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${id}`, token: B.token })).status, 404);
    const crewRead = await call(app, { url: `/api/v1/wirerun-media/${id}`, token: crew.token });
    assert.equal(crewRead.status, 200);
    await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${id}`, token: A.token });
  });

  test(`a run holds at most ${MAX_VIDEOS_PER_RUN} videos`, async () => {
    const ids = [];
    for (let i = 0; i < MAX_VIDEOS_PER_RUN; i++) {
      const s = await start(A.token, { wireRunId: 'run-full', bytes: 3000, mimeType: 'video/mp4' });
      assert.equal(s.status, 201);
      ids.push(s.body.id);
    }
    const over = await start(A.token, { wireRunId: 'run-full', bytes: 3000, mimeType: 'video/mp4' });
    assert.equal(over.status, 429);
    for (const id of ids) await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${id}`, token: A.token });
  });

  test('uploads abandoned for a week are dropped on the next upload', async () => {
    const s = await start(A.token, { wireRunId: 'run-old', bytes: 3000, mimeType: 'video/mp4' });
    await t.superPool.query("UPDATE walkthrough_media SET updated_at = now() - interval '8 days' WHERE id = $1", [s.body.id]);
    const parts = files().filter((f) => f.endsWith('.part')).length;
    const next = await start(A.token, { wireRunId: 'run-new', bytes: 3000, mimeType: 'video/mp4' });
    assert.equal(next.status, 201);
    assert.equal((await call(app, { url: `/api/v1/wirerun-media/${s.body.id}`, token: A.token })).status, 404);
    assert.equal(files().filter((f) => f.endsWith('.part')).length, parts, 'one partial gone, one added');
    await call(app, { method: 'DELETE', url: `/api/v1/wirerun-media/${next.body.id}`, token: A.token });
  });

  test('the CORS preflight lets the iOS app send the offset header', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/api/v1/wirerun-media/x/data',
      headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-fishtape,x-upload-offset' } });
    const allowed = String(r.headers['access-control-allow-headers'] || '').toLowerCase();
    assert.ok(allowed.includes('x-upload-offset'), allowed);
  });
});
