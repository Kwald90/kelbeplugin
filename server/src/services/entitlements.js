// Which plan features a company has right now. The tiers are in electrical-app/js/plans.js
// (shared with the PWA and HQ); this adds the trial rule, the failed-payment grace period,
// HQ overrides, the collection -> module map and the guards. Gate writes, AI calls and
// integrations with it. Reads stay open so a downgrade never hides a company's own data.
import { hasFeature, entitlements, planFor, PLAN_IDS, FEATURE_PLAN, PLANS } from '../../../electrical-app/js/plans.js';
import { ApiError } from '../errors.js';

export const TRIAL_PLAN = 'business';
export const AFTER_TRIAL_PLAN = 'starter';

/**
 * The plan in force. A running trial gets TRIAL_PLAN, an expired one AFTER_TRIAL_PLAN.
 * After a failed payment the paid plan stays until grace_ends_at, then falls back too.
 * @param {{ plan: string, trial_ends_at?: Date|string|null, grace_ends_at?: Date|string|null }} t a tenants row
 */
export function effectivePlan(t, now = new Date()) {
  if (t.grace_ends_at && new Date(t.grace_ends_at) <= now) return AFTER_TRIAL_PLAN;
  if (t.plan === 'trial') return !t.trial_ends_at || new Date(t.trial_ends_at) > now ? TRIAL_PLAN : AFTER_TRIAL_PLAN;
  return PLAN_IDS.includes(t.plan) ? t.plan : AFTER_TRIAL_PLAN;
}

export function tenantHas(t, feature, now = new Date()) {
  return hasFeature(effectivePlan(t, now), feature, t.plan_overrides || {});
}

/**
 * On a free trial: either HQ's plan 'trial' (no card yet), or a self-serve sign-up whose
 * Stripe subscription is still trialing (plan = the chosen tier; services/signup.js).
 */
export function onTrial(t) {
  return t.plan === 'trial' || t.billing_status === 'trialing';
}

/** What /api/v1/me reports: the plan in force, trial state and every unlocked feature. */
export function tenantEntitlements(t, now = new Date()) {
  const plan = effectivePlan(t, now);
  return {
    plan,
    onTrial: onTrial(t),
    trialEndsAt: t.trial_ends_at ? new Date(t.trial_ends_at).toISOString() : null,
    graceEndsAt: t.grace_ends_at ? new Date(t.grace_ends_at).toISOString() : null,
    features: entitlements(plan, t.plan_overrides || {}),
  };
}

/** Users included in the plan in force (null = custom, i.e. Enterprise). */
export function includedUsers(t, now = new Date()) {
  return PLANS[effectivePlan(t, now)]?.includedUsers ?? null;
}

/** @param {{ query: Function }} db */
export async function loadTenantPlan(db, tenantId) {
  const { rows } = await db.query('SELECT plan, plan_overrides, trial_ends_at, grace_ends_at, billing_status FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] || null;
}

export function featureNotInPlan(feature) {
  return new ApiError(403, 'feature_not_in_plan', 'Your plan does not include this. Upgrade to use it.', { feature, plan: planFor(feature) });
}

/** Throws 403 feature_not_in_plan unless the company has `feature`. */
export async function assertFeature(db, tenantId, feature) {
  const t = tenantId ? await loadTenantPlan(db, tenantId) : null;
  if (!t || !tenantHas(t, feature)) throw featureNotInPlan(feature);
}

/** Fastify preHandler for routes with `config: { auth: 'tenant' | 'manager' | 'admin' }`. */
export function requireFeature(db, feature) {
  return async (req) => assertFeature(db, req.principal?.tenantId, feature);
}

/**
 * The module(s) each collection belongs to (keys of FEATURE_PLAN). A write is allowed when
 * the plan has any one of them; null means every plan may write it. Mirrors the write
 * permissions in collections.js, so a collection two modules write (checklists from
 * Compliance and Security, certifications from Compliance and Employees) needs either.
 */
export const COLLECTION_FEATURES = {
  clients: ['clients'],
  leads: ['leads'],
  sequences: ['sequences'],
  enrolments: ['sequences'],
  outbox: ['sequences', 'estimates', 'invoices'],
  jobs: ['jobs'],
  schedule: ['schedule'],
  estimates: ['estimates'],
  invoices: ['invoices'],
  payments: ['invoices'],
  items: ['inventory'],
  locations: ['inventory'],
  stockMoves: ['inventory'],
  employees: ['employees'],
  timeEntries: ['time'],
  drawings: ['drawings'],
  sops: ['sops'],
  permits: ['compliance'],
  inspections: ['compliance'],
  certifications: ['compliance', 'employees'],
  checklists: ['compliance', 'security'],
  panels: ['panels'],
  auditLog: null,
  settings: null,
  wireRuns: ['wireruns'],
  bends: ['bending', 'calcs'],
  benderProfiles: ['bending', 'calcs'],
  flhas: ['safety'],
  toolboxTalks: ['safety'],
  incidents: ['safety'],
  correctiveActions: ['safety'],
  safetyInspections: ['safety'],
  siteOrientations: ['safety'],
  jobSafety: ['safety'],
  // Workers record progress on any plan ("My day" is Starter); planning needs Pro.
  workTasks: ['today', 'workplan'],
  workPlans: ['workplan'],
  taskTemplates: ['workplan'],
  huddles: ['workplan'],
  // Every plan: crew ask for material, the office gets one list a day.
  materialRequests: ['materials'],
  // Location while clocked in is part of the time clock (every plan).
  locationPoints: ['time'],
  locationConsents: ['time'],
  // Purchasing (Pro): suppliers, bills and receipts, purchase orders.
  vendors: ['purchasing'],
  bills: ['purchasing'],
  purchaseOrders: ['purchasing'],
  // Release 1 (docs/releases/r1-get-paid.md 2.2, 2.11): cost codes, company rules, signatures and
  // equipment are in every plan; payroll runs belong to the time clock; field tickets to their module.
  costCodes: null,
  rules: null,
  payrollRuns: ['time'],
  signatures: null,
  fieldTickets: ['tickets'],
  equipment: null,
  equipmentUse: null,
  stockCounts: ['inventory'],
};

/**
 * Throws feature_not_in_plan when a write to `coll` is outside the plan. API keys also
 * need the `api` feature to write. Reads never call this.
 * @param {object|null} t tenants row (plan, plan_overrides, trial_ends_at, grace_ends_at)
 * @param {string} coll
 * @param {{ kind?: string }} [principal]
 */
export function assertCollectionWritable(t, coll, principal, now = new Date()) {
  const feats = COLLECTION_FEATURES[coll];
  if (!t) throw featureNotInPlan(feats?.[0] || 'clients');
  if (principal?.kind === 'api_key' && !tenantHas(t, 'api', now)) throw featureNotInPlan('api');
  if (!feats || feats.some((f) => tenantHas(t, f, now))) return;
  throw featureNotInPlan(feats[0]);
}

/** Every override key HQ may set: the features of plans.js. */
export const OVERRIDE_KEYS = Object.keys(FEATURE_PLAN);
