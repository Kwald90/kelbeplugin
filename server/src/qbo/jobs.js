// QuickBooks job handlers (docs/integrations/quickbooks.md 5.4, 5.8, 5.13, 6), run by the worker's
// QuickBooks pool only (worker.js claims qbo_* there and nowhere else):
//   qbo_dispatch            every minute: which connected tenants have work (outbox, webhooks, retries,
//                           the 6-hourly CDC, the daily check and reference read), and month-start resumes
//   qbo_sync                one pass under the tenant lease; payload.sweep runs the Fishtape-side sweep first
//   qbo_cdc                 the 6-hourly pull (purpose cdc, stopped by the budgets)
//   qbo_check               the daily balance check (and the daily sweep and TaxAgency read)
//   qbo_reference_refresh   reference lists and features (at most every 5 minutes)
//   qbo_setup_scan, qbo_setup_apply   the wizard, in resumable chunks
// Every tenant-scoped handler takes the lease (no lease: the job ends; the holder or the dispatcher
// sees the new rows), heartbeats every 60 s so reclaimStuck never re-queues it, and works only on
// tenants whose status is active. Errors that leave the tenant carry only fixed-table messages.
import { readConfig } from '../config.js';
import { createSealer } from '../lib/crypto.js';
import { createValidator } from '../schemas.js';
import { createRecords } from '../services/records.js';
import { enqueue, heartbeat } from '../services/queue.js';
import { loadTenantPlan, tenantHas } from '../services/entitlements.js';
import { qboCfg } from './env.js';
import { QboError } from './client.js';
import { loadConnection, setPaused, enqueueSync } from './connection.js';
import { withLease } from './lease.js';
import { syncTenant, enqueueContinuation } from './engine.js';
import { runCheck } from './check.js';
import { refreshReference } from './reference.js';
import { scan, apply, enqueueApply } from './wizard.js';

const minuteKey = (d) => d.toISOString().slice(0, 16);
const HOUR = 3_600_000;
const CDC_EVERY_MS = 6 * HOUR;
const DAY = 24 * HOUR;

/** A job error that leaves the tenant: the fixed-table text only (5.8). */
function safeError(e) {
  if (e instanceof QboError) return new Error(e.message);
  if (e?.name === 'FencedError') return new Error('Another QuickBooks pass took over for this company.');
  return new Error('The QuickBooks job failed. Details are in the company sync log.');
}

/**
 * @param {{ db?, sealer?, config?, records?, workerId?, now? }} [deps] the worker passes its own; tests too
 */
