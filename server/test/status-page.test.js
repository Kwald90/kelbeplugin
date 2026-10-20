// Public status page end to end: the public JSON (shape, caching, drafts and internal fields
// never public, app role through the views only), HQ admin-only writes with audit, email
// subscriptions (off by default, double opt-in, notify only confirmed, unsubscribe) and the
// worker's probe run writing status_daily / status_latest.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, logCapture, ownerTenant, testConfig } from './support/app.js';
import { hqUser } from './support/hq.js';
import { buildApp } from '../src/app.js';
import { COMPONENT_IDS, bucketOf, createStatusHandlers } from '../src/services/status-page.js';

const PUBLIC = '/api/v1/public/status';
const STATUS_URL = 'https://status.fishtape.test/';
// The status host posts from its own origin (status.js on STATUS_PUBLIC_URL).
const FROM_STATUS = { origin: 'https://status.fishtape.test' };
const DRAFT_TITLE = 'Draft: database failover rehearsal';
const SECRET_BODY = 'Root cause: the primary ran out of disk at 03:12';
let t, app, app30, admin, staff, owner;

async function makeApp(status) {
  const config = testConfig({ STATUS_PUBLIC_URL: STATUS_URL });
  config.hq = { tlsCheck: false };
  config.status = { probes: null, hostStatusFile: '', publicUrl: STATUS_URL, ...status };
  const a = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
  await a.ready();
  return a;
}
const pub = (a = app) => call(a, { url: PUBLIC });
const hqCall = (method, url, body, who = admin) => call(app, { method, url, token: who.token, body });
const events = async (action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id IS NULL AND action = $1 ORDER BY seq', [action])).rows;
const outbox = async (template) => (await t.superPool.query('SELECT to_address, subject, text_body FROM email_outbox WHERE template = $1 ORDER BY created_at', [template])).rows;
const subscribe = (body, ip = '203.0.113.5', headers = {}) => app.inject({
  method: 'POST', url: `${PUBLIC}/subscribe`, remoteAddress: ip, headers: { 'content-type': 'application/json', 'x-fishtape': '1', ...FROM_STATUS, ...headers }, payload: JSON.stringify(body),
});
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

before(async () => {
  if (skip) return;
  t = await createTestDatabase('statuspage');
  app = await makeApp({ cacheSeconds: 0, subscribePerHour: 4 });
  app30 = await makeApp({});
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
  owner = await ownerTenant(t, app, 'Status Test Electric');
});
after(async () => { await app?.close(); await app30?.close(); await t?.close(); });

describe('public status: empty', { skip }, () => {
  test('nothing measured yet: every component unknown, 90 empty days, cached publicly with an ETag', async () => {
    const r = await pub(app30);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public, max-age=30');
    assert.ok(r.headers.etag);
    const b = r.body;
    assert.deepEqual(Object.keys(b), ['generatedAt', 'overall', 'components', 'uptime', 'notices', 'subscribe']);
    assert.equal(b.overall, 'unknown');
    assert.deepEqual(b.components.map((c) => c.id), COMPONENT_IDS);
    assert.ok(b.components.every((c) => c.status === 'unknown' && c.checkedAt === null && c.name));
    assert.equal(b.uptime.days, 90);
    for (const id of COMPONENT_IDS) {
      assert.equal(b.uptime.byComponent[id].length, 90);
      assert.equal(b.uptime.pct[id], null);
    }
    assert.equal(b.uptime.to, new Date().toISOString().slice(0, 10));
    assert.deepEqual(b.notices, { active: [], upcoming: [], recent: [] });
    assert.deepEqual(b.subscribe, { enabled: false });
    const again = await app30.inject({ method: 'GET', url: PUBLIC, headers: { 'if-none-match': r.headers.etag } });
    assert.equal(again.statusCode, 304);
  });

  test('it is not in the developer API docs', async () => {
    const spec = (await call(app, { url: '/api/v1/openapi.json' })).body;
    for (const p of Object.keys(spec.paths)) assert.ok(!p.startsWith('/api/v1/public/status'), p);
  });

  test('the app role reads notices only through the public views', async () => {
    for (const table of ['status_notices', 'status_notice_updates']) {
      await assert.rejects(t.appPool.query(`SELECT * FROM ${table}`), /permission denied/, table);
    }
    await assert.rejects(t.appPool.query("INSERT INTO status_notices (kind, title, impact, status) VALUES ('incident', 'x', 'minor', 'investigating')"), /permission denied/);
    assert.deepEqual((await t.appPool.query('SELECT * FROM status_notices_public')).rows, []);
    assert.deepEqual((await t.appPool.query('SELECT * FROM status_notice_updates_public')).rows, []);
    const { rows } = await t.appPool.query("SELECT value FROM platform_settings WHERE key = 'status'");
    assert.deepEqual(rows, [], 'readable, and no row needed');
  });
});

describe('HQ status notices: access', { skip }, () => {
  test('signed out 401, company owner 403, HQ staff read-only, HQ admin writes', async () => {
    assert.equal((await call(app, { url: '/api/hq/status-notices' })).status, 401);
    assert.equal((await call(app, { url: '/api/hq/status-notices', token: owner.token })).status, 403);
    const list = await hqCall('GET', '/api/hq/status-notices', undefined, staff);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.settings, { subscribeEnabled: false });
    assert.deepEqual(list.body.subscribers, { confirmed: 0, pending: 0 });
    assert.equal(list.body.publicUrl, STATUS_URL);
    assert.equal(list.body.components.length, 6);

    const id = '00000000-0000-4000-8000-000000000001';
    const writes = [
      ['POST', '/api/hq/status-notices', { kind: 'incident', title: 'x' }],
      ['PATCH', `/api/hq/status-notices/${id}`, { published: true }],
      ['POST', `/api/hq/status-notices/${id}/updates`, { status: 'identified', body: 'x' }],
      ['DELETE', `/api/hq/status-notices/${id}`, undefined],
      ['PUT', '/api/hq/status-settings', { subscribeEnabled: true }],
    ];
    for (const [method, url, body] of writes) {
      assert.equal((await hqCall(method, url, body, staff)).status, 403, `staff ${method} ${url}`);
      assert.equal((await call(app, { method, url, token: owner.token, body })).status, 403, `owner ${method} ${url}`);
      assert.equal((await call(app, { method, url, body })).status, 401, `anonymous ${method} ${url}`);
    }
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM status_notices')).rows[0].n, 0);
  });
});

