-- 0021 HQ compliance & security: incidents with a timeline, vendors, and HQ staff
-- policy acknowledgements. Platform tables for Fishtape itself (no company data), so
-- only the HQ role is granted; the app role sees none of them.

CREATE TABLE hq_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  severity        text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'monitoring', 'resolved', 'closed')),
  summary         text NOT NULL DEFAULT '' CHECK (length(summary) <= 4000),
  customer_impact boolean NOT NULL DEFAULT false,
  opened_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  closed_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_incidents_status_idx ON hq_incidents (status, opened_at DESC);

CREATE TABLE hq_incident_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES hq_incidents (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  author_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  author_label text,
  kind         text NOT NULL CHECK (kind IN ('opened', 'note', 'status', 'severity')),
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000)
);
CREATE INDEX hq_incident_events_incident_idx ON hq_incident_events (incident_id, id);

CREATE TABLE hq_vendors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 120),
  purpose          text NOT NULL DEFAULT '' CHECK (length(purpose) <= 500),
  data_shared      text NOT NULL DEFAULT '' CHECK (length(data_shared) <= 500),
  risk             text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high')),
  assurance        text NOT NULL DEFAULT '' CHECK (length(assurance) <= 200),
  dpa_signed       boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'evaluating' CHECK (status IN ('evaluating', 'active', 'retired')),
  review_due       date,
  last_reviewed_at timestamptz,
  notes            text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Starting list from docs/BUILD-PLAN.md (Services, Sign-in, Environments). Assurance and
-- DPA status are unknown until someone checks: HQ edits these rows.
INSERT INTO hq_vendors (name, purpose, data_shared, risk, notes) VALUES
  ('Stripe', 'Fishtape subscriptions; companies'' invoice payments (their own accounts)', 'Billing contact, company name, payment metadata', 'high', 'Seeded from BUILD-PLAN. Confirm DPA and SOC 2 report.'),
  ('Resend', 'Transactional and sequence email', 'Recipient email addresses, message content', 'high', 'Seeded from BUILD-PLAN. Confirm DPA and SOC 2 report.'),
  ('Twilio', 'SMS for companies that turn it on', 'Recipient phone numbers, message content', 'high', 'Seeded from BUILD-PLAN. Confirm DPA and SOC 2 report.'),
  ('Anthropic', 'AI assistant through each company''s own key', 'Prompts with record excerpts the company sends', 'high', 'Seeded from BUILD-PLAN. Companies bring their own keys.'),
  ('Google', 'Sign in with Google (OIDC)', 'Email, name, account subject id', 'low', 'Seeded from BUILD-PLAN.'),
  ('Microsoft', 'Sign in with Microsoft (OIDC)', 'Email, name, account subject id', 'low', 'Seeded from BUILD-PLAN.'),
  ('GitHub', 'Source code, CI', 'Source code only (no customer data)', 'medium', 'Seeded from BUILD-PLAN.'),
  ('Staging VPS host', 'Staging server (208.113.210.97)', 'Seeded test companies and TG Electrical data', 'high', 'Seeded from BUILD-PLAN. Name the provider.'),
  ('dotmoose', 'Production server (host details pending)', 'All production data', 'high', 'Seeded from BUILD-PLAN. Host details pending.'),
  ('Let''s Encrypt', 'TLS certificates', 'Domain names only', 'low', 'Seeded from BUILD-PLAN.');

CREATE TABLE hq_policies (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,64}$'),
  title      text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  version    text NOT NULL DEFAULT '1.0' CHECK (version ~ '^[0-9A-Za-z.-]{1,20}$'),
  doc_path   text CHECK (doc_path IS NULL OR length(doc_path) <= 300),
  required   boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_policy_acks (
  policy_id text NOT NULL REFERENCES hq_policies (id) ON DELETE CASCADE,
  version   text NOT NULL,
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version, user_id)
);

-- SOC 2-aligned starting set; doc paths are filled in when docs/compliance/ lands.
INSERT INTO hq_policies (id, title) VALUES
  ('information-security', 'Information security policy'),
  ('acceptable-use', 'Acceptable use policy'),
  ('access-control', 'Access control policy'),
  ('incident-response', 'Incident response plan'),
  ('data-retention', 'Data retention and deletion policy'),
  ('vendor-management', 'Vendor management policy'),
  ('change-management', 'Change management policy'),
  ('business-continuity', 'Business continuity and backup policy');

GRANT SELECT, INSERT, UPDATE ON hq_incidents, hq_incident_events, hq_vendors, hq_policies TO fishtape_hq;
GRANT SELECT, INSERT ON hq_policy_acks TO fishtape_hq;
