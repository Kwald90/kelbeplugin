// HQ backup alerts (docs/releases/r1-get-paid.md 5.2, server/src/services/backup-alerts.js): the
// hourly hq_backup_alerts job reads the backup status and restore-test files and emails HQ once
// per problem per day (outbox template hq_backup_alerts:<problem>:<day>), keeps its hourly chain,
// and does nothing on a server without either file.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, testConfig } from './support/app.js';
import { hqUser, startHqApp } from './support/hq.js';
import { BACKUP_ALERT_STEPS, createBackupAlertHandlers, runBackupAlerts, scheduleBackupAlerts } from '../src/services/backup-alerts.js';
import { backupProblems } from '../src/services/hq-health.js';

const NOTIFY = 'hq-backups@fishtape.test';
const NOW = new Date('2026-10-20T15:30:00Z');
const hoursAgo = (h, from = NOW) => new Date(from.getTime() - h * 3_600_000).toISOString();
let t, dir, backupFile, drillsFile;

/** last-backup.json the way backup.sh writes it. */
function backupStatus(o = {}) {
  writeFileSync(backupFile, JSON.stringify({
    schema: 1, environment: 'production', kind: 'nightly', status: 'ok', startedAt: hoursAgo(3), finishedAt: hoursAgo(3), file: 'fishtape-production-20261020T123000Z.dump.age',
    bytes: 123456, offsite: 'ok', offsiteTarget: 'rclone offsite-ca (s3 ca-central-1)', lastOffsiteOkAt: hoursAgo(3), error: null, ...o,
  }));
}
function drills(lines) { writeFileSync(drillsFile, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')); }
const offsiteDrill = (daysAgo, o = {}) => ({ ts: hoursAgo(daysAgo * 24), environment: 'production', source: 'offsite', host: 'off-box', ok: true, secretsChecked: true, secretsOk: true, ...o });

const config = (o = {}) => ({ ...testConfig(), appEnv: 'production', backupStatusFile: backupFile, restoreTestsFile: drillsFile, hq: { notifyEmail: NOTIFY, tlsCheck: false }, ...o });
const outbox = async () => (await t.superPool.query("SELECT template, to_address, subject, text_body FROM email_outbox WHERE template LIKE 'hq_backup_alerts:%' ORDER BY id")).rows;
const jobs = async () => (await t.superPool.query("SELECT dedupe_key, run_at, status FROM jobs_queue WHERE kind = 'hq_backup_alerts' ORDER BY dedupe_key")).rows;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fishtape-backup-alerts-'));
  backupFile = join(dir, 'last-backup.json');
  drillsFile = join(dir, 'restore-tests.jsonl');
  if (skip) return;
  t = await createTestDatabase('backupalerts');
});
after(async () => { await t?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('which problems alert (no database)', () => {
  test('every problem code has first steps', () => {
    for (const code of ['backup_stale', 'backup_failed', 'backup_unreadable', 'offsite_failed', 'offsite_stale', 'offsite_missing', 'drill_overdue', 'drill_unreadable', 'no_offsite_drill']) {
      assert.ok(BACKUP_ALERT_STEPS[code]?.length, code);
    }
  });

  test('a healthy production server with a recent offsite drill has none', () => {
    const h = {
      environment: 'production',
      backup: { configured: true, stale: false, status: 'ok', offsite: { status: 'ok', configured: true, stale: false } },
      restoreTest: { configured: true, stale: false, lastPassAt: hoursAgo(240), lastOffsitePassAt: hoursAgo(240) },
    };
    assert.deepEqual(backupProblems(h), []);
    // Staging without offsite: neither the missing copy nor the missing offsite drill is a problem.
    const stg = { environment: 'staging', backup: { configured: true, stale: false, status: 'ok', offsite: { status: 'skipped', configured: false, stale: true } }, restoreTest: { configured: true, stale: false, lastPassAt: hoursAgo(24), lastOffsitePassAt: null } };
    assert.deepEqual(backupProblems(stg), []);
    assert.deepEqual(backupProblems({ ...stg, environment: 'production' }).map((p) => p.code), ['offsite_missing', 'no_offsite_drill']);
  });
});

describe('hq_backup_alerts', { skip }, () => {
  beforeEach(async () => {
    await t.superPool.query("DELETE FROM email_outbox WHERE template LIKE 'hq_backup_alerts:%'");
    await t.superPool.query("DELETE FROM jobs_queue WHERE kind = 'hq_backup_alerts'");
    backupStatus();
    drills([offsiteDrill(10)]);
  });

  test('nothing wrong: no email', async () => {
    const r = await runBackupAlerts({ db: t.db, config: config(), notifyEmail: NOTIFY, hqLink: 'https://hq.example/#/health', now: NOW });
    assert.deepEqual(r, { problems: [], emailed: 0 });
    assert.deepEqual(await outbox(), []);
  });

  test('offsite failed: one email per problem per day, again the next day', async () => {
    backupStatus({ status: 'degraded', offsite: 'failed', lastOffsiteOkAt: hoursAgo(30), error: 'local backup ok, offsite copy failed' });
    const run = (now) => runBackupAlerts({ db: t.db, config: config(), notifyEmail: NOTIFY, hqLink: 'https://hq.example/#/health', now });
    assert.deepEqual(await run(NOW), { problems: ['offsite_failed'], emailed: 1 });
    assert.deepEqual(await run(new Date(NOW.getTime() + 3_600_000)), { problems: ['offsite_failed'], emailed: 0 }, 'an hour later: already sent today');
    const [m] = await outbox();
    assert.equal(m.template, 'hq_backup_alerts:offsite_failed:2026-10-20');
    assert.equal(m.to_address, NOTIFY);
    assert.match(m.subject, /production.*offsite backup failed/);
    assert.match(m.text_body, /rclone offsite-ca \(s3 ca-central-1\)/);
    assert.match(m.text_body, /docs\/runbooks\/offsite-backups\.md/);
    assert.equal((await run(new Date('2026-10-21T01:00:00Z'))).emailed, 1, 'the next UTC day');
    assert.equal((await outbox()).length, 2);
  });

  test('offsite missing in production, drill overdue and no offsite drill: each its own email', async () => {
    backupStatus({ status: 'degraded', offsite: 'skipped', offsiteTarget: null, lastOffsiteOkAt: null });
    drills([{ ts: hoursAgo(100 * 24), environment: 'production', host: 'srv1', ok: true }]);
    const r = await runBackupAlerts({ db: t.db, config: config(), notifyEmail: NOTIFY, now: NOW });
    assert.deepEqual(r.problems.sort(), ['drill_overdue', 'no_offsite_drill', 'offsite_missing']);
    assert.equal(r.emailed, 3);
    assert.deepEqual((await outbox()).map((m) => m.template.split(':')[1]).sort(), ['drill_overdue', 'no_offsite_drill', 'offsite_missing']);
  });

  test('staging without an offsite copy: no drill emails (nobody drills there)', async () => {
    backupStatus({ status: 'degraded', offsite: 'skipped', offsiteTarget: null, lastOffsiteOkAt: null });
    drills([{ ts: hoursAgo(100 * 24), environment: 'staging', host: 'srv1', ok: true }]);
    const r = await runBackupAlerts({ db: t.db, config: config({ appEnv: 'staging' }), notifyEmail: NOTIFY, now: NOW });
    assert.deepEqual(r, { problems: [], emailed: 0 });
  });

  test('stale offsite and a stale backup; a failed drill does not count as a pass', async () => {
    backupStatus({ finishedAt: hoursAgo(30), lastOffsiteOkAt: hoursAgo(30) });
    drills([offsiteDrill(100), offsiteDrill(1, { ok: false, failures: 'pg_restore failed' })]);
    const r = await runBackupAlerts({ db: t.db, config: config(), notifyEmail: NOTIFY, now: NOW });
    assert.deepEqual(r.problems.sort(), ['backup_stale', 'drill_overdue', 'offsite_stale']);
  });

  test('without HQ_NOTIFY_EMAIL the problems are found but nothing is emailed', async () => {
    backupStatus({ offsite: 'failed' });
    const r = await runBackupAlerts({ db: t.db, config: config(), notifyEmail: '', now: NOW });
    assert.deepEqual(r, { problems: ['offsite_failed'], emailed: 0 });
  });

  test('the job keeps an hourly chain, runs once with payload.once, and skips a server without the files', async () => {
    backupStatus({ offsite: 'failed' });
    const handlers = createBackupAlertHandlers({ config: config(), env: {}, now: () => NOW });
    const r = await handlers.hq_backup_alerts({ db: t.db, job: { payload: {} } });
    assert.equal(r.emailed, 1);
    assert.deepEqual((await jobs()).map((j) => j.dedupe_key), ['hq_backup_alerts:2026-10-20T16']);
    await handlers.hq_backup_alerts({ db: t.db, job: { payload: {} } });
    assert.equal((await jobs()).length, 1, 'the next link is queued once');
    await t.superPool.query("DELETE FROM jobs_queue WHERE kind = 'hq_backup_alerts'");
    await handlers.hq_backup_alerts({ db: t.db, job: { payload: { once: true } } });
    assert.deepEqual(await jobs(), [], 'a one-off run does not chain');

    const bare = createBackupAlertHandlers({ config: config({ backupStatusFile: '', restoreTestsFile: '' }), env: {}, now: () => NOW });
    assert.match((await bare.hq_backup_alerts({ db: t.db, job: { payload: { once: true } } })).skipped, /no BACKUP_STATUS_FILE/);
  });

  test('scheduling is idempotent and needs a status file in the environment', async () => {
    await scheduleBackupAlerts(t.db, NOW, {});
    assert.deepEqual(await jobs(), []);
    const env = { BACKUP_STATUS_FILE: backupFile };
    await scheduleBackupAlerts(t.db, NOW, env);
    await scheduleBackupAlerts(t.db, NOW, env);
    assert.deepEqual((await jobs()).map((j) => j.dedupe_key), ['hq_backup_alerts:2026-10-20T15', 'hq_backup_alerts:2026-10-20T16']);
  });
});

describe('HQ: record a drill result (POST /api/hq/restore-tests)', { skip }, () => {
  let app, cfg, staff, owner, uploads;
  const line = (o = {}) => JSON.stringify({
    ts: '2026-10-19T20:00:00Z', environment: 'test', source: 'offsite', host: 'off-box', file: 'fishtape-production-20261019T024700Z.dump.age',
    sha256: 'b'.repeat(64), ok: true, secretsChecked: true, secretsOk: true, migration: '0152', tenants: 2, durationSeconds: 95, ...o,
  });
  const record = (token, text) => call(app, { method: 'POST', url: '/api/hq/restore-tests', token, body: { line: text } });

  before(async () => {
    uploads = join(dir, 'uploaded-restore-tests.jsonl');
    ({ app, config: cfg } = await startHqApp(t, { env: { RESTORE_TESTS_FILE: uploads } }));
    staff = await hqUser(t, app, 'hq_staff');
    owner = await ownerTenant(t, app, 'Alpha Wiring');
  });
  after(async () => { await app?.close(); });

  test('HQ only', async () => {
    assert.equal((await call(app, { method: 'POST', url: '/api/hq/restore-tests', body: { line: line() } })).status, 401);
    assert.equal((await record(owner.token, line())).status, 403);
    assert.equal(existsSync(uploads), false);
  });

  test('a drill line is checked, normalized, appended once, audited and shown on HQ health', async () => {
    const r = await record(staff.token, `${line({ ts: '2026-10-01T00:00:00Z', ok: false })}\n${line({ extra: 'dropped' })}\n`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.recorded, true);
    assert.equal(r.body.result.ts, '2026-10-19T20:00:00.000Z', 'the last line of a pasted file');
    const stored = readFileSync(uploads, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'offsite');
    assert.ok(stored[0].recordedBy.length > 0);
    assert.ok(!('extra' in stored[0]));
    const again = await record(staff.token, line());
    assert.deepEqual([again.status, again.body.recorded, again.body.duplicate], [200, false, true]);
    assert.equal(readFileSync(uploads, 'utf8').trim().split('\n').length, 1, 'not appended twice');
    const ev = (await t.superPool.query("SELECT * FROM audit_events WHERE tenant_id IS NULL AND action = 'hq.restore_test_recorded'")).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].meta.secretsChecked, true);
    const h = await call(app, { url: '/api/hq/dev-health', token: staff.token });
    assert.equal(h.body.restoreTest.lastOffsitePassAt, '2026-10-19T20:00:00.000Z');
    assert.equal(h.body.restoreTest.secretsChecked, true);
  });

  test('refused: not JSON, not a result, the future, another environment, no file configured', async () => {
    const bad = async (text, status, code) => {
      const r = await record(staff.token, text);
      assert.equal(r.status, status, text.slice(0, 80));
      assert.equal(r.body.error.code, code);
    };
    await bad('PASS', 400, 'validation_failed');
    await bad(JSON.stringify({ ts: '2026-10-19T20:00:00Z' }), 400, 'validation_failed');
    await bad(line({ ts: '2099-01-01T00:00:00Z' }), 400, 'validation_failed');
    await bad(line({ environment: 'production' }), 422, 'wrong_environment');
    const saved = cfg.restoreTestsFile;
    cfg.restoreTestsFile = '';
    try { await bad(line({ ts: '2026-10-18T00:00:00Z' }), 409, 'not_configured'); } finally { cfg.restoreTestsFile = saved; }
  });
});
