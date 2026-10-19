// HQ, billing and plan helpers that need no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURE_PLAN } from '../../electrical-app/js/plans.js';
import { COLLECTIONS } from '../src/collections.js';
import { COLLECTION_FEATURES, assertCollectionWritable, effectivePlan, tenantEntitlements } from '../src/services/entitlements.js';
import { parseYaml, YamlError } from '../src/services/hq-yaml.js';
import { loadControls } from '../src/services/hq-compliance.js';
import { createMetrics, percentile } from '../src/services/hq-metrics.js';
import { healthLevel, parseDeployLog, readBackupStatus, environmentStatuses } from '../src/services/hq-health.js';
import { clipDeep, parseEnvironments } from '../src/services/hq-common.js';
import { catalog, extraSeats, planFromSubscription, estimateMrrCents } from '../src/services/billing.js';
import { createLeadLimiter } from '../src/routes/hq-leads.js';

const day = 86_400_000;

test('every collection maps to modules that exist in plans.js', () => {
  assert.deepEqual(Object.keys(COLLECTION_FEATURES).sort(), [...COLLECTIONS].sort());
  for (const [coll, feats] of Object.entries(COLLECTION_FEATURES)) {
    if (feats === null) continue;
    for (const f of feats) assert.ok(f in FEATURE_PLAN, `${coll} -> ${f}`);
  }
});

test('collection writes follow the plan, overrides and grace period', () => {
  const starter = { plan: 'starter', plan_overrides: {} };
  assert.doesNotThrow(() => assertCollectionWritable(starter, 'clients', { kind: 'session' }));
  assert.doesNotThrow(() => assertCollectionWritable(starter, 'settings', { kind: 'session' }));
  assert.doesNotThrow(() => assertCollectionWritable(starter, 'auditLog', { kind: 'session' }));
  assert.throws(() => assertCollectionWritable(starter, 'drawings', { kind: 'session' }), (e) => e.code === 'feature_not_in_plan' && e.details.plan === 'pro');
  assert.doesNotThrow(() => assertCollectionWritable({ plan: 'starter', plan_overrides: { security: true } }, 'checklists', {}), 'either module unlocks a shared collection');
  assert.throws(() => assertCollectionWritable({ plan: 'pro', plan_overrides: {} }, 'clients', { kind: 'api_key' }), (e) => e.details.feature === 'api');
  assert.throws(() => assertCollectionWritable(null, 'clients', {}), (e) => e.code === 'feature_not_in_plan');
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(effectivePlan({ plan: 'pro', grace_ends_at: new Date(now.getTime() + day) }, now), 'pro');
  assert.equal(effectivePlan({ plan: 'pro', grace_ends_at: new Date(now.getTime() - day) }, now), 'starter');
  assert.equal(tenantEntitlements({ plan: 'pro', grace_ends_at: new Date(now.getTime() + day), plan_overrides: {} }, now).graceEndsAt, new Date(now.getTime() + day).toISOString());
});

test('YAML reader: the shapes controls.yaml uses', () => {
  const doc = parseYaml([
    '# controls',
    'version: 2',
    'controls:',
    '  - id: CC1.1',
    '    title: "Code of conduct: signed"   # trailing comment',
    "    owner: 'Kelvin''s team'",
    '    tsc: [CC1.1, "CC1.4"]',
    '    status: implemented',
    '    evidence:',
    '    - docs/compliance/conduct.md',
    '    description: >',
    '      Folded text',
    '      on two lines.',
    '    notes: |',
    '      line 1',
    '      line 2',
    '    links: []',
    '    meta: { reviewed: true, n: 3, empty: null }',
    '  - id: CC2.1',
    '    title: Plain title with C#sharp # and a comment',
    '',
  ].join('\n'));
  assert.equal(doc.version, 2);
  const [a, b] = doc.controls;
  assert.equal(a.title, 'Code of conduct: signed');
  assert.equal(a.owner, "Kelvin's team");
  assert.deepEqual(a.tsc, ['CC1.1', 'CC1.4']);
  assert.deepEqual(a.evidence, ['docs/compliance/conduct.md']);
  assert.equal(a.description, 'Folded text on two lines.\n');
  assert.equal(a.notes, 'line 1\nline 2\n');
  assert.deepEqual(a.links, []);
  assert.deepEqual(a.meta, { reviewed: true, n: 3, empty: null });
  assert.equal(b.title, 'Plain title with C#sharp');
  assert.throws(() => parseYaml('a: *anchor'), YamlError);
  assert.throws(() => parseYaml('a: 1\n   b: 2'), YamlError);
});

