-- 0169 Marketing hub: the sell-side material and the tracked trial links, all run from HQ.
-- Two platform tables (no tenant, no RLS -- this is Fishtape's own marketing, not a company's
-- data): marketing_pieces holds the editable, co-brandable pieces (the printable catalog is the
-- first), and marketing_campaigns holds the tracked links that carry a trial length and, through
-- signups.campaign_code, let HQ see which link drove which sign-up. HQ writes both; the app reads
-- pieces to render a published page and reads/bumps a campaign to resolve a link and count visits.

CREATE TABLE marketing_pieces (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  kind        text NOT NULL DEFAULT 'catalog' CHECK (kind IN ('catalog', 'flyer', 'onepager', 'email')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  content     jsonb NOT NULL DEFAULT '{"sections":[]}'::jsonb,   -- the block model (services/marketing.js)
  cobrand     jsonb NOT NULL DEFAULT '{}'::jsonb,                -- { enabled, partner, tagline, accent }
  updated_by  uuid,                                             -- the HQ user who last saved (platform_users.id)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON marketing_pieces TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_pieces TO fishtape_hq;

CREATE TABLE marketing_campaigns (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  piece_id    uuid REFERENCES marketing_pieces (id) ON DELETE SET NULL,   -- the page the link opens, if any
  trial_days  integer NOT NULL DEFAULT 75 CHECK (trial_days BETWEEN 1 AND 730),
  plan        text CHECK (plan IS NULL OR plan IN ('starter', 'pro', 'business')),
  active      boolean NOT NULL DEFAULT true,
  visits      integer NOT NULL DEFAULT 0 CHECK (visits >= 0),   -- landings that resolved this link
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON marketing_campaigns TO fishtape_app;         -- resolve a link
GRANT UPDATE (visits) ON marketing_campaigns TO fishtape_app; -- count a visit; never changes the terms
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_campaigns TO fishtape_hq;

-- Attribution: which tracked link a self-serve sign-up came through. Starts and completions are
-- then just COUNTs over signups by this code, so HQ shows the true funnel without a fragile counter.
ALTER TABLE signups ADD COLUMN campaign_code text
  CHECK (campaign_code IS NULL OR campaign_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
CREATE INDEX signups_campaign_idx ON signups (campaign_code) WHERE campaign_code IS NOT NULL;
-- The app writes it on INSERT (it already has full DML on signups); HQ reads it with the rest.
GRANT SELECT (campaign_code) ON signups TO fishtape_hq;
