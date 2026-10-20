-- 0023 Self-serve sign-up: the public form (POST /api/v1/public/signup) creates a pending
-- sign-up and a Stripe Checkout Session (14-day trial plus a $1 deposit charged now). The
-- signed platform webhook turns a paid sign-up into a company, credits the $1 back on the
-- Stripe customer balance and queues the welcome email. Nothing here is tenant data until
-- the company exists, so this is a platform table like users (no RLS); the API writes it,
-- HQ reads it.
--
-- Personal details (email, name, password hash) are kept only while they are needed:
-- the password hash is cleared once the account exists or the sign-up ends, and an expired
-- or abandoned sign-up loses its email and name straight away (services/signup.js). Ended
-- sign-ups are deleted after 30 days; completed ones stay as the record of the deposit.

CREATE TABLE signups (
  id                         uuid PRIMARY KEY,
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'completed', 'expired', 'abandoned', 'failed')),
  email                      text CHECK (email IS NULL OR (email = lower(email) AND length(email) BETWEEN 3 AND 254)),
  display_name               text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  password_hash              text,
  company_name               text NOT NULL CHECK (length(company_name) BETWEEN 1 AND 200),
  province                   text CHECK (province IS NULL OR province ~ '^[A-Z]{2}$'),
  plan                       text NOT NULL CHECK (plan IN ('starter', 'pro', 'business')),
  user_count                 integer NOT NULL CHECK (user_count BETWEEN 1 AND 500),
  trial_days                 integer NOT NULL CHECK (trial_days BETWEEN 1 AND 730),
  terms_version              text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 40),
  terms_accepted_at          timestamptz NOT NULL,
  -- Stripe (Fishtape's own account). Ids only; never card data.
  stripe_checkout_session_id text UNIQUE CHECK (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  stripe_customer_id         text CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  stripe_subscription_id     text CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  -- The deposit: charged in Checkout, then credited (customer balance) to the first invoice.
  deposit_cents              integer NOT NULL CHECK (deposit_cents >= 0),
  deposit_paid_cents         integer CHECK (deposit_paid_cents IS NULL OR deposit_paid_cents >= 0),
  deposit_paid_at            timestamptz,
  credit_txn_id              text CHECK (credit_txn_id IS NULL OR credit_txn_id ~ '^cbtxn_[A-Za-z0-9]{1,250}$'),
  credited_at                timestamptz,
  credit_error               text CHECK (credit_error IS NULL OR length(credit_error) <= 100),
  -- The company it became.
  tenant_id                  uuid REFERENCES tenants (id) ON DELETE SET NULL,
  user_id                    uuid REFERENCES users (id) ON DELETE SET NULL,
  trial_ends_at              timestamptz,
  -- One-time welcome link (verify the email, then set up two-step sign-in). Hash only.
  welcome_token_hash         bytea UNIQUE,
  welcome_expires_at         timestamptz,
  welcome_used_at            timestamptz,
  failure                    text CHECK (failure IS NULL OR failure ~ '^[a-z_]{1,60}$'),
  expires_at                 timestamptz NOT NULL,           -- when the Checkout Session expires
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz
);
-- One open sign-up per email at a time (a second try replaces the first; services/signup.js).
CREATE UNIQUE INDEX signups_pending_email_key ON signups (email) WHERE status = 'pending';
CREATE INDEX signups_status_idx ON signups (status, expires_at);
CREATE INDEX signups_created_idx ON signups (created_at DESC);
CREATE INDEX signups_tenant_idx ON signups (tenant_id) WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON signups TO fishtape_app;
-- HQ sees the funnel and the deposit, never the password hash or the welcome link hash.
GRANT SELECT (id, status, email, display_name, company_name, province, plan, user_count, trial_days, terms_version,
  terms_accepted_at, deposit_cents, deposit_paid_cents, deposit_paid_at, credited_at, credit_error, tenant_id, user_id,
  trial_ends_at, welcome_expires_at, welcome_used_at, failure, expires_at, created_at, updated_at, completed_at)
  ON signups TO fishtape_hq;
