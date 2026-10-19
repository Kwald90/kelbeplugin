// Fishtape's own subscriptions, on Fishtape's own Stripe account (STRIPE_SECRET_KEY).
// Companies pay for a tier (plans.js) plus extra users beyond the tier's included users.
// Checkout and the customer portal are Stripe-hosted; the signed webhook
// (/api/v1/webhooks/platform-stripe) is what actually sets the plan.
//
// The Stripe client is injected (config.billing.stripe) so tests never touch the network.
import Stripe from 'stripe';
import { PLANS, PLAN_IDS, EXTRA_USER_CENTS, CURRENCY, monthlyCents } from '../../../electrical-app/js/plans.js';
import { ApiError, badRequest } from '../errors.js';
import { isUuid } from '../db.js';
import { appendAudit } from './audit.js';
import { AFTER_TRIAL_PLAN, effectivePlan, tenantEntitlements } from './entitlements.js';
import { billingSettings } from './hq-common.js';

/** Price lookup keys, one per priced tier plus the extra-user price. Monthly, CAD. */
export const PRICE_KEYS = {
  starter: 'fishtape_starter_monthly_cad',
  pro: 'fishtape_pro_monthly_cad',
  business: 'fishtape_business_monthly_cad',
  extra_user: 'fishtape_extra_user_monthly_cad',
};
/** Stripe lets us choose product ids, which makes set-up idempotent. */
export const PRODUCT_IDS = { starter: 'fishtape_starter', pro: 'fishtape_pro', business: 'fishtape_business', extra_user: 'fishtape_extra_user' };
/** Tiers a company can buy itself (Enterprise is "Let's talk"). */
export const SELF_SERVE_PLANS = PLAN_IDS.filter((id) => PLANS[id].priceCents != null);

const TIER_BY_KEY = Object.fromEntries(SELF_SERVE_PLANS.map((id) => [PRICE_KEYS[id], id]));
const STRIPE_STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused'];
const STRIPE_ACTOR = { type: 'system', id: 'stripe', label: 'Stripe billing' };

/** What Fishtape sells, from plans.js. */
export function catalog() {
  const items = SELF_SERVE_PLANS.map((id) => ({
    key: id, productId: PRODUCT_IDS[id], name: `Fishtape ${PLANS[id].name}`, description: PLANS[id].blurb,
    lookupKey: PRICE_KEYS[id], unitAmount: PLANS[id].priceCents,
  }));
  items.push({
    key: 'extra_user', productId: PRODUCT_IDS.extra_user, name: 'Fishtape extra user',
    description: "Each user beyond your plan's included users", lookupKey: PRICE_KEYS.extra_user, unitAmount: EXTRA_USER_CENTS,
  });
  return items;
}

const currency = CURRENCY.toLowerCase();
const isMissing = (e) => e?.statusCode === 404 || e?.code === 'resource_missing';
const productOf = (price) => (typeof price.product === 'string' ? price.product : price.product?.id);

/**
 * Create or refresh the products and prices, matched by product id and price lookup key.
 * Running it twice changes nothing. A changed amount creates a new price that takes over
 * the lookup key (transfer_lookup_key) and archives the old one, so existing subscribers
 * keep their price until they are moved.
 * @returns {Promise<{ key: string, action: string, priceId?: string }[]>}
 */
