-- 0020 HQ tenants and billing: suspend/export/delete with a grace period, Fishtape's own
-- Stripe subscription per company, audited support access, and the purge the worker runs
-- once a deletion's grace period is over.

-- Tenant lifecycle ----------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN status_reason       text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  ADD COLUMN status_changed_at   timestamptz,
  ADD COLUMN last_export_at      timestamptz,               -- deletion needs a recent export
  ADD COLUMN delete_requested_at timestamptz,
  ADD COLUMN delete_requested_by uuid,                      -- HQ user; no FK, the log outlives staff
  ADD COLUMN delete_after        timestamptz;               -- purge runs at or after this

-- Fishtape's subscription for the company (Fishtape's own Stripe account, never the
-- company's key). The plan in force stays in tenants.plan; these mirror Stripe.
ALTER TABLE tenants
  ADD COLUMN stripe_customer_id     text UNIQUE CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  ADD COLUMN stripe_subscription_id text CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  ADD COLUMN billing_status         text NOT NULL DEFAULT 'none'
    CHECK (billing_status IN ('none', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused')),
  ADD COLUMN billing_plan           text CHECK (billing_plan IS NULL OR billing_plan IN ('starter', 'pro', 'business', 'enterprise')),
  ADD COLUMN current_period_end     timestamptz,
  ADD COLUMN cancel_at_period_end   boolean NOT NULL DEFAULT false,
  ADD COLUMN billed_seats           integer CHECK (billed_seats IS NULL OR billed_seats >= 0),
  -- A failed payment keeps the paid plan until grace_ends_at; after that the company
  -- falls back (services/entitlements.js effectivePlan). A paid invoice clears both.
  ADD COLUMN past_due_since         timestamptz,
  ADD COLUMN grace_ends_at          timestamptz;

CREATE INDEX tenants_delete_after_idx ON tenants (delete_after) WHERE delete_after IS NOT NULL;

-- HQ may change the lifecycle columns; billing columns are written by the API (webhook).
GRANT UPDATE (status_reason, status_changed_at, last_export_at, delete_requested_at, delete_requested_by, delete_after)
  ON tenants TO fishtape_hq;
-- HQ schedules the purge job when it requests a deletion.
GRANT INSERT ON jobs_queue TO fishtape_hq;

-- Stripe events (Fishtape's account), stored once by event id so a replay is a no-op.
-- No card data: type, amounts and what we did with it.
CREATE TABLE billing_events (
  id                text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 255),
  type              text NOT NULL CHECK (length(type) BETWEEN 1 AND 100),
  tenant_id         uuid REFERENCES tenants (id) ON DELETE SET NULL,
  amount_cents      bigint,
  currency          text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  outcome           text NOT NULL CHECK (outcome IN ('applied', 'ignored', 'unknown_customer')),
  summary           text CHECK (summary IS NULL OR length(summary) <= 500),
  stripe_created_at timestamptz,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_events_tenant_idx ON billing_events (tenant_id, received_at DESC);
CREATE INDEX billing_events_type_idx ON billing_events (type, received_at DESC);
GRANT SELECT, INSERT ON billing_events TO fishtape_app;
GRANT SELECT ON billing_events TO fishtape_hq;

-- Support access: time-boxed (at most 8 h), read-only, with a reason. Opening and
-- closing it, and every read, write an audit event into the company's own chain.
CREATE TABLE support_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  hq_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason     text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours')
);
CREATE INDEX support_grants_tenant_idx ON support_grants (tenant_id, created_at DESC);
GRANT SELECT, INSERT ON support_grants TO fishtape_hq;
GRANT UPDATE (revoked_at) ON support_grants TO fishtape_hq;
-- The app role gets nothing here: companies see support access in their audit log.

-- Purge a closed company whose grace period is over. Runs as the owner so the cascade
-- reaches every tenant table (RLS does not apply to referential actions). Accounts that
-- belonged only to this company, and are not HQ staff, are removed too. audit_events
-- has no foreign key: the company's chain stays as the record of what happened.
CREATE FUNCTION purge_tenant(p_tenant uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    t tenants;
    members uuid[];
  BEGIN
    SELECT * INTO t FROM tenants WHERE id = p_tenant FOR UPDATE;
    IF NOT FOUND OR t.status <> 'closed' OR t.delete_after IS NULL OR t.delete_after > now() THEN
      RETURN false;
    END IF;
    SELECT COALESCE(array_agg(user_id), '{}') INTO members FROM memberships WHERE tenant_id = p_tenant;
    DELETE FROM tenants WHERE id = p_tenant;
    DELETE FROM users u
     WHERE u.id = ANY (members)
       AND u.platform_role IS NULL
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
    RETURN true;
  END
  $$;
REVOKE ALL ON FUNCTION purge_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tenant(uuid) TO fishtape_app;
