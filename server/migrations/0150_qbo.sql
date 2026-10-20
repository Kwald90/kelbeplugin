-- 0150 QuickBooks Online two-way sync (docs/integrations/quickbooks.md).
-- Tokens and the realm id live in tenant_secrets (qbo.refresh_token, qbo.access_token, qbo.realm_id).
-- Nothing in this file holds a plain secret. Tenant tables: RLS enabled and forced, like the rest.

-- ---- platform tables (read before a tenant is known; no customer data) ----

-- Which tenant owns a realm. realm_hash = HMAC-SHA256 (sealer.mac('qbo-realm', env || ':' || realmId)).
-- The primary key makes one tenant per realm; UNIQUE (tenant_id) makes one realm per tenant.
-- Anyone may read (hashes and tenant ids only: webhook routing, realm_in_use); only the tenant itself
-- may insert or delete its row.
CREATE TABLE qbo_realms (
  realm_hash  bytea PRIMARY KEY CHECK (length(realm_hash) = 32),
  tenant_id   uuid NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qbo_realms ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_realms FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_realms_read ON qbo_realms FOR SELECT USING (true);
CREATE POLICY qbo_realms_insert ON qbo_realms FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY qbo_realms_delete ON qbo_realms FOR DELETE USING (tenant_id = app_tenant_id());

-- Connect tickets, OAuth state and takeover offers (the callback arrives with no tenant context).
CREATE TABLE qbo_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stage           text NOT NULL CHECK (stage IN ('ticket', 'authorizing', 'takeover')),
  ticket_hash     bytea NOT NULL UNIQUE CHECK (length(ticket_hash) = 32),
  state_hash      bytea UNIQUE CHECK (length(state_hash) = 32),
  flow_hash       bytea CHECK (length(flow_hash) = 32),
  verifier_sealed text CHECK (length(verifier_sealed) <= 400),
  realm_hash      bytea CHECK (length(realm_hash) = 32),          -- takeover only
  tokens_sealed   text CHECK (length(tokens_sealed) <= 12000),    -- takeover only: sealed TokenSet + realm id
  return_to       text NOT NULL CHECK (return_to IN ('web', 'app')),
  reconnect       boolean NOT NULL DEFAULT false,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qbo_oauth_states_expires_idx ON qbo_oauth_states (expires_at);

-- CorePlus/Core call counts per tenant per month (budgets, HQ). Counts only. Everyone reads (the
-- workspace total is a sum over tenants); a tenant writes only its own rows.
CREATE TABLE qbo_api_usage (
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  environment    text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  core_calls     integer NOT NULL DEFAULT 0,
  coreplus_calls integer NOT NULL DEFAULT 0,
  throttled      integer NOT NULL DEFAULT 0,
  errors         integer NOT NULL DEFAULT 0,
  alerted_pct    smallint NOT NULL DEFAULT 0,   -- highest per-tenant budget alert sent this month (50, 80, 100)
  PRIMARY KEY (month, tenant_id, environment)
);
ALTER TABLE qbo_api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_api_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_api_usage_read ON qbo_api_usage FOR SELECT USING (true);
CREATE POLICY qbo_api_usage_insert ON qbo_api_usage FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY qbo_api_usage_update ON qbo_api_usage FOR UPDATE USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
-- Retention (13 months, 10.4): qbo_purge deletes a tenant's old months under withTenant.
CREATE POLICY qbo_api_usage_delete ON qbo_api_usage FOR DELETE USING (tenant_id = app_tenant_id());

-- Refresh tokens whose revoke failed (disconnect, purge, tenant close). Survives tenant deletion on
-- purpose (no FK), so a live grant is never forgotten. Retried daily for 14 days.
CREATE TABLE qbo_revoke_pending (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  token_sealed  text NOT NULL CHECK (length(token_sealed) <= 2000),   -- sealed with AAD 'qbo-revoke:' || id
  attempts      integer NOT NULL DEFAULT 0,
  next_try_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Platform health events for HQ alerts (section 9). Kinds and counts only, no customer data.
-- Written by W1 (client, webhook, connection) and W3 (engine); read by W6's alerts job and HQ.
CREATE TABLE qbo_platform_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),   -- digits allowed: intuit_5xx
  -- platform_credentials, invalid_grant, reconnect_needed, webhook_signature, intuit_5xx, safety_brake,
  -- realm_mismatch, revoke_gave_up, budget_threshold
  environment text CHECK (environment IN ('sandbox', 'production')),
  tenant_id   uuid REFERENCES tenants (id) ON DELETE CASCADE
);
CREATE INDEX qbo_platform_events_kind_idx ON qbo_platform_events (kind, at);