export function createQboHandlers(deps = {}) {
  let { sealer, config, records } = deps;
  const ready = (db) => {
    config ??= readConfig();
    sealer ??= createSealer(config.secretsMasterKey);
    records ??= createRecords({ validator: createValidator(), config });
    return { db, sealer, config, records, log: deps.log, brakeLimit: deps.brakeLimit, client: deps.client };
  };
  const workerId = deps.workerId || 'qbo-worker';

  /** The common frame: QuickBooks on, tenant active, connection present, lease held, heartbeat. */
  async function tenantJob({ db, job }, fn, { states = ['active'] } = {}) {
    const d = ready(db);
    if (!qboCfg(d.config).enabled) return { skipped: 'QuickBooks is off on this server' };
    const tenantId = job.tenant_id || job.payload?.tenantId;
    if (!tenantId) return { skipped: 'no tenant' };
    const t = (await db.query('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (!t || t.status !== 'active') return { skipped: 'tenant not active' };
    const conn = await db.withTenant({ tenantId }, loadConnection);
    if (!conn || !states.includes(conn.state)) return { skipped: conn?.state || 'not_connected' };
    const beat = setInterval(() => { heartbeat(db, job.id).catch(() => {}); }, 60_000);
    beat.unref?.();
    try {
      const r = await withLease(db, tenantId, `${workerId}:${job.id}`, ({ epoch }) => fn(d, tenantId, epoch, conn));
      return r;
    } catch (e) {
      throw safeError(e);
    } finally {
      clearInterval(beat);
    }
  }

  /** Plan check at the start of a pass (2.5): below Pro pauses, an upgrade resumes. */
  async function planGate(db, tenantId, conn) {
    const plan = await loadTenantPlan(db, tenantId);
    const entitled = Boolean(plan && tenantHas(plan, 'quickbooks'));
    if (!entitled && ['active', 'setup'].includes(conn.state)) { await setPaused(db, tenantId, true, 'plan'); return false; }
    if (entitled && conn.state === 'paused' && conn.pause_reason === 'plan') { await setPaused(db, tenantId, false, 'plan'); return false; }
    return entitled;
  }

  /** The plan check before any pass that calls Intuit (2.5). False when the job should not run. */
  async function planAllows(db, job) {
    const tenantId = job.tenant_id || job.payload?.tenantId;
    if (!tenantId || !qboCfg(ready(db).config).enabled) return true;
    const pre = await db.withTenant({ tenantId }, loadConnection);
    return !(pre && ['active', 'setup', 'paused'].includes(pre.state) && !(await planGate(db, tenantId, pre)));
  }

  return {
    async qbo_sync({ db, job }) {
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      const wantSweep = Boolean(job.payload?.sweep) || job.payload?.reason === 'hq_resume';
      const out = await tenantJob({ db, job }, async (d, id, epoch, conn) => {
        // The first pass after any move back to active runs the sweep (2.5): the resume paths queue
        // payload.sweep (W1) or reason hq_resume (W6), and a connection never swept has no cursor yet.
        const sweep = Boolean(job.payload?.sweep) || job.payload?.reason === 'hq_resume' || conn.fishtape_cursor == null;
        const r = await syncTenant(d, id, { epoch, sweep, direction: job.payload?.direction || 'both', workerId });
        if (r.stopped === 'throttled') {
          const until = await db.withTenant({ tenantId: id }, async (tx) => (await tx.query('SELECT throttled_until FROM qbo_connections WHERE tenant_id = $1', [id])).rows[0]?.throttled_until);
          await enqueue(db, { kind: 'qbo_sync', tenantId: id, dedupeKey: `qbo_sync:${id}:cont`, runAt: until ? new Date(new Date(until).getTime() + 1000) : new Date(Date.now() + 61_000), maxAttempts: 5 });
        } else if (r.more) await enqueueContinuation(db, id);
        if (r.error) delete r.error;
        return r;
      });
      // A sweep that found the lease taken (an API action, a reference read) is not lost: it runs shortly.
      // Two keys in turn, as a running job keeps its own key taken.
      if (out?.busy && wantSweep) {
        const key = `qbo_sync:${job.tenant_id}:sweep`;
        await enqueue(db, { kind: 'qbo_sync', tenantId: job.tenant_id, payload: { sweep: true }, dedupeKey: job.dedupe_key === key ? `${key}2` : key, runAt: new Date(Date.now() + 30_000), maxAttempts: 5 });
      }
      return out;
    },

    async qbo_cdc({ db, job }) {
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      return tenantJob({ db, job }, (d, id, epoch) => syncTenant(d, id, { epoch, direction: 'pull', purpose: 'cdc', workerId }));
    },

    async qbo_check({ db, job }) {
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      return tenantJob({ db, job }, (d, id, epoch) => runCheck(d, id, { epoch }));
    },

    async qbo_reference_refresh({ db, job }) {
      // An HQ pause stops every Intuit call; budget pauses are left to the client's own budget gate.
      return tenantJob({ db, job }, (d, id, epoch, conn) => (conn.state === 'paused' && conn.pause_reason === 'hq'
        ? { skipped: 'hq' } : refreshReference(d, id, { epoch, force: Boolean(job.payload?.force) })), { states: ['setup', 'active', 'paused'] });
    },

    async qbo_setup_scan({ db, job }) {
      return tenantJob({ db, job }, (d, id, epoch) => scan(d, id, { epoch }), { states: ['setup'] });
    },

    async qbo_setup_apply({ db, job }) {
      return tenantJob({ db, job }, async (d, id, epoch) => {
        const r = await apply(d, id, { epoch });
        if (r.more) await enqueueApply(db, id, { next: true });
        return r;
      }, { states: ['setup', 'active'] });
    },

    async qbo_dispatch({ db, job }) {
      const d = ready(db);
      const at = deps.now ? deps.now() : new Date();
      try {
        if (!qboCfg(d.config).enabled) return { skipped: 'QuickBooks is off on this server' };
        return await dispatch(db, at);
      } finally {
        if (!job?.payload?.once && qboCfg(d.config).enabled) {
          const next = new Date(Math.floor(at.getTime() / 60_000) * 60_000 + 60_000);
          await enqueue(db, { kind: 'qbo_dispatch', runAt: next, dedupeKey: `qbo_dispatch:${minuteKey(next)}`, maxAttempts: 1 });
        }
      }
    },
  };
}

/**
 * The dispatcher (5.8): connected tenants (qbo_realms joined with active tenants), then per tenant
 * the work that is due. Suspended and closed tenants are never synced.
 */
export async function dispatch(db, at = new Date()) {
  const { rows } = await db.query("SELECT r.tenant_id FROM qbo_realms r JOIN tenants t ON t.id = r.tenant_id WHERE t.status = 'active'");
  const out = { tenants: rows.length, queued: 0 };
  for (const { tenant_id: tenantId } of rows) {
    await db.withTenant({ tenantId }, async (tx) => {
      const c = await loadConnection(tx);
      if (!c) return;
      if (c.state === 'setup' || c.state === 'active' || c.state === 'paused') {
        if (!c.ref_refreshed_at || at - new Date(c.ref_refreshed_at) > DAY) {
          if (await enqueue(tx, { kind: 'qbo_reference_refresh', tenantId, dedupeKey: `qbo_reference_refresh:${tenantId}`, maxAttempts: 3 })) out.queued++;
        }
      }
      if (c.state !== 'active') return;
      const { rows: due } = await tx.query(
        `SELECT EXISTS (SELECT 1 FROM qbo_outbox WHERE tenant_id = $1 AND not_before <= now() AND (claimed_until IS NULL OR claimed_until < now())) AS outbox,
                EXISTS (SELECT 1 FROM qbo_inbox WHERE tenant_id = $1 AND processed_at IS NULL) AS inbox,
                EXISTS (SELECT 1 FROM qbo_links WHERE tenant_id = $1 AND next_attempt_at IS NOT NULL AND next_attempt_at <= now() AND state IN ('pending', 'synced')) AS retry`, [tenantId]);
      const busy = c.lease_until && new Date(c.lease_until) > at;
      if (!busy && (due[0].outbox || due[0].inbox || due[0].retry || c.dirty_at)) {
        if (await enqueueSync(tx, tenantId)) out.queued++;
      }
      if (!c.last_pull_at || at - new Date(c.last_pull_at) > CDC_EVERY_MS) {
        if (await enqueue(tx, { kind: 'qbo_cdc', tenantId, dedupeKey: `qbo_cdc:${tenantId}`, maxAttempts: 3 })) out.queued++;
      }
      if (!c.last_check_at || at - new Date(c.last_check_at) > DAY) {
        if (await enqueue(tx, { kind: 'qbo_check', tenantId, dedupeKey: `qbo_check:${tenantId}`, maxAttempts: 2 })) out.queued++;
      }
    }).then(async () => {
      // Budget pauses end on the 1st (UTC) (5.11).
      const c = await db.withTenant({ tenantId }, loadConnection);
      if (c?.state === 'paused' && ['budget', 'tenant_budget'].includes(c.pause_reason) && c.paused_since
        && new Date(c.paused_since).toISOString().slice(0, 7) < at.toISOString().slice(0, 7)) {
        await setPaused(db, tenantId, false, c.pause_reason).catch(() => {});
      }
    }).catch(() => {});
  }
  return out;
}

export const QBO_HANDLERS = createQboHandlers();

/** Start the one-minute dispatcher chain (idempotent; the worker calls it hourly). */
export async function scheduleQboJobs(db, { config = null, at = new Date() } = {}) {
  const cfg = config ? qboCfg(config) : qboCfg(readConfig());
  if (!cfg.enabled) return;
  await enqueue(db, { kind: 'qbo_dispatch', dedupeKey: `qbo_dispatch:${minuteKey(at)}`, maxAttempts: 1 });
}
