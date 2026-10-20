// Fishtape's own subscriptions (Fishtape's Stripe account, never a company's key):
//   /api/v1/billing*                    the company's owner/admin: plan, seats, Checkout, portal
//   /api/v1/webhooks/platform-stripe    Stripe -> us (signature-verified); sets plan and status
//   /api/hq/billing                     HQ: subscriptions, plan mix, failed payments, MRR
import { PLANS } from '../../../electrical-app/js/plans.js';
import { appendAudit } from '../services/audit.js';
import { SELF_SERVE_PLANS, createBilling, estimateMrrCents } from '../services/billing.js';
import { effectivePlan } from '../services/entitlements.js';
import { iso } from '../services/hq-common.js';
import { createSignups, isSignupEvent } from '../services/signup.js';
import { tenantCtx, who } from './util.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function hqBillingRoutes(app, { config, db, email }) {
  const billing = createBilling({ config, db });
  // Self-serve sign-ups (services/signup.js) share this webhook: their Checkout events carry
  // metadata.fishtape_signup_id and become a company there.
  const signups = createSignups({ config, db, email, billing });
  const admin = { auth: 'admin' };
  const tags = ['billing'];

  /** Audit in the company's own chain (the owner sees billing actions in their log). */
  const audit = (req, action, summary, meta) => db.withTenant(tenantCtx(req.principal), (tx) => appendAudit(tx, tx.tenantId, { ...who(req), action, collection: 'tenants', recordId: tx.tenantId, summary, meta }), { write: true });

  app.get('/api/v1/billing', { config: admin, schema: { tags, summary: 'Plan, trial, seats and price (owners and admins)' } }, async (req) => billing.summary(req.principal.tenantId));

  app.post('/api/v1/billing/checkout', {
    config: admin,
    schema: {
      tags, summary: 'Subscribe with Stripe Checkout ({ url }), or change the plan of a live subscription ({ changed, plan })',
      body: { type: 'object', required: ['plan'], additionalProperties: false, properties: { plan: { type: 'string', enum: SELF_SERVE_PLANS } } },
    },
  }, async (req) => {
    const p = req.principal;
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [p.userId]);
    const out = await billing.checkout(p.tenantId, req.body.plan, { email: rows[0]?.email || undefined });
    await audit(req, out.url ? 'billing.checkout_started' : 'billing.plan_change', out.url
      ? `Started checkout for ${PLANS[req.body.plan].name}`
      : `Changed the subscription to ${PLANS[req.body.plan].name}`, { plan: req.body.plan });
    return out;
  });

  app.post('/api/v1/billing/portal', { config: admin, schema: { tags, summary: 'Open the Stripe customer portal (cards, invoices, cancel)' } }, async (req) => {
    const out = await billing.portal(req.principal.tenantId);
    await audit(req, 'billing.portal_opened', 'Opened the billing portal');
    return out;
  });

  app.post('/api/v1/billing/seats/sync', { config: admin, schema: { tags, summary: 'Bill the extra users the company has now' } }, async (req) => {
    const out = await billing.syncSeats(req.principal.tenantId);
    if (out.changed) await audit(req, 'billing.seats_synced', `Billing updated to ${out.seats} users (${out.extra} extra)`);
    return out;
  });

  // Stripe needs the exact bytes it signed, so this route parses JSON itself.
  await app.register(async (hook) => {
    hook.removeContentTypeParser('application/json');
    hook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (req, body, done) => {
      req.rawBody = body;
      done(null, {});
    });
    hook.post('/api/v1/webhooks/platform-stripe', {
      config: { auth: 'public', csrf: false },
      schema: { tags, summary: 'Stripe webhook for Fishtape subscriptions (Stripe-Signature verified)', hide: false },
    }, async (req) => {
      const event = billing.verifyEvent(req.rawBody, req.headers['stripe-signature']);
      const r = isSignupEvent(event) ? await signups.handleEvent(event) : await billing.handleEvent(event);
      req.log.info({ stripeEvent: event.type, outcome: r.outcome }, 'stripe event');
      return { received: true, outcome: r.outcome };
    });
  });

  // ---- HQ -------------------------------------------------------------------------

  app.get('/api/hq/billing', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'Subscriptions, plan mix, failed payments and estimated MRR' } }, async () => {
    const data = await db.withHq(async (c) => {
      const tenants = (await c.query(
        `SELECT t.id, t.name, t.status, t.plan, t.plan_overrides, t.trial_ends_at, t.grace_ends_at, t.past_due_since, t.billing_status, t.billing_plan,
                t.billed_seats, t.current_period_end, t.cancel_at_period_end,
                (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status IN ('active', 'invited')) AS seats
           FROM tenants t ORDER BY t.name`)).rows;
      const failed = (await c.query(
        `SELECT e.id, e.tenant_id, t.name AS tenant_name, e.amount_cents, e.currency, e.summary, e.received_at
           FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id
          WHERE e.type = 'invoice.payment_failed' AND e.received_at > now() - interval '90 days' ORDER BY e.received_at DESC LIMIT 100`)).rows;
      const events = (await c.query(
        `SELECT e.id, e.type, e.tenant_id, t.name AS tenant_name, e.amount_cents, e.currency, e.outcome, e.summary, e.received_at
           FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.received_at DESC LIMIT 50`)).rows;
      return { tenants, failed, events };
    });
    const mix = {};
    for (const t of data.tenants.filter((x) => x.status !== 'closed')) {
      const k = t.plan === 'trial' ? 'trial' : effectivePlan(t);
      mix[k] = (mix[k] || 0) + 1;
    }
    return {
      stripeConfigured: billing.configured(),
      webhookConfigured: Boolean(billing.settings.webhookSecret),
      mrrCents: estimateMrrCents(data.tenants),
      planMix: mix,
      subscriptions: data.tenants.filter((t) => t.billing_status !== 'none').map((t) => ({
        tenantId: t.id, tenantName: t.name, plan: t.billing_plan, effectivePlan: effectivePlan(t), status: t.billing_status, seats: t.seats, billedSeats: t.billed_seats,
        currentPeriodEnd: iso(t.current_period_end), cancelAtPeriodEnd: t.cancel_at_period_end, pastDueSince: iso(t.past_due_since), graceEndsAt: iso(t.grace_ends_at),
      })),
      failedPayments: data.failed.map((e) => ({ id: e.id, tenantId: e.tenant_id, tenantName: e.tenant_name, amountCents: e.amount_cents, currency: e.currency, summary: e.summary, at: iso(e.received_at) })),
      recentEvents: data.events.map((e) => ({ id: e.id, type: e.type, tenantId: e.tenant_id, tenantName: e.tenant_name, amountCents: e.amount_cents, currency: e.currency, outcome: e.outcome, summary: e.summary, at: iso(e.received_at) })),
    };
  });
}
