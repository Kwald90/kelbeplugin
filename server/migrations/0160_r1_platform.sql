-- 0160 Release 1: rules table, period locks, sync rejections, server document counters
-- (docs/releases/r1-get-paid.md 2.6, 2.7, 2.10).

-- Platform rules: legal and statutory values Fishtape maintains for every company (HQ edits them).
-- A company may override a row with its own record in the `rules` collection (0161).
CREATE TABLE platform_rules (
  key            text NOT NULL CHECK (key ~ '^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,5}$'),
  province       text NOT NULL DEFAULT '' CHECK (province = '' OR province ~ '^[A-Z]{2}$'),
  effective_from date NOT NULL DEFAULT '1900-01-01',
  value          jsonb,                       -- NULL = not set; never used by any calculation
  status         text NOT NULL CHECK (status IN ('verified', 'sourced', 'verify')),
  source         text CHECK (source IS NULL OR length(source) <= 500),
  source_url     text CHECK (source_url IS NULL OR (source_url ~ '^https://' AND length(source_url) <= 500)),
  note           text CHECK (note IS NULL OR length(note) <= 1000),
  confirmed_by   text CHECK (confirmed_by IS NULL OR length(confirmed_by) <= 200),
  confirmed_at   timestamptz,
  updated_by     text NOT NULL CHECK (length(updated_by) <= 200),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, province, effective_from),
  CHECK (status <> 'verified' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
GRANT SELECT ON platform_rules TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_rules TO fishtape_hq;

-- Period locks: append-only history. The current lock of a kind is its newest row.
CREATE TABLE period_locks (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id         bigint GENERATED ALWAYS AS IDENTITY,
  kind       text NOT NULL CHECK (kind IN ('books', 'payroll')),
  through    date,                            -- books: records posted on or before are read-only; payroll: exported through (informational); NULL = none
  previous   date,
  reason     text CHECK (reason IS NULL OR length(reason) <= 500),
  preflight  jsonb,                           -- the pre-close counts the owner saw (2.6), no money
  actor      text NOT NULL CHECK (length(actor) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX period_locks_kind_idx ON period_locks (tenant_id, kind, id DESC);
ALTER TABLE period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY period_locks_tenant ON period_locks
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT ON period_locks TO fishtape_app;
GRANT SELECT ON period_locks TO fishtape_hq;

-- Writes the server refused (sync, REST or a system actor): who, what and why, never the data.
CREATE TABLE sync_rejections (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL CHECK (length(actor) <= 200),
  device_id   text CHECK (device_id IS NULL OR length(device_id) <= 128),
  collection  text NOT NULL CHECK (length(collection) <= 64),
  record_id   text NOT NULL CHECK (length(record_id) <= 128),
  code        text NOT NULL CHECK (length(code) <= 64),
  message     text CHECK (message IS NULL OR length(message) <= 500),
  resolved_at timestamptz,
  resolved_by text CHECK (resolved_by IS NULL OR length(resolved_by) <= 200),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX sync_rejections_open_idx ON sync_rejections (tenant_id, at DESC) WHERE resolved_at IS NULL;
ALTER TABLE sync_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_rejections_tenant ON sync_rejections
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_rejections TO fishtape_app;
GRANT SELECT ON sync_rejections TO fishtape_hq;

-- Numbers the server hands out so offline devices never collide (field tickets in R1).
CREATE TABLE doc_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('ticket')),
  next      integer NOT NULL CHECK (next > 0),
  PRIMARY KEY (tenant_id, kind)
);
ALTER TABLE doc_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_counters_tenant ON doc_counters
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT, UPDATE ON doc_counters TO fishtape_app;

-- Seed rows (2.7). Province MB unless noted; a NULL value is "not set" and drives nothing.
-- 'sourced' cites a published source not yet confirmed for us; 'verify' is unconfirmed or missing.
-- The 2026 CPP, CPP2, EI and WCB values are loaded by HQ from canada.ca and WCB Manitoba before
-- release (question 9); they are NULL here on purpose.
INSERT INTO platform_rules (key, province, effective_from, value, status, source, note, updated_by) VALUES
  ('pp.MB.inForceFrom', 'MB', '2025-04-01', '"2025-04-01"', 'sourced', 'Manitoba proclamation, S.M. 2023 c. 30 (The Builders'' Liens Amendment Act), in force 2025-04-01', 'Applies to prime contracts signed on or after this day.', 'migration:0160'),
  ('pp.MB.paymentDays', 'MB', '2025-04-01', '28', 'sourced', 'MHCA, "Understanding prompt payment rules now in effect"; MLT Aikins prompt payment summary', NULL, 'migration:0160'),
  ('pp.MB.nonPaymentNoticeDays', 'MB', '2025-04-01', '14', 'sourced', 'MHCA, "Understanding prompt payment rules now in effect"', NULL, 'migration:0160'),
  ('pp.MB.subPaymentDays', 'MB', '2025-04-01', '7', 'sourced', 'MHCA, "Understanding prompt payment rules now in effect"', NULL, 'migration:0160'),
  ('pp.MB.subNonPaymentNoticeDays', 'MB', '2025-04-01', NULL, 'verify', 'VERIFY: a contractor''s notice period to its subcontractor', 'No alarm in Release 1.', 'migration:0160'),
  ('pp.MB.appliesTo', 'MB', '2025-04-01', NULL, 'verify', 'VERIFY with a lawyer: exclusions (residential work, value thresholds)', 'Alarms run on every Manitoba prime contract with "check it applies" until confirmed.', 'migration:0160'),
  ('pp.MB.dayRollover', 'MB', '2025-04-01', NULL, 'verify', 'VERIFY: whether a deadline on a weekend or holiday moves to the next business day (The Interpretation Act)', 'Shown as "may move" until confirmed.', 'migration:0160'),
  ('pp.MB.adjudicationPayDays', 'MB', '2025-04-01', '10', 'sourced', 'MHCA, "Understanding prompt payment rules now in effect"', 'Shown only; no alarm in Release 1.', 'migration:0160'),
  ('holdback.MB.pct', 'MB', '1900-01-01', NULL, 'verify', 'VERIFY: The Builders'' Liens Act holdback percentage', 'Display only; invoices use the job''s contract.holdbackPct.', 'migration:0160'),
  ('holdback.MB.releaseDays', 'MB', '1900-01-01', NULL, 'verify', 'VERIFY: MHCA says 60 days; older guidance 40 days from the certificate', 'No countdown until a lawyer confirms.', 'migration:0160'),
  ('holdback.excludePassThrough', '', '1900-01-01', 'true', 'verify', 'VERIFY with a lawyer: out-of-pocket disbursements outside the holdback base', 'Kelvin''s default.', 'migration:0160'),
  ('lien.MB.days', 'MB', '1900-01-01', NULL, 'verify', 'VERIFY: the lien deadline under the amended Act', 'No countdown in Release 1.', 'migration:0160'),
  ('properInvoice.MB.fields', 'MB', '2025-04-01', '["contractorName","contractorAddress","invoiceDate","periodFrom","periodTo","contractRef","description","amountDue","paymentTerms","payeeContact"]', 'verify', 'VERIFY with a lawyer: what a proper invoice must contain', 'Warnings only.', 'migration:0160'),
  ('tax.CA.gstHoldbackAtRelease', '', '1900-01-01', 'true', 'sourced', 'Excise Tax Act s.168(7)', NULL, 'migration:0160'),
  ('tax.CA.gstDueAtSubstantialCompletion', '', '1900-01-01', 'true', 'sourced', 'Excise Tax Act s.168(3)(c)', NULL, 'migration:0160'),
  ('tax.MB.rstHoldbackAtRelease', 'MB', '1900-01-01', 'true', 'verify', 'Kelvin''s default, to confirm with the accountant', 'If the accountant says RST was due at billing, the deferred RST is remitted late with interest.', 'migration:0160'),
  ('tax.SK.pstHoldbackAtRelease', 'SK', '1900-01-01', 'true', 'verify', 'VERIFY with the accountant', NULL, 'migration:0160'),
  ('tax.BC.pstHoldbackAtRelease', 'BC', '1900-01-01', 'true', 'verify', 'VERIFY with the accountant', NULL, 'migration:0160'),
  ('tax.MB.passThroughAllowed', 'MB', '1900-01-01', 'true', 'verify', 'VERIFY: Manitoba RST Bulletin 031 wording on separately billed out-of-pocket disbursements', NULL, 'migration:0160'),
  ('payroll.MB.vacationPct', 'MB', '1900-01-01', '4', 'sourced', 'Manitoba Employment Standards Code (vacation pay)', NULL, 'migration:0160'),
  ('payroll.MB.vacationPctLong', 'MB', '1900-01-01', '6', 'sourced', 'Manitoba Employment Standards Code (vacation pay after 5 years)', NULL, 'migration:0160'),
  ('payroll.MB.vacationLongYears', 'MB', '1900-01-01', '5', 'sourced', 'Manitoba Employment Standards Code (vacation pay)', NULL, 'migration:0160'),
  ('payroll.MB.constructionHolidayPct', 'MB', '1900-01-01', '4', 'sourced', 'Manitoba Employment Standards, construction industry fact sheet (general holiday pay)', NULL, 'migration:0160'),
  ('payroll.CA.ei.employerFactor', '', '1900-01-01', '1.4', 'sourced', 'Employment Insurance Act s.68', NULL, 'migration:0160'),
  ('payroll.CA.cpp.rate', '', '2026-01-01', NULL, 'verify', 'canada.ca CPP contribution rates for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.CA.cpp.ympe', '', '2026-01-01', NULL, 'verify', 'canada.ca CPP contribution rates for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.CA.cpp.basicExemption', '', '2026-01-01', NULL, 'verify', 'canada.ca CPP contribution rates for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.CA.cpp2.rate', '', '2026-01-01', NULL, 'verify', 'canada.ca CPP2 contribution rates for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.CA.cpp2.yampe', '', '2026-01-01', NULL, 'verify', 'canada.ca CPP2 contribution rates for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.CA.ei.rate', '', '2026-01-01', NULL, 'verify', 'canada.ca EI premium rates for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.CA.ei.mie', '', '2026-01-01', NULL, 'verify', 'canada.ca EI maximum insurable earnings for 2026 (HQ loads before release)', NULL, 'migration:0160'),
  ('payroll.MB.wcb.maxAssessableCents', 'MB', '2026-01-01', NULL, 'verify', 'WCB Manitoba maximum assessable earnings for 2026 (HQ loads before release)', NULL, 'migration:0160');
