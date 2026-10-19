// Worker jobs for integrations (registered in src/worker.js):
//   integrations_dispatch      every minute: send due outbox email/SMS for every company that can
//   integrations_send          right away, one outbox record (invoice/estimate emails)
//   integrations_housekeeping  hourly: recover stuck sends, forget webhook event ids after 90 days
// Each dispatch run enqueues the next one for the following minute (dedupe key per minute,
// so many workers still schedule it once).
import { readConfig } from '../config.js';
import { createSealer } from '../lib/crypto.js';
import { createValidator } from '../schemas.js';
import { createRecords } from '../services/records.js';
import { enqueue } from '../services/queue.js';
import { tenantHas } from '../services/entitlements.js';
import { dispatchTenant, recoverStuck } from './outbox.js';

const minuteKey = (d) => d.toISOString().slice(0, 16);

/**
 * @param {{ sealer?: object, records?: object, now?: () => Date }} [deps] tests pass their own
 */
export function createIntegrationHandlers(deps = {}) {
  let sealer = deps.sealer;
  let records = deps.records;
  const now = deps.now || (() => new Date());
  const ready = () => {
    sealer ??= createSealer(readConfig().secretsMasterKey);
    records ??= createRecords({ validator: createValidator() });
    return { sealer, records };
  };

  async function activeTenants(db, at) {
    const { rows } = await db.query("SELECT id, plan, plan_overrides, trial_ends_at FROM tenants WHERE status = 'active' ORDER BY id");
    return rows.filter((t) => tenantHas(t, 'integrations.email', at) || tenantHas(t, 'integrations.sms', at));
  }

  return {
    async integrations_dispatch({ db, job }) {
      const at = now();
      const { sealer: s, records: r } = ready();
      const totals = { tenants: 0, sent: 0, failed: 0, retrying: 0, errors: 0 };
      try {
        for (const t of await activeTenants(db, at)) {
          totals.tenants++;
          try {
            const out = await dispatchTenant({ db, records: r, sealer: s, tenantId: t.id, now: at });
            totals.sent += out.sent; totals.failed += out.failed; totals.retrying += out.retrying;
          } catch {
            totals.errors++; // one company's problem must not stop the others
          }
        }
      } finally {
        if (!job?.payload?.once) {
          const next = new Date(at.getTime() + 60_000);
          await enqueue(db, { kind: 'integrations_dispatch', runAt: next, dedupeKey: `integrations_dispatch:${minuteKey(next)}`, maxAttempts: 1 });
        }
      }
      return totals;
    },

    async integrations_send({ db, job }) {
      const { sealer: s, records: r } = ready();
      if (!job.tenant_id || typeof job.payload?.outboxId !== 'string') return { skipped: true };
      return dispatchTenant({ db, records: r, sealer: s, tenantId: job.tenant_id, outboxId: job.payload.outboxId, now: now() });
    },

    async integrations_housekeeping({ db }) {
      const at = now();
      const { records: r } = ready();
      const tenants = (await db.query("SELECT id FROM tenants WHERE status = 'active'")).rows;
      let recovered = 0;
      let events = 0;
      for (const t of tenants) {
        recovered += await recoverStuck({ db, records: r, tenantId: t.id, now: at });
        events += await db.withTenant({ tenantId: t.id }, async (tx) => (await tx.query(
          "DELETE FROM integration_events WHERE tenant_id = $1 AND received_at < now() - interval '90 days'", [tx.tenantId])).rowCount);
      }
      return { recovered, events };
    },
  };
}

export const INTEGRATION_HANDLERS = createIntegrationHandlers();

/** Start the minute-by-minute dispatch chain and the hourly housekeeping (idempotent). */
export async function scheduleIntegrationJobs(db, at = new Date()) {
  await enqueue(db, { kind: 'integrations_dispatch', dedupeKey: `integrations_dispatch:${minuteKey(at)}`, maxAttempts: 1 });
  await enqueue(db, { kind: 'integrations_housekeeping', dedupeKey: 'integrations_housekeeping', maxAttempts: 3 });
}

/** Ask the worker to send one outbox record now. */
export function enqueueSend(q, tenantId, outboxId) {
  return enqueue(q, { kind: 'integrations_send', tenantId, payload: { outboxId }, dedupeKey: `integrations_send:${tenantId}:${outboxId}`, maxAttempts: 1 });
}
