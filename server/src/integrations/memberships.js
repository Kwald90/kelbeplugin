// Residential service plans / memberships billed on the company's own Stripe account.
// This mirrors a Stripe subscription back onto the serviceMemberships record when the company's
// own Stripe webhook (/api/v1/webhooks/stripe/:tenantId) delivers a subscription, invoice or
// subscription-checkout event. It reuses the EXISTING company webhook pipeline (no second
// endpoint): webhooks.js calls applyMembershipEvent inside the same verified, idempotent block.
//
// Writes are raw UPDATEs on service_memberships: the tenant_record_stamp trigger bumps version and
// change_seq, so the change syncs to the company's devices like any other. The app role has UPDATE
// on the table and RLS confines it to the tenant. No money or customer PII is logged here.
import { appendAudit } from '../services/audit.js';

const STRIPE_ACTOR = { type: 'system', id: 'stripe', label: 'Stripe billing' };
const isoDay = (unixSecs) => (Number.isFinite(unixSecs) ? new Date(unixSecs * 1000).toISOString().slice(0, 10) : null);
const subIdOf = (v) => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null);
const customerIdOf = (v) => (typeof v === 'string' ? v : null);

/** Map a Stripe subscription status (and the event) to a membership status, or null to leave it. */
export function membershipStatusFor(stripeStatus, eventType) {
  if (eventType === 'customer.subscription.deleted' || stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return 'cancelled';
  if (eventType === 'customer.subscription.paused' || stripeStatus === 'paused') return 'paused';
  if (stripeStatus === 'active' || stripeStatus === 'trialing' || eventType === 'customer.subscription.resumed') return 'active';
  // past_due / unpaid: keep the plan active (the billingStatus field shows the trouble); incomplete: leave as is.
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'active';
  return null;
}

async function membershipBySubscription(tx, subscriptionId) {
  if (!subscriptionId) return null;
  const { rows } = await tx.query(
    'SELECT id, data FROM service_memberships WHERE tenant_id = $1 AND stripe_subscription_id = $2 AND deleted_at IS NULL LIMIT 1',
    [tx.tenantId, subscriptionId]);
  return rows[0] ? { id: rows[0].id, data: rows[0].data || {} } : null;
}

async function membershipById(tx, id) {
  if (typeof id !== 'string' || !id) return null;
  const { rows } = await tx.query('SELECT id, data FROM service_memberships WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1', [tx.tenantId, id]);
  return rows[0] ? { id: rows[0].id, data: rows[0].data || {} } : null;
}

/** Merge a patch into a membership's JSON body; the trigger bumps version and change_seq for sync. */
async function patchMembership(tx, id, patch) {
  await tx.query(
    'UPDATE service_memberships SET data = data || $3::jsonb WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL',
    [tx.tenantId, id, JSON.stringify(patch)]);
}

/**
 * Handle one verified Stripe event for the company's own account, mirroring it onto a service plan.
 * Returns { handled: true } when it was a membership event this changed, else { handled: false } so
 * the caller can try its other handlers (invoice payments, payouts). Must run inside db.withTenant
 * write and after the event's idempotency check.
 */
export async function applyMembershipEvent(tx, event, tenantId) {
  const obj = event?.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (obj.object !== 'checkout.session' || obj.mode !== 'subscription') return { handled: false };
      if (obj.metadata?.fishtape_tenant !== tenantId || !obj.metadata?.fishtape_membership) return { handled: false };
      const m = await membershipById(tx, obj.metadata.fishtape_membership);
      if (!m) return { handled: false };
      const subscriptionId = subIdOf(obj.subscription);
      await patchMembership(tx, m.id, {
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerIdOf(obj.customer),
        status: 'active',
        billingStatus: 'active',
        lastPaymentAt: new Date().toISOString(),
      });
      await appendAudit(tx, tenantId, {
        actor: STRIPE_ACTOR, action: 'membership.billing_started', collection: 'serviceMemberships', recordId: m.id,
        summary: 'A customer started Stripe billing for a service plan',
      });
      return { handled: true };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      if (obj.object !== 'subscription') return { handled: false };
      const m = await membershipBySubscription(tx, obj.id);
      if (!m) return { handled: false };
      const status = membershipStatusFor(obj.status, event.type);
      const patch = { billingStatus: String(obj.status || '').slice(0, 40) || null };
      if (status) patch.status = status;
      const renewal = isoDay(obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end);
      if (renewal && status !== 'cancelled') patch.renewalDate = renewal;
      if (status === 'cancelled') patch.cancelledAt = new Date().toISOString();
      await patchMembership(tx, m.id, patch);
      await appendAudit(tx, tenantId, {
        actor: STRIPE_ACTOR, action: 'membership.subscription', collection: 'serviceMemberships', recordId: m.id,
        summary: `Service-plan subscription ${String(obj.status || '').slice(0, 40)}`.trim(),
      });
      return { handled: true };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      if (obj.object !== 'invoice') return { handled: false };
      const m = await membershipBySubscription(tx, subIdOf(obj.subscription));
      if (!m) return { handled: false };
      if (event.type === 'invoice.payment_failed') {
        await patchMembership(tx, m.id, { billingStatus: 'past_due' });
      } else {
        const patch = { billingStatus: 'active', lastPaymentAt: new Date().toISOString() };
        if (m.data.status === 'pending') patch.status = 'active';
        const renewal = isoDay(obj.period_end ?? obj.lines?.data?.[0]?.period?.end);
        if (renewal) patch.renewalDate = renewal;
        await patchMembership(tx, m.id, patch);
      }
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}
