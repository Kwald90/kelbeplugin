// Stripe with the company's own key: Checkout Sessions for invoice balances, a cheap
// read-only connection test, webhook signature checks (the SDK's constructEvent:
// HMAC-SHA256 over "<t>.<raw body>", 300 s tolerance), and the read-only calls the books need:
// the fee of a payment, a payout and the balance transactions it paid out
// (docs/integrations/quickbooks.md 4.9). Those return money, types and ids only.
import Stripe from 'stripe';
import { ProviderError, formEncode, httpFailure, request } from './http.js';

const API = 'https://api.stripe.com/v1';

const headers = (key, idempotencyKey) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/x-www-form-urlencoded',
  ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
});

function failure(r, permission = 'Checkout Sessions: Write') {
  const e = r.json?.error || {};
  if (r.status === 401 || e.type === 'authentication_error') return new ProviderError('stripe', 'Stripe refused the key. Check it in Stripe > Developers > API keys.', { status: r.status, code: e.code, kind: 'auth' });
  if (r.status === 403) return new ProviderError('stripe', `This restricted key is missing a permission. Give it ${permission}.`, { status: r.status, code: e.code, kind: 'auth' });
  return httpFailure('stripe', r.status, e.message, e.code);
}

export const isLiveKey = (key) => /^(sk|rk)_live_/.test(key);

/** GET /v1/checkout/sessions?limit=1: needs only Checkout Sessions read, changes nothing. */
export async function testStripe({ secretKey }) {
  const r = await request('stripe', `${API}/checkout/sessions?limit=1`, { headers: headers(secretKey) });
  if (!r.ok) throw failure(r);
  return { status: 'ok', message: `Connected (${isLiveKey(secretKey) ? 'live' : 'test'} mode).` };
}

/**
 * A hosted Checkout page for one payment of `amountCents`.
 * @returns {Promise<{ id: string, url: string, expiresAt: string|null }>}
 */
export async function createCheckoutSession({ secretKey, tenantId, invoiceId, invoiceNumber, companyName, amountCents, currency = 'cad', customerEmail, successUrl, cancelUrl }) {
  if (!Number.isInteger(amountCents) || amountCents < 50) throw new ProviderError('stripe', 'The amount is too small for an online payment.', { kind: 'invalid' });
  const metadata = { fishtape_tenant: tenantId, fishtape_invoice: invoiceId };
  const body = formEncode({
    mode: 'payment',
    client_reference_id: invoiceId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(currency).toLowerCase(),
        unit_amount: amountCents,
        product_data: { name: `Invoice ${invoiceNumber || ''}`.trim().slice(0, 200), description: companyName ? String(companyName).slice(0, 200) : undefined },
      },
    }],
    metadata,
    payment_intent_data: { metadata, description: `Invoice ${invoiceNumber || invoiceId}`.slice(0, 200) },
  });
  const r = await request('stripe', `${API}/checkout/sessions`, { method: 'POST', headers: headers(secretKey), body });
  if (!r.ok) throw failure(r);
  const s = r.json || {};
  if (typeof s.url !== 'string' || !s.url.startsWith('https://')) throw new ProviderError('stripe', 'Stripe did not return a payment page.', { kind: 'other' });
  return { id: s.id, url: s.url, expiresAt: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null };
}

export const SUBSCRIPTION_RE = /^sub_[A-Za-z0-9]{6,64}$/;

/**
 * A hosted Checkout page that starts a recurring subscription for a service plan / membership,
 * billed on the company's own Stripe account. The price is inline (price_data), so the company
 * need not create Stripe products first. metadata (on the session and the subscription) carries
 * the tenant and membership ids, so the company's own Stripe webhook can mirror the subscription
 * back onto the plan. `interval` is 'month' or 'year'.
 * @returns {Promise<{ id: string, url: string, expiresAt: string|null }>}
 */
export async function createSubscriptionCheckout({ secretKey, tenantId, membershipId, planName, amountCents, interval = 'year', currency = 'cad', customerEmail, successUrl, cancelUrl }) {
  if (!Number.isInteger(amountCents) || amountCents < 50) throw new ProviderError('stripe', 'The plan price is too small for recurring billing.', { kind: 'invalid' });
  const recurring = interval === 'month' ? 'month' : 'year';
  const metadata = { fishtape_tenant: tenantId, fishtape_membership: membershipId };
  const body = formEncode({
    mode: 'subscription',
    client_reference_id: membershipId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(currency).toLowerCase(),
        unit_amount: amountCents,
        recurring: { interval: recurring },
        product_data: { name: String(planName || 'Membership plan').slice(0, 200) },
      },
    }],
    metadata,
    subscription_data: { metadata },
  });
  const r = await request('stripe', `${API}/checkout/sessions`, { method: 'POST', headers: headers(secretKey), body });
  if (!r.ok) throw failure(r, 'Checkout Sessions: Write and Subscriptions: Write');
  const s = r.json || {};
  if (typeof s.url !== 'string' || !s.url.startsWith('https://')) throw new ProviderError('stripe', 'Stripe did not return a checkout page.', { kind: 'other' });
  return { id: s.id, url: s.url, expiresAt: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null };
}

/**
 * Cancel a subscription immediately on the company's Stripe account.
 * @returns {Promise<{ id: string, status: string, canceledAt: string }>}
 */