describe('HQ status notices: lifecycle', { skip }, () => {
  let incident;

  test('validation names fields: components, status for the kind, window order, title length', async () => {
    const bad = async (body, path) => {
      const r = await hqCall('POST', '/api/hq/status-notices', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.ok(r.body.error.details.errors.some((e) => e.path.startsWith(path)), `${path}: ${JSON.stringify(r.body.error.details)}`);
    };
    await bad({ kind: 'incident', title: 'x', components: ['app', 'database'] }, '/components');
    await bad({ kind: 'incident', title: 'x', status: 'scheduled' }, '/status');
    await bad({ kind: 'incident', title: 'x', impact: 'maintenance' }, '/impact');
    await bad({ kind: 'maintenance', title: 'x', startsAt: inHours(2), endsAt: inHours(1) }, '/endsAt');
    await bad({ kind: 'incident', title: 'y'.repeat(121) }, '/title');
    await bad({ kind: 'incident', title: '\u0000\u0007' }, '/title');
    await bad({ kind: 'outage', title: 'x' }, '/kind');
  });

  test('a draft is never public; publishing shows it, without authors or the draft flag', async () => {
    const r = await hqCall('POST', '/api/hq/status-notices', { kind: 'incident', title: `  ${DRAFT_TITLE}\u0000 `, impact: 'major', components: ['api', 'app'], update: `${SECRET_BODY}\r\nMore later.` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    incident = r.body;
    assert.equal(incident.title, DRAFT_TITLE, 'control characters stripped, trimmed');
    assert.equal(incident.status, 'investigating');
    assert.equal(incident.published, false);
    assert.deepEqual(incident.components, ['app', 'api']);
    assert.equal(incident.updates[0].body, `${SECRET_BODY}\nMore later.`);

    const draft = await pub();
    assert.ok(!JSON.stringify(draft.body).includes(DRAFT_TITLE));
    assert.ok(!JSON.stringify(draft.body).includes(SECRET_BODY));
    assert.equal((await t.appPool.query('SELECT count(*)::int AS n FROM status_notice_updates_public')).rows[0].n, 0);

    const p = await hqCall('PATCH', `/api/hq/status-notices/${incident.id}`, { published: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const b = (await pub()).body;
    assert.equal(b.notices.active.length, 1);
    const n = b.notices.active[0];
    assert.equal(n.title, DRAFT_TITLE);
    assert.equal(n.impact, 'major');
    assert.deepEqual(n.updates, [{ status: 'investigating', body: `${SECRET_BODY}\nMore later.`, at: incident.updates[0].at }]);
    assert.equal(b.overall, 'outage', 'an active major incident');
    const text = JSON.stringify(b);
    for (const s of ['created_by', 'createdBy', 'updated_by', 'createdByName', 'published', 'byName', admin.userId, 'HQ hq_admin']) assert.ok(!text.includes(s), `public JSON has ${s}`);
  });

  test('posting updates moves the status; resolved sets resolvedAt and moves it to recent', async () => {
    let r = await hqCall('POST', `/api/hq/status-notices/${incident.id}/updates`, { status: 'identified', body: 'Found it.' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'identified');
    assert.equal((await hqCall('POST', `/api/hq/status-notices/${incident.id}/updates`, { status: 'completed', body: 'x' })).status, 400, 'not an incident status');
    assert.equal((await hqCall('POST', `/api/hq/status-notices/${incident.id}/updates`, { status: 'resolved', body: ' \u0000 ' })).status, 400, 'empty after cleaning');
    r = await hqCall('POST', `/api/hq/status-notices/${incident.id}/updates`, { status: 'resolved', body: 'Fixed.' });
    assert.equal(r.body.status, 'resolved');
    assert.ok(r.body.resolvedAt);
    const b = (await pub()).body;
    assert.deepEqual(b.notices.active, []);
    assert.equal(b.notices.recent[0].id, incident.id);
    assert.deepEqual(b.notices.recent[0].updates.map((u) => u.status), ['resolved', 'identified', 'investigating']);
    assert.equal(b.overall, 'unknown', 'no probes yet and nothing active');
  });

  test('maintenance: upcoming until its window starts, then active and overall maintenance', async () => {
    const later = await hqCall('POST', '/api/hq/status-notices', { kind: 'maintenance', title: 'Database upgrade', components: ['api'], startsAt: inHours(24), endsAt: inHours(25), published: true });
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal(later.body.impact, 'maintenance');
    assert.equal(later.body.status, 'scheduled');
    const now = await hqCall('POST', '/api/hq/status-notices', { kind: 'maintenance', title: 'Email provider switch', components: ['email'], startsAt: inHours(-0.5), endsAt: inHours(1), published: true });
    let b = (await pub()).body;
    assert.deepEqual(b.notices.upcoming.map((n) => n.id), [later.body.id]);
    assert.deepEqual(b.notices.active.map((n) => n.id), [now.body.id]);
    assert.equal(b.overall, 'maintenance');
    const done = await hqCall('PATCH', `/api/hq/status-notices/${now.body.id}`, { status: 'completed' });
    assert.ok(done.body.resolvedAt);
    b = (await pub()).body;
    assert.deepEqual(b.notices.active, []);
    assert.equal((await hqCall('PATCH', `/api/hq/status-notices/${later.body.id}`, { status: 'resolved' })).status, 400);
    assert.equal((await hqCall('PATCH', `/api/hq/status-notices/${later.body.id}`, { endsAt: inHours(23) })).status, 400, 'ends before it starts');
  });

  test('unpublish hides it again; delete removes it', async () => {
    assert.equal((await hqCall('PATCH', `/api/hq/status-notices/${incident.id}`, { published: false })).status, 200);
    assert.ok(!JSON.stringify((await pub()).body).includes(incident.id));
    assert.equal((await hqCall('DELETE', `/api/hq/status-notices/${incident.id}`)).status, 204);
    assert.equal((await hqCall('DELETE', `/api/hq/status-notices/${incident.id}`)).status, 404);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM status_notice_updates WHERE notice_id = $1', [incident.id])).rows[0].n, 0);
  });

  test('every write was audited on the platform chain, without the free text', async () => {
    assert.equal((await events('hq.status_notice_create')).length, 3);
    assert.equal((await events('hq.status_notice_update')).length, 3, 'publish, complete, unpublish (refused edits are not audited)');
    assert.equal((await events('hq.status_notice_post')).length, 2);
    assert.equal((await events('hq.status_notice_delete')).length, 1);
    const all = (await t.superPool.query("SELECT summary, meta::text AS meta, actor_id FROM audit_events WHERE action LIKE 'hq.status_%'")).rows;
    for (const e of all) {
      assert.equal(e.actor_id, admin.userId);
      for (const s of [SECRET_BODY, 'Found it', 'Fixed.']) assert.ok(!`${e.summary} ${e.meta}`.includes(s), `audit has "${s}"`);
    }
  });
});

describe('email subscriptions', { skip }, () => {
  let confirmToken;

  test('off by default: 404 subscriptions_off', async () => {
    const r = await subscribe({ email: 'Pat@Example.test' });
    assert.equal(r.statusCode, 404);
    assert.equal(JSON.parse(r.body).error.code, 'subscriptions_off');
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM status_subscribers')).rows[0].n, 0);
  });

  test('HQ admin turns them on (audited); the public JSON says so', async () => {
    const r = await hqCall('PUT', '/api/hq/status-settings', { subscribeEnabled: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { subscribeEnabled: true });
    assert.equal((await events('hq.status_settings')).length, 1);
    assert.deepEqual((await pub()).body.subscribe, { enabled: true });
  });

  test('subscribe: always 202, a pending row and a confirm email with the token in the fragment', async () => {
    const r = await subscribe({ email: 'Pat@Example.test' });
    assert.equal(r.statusCode, 202, r.body);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    const row = (await t.superPool.query('SELECT * FROM status_subscribers')).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].email, 'pat@example.test');
    assert.equal(row[0].confirmed_at, null);
    const mail = await outbox('status-confirm');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to_address, 'pat@example.test');
    const m = /(\S+)#confirm=([A-Za-z0-9_-]+)/.exec(mail[0].text_body);
    assert.ok(m, mail[0].text_body);
    assert.equal(m[1], STATUS_URL);
    assert.ok(!mail[0].text_body.includes('?'), 'no query string');
    confirmToken = m[2];
    assert.notEqual(row[0].confirm_token_hash, confirmToken, 'only the hash is stored');
    // Asking again at once: the same answer, no second email.
    assert.equal((await subscribe({ email: 'pat@example.test' }, '203.0.113.6')).statusCode, 202);
    assert.equal((await outbox('status-confirm')).length, 1);
  });

  test('honeypot, bad email, CSRF and the per-IP limit', async () => {
    assert.equal((await subscribe({ email: 'bot@example.test', website: 'x' }, '203.0.113.7')).statusCode, 202);
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM status_subscribers WHERE email = 'bot@example.test'")).rows[0].n, 0);
    const bad = await subscribe({ email: 'not-an-email' }, '203.0.113.7');
    assert.equal(bad.statusCode, 400);
    assert.ok(!bad.body.includes('not-an-email'));
    const noCsrf = await app.inject({ method: 'POST', url: `${PUBLIC}/subscribe`, remoteAddress: '203.0.113.8', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'x@example.test' }) });
    assert.equal(noCsrf.statusCode, 403);
    const otherSite = await subscribe({ email: 'x@example.test' }, '203.0.113.8', { origin: 'https://evil.example' });
    assert.equal(otherSite.statusCode, 403);
    assert.equal(JSON.parse(otherSite.body).error.code, 'csrf_failed');
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await subscribe({ email: `flood${i}@example.test` }, '198.51.100.9')).statusCode);
    assert.deepEqual(codes, [202, 202, 202, 202, 429, 429]);
  });

  test('confirm: 200 once, then invalid_token; junk tokens 400', async () => {
    assert.equal((await call(app, { method: 'POST', url: `${PUBLIC}/confirm`, body: { token: confirmToken }, headers: FROM_STATUS })).status, 200);
    const again = await call(app, { method: 'POST', url: `${PUBLIC}/confirm`, body: { token: confirmToken }, headers: FROM_STATUS });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'invalid_token');
    assert.equal((await call(app, { method: 'POST', url: `${PUBLIC}/confirm`, body: { token: 'nope' } })).body.error.code, 'invalid_token');
    const list = await hqCall('GET', '/api/hq/status-notices', undefined, staff);
    assert.equal(list.body.subscribers.confirmed, 1);
    assert.ok(list.body.subscribers.pending >= 4);
  });

  test('notify emails confirmed subscribers only, with who sent it and a one-click unsubscribe', async () => {
    const n = await hqCall('POST', '/api/hq/status-notices', { kind: 'incident', title: 'Email is delayed', impact: 'minor', components: ['email'], published: true, notify: true, update: 'Messages are queued.' });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    assert.deepEqual(n.body.notified, { sent: 1 });
    let mail = await outbox('status-notice');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to_address, 'pat@example.test');
    assert.match(mail[0].subject, /Email is delayed \(Investigating\)/);
    assert.match(mail[0].text_body, /Messages are queued\./);
    assert.match(mail[0].text_body, /because you subscribed/);
    const m = /#unsubscribe=([A-Za-z0-9_-]+)/.exec(mail[0].text_body);
    assert.ok(m);

    const u = await hqCall('POST', `/api/hq/status-notices/${n.body.id}/updates`, { status: 'resolved', body: 'All caught up.', notify: true });
    assert.deepEqual(u.body.notified, { sent: 1 });
    const quiet = await hqCall('POST', `/api/hq/status-notices/${n.body.id}/updates`, { status: 'resolved', body: 'Postmortem soon.' });
    assert.equal(quiet.body.notified, null);
    mail = await outbox('status-notice');
    assert.equal(mail.length, 2);
    assert.ok(!(await events('hq.status_notice_post')).some((e) => /caught up/.test(`${e.summary}${JSON.stringify(e.meta)}`)));

    // A draft never emails anyone.
    const d = await hqCall('POST', '/api/hq/status-notices', { kind: 'incident', title: 'Quiet draft', notify: true });
    assert.equal(d.body.notified, null);
    assert.equal((await outbox('status-notice')).length, 2);

    // Unsubscribe (from the emailed link on the status host): always 200, and the row is gone.
    assert.equal((await call(app, { method: 'POST', url: `${PUBLIC}/unsubscribe`, body: { token: m[1] }, headers: FROM_STATUS })).status, 200);
    assert.equal((await call(app, { method: 'POST', url: `${PUBLIC}/unsubscribe`, body: { token: m[1] } })).status, 200);
    assert.equal((await call(app, { method: 'POST', url: `${PUBLIC}/unsubscribe`, body: { token: 'x'.repeat(43) } })).status, 200);
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM status_subscribers WHERE email = 'pat@example.test'")).rows[0].n, 0);
    const after = await hqCall('POST', `/api/hq/status-notices/${n.body.id}/updates`, { status: 'resolved', body: 'Done.', notify: true });
    assert.deepEqual(after.body.notified, { sent: 0 });
  });

  test('turned off again: subscribe is 404 and notify sends nothing', async () => {
    assert.equal((await hqCall('PUT', '/api/hq/status-settings', { subscribeEnabled: false })).status, 200);
    assert.equal((await subscribe({ email: 'late@example.test' }, '203.0.113.99')).statusCode, 404);
    const n = await hqCall('POST', '/api/hq/status-notices', { kind: 'incident', title: 'Off', published: true, notify: true });
    assert.deepEqual(n.body.notified, { sent: 0, skipped: 'subscriptions_off' });
    assert.equal((await hqCall('DELETE', `/api/hq/status-notices/${n.body.id}`)).status, 204);
  });
});

