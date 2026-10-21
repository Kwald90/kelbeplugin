// Invoice balances and payments recorded from Stripe. Totals use the PWA's own document
// maths (electrical-app/js/lib/money.js) so the server and the app always agree.
//
// The amount due is one seam (amountDueCents): total − payments + any registered adjustment.
// The QuickBooks sync registers one at start-up (docs/integrations/quickbooks.md 4.9, "Amount
// due"), so an invoice whose QuickBooks tax differs by a cent is charged and settled at the
// QuickBooks total. Stripe payouts land in stripe_payouts and wait in the QuickBooks outbox.
// Stripe is read for the books (fees, payout items) only for a company that has connected
// QuickBooks on a server where QuickBooks is on (booksInQbo); nothing else changes for the rest.
import { docTotals } from '../../../electrical-app/js/lib/money.js';
import { ID_RE } from '../services/records.js';
import { notify } from '../services/notify.js';
import { enqueue } from '../services/queue.js';
import { qboEnabled } from '../qbo/alerts.js';
import { PAYOUT_RE, payoutStatus } from './stripe.js';
import { invoiceClientId, queueClientRecheck } from '../services/receivables.js';

/** Company time zone by province, for the payment's date (YYYY-MM-DD). */
const ZONES = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto',
  QC: 'America/Toronto', NB: 'America/Moncton', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns',
  YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit',
};