export async function cancelStripeSubscription(secretKey, subscriptionId) {
  if (!SUBSCRIPTION_RE.test(String(subscriptionId))) throw new ProviderError('stripe', 'This is not a Stripe subscription reference.', { kind: 'invalid' });
  const r = await request('stripe', `${API}/subscriptions/${subscriptionId}`, { method: 'DELETE', headers: headers(secretKey) });
  if (!r.ok) throw failure(r, 'Subscriptions: Write');
  const s = r.json || {};
  return { id: String(s.id || subscriptionId), status: String(s.status || 'canceled'), canceledAt: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : new Date().toISOString() };
}

/**
 * Verify a webhook and return the event, or null when the signature does not match
 * (wrong secret, edited body, replay older than 5 minutes).
 */
export function verifyStripeEvent(rawBody, signatureHeader, webhookSecret) {
  if (!rawBody || !signatureHeader || !webhookSecret) return null;
  try {
    return Stripe.webhooks.constructEvent(rawBody, String(signatureHeader), webhookSecret);
  } catch {
    return null;
  }
}

/** For tests and the setup guide: a valid Stripe-Signature header for a payload. */
export function stripeTestHeader(payload, secret, timestamp) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });
}

// ---- the books: fees and payouts (read-only) -----------------------------------------

export const PAYMENT_INTENT_RE = /^pi_[A-Za-z0-9]{8,64}$/;
export const PAYOUT_RE = /^po_[A-Za-z0-9]{8,64}$/;
const READ_PERMS = 'Read on PaymentIntents, Charges, Balance transactions and Payouts';
const isoOf = (unix) => (Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : null);
const idOf = (v) => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null);
const cents = (v) => (Number.isInteger(v) ? v : null);
const expanded = (v) => (v && typeof v === 'object' ? v : null);

async function readStripe(secretKey, path) {
  const r = await request('stripe', `${API}${path}`, { headers: headers(secretKey) });
  if (!r.ok) throw failure(r, READ_PERMS);
  return r.json || {};
}

/**
 * The fee Stripe took on a payment, from its charge's balance transaction. Throws a retryable
 * ProviderError while Stripe has not settled the balance transaction yet.
 * @returns {Promise<{ chargeId: string, balanceTransactionId: string, feeCents: number, netCents: number, currency: string, created: string|null }>}
 */
export async function fetchStripeFee(secretKey, paymentIntentId) {
  if (!PAYMENT_INTENT_RE.test(String(paymentIntentId))) throw new ProviderError('stripe', 'This is not a Stripe payment reference.', { kind: 'invalid' });
  const pi = await readStripe(secretKey, `/payment_intents/${paymentIntentId}?expand[]=latest_charge.balance_transaction`);
  const charge = expanded(pi.latest_charge);
  const bt = expanded(charge?.balance_transaction);
  if (!charge || !bt || cents(bt.fee) == null || cents(bt.net) == null) {
    throw new ProviderError('stripe', 'Stripe has not settled the fee for this payment yet. We\'ll try again.', { retry: true, kind: 'unavailable' });
  }
  return {
    chargeId: String(charge.id), balanceTransactionId: String(bt.id), feeCents: bt.fee, netCents: bt.net,
    currency: String(bt.currency || charge.currency || '').toLowerCase(), created: isoOf(charge.created),
  };
}

/** Stripe's in_transit is still on its way: stored as pending (stripe_payouts has four states). */
export function payoutStatus(status) {
  return ['paid', 'failed', 'canceled'].includes(status) ? status : 'pending';
}

/**
 * One payout. feeCents is Stripe's own fee for the payout (instant payouts), for information only.
 * @returns {Promise<{ amountCents: number, currency: string, arrivalDate: string|null, status: string, automatic: boolean, livemode: boolean, feeCents: number|null }>}
 */
export async function fetchPayout(secretKey, payoutId) {
  if (!PAYOUT_RE.test(String(payoutId))) throw new ProviderError('stripe', 'This is not a Stripe payout reference.', { kind: 'invalid' });
  const po = await readStripe(secretKey, `/payouts/${payoutId}?expand[]=balance_transaction`);
  return {
    amountCents: cents(po.amount), currency: String(po.currency || '').toLowerCase(), arrivalDate: isoOf(po.arrival_date)?.slice(0, 10) || null,
    status: payoutStatus(po.status), automatic: po.automatic !== false, livemode: Boolean(po.livemode), feeCents: cents(expanded(po.balance_transaction)?.fee),
  };
}

const MAX_PAGES = 50;

/**
 * Every balance transaction an automatic payout paid out (charges, refunds, fees, adjustments and
 * the payout itself), 100 a page. Descriptions and customer details are never kept.
 * @returns {Promise<Array<{ id: string, type: string, amountCents: number, feeCents: number, paymentIntentId: string|null, created: string|null }>>}
 */
export async function fetchPayoutTransactions(secretKey, payoutId) {
  if (!PAYOUT_RE.test(String(payoutId))) throw new ProviderError('stripe', 'This is not a Stripe payout reference.', { kind: 'invalid' });
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await readStripe(secretKey, `/balance_transactions?payout=${payoutId}&limit=100&expand[]=data.source${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    const data = Array.isArray(list.data) ? list.data : [];
    for (const t of data) {
      const pi = idOf(expanded(t.source)?.payment_intent);
      out.push({
        id: String(t.id), type: String(t.type || 'other').slice(0, 40), amountCents: cents(t.amount) ?? 0, feeCents: cents(t.fee) ?? 0,
        paymentIntentId: pi && PAYMENT_INTENT_RE.test(pi) ? pi : null, created: isoOf(t.created),
      });
    }
    if (!list.has_more || !data.length) return out;
    after = data[data.length - 1].id;
  }
  throw new ProviderError('stripe', 'This payout has too many transactions to list.', { kind: 'other' });
}
