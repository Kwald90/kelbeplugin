# Fishtape data model

PostgreSQL 17, one database (`fishtape`), schema `public`. Sources of truth:
`server/db/bootstrap.sql` (roles), `server/migrations/` (tables, policies, grants),
`server/src/collections.js` (the per-collection registry `0003_collections.sql` is generated
from), and `electrical-app/js/schema/<collection>.json` (record bodies).

## Roles

| role | attributes | used by | can do |
| --- | --- | --- | --- |
| `fishtape_owner` | LOGIN, NOBYPASSRLS | `npm run migrate` | owns every object. Still subject to RLS (every tenant table is `FORCE ROW LEVEL SECURITY`). |
| `fishtape_app` | LOGIN, NOBYPASSRLS, NOINHERIT | API and worker | SELECT/INSERT/UPDATE on tenant tables (no DELETE: deletes are soft); SELECT/INSERT on `audit_events`; DML on the platform tables it manages. |
| `fishtape_hq` | LOGIN, **BYPASSRLS**, read-only by default | `/api/hq/*` only | SELECT almost everywhere; may change tenant status/plan, feature flags and queue rows; INSERT on `audit_events`. Never granted `recovery_codes`, `password_resets` or `tenant_secrets`. |

`bootstrap.sql` also revokes `CREATE` on `public` from everyone else and sets
`statement_timeout` (30 s app, 60 s HQ) and `idle_in_transaction_session_timeout` (60 s app).
The API refuses to start in staging/production if `DATABASE_URL` is a superuser or BYPASSRLS
role.

## Tenant isolation

Every tenant row carries `tenant_id uuid`. Every tenant table has RLS **enabled and forced**,
with one policy:

```sql
USING      (tenant_id = app_tenant_id() AND <portal rule>)
WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
```

`app_tenant_id()` is `NULLIF(current_setting('app.tenant_id', true), '')::uuid`: unset or empty
means NULL, and NULL matches nothing, so a connection without a tenant sees zero rows and can
write none. The API sets it in exactly one place, `withTenant(ctx, fn)` in `server/src/db.js`:

```
BEGIN
SELECT set_config('app.tenant_id', $tenant, true),       -- transaction-local
       set_config('app.user_id', $user, true),
       set_config('app.portal_client_id', $portalClient, true)
[SELECT pg_advisory_xact_lock(tenant_lock_key($tenant))]  -- writes
... queries (which also filter tenant_id = $tenant explicitly) ...
COMMIT
```

Because the settings are transaction-local, a pooled connection forgets the tenant at
`COMMIT`/`ROLLBACK`. A trigger refuses any `UPDATE` that changes `tenant_id` or `id`.

**Client portal (Phase 1).** When `app.portal_client_id` is set, tables with a `client_id`
(leads, jobs, estimates, invoices) show only that client's rows, `clients` shows only the
client itself, every other tenant table shows nothing, and every write is refused.

`test/isolation.test.js` proves all of this at the API and the database level.

## Tenant data tables (one per collection)

Every collection in `electrical-app/js/store.js` `COLLECTIONS` except `auditLog` has a table
of the same shape:

