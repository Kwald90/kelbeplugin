// Postgres job queue. Jobs are claimed with FOR UPDATE SKIP LOCKED, so any number of
// workers can run; failures retry with exponential backoff up to max_attempts.

/**
 * @param {{ query: Function }} q
 * @param {{ kind: string, payload?: object, tenantId?: string|null, runAt?: Date, maxAttempts?: number, dedupeKey?: string }} job
 * @returns {Promise<number|null>} job id, or null when an identical (dedupeKey) job is already waiting
 */
export async function enqueue(q, job) {
  const { rows } = await q.query(
    `INSERT INTO jobs_queue (kind, payload, tenant_id, run_at, max_attempts, dedupe_key)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
     RETURNING id`,
    [job.kind, job.payload || {}, job.tenantId || null, job.runAt || null, job.maxAttempts || 5, job.dedupeKey || null]);
  return rows[0]?.id ?? null;
}

/** Job kinds run by the QuickBooks worker pool only (docs/integrations/quickbooks.md 5.8). */
export const QBO_KIND_PATTERN = 'qbo\\_%';

/**
 * Claim the next due job, or null. `kinds` limits the claim to kinds matching any of these LIKE
 * patterns, `excludeKinds` skips kinds matching any of them (the general loop never takes qbo_*
 * jobs, the QuickBooks loop takes nothing else).
 * @param {{ kinds?: string[], excludeKinds?: string[] }} [opts]
 */
export async function claim(db, workerId, { kinds = null, excludeKinds = null } = {}) {
  const params = [workerId];
  let filter = '';
  if (Array.isArray(kinds) && kinds.length) { params.push(kinds); filter += ` AND kind LIKE ANY($${params.length}::text[])`; }
  if (Array.isArray(excludeKinds) && excludeKinds.length) { params.push(excludeKinds); filter += ` AND NOT (kind LIKE ANY($${params.length}::text[]))`; }
  const { rows } = await db.query(
    `UPDATE jobs_queue SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs_queue WHERE status = 'queued' AND run_at <= now()${filter}
                   ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, params);
  return rows[0] || null;
}

/** A long job is still alive: reclaimStuck (15 minutes) leaves it running. */
export async function heartbeat(db, jobId) {
  await db.query("UPDATE jobs_queue SET locked_at = now() WHERE id = $1 AND status = 'running'", [jobId]);
}

export async function complete(db, id) {
  await db.query("UPDATE jobs_queue SET status = 'done', finished_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1", [id]);
}

/** Retry later (10 s, 20 s, 40 s ... capped at 1 h) or give up after max_attempts. */
export async function fail(db, job, err) {
  const message = String(err?.message || err).slice(0, 1000);
  if (job.attempts >= job.max_attempts) {
    await db.query("UPDATE jobs_queue SET status = 'failed', finished_at = now(), locked_at = NULL, last_error = $2 WHERE id = $1", [job.id, message]);
    return 'failed';
  }
  const delayS = Math.min(3600, 10 * 2 ** (job.attempts - 1));
  await db.query(
    `UPDATE jobs_queue SET status = 'queued', locked_at = NULL, locked_by = NULL, last_error = $2, run_at = now() + make_interval(secs => $3) WHERE id = $1`,
    [job.id, message, delayS]);
  return 'retry';
}

/** Put jobs whose worker died back in the queue. */
export async function reclaimStuck(db, olderThanMinutes = 15) {
  const { rowCount } = await db.query(
    `UPDATE jobs_queue SET status = 'queued', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)`, [olderThanMinutes]);
  return rowCount;
}

/**
 * Job handlers. Each gets { db, job, log }. Anything touching tenant data must go
 * through db.withTenant().
 */
export const HANDLERS = {
  /** Delete sessions, reset links, sent emails and finished jobs that are past keeping. */
  async purge_expired(ctx) {
    const { db } = ctx;
    const r = {};
    r.sessions = (await db.query(
      `DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '7 days'
          OR last_seen_at + make_interval(secs => idle_timeout_s) < now() - interval '1 day'`)).rowCount;
    r.passwordResets = (await db.query("DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'")).rowCount;
    r.emails = (await db.query("DELETE FROM email_outbox WHERE status = 'sent' AND sent_at < now() - interval '7 days'")).rowCount;
    r.jobs = (await db.query("DELETE FROM jobs_queue WHERE status IN ('done', 'failed') AND finished_at < now() - interval '30 days'")).rowCount;
    return r;
  },
  /** Sync idempotency records older than 30 days, per tenant (RLS: one tenant at a time). */
  async purge_sync_mutations(ctx) {
    const { db } = ctx;
    const tenants = (await db.query('SELECT id FROM tenants')).rows;
    let n = 0;
    for (const t of tenants) {
      n += await db.withTenant({ tenantId: t.id }, async (tx) => (await tx.query(
        "DELETE FROM sync_mutations WHERE tenant_id = $1 AND created_at < now() - interval '30 days'", [tx.tenantId])).rowCount);
    }
    return { syncMutations: n };
  },
};

/** Recurring housekeeping, deduplicated so many workers enqueue it once. */
export async function scheduleRecurring(db) {
  await enqueue(db, { kind: 'purge_expired', dedupeKey: 'purge_expired', maxAttempts: 3 });
  await enqueue(db, { kind: 'purge_sync_mutations', dedupeKey: 'purge_sync_mutations', maxAttempts: 3 });
}

/**
 * Run at most one job. Returns what happened (for tests and logs).
 * @returns {Promise<null | { id: number, kind: string, outcome: 'done'|'retry'|'failed', result?: unknown }>}
 */
export async function runOnce(db, { workerId = 'worker', handlers = HANDLERS, log = console, kinds = null, excludeKinds = null } = {}) {
  const job = await claim(db, workerId, { kinds, excludeKinds });
  if (!job) return null;
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
    const result = await handler({ db, job, log });
    await complete(db, job.id);
    return { id: job.id, kind: job.kind, outcome: 'done', result };
  } catch (e) {
    const outcome = await fail(db, job, e);
    return { id: job.id, kind: job.kind, outcome, error: e.message };
  }
}
