// HQ, billing and plan helpers that need no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_PLAN } from '../../electrical-app/js/plans.js';
import { COLLECTIONS } from '../src/collections.js';
import { COLLECTION_FEATURES, assertCollectionWritable, effectivePlan, tenantEntitlements } from '../src/services/entitlements.js';
import { parseYaml, YamlError } from '../src/services/hq-yaml.js';
import { loadControls } from '../src/services/hq-compliance.js';
import { createMetrics, percentile } from '../src/services/hq-metrics.js';
import {
  backupProblems, healthLevel, normalizeRestoreResult, parseDeployLog, parseRestoreTests, readBackupStatus, readRestoreTests, environmentStatuses,
} from '../src/services/hq-health.js';
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
  assert.equal(b.offsite.status, null, 'a status file from before offsite tracking says nothing about offsite');
  assert.equal(b.offsite.configured, false);
});

test('readBackupStatus: the offsite copy from backup.sh (status, target, last copy, staleness)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishtape-backup-'));
  const now = Date.parse('2026-10-20T12:00:00Z');
  const write = (o) => { writeFileSync(join(dir, 'b.json'), JSON.stringify({ schema: 1, environment: 'production', status: 'ok', finishedAt: '2026-10-20T09:00:00Z', bytes: 4096, ...o })); return readBackupStatus(join(dir, 'b.json'), now); };

  const ok = write({ offsite: 'ok', offsiteTarget: 'rclone offsite-ca (s3 ca-central-1)', lastOffsiteOkAt: '2026-10-20T09:00:00Z' });
  assert.deepEqual(ok.offsite, { status: 'ok', configured: true, lastOkAt: '2026-10-20T09:00:00.000Z', ageHours: 3, stale: false, target: 'rclone offsite-ca (s3 ca-central-1)' });
  assert.equal(ok.sizeBytes, 4096, 'backup.sh writes bytes');
  assert.equal(ok.target, 'rclone offsite-ca (s3 ca-central-1)');
  assert.equal(ok.environment, 'production');

  const failed = write({ status: 'degraded', offsite: 'failed', offsiteTarget: 'rclone offsite-ca', lastOffsiteOkAt: '2026-10-18T09:00:00Z' });
  assert.equal(failed.offsite.status, 'failed');
  assert.equal(failed.offsite.stale, true);
  assert.equal(failed.offsite.ageHours, 51);
  assert.equal(failed.status, 'degraded');

  const skipped = write({ offsite: 'skipped', offsiteTarget: null, lastOffsiteOkAt: null });
  assert.deepEqual([skipped.offsite.status, skipped.offsite.configured, skipped.offsite.lastOkAt, skipped.offsite.stale], ['skipped', false, null, true]);
  assert.equal(write({ offsite: 'skipped', lastOffsiteOkAt: '2026-10-01T00:00:00Z' }).offsite.configured, true, 'it was configured once: a skip now is a stale offsite copy');
  assert.equal(write({ offsite: 'weird' }).offsite.status, null);
});

test('restore tests: lines from restore-test.sh, the offsite drill and HQ uploads; newest pass, offsite pass, staleness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishtape-drills-'));
  const file = join(dir, 'restore-tests.jsonl');
  const now = Date.parse('2026-10-20T12:00:00Z');
  assert.deepEqual(readRestoreTests(''), { configured: false });
  const none = readRestoreTests(file, now);
  assert.equal(none.configured, true);
  assert.equal(none.error, undefined, 'no file yet is not an error');
  assert.equal(none.stale, true);
  assert.equal(none.lastPassAt, null);

  writeFileSync(file, [
    // restore-test.sh on a server (no source: local)
    JSON.stringify({ ts: '2026-07-01T10:00:00Z', environment: 'production', host: 'vps1', file: 'fishtape-production-20260630T024700Z.dump.age', sha256: 'a'.repeat(64), ok: true, tables: 80, migrations: 40, tenants: 3 }),
    'not json',
    JSON.stringify({ ts: 'yesterday', ok: true }),
    JSON.stringify({ ts: '2026-08-01T10:00:00Z', ok: 'yes' }),
    // the offsite drill, with secrets checked
    JSON.stringify({ ts: '2026-09-15T10:00:00Z', environment: 'production', source: 'offsite', host: 'off-box', ok: true, secretsChecked: true, secretsOk: true, migration: '0152', tenants: 3, extra: 'dropped' }),
    // a failed run after it
    JSON.stringify({ ts: '2026-10-01T10:00:00Z', environment: 'production', source: 'offsite', host: 'off-box', ok: false, failures: 'checksum mismatch' }),
  ].join('\n'));
  const r = readRestoreTests(file, now);
  assert.equal(r.count, 3);
  assert.equal(r.lastPassAt, '2026-09-15T10:00:00.000Z');
  assert.equal(r.lastSource, 'offsite');
  assert.equal(r.lastHost, 'off-box');
  assert.equal(r.secretsChecked, true);
  assert.equal(r.ageDays, 35);
  assert.equal(r.stale, false);
  assert.equal(r.lastOffsitePassAt, '2026-09-15T10:00:00.000Z');
  assert.deepEqual(r.lastRun, { at: '2026-10-01T10:00:00.000Z', ok: false, source: 'offsite', host: 'off-box', failures: 'checksum mismatch' });
  assert.equal(r.recent.length, 3);
  assert.equal(r.recent[2].source, 'local');
  assert.ok(!('extra' in r.recent[1]), 'unknown fields are dropped');
  assert.equal(readRestoreTests(file, Date.parse('2026-12-17T12:00:00Z')).stale, true, 'over 92 days');

  // Normalization: types checked, junk refused.
  assert.equal(normalizeRestoreResult({ ts: '2026-10-01T00:00:00Z' }), null, 'ok is required');
  assert.equal(normalizeRestoreResult([1]), null);
  const n = normalizeRestoreResult({ ts: '2026-10-01T00:00:00Z', ok: true, host: 'bad host; rm -rf', sha256: 'xyz', tenants: -1, migrations: 3.5, file: '../../etc/passwd', failures: 'x'.repeat(900) });
  assert.deepEqual([n.host, n.sha256, n.tenants, n.migrations, n.file, n.failures.length], [null, null, null, null, null, 500]);
  assert.equal(parseRestoreTests(`${'{"ts":"2026-10-01T00:00:00Z","ok":true,"failures":"'}${'y'.repeat(20_000)}"}`).length, 0, 'over-long lines are skipped');
});

