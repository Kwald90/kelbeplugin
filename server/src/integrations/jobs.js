// Worker jobs for integrations (registered in src/worker.js):
//   integrations_dispatch      every minute: send due outbox email/SMS for every company that can
//   integrations_send          right away, one outbox record (invoice/estimate emails)
//   integrations_housekeeping  hourly: recover stuck sends, forget webhook event ids after 90 days,
//                              and queue again the Stripe reads for the books that never finished
//   stripe_fee_fetch           after a Stripe payment: its fee, net and charge onto payments.stripe
//   stripe_payout_fetch        after a payout webhook: the payout and its balance transactions into
//                              stripe_payouts (then queued for QuickBooks, payments.js)
// The two Stripe reads run only for a company on QuickBooks (payments.js booksInQbo).
// Each dispatch run enqueues the next one for the following minute (dedupe key per minute,
// so many workers still schedule it once).
import { readConfig } from '../config.js';
import { createSealer } from '../lib/crypto.js';
import { createValidator } from '../schemas.js';
import { createRecords } from '../services/records.js';
import { enqueue } from '../services/queue.js';
import { tenantHas } from '../services/entitlements.js';
import { qboEnabled } from '../qbo/alerts.js';
import { dispatchTenant, recoverStuck } from './outbox.js';
import { ProviderError } from './http.js';
import { PAYMENT_INTENT_RE, PAYOUT_RE, fetchPayout, fetchPayoutTransactions, fetchStripeFee } from './stripe.js';
import { booksInQbo, enqueueFeeFetch, feeFetchKey, recordStripePayout } from './payments.js';
import { providerSecrets, setStatus, systemPrincipal, systemWho } from './state.js';

const minuteKey = (d) => d.toISOString().slice(0, 16);
// The catch-up asks Stripe again about one payment or payout at most this often, for this long.
const RETRY_HOURS = 6;
const LOOKBACK_DAYS = 90;

/**
 * @param {{ sealer?: object, records?: object, now?: () => Date, env?: object }} [deps] tests pass their own
 */
