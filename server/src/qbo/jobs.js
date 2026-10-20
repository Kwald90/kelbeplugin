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
import { syncTenant, enqueueContinuation, nextKey } from './engine.js';
import { runCheck } from './check.js';
import { refreshReference } from './reference.js';
import { scan, apply, enqueueApply } from './wizard.js';

const minuteKey = (d) => d.toISOString().slice(0, 16);
const HOUR = 3_600_000;
const CDC_EVERY_MS = 6 * HOUR;
const DAY = 24 * HOUR;
/** Setup phases that run in the apply chain: sync passes wait for it and never take its lease (6.4). */
const APPLY_PHASES = ['apply_queued', 'applying'];
/**
 * The QuickBooks jobs that hold the tenant lease and heartbeat every minute (tenantJob), plus the
 * one-minute dispatcher. A row of one of these still 'running' with no heartbeat for 3 minutes lost
 * its worker (a deploy's kill, an out-of-memory kill): the dispatcher puts it back (5.8).
 */
export const RECLAIM_KINDS = ['qbo_sync', 'qbo_cdc', 'qbo_check', 'qbo_reference_refresh', 'qbo_setup_scan', 'qbo_setup_apply', 'qbo_dispatch'];
const RECLAIM_AFTER_S = 180;
/** Jobs the dispatcher queues on a timer: a failure (or a pull stopped by a budget) backs them off. */
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * HOUR;

/** Back-off of a periodic job after `failures` failures in a row: 5 minutes, doubling, at most 6 hours. */
export const backoffMs = (failures) => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));

/** True while a periodic job of this kind is backed off for the connection. */
export function backedOff(conn, kind, at = new Date()) {
  const until = conn?.backoff?.[kind]?.until;
  return Boolean(until && Date.parse(until) > at.getTime());
}

/**
 * Record how a periodic job went (qbo_connections.backoff, 5.8): a success clears its back-off, a
 * failure doubles it, `until` sets it to a given time (a pull stopped by a budget waits for the hour).
 */
