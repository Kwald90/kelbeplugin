-- 0140 location access: helpers for the location tables in 0141 (docs/compliance/privacy.md,
-- "Location while clocked in"). Raw location points belong to one person. On top of the usual
-- tenant policy, their table gets a RESTRICTIVE policy that compares each row's employee id with
-- the employee id of the signed-in member, so even an owner or foreman session cannot read
-- someone else's points through any query path (REST, sync, AI tools, a forgotten filter).
--
-- Two narrow scopes, set only by server code with set_config(..., true) inside one transaction:
--   'system'  the retention job (services/location.js): reads, scrubs and deletes old points
--   'crew'    the opt-in live crew map (GET /api/v1/location/live): read-only, latest point per
--             person who is clocked in right now, only when the company turned the map on

-- The employees record id of the member making this request (memberships.employee_id), or NULL
-- for API keys, the worker and anyone not linked to an employee.
CREATE FUNCTION app_member_employee_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT m.employee_id FROM memberships m
     WHERE m.tenant_id = app_tenant_id() AND m.user_id::text = app_user_id() AND m.status = 'active'
  $$;

CREATE FUNCTION app_location_scope() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.location_scope', true), '') $$;
