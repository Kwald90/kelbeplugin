// Invoice balances and payments recorded from Stripe. Totals use the PWA's own document
// maths (electrical-app/js/lib/money.js) so the server and the app always agree.
import { docTotals } from '../../../electrical-app/js/lib/money.js';
import { ID_RE } from '../services/records.js';

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

/** The invoice with its total, what has been paid and the balance, or null when it doesn't exist. */
export async function invoiceBalance(tx, invoiceId) {
  if (typeof invoiceId !== 'string' || !ID_RE.test(invoiceId)) return null;
  const { rows } = await tx.query('SELECT id, data, version FROM invoices WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, invoiceId]);
  if (!rows[0]) return null;
  const paid = await tx.query(
    `SELECT COALESCE(sum((data->>'amountCents')::bigint), 0)::bigint AS cents FROM payments
      WHERE tenant_id = $1 AND invoice_id = $2 AND deleted_at IS NULL`, [tx.tenantId, invoiceId]);
  const invoice = { ...rows[0].data, id: rows[0].id, version: rows[0].version };
  const totalCents = docTotals(invoice).totalCents;
  const paidCents = Number(paid.rows[0].cents) || 0;
  return { invoice, totalCents, paidCents, balanceCents: totalCents - paidCents };
}

/** Same rule as syncInvoiceStatus in the PWA (modules/invoices.js); void is never touched. */
export async function refreshInvoiceStatus(tx, records, p, who, invoiceId) {
  const b = await invoiceBalance(tx, invoiceId);
  if (!b || b.invoice.status === 'void') return b;
  let next = b.invoice.status;
  if (b.paidCents > 0 && b.paidCents >= b.totalCents) next = 'paid';
  else if (b.paidCents > 0) next = 'partial';
  if (next !== b.invoice.status) await records.patchRecord(tx, p, 'invoices', invoiceId, { status: next }, {}, who);
  return { ...b, status: next };
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
  await records.createRecord(tx, p, 'payments', {
    id: paymentId,
    invoiceId,
    amountCents,
    date: localDate((session.created || Date.now() / 1000) * 1000, settings.company?.province),
    method: 'card',
    reference: String(ref).slice(0, 200),
    source: 'stripe',
    currency: typeof session.currency === 'string' ? session.currency.toUpperCase().slice(0, 3) : null,
    stripe: { checkoutSessionId: String(session.id || '').slice(0, 200), paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null, eventId: String(eventId || '').slice(0, 200), livemode: Boolean(session.livemode) },
  }, who);
  await refreshInvoiceStatus(tx, records, p, who, invoiceId);
  return { recorded: true, paymentId };
}