export async function noteBackoff(db, tenantId, kind, { ok = false, until = null } = {}) {
  await db.withTenant({ tenantId }, async (tx) => {
    const row = (await tx.query('SELECT backoff FROM qbo_connections WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows[0];
    if (!row) return;
    const all = { ...(row.backoff || {}) };
    if (ok && !until) { if (!all[kind]) return; delete all[kind]; }
    else if (until) all[kind] = { until: new Date(until).toISOString(), failures: all[kind]?.failures || 0 };
    else {
      const failures = (Number(all[kind]?.failures) || 0) + 1;
      all[kind] = { until: new Date(Date.now() + backoffMs(failures)).toISOString(), failures };
    }
    await tx.query('UPDATE qbo_connections SET backoff = $2 WHERE tenant_id = $1', [tenantId, JSON.stringify(all)]);
  }, { write: true }).catch(() => {});
}

/** The start of the next hour (a budget-stopped pull tries again then). */
const nextHour = (at = new Date()) => new Date(Math.floor(at.getTime() / HOUR) * HOUR + HOUR);

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

  /**
   * The common frame: QuickBooks on, tenant active, connection present, lease held, heartbeat.
   * `notDuringApply`: the job does nothing while the setup apply chain runs (it would only take the
   * lease the next apply chunk needs, 6.4).
   */
  async function tenantJob({ db, job }, fn, { states = ['active'], notDuringApply = false } = {}) {
    const d = ready(db);
    if (!qboCfg(d.config).enabled) return { skipped: 'QuickBooks is off on this server' };
    const tenantId = job.tenant_id || job.payload?.tenantId;
    if (!tenantId) return { skipped: 'no tenant' };
    const t = (await db.query('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0];
    if (!t || t.status !== 'active') return { skipped: 'tenant not active' };
    const conn = await db.withTenant({ tenantId }, loadConnection);
    if (!conn || !states.includes(conn.state)) return { skipped: conn?.state || 'not_connected' };
    if (notDuringApply && conn.state === 'active' && APPLY_PHASES.includes(conn.setup?.phase)) return { skipped: 'setup' };
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

  /** A periodic job: its outcome sets or clears its back-off (5.8); a throw is a failure. */
  async function periodic(db, job, kind, fn) {
    const tenantId = job.tenant_id || job.payload?.tenantId;
    let r;
    try { r = await fn(); } catch (e) {
      if (tenantId) await noteBackoff(db, tenantId, kind);
      throw e;
    }
    if (tenantId && r && !r.busy && !r.skipped) await noteBackoff(db, tenantId, kind, { ok: true });
    return r;
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
      const base = `qbo_sync:${job.tenant_id}`;
      const out = await tenantJob({ db, job }, async (d, id, epoch, conn) => {
        // The first pass after any move back to active runs the sweep (2.5): the resume paths queue
        // payload.sweep (W1) or reason hq_resume (W6), and a connection never swept has no cursor yet.
        const sweep = Boolean(job.payload?.sweep) || job.payload?.reason === 'hq_resume' || conn.fishtape_cursor == null;
        const r = await syncTenant(d, id, { epoch, sweep, direction: job.payload?.direction || 'both', workerId });
        if (r.stopped === 'throttled') {
          const until = await db.withTenant({ tenantId: id }, async (tx) => (await tx.query('SELECT throttled_until FROM qbo_connections WHERE tenant_id = $1', [id])).rows[0]?.throttled_until);
          await enqueue(db, { kind: 'qbo_sync', tenantId: id, dedupeKey: nextKey(base, job.dedupe_key), runAt: until ? new Date(new Date(until).getTime() + 1000) : new Date(Date.now() + 61_000), maxAttempts: 5 });
        } else if (r.sweepMore) {
          // The sweep stopped at its limit: the next pass sweeps on from where it got to (5.12).
          await enqueueContinuation(db, id, job.dedupe_key, { payload: { sweep: true } });
        } else if (r.more) await enqueueContinuation(db, id, job.dedupe_key);
        if (r.error) delete r.error;
        return r;
      }, { notDuringApply: true });
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
      return periodic(db, job, 'qbo_cdc', async () => {
        const r = await tenantJob({ db, job }, (d, id, epoch) => syncTenant(d, id, { epoch, direction: 'pull', purpose: 'cdc', workerId }), { notDuringApply: true });
        // Stopped by a read budget: the next try is in an hour, not on the next minute's dispatch (5.11).
        if (r && (r.stopped === 'budget' || r.pullSkipped)) {
          await noteBackoff(db, job.tenant_id || job.payload?.tenantId, 'qbo_cdc', { until: nextHour() });
          return { ...r, skipped: 'budget' };
        }
        return r;
      });
    },

    async qbo_check({ db, job }) {
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      return periodic(db, job, 'qbo_check', () => tenantJob({ db, job }, (d, id, epoch) => runCheck(d, id, { epoch }), { notDuringApply: true }));
    },

    async qbo_reference_refresh({ db, job }) {
      // The plan check (2.5): a company whose plan no longer has QuickBooks reads nothing from Intuit,
      // and an upgrade resumes it here as well (this job is queued daily for paused connections too).
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      // An HQ or plan pause stops every Intuit call; budget pauses are left to the client's own budget gate.
      return periodic(db, job, 'qbo_reference_refresh', () => tenantJob({ db, job }, (d, id, epoch, conn) => (conn.state === 'paused' && ['hq', 'plan'].includes(conn.pause_reason)
        ? { skipped: conn.pause_reason } : refreshReference(d, id, { epoch, force: Boolean(job.payload?.force) })), { states: ['setup', 'active', 'paused'] }));
    },

    async qbo_setup_scan({ db, job }) {
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      const out = await tenantJob({ db, job }, (d, id, epoch) => scan(d, id, { epoch }), { states: ['setup'] });
      // The lease was taken (a reference read, an API action): the scan runs shortly, never lost.
      if (out?.busy) await enqueue(db, { kind: 'qbo_setup_scan', tenantId: job.tenant_id, dedupeKey: nextKey(`qbo_setup_scan:${job.tenant_id}`, job.dedupe_key), runAt: new Date(Date.now() + 15_000), maxAttempts: 3 });
      return out;
    },

    async qbo_setup_apply({ db, job }) {
      // A plan that lost QuickBooks stops the apply here (the setup phase stays, so an upgrade resumes it).
      if (!(await planAllows(db, job))) return { skipped: 'plan' };
      const out = await periodic(db, job, 'qbo_setup_apply', () => tenantJob({ db, job }, async (d, id, epoch) => {
        const r = await apply(d, id, { epoch });
        if (r.more) await enqueueApply(db, id, { next: true, runningKey: job.dedupe_key });
        return r;
      }, { states: ['setup', 'active'] }));
      // The lease was taken between two chunks (a webhook's pass, an API action): the chain goes on shortly.
      if (out?.busy) await enqueueApply(db, job.tenant_id, { next: true, runningKey: job.dedupe_key, delayMs: 15_000 });
      return out;
    },

    async qbo_dispatch({ db, job }) {
      const d = ready(db);
      const at = deps.now ? deps.now() : new Date();
      try {
        if (!qboCfg(d.config).enabled) return { skipped: 'QuickBooks is off on this server' };
        return await dispatch(db, at, { writesEnabled: qboCfg(d.config).writesEnabled });
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
 * the work that is due. Suspended and closed tenants are never synced. Periodic jobs that keep
 * failing (or a pull a budget stopped) wait out their back-off. With writes off on the server
 * (QBO_WRITES=off) waiting outbox rows queue no pass: a pass could only pull, every minute, and spend
 * the read budget for nothing; webhooks, retries of pulls and the 6-hourly catch-up still run.
 * @param {{ writesEnabled?: boolean }} [o]
 */
export async function dispatch(db, at = new Date(), { writesEnabled = true } = {}) {
  // A QuickBooks job whose worker died (a deploy's kill) keeps its row 'running' and its dedupe key
  // taken; with no heartbeat for 3 minutes it is put back, so that company is not stuck for an hour.
  const reclaimed = (await db.query(
    `UPDATE jobs_queue SET status = 'queued', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND kind = ANY($1::text[]) AND locked_at < now() - make_interval(secs => $2)`,
    [RECLAIM_KINDS, RECLAIM_AFTER_S])).rowCount;
  const { rows } = await db.query("SELECT r.tenant_id FROM qbo_realms r JOIN tenants t ON t.id = r.tenant_id WHERE t.status = 'active'");
  const out = { tenants: rows.length, queued: 0, reclaimed };
  for (const { tenant_id: tenantId } of rows) {
    await db.withTenant({ tenantId }, async (tx) => {
      const c = await loadConnection(tx);
      if (!c) return;
      const busy = c.lease_until && new Date(c.lease_until) > at;
      if (c.state === 'setup' || c.state === 'active' || c.state === 'paused') {
        if ((!c.ref_refreshed_at || at - new Date(c.ref_refreshed_at) > DAY) && !backedOff(c, 'qbo_reference_refresh', at)) {
          if (await enqueue(tx, { kind: 'qbo_reference_refresh', tenantId, dedupeKey: `qbo_reference_refresh:${tenantId}`, maxAttempts: 3 })) out.queued++;
        }
      }
      // The apply chain is never lost (6.4): a setup being applied with no chunk queued or running
      // (a busy lease, a kill, a chunk that failed for good) gets its next chunk.
      if ((c.state === 'setup' || c.state === 'active') && APPLY_PHASES.includes(c.setup?.phase) && !busy && !backedOff(c, 'qbo_setup_apply', at)) {
        const alive = (await db.query("SELECT 1 FROM jobs_queue WHERE kind = 'qbo_setup_apply' AND tenant_id = $1 AND status IN ('queued', 'running') LIMIT 1", [tenantId])).rows.length > 0;
        if (!alive && await enqueueApply(tx, tenantId, { next: true, delayMs: 0 })) out.queued++;
      }
      if (c.state !== 'active') return;
      const { rows: due } = await tx.query(
        `SELECT EXISTS (SELECT 1 FROM qbo_outbox WHERE tenant_id = $1 AND not_before <= now() AND (claimed_until IS NULL OR claimed_until < now())) AS outbox,
                EXISTS (SELECT 1 FROM qbo_inbox WHERE tenant_id = $1 AND processed_at IS NULL) AS inbox,
                EXISTS (SELECT 1 FROM qbo_links WHERE tenant_id = $1 AND next_attempt_at IS NOT NULL AND next_attempt_at <= now() AND state IN ('pending', 'synced')) AS retry`, [tenantId]);
      const pushDue = writesEnabled !== false && (due[0].outbox || due[0].retry);
      if (!busy && !APPLY_PHASES.includes(c.setup?.phase) && (pushDue || due[0].inbox || c.dirty_at)) {
        if (await enqueueSync(tx, tenantId)) out.queued++;
      }
      if ((!c.last_pull_at || at - new Date(c.last_pull_at) > CDC_EVERY_MS) && !backedOff(c, 'qbo_cdc', at)) {
        if (await enqueue(tx, { kind: 'qbo_cdc', tenantId, dedupeKey: `qbo_cdc:${tenantId}`, maxAttempts: 3 })) out.queued++;
      }
      if ((!c.last_check_at || at - new Date(c.last_check_at) > DAY) && !backedOff(c, 'qbo_check', at)) {
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

/**
 * Start the one-minute dispatcher chain (idempotent; the worker calls it at start and hourly). The
 * next minute's link too: a killed worker's dispatch row may still hold this minute's key, and the
 * chain must not wait for the hourly reclaim to start again.
 */
export async function scheduleQboJobs(db, { config = null, at = new Date() } = {}) {
  const cfg = config ? qboCfg(config) : qboCfg(readConfig());
  if (!cfg.enabled) return;
  await enqueue(db, { kind: 'qbo_dispatch', dedupeKey: `qbo_dispatch:${minuteKey(at)}`, maxAttempts: 1 });
  const next = new Date(Math.floor(at.getTime() / 60_000) * 60_000 + 60_000);
  await enqueue(db, { kind: 'qbo_dispatch', runAt: next, dedupeKey: `qbo_dispatch:${minuteKey(next)}`, maxAttempts: 1 });
}
