# Fishtape build plan

Fishtape (working name for Kelbe Circuit) becomes a multi-company SaaS for Canadian
electrical contractors, built to the Canadian Electrical Code. This file is the contract
every workstream builds against. Change it before changing a contract in code.

## Decisions (from Kelvin, 2026-10-19)

| topic | decision |
| --- | --- |
| Name | **Fishtape**. Domains to register: fishtapehq.com (+ .ca). Trademark check (CIPO) pending. The name lives in `electrical-app/js/brand.js`; nothing else hard-codes it. |
| Tenancy | Both: many electrical companies (tenants) **and** a client portal for each company's customers. TG Electrical is tenant #1. Test companies are seeded tenants. Data never crosses tenants. |
| Backend | Own API: Node.js 22 + PostgreSQL 17 with row-level security (RLS). No vendor lock-in. |
| Environments | local → **staging** `https://tgelectrical.truecollarbuilt.com` (VPS 208.113.210.97) → **production** on a second VPS at dotmoose.com (host details pending), at `app.fishtapehq.com`. |
| Code book | CEC (CSA C22.1:24) by default, with provincial amendments; NEC 2023 stays as a per-company option. |
| Provinces | ON, BC, AB, SK, MB and Atlantic at launch (QC later: needs Chapter V, QST, French). |
| Units | Each user chooses metric or imperial (`js/lib/units.js`). Stored values are always SI (metres, mm², W). |
| Money | CAD, integer cents, GST/HST/PST/RST by province. |
| Pipe bending | Offsets, kicks, saddles (3/4-point), 90s, stubs, back-to-backs, box/bracket offsets, rolling and parallel offsets, segment bends, rigid and PVC. Diagram + marks for every bend. |
| Box placement | Keep manual placement and takeoff, add CEC checks on the drawing, and auto-place boxes in a drawn room. |
| Wire runs | Named, saved runs; AR tape (WebXR on Android now, ARKit in the iOS app), traced on a drawing, or typed; allowances; PDF export; push to estimate. Phone-motion-only measuring was rejected: accelerometer drift makes it wrong within seconds. |
| Sign-in | Email + password + TOTP MFA (required for owners, admins and HQ staff), Google and Microsoft sign-in, crew PIN on a shared iPad. |
| Offline | Field tools offline (time clock, drawings, calculators, bending, wire runs, SOPs, today's jobs); office tools need a connection. In practice every collection syncs through the same queue. |
| Data | Demo data only today; start clean. |
| Compliance | SOC 2-aligned controls, no formal audit. Evidence tracked in the repo and in HQ. |
| HQ | Tenants, developer health, compliance & security, billing, API keys, AI agents. |
| AI | In-app assistant (estimates/invoices), CEC helper, agent API + MCP server, background agents. Each company brings its own keys (Anthropic etc.) with in-app setup guides. Facebook integration (Lead Ads → leads) requested; "FB Muse" meaning to confirm. |
| Services | Stripe (invoice payments + subscriptions), Resend (email), Twilio (SMS). Per-company keys with guides; setup offered as a paid service. |
| Plans | At most 4 tiers: 3 priced tiers plus **Enterprise ("Let's talk")**. Each module is tagged with the lowest tier that includes it. The server enforces entitlements (API, sync, AI, integrations); the PWA shows locked modules with an upgrade prompt. HQ manages plans, trials and per-tenant overrides; Stripe subscriptions map to tiers. The Enterprise button opens a contact form that creates a lead in Fishtape's own HQ sales pipeline (lead gen) and emails Kelvin. Tier contents and prices are still to be agreed. |
| Wire runs | Uses the `drawings` permission (apprentices included). Photos move from inline data URLs to object storage once the server is live. Removing a row offers Undo. |
| Repo | This repo, branch `claude/electrical-concept-app-h4qz12`. |
| Mobile | iOS app via Capacitor wrapping `electrical-app/`, with a native ARKit measuring plugin. Built on Kelvin's Mac over SSH. Bundle ID proposal: `com.fishtapehq.app`. |

## The 13 layers

| # | layer | where it lives |
| --- | --- | --- |
| 1 | Product & domain | this file, `docs/code/` (CEC), `docs/field/` |
| 2 | Architecture | `docs/architecture/` (ADRs, data model, API) |
| 3 | Environments | `docs/architecture/environments.md`, `deploy/` |
| 4 | CI/CD | `.github/workflows/`, `deploy/*/update.sh` |
| 5 | Identity & access | `server/src/auth/` |
| 6 | Tenancy & isolation | Postgres RLS in `server/migrations/`, `server/test/isolation.test.js` |
| 7 | API | `server/src/routes/v1/`, OpenAPI at `/api/v1/openapi.json` |
| 8 | Data | migrations, backups (`deploy/*/backup.sh`), retention policy |
| 9 | Offline & sync | `electrical-app/js/store.js` + `sync.js`, `/api/v1/sync/*` |
| 10 | Security | `docs/security/`, headers/CSP in nginx, scanners in CI |
| 11 | Observability | `/api/healthz`, `/api/readyz`, `/api/v1/status`, HQ dev health, logs |
| 12 | Compliance | `docs/compliance/`, `compliance/controls.yaml`, evidence scripts |
| 13 | Operations / HQ | `hq/` console, `/api/hq/*`, runbooks in `docs/runbooks/` |

## Repo layout

```
electrical-app/        PWA (vanilla ES modules, no build). Served at / in every environment.
  js/schema/           JSON Schemas per collection, shared by browser and server
server/                API + worker (Node 22, ESM JavaScript, Fastify, pg)
  src/index.js         entry: `npm start`
  src/worker.js        background jobs (queue in Postgres, FOR UPDATE SKIP LOCKED)
  migrations/          NNNN_name.sql, applied in order by `npm run migrate`
  test/                node:test; integration tests need TEST_DATABASE_URL
hq/                    HQ console (Phase 1), served at /hq/
mobile/                Capacitor iOS project (Phase 1, needs the Mac)
deploy/local|staging|production/   docker compose, nginx snippets, update/backup scripts
docs/                  architecture, security, compliance, runbooks, code, field
compliance/            controls.yaml + evidence collectors
.github/workflows/     CI
```

## Environments

| | local | staging | production |
| --- | --- | --- | --- |
| URL | http://localhost:8080 (+ API :3410) | https://tgelectrical.truecollarbuilt.com | https://app.fishtapehq.com, hq., status. |
| Host | dev PC | VPS 208.113.210.97 (CloudPanel nginx, Docker 29, 8 CPU / 31 GB) | dotmoose VPS (TBC) |
| API | `node server/src/index.js` | docker compose `fishtape-staging`, API on 127.0.0.1:3410 | same, own host |
| Postgres | docker, 127.0.0.1:5433 | container `postgres:17`, 127.0.0.1:5433 (the host's own Postgres on 5432 and the app on :3000 belong to other sites, don't touch them) | container or managed, never shared |
| Data | seeds | seeded test tenants + TG Electrical | real |
| Deploy | — | on push to the branch (manual script first, then CI) | from a `v*` tag, manual approval |

Same-origin everywhere: nginx serves the PWA at `/`, proxies `/api/` to the API, serves `/hq/`.
The iOS app calls the API cross-origin from `capacitor://localhost` with a bearer token.

## Backend contract (workstream A builds it; everyone else codes against it)

**Config (env):** `APP_ENV` (local|staging|production), `PORT` (3410), `DATABASE_URL` (app role),
`MIGRATE_DATABASE_URL` (owner role), `HQ_DATABASE_URL` (hq role), `PUBLIC_ORIGIN`, `CORS_ORIGINS`
(adds `capacitor://localhost`), `SECRETS_MASTER_KEY` (base64, 32 bytes, envelope key for tenant
secrets), `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `LOG_LEVEL`, `GIT_SHA`.
Never commit real values; `server/.env.example` lists them.

**Postgres roles:** `fishtape_owner` owns the schema and runs migrations. `fishtape_app` is what
the API uses: LOGIN, NOBYPASSRLS, DML on tenant tables, INSERT-only on `audit_events`.
`fishtape_hq` has BYPASSRLS for HQ only; every HQ read of tenant data writes an audit event.
All tenant tables have `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.

**Tenant context:** each request runs in one transaction that first does
`set_config('app.tenant_id', $tenant, true)`, `app.user_id`, and for portal sessions
`app.portal_client_id`. Policies compare `tenant_id = current_setting('app.tenant_id', true)::uuid`;
unset means no rows. No query path may skip this (one helper: `withTenant(ctx, fn)`).

**Platform tables (not tenant-scoped by RLS):** `tenants`, `users`, `memberships` (user↔tenant,
role), `sessions` (hashed tokens), `mfa_factors`, `recovery_codes`, `oauth_identities`,
`devices` (shared-iPad crew mode), `api_keys` (hashed, scoped, per tenant), `portal_users`,
`tenant_secrets` (AES-256-GCM, envelope-encrypted), `audit_events` (append-only, hash-chained
per tenant), `jobs_queue`, `feature_flags`, `schema_migrations`.

**Tenant data tables:** one per collection in `electrical-app/js/store.js` `COLLECTIONS`
(except `auditLog`, which becomes `audit_events`), same shape:
`tenant_id uuid, id text, data jsonb, version bigint, change_seq bigint (global sequence),
created_at, updated_at, deleted_at (soft delete, tombstones sync), created_by, updated_by`,
PK `(tenant_id, id)`, plus STORED generated columns for fields that need indexes or the portal
filter (`client_id`, `job_id`, `status`, `number`, …). The record body in `data` follows the
data contract in `replica/architecture.md` plus the new collections below. Validation: JSON
Schemas in `electrical-app/js/schema/<collection>.json` (ajv on the server, same files in the browser).

**Sync (offline-first):** `store.js` keeps its synchronous API; Phase 1 adds `sync.js`.
- `POST /api/v1/sync/push` `{ mutations: [{ mid, collection, id, op: 'upsert'|'delete', baseVersion, data }] }`
  → `{ results: [{ mid, status: 'ok', version, changeSeq } | { mid, status: 'conflict', server } | { mid, status: 'rejected', error }] }`.
  Idempotent by `mid`. Conflicts resolve last-writer-wins per record, the loser kept in history.
- `GET /api/v1/sync/pull?since=<changeSeq>&limit=500` → `{ changes: [{ collection, id, version, deleted, data }], cursor, more }`.

**REST:** `/api/v1/{collection}` GET (filters, `limit`, `cursor`), `/:id` GET, POST, PATCH, DELETE.
Same validation and audit as sync. Errors: `{ error: { code, message, requestId } }`.
OpenAPI at `/api/v1/openapi.json`. API keys: `Authorization: Bearer ft_live_…`/`ft_test_…`, scoped
(`jobs:read`, `invoices:write`, …), rate-limited per key.

**Auth:** opaque session tokens (sha-256 stored) in an httpOnly, Secure, SameSite=Lax cookie
`ft_session` for the web, or `Authorization: Bearer` for the iOS app. argon2id passwords, TOTP
MFA + recovery codes, Google/Microsoft OIDC, rate limits and lockouts on every auth route,
CSRF guard (Origin check + `X-Fishtape: 1` header) on state-changing cookie requests.
Shared iPad: a manager registers a device (long-lived, revocable device token); crew sign in on
it with name + PIN (argon2, lockout) and get a short crew session limited to that device.

**Audit:** every write (sync, REST, HQ, agents) appends to `audit_events`: tenant, actor
(user | api key | agent | system | hq staff), action, collection, record id, summary, ip, user
agent, request id, `prev_hash`, `hash`.

**Health:** `GET /api/healthz` (process up), `GET /api/readyz` (DB ping, migrations current, queue
lag; 503 when not ready), `GET /api/v1/status` (public: status, version, environment, no secrets),
`GET /api/hq/health` (HQ staff only: DB latency, pool, migration version, queue depth and failures,
last backup, error counts, memory, uptime, git SHA, cert expiry, disk).

## New front-end collections (Phase 0, synced later like the rest)

All lengths in **metres**. Records follow the store contract (`id`, `createdAt`, `updatedAt`).

- `wireRuns`: `name, jobId?, drawingId?, location, wiringMethod ('cable'|'conduit'), conduit? { type, tradeSize },
  segments[{ id, label, lengthM, source ('ar'|'plan'|'manual'), note, points? [{ x, y, z }] }],
  allowances { drops[{ label, count, lengthM }], boxCount, boxMakeupM, panelMakeupM, wastePct },
  conductors[{ id, description, size, material ('cu'|'al'), type, count, itemId? }], photos[], notes, totalM`
- `bends`: `name, jobId?, kind ('offset'|'kick'|'saddle3'|'saddle4'|'stub90'|'backToBack'|'boxOffset'|'rolling'|'parallel'|'segment'|'concentric'),
  conduit { type ('EMT'|'RMC'|'IMC'|'PVC'|'AL'), tradeSize ('16'|'21'|'27'|'35'|'41'|'53'|'63'|'78'|'91'|'103') }, benderProfileId?,
  inputs {}, result { marks[{ label, atM }], shrinkM, developedLengthM, warnings[] }, notes`
- `benderProfiles`: `name, brand, model, conduitType, tradeSize, takeUpM, gainM, backToBackMark, centreMark, minRadiusM, isDefault, notes`

Settings additions (workstream B): `company.province`, `codeBook ('CEC-2024'|'NEC-2023')`,
`currency 'CAD'`, `tax { mode: 'province'|'custom', ... }`, `units` (company default).

**Native measuring plugin (iOS, Phase 1) — the JS side codes against this now:**
`window.Capacitor?.Plugins?.FishtapeMeasure`:
`isAvailable() → { available }`;
`measurePath({ units }) → { totalM, segments: [{ lengthM }], points: [{ x, y, z }], snapshot?: 'data:image/jpeg;base64,…' }`
(full-screen ARKit view, tap points along the wall or conduit, Done returns; rejects with `'cancelled'`).

## Workstreams and file ownership

Phase 0 runs in parallel, each workstream in its own git worktree. Touch only the files you own.
Shared files (`js/app.js`, `js/ui.js`, `js/icons.js`, `js/auth.js`, `index.html`, `sw.js`,
`modules/index.js`) are frozen in Phase 0 except where noted. Need a helper? Put it in your own lib file.
Need an icon? Inline the SVG in your module.

| | workstream | owns |
| --- | --- | --- |
| A | Backend core | `server/**`, `electrical-app/js/schema/**`, `deploy/local/**`, `docs/architecture/{api,data-model,adr-*}.md` |
| B | Canadian code, tax, units | `js/lib/cec/**`, `js/lib/electrical.js` (→ NEC), `js/lib/tax.js`, `js/lib/money.js`, `js/lib/doc-view.js`, modules `calcs, panels, compliance, settings, estimates, invoices, dashboard`, `seed.js`, `store.js` (DEFAULT_SETTINGS only), `app.js` (first-launch units prompt only), `css/calcs.css`, `tests/{cec,tax}*.test.mjs`, `docs/code/**` |
| C | Pipe bending | `js/lib/bending*.js`, `modules/bending.js`, `css/bending.css`, `tests/bending.test.mjs`, `docs/field/bending.md` |
| D | Box placement & CEC drawing checks | `js/canvas/**`, `modules/drawings.js`, `js/lib/placement*.js`, `css/canvas.css`, `tests/placement.test.mjs`, `docs/field/box-placement.md` |
| E | Wire runs | `modules/wireruns.js`, `js/lib/wireruns.js`, `js/lib/ar-measure.js`, `js/lib/pdf.js`, `css/wireruns.css`, `tests/wireruns.test.mjs`, `docs/field/wire-runs.md` |
| F | Platform: CI/CD, deploy, security, compliance | `.github/**`, `deploy/staging/**`, `deploy/production/**`, `server/Dockerfile`, `.dockerignore`, `SECURITY.md`, `.gitleaks.toml`, `docs/{security,compliance,runbooks}/**`, `docs/architecture/{13-layers,environments}.md`, `compliance/**` |

Phase 1 (after A lands): sync + sign-in screens in the PWA, HQ console, client portal,
plans & entitlements (tiers, locked modules, Enterprise lead form),
integrations (Stripe, Resend, Twilio, Facebook Lead Ads, per-tenant keys + guides),
AI (assistant, CEC helper, MCP server, background agents), iOS app + ARKit plugin, staging deploy.

Data leakage rule (applies to every workstream): no secrets or customer details in response
headers, URLs/query strings, error messages, logs or any file under the web root. `.env` files
live outside the web root, are chmod 600 and never committed. `/api` responses carrying tenant
data send `Cache-Control: no-store`. `deploy/check-exposure.sh` runs after every deploy.

## Phase 1 (backend merged 2026-10-19)

Shared pieces already in the base branch, use them, don't fork them:
- `electrical-app/js/plans.js`: tiers (starter, pro, business, enterprise), `FEATURE_PLAN`, `hasFeature(plan, feature, overrides)`,
  `entitlements()`, `monthlyCents()`. Server imports it like the schemas (`../electrical-app/js/plans.js`).
  Downgrades never delete data: a company keeps **reading** everything, while writes, AI calls and integrations check the feature.
- `server/src/services/secrets.js`: per-company keys (`setSecret/getSecret/listSecrets/deleteSecret`, names in `SECRETS`).
  Plaintext never goes to the browser; `listSecrets` returns hints only.
- `server/src/services/entitlements.js` + migration `0004_plans.sql`: `tenants.plan` ('trial'|tier), `plan_overrides`,
  `trial_ends_at`; `effectivePlan` (a running trial gets Business, an expired one Starter), `tenantEntitlements(t)` for
  `/api/v1/me`, `assertFeature(db, tenantId, feature)` and the route guard `requireFeature(db, feature)`.
- `server/src/db.js` `withTenant` / `TenantTx`, `server/src/services/audit.js`, `server/src/services/queue.js` (worker jobs).

Conventions:
- **Migrations:** each workstream uses its own number range so files never collide: G 0010–0019, H 0020–0029,
  I 0040–0049, J 0050–0059, portal 0060–0069. Platform tables get RLS like the rest if they hold tenant data.
- **Routes:** add your own Fastify plugin file and one `app.register(...)` line in `server/src/app.js` (the lead resolves the
  one-line merge conflicts). **Modules:** add your module file and one line in `electrical-app/js/modules/index.js`.
- Every new endpoint: permission check, entitlement check where gated, audit event on writes, `Cache-Control: no-store`,
  tests including a cross-tenant attempt. Server tests run with `cd server && npm run test:embedded`.
- Platform keys (Fishtape's own Stripe account for subscriptions, Fishtape's own Resend key for system email) come from
  env vars, never `tenant_secrets`. Company keys come from `tenant_secrets` only.

| | workstream | owns |
| --- | --- | --- |
| G | PWA accounts & sync | `electrical-app/js/{store,sync,session,auth,app}.js`, new `modules/account.js` (sign-in, MFA, password reset, company switcher, shared-iPad PIN mode), `css/account.css`, rail locking for features not in the plan, `GET /api/v1/me` (session user, memberships, role perms, plan, entitlements) in `server/src/routes/v1/me.js`, tests |
| H | HQ, plans & billing | `hq/**` (console at `/hq/`, may import `/js/ui.js` and `/css/*` from the app), `server/src/routes/hq*.js`, `server/src/services/{billing,hq-*}.js` (may extend `entitlements.js`), the entitlement hooks in `server/src/services/records.js` and `routes/v1/sync.js`, `site/**` (public pricing page + Enterprise "Let's talk" form), migrations 0020–0029. Tenants (create, suspend, delete with export, plan/trial/overrides, audited support access), **developer health page**, compliance & security page (controls from `compliance/controls.yaml`, access review with MFA status, incidents, vendors), billing with Fishtape's Stripe (checkout, customer portal, webhooks set the plan), HQ sales leads from the Enterprise form, server-side entitlement middleware `requireFeature()` |
| I | Integrations | `server/src/integrations/**`, `server/src/routes/v1/{integrations,webhooks}.js`, worker jobs for email/SMS, migrations 0040–0049, `electrical-app/js/modules/integrations.js` + `css/integrations.css`, `electrical-app/guides/*.md` (setup guides shown in the app) + a small safe Markdown renderer in `electrical-app/js/lib/markdown.js`. Stripe invoice payments (company's key; pay link on invoices; signed webhook records the payment), Resend (outbox and sequences), Twilio SMS, Facebook Lead Ads (webhook → `leads`), connection tests |
| J | AI | `server/src/ai/**`, `server/src/routes/v1/ai.js`, `server/src/routes/mcp.js`, migrations 0050–0059, `electrical-app/js/modules/assistant.js` (+ any `js/lib/assistant*.js`), `css/assistant.css`, `docs/ai/**`. Claude through each company's own Anthropic key: estimate/invoice drafting (human approves), CEC helper using the calculators as tools, background agents that draft suggestions, an MCP server on scoped API keys, token usage per company |

Client portal (homeowners/GCs see estimates, sign, pay invoices) starts after I lands, since it needs email and payments.

### Work plans, My day and crew KPIs (migrations 0100–0109)

Modules `today` ("My day", every role, Starter; the landing screen for electricians and apprentices) and `workplan`
(planner, meeting mode, KPIs; Pro). Permission keys `today` (all roles), `workplan` and `kpis` (owner, admin, office,
foreman). Plan features `today: starter`, `workplan: pro`, `kpis: pro`.

- `workPlans`: `jobId, name, startDate, endDate, skipWeekends, holidays[] (YYYY-MM-DD), province, dayHours, crewIds[],
  phases[{ id, name, order }], published { 'YYYY-MM-DD': { at, by } }, status ('active'|'paused'|'complete'|'archived'), notes`
- `workTasks`: one task for **one** worker on **one** day (several assignees = several tasks sharing `groupId`):
  `planId, jobId, phaseId, phaseName, groupId, title, description, taskType, date, baselineDate, employeeId, order, estHours,
  qty, unit, priority, requiresPhoto, minPhotos, dependsOn[], link { kind ('drawing'|'wireRun'|'url'), id, label, url },
  status ('draft'|'todo'|'in-progress'|'blocked'|'done'), publishedAt, publishedBy, lateAdd, seenAt, ackAt, ackVia,
  startedAt, completedAt, actualHours, qtyDone, note, blocks[{ reason, note, at, resolvedAt, by }], photos[{ id, dataUrl,
  takenAt, width, height }] (≤ 6 downscaled JPEGs ≤ 300 KB each until object storage), reopens[{ at, by, reason }],
  evidenceWaived { by, at, reason }, progressAt, progressBy`
- `taskTemplates`: `name, title, description, phaseName, taskType, unit, qty, estHours, ratePerHour, requiresPhoto, minPhotos, priority`
- `huddles`: `date, planIds[], jobIds[], startedAt, endedAt, ledBy, attendees[{ employeeId, ackAt, by }], notes`

Rules (`electrical-app/js/lib/workplan.js`, imported by `server/src/auth/access.js`): tasks are drafts until their day
is published and never go back to draft; non-managers read only their own published tasks (row filter on
`employee_id` and `status`) and may change only the progress fields; a photo-required task can't become `done` without
its photos (any writer; a foreman may record a waiver). Work-task writes merge by field group (the foreman's fields,
progress by `progressAt`, seen/"Got it" kept once set) instead of whole-record last-writer-wins, so an offline
completion survives a foreman's edit; the device gets the merged copy back as a sync conflict. KPIs
(`electrical-app/js/lib/kpis.js`) are shared with `GET /api/v1/kpis`. Notifications: a marked hook in
`server/src/services/workplan-events.js` until a server `notify()` exists.

## Definition of done (every workstream)

- Tests with `node:test` next to the existing ones; run `node --test electrical-app/tests/*.test.mjs` (and `server` tests for A) and they pass.
- Code reads like the surrounding code: vanilla ES modules, `h()` from `ui.js`, tokens-only CSS, integer cents, SI units in storage.
- Code values (CEC tables, rule numbers, tax rates) cite their source in a comment; anything unverified is marked `VERIFY` and listed in your doc. Never paste CSA's text; numbers and rule references only.
- No secrets in the repo. No network calls to production. No deploys or SSH (the lead does those).
- Commit on your worktree branch with clear messages ending in the Co-Authored-By line. Do not push.
- Finish with a short report: what you built, what you couldn't, open questions, and files outside your area you think need changes.
