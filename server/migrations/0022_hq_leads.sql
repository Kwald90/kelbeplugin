-- 0022 HQ leads: Fishtape's own Enterprise sales pipeline, fed by the "Let's talk" form
-- on the pricing page (POST /api/v1/public/enterprise-leads). The API (fishtape_app)
-- may only insert; HQ reads and works the pipeline.

CREATE TABLE hq_leads (
  id           uuid PRIMARY KEY,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email        text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  company      text NOT NULL CHECK (length(company) BETWEEN 1 AND 200),
  phone        text CHECK (phone IS NULL OR length(phone) <= 40),
  province     text CHECK (province IS NULL OR province ~ '^[A-Z]{2}$'),
  team_size    text CHECK (team_size IS NULL OR team_size IN ('1-5', '6-15', '16-50', '51-200', '200+')),
  message      text CHECK (message IS NULL OR length(message) <= 4000),
  source       text NOT NULL DEFAULT 'pricing' CHECK (source ~ '^[a-z0-9-]{1,40}$'),
  stage        text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  owner_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  notes        text NOT NULL DEFAULT '' CHECK (length(notes) <= 8000),
  next_step_at date,
  value_cents  bigint CHECK (value_cents IS NULL OR value_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_leads_stage_idx ON hq_leads (stage, created_at DESC);

GRANT INSERT ON hq_leads TO fishtape_app;
GRANT SELECT ON hq_leads TO fishtape_hq;
GRANT UPDATE (stage, owner_id, notes, next_step_at, value_cents, updated_at) ON hq_leads TO fishtape_hq;
