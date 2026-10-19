-- 0050 AI (workstream J): assistant conversations, drafts people approve, background
-- suggestions, token usage per company and call, per-company AI settings and caps.
-- Every table holds one company's data, so each gets RLS ENABLE + FORCE with the
-- same tenant policy as the collection tables (portal sessions see nothing).

-- Per-company AI settings. A missing row means the defaults (src/ai/config.js).
CREATE TABLE ai_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  monthly_cap_cents    integer CHECK (monthly_cap_cents IS NULL OR monthly_cap_cents BETWEEN 0 AND 100000000),  -- US cents of estimated Anthropic spend
  background_enabled   boolean NOT NULL DEFAULT true,
  background_ai_drafts boolean NOT NULL DEFAULT false,  -- let Claude word reminder emails (uses the company's key, counts toward the cap)
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text
);

-- A chat with the assistant or the CEC helper. The system context is frozen when the
-- conversation starts so every turn sends the same prefix (prompt caching and the
-- thinking-block binding both need a byte-identical prefix).
CREATE TABLE ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mode            text NOT NULL CHECK (mode IN ('assistant', 'cec')),
  title           text CHECK (title IS NULL OR length(title) <= 200),
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  system_context  text NOT NULL,
  prompt_version  text NOT NULL,
  message_count   integer NOT NULL DEFAULT 0,
  busy_until      timestamptz,            -- one turn at a time per conversation
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (tenant_id, user_id, updated_at DESC);

-- Messages exactly as sent to / received from the Messages API. `content` is text, not
-- jsonb: jsonb reorders object keys, and a replayed turn must be byte-identical.
-- Append-only: the app role can insert and read, and delete whole conversations.
CREATE TABLE ai_messages (
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX ai_messages_tenant_idx ON ai_messages (tenant_id, conversation_id);

-- Proposals from the assistant or an MCP agent: estimate lines or an invoice. Nothing
-- changes in estimates/invoices until a person accepts the draft in the app.
CREATE TABLE ai_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('estimate', 'invoice')),
  status            text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'discarded')),
  target_collection text NOT NULL CHECK (target_collection IN ('estimates', 'invoices')),
  target_id         text,                 -- existing document to add lines to; NULL = a new draft document
  base_version      bigint,               -- version of target_id when proposed (accept fails if it changed)
  proposal          jsonb NOT NULL,
  summary           text NOT NULL CHECK (length(summary) <= 500),
  conversation_id   uuid REFERENCES ai_conversations (id) ON DELETE SET NULL,
  created_by        text NOT NULL,        -- actor string: agent:assistant:<user>, api_key:<id>
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_by        text,
  decided_at        timestamptz,
  result_id         text                  -- the estimate/invoice the accepted draft wrote
);
CREATE INDEX ai_drafts_status_idx ON ai_drafts (tenant_id, status, created_at DESC);

-- Findings of the background agents. dedupe_key makes each finding once-only (with a
-- time bucket where a repeat reminder is wanted). outbox_id is the draft message or task.
CREATE TABLE ai_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('overdue_invoice', 'permit_expiry', 'certification_expiry', 'licence_expiry', 'low_stock', 'unapproved_time')),
  dedupe_key         text NOT NULL CHECK (length(dedupe_key) <= 300),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'dismissed')),
  title              text NOT NULL CHECK (length(title) <= 300),
  detail             text CHECK (detail IS NULL OR length(detail) <= 2000),
  related_collection text,
  related_id         text,
  outbox_id          text,
  drafted_by         text NOT NULL DEFAULT 'template' CHECK (drafted_by IN ('template', 'ai')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_by         text,
  decided_at         timestamptz,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX ai_suggestions_status_idx ON ai_suggestions (tenant_id, status, created_at DESC);

-- One row per Messages API call: who, what for, which model, tokens and estimated cost.
-- Insert-only for the app; the monthly cap sums cost_micro_usd for the current month.
CREATE TABLE ai_usage (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  at                 timestamptz NOT NULL DEFAULT now(),
  feature            text NOT NULL CHECK (feature IN ('assistant', 'cec', 'background', 'mcp')),
  model              text NOT NULL,
  actor              text,
  conversation_id    uuid,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cost_micro_usd     bigint NOT NULL DEFAULT 0,
  stop_reason        text
);
CREATE INDEX ai_usage_tenant_at_idx ON ai_usage (tenant_id, at);

-- Throttle for the background agents: one run per company, kind and day.
CREATE TABLE ai_agent_runs (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  run_day     date NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result      jsonb,
  PRIMARY KEY (tenant_id, kind, run_day)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_settings', 'ai_conversations', 'ai_messages', 'ai_drafts', 'ai_suggestions', 'ai_usage', 'ai_agent_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL) WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON ai_settings TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_conversations TO fishtape_app;
GRANT SELECT, INSERT, DELETE ON ai_messages TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON ai_drafts TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON ai_suggestions TO fishtape_app;
GRANT SELECT, INSERT ON ai_usage TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON ai_agent_runs TO fishtape_app;

-- HQ (AI agents page, workstream H): usage, caps and agent runs, never conversations.
GRANT SELECT ON ai_settings, ai_usage, ai_agent_runs TO fishtape_hq;
