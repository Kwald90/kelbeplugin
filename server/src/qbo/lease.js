// One QuickBooks worker per tenant, fenced (docs/integrations/quickbooks.md 5.8). Every tenant-scoped
// qbo_* job and every API action that writes takes the lease on qbo_connections: lease_until moves
// two minutes ahead and lease_epoch goes up by one. Every transaction that writes links, the outbox,
// conflicts, candidates or Fishtape records first checks the epoch (assertEpoch) and rolls back when
// another holder took over, or when a pause, a reconnect-needed or a disconnect fenced the pass.
// Epochs are compared by equality only: HQ fences with a clock value (W6).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown inside a write transaction when the job no longer holds the tenant's lease. */
export class FencedError extends Error {
  constructor() {
    super('Another QuickBooks pass took over for this company.');
    this.name = 'FencedError';
    this.code = 'qbo_fenced';
  }
}

/**
 * Take the tenant's lease. Waits up to `waitMs` (API actions wait 10 s, jobs do not wait).
 * @returns {Promise<{ epoch: number } | null>} null when someone else holds it
 */
export async function acquireLease(db, tenantId, workerId, { waitMs = 0, pollMs = 250 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await db.withTenant({ tenantId }, (tx) => tx.query(
      `UPDATE qbo_connections SET lease_until = now() + interval '2 minutes', lease_by = $2, lease_epoch = lease_epoch + 1
        WHERE tenant_id = $1 AND (lease_until IS NULL OR lease_until < now()) RETURNING lease_epoch`,
      [tenantId, String(workerId || 'worker').slice(0, 200)]));
    if (rows[0]) return { epoch: Number(rows[0].lease_epoch) };
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Keep the lease while working (every 30 s). False when it was lost (fenced or taken over). */
export async function renewLease(db, tenantId, epoch) {
  const { rowCount } = await db.withTenant({ tenantId }, (tx) => tx.query(
    "UPDATE qbo_connections SET lease_until = now() + interval '2 minutes' WHERE tenant_id = $1 AND lease_epoch = $2", [tenantId, epoch]));
  return rowCount > 0;
}

/**
 * In a write transaction: hold the connection row (FOR SHARE) and check the epoch. Throws
 * FencedError, which rolls the transaction back, when it is not the job's epoch.
 */
export async function assertEpoch(tx, tenantId, epoch) {
  const { rows } = await tx.query('SELECT lease_epoch FROM qbo_connections WHERE tenant_id = $1 FOR SHARE', [tenantId]);
  if (!rows[0] || Number(rows[0].lease_epoch) !== Number(epoch)) throw new FencedError();
}

/** Give the lease back (only if still ours). */
export async function releaseLease(db, tenantId, epoch) {
  await db.withTenant({ tenantId }, (tx) => tx.query(
    'UPDATE qbo_connections SET lease_until = NULL, lease_by = NULL WHERE tenant_id = $1 AND lease_epoch = $2', [tenantId, epoch])).catch(() => {});
}

/**
 * Run fn while holding the lease, renewing it every 30 s. Returns { busy: true } without running
 * fn when the lease is held elsewhere. fn gets { epoch, alive() }.
 */
export async function withLease(db, tenantId, workerId, fn, { waitMs = 0, renewMs = 30_000 } = {}) {
  const lease = await acquireLease(db, tenantId, workerId, { waitMs });
  if (!lease) return { busy: true };
  let alive = true;
  const timer = setInterval(() => {
    renewLease(db, tenantId, lease.epoch).then((ok) => { if (!ok) alive = false; }).catch(() => {});
  }, renewMs);
  timer.unref?.();
  try {
    return await fn({ epoch: lease.epoch, alive: () => alive });
  } finally {
    clearInterval(timer);
    await releaseLease(db, tenantId, lease.epoch);
  }
}
