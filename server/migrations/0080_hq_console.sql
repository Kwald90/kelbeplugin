-- 0080 HQ console: platform settings and legal versions, announcements ("What's new"),
-- the finance cache the worker refreshes from Stripe, API usage per company and key, AI
-- errors, and the narrow grants HQ admins need to support users (unlock, force a password
-- reset, sign out everywhere) and to edit a company's AI cap. Every HQ change is audited
-- by the API (routes/hq-*.js).

-- Platform settings HQ can edit (env vars stay read-only and are shown as such).
-- One row per group: 'support' { email, senderName }, 'legal' { terms, privacy }.
CREATE TABLE platform_settings (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  value      jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND pg_column_size(value) <= 16384),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid                      -- HQ user; no FK, the log outlives staff
);
GRANT SELECT ON platform_settings TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON platform_settings TO fishtape_hq;

-- Who accepted which version of the terms and the privacy policy. A version that HQ marks
-- "require re-acceptance" is asked for again in the app until the person accepts it.
CREATE TABLE legal_acceptances (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  doc         text NOT NULL CHECK (doc IN ('terms', 'privacy')),
  version     text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip          text CHECK (ip IS NULL OR length(ip) <= 100),
  PRIMARY KEY (user_id, doc, version)
);
GRANT SELECT, INSERT ON legal_acceptances TO fishtape_app;
GRANT SELECT ON legal_acceptances TO fishtape_hq;

-- Announcements shown as a banner in the app, to everyone or to some plans / provinces.
-- Empty target arrays mean everyone. 'trial' in target_plans means companies on a trial.
CREATE TABLE announcements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  link_url         text CHECK (link_url IS NULL OR (length(link_url) <= 500 AND link_url ~ '^(https://|#/)')),
  link_label       text CHECK (link_label IS NULL OR length(link_label) <= 40),
  tone             text NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'success', 'warning')),
  target_plans     text[] NOT NULL DEFAULT '{}' CHECK (target_plans <@ ARRAY['trial', 'starter', 'pro', 'business', 'enterprise']),
  target_provinces text[] NOT NULL DEFAULT '{}' CHECK (cardinality(target_provinces) <= 13),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz CHECK (ends_at IS NULL OR ends_at > starts_at),
  dismissible      boolean NOT NULL DEFAULT true,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_live_idx ON announcements (status, starts_at);

CREATE TABLE announcement_dismissals (
  announcement_id uuid NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
GRANT SELECT ON announcements TO fishtape_app;
GRANT SELECT, INSERT ON announcement_dismissals TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON announcements TO fishtape_hq;
GRANT SELECT ON announcement_dismissals TO fishtape_hq;

-- Finance summaries computed from Fishtape's Stripe subscriptions and invoices plus the
-- database (services/hq-finance.js). The worker refreshes them hourly so HQ opens fast.
-- Amounts only; no card or personal data.
CREATE TABLE finance_snapshots (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,40}$'),
  data         jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  duration_ms  integer,
  error        text CHECK (error IS NULL OR length(error) <= 300)
);
GRANT SELECT, INSERT, UPDATE ON finance_snapshots TO fishtape_app, fishtape_hq;

-- API requests per company, day and credential (an API key id, or 'session'). Counted in
-- memory by the API and added here in batches through api_usage_add(), so the app role
-- never reads other companies' rows.
CREATE TABLE api_usage_daily (
  day        date NOT NULL,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  actor_key  text NOT NULL CHECK (actor_key = 'session' OR actor_key ~ '^[0-9a-f-]{36}$'),
  requests   integer NOT NULL DEFAULT 0,
  errors_4xx integer NOT NULL DEFAULT 0,
  errors_5xx integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tenant_id, actor_key)
);
CREATE INDEX api_usage_daily_tenant_idx ON api_usage_daily (tenant_id, day);
GRANT SELECT ON api_usage_daily TO fishtape_hq;

