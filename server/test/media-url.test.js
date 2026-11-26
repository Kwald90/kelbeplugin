// Job-site media behind signed URLs (services/media-url.js, routes/v1/media.js): the signer, byte
// ranges, then the route against real Postgres (skipped without TEST_DATABASE_URL): a valid link
// streams (206 for ranges), an expired, tampered or other-company link doesn't, a missing file is
// 404, and only promotion media is published to MEDIA_DIR/public.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { call, logCapture, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createSealer } from '../src/lib/crypto.js';
import { MEDIA_URL_TTL_S, createMediaSigner, mediaContentType, mediaFileFor, parseRange } from '../src/services/media-url.js';
import { publishPromotionMedia } from '../src/services/promotions.js';

const sealer = createSealer(Buffer.alloc(32, 7).toString('base64'));
const M = randomUUID(), T = randomUUID(), T2 = randomUUID();
const query = (url) => Object.fromEntries(new URL(url, 'https://x').searchParams);

describe('signed media urls', () => {
  test('a signed url verifies for its file and company, and says when it expires', () => {
    const now = Date.UTC(2026, 10, 25, 12, 1, 0);
    const s = createMediaSigner(sealer, { now: () => now });
    const { url, expiresAt } = s.sign({ mediaId: M, tenantId: T, kind: 'video' });
    assert.match(url, new RegExp(`^/api/v1/media/${M}/video\\?c=${T}&e=\\d+&s=[A-Za-z0-9_-]{43}$`));
    const life = (Date.parse(expiresAt) - now) / 1000;
    assert.ok(life >= MEDIA_URL_TTL_S && life <= MEDIA_URL_TTL_S + 300, `lives ${life}s`);
    const q = query(url);
    assert.deepEqual(s.verify({ mediaId: M, kind: 'video', ...q }), { ok: true, tenantId: T, expiresAt: Number(q.e) });
    // the same url for a few minutes, so it can be cached and an AVPlayer keeps one url
    assert.equal(createMediaSigner(sealer, { now: () => now + 60_000 }).sign({ mediaId: M, tenantId: T, kind: 'video' }).url, url);
  });

  test('expired, tampered, other-file and other-company links are refused', () => {
    const now = Date.now();
    const s = createMediaSigner(sealer, { now: () => now });
    const q = query(s.sign({ mediaId: M, tenantId: T, kind: 'video' }).url);
    const later = createMediaSigner(sealer, { now: () => now + (MEDIA_URL_TTL_S + 301) * 1000 });
    assert.deepEqual(later.verify({ mediaId: M, kind: 'video', ...q }), { ok: false, reason: 'expired' });
    const bad = (o) => s.verify({ mediaId: M, kind: 'video', ...q, ...o });
    assert.equal(bad({ s: q.s.slice(0, -1) + (q.s.endsWith('A') ? 'B' : 'A') }).reason, 'invalid', 'signature changed');
    assert.equal(bad({ e: String(Number(q.e) + 300) }).reason, 'invalid', 'expiry pushed out');
    assert.equal(bad({ c: T2 }).reason, 'invalid', 'another company');
    assert.equal(s.verify({ mediaId: randomUUID(), kind: 'video', ...q }).reason, 'invalid', 'another file');
    assert.equal(s.verify({ mediaId: M, kind: 'poster', ...q }).reason, 'invalid', 'poster link from a video link');
    assert.equal(bad({ s: '' }).reason, 'invalid');
    assert.equal(bad({ e: '1e12' }).reason, 'invalid');
    assert.equal(s.verify({ mediaId: '../x', kind: 'video', ...q }).reason, 'invalid');
    const other = createMediaSigner(createSealer(Buffer.alloc(32, 9).toString('base64')), { now: () => now });
    assert.equal(other.verify({ mediaId: M, kind: 'video', ...q }).reason, 'invalid', 'another master key');
  });

  test('byte ranges', () => {
    assert.equal(parseRange(undefined, 1000), null);
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 }, 'clipped to the file');
    assert.deepEqual(parseRange('bytes=0-1', 1000), { start: 0, end: 1 }, 'Safari probes the first two bytes');
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-1,5-9', 1000), null, 'several ranges: the whole file');
    assert.equal(parseRange('items=0-1', 1000), null);
    assert.equal(parseRange('bytes=9-1', 1000), null);
  });

  test('which file a kind means, and its type', () => {
    const f = (o) => ({ id: M, original_file: 'a.mp4', output_file: 'b.mp4', poster_file: 'c.jpg', ...o });
    assert.equal(mediaFileFor(f({ status: 'ready' }), 'video'), 'b.mp4');
    assert.equal(mediaFileFor(f({ status: 'processing', output_file: null }), 'video'), 'a.mp4');
    assert.equal(mediaFileFor(f({ status: 'uploading', output_file: null }), 'video'), null);
    assert.equal(mediaFileFor(f({ status: 'ready' }), 'poster'), 'c.jpg');
    assert.equal(mediaFileFor(null, 'video'), null);
    assert.equal(mediaContentType('x.mp4'), 'video/mp4');
    assert.equal(mediaContentType('x.webm'), 'video/webm');
    assert.equal(mediaContentType('x.jpg'), 'image/jpeg');
  });
});

