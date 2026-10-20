// Public status page, pure pieces: probe classification, merging the host's probes, the
// 90-day uptime maths, the overall status rules, notice bucketing, stale data, validation,
// settings and the worker's 5-minute chain.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPONENT_IDS, bucketNotices, bucketOf, buildPublicStatus, buildUptime, classifyEmail, classifyHttp, cleanText, componentStatuses,
  createStatusHandlers, defaultProbeUrls, mergeProbes, noticeEmail, noticeProblems, overallStatus, parseProbeList, probeHttp,
  probeStripe, statusPublicUrl, statusSettings, worse,
} from '../src/services/status-page.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const config = { publicOrigin: 'https://app.example.test' };

describe('probe classification', () => {
  test('HTTP: 2xx operational, 503 and 429 degraded, everything else and no answer outage', () => {
    assert.equal(classifyHttp({ code: 200 }), 'operational');
    assert.equal(classifyHttp({ code: 204 }), 'operational');
    assert.equal(classifyHttp({ code: 503 }), 'degraded');
    assert.equal(classifyHttp({ code: 429 }), 'degraded');
    for (const code of [0, 301, 404, 500, 502, 504]) assert.equal(classifyHttp({ code }), 'outage', String(code));
    assert.equal(classifyHttp({ code: 0, error: 'timeout' }), 'outage');
    assert.equal(classifyHttp(null), 'outage');
  });

  test('email: unknown when not configured; failures and stuck mail', () => {
    assert.equal(classifyEmail({ configured: false, sent: 10 }), 'unknown');
    assert.equal(classifyEmail({ configured: true }), 'operational', 'no traffic is fine');
    assert.equal(classifyEmail({ configured: true, sent: 50, failed: 1 }), 'operational');
    assert.equal(classifyEmail({ configured: true, sent: 5, failed: 1 }), 'degraded');
    assert.equal(classifyEmail({ configured: true, sent: 50, stuck: 1 }), 'degraded');
    assert.equal(classifyEmail({ configured: true, sent: 1, failed: 3 }), 'outage');
    assert.equal(classifyEmail({ configured: true, sent: 0, failed: 2 }), 'degraded');
  });

  test('probeHttp never throws and times out', async () => {
    assert.deepEqual(await probeHttp('https://x.test/', { fetchImpl: async () => ({ status: 200 }) }), { code: 200 });
    assert.deepEqual(await probeHttp('https://x.test/', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { code: 0, error: 'unreachable' });
    const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
    const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer does not hold the event loop open
    assert.deepEqual(await probeHttp('https://x.test/', { fetchImpl: hang, timeoutMs: 20 }), { code: 0, error: 'timeout' });
    clearTimeout(keepAlive);
  });

  test('Stripe: not configured unknown, a working call operational, an error or hang outage', async () => {
    assert.equal(await probeStripe(null), 'unknown');
    assert.equal(await probeStripe({ accounts: { retrieve: async () => ({ id: 'acct_1' }) } }), 'operational');
    assert.equal(await probeStripe({ accounts: { retrieve: async () => { throw new Error('Invalid API Key'); } } }), 'outage');
    assert.equal(await probeStripe({ accounts: { retrieve: () => new Promise(() => {}) } }, 20), 'outage');
  });
});

describe('mergeProbes', () => {
  const worker = { app: 'operational', api: 'operational', hq: 'unknown', signin: 'operational', email: 'operational', payments: 'unknown' };

  test('a fresh failing host probe marks that component down for the run', () => {
    const r = mergeProbes(worker, { generatedAt: minutesAgo(10), probes: { app: 0, api: 200, hq: 200, site: 500 } }, NOW);
    assert.equal(r.app, 'outage');
    assert.equal(r.api, 'operational');
    assert.equal(r.hq, 'operational', 'unknown takes the host answer');
    assert.equal(r.email, 'operational');
    assert.equal(r.payments, 'unknown');
    assert.equal(r.site, undefined, 'not a component');
  });

  test('a host 503 on the API is degraded; a host success never hides a worker outage', () => {
    const r = mergeProbes({ ...worker, app: 'outage' }, { generatedAt: minutesAgo(1), probes: { app: 200, api: 503 } }, NOW);
    assert.equal(r.app, 'outage');
    assert.equal(r.api, 'degraded');
  });

  test('stale, future, missing or malformed host status is ignored', () => {
    for (const hs of [null, {}, { generatedAt: minutesAgo(21), probes: { app: 0 } }, { generatedAt: 'nope', probes: { app: 0 } },
      { generatedAt: new Date(NOW.getTime() + 3_600_000).toISOString(), probes: { app: 0 } }, { generatedAt: minutesAgo(1), probes: 'x' },
      { generatedAt: minutesAgo(1), probes: { app: 'abc' } }]) {
      assert.deepEqual(mergeProbes(worker, hs, NOW), worker, JSON.stringify(hs));
    }
  });

  test('worse()', () => {
    assert.equal(worse('operational', 'outage'), 'outage');
    assert.equal(worse('degraded', 'operational'), 'degraded');
    assert.equal(worse('unknown', 'operational'), 'operational');
    assert.equal(worse('outage', 'unknown'), 'outage');
    assert.equal(worse('unknown', 'unknown'), 'unknown');
  });
});

describe('uptime', () => {
  test('exactly 90 days per component, oldest first, UTC, null on days without checks', () => {
    const rows = [
      { day: '2026-10-19', component: 'api', checks: 144, outages: 1, degraded: 2 },
      { day: '2026-10-18', component: 'api', checks: 288, outages: 0, degraded: 0 },
      { day: '2026-07-21', component: 'api', checks: 288, outages: 288, degraded: 0 }, // the day before the window
      { day: '2026-07-22', component: 'app', checks: 0, outages: 0, degraded: 0 }, // day 1 of 90, no checks
    ];
    const u = buildUptime(rows, NOW);
    assert.equal(u.days, 90);
    assert.equal(u.from, '2026-07-22');
    assert.equal(u.to, '2026-10-19');
    for (const id of COMPONENT_IDS) {
      assert.equal(u.byComponent[id].length, 90, id);
      assert.equal(u.byComponent[id][0].date, u.from);
      assert.equal(u.byComponent[id].at(-1).date, u.to);
    }
    const api = u.byComponent.api;
    assert.deepEqual(api.at(-1), { date: '2026-10-19', pct: 99.3, checks: 144, outages: 1, degraded: 2 });
    assert.deepEqual(api.at(-2), { date: '2026-10-18', pct: 100, checks: 288, outages: 0, degraded: 0 });
    assert.deepEqual(api.at(-3), { date: '2026-10-17', pct: null, checks: 0, outages: 0, degraded: 0 });
    assert.equal(u.pct.api, 99.76, '(432 - 1) / 432, floored to two decimals');
    assert.equal(u.pct.app, null, 'no data');
    assert.ok(u.byComponent.app.every((d) => d.pct === null && d.checks === 0));
  });

  test('pct floors so any outage shows under 100', () => {
    const u = buildUptime([{ day: '2026-10-19', component: 'app', checks: 100000, outages: 1, degraded: 0 }], NOW);
    assert.equal(u.byComponent.app.at(-1).pct, 99.99);
  });

  test('accepts Date days too', () => {
    const u = buildUptime([{ day: new Date('2026-10-19T00:00:00Z'), component: 'hq', checks: 4, outages: 1, degraded: 0 }], NOW);
    assert.equal(u.byComponent.hq.at(-1).pct, 75);
  });
});

describe('components and overall', () => {
  test('missing or stale (over 20 minutes) rows are unknown: stale data never shows green', () => {
    const latest = [
      { component: 'app', status: 'operational', checked_at: minutesAgo(4) },
      { component: 'api', status: 'operational', checked_at: minutesAgo(21) },
      { component: 'hq', status: 'degraded', checked_at: minutesAgo(19) },
      { component: 'nope', status: 'outage', checked_at: minutesAgo(1) },
    ];
    const c = componentStatuses(latest, NOW);
    assert.deepEqual(c.map((x) => x.id), COMPONENT_IDS);
    assert.deepEqual(c.map((x) => x.status), ['operational', 'unknown', 'degraded', 'unknown', 'unknown', 'unknown']);
    assert.equal(c[1].checkedAt, minutesAgo(21));
    assert.equal(c[3].checkedAt, null);
    assert.equal(c[0].name, 'Web app');
  });

  const comps = (...s) => s.map((status, i) => ({ id: COMPONENT_IDS[i], status }));
  test('overall rules', () => {
    assert.equal(overallStatus(comps('operational', 'operational')), 'operational');
    assert.equal(overallStatus(comps('operational', 'unknown')), 'operational', 'unknown parts do not count');
    assert.equal(overallStatus(comps('unknown', 'unknown')), 'unknown');
    assert.equal(overallStatus(comps('operational', 'degraded')), 'degraded');
    assert.equal(overallStatus(comps('degraded', 'outage')), 'outage');
    assert.equal(overallStatus(comps('operational'), [{ kind: 'incident', impact: 'major' }]), 'outage');
    assert.equal(overallStatus(comps('operational'), [{ kind: 'incident', impact: 'minor' }]), 'degraded');
    assert.equal(overallStatus(comps('operational'), [{ kind: 'incident', impact: 'none' }]), 'operational');
    assert.equal(overallStatus(comps('operational'), [{ kind: 'maintenance', impact: 'maintenance', status: 'in_progress' }]), 'maintenance');
    assert.equal(overallStatus(comps('degraded'), [{ kind: 'maintenance', impact: 'major' }]), 'degraded', 'maintenance impact is not an incident');
    assert.equal(overallStatus(comps('unknown'), [{ kind: 'maintenance' }]), 'maintenance');
  });
});

describe('notices', () => {
  const n = (o) => ({ id: o.id, kind: 'incident', title: 't', impact: 'minor', components: [], status: 'investigating', created_at: daysAgo(1), updated_at: daysAgo(1), ...o });

  test('bucketing: active, upcoming, recent', () => {
    const list = [
      n({ id: 'open-incident' }),
      n({ id: 'resolved-yesterday', status: 'resolved', resolved_at: daysAgo(1) }),
      n({ id: 'resolved-long-ago', status: 'resolved', resolved_at: daysAgo(31) }),
      n({ id: 'maint-started', kind: 'maintenance', status: 'scheduled', impact: 'maintenance', starts_at: minutesAgo(5), ends_at: daysAgo(-1) }),
      n({ id: 'maint-early', kind: 'maintenance', status: 'in_progress', impact: 'maintenance', starts_at: daysAgo(-1) }),
      n({ id: 'maint-later', kind: 'maintenance', status: 'scheduled', impact: 'maintenance', starts_at: daysAgo(-2) }),
      n({ id: 'maint-sooner', kind: 'maintenance', status: 'scheduled', impact: 'maintenance', starts_at: daysAgo(-1) }),
      n({ id: 'maint-done', kind: 'maintenance', status: 'completed', impact: 'maintenance', starts_at: daysAgo(3), resolved_at: daysAgo(2) }),
    ];
    const b = bucketNotices(list, NOW);
    assert.deepEqual(b.active.map((x) => x.id).sort(), ['maint-early', 'maint-started', 'open-incident']);
    assert.deepEqual(b.upcoming.map((x) => x.id), ['maint-sooner', 'maint-later']);
    assert.deepEqual(b.recent.map((x) => x.id), ['resolved-yesterday', 'maint-done']);
  });

  test('recent is capped at 20, newest first', () => {
    const list = Array.from({ length: 25 }, (_, i) => n({ id: `r${i}`, status: 'resolved', resolved_at: minutesAgo(i) }));
    const b = bucketNotices(list, NOW);
    assert.equal(b.recent.length, 20);
    assert.equal(b.recent[0].id, 'r0');
  });

  test('the public JSON has the contract shape and no internal fields', () => {
    const notices = [n({ id: 'a', impact: 'major', created_by: 'u1', updated_by: 'u2', published: true })];
    const updates = [
      { notice_id: 'a', status: 'investigating', body: 'first', created_at: minutesAgo(30), created_by: 'u1' },
      { notice_id: 'a', status: 'identified', body: 'second', created_at: minutesAgo(10), created_by: 'u1' },
      { notice_id: 'zzz', status: 'identified', body: 'other', created_at: minutesAgo(10) },
    ];
    const latest = COMPONENT_IDS.map((component) => ({ component, status: 'operational', checked_at: minutesAgo(2) }));
    const s = buildPublicStatus({ latest, daily: [], notices, updates, subscribeEnabled: false, now: NOW });
    assert.deepEqual(Object.keys(s), ['generatedAt', 'overall', 'components', 'uptime', 'notices', 'subscribe']);
    assert.equal(s.overall, 'outage', 'an active major incident');
    assert.deepEqual(Object.keys(s.notices), ['active', 'upcoming', 'recent']);
    const a = s.notices.active[0];
    assert.deepEqual(Object.keys(a).sort(), ['components', 'createdAt', 'endsAt', 'id', 'impact', 'kind', 'resolvedAt', 'startsAt', 'status', 'title', 'updatedAt', 'updates'].sort());
    assert.deepEqual(a.updates, [{ status: 'identified', body: 'second', at: minutesAgo(10) }, { status: 'investigating', body: 'first', at: minutesAgo(30) }]);
    assert.deepEqual(s.subscribe, { enabled: false });
    assert.ok(!JSON.stringify(s).includes('u1'));
  });

  test('validation: kind, title, impact, components, status for the kind, window order', () => {
    const ok = { kind: 'incident', title: 'Slow sign-in', impact: 'minor', components: ['signin'], status: 'investigating' };
    assert.deepEqual(noticeProblems(ok), []);
    const paths = (o) => noticeProblems({ ...ok, ...o }).map((p) => p.path);
    assert.deepEqual(paths({ kind: 'outage' }), ['/kind']);
    assert.deepEqual(paths({ title: '' }), ['/title']);
    assert.deepEqual(paths({ title: 'x'.repeat(121) }), ['/title']);
    assert.deepEqual(paths({ impact: 'maintenance' }), ['/impact']);
    assert.deepEqual(paths({ components: ['app', 'db'] }), ['/components']);
    assert.deepEqual(paths({ status: 'scheduled' }), ['/status']);
    assert.deepEqual(paths({ kind: 'maintenance', impact: 'maintenance', status: 'investigating' }), ['/status']);
    assert.deepEqual(paths({ kind: 'maintenance', impact: 'maintenance', status: 'scheduled', startsAt: daysAgo(-1), endsAt: daysAgo(-1) }), ['/endsAt']);
    assert.deepEqual(paths({ kind: 'maintenance', impact: 'maintenance', status: 'in_progress', startsAt: daysAgo(-1), endsAt: daysAgo(-2) }), []);
  });

  test('cleanText: plain text, control and bidi characters gone, newlines kept only in bodies', () => {
    const rlo = String.fromCharCode(0x202e);
    assert.equal(cleanText(`  Sign-in\u0000 slow\r\nnow${rlo} `), 'Sign-in slow now');
    assert.equal(cleanText(`Line one\r\nLine two\u0007\tend${rlo}`, { multiline: true }), 'Line one\nLine two\tend');
    assert.equal(cleanText('<b>bold</b>'), '<b>bold</b>', 'markup is kept as text; the page uses textContent');
  });

  test('notice email: who sent it, why, and a one-click unsubscribe in the fragment', () => {
    const m = noticeEmail({
      brand: 'Fishtape', publicUrl: 'https://status.example.test/', supportEmail: 'support@example.test',
      notice: { kind: 'incident', title: 'Email delayed', status: 'identified', components: ['email'] },
      update: { status: 'identified', body: 'A provider issue.' }, to: 'a@example.test', unsubscribeToken: 'tok_abc',
    });
    assert.match(m.subject, /Email delayed \(Identified\)/);
    assert.match(m.text, /Affects: Email/);
    assert.match(m.text, /A provider issue\./);
    assert.match(m.text, /because you subscribed/);
    assert.match(m.text, /Sent by Fishtape \(support@example\.test\)/);
    assert.match(m.text, /https:\/\/status\.example\.test\/#unsubscribe=tok_abc/);
    assert.ok(!m.text.includes('?'), 'no query strings');
  });
});

describe('settings', () => {
  test('default probe URLs from PUBLIC_ORIGIN and HQ_PUBLIC_URL', () => {
    assert.deepEqual(defaultProbeUrls(config, {}), {
      app: 'https://app.example.test/', api: 'https://app.example.test/api/readyz', hq: 'https://app.example.test/api/healthz', signin: 'https://app.example.test/api/v1/auth/providers',
    });
    assert.equal(defaultProbeUrls(config, { HQ_PUBLIC_URL: 'https://hq.example.test/' }).hq, 'https://hq.example.test/api/healthz');
    assert.equal(defaultProbeUrls(config, { HQ_PUBLIC_URL: 'https://app.example.test/hq/' }).hq, 'https://app.example.test/api/healthz', 'staging: HQ on the app host');
    assert.equal(defaultProbeUrls(config, { HQ_PUBLIC_URL: 'javascript:alert(1)' }).hq, 'https://app.example.test/api/healthz');
  });

  test('STATUS_PROBES: off, or overrides for some components', () => {
    assert.equal(statusSettings(config, { STATUS_PROBES: 'off', HOST_STATUS_FILE: '' }).probes, null);
    const s = statusSettings(config, { STATUS_PROBES: 'app=https://other.test/,bogus=https://x.test/,api=ftp://x', HOST_STATUS_FILE: 'off' });
    assert.equal(s.probes.app, 'https://other.test/');
    assert.equal(s.probes.api, 'https://app.example.test/api/readyz');
    assert.equal(s.probes.bogus, undefined);
    assert.equal(s.hostStatusFile, '');
    assert.equal(s.timeoutMs, 5000);
    assert.deepEqual(parseProbeList('signin=http://localhost:3410/api/v1/auth/providers'), { signin: 'http://localhost:3410/api/v1/auth/providers' });
  });

  test('STATUS_PUBLIC_URL, else the site page', () => {
    assert.equal(statusPublicUrl(config, {}), 'https://app.example.test/site/status.html');
    assert.equal(statusPublicUrl(config, { STATUS_PUBLIC_URL: 'https://status.example.test/' }), 'https://status.example.test/');
    assert.equal(statusPublicUrl(config, { STATUS_PUBLIC_URL: 'https://status.example.test/#x' }), 'https://status.example.test/');
    assert.equal(statusPublicUrl(config, { STATUS_PUBLIC_URL: 'http://evil.test/' }), 'https://app.example.test/site/status.html');
  });
});

describe('worker chain', () => {
  test('each run enqueues the next 5-minute bucket, never the one it ran in', async () => {
    const queued = [];
    const db = {
      async query(sql, params) {
        if (/INSERT INTO jobs_queue/.test(sql)) { queued.push({ kind: params[0], payload: params[1], runAt: params[3], dedupeKey: params[5] }); return { rows: [{ id: 1 }] }; }
        if (/FROM email_outbox/.test(sql)) return { rows: [{ sent: 0, failed: 0, stuck: 0 }] };
        return { rows: [], rowCount: 0 };
      },
      async tx(fn) { return fn(this); },
    };
    const at = new Date('2026-10-19T12:03:10Z');
    const h = createStatusHandlers({ config, env: { STATUS_PROBES: 'off', HOST_STATUS_FILE: 'off' }, stripe: null, emailConfigured: false, now: () => at });
    const r = await h.status_probe({ db, job: { payload: { bucket: bucketOf(at) } } });
    assert.deepEqual(r, { app: 'unknown', api: 'unknown', hq: 'unknown', signin: 'unknown', email: 'unknown', payments: 'unknown' });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].dedupeKey, `status_probe:${bucketOf(at) + 1}`);
    assert.equal(queued[0].runAt.toISOString(), '2026-10-19T12:05:00.000Z');
    // A late job (its bucket long gone) schedules after now, not in the past.
    queued.length = 0;
    await h.status_probe({ db, job: { payload: { bucket: bucketOf(at) - 10 } } });
    assert.equal(queued[0].runAt.toISOString(), '2026-10-19T12:05:00.000Z');
    // A run that fails still keeps the chain going.
    queued.length = 0;
    const broken = { ...db, async tx() { throw new Error('db down'); } };
    await assert.rejects(h.status_probe({ db: broken, job: { payload: {} } }), /db down/);
    assert.equal(queued.length, 1);
  });
});