CREATE FUNCTION api_usage_add(p jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    INSERT INTO api_usage_daily AS u (day, tenant_id, actor_key, requests, errors_4xx, errors_5xx)
    SELECT (r->>'day')::date, (r->>'tenantId')::uuid, r->>'actorKey',
           GREATEST((r->>'requests')::int, 0), GREATEST((r->>'e4')::int, 0), GREATEST((r->>'e5')::int, 0)
      FROM jsonb_array_elements(p) AS r
     WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.id = (r->>'tenantId')::uuid)
       AND (r->>'actorKey' = 'session' OR r->>'actorKey' ~ '^[0-9a-f-]{36}$')
    ON CONFLICT (day, tenant_id, actor_key) DO UPDATE
      SET requests = u.requests + EXCLUDED.requests, errors_4xx = u.errors_4xx + EXCLUDED.errors_4xx, errors_5xx = u.errors_5xx + EXCLUDED.errors_5xx
  $$;
REVOKE ALL ON FUNCTION api_usage_add(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_usage_add(jsonb) TO fishtape_app;

-- AI errors seen by the API (before or during a streamed reply, and MCP): codes only, never
-- prompts, keys or upstream bodies. The app may only add rows; HQ reads them.
CREATE TABLE ai_error_log (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  feature   text NOT NULL CHECK (feature ~ '^[a-z_]{1,30}$'),
  code      text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,60}$'),
  status    integer
);
CREATE INDEX ai_error_log_at_idx ON ai_error_log (at DESC);
GRANT INSERT ON ai_error_log TO fishtape_app;
GRANT SELECT ON ai_error_log TO fishtape_hq;

-- Assistant tool calls per company, day and tool (counted from the streamed replies, added
-- in batches like API usage). Tool names only.
CREATE TABLE ai_tool_daily (
  day       date NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  tool      text NOT NULL CHECK (tool ~ '^[a-z0-9_]{1,64}$'),
  calls     integer NOT NULL DEFAULT 0,
  errors    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tenant_id, tool)
);
GRANT SELECT ON ai_tool_daily TO fishtape_hq;

CREATE FUNCTION ai_tool_add(p jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    INSERT INTO ai_tool_daily AS u (day, tenant_id, tool, calls, errors)
    SELECT (r->>'day')::date, (r->>'tenantId')::uuid, r->>'tool', GREATEST((r->>'calls')::int, 0), GREATEST((r->>'errors')::int, 0)
      FROM jsonb_array_elements(p) AS r
     WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.id = (r->>'tenantId')::uuid) AND r->>'tool' ~ '^[a-z0-9_]{1,64}$'
    ON CONFLICT (day, tenant_id, tool) DO UPDATE SET calls = u.calls + EXCLUDED.calls, errors = u.errors + EXCLUDED.errors
  $$;
REVOKE ALL ON FUNCTION ai_tool_add(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_tool_add(jsonb) TO fishtape_app;

-- HQ support actions on accounts (routes/hq-users.js, HQ admins only, audited):
-- unlock (password and PIN lockouts), force a password reset (clear the password, sign out
-- everywhere, email a link), revoke sessions. Column grants only; hashes are never read back.
GRANT UPDATE (failed_logins, locked_until, password_hash, password_changed_at, updated_at) ON users TO fishtape_hq;
GRANT UPDATE (pin_failed, pin_locked_until) ON memberships TO fishtape_hq;
GRANT UPDATE (revoked_at) ON sessions TO fishtape_hq;
GRANT SELECT (id, user_id, used_at, expires_at, purpose), INSERT ON password_resets TO fishtape_hq;
GRANT UPDATE (used_at) ON password_resets TO fishtape_hq;
GRANT INSERT ON email_outbox TO fishtape_hq;

-- Developer page: webhook deliveries (ids and kinds only). AI page: edit a company's cap.
GRANT SELECT ON integration_events TO fishtape_hq;
GRANT INSERT, UPDATE ON ai_settings TO fishtape_hq;
