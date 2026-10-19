// Stripe with the company's own key: Checkout Sessions for invoice balances, a cheap
// read-only connection test, and webhook signature checks (the SDK's constructEvent:
// HMAC-SHA256 over "<t>.<raw body>", 300 s tolerance).
import Stripe from 'stripe';
import { ProviderError, formEncode, httpFailure, request } from './http.js';

const API = 'https://api.stripe.com/v1';

const headers = (key, idempotencyKey) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/x-www-form-urlencoded',
  ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
});

function failure(r) {
  const e = r.json?.error || {};
  if (r.status === 401 || e.type === 'authentication_error') return new ProviderError('stripe', 'Stripe refused the key. Check it in Stripe > Developers > API keys.', { status: r.status, code: e.code, kind: 'auth' });
  if (r.status === 403) return new ProviderError('stripe', 'This restricted key is missing a permission. Give it Checkout Sessions: Write.', { status: r.status, code: e.code, kind: 'auth' });
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
