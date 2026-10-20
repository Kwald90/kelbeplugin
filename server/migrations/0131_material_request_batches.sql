-- 0131 material request batches (range 0130-0139): each time a company's material requests go
-- to the office as one combined list, once a day at the company's time (services/materials.js)
-- or when someone taps "Send now". The unique index makes the daily send happen at most once
-- per company per local day, however many workers run or retry. Tenant data, RLS like the rest.
-- Holds counts and times only: no contact details, no prices.

CREATE TABLE material_request_batches (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('scheduled', 'now')),
  local_date    date NOT NULL,                       -- the company's own calendar day
  time_zone     text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  job_count     integer NOT NULL DEFAULT 0 CHECK (job_count >= 0),
  emailed       boolean NOT NULL DEFAULT false,
  actor         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX material_request_batches_daily ON material_request_batches (tenant_id, local_date) WHERE kind = 'scheduled';
CREATE INDEX material_request_batches_recent ON material_request_batches (tenant_id, created_at DESC);

ALTER TABLE material_request_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_request_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY material_request_batches_tenant ON material_request_batches
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);

GRANT SELECT, INSERT, UPDATE ON material_request_batches TO fishtape_app;
GRANT SELECT ON material_request_batches TO fishtape_hq;
