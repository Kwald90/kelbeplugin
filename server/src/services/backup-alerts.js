// Backup alerts for HQ (docs/releases/r1-get-paid.md 5.2). The hq_backup_alerts job runs hourly in
// the worker's general pool, reads the same files as HQ health (BACKUP_STATUS_FILE and
// RESTORE_TESTS_FILE) and emails HQ_NOTIFY_EMAIL through the platform email outbox about each
// problem at most once a day: the outbox row's template is the dedupe key
// `hq_backup_alerts:<problem>:<UTC day>`, so several workers never send the same alert twice.
//
// The problems (backupProblems in hq-health.js): backup stale or failed, offsite copy failed, stale
// or not configured (production), restore drill overdue (over 92 days), no offsite drill yet.
// The emails carry file names, times and the offsite target label only; no tenant data, no keys.
// First steps for each are in docs/runbooks/offsite-backups.md.
import { readConfig } from '../config.js';
import { createEmail } from '../lib/email.js';
import { enqueue } from './queue.js';
import { hqSettings } from './hq-common.js';
import { backupProblems, readBackupStatus, readRestoreTests } from './hq-health.js';

const HOUR_MS = 3_600_000;
const RUNBOOK = 'docs/runbooks/offsite-backups.md';
const hourKey = (d) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);

/** What to do first, per problem code. */
export const BACKUP_ALERT_STEPS = {
  backup_stale: ['Check the backup timer on the server: systemctl list-timers \'fishtape-*-backup*\' and journalctl -u fishtape-<env>-backup.', 'Run one backup by hand (sudo deploy/<env>/backup.sh) and read its last line.'],
  backup_failed: ['Read the error in last-backup.json on the HQ health page, then the backup unit\'s journal.', 'Fix the cause and run sudo deploy/<env>/backup.sh once by hand.'],
  backup_unreadable: ['BACKUP_STATUS_FILE cannot be read by the API: check the status mount and that last-backup.json exists (sudo deploy/<env>/backup.sh writes it).'],
  offsite_failed: ['The local backup is fine; the copy to the bucket failed. On the server: sudo rclone lsd <remote> as root to test the key and network.', 'Check the bucket key has not expired or lost its permissions, then run sudo deploy/<env>/backup.sh once.'],
  offsite_stale: ['No backup has reached the bucket in over 26 hours. Check last-backup.json (offsite field) and the backup timer.', 'If backups run but say "skipped", OFFSITE_RCLONE_REMOTE was removed from backup.conf.'],
  offsite_missing: ['Production needs an offsite copy: follow docs/runbooks/offsite-backups.md (choose the bucket, keys, backup.conf).'],
  drill_overdue: ['Run the offsite drill from your PC (offsite-drill.sh --identity - --verify-secrets) and record the result on the HQ health page.', 'A quarterly drill is the policy (docs/compliance/backup-retention.md).'],
  drill_unreadable: ['RESTORE_TESTS_FILE cannot be read by the API: check the drills mount (/var/lib/fishtape-<env>/drills, owned by uid 1000).'],
  no_offsite_drill: ['Run the first offsite drill from your PC and record its JSON line on the HQ health page (Record a drill result).'],
};

const email = createEmail();

function body({ environment, problem, backup, restoreTest, hqLink }) {
  const facts = [
    `Environment: ${environment}`,
    backup?.configured && !backup.error ? `Last backup: ${backup.at || 'unknown'} (${backup.status || (backup.ok ? 'ok' : 'unknown')})` : null,
    backup?.offsite ? `Offsite: ${backup.offsite.status || 'not reported'}${backup.offsite.target ? ` to ${backup.offsite.target}` : ''}; last copy ${backup.offsite.lastOkAt || 'never'}` : null,
    restoreTest?.configured && !restoreTest.error ? `Last restore drill passed: ${restoreTest.lastPassAt || 'never'}; last offsite drill: ${restoreTest.lastOffsitePassAt || 'never'}` : null,
  ].filter(Boolean);
  return [
    `Problem: ${problem.text}.`,
    '',
    ...facts,
    '',
    'First steps:',
    ...(BACKUP_ALERT_STEPS[problem.code] || []).map((s) => `- ${s}`),
    '',
    `Runbook: ${RUNBOOK}`,
    `HQ: ${hqLink}`,
    '',
    'At most one email per problem a day. File names and times only; no customer data.',
  ].join('\n');
}

/**
 * Read the backup and restore-test status once and email each problem not yet emailed today.
 * @param {{ db: object, config: object, notifyEmail?: string, hqLink?: string, now?: Date }} o
 * @returns {Promise<{ problems: string[], emailed: number }>}
 */
export async function runBackupAlerts({ db, config, notifyEmail = '', hqLink = '', now = new Date() }) {
  const t = now.getTime();
  const backup = readBackupStatus(config.backupStatusFile, t);
  const restoreTest = readRestoreTests(config.restoreTestsFile, t);
  const environment = config.appEnv;
  const problems = backupProblems({ environment, backup, restoreTest });
  const day = now.toISOString().slice(0, 10);
  let emailed = 0;
  for (const problem of problems) {
    if (!notifyEmail) continue;
    const template = `hq_backup_alerts:${problem.code}:${day}`;
    const { rows } = await db.query('SELECT 1 FROM email_outbox WHERE template = $1 LIMIT 1', [template]);
    if (rows.length) continue;
    await email.send(db, {
      to: notifyEmail, template,
      subject: `Backup alert (${environment}): ${problem.text}`.slice(0, 150),
      text: body({ environment, problem, backup, restoreTest, hqLink }),
    });
    emailed++;
  }
  return { problems: problems.map((p) => p.code), emailed };
}

/** Is there anything to watch on this server? (Local development has neither file.) */
const watching = (config) => Boolean(config.backupStatusFile || config.restoreTestsFile);

/**
 * @param {{ config?: object, env?: object, now?: () => Date }} [deps] tests pass their own
 */
export function createBackupAlertHandlers(deps = {}) {
  const now = deps.now || (() => new Date());
  return {
    async hq_backup_alerts({ db, job }) {
      const env = deps.env || process.env;
      const at = now();
      try {
        const config = deps.config || readConfig(env);
        if (!watching(config)) return { skipped: 'no BACKUP_STATUS_FILE or RESTORE_TESTS_FILE on this server' };
        const hq = hqSettings(config, env);
        return await runBackupAlerts({ db, config, notifyEmail: hq.notifyEmail, hqLink: `${hq.publicUrl}#/health`, now: at });
      } finally {
        if (!job?.payload?.once) {
          const next = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
          await enqueue(db, { kind: 'hq_backup_alerts', runAt: next, dedupeKey: `hq_backup_alerts:${hourKey(next)}`, maxAttempts: 1 });
        }
      }
    },
  };
}

export const BACKUP_ALERT_HANDLERS = createBackupAlertHandlers();

/**
 * Start the hourly chain (idempotent; the worker calls it at start and hourly): this hour's run and
 * the next hour's link, since a killed worker's row may still hold this hour's key. Nothing when
 * the server has neither status file.
 */
export async function scheduleBackupAlerts(db, at = new Date(), env = process.env) {
  if (!env.BACKUP_STATUS_FILE && !env.RESTORE_TESTS_FILE) return;
  await enqueue(db, { kind: 'hq_backup_alerts', dedupeKey: `hq_backup_alerts:${hourKey(at)}`, maxAttempts: 1 });
  const next = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
  await enqueue(db, { kind: 'hq_backup_alerts', runAt: next, dedupeKey: `hq_backup_alerts:${hourKey(next)}`, maxAttempts: 1 });
}
