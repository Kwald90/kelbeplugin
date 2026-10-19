# Fishtape server

The API and background worker behind the Fishtape PWA: Node 22 (ESM JavaScript with JSDoc,
no build step), Fastify 5, PostgreSQL 17 with row-level security.

- Contract: [`docs/BUILD-PLAN.md`](../docs/BUILD-PLAN.md) (Backend contract section).
- Endpoints: [`docs/architecture/api.md`](../docs/architecture/api.md), live at `/api/v1/openapi.json`.
- Tables, roles and RLS: [`docs/architecture/data-model.md`](../docs/architecture/data-model.md).
- Decisions: [`adr-001`](../docs/architecture/adr-001-own-api-postgres-rls.md) (own API + RLS),
  [`adr-002`](../docs/architecture/adr-002-sync-protocol.md) (sync),
  [`adr-003`](../docs/architecture/adr-003-auth-sessions.md) (auth and sessions).

## Run it locally

You need Node 22.11+ and a Postgres 17. Two ways to get the Postgres:

**Docker** (preferred, matches staging):

```sh
cp deploy/local/.env.example deploy/local/.env        # set the four passwords
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/.env up -d
```

That starts `postgres:17` on `127.0.0.1:5433` and runs `server/db/bootstrap.sql` once
(roles `fishtape_owner`, `fishtape_app`, `fishtape_hq`; database `fishtape`).

**No Docker:** `npm run test:embedded` uses the `embedded-postgres` dev dependency to run a
throwaway Postgres 17 for the tests (nothing is installed system-wide). For a dev server
without Docker, install Postgres 17 yourself and run the bootstrap with psql:

```sh
psql "postgres://postgres@127.0.0.1:5433/postgres" -v owner_password=... -v app_password=... \
  -v hq_password=... -f server/db/bootstrap.sql
```

Then, in `server/`:

```sh
npm ci
cp .env.example .env          # set DATABASE_URL / MIGRATE_DATABASE_URL / HQ_DATABASE_URL passwords
npm run migrate               # as fishtape_owner
npm run seed                  # demo tenants; prints the generated sign-ins once
npm start                     # API on http://127.0.0.1:3410
npm run worker                # background jobs (another terminal)
```

Serve the PWA as before (`cd electrical-app && python -m http.server 8080`). The PWA and API
are same-origin behind nginx in staging and production (`/api/` is proxied to port 3410).

Seeded sign-ins: `owner@tgelectrical.test`, `owner@alpha.test`, `owner@bravo.test` (owners of
TG Electrical, Test Co Alpha, Test Co Bravo) and `hq@fishtape.test` (HQ staff). Owners and HQ
staff must set up TOTP on first sign-in (`POST /api/v1/auth/mfa/totp/enrol`, then `/confirm`).
The seed refuses to run when `APP_ENV=production`, and opens self-service signup only when
`APP_ENV=local`.

Create a company by hand (works while signup is closed):

```sh
npm run tenant:create -- --name "TG Electrical" --email owner@example.com --owner "Kelvin Waldner" --province AB
```

## Scripts

| script | what it does |
| --- | --- |
| `npm start` | API server (`src/index.js`). Refuses to start in staging/production if `DATABASE_URL` is a role that bypasses RLS. |
| `npm run worker` | Job worker (`src/worker.js`): Postgres queue, `FOR UPDATE SKIP LOCKED`, retries with backoff; hourly housekeeping (expired sessions, reset links, sent emails, old sync records). |
| `npm run migrate` | Applies `migrations/NNNN_*.sql` in order, each in a transaction, as the owner role. `-- --status` lists applied/pending. Editing an applied file is an error. |
| `npm run seed` | Demo tenants, owners, records and one HQ user. Idempotent. Not in production. |
| `npm run tenant:create` | One company + owner from the command line. |
| `npm test` | All tests. DB tests need `TEST_DATABASE_URL` and skip cleanly without it. |
| `npm run test:embedded` | Starts a throwaway Postgres 17, runs `bootstrap.sql` on it, runs every test, removes it. |
| `npm run lint` | `node --check` over every file, and checks `migrations/0003_collections.sql` still matches its generator. |
| `npm run gen:collections-sql` | Regenerates `0003_collections.sql` from `src/collections.js` (only before it ships; after that add a new migration). |

## Tests

```sh
npm run test:embedded                      # no Docker needed
# or against the Docker Postgres (a superuser URL; the tests create and drop their own databases):
TEST_DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/postgres npm test
```

Each test file creates its own database (`ft_test_*`), migrates it as `fishtape_owner`, and
talks to it as `fishtape_app` (with the role password when `TEST_*_PASSWORD` is set, otherwise
by `SET ROLE` from the superuser connection). If the roles do not exist yet, the tests run
`bootstrap.sql` first.

