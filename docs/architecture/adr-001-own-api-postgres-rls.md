# ADR-001: Our own API on PostgreSQL with row-level security

- Status: accepted (2026-10-19)
- Deciders: Kelvin (product), workstream A (backend)

## Context

Fishtape becomes a SaaS for many electrical contractors, each with its own customers, jobs,
invoices and crew. Until now everything lived in IndexedDB on one device. We need a server
that keeps companies apart with certainty, works with an offline-first PWA and an iOS app,
and does not tie us to one vendor. Kelvin ruled out a hosted backend-as-a-service; staging
and production are our own VPSes running Docker.

The single worst failure for this product is one company seeing another's data. Application
code alone ("remember to add `WHERE tenant_id = …`") fails the first time someone forgets.

## Decision

1. **Node.js 22 + Fastify 5 + PostgreSQL 17**, plain ESM JavaScript with JSDoc, no build step,
   few mainstream dependencies at exact versions.
2. **Shared database, shared schema, `tenant_id` on every tenant row**, isolated by Postgres
   **row-level security**, `ENABLE` and `FORCE` on every tenant table, with policies on
   `current_setting('app.tenant_id', true)` for both `USING` and `WITH CHECK`.
3. **Three roles.** The API connects as `fishtape_app` (NOBYPASSRLS). Migrations run as
   `fishtape_owner` (also subject to RLS because of FORCE). Only HQ uses `fishtape_hq`
   (BYPASSRLS), and every HQ read of a company's data writes an audit event into that
   company's chain.
4. **One path to tenant data:** `withTenant(ctx, fn)` opens a transaction, sets
   `app.tenant_id`, `app.user_id` and `app.portal_client_id` with `set_config(…, true)`, then
   runs the queries. Nothing else sets those values. Queries also filter by `tenant_id`
   explicitly; RLS is the backstop that does not depend on getting that right.
5. **One table per collection** with the same shape (`data jsonb` plus version, change
   sequence, timestamps, soft delete, actors) and stored generated columns for the fields we
   filter and index on. Record bodies are validated with the JSON Schemas the PWA also uses.
6. **Append-only, hash-chained audit log** per company.

## Consequences

- An unset tenant means zero rows, not all rows. A bug in a route can at worst return nothing.
- `test/isolation.test.js` is the gate: API-level (sessions, API keys, guessed ids, crafted
  cursors, sync) and database-level (no tenant → 0 rows; cross-tenant insert/update refused).
- One schema means one migration run for all companies and simple HQ queries. Very large
  companies could later move to their own database with the same code (the tenant id stays).
- `jsonb` bodies keep the PWA's flexible records and let front-end workstreams add fields
  without migrations. The cost: weaker typing in SQL, so validation lives in the JSON Schemas,
  and any field we need to query becomes a generated column (a migration).
- Every write for one company takes a per-company advisory lock (see ADR-002). Fine for
  contractor-sized companies; revisit if a single company ever writes hundreds of times a
  second.
- Connection poolers must run in session or transaction mode that preserves transaction-local
  settings (PgBouncer transaction mode is fine because `set_config(…, true)` is per transaction).

## Alternatives considered

- **Database per tenant:** strongest isolation, but migrations, pooling and HQ reporting
  multiply with every company. Overkill for small contractors; still possible later.
- **Schema per tenant:** the same operational cost with weaker guarantees than separate
  databases.
- **Application-only filtering:** rejected; one missed `WHERE` is a breach.
- **Supabase/Firebase:** fast to start but vendor lock-in, and Kelvin wants to own the stack.