| column | type | notes |
| --- | --- | --- |
| `tenant_id` | uuid | FK `tenants`, part of the PK |
| `id` | text | the record id from the PWA (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`); PK `(tenant_id, id)`, so two companies may use the same id without touching each other |
| `data` | jsonb | the record body as the PWA stores it (`createdAt`, `updatedAt` and every field), validated against the JSON Schema |
| `version` | bigint | 1 on insert, +1 on every write (set by trigger) |
| `change_seq` | bigint | from the global sequence `change_seq`, set by trigger on every write; drives sync pull |
| `created_at`, `updated_at` | timestamptz | server time (trigger) |
| `deleted_at` | timestamptz | soft delete; the row stays as a tombstone so devices learn about the delete |
| `created_by`, `updated_by` | text | actor, e.g. `user:<uuid>`, `api_key:<uuid>`, `system:seed` |
| generated columns | text, `GENERATED ALWAYS AS (data->>'…') STORED` | indexed per tenant; listed below |

Indexes on every table: `(tenant_id, change_seq)`, `(tenant_id, created_at DESC, id DESC)`,
and `(tenant_id, <generated column>)` for each generated column.

| collection | table | generated columns (field) |
| --- | --- | --- |
| clients | `clients` | — |
| leads | `leads` | `client_id` (clientId), `status` (stage) |
| sequences | `sequences` | — |
| enrolments | `enrolments` | `lead_id`, `sequence_id`, `status` |
| outbox | `outbox` | `status`, `related_id` |
| jobs | `jobs` | `client_id`, `status`, `number` |
| schedule | `schedule` | `job_id`, `employee_id`, `day` (date) |
| estimates | `estimates` | `client_id`, `job_id`, `status`, `number` |
| invoices | `invoices` | `client_id`, `job_id`, `status`, `number` |
| payments | `payments` | `invoice_id` |
| items | `items` | `sku` |
| locations | `locations` | — |
| stockMoves | `stock_moves` | `job_id`, `item_id` |
| employees | `employees` | — |
| timeEntries | `time_entries` | `employee_id`, `job_id` |
| drawings | `drawings` | `job_id` |
| sops | `sops` | — |
| permits | `permits` | `job_id`, `status`, `number` |
| inspections | `inspections` | `job_id`, `permit_id`, `status` (result) |
| certifications | `certifications` | `employee_id` |
| checklists | `checklists` | `job_id` |
| panels | `panels` | `job_id` |
| settings | `settings` | — (one row, id `settings`) |
| wireRuns | `wire_runs` | `job_id`, `drawing_id` |
| bends | `bends` | `job_id` |
| benderProfiles | `bender_profiles` | — |

### Write ordering

The `tenant_record_stamp` trigger takes `pg_advisory_xact_lock(tenant_lock_key(tenant_id))`
before it draws a `change_seq`. Writers for one company therefore commit in `change_seq`
order, so a sync cursor never skips a row that commits late (the classic gap problem with
global sequences). Different companies never wait on each other. The same lock keeps each
company's audit hash chain linear.

### Record bodies (JSON Schemas)

`electrical-app/js/schema/<collection>.json` (draft-07, one per collection plus `index.json`),
shared by the browser and the server (ajv, no type coercion). Known fields are typed, optional
fields accept `null` (the PWA's "not set"), and extra fields are allowed so front-end additions
are not rejected. `id` is required; `settings` must be `"settings"`. Enums are enforced only
where `docs/BUILD-PLAN.md` fixes the values (bend kinds, conduit types and trade sizes, wire
run method/source/material, roles).

Size limits per record (JSON bytes): 512 KiB by default, **24 MiB for drawings** (underlay
data URLs, up to 20 MiB), **64 MiB for wire runs** (up to 12 photos as JPEG data URLs, about
4.8 MB each). These blobs belong in object storage: drawing underlays and wire-run photos
should move to an object store (S3-compatible, per-tenant prefixes, signed URLs) with only a
reference in the record. Until then, the sync push body limit is about 72 MiB and nginx must
allow it on `/api/`.

The server never stores `employees.pin` (crew PINs are argon2 hashes on `memberships`).

## Sync support tables (tenant-scoped, RLS)

| table | purpose |
| --- | --- |
| `sync_mutations` | `(tenant_id, mid)` → the stored result, so a replayed mutation returns its first answer. Purged after 30 days by the worker. |
| `record_history` | the losing side of every last-writer-wins conflict: `reason = 'overwritten'` (server copy replaced by a newer client edit) or `'rejected'` (client edit older than the server copy), with version, data, mid and actor. |

## Audit log

`audit_events` replaces the PWA's `auditLog` collection on the server. Every write appends a
row: REST, sync, sign-ins and failures, member/key/device/secret changes, HQ reads of tenant
data. Columns: `seq`, `tenant_id` (NULL for platform events such as failed sign-ins for an
unknown email), `at`, `actor_type` (`user`, `api_key`, `agent`, `system`, `hq`), `actor_id`,
`actor_label`, `action`, `collection`, `record_id`, `summary`, `ip`, `user_agent`,
`request_id`, `meta`, `prev_hash`, `hash`.

- **Append-only:** the app and HQ roles have INSERT and SELECT only; triggers refuse UPDATE,
  DELETE and TRUNCATE for everyone.
- **Hash chain per tenant** (plus one `platform` chain): a `SECURITY DEFINER` trigger takes the
  tenant lock, assigns `seq` and `at`, and sets
  `hash = sha256(prev_hash | seq | tenant | at | actor | action | collection | record | summary | ip | request | meta)`.
  Chain heads live in `audit_chain_heads`, which only the owner can touch.
- `audit_verify_chain(tenant)` re-walks a chain and compares it with the head, so edited,
  removed or truncated events are detected. The app can verify its own company; HQ any.
- RLS: a company reads only its own chain; the app with no tenant may append platform events
  but read none.

## Platform tables (no tenant RLS)

Reached only through the auth and admin code, never through `withTenant`.

| table | key columns | notes |
| --- | --- | --- |
| `tenants` | `id`, `slug`, `name`, `status` (active/suspended/closed), `province`, `plan` | |
| `users` | `id`, `email` (unique, lower-case, NULL for PIN-only crew), `password_hash` (argon2id), `platform_role` (`hq_staff`/`hq_admin`), `status`, `failed_logins`, `locked_until` | a user can belong to several companies |
| `memberships` | `(tenant_id, user_id)` unique, `role` (owner/admin/office/foreman/electrician/apprentice), `employee_id` (unique per tenant), `status` (active/invited/disabled), `pin_hash`, `pin_failed`, `pin_locked_until` | the server's source of truth for roles |
| `sessions` | `token_hash` (sha-256), `user_id`, `tenant_id` (active company), `kind` (web/bearer/crew), `device_id`, `auth_method`, `mfa_verified_at`, `expires_at`, `idle_timeout_s`, `last_seen_at`, `revoked_at` | tokens themselves are never stored |
| `mfa_factors` | `user_id`, `secret_enc` (AES-256-GCM under `SECRETS_MASTER_KEY`), `confirmed_at`, `last_time_step` (replay guard) | |
| `recovery_codes` | `user_id`, `code_hash`, `used_at` | 10 per user, single use |
| `oauth_identities` | `(provider, subject)` unique → `user_id` | Google, Microsoft |
| `password_resets` | `token_hash`, `purpose` (reset/invite), `expires_at`, `used_at` | 1 hour / 7 days |
| `devices` | `tenant_id`, `name`, `token_hash`, `failed_pins`, `locked_until`, `revoked_at` | shared iPads |
| `api_keys` | `tenant_id`, `prefix` (display), `key_hash` (sha-256), `scopes[]`, `expires_at`, `revoked_at`, `last_used_at` | |
| `portal_users` | `tenant_id`, `client_id`, `email`, `password_hash` | Phase 1 client portal |
| `tenant_secrets` | `(tenant_id, name)`, `value_enc` | **RLS forced**; envelope encryption (random data key per value, wrapped by the master key, bound to `tenant:name`) |
| `email_outbox` | `to_address`, `subject`, `text_body`, `status` | written by the `email` interface; a sender drains it (Phase 1). Reset links live here until sent; sent rows are purged after 7 days. |
| `jobs_queue` | `kind`, `payload`, `status`, `run_at`, `attempts`, `max_attempts`, `dedupe_key`, `last_error` | worker claims with `FOR UPDATE SKIP LOCKED`; backoff 10 s × 2ⁿ up to 1 h |
| `feature_flags` | `(key, tenant_id)` | `signup_open` (platform-wide, off by default) |
| `schema_migrations` | `version`, `name`, `checksum`, `applied_at` | written by the migrator |

## Retention (worker, hourly)

| data | kept |
| --- | --- |
| sessions | until 1 day past expiry (idle or absolute) or 7 days past revocation |
| password reset/invite links | 7 days past expiry |
| sent emails | 7 days |
| finished queue jobs | 30 days |
| `sync_mutations` | 30 days |
| tombstones, `record_history`, `audit_events` | not purged yet (retention policy to be set with compliance) |
