// Plans and what each one unlocks. Shared by the PWA (locked modules, upgrade prompts),
// the server (entitlement checks on the API, sync and integrations) and HQ.
// One source of truth for names, prices, billing period and seats; HQ can override per company.
//
// Three self-serve tiers (internal ids kept stable for the database and Stripe):
//   starter  -> Live Wire   $40/year   calculators and concept drawings, solo
//   pro      -> Fully Loaded $149/month the whole app, CRM and a lead-capture website (1-2 users)
//   business -> Full Power   $349/month everything, 5 users included, extra seats $47/user/month
// 'enterprise' is retired as a self-serve tier (Full Power's seat slider covers large crews) but
// stays a valid stored value for any older company and for HQ.

export const PLAN_IDS = ['starter', 'pro', 'business'];

export const PLANS = {
  starter: {
    name: 'Live Wire', priceCents: 4000, period: 'year',
    includedUsers: 1, extraUserCents: 0,
    blurb: 'Calculators and concept drawings for the solo sparky',
  },
  pro: {
    name: 'Fully Loaded', priceCents: 14900, period: 'month',
    includedUsers: 2, extraUserCents: 0,
    blurb: 'The whole app, CRM and a lead-capture website for a small shop',
  },
  business: {
    name: 'Full Power', priceCents: 34900, period: 'month',
    includedUsers: 5, extraUserCents: 4700,
    blurb: 'Everything, with seats you add as the crew grows',
  },
};

// Kept for callers that import a single extra-seat price: the only tier with paid extra seats.
export const EXTRA_USER_CENTS = PLANS.business.extraUserCents;
export const CURRENCY = 'CAD';

/** Billing period for a plan: 'year' or 'month'. */
export const periodOf = (planId) => PLANS[planId]?.period || 'month';

/** Extra-seat price for a plan (0 for tiers with a fixed seat count). */
export const extraUserCents = (planId) => PLANS[planId]?.extraUserCents ?? 0;

/** Lowest plan that includes each module (by module id) or feature key. Anything missing is in every plan. */
export const FEATURE_PLAN = {
  // Live Wire (starter): calculators and concept drawings, plus the shell every account needs.
  calcs: 'starter', bending: 'starter', wireruns: 'starter', drawings: 'starter', panels: 'starter',
  dashboard: 'starter', settings: 'starter', billing: 'starter', help: 'starter',
  onboarding: 'starter', import: 'starter', notifications: 'starter',
  today: 'starter',

  // Fully Loaded (pro): the whole business app, CRM and a lead-capture website.
  clients: 'pro', leads: 'pro', jobs: 'pro', schedule: 'pro', estimates: 'pro', invoices: 'pro',
  booking: 'pro', servicerequests: 'pro',
  employees: 'pro', time: 'pro', labour: 'pro', sops: 'pro', safety: 'pro', materials: 'pro',
  inventory: 'pro', compliance: 'pro', sequences: 'pro', security: 'pro', integrations: 'pro',
  workplan: 'pro', kpis: 'pro', quickbooks: 'pro', purchasing: 'pro',
  books: 'pro', tickets: 'pro', reports: 'pro', 'reports.wip': 'pro', monthend: 'pro',
  walkthroughs: 'pro', assemblies: 'pro', service: 'pro', memberships: 'pro', testing: 'pro', pricelists: 'pro',
  controlpanels: 'pro',
  punchlist: 'pro', dailylog: 'pro',
  faverification: 'pro', irinspection: 'pro',
  rfis: 'pro', submittals: 'pro',
  drawingrevisions: 'pro', procurement: 'pro',
  // features inside modules
  'drawings.rooms': 'pro', 'wireruns.trace': 'pro', portal: 'pro', leadsite: 'pro',
  'payments.online': 'pro', 'integrations.email': 'pro',

  // Full Power (business): scale and integrations for a growing crew.
  api: 'business', 'integrations.sms': 'business', 'integrations.facebook': 'business',
  'locations.multi': 'business', developer: 'business',
  sso: 'business', 'setup.service': 'business',
  // Hidden for now (lib/modules.js), kept so re-enabling is one edit; no label, so it never
  // shows on the pricing page. See the AI-assistant switch in modules/index.js.
  assistant: 'business',
  // AI is off the pricing surface (no labels in billing.js, so it shows nowhere), but the keys
  // stay so the server's AI/MCP routes keep their gate instead of becoming open to every plan.
  'ai.assistant': 'business', 'ai.cec': 'business', 'ai.background': 'business', mcp: 'business',
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

/** Price in cents for a plan's own billing period and head count, or null if the plan is unknown. */
export function priceCents(planId, users = 1) {
  const p = PLANS[planId];
  if (!p || p.priceCents == null) return null;
  return p.priceCents + Math.max(0, users - (p.includedUsers ?? 0)) * (p.extraUserCents ?? 0);
}

/**
 * Monthly-equivalent price in cents (a yearly plan divided by twelve), for MRR and comparisons.
 * Use priceCents + periodOf for anything a customer sees.
 */
export function monthlyCents(planId, users = 1) {
  const c = priceCents(planId, users);
  if (c == null) return null;
  return periodOf(planId) === 'year' ? Math.round(c / 12) : c;
}