-- ---- tenant tables ----

CREATE TABLE qbo_connections (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  environment             text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  realm_hash              bytea NOT NULL CHECK (length(realm_hash) = 32),
  state                   text NOT NULL CHECK (state IN ('setup', 'active', 'paused', 'reconnect_needed', 'disconnected')),
  state_before            text CHECK (state_before IN ('setup', 'active', 'paused')),
  pause_reason            text CHECK (pause_reason IN ('user', 'plan', 'budget', 'tenant_budget', 'brake', 'hq')),
  paused_since            timestamptz,
  reconnect_reason        text CHECK (reconnect_reason IN ('revoked', 'expired', 'not_canada', 'not_cad', 'environment', 'error')),
  company_name            text CHECK (length(company_name) <= 200),
  features                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  connected_at            timestamptz,
  connected_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  access_expires_at       timestamptz,
  refresh_expires_at      timestamptz,
  refresh_hard_expires_at timestamptz,
  last_refresh_at         timestamptz,
  refreshing_until        timestamptz,                 -- token refresh lease (2.4)
  sync_from               date,
  setup                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(setup) = 'object'),
  cdc_cursor              timestamptz,                 -- one cursor; every CDC call asks for every entity (5.4)
  time_cursor             timestamptz,                 -- TimeActivity (not in CDC)
  fishtape_cursor         bigint,                      -- highest change_seq the Fishtape-side sweep has covered (5.12)
  dirty_at                timestamptz,                 -- a webhook arrived since the last pull
  ref_refreshed_at        timestamptz,
  last_pull_at            timestamptz,
  last_push_at            timestamptz,
  last_webhook_at         timestamptz,
  last_scan_at            timestamptz,
  last_manual_pull_at     timestamptz,
  last_check_at           timestamptz,                 -- daily balance check (5.13)
  throttled_until         timestamptz,
  lease_until             timestamptz,
  lease_by                text CHECK (length(lease_by) <= 200),
  lease_epoch             bigint NOT NULL DEFAULT 0,   -- fencing token (5.8)
  brake_allow_until       timestamptz,                 -- "allow once" after a safety brake (5.8)
  brake_allow_count       integer,
  disconnected_at         timestamptz,
  purge_after             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qbo_links (
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  realm_hash     bytea NOT NULL CHECK (length(realm_hash) = 32),
  collection     text NOT NULL CHECK (collection IN ('clients', 'jobs', 'items', 'employees', 'vendors', 'estimates',
                   'invoices', 'payments', 'bills', 'purchaseOrders', 'timeEntries', 'stripePayouts')),
  record_id      text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  role           text NOT NULL DEFAULT 'main' CHECK (role IN ('main', 'fee', 'deposit', 'settlement')),
  qbo_entity     text NOT NULL CHECK (qbo_entity IN ('Customer', 'Item', 'Employee', 'Vendor', 'Estimate', 'Invoice',
                   'Payment', 'Bill', 'Purchase', 'PurchaseOrder', 'TimeActivity', 'Transfer')),
  qbo_id         text CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  qbo_line       text NOT NULL DEFAULT '' CHECK (length(qbo_line) <= 40),
  sync_token     text CHECK (sync_token ~ '^[0-9]{1,10}$'),
  qbo_updated_at timestamptz,
  fishtape_version bigint,
  state          text NOT NULL CHECK (state IN ('pending', 'synced', 'conflict', 'error', 'blocked',
                   'needs_review', 'deleted_remote', 'deleted_local', 'unlinked')),
  owner          text NOT NULL DEFAULT 'both' CHECK (owner IN ('both', 'fishtape', 'quickbooks', 'none')),
  snapshot       jsonb,
  prev_values    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(prev_values) = 'object'),
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  reason         text CHECK (length(reason) <= 60),
  attempts       integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error     text CHECK (length(last_error) <= 500),
  synced_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, collection, record_id, role)
);
CREATE UNIQUE INDEX qbo_links_remote_key ON qbo_links (tenant_id, qbo_entity, qbo_id, qbo_line, role)
  WHERE qbo_id IS NOT NULL AND state <> 'unlinked';