test('health level names the problems', () => {
  const ok = { database: { ok: true }, migrations: { pending: [] }, queue: { failed24h: 0, lagSeconds: 0 }, errors: { lastHour: { errors5xx: 0 } }, backup: { configured: false }, tls: { checked: true, daysLeft: 60 }, disk: [{ usedPct: 50 }] };
  assert.deepEqual(healthLevel(ok), { level: 'ok', problems: [] });
  const bad = { ...ok, queue: { failed24h: 2, lagSeconds: 0 }, tls: { checked: true, daysLeft: 5 }, backup: { configured: true, stale: true } };
  const h = healthLevel(bad);
  assert.equal(h.level, 'degraded');
  assert.equal(h.problems.length, 3);
  assert.equal(healthLevel({ ...ok, database: { ok: false } }).level, 'down');

  // Offsite and restore drills (r1-get-paid.md 5.2).
  const offsite = (o) => ({ configured: true, stale: false, status: 'ok', offsite: { status: 'ok', configured: true, stale: false, ...o } });
  const drill = (o) => ({ configured: true, stale: false, lastPassAt: '2026-10-01T00:00:00Z', lastOffsitePassAt: '2026-10-01T00:00:00Z', ...o });
  const prod = { ...ok, environment: 'production', backup: offsite(), restoreTest: drill() };
  assert.deepEqual(healthLevel(prod), { level: 'ok', problems: [] });
  assert.deepEqual(healthLevel({ ...prod, backup: offsite({ status: 'skipped', configured: false, stale: true }) }).problems, ['offsite backup not configured']);
  assert.deepEqual(healthLevel({ ...prod, environment: 'staging', backup: offsite({ status: 'skipped', configured: false, stale: true }) }).problems, [], 'offsite is optional on staging');
  assert.deepEqual(healthLevel({ ...prod, backup: offsite({ status: 'failed', stale: true }) }).problems, ['offsite backup failed']);
  assert.deepEqual(healthLevel({ ...prod, backup: offsite({ stale: true }) }).problems, ['offsite backup stale']);
  assert.deepEqual(healthLevel({ ...prod, restoreTest: drill({ stale: true }) }).problems, ['restore drill overdue']);
  assert.deepEqual(healthLevel({ ...prod, restoreTest: drill({ lastOffsitePassAt: null }) }).problems, ['no offsite restore drill yet']);
  assert.deepEqual(healthLevel({ ...prod, restoreTest: drill({ stale: true, lastPassAt: null, lastOffsitePassAt: null }) }).problems,
    ['restore drill overdue (none recorded yet)', 'no offsite restore drill yet']);
  assert.deepEqual(healthLevel({ ...prod, restoreTest: { configured: false } }).problems, [], 'no RESTORE_TESTS_FILE on this server: nothing to judge');
  assert.deepEqual(backupProblems({ ...prod, backup: offsite({ status: 'failed' }) }).map((p) => p.code), ['offsite_failed']);
});

test('compliance register and threat model carry the Release 1 rows', () => {
  const root = new URL('../../', import.meta.url);
  const controls = loadControls(fileURLToPath(new URL('compliance/controls.yaml', root)));
  assert.equal(controls.found, true);
  assert.equal(controls.error ?? null, null);
  const ids = new Set(controls.controls.map((c) => c.id));
  for (const id of ['BCK-02', 'BCK-03', 'BCK-04', 'BCK-08', 'PRI-01', 'PRI-02', 'PRI-03', 'PRV-07']) assert.ok(ids.has(id), id);
  for (const c of controls.controls) assert.ok(['implemented', 'partial', 'planned'].includes(c.status), `${c.id} status ${c.status}`);
  const tm = readFileSync(new URL('docs/security/threat-model.md', root), 'utf8');
  for (const id of ['TM-R1-01', 'TM-R1-02', 'TM-R1-03', 'TM-R1-04']) assert.match(tm, new RegExp(`^\\| ${id} \\|`, 'm'), id);
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