describe('the signed media route', { skip }, () => {
  let t, app, A, B, mediaDir, signer;
  const hex = (c) => c.repeat(32);
  const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(5000, 3)]);
  const POSTER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
  const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });
  async function row(tenantId, o = {}) {
    const r = await t.superPool.query(
      `INSERT INTO walkthrough_media (tenant_id, owner_kind, walkthrough_id, status, original_file, output_file, poster_file, original_mime, bytes)
       VALUES ($1, $2, 'wt-1', $3, $4, $5, $6, 'video/mp4', $7) RETURNING id`,
      [tenantId, o.kind || 'walkthrough', o.status || 'ready', o.original || null, o.output || null, o.poster || null, VIDEO.length]);
    return r.rows[0].id;
  }

  before(async () => {
    t = await createTestDatabase('media_url');
    mediaDir = mkdtempSync(join(tmpdir(), 'fishtape-mediaurl-'));
    const config = testConfig();
    config.media = { dir: mediaDir, maxVideoBytes: 200_000, maxImageBytes: 50_000 };
    app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
    await app.ready();
    signer = createMediaSigner(app.sealer);
    A = await ownerTenant(t, app, 'Media Url A');
    B = await ownerTenant(t, app, 'Media Url B');
    writeFileSync(join(mediaDir, hex('a') + '.mp4'), VIDEO);
    writeFileSync(join(mediaDir, hex('b') + '.jpg'), POSTER);
  });
  after(async () => {
    await app?.close(); await t?.close();
    if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
  });

  test('a valid link streams the video, whole or by byte range, privately and for the app', async () => {
    const id = await row(A.tenantId, { output: hex('a') + '.mp4', poster: hex('b') + '.jpg' });
    const { url } = signer.sign({ mediaId: id, tenantId: A.tenantId, kind: 'video' });
    const whole = await get(url);
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(Number(whole.headers['content-length']), VIDEO.length);
    assert.ok(whole.rawPayload.equals(VIDEO));
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.match(whole.headers['cache-control'], /^private, max-age=\d+$/);
    assert.equal(whole.headers['cross-origin-resource-policy'], 'cross-origin');

    const part = await get(url, { range: 'bytes=100-199' });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 100-199/${VIDEO.length}`);
    assert.ok(part.rawPayload.equals(VIDEO.subarray(100, 200)));
    const tail = await get(url, { range: 'bytes=-10' });
    assert.equal(tail.statusCode, 206);
    assert.ok(tail.rawPayload.equals(VIDEO.subarray(-10)));
    const beyond = await get(url, { range: `bytes=${VIDEO.length}-` });
    assert.equal(beyond.statusCode, 416);
    assert.equal(beyond.headers['content-range'], `bytes */${VIDEO.length}`);

    const poster = await get(signer.sign({ mediaId: id, tenantId: A.tenantId, kind: 'poster' }).url);
    assert.equal(poster.statusCode, 200);
    assert.equal(poster.headers['content-type'], 'image/jpeg');

    // the iOS app (capacitor://localhost) may read it, so the frame measure can draw it
    const cors = await get(url, { origin: 'capacitor://localhost' });
    assert.equal(cors.headers['access-control-allow-origin'], 'capacitor://localhost');
  });

  test('expired and tampered links get 401 and no bytes', async () => {
    const id = await row(A.tenantId, { output: hex('a') + '.mp4' });
    const old = createMediaSigner(app.sealer, { now: () => Date.now() - 3600_000 }).sign({ mediaId: id, tenantId: A.tenantId, kind: 'video' }).url;
    const r1 = await get(old);
    assert.equal(r1.statusCode, 401);
    assert.equal(JSON.parse(r1.body).error.code, 'media_url_expired');
    const good = signer.sign({ mediaId: id, tenantId: A.tenantId, kind: 'video' }).url;
    for (const bad of [good.replace(/s=.{5}/, 's=AAAAA'), good.replace(/e=\d+/, (m) => `e=${Number(m.slice(2)) + 600}`), good.replace(/&s=.*$/, ''), `/api/v1/media/${id}/video`]) {
      const r = await get(bad);
      assert.equal(r.statusCode, 401, bad);
      assert.equal(JSON.parse(r.body).error.code, 'media_url_invalid');
      assert.ok(!r.rawPayload.includes(VIDEO.subarray(0, 12)));
    }
  });

  test("another company's media can't be reached with your link or theirs swapped in", async () => {
    const theirs = await row(B.tenantId, { output: hex('a') + '.mp4' });
    // a link signed for company A naming B's media id: A can't see B's row (RLS) -> 404
    const r1 = await get(signer.sign({ mediaId: theirs, tenantId: A.tenantId, kind: 'video' }).url);
    assert.equal(r1.statusCode, 404);
    // B's own link with the company switched to A: the signature no longer matches -> 401
    const own = signer.sign({ mediaId: theirs, tenantId: B.tenantId, kind: 'video' }).url;
    const r2 = await get(own.replace(`c=${B.tenantId}`, `c=${A.tenantId}`));
    assert.equal(r2.statusCode, 401);
    assert.equal((await get(own)).statusCode, 200, 'B itself can');
  });

  test('a missing file, a missing poster and a not-yet-uploaded video are 404', async () => {
    const gone = await row(A.tenantId, { output: hex('9') + '.mp4' });
    assert.equal((await get(signer.sign({ mediaId: gone, tenantId: A.tenantId, kind: 'video' }).url)).statusCode, 404);
    assert.equal((await get(signer.sign({ mediaId: gone, tenantId: A.tenantId, kind: 'poster' }).url)).statusCode, 404);
    assert.equal((await get(signer.sign({ mediaId: randomUUID(), tenantId: A.tenantId, kind: 'video' }).url)).statusCode, 404);
  });

  test('the authenticated walkthrough route hands out signed links that play', async () => {
    const id = await row(A.tenantId, { output: hex('a') + '.mp4', poster: hex('b') + '.jpg' });
    const r = await call(app, { url: `/api/v1/walkthrough-media/${id}`, token: A.token });
    assert.equal(r.status, 200);
    assert.match(r.body.url, new RegExp(`^/api/v1/media/${id}/video\\?`));
    assert.match(r.body.posterUrl, new RegExp(`^/api/v1/media/${id}/poster\\?`));
    assert.ok(Date.parse(r.body.urlExpiresAt) > Date.now());
    assert.ok(!JSON.stringify(r.body).includes(hex('a')), 'no file names');
    assert.equal((await get(r.body.url, { range: 'bytes=0-1' })).statusCode, 206);
    assert.equal((await call(app, { url: `/api/v1/walkthrough-media/${id}`, token: B.token })).status, 404, 'not for another company');
  });

  test('only promotion media and hand-copied hero files are published to MEDIA_DIR/public', async () => {
    const promo = hex('c') + '.mp4', inSlides = hex('d') + '.jpg', hero = 'hero-2026-11.mp4', job = hex('a') + '.mp4';
    for (const n of [promo, inSlides, hero]) writeFileSync(join(mediaDir, n), VIDEO);
    await t.superPool.query("INSERT INTO hq_media (file_name, kind, mime_type, bytes, sha256, label) VALUES ($1, 'video', 'video/mp4', 10, $2, 'x')", [promo, 'f'.repeat(64)]);
    const { mediaSettings } = await import('../src/services/promotions.js');
    const media = mediaSettings({ media: { dir: mediaDir, maxVideoBytes: 1, maxImageBytes: 1 } });
    const slidesId = randomUUID();
    await t.superPool.query("INSERT INTO promotions (id, name, overlay, slides) VALUES ($1, 'p', '{}'::jsonb, $2::jsonb)",
      [slidesId, JSON.stringify([{ poster: `/media/${inSlides}` }, { poster: '/site/img/a.jpg' }, { poster: '/site/img/b.jpg' }])]);
    const out = await publishPromotionMedia(t.db, media);
    assert.ok(existsSync(join(mediaDir, 'public', promo)), 'an HQ upload');
    assert.ok(existsSync(join(mediaDir, 'public', hero)), 'a hand-copied hero file');
    assert.ok(existsSync(join(mediaDir, 'public', inSlides)), 'a file a promotion names');
    assert.ok(!existsSync(join(mediaDir, 'public', job)), 'job-site video never');
    assert.ok(!existsSync(join(mediaDir, 'public', hex('b') + '.jpg')), 'job-site posters never');
    assert.ok(existsSync(join(mediaDir, promo)), 'linked, not moved: the old nginx keeps working until the new one is in');
    assert.ok(out.published.includes(promo));
    assert.deepEqual((await publishPromotionMedia(t.db, media)).published, [], 'idempotent');
  });
});