test('loadControls: found, missing, broken and normalized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishtape-controls-'));
  writeFileSync(join(dir, 'ok.yaml'), 'controls:\n  - id: CC6.1\n    title: MFA\n    tsc: CC6.1\n    status: implemented\n  - id: CC7.2\n    title: Monitoring\n');
  writeFileSync(join(dir, 'bad.yaml'), 'controls:\n  - id: [unclosed\n');
  writeFileSync(join(dir, 'empty.yaml'), 'other: 1\n');
  const ok = loadControls(join(dir, 'ok.yaml'));
  assert.equal(ok.found, true);
  assert.deepEqual(ok.controls[0].tsc, ['CC6.1']);
  assert.deepEqual(ok.controls[1].links, []);
  assert.equal(ok.controls[1].status, 'unknown');
  assert.deepEqual(ok.summary.byStatus, { implemented: 1, unknown: 1 });
  assert.equal(loadControls(join(dir, 'missing.yaml')).found, false);
  assert.match(loadControls(join(dir, 'bad.yaml')).error, /Could not read/);
  assert.match(loadControls(join(dir, 'empty.yaml')).error, /controls/);
});

test('metrics: per-minute buckets, percentiles, routes not URLs, 24 h window', () => {
  let now = Date.parse('2026-10-19T12:00:30Z');
  const m = createMetrics({ now: () => now });
  m.record(200, 5, 'GET /api/v1/:collection');
  m.record(200, 40, 'GET /api/v1/:collection');
  m.record(404, 2, 'GET unmatched');
  m.record(500, 3000, 'POST /api/v1/sync/push');
  let s = m.snapshot();
  assert.deepEqual([s.lastHour.requests, s.lastHour.errors4xx, s.lastHour.errors5xx], [4, 1, 1]);
  assert.equal(s.lastHour.errorRate, 25);
  assert.equal(s.lastHour.p50Ms, 10);
  assert.equal(s.lastHour.maxMs, 3000);
  assert.deepEqual(s.errorRoutes, [{ route: 'POST /api/v1/sync/push', count: 1 }]);
  assert.equal(s.perMinute.length, 60);
  assert.equal(s.perMinute.at(-1).requests, 4);
  assert.equal(s.perHour.length, 24);
  now += 2 * 3_600_000;
  s = m.snapshot();
  assert.equal(s.lastHour.requests, 0);
  assert.equal(s.last24h.requests, 4);
  now += 23 * 3_600_000;
  m.record(200, 1, 'GET /x');
  assert.equal(m.snapshot().last24h.requests, 1, 'old minutes drop off');
  assert.equal(percentile([0, 0, 0], 0.5), null);
});

test('deploy log and backup status parsing', () => {
  const items = parseDeployLog([
    '{"at":"2026-10-18T10:00:00Z","sha":"abc1234","env":"staging","ok":true,"message":"first"}',
    'garbage {',
    '2026-10-19T09:00:00Z def5678 second deploy',
  ].join('\n'));
  assert.equal(items[0].sha, 'def5678');
  assert.equal(items[0].message, 'second deploy');
  assert.equal(items[2].environment, 'staging');
  assert.equal(items[2].ok, true);
  const dir = mkdtempSync(join(tmpdir(), 'fishtape-backup-'));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ finishedAt: '2026-10-18T00:00:00Z', status: 'success', size: 42 }));
  const b = readBackupStatus(join(dir, 'b.json'), Date.parse('2026-10-19T12:00:00Z'));
  assert.deepEqual([b.ok, b.ageHours, b.stale, b.sizeBytes], [true, 36, true, 42]);
  assert.equal(readBackupStatus('').configured, false);
  assert.equal(readBackupStatus(join(dir, 'nope.json')).error, 'unreadable');
});

