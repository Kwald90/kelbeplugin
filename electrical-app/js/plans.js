// Plans and what each one unlocks. Shared by the PWA (locked modules, upgrade prompts),
// the server (entitlement checks on the API, sync, AI and integrations) and HQ.
// Prices are placeholders in CAD cents until Kelvin sets them; HQ can override per company.

export const PLAN_IDS = ['starter', 'pro', 'business', 'enterprise'];

export const PLANS = {
  starter: { name: 'Starter', priceCents: 4900, includedUsers: 2, blurb: 'For a solo electrician or a two-person crew' },
  pro: { name: 'Pro', priceCents: 12900, includedUsers: 10, blurb: 'Plans, takeoff and permits for a growing crew' },
  business: { name: 'Business', priceCents: 27900, includedUsers: 25, blurb: 'AI, automation and integrations for a busy shop' },
  enterprise: { name: 'Enterprise', priceCents: null, includedUsers: null, contactSales: true, blurb: "Custom limits, SSO and setup done for you. Let's talk." },
};

export const EXTRA_USER_CENTS = 1500;
export const CURRENCY = 'CAD';

/** Lowest plan that includes each module (by module id) or feature key. Anything missing is in every plan. */
export const FEATURE_PLAN = {
  // modules
  dashboard: 'starter', clients: 'starter', leads: 'starter', jobs: 'starter', schedule: 'starter',
  estimates: 'starter', invoices: 'starter', employees: 'starter', time: 'starter', sops: 'starter',
  calcs: 'starter', bending: 'starter', wireruns: 'starter', settings: 'starter', integrations: 'starter', billing: 'starter', help: 'starter',
  drawings: 'pro', panels: 'pro', inventory: 'pro', compliance: 'pro', sequences: 'pro', security: 'pro',
  assistant: 'business',
  // features inside modules
  'drawings.rooms': 'pro', 'wireruns.trace': 'pro', portal: 'pro', 'payments.online': 'pro', 'integrations.email': 'pro',
  'ai.assistant': 'business', 'ai.cec': 'business', 'ai.background': 'business', api: 'business', mcp: 'business',
  'integrations.sms': 'business', 'integrations.facebook': 'business', 'locations.multi': 'business',
  sso: 'enterprise', 'setup.service': 'enterprise',
};

export const planRank = (id) => PLAN_IDS.indexOf(id);

/** The lowest plan that includes a feature, or null if every plan has it. */
export const planFor = (feature) => FEATURE_PLAN[feature] || null;

/**
 * hasFeature('pro', 'drawings') -> true. `overrides` ({ feature: true|false }) come from HQ
 * and win over the plan. An unknown plan id gets nothing beyond the always-on features.
 */
export function hasFeature(planId, feature, overrides = {}) {
  if (overrides && Object.hasOwn(overrides, feature)) return !!overrides[feature];
  const need = FEATURE_PLAN[feature];
  if (!need) return true;
  const have = planRank(planId);
  return have >= 0 && have >= planRank(need);
}

/** Every feature key the plan (plus overrides) unlocks. */
export function entitlements(planId, overrides = {}) {
  return Object.keys(FEATURE_PLAN).filter((f) => hasFeature(planId, f, overrides));
}

/** Monthly price in cents for a plan and head count, or null for Enterprise. */
export function monthlyCents(planId, users = 1) {
  const p = PLANS[planId];
  if (!p || p.priceCents == null) return null;
  return p.priceCents + Math.max(0, users - p.includedUsers) * EXTRA_USER_CENTS;
}