export async function ensureStripeCatalog(stripe, { dryRun = false, log = () => {} } = {}) {
  const out = [];
  for (const item of catalog()) {
    let product = null;
    try { product = await stripe.products.retrieve(item.productId); } catch (e) { if (!isMissing(e)) throw e; }
    if (!product) {
      log(`create product ${item.productId}`);
      if (!dryRun) product = await stripe.products.create({ id: item.productId, name: item.name, description: item.description, metadata: { fishtape_key: item.key } });
    } else if (product.name !== item.name || product.active === false) {
      log(`update product ${item.productId}`);
      if (!dryRun) await stripe.products.update(item.productId, { name: item.name, description: item.description, active: true });
    }
    const existing = (await stripe.prices.list({ lookup_keys: [item.lookupKey], limit: 1 })).data[0] || null;
    const matches = existing && existing.active !== false && existing.unit_amount === item.unitAmount && existing.currency === currency
      && existing.recurring?.interval === 'month' && productOf(existing) === item.productId;
    if (matches) {
      log(`ok ${item.lookupKey} (${existing.id})`);
      out.push({ key: item.key, action: 'unchanged', priceId: existing.id });
      continue;
    }
    log(`${existing ? 'replace' : 'create'} price ${item.lookupKey} ${item.unitAmount} ${currency}/month`);
    if (dryRun) { out.push({ key: item.key, action: existing ? 'would-replace' : 'would-create' }); continue; }
    const price = await stripe.prices.create({
      product: item.productId, currency, unit_amount: item.unitAmount, recurring: { interval: 'month' },
      lookup_key: item.lookupKey, transfer_lookup_key: true, tax_behavior: 'exclusive', metadata: { fishtape_key: item.key },
    });
    if (existing && existing.active !== false) await stripe.prices.update(existing.id, { active: false });
    out.push({ key: item.key, action: existing ? 'replaced' : 'created', priceId: price.id });
  }
  return out;
}

/** Tier of a Stripe subscription: the item whose price carries a tier lookup key. */
export function planFromSubscription(sub) {
  for (const it of sub?.items?.data || []) {
    const tier = TIER_BY_KEY[it.price?.lookup_key];
    if (tier) return tier;
  }
  const m = sub?.metadata?.plan;
  return SELF_SERVE_PLANS.includes(m) || m === 'enterprise' ? m : null;
}

const extraItemOf = (sub) => (sub?.items?.data || []).find((it) => it.price?.lookup_key === PRICE_KEYS.extra_user) || null;
const tierItemOf = (sub) => (sub?.items?.data || []).find((it) => TIER_BY_KEY[it.price?.lookup_key]) || null;
const toDate = (secs) => (Number.isFinite(secs) ? new Date(secs * 1000) : null);

/** Seats in use: active and invited members (PIN-only crew included). */
export async function seatsUsed(q, tenantId) {
  const { rows } = await q.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND status IN ('active', 'invited')", [tenantId]);
  return rows[0].n;
}

export function extraSeats(plan, seats) {
  const inc = PLANS[plan]?.includedUsers;
  return inc == null ? 0 : Math.max(0, seats - inc);
}

/**
 * @param {{ config: import('../config.js').Config, db: import('../db.js').Db, settings?: ReturnType<typeof billingSettings> }} deps
 */
