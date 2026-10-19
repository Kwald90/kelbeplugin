-- 0002 audit: append-only audit_events, hash-chained per tenant (plus one 'platform'
-- chain for events with no tenant, e.g. failed sign-ins).
--
-- hash = sha256(prev_hash | seq | tenant | at | actor | action | collection | record | summary | ip | request | meta)
-- seq, at, prev_hash and hash are always set by the trigger, never by the caller.

CREATE SEQUENCE audit_events_seq AS bigint;

CREATE TABLE audit_events (
  seq         bigint PRIMARY KEY,
  tenant_id   uuid,                          -- NULL = platform chain. No FK: the log outlives tenants.
  at          timestamptz NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'agent', 'system', 'hq')),
  actor_id    text,
  actor_label text,
  action      text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  collection  text,
  record_id   text,
  summary     text CHECK (summary IS NULL OR length(summary) <= 500),
  ip          text,
  user_agent  text,
  request_id  text,
  meta        jsonb,
  prev_hash   text,
  hash        text NOT NULL
);
CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, seq);
CREATE INDEX audit_events_record_idx ON audit_events (tenant_id, collection, record_id);

-- Latest hash of each chain. Only the owner (via the SECURITY DEFINER trigger) touches it.
CREATE TABLE audit_chain_heads (
  chain_key text PRIMARY KEY,                -- tenant uuid or 'platform'
  last_seq  bigint NOT NULL,
  last_hash text NOT NULL
);

CREATE FUNCTION audit_event_digest(prev text, e audit_events) RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT encode(sha256(convert_to(concat_ws('|',
      COALESCE(prev, ''), e.seq::text, COALESCE(e.tenant_id::text, ''),
      to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      e.actor_type, COALESCE(e.actor_id, ''), e.action, COALESCE(e.collection, ''),
      COALESCE(e.record_id, ''), COALESCE(e.summary, ''), COALESCE(e.ip, ''),
      COALESCE(e.request_id, ''), COALESCE(e.meta::text, '')), 'UTF8')), 'hex')
  $$;

CREATE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    k text := COALESCE(NEW.tenant_id::text, 'platform');
    h text;
  BEGIN
    -- Same lock as tenant record writes, so a chain only ever grows in one order.
    IF NEW.tenant_id IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('fishtape:platform', 0));
    ELSE
      PERFORM pg_advisory_xact_lock(tenant_lock_key(NEW.tenant_id));
    END IF;
    NEW.seq := nextval('audit_events_seq');
    NEW.at := now();
    SELECT last_hash INTO h FROM audit_chain_heads WHERE chain_key = k;
    NEW.prev_hash := h;
    NEW.hash := audit_event_digest(h, NEW);
    INSERT INTO audit_chain_heads (chain_key, last_seq, last_hash) VALUES (k, NEW.seq, NEW.hash)
      ON CONFLICT (chain_key) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '42501'; END $$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- RLS: a tenant sees and appends only its own chain; with no tenant set, the app may
-- append platform events (tenant_id NULL) but read none.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read ON audit_events FOR SELECT
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
CREATE POLICY audit_events_append ON audit_events FOR INSERT
  WITH CHECK (tenant_id IS NOT DISTINCT FROM app_tenant_id());

-- Head of a chain. A hash reveals nothing, so any API role may read it; the table stays private.
CREATE FUNCTION audit_chain_head(p_tenant uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT last_hash FROM audit_chain_heads WHERE chain_key = COALESCE(p_tenant::text, 'platform') $$;

-- Verify one chain end to end, including that nothing was cut off the end.
-- Runs with the caller's rights: the app can only verify its current tenant's
-- chain (RLS); HQ (BYPASSRLS) can verify any chain, including 'platform' (NULL).
CREATE FUNCTION audit_verify_chain(p_tenant uuid)
  RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint)
  LANGUAGE plpgsql STABLE
  AS $$
  DECLARE
    r audit_events;
    prev text := NULL;
    n bigint := 0;
  BEGIN
    FOR r IN SELECT * FROM audit_events WHERE tenant_id IS NOT DISTINCT FROM p_tenant ORDER BY seq LOOP
      n := n + 1;
      IF r.prev_hash IS DISTINCT FROM prev OR r.hash IS DISTINCT FROM audit_event_digest(prev, r) THEN
        RETURN QUERY SELECT false, n, r.seq;
        RETURN;
      END IF;
      prev := r.hash;
    END LOOP;
    IF audit_chain_head(p_tenant) IS DISTINCT FROM prev THEN
      RETURN QUERY SELECT false, n, NULL::bigint;   -- rows missing from the end
      RETURN;
    END IF;
    RETURN QUERY SELECT true, n, NULL::bigint;
  END
  $$;

REVOKE ALL ON FUNCTION audit_chain_head(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_chain_head(uuid) TO fishtape_app, fishtape_hq;

GRANT SELECT, INSERT ON audit_events TO fishtape_app;
GRANT SELECT, INSERT ON audit_events TO fishtape_hq;
-- audit_chain_heads: no grants. audit_events_seq: used only inside the definer trigger.
