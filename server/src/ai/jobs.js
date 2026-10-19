// Worker jobs for the AI workstream. worker.js merges these handlers into the queue
// runner and calls scheduleAiJobs() with its hourly housekeeping.
import { createSealer } from '../lib/crypto.js';
import { createValidator } from '../schemas.js';
import { createRecords } from '../services/records.js';
import { enqueue } from '../services/queue.js';
import { readAiConfig } from './config.js';
import { dispatch, purgeConversations, scanTenant } from './background.js';

/**
 * @param {{ config: import('../config.js').Config, aiCfg?: import('./config.js').AiConfig, records?: object }} o
 */
export function createAiHandlers({ config, aiCfg = readAiConfig(), records } = {}) {
  const sealer = createSealer(config.secretsMasterKey);
  let recs = records;
  const getRecords = () => (recs ||= createRecords({ validator: createValidator() }));
  return {
    /** Hourly: queue a scan for each company with background agents (each scans at most once a day). */
    async ai_background_dispatch({ db }) {
      return dispatch(db);
    },
    async ai_background_scan({ db, job }) {
      return scanTenant({ db, sealer, records: getRecords(), aiCfg, tenantId: job.payload.tenantId || job.tenant_id, force: Boolean(job.payload.force) });
    },
    async ai_purge({ db }) {
      return purgeConversations(db, aiCfg);
    },
  };
}

/** Recurring AI jobs, deduplicated so many workers enqueue each once. */
export async function scheduleAiJobs(db) {
  await enqueue(db, { kind: 'ai_background_dispatch', dedupeKey: 'ai_background_dispatch', maxAttempts: 3 });
  await enqueue(db, { kind: 'ai_purge', dedupeKey: 'ai_purge', maxAttempts: 3 });
}