CREATE INDEX qbo_links_state_idx ON qbo_links (tenant_id, state, next_attempt_at);

-- Fishtape changes waiting to go to QBO (one row per record; written by the records afterWrite hook,
-- by the Fishtape-side sweep and by recordStripePayout). Kept while sync is off; deleted only in the
-- transaction that records the link outcome (5.3), or at purge.
CREATE TABLE qbo_outbox (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  collection    text NOT NULL CHECK (length(collection) <= 40),
  record_id     text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  op            text NOT NULL CHECK (op IN ('upsert', 'delete')),
  stale         boolean NOT NULL DEFAULT false,
  held          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(held) = 'object'),  -- device money values kept out of the record (5.2)
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'field_user', 'api_key', 'agent', 'stripe', 'system', 'sweep')),
  rank          smallint NOT NULL CHECK (rank BETWEEN 0 AND 99),
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  not_before    timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claimed_epoch bigint,
  PRIMARY KEY (tenant_id, collection, record_id)
);
CREATE INDEX qbo_outbox_due_idx ON qbo_outbox (tenant_id, rank, not_before);

-- Webhook events that CDC cannot replace: TimeActivity (not in CDC) and merges. One row per object;
-- a newer event overwrites the older one, so the table stays bounded while sync is off. Other entities
-- only set qbo_connections.dirty_at.
CREATE TABLE qbo_inbox (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  realm_hash   bytea NOT NULL CHECK (length(realm_hash) = 32),
  entity       text NOT NULL CHECK (entity IN ('TimeActivity', 'Customer', 'Vendor', 'Item')),
  qbo_id       text NOT NULL CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  op           text NOT NULL CHECK (op IN ('created', 'updated', 'deleted', 'merged')),
  deleted_id   text CHECK (deleted_id ~ '^[0-9]{1,20}$'),
  event_time   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  attempts     smallint NOT NULL DEFAULT 0,
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, entity, qbo_id)
);
CREATE INDEX qbo_inbox_pending_idx ON qbo_inbox (tenant_id, event_time) WHERE processed_at IS NULL;

CREATE TABLE qbo_conflicts (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  link_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('fields', 'review', 'deleted', 'merged')),
  collection  text NOT NULL CHECK (length(collection) <= 40),
  record_id   text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  label       text CHECK (length(label) <= 200),
  reason      text CHECK (length(reason) <= 60),
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array'),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text CHECK (length(resolved_by) <= 200),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, link_id) REFERENCES qbo_links (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX qbo_conflicts_open_key ON qbo_conflicts (tenant_id, link_id) WHERE status = 'open';

