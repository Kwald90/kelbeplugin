// Background worker: `npm run worker`. Polls jobs_queue and runs handlers from
// services/queue.js. Safe to run several copies (SKIP LOCKED).
import { hostname } from 'node:os';
import { loadEnvFile, readConfig } from './config.js';
import { createDb, createPool } from './db.js';
import { HANDLERS, reclaimStuck, runOnce, scheduleRecurring } from './services/queue.js';
import { INTEGRATION_HANDLERS, scheduleIntegrationJobs } from './integrations/jobs.js';

Object.assign(HANDLERS, INTEGRATION_HANDLERS);

const HOUR = 3600_000;

async function main() {
  loadEnvFile();
  const config = readConfig();
  const db = createDb({ app: createPool(config.databaseUrl, { max: config.worker.concurrency + 1, applicationName: 'fishtape-worker' }) });
  const workerId = `${hostname()}:${process.pid}`;
  const log = (level, msg, extra = {}) => process.stdout.write(JSON.stringify({ level, time: Date.now(), workerId, msg, ...extra }) + '\n');
  let stopping = false;
  let lastHousekeeping = 0;

  async function loop(slot) {
    while (!stopping) {
      try {
        if (slot === 0 && Date.now() - lastHousekeeping > HOUR) {
          lastHousekeeping = Date.now();
          const n = await reclaimStuck(db);
          if (n) log('warn', 'requeued stuck jobs', { count: n });
          await scheduleRecurring(db);
          await scheduleIntegrationJobs(db);
        }
        const r = await runOnce(db, { workerId, log: { info: (m) => log('info', m), error: (m) => log('error', m) } });
        if (r) { log(r.outcome === 'done' ? 'info' : 'warn', `job ${r.kind} ${r.outcome}`, { jobId: r.id, ...(r.error ? { error: r.error } : {}) }); continue; }
      } catch (e) {
        log('error', 'worker loop error', { error: e.message });
      }
      await new Promise((res) => setTimeout(res, config.worker.pollMs));
    }
  }

  const stop = async () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('info', 'worker started', { concurrency: config.worker.concurrency });
  await Promise.all(Array.from({ length: config.worker.concurrency }, (_, i) => loop(i)));
  await db.close();
  log('info', 'worker stopped');
}

main().catch((e) => { console.error(e); process.exit(1); });