describe('worker probe run', { skip }, () => {
  const config = { publicOrigin: 'https://app.fishtape.test', status: { probes: { app: 'https://app.fishtape.test/', api: 'https://app.fishtape.test/api/readyz', hq: 'https://hq.fishtape.test/api/healthz', signin: 'https://app.fishtape.test/api/v1/auth/providers' }, hostStatusFile: '' } };
  const run = async (codes, { hostStatus = null, stripe = { accounts: { retrieve: async () => ({ id: 'acct_test' }) } }, now = new Date() } = {}) => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      const code = codes[url];
      if (code === 'throw') throw new TypeError('fetch failed');
      return { status: code ?? 200 };
    };
    const h = createStatusHandlers({ config, env: {}, fetchImpl, stripe, emailConfigured: true, hostStatus, now: () => now });
    const result = await h.status_probe({ db: t.db, job: { payload: { bucket: bucketOf(now) } } });
    return { result, seen };
  };
  const daily = async () => Object.fromEntries((await t.superPool.query("SELECT component, checks, outages, degraded FROM status_daily WHERE day = (now() AT TIME ZONE 'UTC')::date")).rows.map((r) => [r.component, r]));
  const latest = async () => Object.fromEntries((await t.superPool.query('SELECT * FROM status_latest')).rows.map((r) => [r.component, r]));

  test('one run measures every component and records it; the host probes count too', async () => {
    await t.superPool.query("INSERT INTO status_daily (day, component, checks) VALUES ((now() AT TIME ZONE 'UTC')::date - 121, 'api', 288), ((now() AT TIME ZONE 'UTC')::date - 119, 'api', 288)");
    const { result, seen } = await run(
      { 'https://app.fishtape.test/api/readyz': 503, 'https://hq.fishtape.test/api/healthz': 'throw' },
      { hostStatus: { generatedAt: new Date().toISOString(), probes: { app: 0, api: 503, hq: 0 } } });
    assert.equal(seen.length, 4);
    assert.deepEqual(result, { app: 'outage', api: 'degraded', hq: 'outage', signin: 'operational', email: 'operational', payments: 'operational' });
    const d = await daily();
    assert.deepEqual(d.app, { component: 'app', checks: 1, outages: 1, degraded: 0 });
    assert.deepEqual(d.api, { component: 'api', checks: 1, outages: 0, degraded: 1 });
    assert.deepEqual(d.signin, { component: 'signin', checks: 1, outages: 0, degraded: 0 });
    assert.equal(Object.keys(d).length, 6);
    const old = (await t.superPool.query("SELECT ((now() AT TIME ZONE 'UTC')::date - day) AS age FROM status_daily WHERE component = 'api' AND day < (now() AT TIME ZONE 'UTC')::date ORDER BY day")).rows;
    assert.deepEqual(old.map((r) => r.age), [119], 'rows older than 120 days are deleted');
    const next = (await t.superPool.query("SELECT dedupe_key FROM jobs_queue WHERE kind = 'status_probe' AND status = 'queued'")).rows;
    assert.equal(next.length, 1);
  });

  test('a second run adds a check; changed_at moves only when the status changes', async () => {
    const before = await latest();
    await new Promise((r) => setTimeout(r, 20));
    await run({}, { stripe: null });
    const d = await daily();
    assert.deepEqual(d.app, { component: 'app', checks: 2, outages: 1, degraded: 0 });
    assert.equal(d.payments.checks, 1, 'unknown is not counted');
    const l = await latest();
    assert.equal(l.payments.status, 'unknown');
    assert.equal(l.signin.changed_at.getTime(), before.signin.changed_at.getTime());
    assert.ok(l.signin.checked_at > before.signin.checked_at);
    assert.ok(l.app.changed_at > before.app.changed_at);
    assert.equal(l.app.status, 'operational');
  });

  test('the public page shows it: statuses, uptime, and stale rows turn unknown', async () => {
    let b = (await pub()).body;
    const by = Object.fromEntries(b.components.map((c) => [c.id, c.status]));
    assert.deepEqual(by, { app: 'operational', api: 'operational', hq: 'operational', signin: 'operational', email: 'operational', payments: 'unknown' });
    assert.equal(b.overall, 'operational');
    assert.equal(b.uptime.byComponent.app.at(-1).checks, 2);
    assert.equal(b.uptime.byComponent.app.at(-1).pct, 50);
    assert.equal(b.uptime.pct.signin, 100);
    assert.equal(b.uptime.byComponent.api.filter((x) => x.checks).length, 1, 'the 119-day-old row is outside the 90 days');
    await t.superPool.query("UPDATE status_latest SET checked_at = now() - interval '25 minutes' WHERE component = 'api'");
    b = (await pub()).body;
    assert.equal(b.components.find((c) => c.id === 'api').status, 'unknown');
  });
});