export function localDate(when, province) {
  const zone = ZONES[province] || 'America/Toronto';
  return new Date(when).toLocaleDateString('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

export async function companySettings(tx) {
  const { rows } = await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  return rows[0]?.data || {};
}

// ---- amount due ---------------------------------------------------------------------

const adjusters = new Set();

/**
 * Add an amount-due adjustment: fn(tx, invoiceId) resolves to cents added to what is owing
 * (negative lowers it). The QuickBooks sync registers one at start-up. Returns a function
 * that removes it again (tests).
 */
export function registerAmountDueAdjuster(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerAmountDueAdjuster needs a function');
  adjusters.add(fn);
  return () => { adjusters.delete(fn); };
}

async function adjustmentCents(tx, invoiceId) {
  let n = 0;
  for (const fn of adjusters) {
    const v = await fn(tx, invoiceId);
    if (Number.isInteger(v)) n += v;
  }
  return n;
}

async function paidCents(tx, invoiceId) {
  const { rows } = await tx.query(
    `SELECT COALESCE(sum((data->>'amountCents')::bigint), 0)::bigint AS cents FROM payments
      WHERE tenant_id = $1 AND invoice_id = $2 AND deleted_at IS NULL`, [tx.tenantId, invoiceId]);
  return Number(rows[0].cents) || 0;
}

/** The parts of the amount due: docTotals total, payments, adjustment and what is still owing. */
async function dueParts(tx, invoice) {
  const totalCents = docTotals(invoice).totalCents;
  const paid = await paidCents(tx, invoice.id);
  const adjustment = await adjustmentCents(tx, invoice.id);
  return { totalCents, paidCents: paid, adjustmentCents: adjustment, dueCents: totalCents - paid + adjustment };
}

/** What is still owing on an invoice (an object with its id): docTotals total − payments + adjustment. */
export async function amountDueCents(tx, invoice) {
  return (await dueParts(tx, invoice)).dueCents;
}

/**
 * The invoice with its total, what has been paid and the balance (the amount due, which the pay
 * link charges), or null when it doesn't exist.
 */
export async function invoiceBalance(tx, invoiceId) {
  if (typeof invoiceId !== 'string' || !ID_RE.test(invoiceId)) return null;
  const { rows } = await tx.query('SELECT id, data, version FROM invoices WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, invoiceId]);
  if (!rows[0]) return null;
  const invoice = { ...rows[0].data, id: rows[0].id, version: rows[0].version };
  const { dueCents, ...parts } = await dueParts(tx, invoice);
  return { invoice, ...parts, balanceCents: dueCents };
}

/** Same rule as syncInvoiceStatus in the PWA (modules/invoices.js), on the amount due; void is never touched. */
export async function refreshInvoiceStatus(tx, records, p, who, invoiceId) {
  const b = await invoiceBalance(tx, invoiceId);
  if (!b || b.invoice.status === 'void') return b;
  let next = b.invoice.status;
  if (b.paidCents > 0 && b.balanceCents <= 0) next = 'paid';
  else if (b.paidCents > 0) next = 'partial';
  if (next !== b.invoice.status) await records.patchRecord(tx, p, 'invoices', invoiceId, { status: next }, {}, who);
  return { ...b, status: next };
}

// ---- the books ----------------------------------------------------------------------

/**
 * The company's QuickBooks connection row ({ state }), or null when QuickBooks is off on this
 * server (QBO_ENVIRONMENT unset: no QuickBooks table is read, contract 2.1) or the company never
 * connected it. Stripe fees and payout items are read only when this is set, so a company that
 * does not use QuickBooks never needs the read permissions on its restricted key.
 */
export async function booksInQbo(tx, env = process.env) {
  if (!qboEnabled(env)) return null;
  return (await tx.query('SELECT state FROM qbo_connections WHERE tenant_id = $1', [tx.tenantId])).rows[0] || null;
}

// ---- Stripe payments ------------------------------------------------------------------

export const feeFetchKey = (tenantId, paymentId) => `stripe_fee_fetch:${tenantId}:${paymentId}`;

/**
 * Ask the worker to read the payment's Stripe fee (integrations/jobs.js stripe_fee_fetch).
 * Stripe settles a card fee within seconds; two minutes leaves room (`delayMs` 0 for the
 * hourly catch-up).
 */
export function enqueueFeeFetch(q, tenantId, paymentId, delayMs = 120_000) {
  return enqueue(q, {
    kind: 'stripe_fee_fetch', tenantId, payload: { paymentId }, runAt: new Date(Date.now() + delayMs),
    maxAttempts: 8, dedupeKey: feeFetchKey(tenantId, paymentId),
  });
}

/**
 * Record a completed Checkout Session as a payments record (once: the record id is derived
 * from the PaymentIntent, so a second event for the same payment changes nothing).
 * @returns {Promise<{ recorded: boolean, paymentId: string|null, reason?: string }>}
 */
export async function recordStripePayment(tx, records, p, who, session, eventId) {
  const invoiceId = session?.metadata?.fishtape_invoice;
  const amountCents = session?.amount_total;
  if (typeof invoiceId !== 'string' || !ID_RE.test(invoiceId)) return { recorded: false, paymentId: null, reason: 'no invoice' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { recorded: false, paymentId: null, reason: 'no amount' };
  const ref = typeof session.payment_intent === 'string' ? session.payment_intent : session.id;
  const paymentId = `stripe-${ref}`.slice(0, 128);
  if (!ID_RE.test(paymentId)) return { recorded: false, paymentId: null, reason: 'bad id' };
  const exists = await tx.query('SELECT 1 FROM payments WHERE tenant_id = $1 AND id = $2', [tx.tenantId, paymentId]);
  if (exists.rows.length) return { recorded: false, paymentId, reason: 'duplicate' };
  const settings = await companySettings(tx);
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  await records.createRecord(tx, p, 'payments', {
    id: paymentId,
    invoiceId,
    amountCents,
    date: localDate((session.created || Date.now() / 1000) * 1000, settings.company?.province),
    method: 'card',
    reference: String(ref).slice(0, 200),
    source: 'stripe',
    currency: typeof session.currency === 'string' ? session.currency.toUpperCase().slice(0, 3) : null,
    stripe: { checkoutSessionId: String(session.id || '').slice(0, 200), paymentIntentId, eventId: String(eventId || '').slice(0, 200), livemode: Boolean(session.livemode) },
  }, who);
  await refreshInvoiceStatus(tx, records, p, who, invoiceId);
  // The client's past-due hold may lift now (docs/releases/r1-get-paid.md 10.1).
  await queueClientRecheck(tx, await invoiceClientId(tx, invoiceId));
  await notify(tx, { perm: 'invoices', kind: 'payment', title: `Card payment of $${(amountCents / 100).toFixed(2)} received online`, link: `#/invoices/${invoiceId}`, ref: `payment:${paymentId}` });
  // The fee (stripe.feeCents and friends) is filled in by the worker, for the books. Payments made
  // before QuickBooks was connected are picked up by the hourly catch-up (jobs.js).
  if (paymentIntentId && await booksInQbo(tx)) await enqueueFeeFetch(tx, tx.tenantId, paymentId);
  return { recorded: true, paymentId };
}

// ---- Stripe payouts -------------------------------------------------------------------

/** A Stripe payout object (webhook) in the shape recordStripePayout takes. */
export function payoutFromStripe(po) {
  return {
    id: po?.id, amountCents: po?.amount, currency: po?.currency, status: po?.status, automatic: po?.automatic !== false,
    livemode: Boolean(po?.livemode), arrivalDate: Number.isFinite(po?.arrival_date) ? new Date(po.arrival_date * 1000).toISOString().slice(0, 10) : null,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKED_TYPES = new Set(['charge', 'payment']);
// A later event never takes a payout back: failed and canceled are final, and paid only gives way to failed.
const RANK = { pending: 0, paid: 1, failed: 2, canceled: 2 };

function nextStatus(prev, incoming) {
  if (!prev) return incoming;
  if (prev === 'failed' || prev === 'canceled') return prev;
  return RANK[incoming] >= RANK[prev] ? incoming : prev;
}

/** Balance transactions as stripe_payouts keeps them: money, types and ids only. */
function cleanTxns(list) {
  return list.slice(0, 5000).map((t) => ({
    id: String(t.id).slice(0, 100), type: String(t.type || 'other').slice(0, 40),
    amountCents: Number.isInteger(t.amountCents) ? t.amountCents : 0, feeCents: Number.isInteger(t.feeCents) ? t.feeCents : 0,
    paymentIntentId: typeof t.paymentIntentId === 'string' ? t.paymentIntentId.slice(0, 100) : null, created: t.created || null,
  }));
}

/**
 * Queue a payout for QuickBooks the way the records hook queues a record (W3 hooks.js, same
 * SQL): one qbo_outbox row (collection stripePayouts, rank 70, actor stripe), and a qbo_sync
 * pass when the connection (booksInQbo) is active.
 */
async function queuePayoutForQbo(tx, payoutId, conn) {
  await tx.query(
    `INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, actor_type, rank, not_before)
     VALUES ($1, 'stripePayouts', $2, 'upsert', 'stripe', 70, now() + interval '20 seconds')
     ON CONFLICT (tenant_id, collection, record_id) DO UPDATE SET
       op = EXCLUDED.op, stale = qbo_outbox.stale OR EXCLUDED.stale, held = qbo_outbox.held || EXCLUDED.held,
       actor_type = CASE WHEN qbo_outbox.actor_type IN ('api_key', 'agent') THEN qbo_outbox.actor_type ELSE EXCLUDED.actor_type END,
       not_before = EXCLUDED.not_before, claimed_until = NULL`, [tx.tenantId, payoutId]);
  if (conn.state === 'active') {
    await enqueue(tx, { kind: 'qbo_sync', tenantId: tx.tenantId, runAt: new Date(Date.now() + 20_000), dedupeKey: `qbo_sync:${tx.tenantId}` });
  }
  return true;
}

/**
 * Store or update a payout seen on the company's Stripe webhook or read by the worker, and
 * queue it for QuickBooks once it can be booked: paid and itemised (balanceTxns read; manual
 * payouts cannot be itemised and go as they are), or failed after it was paid (the Transfer comes
 * out again). Pending and canceled payouts are only stored, and so is everything while the
 * company is not on QuickBooks (booksInQbo). `itemise` says the worker should read the payout's
 * balance transactions (stripe_payout_fetch).
 * @param {{ id: string, amountCents: number, currency: string, arrivalDate: string, status: string, automatic?: boolean, livemode: boolean, feeCents?: number|null, balanceTxns?: object[] }} payout
 * @returns {Promise<{ inserted: boolean, status?: string, queued?: boolean, itemise?: boolean, reason?: string }>}
 */
export async function recordStripePayout(tx, payout) {
  const id = payout?.id;
  if (typeof id !== 'string' || !PAYOUT_RE.test(id)) return { inserted: false, reason: 'bad id' };
  if (!Number.isInteger(payout.amountCents)) return { inserted: false, reason: 'no amount' };
  const currency = String(payout.currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return { inserted: false, reason: 'no currency' };
  if (!DATE_RE.test(String(payout.arrivalDate || ''))) return { inserted: false, reason: 'no arrival date' };

  // A placeholder row first: two events for a new payout (payout.failed and the fetch job, say)
  // then wait on one row lock and see each other, instead of both inserting and the last one winning.
  const created = await tx.query(
    `INSERT INTO stripe_payouts (tenant_id, payout_id, amount_cents, currency, arrival_date, status, livemode)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6) ON CONFLICT (tenant_id, payout_id) DO NOTHING`,
    [tx.tenantId, id, payout.amountCents, currency, payout.arrivalDate, Boolean(payout.livemode)]);
  const prev = created.rowCount === 1 ? null
    : (await tx.query('SELECT status, paid_seen, balance_txns, fee_cents FROM stripe_payouts WHERE tenant_id = $1 AND payout_id = $2 FOR UPDATE', [tx.tenantId, id])).rows[0];
  const status = nextStatus(prev?.status, payoutStatus(payout.status));
  const paidSeen = Boolean(prev?.paid_seen) || status === 'paid';
  const itemised = Array.isArray(payout.balanceTxns);
  const txns = itemised ? cleanTxns(payout.balanceTxns) : (prev?.balance_txns || []);
  const booked = txns.filter((t) => BOOKED_TYPES.has(t.type));
  const intents = [...new Set(booked.map((t) => t.paymentIntentId).filter(Boolean))];
  const earliest = booked.map((t) => t.created).filter(Boolean).sort()[0] || null;
  const feeCents = Number.isInteger(payout.feeCents) ? payout.feeCents : (prev?.fee_cents ?? null);
  const automatic = payout.automatic !== false;

  await tx.query(
    `UPDATE stripe_payouts SET amount_cents = $3, currency = $4, arrival_date = $5, status = $6, paid_seen = $7, automatic = $8,
       livemode = $9, payment_intent_ids = $10, earliest_charge_at = $11, balance_txns = $12, fee_cents = $13, received_at = now()
      WHERE tenant_id = $1 AND payout_id = $2`,
    [tx.tenantId, id, payout.amountCents, currency, payout.arrivalDate, status, paidSeen, automatic, Boolean(payout.livemode),
      intents, earliest, JSON.stringify(txns), feeCents]);

  const conn = await booksInQbo(tx);
  const ready = (status === 'paid' && (!automatic || itemised || txns.length > 0)) || (status === 'failed' && paidSeen);
  const queued = ready && conn ? await queuePayoutForQbo(tx, id, conn) : false;
  const itemise = Boolean(conn) && status === 'paid' && automatic && !itemised && txns.length === 0;
  return { inserted: !prev, status, queued, itemise };
}
