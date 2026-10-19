// Which plan features a company has right now. The tiers are in electrical-app/js/plans.js
// (shared with the PWA and HQ); this adds the trial rule, HQ overrides and a route guard.
// Gate writes, AI calls and integrations with it. Reads stay open so a downgrade never
// hides a company's own data.
import { hasFeature, entitlements, planFor, PLAN_IDS } from '../../../electrical-app/js/plans.js';
import { ApiError } from '../errors.js';

export const TRIAL_PLAN = 'business';
export const AFTER_TRIAL_PLAN = 'starter';

/** @param {{ plan: string, trial_ends_at?: Date|string|null }} t a tenants row */
export function effectivePlan(t, now = new Date()) {
  if (t.plan === 'trial') return !t.trial_ends_at || new Date(t.trial_ends_at) > now ? TRIAL_PLAN : AFTER_TRIAL_PLAN;
  return PLAN_IDS.includes(t.plan) ? t.plan : AFTER_TRIAL_PLAN;
}

export function tenantHas(t, feature, now = new Date()) {
  return hasFeature(effectivePlan(t, now), feature, t.plan_overrides || {});
}

/** What /api/v1/me reports: the plan in force, trial state and every unlocked feature. */
export function tenantEntitlements(t, now = new Date()) {
  const plan = effectivePlan(t, now);
  return {
    plan,
    onTrial: t.plan === 'trial',
    trialEndsAt: t.trial_ends_at ? new Date(t.trial_ends_at).toISOString() : null,
    features: entitlements(plan, t.plan_overrides || {}),
  };
}

/** @param {{ query: Function }} db */
export async function loadTenantPlan(db, tenantId) {
  const { rows } = await db.query('SELECT plan, plan_overrides, trial_ends_at FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] || null;
}

/** Throws 403 feature_not_in_plan unless the company has `feature`. */
export async function assertFeature(db, tenantId, feature) {
  const t = tenantId ? await loadTenantPlan(db, tenantId) : null;
  if (!t || !tenantHas(t, feature)) {
    throw new ApiError(403, 'feature_not_in_plan', 'Your plan does not include this. Upgrade to use it.', { feature, plan: planFor(feature) });
  }
}

/** Fastify preHandler for routes with `config: { auth: 'tenant' | 'manager' | 'admin' }`. */
export function requireFeature(db, feature) {
  return async (req) => assertFeature(db, req.principal?.tenantId, feature);
}
