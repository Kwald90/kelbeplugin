-- 0120 Public service status (status.fishtapehq.com, site/status.html): what the worker's
-- probes saw (status_daily counters for the 90-day uptime bars, status_latest for "now"),
-- incident and maintenance notices HQ admins post, and optional email subscribers.
-- Fishtape's own platform data, not tenant data, so no RLS. Separate from HQ's internal
-- compliance incidents (0021_hq_compliance.sql).
--
-- Access by role:
--   fishtape_app  (API + worker)  writes the probe tables (worker), reads notices ONLY through
--                 the *_public views (published notices, public columns), and manages
--                 subscribers for the public subscribe / confirm / unsubscribe endpoints.
--   fishtape_hq   (hq-api)        reads the probe tables and subscribers, writes notices.

-- Probe counters: one row per UTC day and component. The worker adds one check every 5
-- minutes (288 a day) and deletes rows older than 120 days.
CREATE TABLE status_daily (
  day       date NOT NULL,
  component text NOT NULL CHECK (component IN ('app', 'api', 'hq', 'signin', 'email', 'payments')),
  checks    integer NOT NULL DEFAULT 0 CHECK (checks >= 0),
  outages   integer NOT NULL DEFAULT 0 CHECK (outages >= 0),
  degraded  integer NOT NULL DEFAULT 0 CHECK (degraded >= 0),
  PRIMARY KEY (day, component)
);

-- The last probe result per component. changed_at moves only when the status changes.
CREATE TABLE status_latest (
  component  text PRIMARY KEY CHECK (component IN ('app', 'api', 'hq', 'signin', 'email', 'payments')),
  status     text NOT NULL CHECK (status IN ('operational', 'degraded', 'outage', 'unknown')),
  checked_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON status_daily TO fishtape_app;
GRANT SELECT, INSERT, UPDATE ON status_latest TO fishtape_app;
GRANT SELECT ON status_daily, status_latest TO fishtape_hq;

-- Public notices. Drafts (published = false) never leave HQ.
CREATE TABLE status_notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('incident', 'maintenance')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  impact      text NOT NULL CHECK (impact IN ('none', 'minor', 'major', 'maintenance')),
  components  text[] NOT NULL DEFAULT '{}'
              CHECK (components <@ ARRAY['app', 'api', 'hq', 'signin', 'email', 'payments']::text[] AND cardinality(components) <= 6),
  status      text NOT NULL,
  published   boolean NOT NULL DEFAULT false,
  starts_at   timestamptz,             -- maintenance window (an incident may record when it began)
  ends_at     timestamptz,
  resolved_at timestamptz,             -- set when the status becomes resolved / completed
  created_by  uuid,                    -- HQ user; no FK, the record outlives staff
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'incident' AND status IN ('investigating', 'identified', 'monitoring', 'resolved'))
      OR (kind = 'maintenance' AND status IN ('scheduled', 'in_progress', 'completed'))),
  CHECK (kind = 'maintenance' OR impact <> 'maintenance'),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX status_notices_public_idx ON status_notices (published, resolved_at);

-- The public timeline of a notice.
CREATE TABLE status_notice_updates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id  uuid NOT NULL REFERENCES status_notices (id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed')),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX status_notice_updates_notice_idx ON status_notice_updates (notice_id, created_at DESC);

-- What the public API may see: published notices and their updates, public columns only
-- (no authors, no draft flag). The views run with their owner's rights.
CREATE VIEW status_notices_public WITH (security_barrier) AS
  SELECT id, kind, title, impact, components, status, starts_at, ends_at, resolved_at, created_at, updated_at
    FROM status_notices
   WHERE published;

CREATE VIEW status_notice_updates_public WITH (security_barrier) AS
  SELECT u.id, u.notice_id, u.status, u.body, u.created_at
    FROM status_notice_updates u
    JOIN status_notices n ON n.id = u.notice_id
   WHERE n.published;

GRANT SELECT ON status_notices_public, status_notice_updates_public TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON status_notices, status_notice_updates TO fishtape_hq;

-- Email subscribers (off until HQ turns it on: platform_settings key 'status',
-- { "subscribeEnabled": true }). Double opt-in: a row is pending until the emailed link
-- (token in the URL fragment, only its sha-256 stored) confirms it. The unsubscribe token
-- goes into every notice email; it can only remove this one row. Unconfirmed rows are
-- deleted after 7 days by the probe job.
CREATE TABLE status_subscribers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  confirm_token_hash text CHECK (confirm_token_hash IS NULL OR confirm_token_hash ~ '^[0-9a-f]{64}$'),
  confirm_sent_at    timestamptz,
  unsubscribe_token  text NOT NULL UNIQUE CHECK (unsubscribe_token ~ '^[A-Za-z0-9_-]{32,64}$'),
  confirmed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON status_subscribers TO fishtape_app;
GRANT SELECT ON status_subscribers TO fishtape_hq;