test('health level names the problems', () => {
  const ok = { database: { ok: true }, migrations: { pending: [] }, queue: { failed24h: 0, lagSeconds: 0 }, errors: { lastHour: { errors5xx: 0 } }, backup: { configured: false }, tls: { checked: true, daysLeft: 60 }, disk: [{ usedPct: 50 }] };
  assert.deepEqual(healthLevel(ok), { level: 'ok', problems: [] });
  const bad = { ...ok, queue: { failed24h: 2, lagSeconds: 0 }, tls: { checked: true, daysLeft: 5 }, backup: { configured: true, stale: true } };
  const h = healthLevel(bad);
  assert.equal(h.level, 'degraded');
  assert.equal(h.problems.length, 3);
  assert.equal(healthLevel({ ...ok, database: { ok: false } }).level, 'down');
});

test('environments: parsed from env, fetched with a timeout, failures reported', async () => {
  const envs = parseEnvironments('staging=https://staging.example/, production=https://app.example, bad=ftp://x, local=http://localhost:3410');
  assert.deepEqual(envs.map((e) => e.name), ['staging', 'production', 'local']);
  const fetchImpl = async (url) => {
    if (url.includes('app.example')) throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    return { ok: true, status: 200, json: async () => ({ status: 'ok', version: '0.1.0', gitSha: 'abc123', environment: 'staging' }) };
  };
  const r = await environmentStatuses(envs, { fetchImpl });
  assert.equal(r[0].ok, true);
  assert.equal(r[0].gitSha, 'abc123');
  assert.equal(r[1].status, 'unreachable');
  assert.equal(r[1].error, 'timeout');
});

test('billing helpers: catalogue, seats, plan from a subscription, MRR', () => {
  assert.deepEqual(catalog().map((c) => c.lookupKey), ['fishtape_starter_monthly_cad', 'fishtape_pro_monthly_cad', 'fishtape_business_monthly_cad', 'fishtape_extra_user_monthly_cad']);
  assert.equal(extraSeats('starter', 5), 3);
  assert.equal(extraSeats('pro', 5), 0);
  assert.equal(extraSeats('enterprise', 500), 0);
  assert.equal(planFromSubscription({ items: { data: [{ price: { lookup_key: 'fishtape_extra_user_monthly_cad' } }, { price: { lookup_key: 'fishtape_pro_monthly_cad' } }] } }), 'pro');
  assert.equal(planFromSubscription({ items: { data: [] }, metadata: { plan: 'business' } }), 'business');
  assert.equal(planFromSubscription({ items: { data: [] }, metadata: { plan: 'free-forever' } }), null);
  assert.equal(estimateMrrCents([
    { billing_status: 'active', billing_plan: 'starter', billed_seats: 5, plan: 'starter' },
    { billing_status: 'past_due', billing_plan: 'pro', billed_seats: 10, plan: 'pro' },
    { billing_status: 'canceled', billing_plan: null, plan: 'starter' },
    { billing_status: 'none', plan: 'trial' },
  ]), 4900 + 3 * 1500 + 12900);
});

test('lead limiter: per key and global, sliding hour', () => {
  let now = 0;
  const allow = createLeadLimiter({ perKey: 2, global: 3, now: () => now });
  assert.deepEqual([allow('a'), allow('a'), allow('a')], [true, true, false]);
  assert.deepEqual([allow('b'), allow('c')], [true, false]);
  now += 3_600_001;
  assert.equal(allow('a'), true);
});

test('clipDeep hides long strings at any depth', () => {
  const v = clipDeep({ a: 'x'.repeat(3000), b: [{ c: 'short' }], n: 5 });
  assert.equal(v.a, '[3000 characters hidden]');
  assert.equal(v.b[0].c, 'short');
  assert.equal(v.n, 5);
});
