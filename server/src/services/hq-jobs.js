// Worker jobs for HQ. src/worker.js runs these next to the handlers in services/queue.js.
import { isUuid } from '../db.js';
import { appendAudit } from './audit.js';
import { enqueue } from './queue.js';

const WORKER = { type: 'system', id: 'worker', label: 'Fishtape worker' };

/** Queue the purge for a closed company. One job per deletion request (key includes the time). */
export function enqueuePurge(q, tenantId, deleteAfter) {
  const at = new Date(deleteAfter);
  return enqueue(q, { kind: 'tenant_purge', payload: { tenantId }, runAt: at, maxAttempts: 5, dedupeKey: `tenant_purge:${tenantId}:${at.getTime()}` });
}

export const HQ_HANDLERS = {
  /**
   * Delete a company for good once its deletion grace period is over. purge_tenant()
   * re-checks that it is still closed and due, so a restored company is left alone.
   * The company's audit chain stays (no foreign key) as the record of what happened.
   */
  async tenant_purge({ db, job }) {
    const tenantId = job.payload?.tenantId;
    if (!isUuid(tenantId)) throw new Error('tenant_purge: payload.tenantId must be a uuid');
    const { rows } = await db.query('SELECT purge_tenant($1) AS purged', [tenantId]);
    const purged = Boolean(rows[0]?.purged);
    if (purged) {
      await db.tx((c) => appendAudit(c, null, {
        actor: WORKER, action: 'tenant.purged', collection: 'tenants', recordId: tenantId,
        summary: 'Company and its data deleted after the deletion grace period',
      }));
    }
    return { purged };
  },
};
