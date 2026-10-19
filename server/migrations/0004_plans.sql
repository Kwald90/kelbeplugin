-- Plans: the tiers live in electrical-app/js/plans.js. Here: which plan names are valid,
-- per-company feature overrides set by HQ, and when a free trial ends.
ALTER TABLE tenants
  ADD COLUMN plan_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(plan_overrides) = 'object'),
  ADD COLUMN trial_ends_at timestamptz;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_plan_known CHECK (plan IN ('trial', 'starter', 'pro', 'business', 'enterprise'));

GRANT UPDATE (plan_overrides, trial_ends_at) ON tenants TO fishtape_hq;
