// Background worker: `npm run worker`. Polls jobs_queue and runs handlers from
// services/queue.js. Safe to run several copies (SKIP LOCKED).
//
// Two pools in one process (docs/integrations/quickbooks.md 5.8): the general loop
// (WORKER_CONCURRENCY slots) never claims qbo_* jobs, and the QuickBooks loop
// (WORKER_QBO_CONCURRENCY slots) claims nothing else, so password resets, invites, Stripe
// follow-ups and notifications never wait behind QuickBooks.
import { hostname } from 'node:os';
import { loadEnvFile, readConfig } from './config.js';
import { createDb, createPool } from './db.js';
import { createSealer } from './lib/crypto.js';
import { createValidator } from './schemas.js';
import { createRecords } from './services/records.js';
import { HANDLERS, QBO_KIND_PATTERN, reclaimStuck, runOnce, scheduleRecurring } from './services/queue.js';
import { INTEGRATION_HANDLERS, scheduleIntegrationJobs } from './integrations/jobs.js';
import { createAiHandlers, scheduleAiJobs } from './ai/jobs.js';
import { HQ_HANDLERS } from './services/hq-jobs.js';
import { PLATFORM_EMAIL_HANDLERS, schedulePlatformEmail } from './services/platform-email.js';
import { createNotificationHandlers, scheduleNotificationDigest } from './routes/v1/notifications.js';
import { SIGNUP_HANDLERS, scheduleSignupCleanup } from './services/signup.js';
import { FINANCE_HANDLERS, scheduleFinanceJobs } from './services/hq-finance.js';
import { STATUS_HANDLERS, scheduleStatusProbes } from './services/status-page.js';
import { createMaterialHandlers, scheduleMaterialRequestSends } from './services/materials.js';
import { LOCATION_HANDLERS, scheduleLocationJobs } from './services/location.js';
import { registerAmountDueAdjuster } from './integrations/payments.js';
import { createQboHandlers, scheduleQboJobs } from './qbo/jobs.js';
import { createQboPlatformHandlers, scheduleQboPlatformJobs } from './qbo/platform-jobs.js';
import { QBO_ALERT_HANDLERS, scheduleQboAlerts } from './qbo/alerts.js';
import { amountDueAdjustment, markShutdown } from './qbo/engine.js';

Object.assign(HANDLERS, INTEGRATION_HANDLERS, HQ_HANDLERS, PLATFORM_EMAIL_HANDLERS, SIGNUP_HANDLERS, FINANCE_HANDLERS, STATUS_HANDLERS, LOCATION_HANDLERS);

const HOUR = 3600_000;
const QBO_KINDS = [QBO_KIND_PATTERN];

async function main() {
  loadEnvFile();
  const config = readConfig();
  const db = createDb({ app: createPool(config.databaseUrl, { max: config.worker.concurrency + config.worker.qboConcurrency + 1, applicationName: 'fishtape-worker' }) });
  const workerId = `${hostname()}:${process.pid}`;
  const sealer = createSealer(config.secretsMasterKey);
  const records = createRecords({ validator: createValidator(), config });
  // The QuickBooks alerts run in the general pool: they watch the QuickBooks pool and must not wait in it.
  const handlers = { ...HANDLERS, ...createAiHandlers({ config }), ...createNotificationHandlers({ config }), ...createMaterialHandlers({ config }), ...QBO_ALERT_HANDLERS };
  const qboHandlers = {
    ...createQboHandlers({ sealer, config, records, workerId }),
    ...createQboPlatformHandlers({ sealer, config }),
  };
  // The QuickBooks amount-due adjustment (docs/integrations/quickbooks.md 4.9), for invoice statuses set here.
  if (config.qbo?.enabled) registerAmountDueAdjuster(amountDueAdjustment);
  const log = (level, msg, extra = {}) => process.stdout.write(JSON.stringify({ level, time: Date.now(), workerId, msg, ...extra }) + '\n');
  const jobLog = { info: (m) => log('info', m), error: (m) => log('error', m) };
  let stopping = false;
  let lastHousekeeping = 0;

  async function housekeeping() {
    lastHousekeeping = Date.now();
    const n = await reclaimStuck(db);
    if (n) log('warn', 'requeued stuck jobs', { count: n });
    await scheduleRecurring(db);
    await scheduleIntegrationJobs(db);
    await scheduleAiJobs(db);
    await schedulePlatformEmail(db);
    await scheduleNotificationDigest(db);
    await scheduleSignupCleanup(db);
    await scheduleFinanceJobs(db);
    await scheduleStatusProbes(db);
    await scheduleMaterialRequestSends(db);
    await scheduleLocationJobs(db);
    await scheduleQboJobs(db, { config });
    await scheduleQboPlatformJobs(db);
    await scheduleQboAlerts(db);
  }

  /** @param {'general'|'qbo'} pool */
  async function loop(pool, slot) {
    const opts = pool === 'qbo'
      ? { workerId, handlers: qboHandlers, log: jobLog, kinds: QBO_KINDS }
      : { workerId, handlers, log: jobLog, excludeKinds: QBO_KINDS };
    while (!stopping) {
      try {
        if (pool === 'general' && slot === 0 && Date.now() - lastHousekeeping > HOUR) await housekeeping();
        const r = await runOnce(db, opts);
        if (r) { log(r.outcome === 'done' ? 'info' : 'warn', `job ${r.kind} ${r.outcome}`, { jobId: r.id, pool, ...(r.error ? { error: r.error } : {}) }); continue; }
      } catch (e) {
        log('error', 'worker loop error', { pool, error: e.message });
      }
      await new Promise((res) => setTimeout(res, config.worker.pollMs));
    }
  }

  // A deploy stops the container (SIGTERM, then a kill after stop_grace_period): QuickBooks passes end
  // at their next step as if out of time, release their claims and lease and queue their continuation.
  const stop = async () => { stopping = true; markShutdown(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('info', 'worker started', { concurrency: config.worker.concurrency, qboConcurrency: config.worker.qboConcurrency });
  await Promise.all([
    ...Array.from({ length: config.worker.concurrency }, (_, i) => loop('general', i)),
    ...Array.from({ length: config.worker.qboConcurrency }, (_, i) => loop('qbo', i)),
  ]);
  await db.close();
  log('info', 'worker stopped');
}

main().catch((e) => { console.error(e); process.exit(1); });