export function createIntegrationHandlers(deps = {}) {
  let sealer = deps.sealer;
  let records = deps.records;
  const now = deps.now || (() => new Date());
  const env = () => deps.env || process.env;
  const ready = () => {
    sealer ??= createSealer(readConfig().secretsMasterKey);
    records ??= createRecords({ validator: createValidator() });
    return { sealer, records };
  };

  async function activeTenants(db, at) {
    const { rows } = await db.query("SELECT id, plan, plan_overrides, trial_ends_at FROM tenants WHERE status = 'active' ORDER BY id");
    return rows.filter((t) => tenantHas(t, 'integrations.email', at) || tenantHas(t, 'integrations.sms', at));
  }

  /**
   * Stripe reads for the books that never finished: a fee read or a payout itemisation refused
   * (a restricted key without the read permissions, fixed later) or given up after Stripe errors.
   * Queues them again for every company on QuickBooks with a Stripe key: Stripe payments of the
   * last 90 days with no fee, and paid automatic payouts with no balance transactions. One item is
   * asked about at most once every 6 hours (its last job, by dedupe key).
   */
  async function booksCatchUp(db, tenants) {
    const out = { fees: 0, payouts: 0 };
    if (!tenants.length) return out;
    const { sealer: s } = ready();
    const recent = new Set((await db.query(
      `SELECT dedupe_key FROM jobs_queue WHERE kind IN ('stripe_fee_fetch', 'stripe_payout_fetch') AND dedupe_key IS NOT NULL
          AND (status IN ('queued', 'running') OR finished_at > now() - make_interval(hours => $1))`, [RETRY_HOURS])).rows.map((r) => r.dedupe_key));
    for (const t of tenants) {
      try {
        await db.withTenant({ tenantId: t.id }, async (tx) => {
          if (!(await booksInQbo(tx, env()))) return;
          if (!(await providerSecrets(tx, s, 'stripe'))['stripe.secret_key']) return;
          const fees = (await tx.query(
            `SELECT id FROM payments WHERE tenant_id = $1 AND deleted_at IS NULL AND created_at > now() - make_interval(days => $2)
                AND data->>'source' = 'stripe' AND data->'stripe'->>'paymentIntentId' ~ '^pi_[A-Za-z0-9]{8,64}$'
                AND jsonb_typeof(data->'stripe'->'feeCents') IS DISTINCT FROM 'number'
              ORDER BY created_at LIMIT 200`, [tx.tenantId, LOOKBACK_DAYS])).rows;
          for (const r of fees) {
            if (!recent.has(feeFetchKey(tx.tenantId, r.id)) && await enqueueFeeFetch(tx, tx.tenantId, r.id, 0)) out.fees++;
          }
          const payouts = (await tx.query(
            `SELECT payout_id FROM stripe_payouts WHERE tenant_id = $1 AND status = 'paid' AND automatic AND balance_txns = '[]'::jsonb
                AND arrival_date > current_date - $2::int
              ORDER BY arrival_date LIMIT 50`, [tx.tenantId, LOOKBACK_DAYS])).rows;
          for (const r of payouts) {
            if (!recent.has(payoutFetchKey(tx.tenantId, r.payout_id)) && await enqueuePayoutFetch(tx, tx.tenantId, r.payout_id)) out.payouts++;
          }
        }, { write: true });
      } catch {
        out.errors = (out.errors || 0) + 1; // one company's problem must not stop the others
      }
    }
    return out;
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
      // With QuickBooks off on this server no QuickBooks table is read (contract 2.1).
      const books = qboEnabled(env()) ? await booksCatchUp(db, tenants) : {};
      return { recovered, events, ...books };
    },

    async stripe_fee_fetch({ db, job }) {
      const { sealer: s, records: r } = ready();
      const tenantId = job.tenant_id;
      const paymentId = job.payload?.paymentId;
      if (!tenantId || typeof paymentId !== 'string') return { skipped: true };
      const pre = await db.withTenant({ tenantId }, async (tx) => ({
        books: await booksInQbo(tx, env()),
        key: (await providerSecrets(tx, s, 'stripe'))['stripe.secret_key'],
        pay: (await tx.query('SELECT data FROM payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, paymentId])).rows[0]?.data,
      }));
      const intent = pre.pay?.stripe?.paymentIntentId;
      if (!pre.pay || pre.pay.source !== 'stripe' || !intent) return { skipped: 'not a Stripe payment' };
      if (!PAYMENT_INTENT_RE.test(intent)) return { skipped: 'not a Stripe payment reference' }; // retrying cannot help
      if (Number.isInteger(pre.pay.stripe.feeCents)) return { skipped: 'fee known' };
      if (!pre.books) return { skipped: 'QuickBooks not connected' };
      if (!pre.key) return { skipped: 'Stripe not connected' };
      const fee = await stripeCall(db, tenantId, () => fetchStripeFee(pre.key, intent));
      if (!fee) return { failed: true };
      const p = systemPrincipal(tenantId, 'stripe', 'Stripe');
      return db.withTenant({ tenantId }, async (tx) => {
        const cur = (await tx.query('SELECT data FROM payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE', [tx.tenantId, paymentId])).rows[0]?.data;
        if (!cur || Number.isInteger(cur.stripe?.feeCents)) return { skipped: 'changed meanwhile' };
        // feeCurrency lets the books skip a fee that is not in CAD.
        await r.patchRecord(tx, p, 'payments', paymentId, {
          stripe: { ...cur.stripe, chargeId: fee.chargeId, balanceTransactionId: fee.balanceTransactionId, feeCents: fee.feeCents, netCents: fee.netCents, feeCurrency: fee.currency.toUpperCase().slice(0, 3) || null },
        }, {}, systemWho(p));
        return { feeCents: fee.feeCents };
      }, { write: true });
    },

    async stripe_payout_fetch({ db, job }) {
      const { sealer: s } = ready();
      const tenantId = job.tenant_id;
      const payoutId = job.payload?.payoutId;
      if (!tenantId || typeof payoutId !== 'string' || !PAYOUT_RE.test(payoutId)) return { skipped: true };
      const pre = await db.withTenant({ tenantId }, async (tx) => ({
        books: await booksInQbo(tx, env()),
        key: (await providerSecrets(tx, s, 'stripe'))['stripe.secret_key'],
      }));
      if (!pre.books) return { skipped: 'QuickBooks not connected' };
      const { key } = pre;
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
 * A Stripe read for a job (only for a company on QuickBooks, which needs the read permissions).
 * A refused key marks the Stripe card in error and gives up (null); the hourly catch-up asks
 * again later. Anything else is thrown, so the queue retries with backoff.
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

const payoutFetchKey = (tenantId, payoutId) => `stripe_payout_fetch:${tenantId}:${payoutId}`;

/** Ask the worker to read a payout and what it paid out (after a payout webhook, or the catch-up). */
export function enqueuePayoutFetch(q, tenantId, payoutId) {
  return enqueue(q, { kind: 'stripe_payout_fetch', tenantId, payload: { payoutId }, maxAttempts: 8, dedupeKey: payoutFetchKey(tenantId, payoutId) });
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
