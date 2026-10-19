-- 0001 platform: tenancy helpers and the platform tables (identity, sessions, keys, queue, flags).
-- Runs as fishtape_owner inside one transaction (src/migrate.js).

-- Tenant context ------------------------------------------------------------
-- withTenant() sets these with set_config(..., true) (transaction-local).
-- Unset or empty means NULL, and NULL matches no tenant row.
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

-- Client-portal sessions (Phase 1) also set app.portal_client_id; policies then
-- narrow reads to that client's rows and refuse every write.
CREATE FUNCTION app_portal_client_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.portal_client_id', true), '') $$;

-- Advisory-lock key per tenant. Writes for one tenant serialise on it, which keeps
-- change_seq in commit order per tenant (sync pull cursors never skip a row) and
-- keeps the audit hash chain linear.
CREATE FUNCTION tenant_lock_key(t uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT hashtextextended('fishtape:tenant:' || t::text, 0) $$;

-- Tenants and identity ------------------------------------------------------
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  province    text CHECK (province IS NULL OR province ~ '^[A-Z]{2}$'),
  plan        text NOT NULL DEFAULT 'trial',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text CHECK (email IS NULL OR (email = lower(email) AND length(email) <= 254)),
  email_verified_at   timestamptz,
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash       text,
  platform_role       text CHECK (platform_role IN ('hq_staff', 'hq_admin')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins       integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  password_changed_at timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Email is optional: PIN-only crew members on a shared iPad have none.
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

CREATE TABLE memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('owner', 'admin', 'office', 'foreman', 'electrician', 'apprentice')),
  employee_id      text,            -- the employees record this member is, inside the tenant
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  pin_hash         text,            -- argon2id of the crew PIN (shared-iPad sign-in)
  pin_failed       integer NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE UNIQUE INDEX memberships_employee_key ON memberships (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash   bytea NOT NULL UNIQUE,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  failed_pins  integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_tenant_idx ON devices (tenant_id);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      bytea NOT NULL UNIQUE,     -- sha-256 of the opaque token; the token itself is never stored
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id       uuid REFERENCES tenants (id) ON DELETE SET NULL,  -- active tenant
  kind            text NOT NULL CHECK (kind IN ('web', 'bearer', 'crew')),
  device_id       uuid REFERENCES devices (id) ON DELETE CASCADE,   -- crew sessions only
  auth_method     text NOT NULL,             -- password | oidc:google | oidc:microsoft | pin | signup | reset
  mfa_verified_at timestamptz,
  mfa_failed      integer NOT NULL DEFAULT 0,
  idle_timeout_s  integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip              text,
  user_agent      text,
  CHECK ((kind = 'crew') = (device_id IS NOT NULL))
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE mfa_factors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type = 'totp'),
  secret_enc     text NOT NULL,              -- sealed with SECRETS_MASTER_KEY (src/lib/crypto.js)
  confirmed_at   timestamptz,
  last_time_step bigint,                      -- replay guard: a code's time step is accepted once
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id);
CREATE UNIQUE INDEX mfa_factors_confirmed_key ON mfa_factors (user_id, type) WHERE confirmed_at IS NOT NULL;

CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

CREATE TABLE oauth_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject       text NOT NULL,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (provider, subject)
);
CREATE INDEX oauth_identities_user_idx ON oauth_identities (user_id);

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  purpose    text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset', 'invite')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prefix       text NOT NULL,              -- shown in lists: ft_live_ab12cd34
  key_hash     bytea NOT NULL UNIQUE,      -- sha-256 of the whole key
  scopes       text[] NOT NULL,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- Client portal (Phase 1). A portal user sees only their own client's rows.
CREATE TABLE portal_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id     text NOT NULL,
  email         text NOT NULL CHECK (email = lower(email)),
  display_name  text,
  password_hash text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- Per-tenant secrets (Stripe, Resend, Twilio, Anthropic keys...). Values are
-- envelope-encrypted (AES-256-GCM data key wrapped by SECRETS_MASTER_KEY).
CREATE TABLE tenant_secrets (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  value_enc   text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);
ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_secrets_tenant ON tenant_secrets
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

-- Platform email (password resets, invites). Written by src/lib/email.js; a sender
-- (Resend, Phase 1) drains it. Rows hold reset links, so sent rows are purged.
CREATE TABLE email_outbox (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,
  to_address text NOT NULL,
  subject    text NOT NULL,
  text_body  text NOT NULL,
  html_body  text,
  template   text,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX email_outbox_status_idx ON email_outbox (status, created_at);

-- Background jobs (src/worker.js claims with FOR UPDATE SKIP LOCKED).
CREATE TABLE jobs_queue (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,
  tenant_id    uuid REFERENCES tenants (id) ON DELETE CASCADE,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_queue_ready_idx ON jobs_queue (run_at, id) WHERE status = 'queued';
CREATE INDEX jobs_queue_status_idx ON jobs_queue (status, finished_at);
CREATE UNIQUE INDEX jobs_queue_dedupe_key ON jobs_queue (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE feature_flags (
  key        text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  tenant_id  uuid REFERENCES tenants (id) ON DELETE CASCADE,   -- NULL = platform-wide
  enabled    boolean NOT NULL DEFAULT false,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_key ON feature_flags (key, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Self-service signup is closed until someone opens it (seed opens it locally).
INSERT INTO feature_flags (key, enabled) VALUES ('signup_open', false);

-- Grants --------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON tenants TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON users TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON devices TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_factors TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recovery_codes TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_identities TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON api_keys TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON portal_users TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_secrets TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_outbox TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs_queue TO fishtape_app;
GRANT SELECT ON feature_flags TO fishtape_app;

-- HQ reads everything (BYPASSRLS), and may change tenant status, flags and the queue.
GRANT SELECT ON tenants, users, memberships, devices, sessions, mfa_factors, oauth_identities,
  api_keys, portal_users, email_outbox, jobs_queue, feature_flags TO fishtape_hq;
GRANT UPDATE (status, plan, updated_at) ON tenants TO fishtape_hq;
GRANT INSERT, UPDATE, DELETE ON feature_flags TO fishtape_hq;
GRANT UPDATE (status, run_at, attempts, last_error) ON jobs_queue TO fishtape_hq;
-- Deliberately not granted to HQ: recovery_codes, password_resets, tenant_secrets (no reason to read them).
