// Landing-page promotions and HQ media: public endpoint (default, active window, audience, no
// internal fields, caching), HQ admin-only CRUD with validation and audit, and uploads checked
// by magic bytes with size caps and no path traversal.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skip, createTestDatabase } from './support/db.js';
import { call, logCapture, ownerTenant, testConfig } from './support/app.js';
import { hqUser } from './support/hq.js';
import { buildApp } from '../src/app.js';

let t, app, admin, staff, owner, mediaDir;
const PUBLIC = '/api/v1/public/promotions/active';
const SECRET_NAME = 'Internal codename Falcon';
const SECRET_NOTE = 'Only for HQ eyes: discount approved by Kelvin';

const mp4 = (n = 2048) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(n, 1)]);
const jpeg = (n = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 2)]);
const png = (n = 2048) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 3)]);
const webp = (n = 2048) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(n, 4)]);
const ebml = (doc, n = 2048) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | doc.length]), Buffer.from(doc), Buffer.alloc(n, 5)]);

const upload = (body, type, { token = admin.token, headers = {} } = {}) => app.inject({
  method: 'POST', url: '/api/hq/media', payload: body,
  headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});
const json = (r) => (r.body ? JSON.parse(r.body) : null);

function promo(over = {}) {
  return {
    name: 'Spring push', status: 'active', priority: 0,
    overlay: { eyebrow: 'Spring rush is coming', headline: 'Win more jobs with faster quotes', subline: 'Draw the plan, count the boxes, send the estimate.', primaryCta: { label: 'Start free trial', href: '/site/signup.html?plan=pro' }, secondaryCta: null, note: '$1 to start.' },
    slides: [
      { videoDesktop: '/media/0123456789abcdef0123456789abcdef.mp4', videoMobile: '/media/0123456789abcdef0123456789abcde0.mp4', poster: '/media/0123456789abcdef0123456789abcdef.jpg' },
      { poster: '/site/img/hero/default-2.svg', overlay: { headline: 'Bend it right the first time' } },
      { poster: '/site/img/hero/default-3.svg' },
    ],
    notes: SECRET_NOTE,
    ...over,
  };
}
const create = async (body) => {
  const r = await call(app, { method: 'POST', url: '/api/hq/promotions', token: admin.token, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const active = async (qs = '') => call(app, { url: PUBLIC + qs });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('promotions');
  mediaDir = mkdtempSync(join(tmpdir(), 'fishtape-media-'));
  const config = testConfig();
  config.hq = { tlsCheck: false };
  config.media = { dir: mediaDir, maxVideoBytes: 200_000, maxImageBytes: 50_000 };
  config.promotions = { cacheSeconds: 30, mediaOrigins: ['https://cdn.fishtape.test'] };
  app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
  await app.ready();
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
  owner = await ownerTenant(t, app, 'Promo Test Electric');
});
after(async () => {
  await app?.close(); await t?.close();
  if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
});

describe('public promotion', { skip }, () => {
  test('with nothing in the database the built-in default is served (poster-only, 14-day trial, $1 note)', async () => {
    const r = await active();
    assert.equal(r.status, 200);
    const p = r.body.promotion;
    assert.equal(p.id, 'default');
    assert.equal(p.overlay.headline, 'Built for Canadian electricians');
    assert.match(p.overlay.primaryCta.label, /14-day free trial/);
    assert.match(p.overlay.primaryCta.href, /^\/site\/signup\.html\?plan=/);
    assert.match(p.overlay.note, /\$1 deposit, credited to your first month/);
    assert.equal(p.slides.length, 3);
    for (const s of p.slides) { assert.ok(s.poster); assert.equal(s.videoDesktop, undefined); }
    assert.match(r.headers['cache-control'], /^public, max-age=\d+$/);
    assert.ok(r.headers.etag);
    const again = await app.inject({ method: 'GET', url: PUBLIC, headers: { 'if-none-match': r.headers.etag } });
    assert.equal(again.statusCode, 304);
  });

  test('it is not in the developer API docs', async () => {
    const spec = (await call(app, { url: '/api/v1/openapi.json' })).body;
    assert.equal(spec.paths[PUBLIC], undefined);
  });
});

describe('HQ promotions: access', { skip }, () => {
  test('signed out 401; HQ staff, company owners and API callers without HQ admin 403', async () => {
    assert.equal((await call(app, { url: '/api/hq/promotions' })).status, 401);
    assert.equal((await call(app, { url: '/api/hq/promotions', token: staff.token })).status, 403);
    assert.equal((await call(app, { url: '/api/hq/promotions', token: owner.token })).status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/hq/promotions', token: staff.token, body: promo() })).status, 403);
    assert.equal((await upload(jpeg(), 'image/jpeg', { token: staff.token })).statusCode, 403);
    assert.equal((await upload(jpeg(), 'image/jpeg', { token: null, headers: { 'x-fishtape': '1' } })).statusCode, 401);
    const list = await call(app, { url: '/api/hq/promotions', token: admin.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.defaultPromotion.id, 'default');
    assert.equal(list.body.uploads.enabled, true);
  });

  test('cookie sessions need the CSRF header on writes', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/hq/promotions', headers: { cookie: 'ft_session=whatever', 'content-type': 'application/json' }, payload: JSON.stringify(promo()) });
    assert.equal(r.statusCode, 403);
    assert.equal(json(r).error.code, 'csrf_failed');
  });
});

describe('HQ promotions: validation', { skip }, () => {
  const bad = async (body, path) => {
    const r = await call(app, { method: 'POST', url: '/api/hq/promotions', token: admin.token, body });
    assert.equal(r.status, 400, `${path}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'validation_failed');
    if (path) assert.ok(r.body.error.details.errors.some((e) => e.path.startsWith(path)), `${path} in ${JSON.stringify(r.body.error.details)}`);
    return r;
  };

  test('URLs must be same-origin /media/ or /site/img/, or an allow-listed https origin', async () => {
    const slide = (s) => promo({ slides: [s, { poster: '/site/img/hero/default-2.svg' }, { poster: '/site/img/hero/default-3.svg' }] });
    await bad(slide({ videoDesktop: 'https://evil.example/clip.mp4' }), '/slides/0/videoDesktop');
    await bad(slide({ videoDesktop: '/media/../server/.env' }), '/slides/0/videoDesktop');
    await bad(slide({ videoDesktop: '/media/%2e%2e/secret.mp4' }), '/slides/0/videoDesktop');
    await bad(slide({ poster: '/site/img/../../server/.env' }), '/slides/0/poster');
    await bad(slide({ poster: '/media/abc.svg' }), '/slides/0/poster');
    await bad(slide({ videoDesktop: '/media/clip.exe' }), '/slides/0/videoDesktop');
    await bad(slide({ webmDesktop: '/media/clip.mp4' }), '/slides/0/webmDesktop');
    await bad(slide({ videoDesktop: '//evil.example/x.mp4' }), '/slides/0/videoDesktop');
    await bad(slide({ videoDesktop: 'https://cdn.fishtape.test/x.mp4?token=1' }), '/slides/0/videoDesktop');
    const ok = await call(app, { method: 'POST', url: '/api/hq/promotions', token: admin.token, body: { ...slide({ videoDesktop: 'https://cdn.fishtape.test/hero/clip-1.mp4', poster: '/media/0123456789abcdef0123456789abcdef.webp' }), status: 'draft' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  test('button links: paths, anchors, mailto and allowed https only', async () => {
    const withHref = (href) => promo({ overlay: { ...promo().overlay, primaryCta: { label: 'Go', href } } });
    for (const href of ['javascript:alert(1)', 'data:text/html,hi', '//evil.example', 'https://evil.example/', 'http://localhost/x', '/site/../server/.env']) {
      const r = await bad(withHref(href), '/overlay/primaryCta/href');
      assert.ok(!JSON.stringify(r.body).includes(href), 'the value is not echoed');
    }
  });

  test('shape: 3 to 5 slides, headline and CTA required, window order, timing, audience format, unknown fields', async () => {
    await bad(promo({ slides: promo().slides.slice(0, 2) }), '/slides');
    await bad(promo({ slides: [...promo().slides, ...promo().slides] }), '/slides');
    await bad(promo({ overlay: { headline: 'x' } }), '/overlay');
    await bad(promo({ startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' }), '/endsAt');
    await bad(promo({ settings: { transitionMs: 1500, handoverAtMs: 1000 } }), '/settings/handoverAtMs');
    await bad(promo({ audience: 'Province is Ontario' }), '/audience');
    await bad({ ...promo(), secretField: 1 });
    await bad(promo({ slides: [{}, ...promo().slides.slice(1)] }), '/slides/0');
  });
});

describe('HQ promotions: lifecycle and the active window', { skip }, () => {
  const ids = {};
  test('create, then the public endpoint serves the highest-priority live one', async () => {
    // Clear what earlier tests made.
    await t.superPool.query('DELETE FROM promotions');
    ids.a = (await create(promo({ name: SECRET_NAME }))).id;
    ids.future = (await create(promo({ name: 'Future', priority: 5, startsAt: new Date(Date.now() + 86_400_000).toISOString(), overlay: { ...promo().overlay, headline: 'Not yet' } }))).id;
    ids.ended = (await create(promo({ name: 'Ended', priority: 50, startsAt: '2025-01-01T00:00:00Z', endsAt: '2025-02-01T00:00:00Z', overlay: { ...promo().overlay, headline: 'Too late' } }))).id;
    ids.draft = (await create(promo({ name: 'Draft', status: 'draft', priority: 100, overlay: { ...promo().overlay, headline: 'Draft text' } }))).id;
    ids.on = (await create(promo({ name: 'Ontario', priority: 10, audience: 'province=ON', overlay: { ...promo().overlay, headline: 'Hello Ontario' } }))).id;
    const r = await active();
    assert.equal(r.body.promotion.id, ids.a);
    assert.equal(r.body.promotion.overlay.headline, 'Win more jobs with faster quotes');
    const list = await call(app, { url: '/api/hq/promotions', token: admin.token });
    const by = Object.fromEntries(list.body.data.map((p) => [p.id, p]));
    assert.equal(by[ids.a].state, 'live');
    assert.equal(by[ids.future].state, 'scheduled');
    assert.equal(by[ids.ended].state, 'ended');
    assert.equal(by[ids.draft].state, 'draft');
    assert.equal(list.body.servingId, ids.a);
  });

  test('audience tags pick a targeted promotion only for matching visitors', async () => {
    assert.equal((await active('?audience=province%3DON')).body.promotion.id, ids.on);
    assert.equal((await active('?audience=province=ON,campaign=x')).body.promotion.id, ids.on);
    assert.equal((await active('?audience=province=BC')).body.promotion.id, ids.a);
    assert.equal((await active('?audience=%3Cscript%3E')).body.promotion.id, ids.a);
  });

  test('the public view has no internal fields', async () => {
    const r = await active();
    assert.deepEqual(Object.keys(r.body.promotion).sort(), ['id', 'overlay', 'settings', 'slides']);
    const text = r.raw.body;
    for (const s of [SECRET_NAME, SECRET_NOTE, admin.userId, 'province=ON']) assert.ok(!text.includes(s), `public body contains ${s}`);
    for (const k of ['notes', 'name', 'status', 'priority', 'audience', 'startsAt', 'starts_at', 'createdBy', 'created_by', 'updatedBy', 'version']) {
      assert.ok(!text.includes(`"${k}"`), `public body has the field ${k}`);
    }
    for (const s of r.body.promotion.slides) for (const k of Object.keys(s)) assert.ok(['videoDesktop', 'videoMobile', 'webmDesktop', 'webmMobile', 'poster', 'posterMobile', 'overlay'].includes(k), k);
  });

  test('editing the schedule changes what is served immediately (same process) and bumps the version', async () => {
    const cur = (await call(app, { url: `/api/hq/promotions/${ids.future}`, token: admin.token })).body;
    const body = { ...promo({ name: 'Future', priority: 5, overlay: { ...promo().overlay, headline: 'Now live' } }), startsAt: new Date(Date.now() - 60_000).toISOString(), version: cur.version };
    const r = await call(app, { method: 'PUT', url: `/api/hq/promotions/${ids.future}`, token: admin.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, cur.version + 1);
    assert.equal((await active()).body.promotion.overlay.headline, 'Now live');
    const stale = await call(app, { method: 'PUT', url: `/api/hq/promotions/${ids.future}`, token: admin.token, body });
    assert.equal(stale.status, 409);
  });

  test('deactivate, duplicate as draft, delete; each write is audited without the copy text', async () => {
    const off = await call(app, { method: 'POST', url: `/api/hq/promotions/${ids.future}/status`, token: admin.token, body: { status: 'inactive' } });
    assert.equal(off.body.state, 'inactive');
    assert.equal((await active()).body.promotion.id, ids.a);
    const dup = await call(app, { method: 'POST', url: `/api/hq/promotions/${ids.a}/duplicate`, token: admin.token });
    assert.equal(dup.status, 201);
    assert.equal(dup.body.status, 'draft');
    assert.equal(dup.body.name, `Copy of ${SECRET_NAME}`);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/hq/promotions/${dup.body.id}`, token: admin.token })).status, 204);
    assert.equal((await call(app, { url: `/api/hq/promotions/${dup.body.id}`, token: admin.token })).status, 404);
    const ev = (await t.superPool.query("SELECT action, summary, actor_type, tenant_id FROM audit_events WHERE action LIKE 'hq.promotion_%' ORDER BY seq")).rows;
    for (const a of ['hq.promotion_create', 'hq.promotion_update', 'hq.promotion_status', 'hq.promotion_duplicate', 'hq.promotion_delete']) assert.ok(ev.some((e) => e.action === a), a);
    for (const e of ev) { assert.equal(e.actor_type, 'hq'); assert.equal(e.tenant_id, null); assert.ok(!e.summary.includes(SECRET_NAME)); }
  });

  test('with every promotion inactive the default comes back', async () => {
    await t.superPool.query("UPDATE promotions SET status = 'inactive'");
    // The public list is cached; an HQ write in this process clears it.
    await call(app, { method: 'POST', url: `/api/hq/promotions/${ids.a}/status`, token: admin.token, body: { status: 'inactive' } });
    assert.equal((await active()).body.promotion.id, 'default');
  });
});

