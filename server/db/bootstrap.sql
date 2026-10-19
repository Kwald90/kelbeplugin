-- Fishtape database bootstrap. Run ONCE per Postgres cluster, as a superuser, with psql:
--
--   psql "postgres://postgres@127.0.0.1:5433/postgres" \
--     -v owner_password="$FISHTAPE_OWNER_PASSWORD" \
--     -v app_password="$FISHTAPE_APP_PASSWORD" \
--     -v hq_password="$FISHTAPE_HQ_PASSWORD" \
--     -f server/db/bootstrap.sql
--
-- Creates three login roles and the `fishtape` database. It is safe to re-run:
-- existing roles get their attributes and passwords reset to the values given.
--   fishtape_owner  owns the schema, runs migrations (npm run migrate). Subject to RLS (FORCE).
--   fishtape_app    what the API and worker use. NOBYPASSRLS: tenant rows only via app.tenant_id.
--   fishtape_hq     HQ console only. BYPASSRLS, read-mostly; every tenant read is audited by the API.
-- Tables, grants and policies come from server/migrations, not from this file.

\set ON_ERROR_STOP on

-- Roles ---------------------------------------------------------------------
SELECT format('CREATE ROLE %I', r)
  FROM unnest(ARRAY['fishtape_owner', 'fishtape_app', 'fishtape_hq']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

SELECT format('ALTER ROLE fishtape_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password')
\gexec
SELECT format('ALTER ROLE fishtape_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 200 PASSWORD %L', :'app_password')
\gexec
SELECT format('ALTER ROLE fishtape_hq LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT CONNECTION LIMIT 20 PASSWORD %L', :'hq_password')
\gexec

-- Database ------------------------------------------------------------------
SELECT 'CREATE DATABASE fishtape OWNER fishtape_owner ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'fishtape')
\gexec

REVOKE ALL ON DATABASE fishtape FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE fishtape TO fishtape_owner;
GRANT CONNECT ON DATABASE fishtape TO fishtape_app, fishtape_hq;

\connect fishtape

-- Schema: owned by fishtape_owner; nobody else may create objects in it.
ALTER SCHEMA public OWNER TO fishtape_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fishtape_app, fishtape_hq;

-- Safe session defaults for the API roles.
ALTER ROLE fishtape_app IN DATABASE fishtape SET statement_timeout = '30s';
ALTER ROLE fishtape_app IN DATABASE fishtape SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE fishtape_hq IN DATABASE fishtape SET statement_timeout = '60s';
ALTER ROLE fishtape_hq IN DATABASE fishtape SET default_transaction_read_only = on;
