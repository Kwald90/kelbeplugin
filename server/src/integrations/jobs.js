// Worker jobs for integrations (registered in src/worker.js):
//   integrations_dispatch      every minute: send due outbox email/SMS for every company that can
//   integrations_send          right away, one outbox record (invoice/estimate emails)
//   integrations_housekeeping  hourly: recover stuck sends, forget webhook event ids after 90 days
//   stripe_fee_fetch           after a Stripe payment: its fee, net and charge onto payments.stripe
//   stripe_payout_fetch        after a payout webhook: the payout and its balance transactions into
//                              stripe_payouts (then queued for QuickBooks, payments.js)
// Each dispatch run enqueues the next one for the following minute (dedupe key per minute,
// so many workers still schedule it once).
import { readConfig } from '../config.js';
import { createSealer } from '../lib/crypto.js';
import { createValidator } from '../schemas.js';
import { createRecords } from '../services/records.js';
import { enqueue } from '../services/queue.js';
import { tenantHas } from '../services/entitlements.js';
import { dispatchTenant, recoverStuck } from './outbox.js';
import { ProviderError } from './http.js';
import { PAYOUT_RE, fetchPayout, fetchPayoutTransactions, fetchStripeFee } from './stripe.js';
import { recordStripePayout } from './payments.js';
import { providerSecrets, setStatus, systemPrincipal, systemWho } from './state.js';

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

    async stripe_fee_fetch({ db, job }) {
      const { sealer: s, records: r } = ready();
      const tenantId = job.tenant_id;
      const paymentId = job.payload?.paymentId;
      if (!tenantId || typeof paymentId !== 'string') return { skipped: true };
      const pre = await db.withTenant({ tenantId }, async (tx) => ({
        key: (await providerSecrets(tx, s, 'stripe'))['stripe.secret_key'],
        pay: (await tx.query('SELECT data FROM payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, paymentId])).rows[0]?.data,
      }));
      const intent = pre.pay?.stripe?.paymentIntentId;
      if (!pre.pay || pre.pay.source !== 'stripe' || !intent) return { skipped: 'not a Stripe payment' };
      if (Number.isInteger(pre.pay.stripe.feeCents)) return { skipped: 'fee known' };
      if (!pre.key) return { skipped: 'Stripe not connected' };
      const fee = await stripeCall(db, tenantId, () => fetchStripeFee(pre.key, intent));
      if (!fee) return { failed: true };
      const p = systemPrincipal(tenantId, 'stripe', 'Stripe');
      return db.withTenant({ tenantId }, async (tx) => {
        const cur = (await tx.query('SELECT data FROM payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE', [tx.tenantId, paymentId])).rows[0]?.data;
        if (!cur || Number.isInteger(cur.stripe?.feeCents)) return { skipped: 'changed meanwhile' };
        await r.patchRecord(tx, p, 'payments', paymentId, {
          stripe: { ...cur.stripe, chargeId: fee.chargeId, balanceTransactionId: fee.balanceTransactionId, feeCents: fee.feeCents, netCents: fee.netCents },
        }, {}, systemWho(p));
        return { feeCents: fee.feeCents };
      }, { write: true });
    },

    async stripe_payout_fetch({ db, job }) {
      const { sealer: s } = ready();
      const tenantId = job.tenant_id;
      const payoutId = job.payload?.payoutId;
      if (!tenantId || typeof payoutId !== 'string' || !PAYOUT_RE.test(payoutId)) return { skipped: true };
      const key = await db.withTenant({ tenantId }, async (tx) => (await providerSecrets(tx, s, 'stripe'))['stripe.secret_key']);
      if (!key) return { skipped: 'Stripe not connected' };
      const payout = await stripeCall(db, tenantId, () => fetchPayout(key, payoutId));
      if (!payout) return { failed: true };
      // Only an automatic payout can be listed by its balance transactions (Stripe's rule).
      let balanceTxns;
      if (payout.automatic && payout.status === 'paid') {
        balanceTxns = await stripeCall(db, tenantId, () => fetchPayoutTransactions(key, payoutId));
        if (!balanceTxns) return { failed: true };
      }
      return db.withTenant({ tenantId }, (tx) => recordStripePayout(tx, { id: payoutId, ...payout, ...(balanceTxns ? { balanceTxns } : {}) }), { write: true });
    },
  };
}

/**
 * A Stripe read for a job. A refused key marks the Stripe card in error and gives up (null);
 * anything else is thrown, so the queue retries with backoff.
 */
async function stripeCall(db, tenantId, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ProviderError) || e.kind !== 'auth') throw e;
    await db.withTenant({ tenantId }, (tx) => setStatus(tx, 'stripe', 'error', e.message), { write: true });
    return null;
  }
}

/** Ask the worker to read a payout and what it paid out (after a payout webhook). */
export function enqueuePayoutFetch(q, tenantId, payoutId) {
  return enqueue(q, { kind: 'stripe_payout_fetch', tenantId, payload: { payoutId }, maxAttempts: 8, dedupeKey: `stripe_payout_fetch:${tenantId}:${payoutId}` });
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