describe('HQ media uploads', { skip }, () => {
  const files = () => readdirSync(mediaDir);

  test('accepted by magic bytes: MP4, WebM, JPG, PNG, WebP (random names, listed, audited)', async () => {
    const cases = [[mp4(), 'video/mp4', 'mp4'], [ebml('webm'), 'video/webm', 'webm'], [jpeg(), 'image/jpeg', 'jpg'], [png(), 'image/png', 'png'], [webp(), 'image/webp', 'webp'], [jpeg(), 'application/octet-stream', 'jpg']];
    for (const [buf, type, ext] of cases) {
      const r = await upload(buf, type, { headers: { 'x-media-label': encodeURIComponent('Spring clip <1>.mov') } });
      assert.equal(r.statusCode, 201, `${type}: ${r.body}`);
      const m = json(r);
      assert.match(m.name, new RegExp(`^[a-f0-9]{32}\\.${ext}$`));
      assert.equal(m.url, `/media/${m.name}`);
      assert.equal(m.bytes, buf.length);
      assert.equal(m.label, 'Spring clip 1.mov');
      const st = statSync(join(mediaDir, m.name));
      assert.equal(st.size, buf.length);
      if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o644);
    }
    const list = await call(app, { url: '/api/hq/media', token: admin.token });
    assert.equal(list.body.data.length, cases.length);
    const ev = (await t.superPool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'hq.media_upload'")).rows[0].n;
    assert.equal(ev, cases.length);
  });

  test('refused by magic bytes whatever the name or type says (415), nothing left behind', async () => {
    const before = files().length;
    const refuse = [
      [Buffer.from('<!doctype html><script>alert(1)</script>'.padEnd(200, ' ')), 'video/mp4'],
      [png(), 'video/mp4'],                       // real PNG, wrong declared type
      [mp4(), 'image/jpeg'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'), 'image/svg+xml'],
      [Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500)]), 'application/octet-stream'],
      [Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(500)]), 'video/mp4'],   // QuickTime
      [Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(500)]), 'application/octet-stream'], // AVIF image
      [ebml('matroska'), 'video/webm'],
      [Buffer.from('tiny'), 'image/png'],
      [Buffer.alloc(0), 'image/png'],
      [jpeg(), 'text/html'],
    ];
    for (const [buf, type] of refuse) {
      const r = await upload(buf, type);
      assert.equal(r.statusCode, 415, `${type} ${buf.subarray(0, 12).toString('latin1')}: ${r.body}`);
      // Types this route never accepts are refused by Fastify itself (unsupported_media_type).
      assert.ok(['unsupported_media', 'unsupported_media_type'].includes(json(r).error.code), json(r).error.code);
    }
    assert.equal(files().length, before);
    assert.ok(!files().some((f) => f.endsWith('.part')));
  });

  test('size caps: by Content-Length up front, and while streaming for the sniffed kind (413)', async () => {
    const before = files().length;
    const big = await upload(mp4(250_000), 'video/mp4');
    assert.equal(big.statusCode, 413);
    assert.equal(json(big).error.code, 'too_large');
    // Declared as octet-stream (video cap 200 KB) but the bytes are a JPEG over the 50 KB image cap.
    const img = await upload(jpeg(80_000), 'application/octet-stream');
    assert.equal(img.statusCode, 413);
    assert.equal(files().length, before);
    assert.ok(!files().some((f) => f.endsWith('.part')));
    const fits = await upload(mp4(150_000), 'video/mp4');
    assert.equal(fits.statusCode, 201);
  });

  test('delete refuses traversal and unknown names; files in use are kept', async () => {
    for (const name of ['..%2F..%2Fserver%2F.env', '..%5C..%5Cserver%5C.env', '0123456789abcdef0123456789abcdef.mp4%00.txt', 'x.mp4', '0123456789ABCDEF0123456789abcdef.mp4']) {
      const r = await call(app, { method: 'DELETE', url: `/api/hq/media/${name}`, token: admin.token });
      assert.ok([400, 404].includes(r.status), `${name}: ${r.status}`);
    }
    assert.equal((await call(app, { method: 'DELETE', url: '/api/hq/media/0123456789abcdef0123456789abcdef.mp4', token: admin.token })).status, 404);
    const list = (await call(app, { url: '/api/hq/media', token: admin.token })).body.data;
    const vid = list.find((m) => m.kind === 'video' && m.name.endsWith('.mp4'));
    const used = await create(promo({ status: 'draft', slides: [{ videoDesktop: vid.url }, ...promo().slides.slice(1)] }));
    assert.equal((await call(app, { method: 'DELETE', url: `/api/hq/media/${vid.name}`, token: admin.token })).status, 409);
    await call(app, { method: 'DELETE', url: `/api/hq/promotions/${used.id}`, token: admin.token });
    assert.equal((await call(app, { method: 'DELETE', url: `/api/hq/media/${vid.name}`, token: admin.token })).status, 204);
    assert.ok(!existsSync(join(mediaDir, vid.name)));
  });

  test('uploads are off (503) without MEDIA_DIR, or with one inside the code checkout', async () => {
    for (const dir of ['', join(process.cwd(), 'media-in-checkout')]) {
      const config = testConfig();
      config.hq = { tlsCheck: false };
      config.media = { dir };
      const other = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
      await other.ready();
      const r = await other.inject({ method: 'POST', url: '/api/hq/media', payload: jpeg(), headers: { 'content-type': 'image/jpeg', authorization: `Bearer ${admin.token}` } });
      assert.equal(r.statusCode, 503);
      assert.equal(json(r).error.code, 'media_unavailable');
      await other.close();
    }
    assert.ok(!existsSync(join(process.cwd(), 'media-in-checkout')));
  });
});