CREATE TABLE qbo_sync_log (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL DEFAULT now(),
  direction   text NOT NULL CHECK (direction IN ('push', 'pull', 'system')),
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'skipped', 'conflict', 'error', 'warning', 'info', 'shadow')),
  action      text NOT NULL CHECK (action ~ '^[a-z_]{2,40}$'),
  actor_type  text CHECK (actor_type IN ('user', 'field_user', 'api_key', 'agent', 'stripe', 'system', 'sweep')),
  collection  text CHECK (length(collection) <= 40),
  record_id   text CHECK (length(record_id) <= 128),
  qbo_entity  text CHECK (length(qbo_entity) <= 40),
  label       text CHECK (length(label) <= 200),
  message     text CHECK (length(message) <= 500),
  error_code  text CHECK (length(error_code) <= 60),
  intuit_tid  text CHECK (length(intuit_tid) <= 100),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX qbo_sync_log_at_idx ON qbo_sync_log (tenant_id, at DESC);
CREATE INDEX qbo_sync_log_record_idx ON qbo_sync_log (tenant_id, collection, record_id, id DESC);

CREATE TABLE qbo_mappings (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  realm_hash bytea NOT NULL CHECK (length(realm_hash) = 32),
  kind       text NOT NULL CHECK (kind IN ('item', 'taxCode', 'purchaseTaxCode', 'account', 'paymentMethod',
               'depositTo', 'paidFrom', 'class', 'department', 'term', 'option')),
  key        text NOT NULL CHECK (key ~ '^[A-Za-z0-9+|._:-]{1,64}$'),
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text CHECK (length(updated_by) <= 200),
  PRIMARY KEY (tenant_id, kind, key)
);

-- QBO lists Fishtape needs for choices and lookups (accounts, tax codes, ...). Refreshed on connect,
-- daily and on webhooks. TaxCode/TaxRate are not in CDC, so the daily read is their only source.
-- data holds only the allow-listed fields of section 3.8, never whole QBO objects.
CREATE TABLE qbo_reference (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  realm_hash bytea NOT NULL CHECK (length(realm_hash) = 32),
  kind       text NOT NULL CHECK (kind IN ('Account', 'Item', 'TaxCode', 'TaxRate', 'TaxAgency', 'PaymentMethod',
               'Class', 'Department', 'Term', 'Employee', 'Vendor')),
  qbo_id     text NOT NULL CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  name       text NOT NULL CHECK (length(name) <= 200),
  active     boolean NOT NULL DEFAULT true,
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, qbo_id)
);

-- First-connect matching candidates (the wizard). Deleted 30 days after the scan that wrote them.
CREATE TABLE qbo_candidates (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  realm_hash    bytea NOT NULL CHECK (length(realm_hash) = 32),
  kind          text NOT NULL CHECK (kind IN ('customers', 'jobs', 'items', 'employees', 'vendors', 'estimates', 'invoices', 'payments')),
  fishtape_id   text CHECK (length(fishtape_id) <= 128),
  qbo_id        text CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  qbo_summary   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qbo_summary) = 'object'),
  score         smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  reasons       text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL CHECK (status IN ('matched', 'ambiguous', 'fishtape_only', 'quickbooks_only')),
  choice        text NOT NULL CHECK (choice IN ('link', 'create_in_qbo', 'create_in_fishtape', 'skip')),
  diffs         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diffs) = 'array'),          -- link candidates: [{ field, fishtape, quickbooks }] display values
  field_choices jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_choices) = 'object'), -- { field: 'fishtape'|'quickbooks' }
  confirmed     boolean NOT NULL DEFAULT false,      -- explicit tick for creates dated on or before taxFiledThrough
  chosen_by     text CHECK (length(chosen_by) <= 200),
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  error         text CHECK (length(error) <= 500),
  PRIMARY KEY (tenant_id, id),
  CHECK (fishtape_id IS NOT NULL OR qbo_id IS NOT NULL)
);
CREATE INDEX qbo_candidates_kind_idx ON qbo_candidates (tenant_id, kind, status);

