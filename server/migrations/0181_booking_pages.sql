-- 0181 Online booking front door (resi service-shop): the per-tenant public booking page.
-- A booking_pages row maps a shop-chosen, globally-unique public slug to a tenant, so the
-- PUBLIC, unauthenticated booking route can resolve a tenant from the slug alone -- there is no
-- tenant context yet, the slug is what establishes it (the same pattern as marketing_campaigns
-- resolving a tracked link in services/marketing.js). One platform table, no tenant column of its
-- own beyond the FK and no RLS: it holds only a slug->tenant mapping and an on/off flag, never a
-- company's data. The booking form's content (which service types to offer, which intake fields,
-- the confirmation message, the shop's contact) lives in the tenant's settings doc under
-- `booking`; this table is just the resolver.
--
--   public app pool  : SELECT to resolve a slug; INSERT/UPDATE/DELETE so a signed-in owner can
--                       claim/rename/disable THEIR OWN row through routes/v1/booking.js (which
--                       always scopes the write to the caller's tenant_id; the UNIQUE(slug)
--                       constraint enforces global uniqueness and rejects a taken slug).
--   hq pool          : full DML for support/visibility.

CREATE TABLE booking_pages (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,   -- one page per tenant
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),  -- 2-63 chars, lower-case
  enabled     boolean NOT NULL DEFAULT false,   -- the single public gate: a disabled slug 404s
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- tenant_id (PK) and slug (UNIQUE) are both indexed; the public resolver looks up by slug.
GRANT SELECT, INSERT, UPDATE, DELETE ON booking_pages TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON booking_pages TO fishtape_hq;
