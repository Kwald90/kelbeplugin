-- Integrations (workstream I): per-company connection state for Stripe, Resend, Twilio,
-- Facebook Lead Ads and Anthropic. The keys themselves live in tenant_secrets; nothing
-- here is secret. Every table is tenant data: RLS enabled and forced, like the rest.

-- Non-secret settings and the last connection test result, one row per provider.
CREATE TABLE integration_settings (
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('stripe', 'resend', 'twilio', 'facebook', 'anthropic')),
  config         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  status         text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'warning', 'error')),
  status_message text CHECK (length(status_message) <= 500),
  tested_at      timestamptz,
  last_event_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

-- Webhook events already handled, so a replay (providers retry) is acknowledged once.
CREATE TABLE integration_events (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('stripe', 'twilio', 'facebook')),
  event_id    text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  kind        text CHECK (length(kind) <= 100),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, event_id)
);
CREATE INDEX integration_events_received_idx ON integration_events (tenant_id, received_at);

-- Numbers that replied STOP (or that Twilio refused as unsubscribed). Texts to them are not sent.
CREATE TABLE sms_opt_outs (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  phone        text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL CHECK (source IN ('reply', 'provider', 'manual')),
  PRIMARY KEY (tenant_id, phone)
);

-- Durable "Pay online" links printed on invoices. The token is random and only its
-- sha-256 is stored; opening the link starts a fresh Stripe Checkout for the balance.
CREATE TABLE pay_links (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL,
  invoice_id   text NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  PRIMARY KEY (tenant_id, token_hash)
);
CREATE UNIQUE INDEX pay_links_live_invoice ON pay_links (tenant_id, invoice_id) WHERE revoked_at IS NULL;

ALTER TABLE integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_settings_tenant ON integration_settings
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_events_tenant ON integration_events
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE sms_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_opt_outs FORCE ROW LEVEL SECURITY;
CREATE POLICY sms_opt_outs_tenant ON sms_opt_outs
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE pay_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_links FORCE ROW LEVEL SECURITY;
CREATE POLICY pay_links_tenant ON pay_links
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON integration_settings, integration_events, sms_opt_outs TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON pay_links TO fishtape_app;
-- HQ support can see whether a company's integrations work (no secrets live here).
GRANT SELECT ON integration_settings TO fishtape_hq;
