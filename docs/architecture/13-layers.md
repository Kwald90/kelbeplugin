# The 13 layers

How Fishtape is put together, one layer at a time: the goal, what exists today (October 2026,
end of Phase 0), what comes next, and who owns it. The contract every layer codes against is
[docs/BUILD-PLAN.md](../BUILD-PLAN.md). Owners: Kelvin is accountable for everything; the
workstream letters (A to F) are the Phase 0 builders from the build plan.

| # | layer | state |
| --- | --- | --- |
| 1 | Product and domain | built (Phase 0), CEC content being verified |
| 2 | Architecture | built |
| 3 | Environments | staging ready to set up; production waiting on the host |
| 4 | CI/CD | built; deploys off until secrets are added |
| 5 | Identity and access | built in the API; sign-in screens are Phase 1 |
| 6 | Tenancy and isolation | built (RLS + tests) |
| 7 | API | built (REST, sync, OpenAPI) |
| 8 | Data | built: migrations, encrypted backups, retention |
| 9 | Offline and sync | server side built; PWA sync is Phase 1 |
| 10 | Security | built: headers/CSP, scanners, threat model |
| 11 | Observability | partial: health endpoints and host status; alerting to set up |
| 12 | Compliance | built: policies, controls, evidence collector |
| 13 | Operations / HQ | partial: HQ API and runbooks; HQ console is Phase 1 |

## 1. Product and domain

- Goal: a CRM/ERP for Canadian electrical contractors that follows the Canadian Electrical Code
  (CSA C22.1:24 with provincial amendments), with field tools that work offline.
- Built: the PWA modules (jobs, clients, leads, estimates, invoices, inventory, crew, time clock,
  SOPs, compliance, drawings with CEC checks and box auto-placement, pipe bending, wire runs,
  calculators, panels), CEC tables and provincial tax, metric/imperial units, plan tiers.
- Next: verify every `VERIFY`-marked code value, Quebec (Chapter V, QST, French), plan prices.
- Owner: Kelvin; workstreams B (code, tax, units), C (bending), D (drawings), E (wire runs).

## 2. Architecture

- Goal: boring, owned technology with no vendor lock-in: vanilla ES-module PWA, Node 22 + Fastify
  API, PostgreSQL 17 with row-level security, one Docker image for API and worker.
- Built: the contract in BUILD-PLAN, ADRs ([001 own API + RLS](adr-001-own-api-postgres-rls.md),
  [002 sync](adr-002-sync-protocol.md), [003 auth](adr-003-auth-sessions.md)),
  [API](api.md) and [data model](data-model.md) docs, shared JSON Schemas used by browser and server.
- Next: ADRs for object storage (photos and plan images leave the records), AI agent tooling and
  MCP, payments and webhooks.
- Owner: Kelvin; workstream A.

## 3. Environments

- Goal: local, staging and production that behave the same way and never share data or secrets.
- Built: [environments.md](environments.md); `deploy/local` (Postgres for development),
  `deploy/staging` (compose stack, nginx snippets for the CloudPanel vhost, init/backup/restore
  scripts, systemd timers) and `deploy/production` (the same, hardened, plus host checklist and
  `check-host.sh`).
- Next: set up staging's API stack (deploy/staging/README.md), confirm the dotmoose host
  (location, disk encryption), DNS for fishtapehq.com.
- Owner: Kelvin; workstream F.

## 4. CI/CD

- Goal: every change tested and scanned before it ships; staging deploys itself, production
  needs a tag and an approval.
- Built: `.github/workflows/ci.yml` (web tests, CSP guard, deploy-config checks including
  `nginx -t` and shellcheck, server tests against Postgres 17, Docker build and hardened smoke
  test), `security.yml` (gitleaks, CodeQL, osv-scanner, npm audit, dependency review),
  `deploy-staging.yml` and `deploy-production.yml` over SSH to forced-command deploy users,
  `deploy/<env>/update.sh` with readiness checks and rollback. Actions pinned to commit SHAs.
- Next: add the GitHub secrets and turn deploys on; branch protection requiring "CI passed";
  agents on their own branches with pull requests; a tag ruleset; signed release tags.
- Owner: Kelvin; workstream F.

## 5. Identity and access

- Goal: the right person, with the right role, in the right company.
- Built (API): argon2id passwords, TOTP MFA required for owners, admins and HQ staff, recovery
  codes, Google and Microsoft sign-in, opaque hashed session tokens, CSRF guard, lockouts and rate
  limits, shared-iPad devices with crew PINs, scoped API keys, roles and permissions.
