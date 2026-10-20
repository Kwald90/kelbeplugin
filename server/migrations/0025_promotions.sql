-- 0025 Promotions: the public landing page's video hero (site/index.html + site/hero.js).
-- HQ admins manage them at /api/hq/promotions. GET /api/v1/public/promotions/active reads
-- only live rows through promotions_public, which has no internal columns (name, notes,
-- status, authors). Fishtape's own marketing, not tenant data, so no RLS; the app role
-- cannot read the table itself.

CREATE TABLE promotions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  starts_at   timestamptz,
  ends_at     timestamptz,
  priority    integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
  -- One optional tag like province=ON or campaign=spring-show; the page passes the visitor's tags.
  audience    text CHECK (audience IS NULL OR audience ~ '^[a-z][a-z0-9_]{0,31}=[A-Za-z0-9_-]{1,64}$'),
  overlay     jsonb NOT NULL CHECK (jsonb_typeof(overlay) = 'object'),
  slides      jsonb NOT NULL CHECK (jsonb_typeof(slides) = 'array' AND jsonb_array_length(slides) BETWEEN 3 AND 5),
  settings    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  notes       text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  uuid,                    -- HQ user; no FK, the record outlives staff
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX promotions_active_idx ON promotions (priority DESC, starts_at) WHERE status = 'active';

-- What the public API may see: active and not yet ended (scheduled ones included, so a cached
-- copy picks them up the moment they start). The view runs with its owner's rights.
CREATE VIEW promotions_public WITH (security_barrier) AS
  SELECT id, starts_at, ends_at, priority, audience, overlay, slides, settings, updated_at
    FROM promotions
   WHERE status = 'active' AND (ends_at IS NULL OR ends_at > now());

GRANT SELECT ON promotions_public TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON promotions TO fishtape_hq;