| file | covers |
| --- | --- |
| `test/isolation.test.js` | Tenant A vs tenant B through sessions, API keys, guessed ids, crafted cursors, sync pull/push; `fishtape_app` with no tenant sees 0 rows; cross-tenant inserts/updates refused; audit chain tamper detection; portal context. |
| `test/auth.test.js` | Signup gate, MFA enrolment and verification, recovery codes, login lockout, expired/idle sessions, logout, password change/reset, CSRF and CORS, role rules, crew PIN lockout and device revocation, API key scopes, OIDC (mocked), tenant switching, HQ, rate limits, log redaction. |
| `test/records.test.js` | REST CRUD, If-Match, filters and cursors, sync idempotency, last-writer-wins with history, tombstones, pull paging, health/readiness/status, OpenAPI, the job queue. |
| `test/leaks.test.js` | No customer data in headers, `no-store` everywhere, error bodies never echo input, production 500s hide internals, public endpoints reveal nothing tenant-specific, query parameters are ids only. |
| `test/unit.test.js` | No DB: collections/roles match the PWA, every PWA demo-seed record passes its JSON Schema, wire run/bend/drawing shapes, access rules, crypto, config. |
| `test/migrations.test.js` | Migrations apply and are idempotent; role attributes; RLS enabled and forced with USING + WITH CHECK on every tenant table; grants. |

## Environment variables

All listed with comments in [`.env.example`](.env.example). The important ones:

| variable | notes |
| --- | --- |
| `APP_ENV` | `local`, `test`, `staging`, `production`. Staging/production require `SECRETS_MASTER_KEY` and `DATABASE_URL`, and refuse the public dev key. |
| `PORT`, `HOST` | Default `3410` on `127.0.0.1`. |
| `DATABASE_URL` | `fishtape_app` (NOBYPASSRLS). |
| `MIGRATE_DATABASE_URL` | `fishtape_owner`, for `npm run migrate`. |
| `HQ_DATABASE_URL` | `fishtape_hq` (BYPASSRLS), for `/api/hq/*` reads across tenants. Optional. |
| `PUBLIC_ORIGIN` | The PWA origin, e.g. `https://tgelectrical.truecollarbuilt.com`. Used for CORS, CSRF origin checks, cookies, OIDC redirects and email links. |
| `CORS_ORIGINS` | Extra origins. `capacitor://localhost` (iOS app) is always allowed. |
| `SECRETS_MASTER_KEY` | base64, 32 bytes. Encrypts TOTP secrets and tenant secrets (envelope). Losing it makes those unreadable; rotate by re-wrapping. |
| `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET` | Turn each sign-in provider on. |
| `LOG_LEVEL`, `GIT_SHA` | pino level; commit shown in status and HQ health. |

Keep `server/.env` outside any directory nginx serves (only `electrical-app/` is served),
mode 600, never committed (`server/.gitignore` ignores `.env` and `.env.*`).

## Layout

```
db/bootstrap.sql        roles + database (superuser, once, via psql)
migrations/             0001 platform tables, 0002 audit log, 0003 one table per collection (generated)
src/index.js            API entry          src/worker.js   worker entry
src/app.js              Fastify app: plugins, error format, routes
src/db.js               pools, withTenant() (the only path to tenant rows), TenantTx
src/collections.js      collection registry: tables, generated columns, read/write permissions
src/schemas.js          ajv over electrical-app/js/schema/*.json
src/auth/               permissions, access rules, guard (per-route auth), sessions, MFA, API keys, devices, OIDC
src/services/           records (CRUD + sync), audit, tenants, queue, password links
src/routes/             health, hq, v1/{auth,records,sync,admin}
scripts/                embedded-Postgres test runner, collections SQL generator, lint
test/                   node:test suites (see above)
```

## Things to know

- **Node version.** `cookie` 2.x is ESM-only and needs Node 22.12+. `package.json` pins
  `@fastify/cookie` 11.1.0 and overrides `light-my-request` to 6.6.0 so Node 22.11 works. Drop
  the pins once every machine and image runs 22.12 or later.
- **Big records.** Drawings (underlays) and wire runs (photos) carry data URLs: up to 24 MiB
  and 64 MiB per record, and `/api/v1/sync/push` accepts bodies up to about 72 MiB. nginx needs
  a matching `client_max_body_size` on `/api/`. These blobs should move to object storage.
- **Rate limits** are in memory, per process. With more than one API process, move them to a
  shared store.
- **Document numbers** (`settings.nextNumbers`) are still assigned on the device, so two
  offline devices can both issue J-1005. Server-side numbering is a Phase 1 item.