- Next: sign-in, MFA and device screens in the PWA (Phase 1); passkeys for HQ staff.
- Owner: Kelvin; workstream A.

## 6. Tenancy and isolation

- Goal: no company ever sees another company's data, even when a query has a bug.
- Built: `ENABLE` and `FORCE ROW LEVEL SECURITY` on every tenant table, `withTenant()` setting
  `app.tenant_id` per transaction, separate roles (owner for migrations, app without BYPASSRLS,
  HQ with BYPASSRLS in its own `hq-api` container only), isolation and leakage test suites run in
  CI against real Postgres, the restore test re-checks RLS on every backup.
- Next: HQ-only mode for `hq-api`; portal (client) sessions scoped by `app.portal_client_id`.
- Owner: Kelvin; workstream A (database), F (deployment separation).

## 7. API

- Goal: one API for the PWA, the iOS app, integrations and AI agents.
- Built: REST per collection, sync push/pull, members, devices, API keys, tenant secrets,
  entitlements, health endpoints, OpenAPI at `/api/v1/openapi.json`, uniform error bodies with no
  internals, `Cache-Control: no-store`.
- Next: client portal, integrations (Stripe, Resend, Twilio, Facebook Lead Ads) with signed
  webhooks, AI assistant and MCP server, HQ tenant lifecycle (export, close, delete).
- Owner: Kelvin; workstream A.

## 8. Data

- Goal: data is valid, recoverable and kept only as long as it should be.
- Built: ordered, checksummed migrations (0001 to 0004), JSON Schema validation, audit events
  hash-chained per tenant, nightly `pg_dump` encrypted with age to an offline key (14 daily, 8
  weekly, pre-deploy dumps), restore test, retention schedule.
- Next: offsite backup target in Canada with object lock; WAL archiving for a 15-minute RPO;
  photos and plan images to object storage.
- Owner: Kelvin; workstreams A (schema) and F (backups).

## 9. Offline and sync

- Goal: field tools keep working with no signal and catch up safely.
- Built: `store.js` on IndexedDB in the PWA; server sync push (idempotent by mutation id,
  last-writer-wins with history) and pull by `change_seq` cursor.
- Next: `sync.js` in the PWA (Phase 1), per-user/tenant local databases and wipe on sign-out,
  service worker that never caches `/api/` responses.
- Owner: Kelvin; workstream A (server), PWA owner (client).

## 10. Security

- Goal: defence in depth that holds up to a SOC 2-style review.
- Built: [threat model](../security/threat-model.md), secure SDLC, strict CSP and security headers
  (CI guard keeps app and policy in step), nginx allow-list with no secrets or repo files
  reachable, `deploy/check-exposure.sh` after every deploy, hardened containers, secrets in
  root-only env files, gitleaks/CodeQL/osv-scanner, vulnerability SLAs, ASVS L2 test checklist.
- Next: self-host pdf.js, CSP reporting endpoint, image scanning gate, external pen test before
  real customer data.
- Owner: Kelvin; workstream F.

## 11. Observability

- Goal: know about problems before tenants do.
- Built: `/api/healthz`, `/api/readyz`, public `/api/v1/status`, HQ developer health
  (`/api/hq/health`) fed by `last-backup.json`, `last-deploy.json` and `host-status.json`, JSON
  logs with secrets redacted, nginx logs without query strings.
- Next: external uptime checks and the backup heartbeat wired to Kelvin's phone; log shipping off
  the host; error alerting.
- Owner: Kelvin; workstreams A and F.

## 12. Compliance

- Goal: SOC 2-aligned controls with evidence, without a formal audit.
- Built: 15 policies in [docs/compliance/](../compliance/README.md), 74 controls mapped to the
  2017 Trust Services Criteria in `compliance/controls.yaml`, `compliance/evidence/collect.mjs`
  for monthly evidence bundles, PIPEDA-based privacy and breach procedure.
- Next: first quarterly access review, first restore test, name the backup contact, privacy
  counsel review before launch.
- Owner: Kelvin; workstream F.

## 13. Operations / HQ

- Goal: one person can run the service: onboard companies, watch health, respond to incidents.
- Built: HQ API (tenants, audit chain verification, developer health) behind its own host and
  container, [runbooks](../runbooks/README.md) for deploys, rollback, restore, incidents, secrets,
  tenants and on-call.
- Next: the HQ console at `hq/` (tenants, plans, developer health, compliance status, API keys,
  AI agents), billing via Stripe.
- Owner: Kelvin; workstream A (API), Phase 1 HQ console.