-- Stripe payouts seen on the tenant's Stripe webhook (written by integrations, pushed as QBO Transfers).
-- fee_cents is informational only (Stripe's payout summary) and is never posted: fees are booked per
-- payment (4.9). balance_txns is the payout's balance-transaction list, money only, no customer data.
CREATE TABLE stripe_payouts (
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payout_id          text NOT NULL CHECK (payout_id ~ '^po_[A-Za-z0-9]{8,64}$'),
  amount_cents       bigint NOT NULL,
  currency           text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  arrival_date       date NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'canceled')),
  paid_seen          boolean NOT NULL DEFAULT false,   -- true once 'paid' was ever seen (a later 'failed' reverses)
  automatic          boolean NOT NULL DEFAULT true,
  livemode           boolean NOT NULL,
  payment_intent_ids text[] NOT NULL DEFAULT '{}',
  earliest_charge_at timestamptz,
  balance_txns       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(balance_txns) = 'array'),
  -- [{ id, type, amountCents, feeCents, paymentIntentId|null, created }]
  fee_cents          bigint,
  received_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, payout_id)
);

-- RLS (same shape as 0040) on every tenant table.
ALTER TABLE qbo_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_connections_tenant ON qbo_connections
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
ALTER TABLE qbo_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_links FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_links_tenant ON qbo_links
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_outbox_tenant ON qbo_outbox
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_inbox_tenant ON qbo_inbox
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_conflicts_tenant ON qbo_conflicts
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_sync_log FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_sync_log_tenant ON qbo_sync_log
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_mappings_tenant ON qbo_mappings
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_reference_tenant ON qbo_reference
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE qbo_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_candidates_tenant ON qbo_candidates
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

ALTER TABLE stripe_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_payouts_tenant ON stripe_payouts
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

GRANT SELECT, INSERT, DELETE ON qbo_realms TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_oauth_states, qbo_revoke_pending TO fishtape_app;
GRANT SELECT, INSERT, DELETE ON qbo_platform_events TO fishtape_app;
GRANT SELECT ON qbo_platform_events TO fishtape_hq;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_api_usage TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_connections, qbo_links, qbo_outbox, qbo_inbox, qbo_conflicts,
  qbo_sync_log, qbo_mappings, qbo_reference, qbo_candidates, stripe_payouts TO fishtape_app;

-- HQ (BYPASSRLS): health and counts only, never customer data (column grants), plus pause and release.
GRANT SELECT ON qbo_api_usage TO fishtape_hq;
GRANT SELECT (tenant_id, environment) ON qbo_realms TO fishtape_hq;
GRANT DELETE ON qbo_realms TO fishtape_hq;                                   -- HQ release (2.9)
-- lease_epoch is read by the HQ pause and release (SET lease_epoch = lease_epoch + 1).
GRANT SELECT (tenant_id, environment, state, state_before, pause_reason, paused_since, reconnect_reason,
  features, connected_at, refresh_expires_at, refresh_hard_expires_at, last_pull_at, last_push_at,
  last_webhook_at, last_check_at, throttled_until, disconnected_at, lease_epoch) ON qbo_connections TO fishtape_hq;
GRANT UPDATE (state, state_before, pause_reason, paused_since, lease_epoch, lease_until, updated_at)
  ON qbo_connections TO fishtape_hq;                                         -- HQ pause and release (2.9)
GRANT SELECT (tenant_id, collection, state, reason, updated_at) ON qbo_links TO fishtape_hq;
GRANT SELECT (tenant_id, status, created_at) ON qbo_conflicts TO fishtape_hq;
GRANT SELECT (tenant_id, at, direction, outcome, action, actor_type, collection, error_code, intuit_tid)
  ON qbo_sync_log TO fishtape_hq;
GRANT SELECT (tenant_id, received_at, processed_at, attempts) ON qbo_inbox TO fishtape_hq;
GRANT SELECT (tenant_id, collection, enqueued_at) ON qbo_outbox TO fishtape_hq;
GRANT SELECT (id, environment, attempts, created_at) ON qbo_revoke_pending TO fishtape_hq;