export function createBilling({ config, db, settings = billingSettings(config) }) {
  const stripe = settings.stripe || (settings.secretKey ? new Stripe(settings.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'Fishtape' } }) : null);
  let priceCache = { at: 0, ids: null };

  const unavailable = () => new ApiError(503, 'billing_unavailable', 'Online billing is not set up yet. Contact Fishtape support.');
  function needStripe() {
    if (!stripe) throw unavailable();
    return stripe;
  }

  async function priceIds() {
    if (priceCache.ids && Date.now() - priceCache.at < 10 * 60_000) return priceCache.ids;
    const res = await needStripe().prices.list({ lookup_keys: Object.values(PRICE_KEYS), active: true, limit: 10 });
    const ids = Object.fromEntries(res.data.map((p) => [p.lookup_key, p.id]));
    for (const k of Object.values(PRICE_KEYS)) if (!ids[k]) throw unavailable();
    priceCache = { at: Date.now(), ids };
    return ids;
  }

  async function tenantRow(q, tenantId) {
    const { rows } = await q.query(
      `SELECT id, name, status, plan, plan_overrides, trial_ends_at, grace_ends_at, past_due_since, stripe_customer_id,
              stripe_subscription_id, billing_status, billing_plan, current_period_end, cancel_at_period_end, billed_seats
         FROM tenants WHERE id = $1`, [tenantId]);
    return rows[0] || null;
  }

  /** What the company's owner sees on #/billing. */
  async function summary(tenantId) {
    const t = await tenantRow(db, tenantId);
    if (!t) throw new ApiError(404, 'not_found', 'No such company.');
    const seats = await seatsUsed(db, tenantId);
    const ent = tenantEntitlements(t);
    const plan = ent.plan;
    const included = PLANS[plan]?.includedUsers ?? null;
    return {
      plan,
      planName: PLANS[plan]?.name || plan,
      subscribedPlan: t.billing_plan,
      onTrial: ent.onTrial,
      trialEndsAt: ent.trialEndsAt,
      status: t.billing_status,
      pastDueSince: t.past_due_since ? new Date(t.past_due_since).toISOString() : null,
      graceEndsAt: ent.graceEndsAt,
      currentPeriodEnd: t.current_period_end ? new Date(t.current_period_end).toISOString() : null,
      cancelAtPeriodEnd: t.cancel_at_period_end,
      seats: { used: seats, included, extra: extraSeats(plan, seats), billed: t.billed_seats },
      monthlyCents: monthlyCents(t.billing_plan || plan, seats),
      currency: CURRENCY,
      hasSubscription: Boolean(t.stripe_subscription_id),
      hasCustomer: Boolean(t.stripe_customer_id),
      stripeConfigured: Boolean(stripe),
      selfServePlans: SELF_SERVE_PLANS,
      features: ent.features,
    };
  }

  async function ensureCustomer(t, email) {
    if (t.stripe_customer_id) return t.stripe_customer_id;
    const customer = await needStripe().customers.create(
      { name: t.name, ...(email ? { email } : {}), metadata: { tenant_id: t.id } },
      { idempotencyKey: `fishtape-customer-${t.id}` },
    );
    await db.query('UPDATE tenants SET stripe_customer_id = $2, updated_at = now() WHERE id = $1 AND stripe_customer_id IS NULL', [t.id, customer.id]);
    const fresh = await tenantRow(db, t.id);
    return fresh.stripe_customer_id;
  }

  const LIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

  /**
   * Subscribe (Stripe Checkout) or, with a live subscription, change the tier in place.
   * @returns {Promise<{ url: string } | { changed: true, plan: string }>}
   */
  async function checkout(tenantId, plan, { email } = {}) {
    if (!SELF_SERVE_PLANS.includes(plan)) throw badRequest('Pick Starter, Pro or Business. Enterprise is set up with us directly.');
    const s = needStripe();
    const t = await tenantRow(db, tenantId);
    if (!t) throw new ApiError(404, 'not_found', 'No such company.');
    if (t.stripe_subscription_id && LIVE.includes(t.billing_status)) return changePlan(t, plan);
    const prices = await priceIds();
    const customer = await ensureCustomer(t, email);
    const extra = extraSeats(plan, await seatsUsed(db, tenantId));
    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: tenantId,
      line_items: [{ price: prices[PRICE_KEYS[plan]], quantity: 1 }, ...(extra > 0 ? [{ price: prices[PRICE_KEYS.extra_user], quantity: extra }] : [])],
      subscription_data: { metadata: { tenant_id: tenantId, plan } },
      metadata: { tenant_id: tenantId, plan },
      allow_promotion_codes: true,
      success_url: `${config.publicOrigin}/#/billing?checkout=done`,
      cancel_url: `${config.publicOrigin}/#/billing?checkout=cancelled`,
    });
    return { url: session.url };
  }

  async function changePlan(t, plan) {
    const s = needStripe();
    const prices = await priceIds();
    const sub = await s.subscriptions.retrieve(t.stripe_subscription_id, { expand: ['items.data.price'] });
    const tierItem = tierItemOf(sub);
    const extraItem = extraItemOf(sub);
    const extra = extraSeats(plan, await seatsUsed(db, t.id));
    const items = [];
    if (tierItem) items.push({ id: tierItem.id, price: prices[PRICE_KEYS[plan]], quantity: 1 });
    else items.push({ price: prices[PRICE_KEYS[plan]], quantity: 1 });
    if (extraItem) items.push(extra > 0 ? { id: extraItem.id, quantity: extra } : { id: extraItem.id, deleted: true });
    else if (extra > 0) items.push({ price: prices[PRICE_KEYS.extra_user], quantity: extra });
    const updated = await s.subscriptions.update(sub.id, {
      items, proration_behavior: 'create_prorations', metadata: { tenant_id: t.id, plan }, expand: ['items.data.price'],
    });
    await applySubscription(t.id, updated, { reason: 'plan change' });
    return { changed: true, plan };
  }

  /** Stripe-hosted customer portal: cards, invoices, cancel. */
  async function portal(tenantId) {
    const t = await tenantRow(db, tenantId);
    if (!t?.stripe_customer_id) throw new ApiError(409, 'no_subscription', 'Subscribe to a plan first.');
    const session = await needStripe().billingPortal.sessions.create({ customer: t.stripe_customer_id, return_url: `${config.publicOrigin}/#/billing` });
    return { url: session.url };
  }

  /** Make the subscription's extra-user quantity match the members in use. */
  async function syncSeats(tenantId) {
    const t = await tenantRow(db, tenantId);
    if (!t?.stripe_subscription_id || !LIVE.includes(t.billing_status)) return { synced: false, reason: 'no_subscription' };
    const s = needStripe();
    const seats = await seatsUsed(db, tenantId);
    const sub = await s.subscriptions.retrieve(t.stripe_subscription_id, { expand: ['items.data.price'] });
    const plan = planFromSubscription(sub) || t.billing_plan;
    const extra = extraSeats(plan, seats);
    const item = extraItemOf(sub);
    const have = item?.quantity || 0;
    if (have !== extra) {
      if (item && extra > 0) await s.subscriptionItems.update(item.id, { quantity: extra });
      else if (item) await s.subscriptionItems.del(item.id);
      else await s.subscriptionItems.create({ subscription: sub.id, price: (await priceIds())[PRICE_KEYS.extra_user], quantity: extra });
    }
    // billed_seats = what the subscription pays for: included users plus extra users.
    const billed = (PLANS[plan]?.includedUsers ?? seats) + extra;
    await db.query('UPDATE tenants SET billed_seats = $2, updated_at = now() WHERE id = $1', [tenantId, billed]);
    return { synced: true, seats, extra, billed, changed: have !== extra };
  }

  // ---- webhook -------------------------------------------------------------

  /** Verify a webhook delivery. Throws 400 invalid_signature on any mismatch. */
  function verifyEvent(rawBody, signature) {
    if (!settings.webhookSecret) throw unavailable();
    if (!rawBody || typeof signature !== 'string' || !signature) throw new ApiError(400, 'invalid_signature', 'Missing or invalid Stripe signature.');
    try {
      return Stripe.webhooks.constructEvent(rawBody, signature, settings.webhookSecret);
    } catch {
      throw new ApiError(400, 'invalid_signature', 'Missing or invalid Stripe signature.');
    }
  }

  async function tenantForCustomer(customerId, metaTenantId) {
    if (typeof customerId === 'string' && customerId) {
      const { rows } = await db.query('SELECT id FROM tenants WHERE stripe_customer_id = $1', [customerId]);
      if (rows[0]) return rows[0].id;
    }
    // First event for a customer created elsewhere: trust metadata only when that company
    // has no customer yet (so one company cannot be pointed at another's subscription).
    if (isUuid(metaTenantId)) {
      const { rows } = await db.query('SELECT id, stripe_customer_id FROM tenants WHERE id = $1', [metaTenantId]);
      if (rows[0] && (!rows[0].stripe_customer_id || rows[0].stripe_customer_id === customerId)) return rows[0].id;
    }
    return null;
  }

  /**
   * Mirror a subscription onto the company and set the plan in force:
   * active/trialing -> the tier; past_due/unpaid -> keep the tier, start the grace period;
   * canceled/incomplete_expired -> fall back to AFTER_TRIAL_PLAN.
   */
  async function applySubscription(tenantId, sub, { reason = 'subscription', eventMeta = null, q = null } = {}) {
    const run = async (tx) => {
      const t = await tenantRow(tx, tenantId);
      if (!t) return 'ignored';
      if (t.stripe_subscription_id && t.stripe_subscription_id !== sub.id && LIVE.includes(t.billing_status) && !LIVE.includes(sub.status)) {
        return 'ignored'; // an old subscription ending does not touch the live one
      }
      const status = STRIPE_STATUSES.includes(sub.status) ? sub.status : 'incomplete';
      const tier = planFromSubscription(sub);
      const periodEnd = toDate(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
      const extra = extraItemOf(sub)?.quantity || 0;
      const seats = tier && PLANS[tier]?.includedUsers != null ? PLANS[tier].includedUsers + extra : t.billed_seats;
      let plan = t.plan;
      let pastDue = t.past_due_since;
      let grace = t.grace_ends_at;
      let subId = sub.id;
      if (status === 'active' || status === 'trialing') {
        if (tier) plan = tier;
        pastDue = null; grace = null;
      } else if (status === 'past_due' || status === 'unpaid') {
        if (tier) plan = tier;
        pastDue ??= new Date();
        grace ??= new Date(new Date(pastDue).getTime() + settings.graceDays * 86_400_000);
      } else if (status === 'canceled' || status === 'incomplete_expired') {
        plan = AFTER_TRIAL_PLAN; pastDue = null; grace = null; subId = null;
      }
      await tx.query(
        `UPDATE tenants SET plan = $2, billing_status = $3, billing_plan = $4, stripe_subscription_id = $5, current_period_end = $6,
                cancel_at_period_end = $7, billed_seats = $8, past_due_since = $9, grace_ends_at = $10, updated_at = now()
          WHERE id = $1`,
        [tenantId, plan, status, subId ? tier : null, subId, periodEnd, Boolean(sub.cancel_at_period_end), seats, pastDue, grace]);
      if (plan !== t.plan || status !== t.billing_status) {
        await appendAudit(tx, tenantId, {
          actor: STRIPE_ACTOR, action: 'billing.subscription', collection: 'tenants', recordId: tenantId,
          summary: `Subscription ${status}: plan ${t.plan} -> ${plan} (${reason})`, meta: { from: t.plan, to: plan, status, ...(eventMeta || {}) },
        });
      }
      return 'applied';
    };
    if (q) return run(q);
    return db.withTenant({ tenantId }, run, { write: true });
  }

  async function recordEvent(q, event, tenantId, outcome, { amount = null, cur = null, summary = null } = {}) {
    const { rows } = await q.query(
      `INSERT INTO billing_events (id, type, tenant_id, amount_cents, currency, outcome, summary, stripe_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [event.id, String(event.type).slice(0, 100), tenantId, amount, cur, outcome, summary ? String(summary).slice(0, 500) : null, toDate(event.created)]);
    return rows.length > 0;
  }

  class Duplicate extends Error {}

  /**
   * Handle one verified event. Idempotent: an event id is processed once.
   * @returns {Promise<{ outcome: string, duplicate?: boolean }>}
   */
  async function handleEvent(event) {
    if (!event?.id || !event.type) throw badRequest('Not a Stripe event.');
    const seen = await db.query('SELECT 1 FROM billing_events WHERE id = $1', [event.id]);
    if (seen.rows.length) return { outcome: 'duplicate', duplicate: true };
    const obj = event.data?.object || {};
    let tenantId = null;
    let sub = null;
    let amount = null;
    let cur = null;
    let summary = null;
    let apply = null;

    switch (event.type) {
      case 'checkout.session.completed': {
        tenantId = await tenantForCustomer(obj.customer, obj.client_reference_id || obj.metadata?.tenant_id);
        if (tenantId && obj.subscription) {
          const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
          sub = await needStripe().subscriptions.retrieve(subId, { expand: ['items.data.price'] });
          apply = async (tx) => {
            await tx.query('UPDATE tenants SET stripe_customer_id = COALESCE(stripe_customer_id, $2), stripe_subscription_id = $3 WHERE id = $1',
              [tenantId, obj.customer, sub.id]);
            return applySubscription(tenantId, sub, { reason: 'checkout', q: tx });
          };
        }
        amount = obj.amount_total ?? null; cur = obj.currency || null;
        summary = 'Checkout completed';
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        tenantId = await tenantForCustomer(obj.customer, obj.metadata?.tenant_id);
        sub = obj;
        if (tenantId) {
          apply = async (tx) => {
            await tx.query('UPDATE tenants SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1', [tenantId, obj.customer]);
            return applySubscription(tenantId, sub, { reason: event.type.split('.').pop(), q: tx });
          };
        }
        summary = `Subscription ${obj.status || ''}`.trim();
        break;
      }
      case 'invoice.payment_failed': {
        tenantId = await tenantForCustomer(obj.customer, null);
        amount = obj.amount_due ?? null; cur = obj.currency || null;
        summary = `Payment failed (attempt ${obj.attempt_count ?? 1})`;
        if (tenantId) {
          apply = async (tx) => {
            const { rows } = await tx.query(
              `UPDATE tenants SET billing_status = CASE WHEN billing_status IN ('active', 'trialing') THEN 'past_due' ELSE billing_status END,
                      past_due_since = COALESCE(past_due_since, now()),
                      grace_ends_at = COALESCE(grace_ends_at, COALESCE(past_due_since, now()) + make_interval(days => $2)),
                      updated_at = now()
                WHERE id = $1 RETURNING grace_ends_at`, [tenantId, settings.graceDays]);
            await appendAudit(tx, tenantId, {
              actor: STRIPE_ACTOR, action: 'billing.payment_failed', collection: 'tenants', recordId: tenantId,
              summary: `A subscription payment failed. Features stay on until ${new Date(rows[0].grace_ends_at).toISOString().slice(0, 10)}.`,
            });
            return 'applied';
          };
        }
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        tenantId = await tenantForCustomer(obj.customer, null);
        amount = obj.amount_paid ?? null; cur = obj.currency || null;
        summary = 'Invoice paid';
        if (tenantId) {
          apply = async (tx) => {
            const { rows } = await tx.query('SELECT past_due_since FROM tenants WHERE id = $1', [tenantId]);
            await tx.query(
              `UPDATE tenants SET past_due_since = NULL, grace_ends_at = NULL,
                      billing_status = CASE WHEN billing_status IN ('past_due', 'unpaid') THEN 'active' ELSE billing_status END, updated_at = now()
                WHERE id = $1`, [tenantId]);
            if (rows[0]?.past_due_since) {
              await appendAudit(tx, tenantId, { actor: STRIPE_ACTOR, action: 'billing.payment_recovered', collection: 'tenants', recordId: tenantId, summary: 'Overdue subscription payment received' });
            }
            return 'applied';
          };
        }
        break;
      }
      case 'invoice.upcoming': {
        tenantId = await tenantForCustomer(obj.customer, null);
        summary = 'Upcoming invoice: seats checked';
        if (tenantId) {
          await syncSeats(tenantId);
          apply = async () => 'applied';
        }
        break;
      }
      default:
        summary = null;
    }

    const outcome = !apply ? (tenantId || !obj.customer ? 'ignored' : 'unknown_customer') : null;
    const run = async (tx) => {
      const inserted = await recordEvent(tx, event, tenantId, outcome || 'applied', { amount, cur, summary });
      if (!inserted) throw new Duplicate();
      return apply ? apply(tx) : outcome;
    };
    try {
      const result = tenantId ? await db.withTenant({ tenantId }, run, { write: true }) : await db.tx(run);
      return { outcome: result };
    } catch (e) {
      if (e instanceof Duplicate) return { outcome: 'duplicate', duplicate: true };
      throw e;
    }
  }

  return { stripe, configured: () => Boolean(stripe), summary, checkout, portal, syncSeats, verifyEvent, handleEvent, applySubscription, settings };
}

/** MRR estimate for HQ: paying companies at plans.js prices plus extra users. */
export function estimateMrrCents(rows) {
  let total = 0;
  for (const t of rows) {
    if (!['active', 'past_due'].includes(t.billing_status)) continue;
    const cents = monthlyCents(t.billing_plan || effectivePlan(t), t.billed_seats || t.seats || 1);
    if (cents) total += cents;
  }
  return total;
}
