# Fishtape threat model

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | PWA, iOS app, API and worker, HQ, Postgres, staging and production hosts, CI/CD, integrations, AI features |
| Review cadence | Annually, and on any major change (see [Review](#review)) |
| Last reviewed | 2026-10-20 |
| Related controls | RSK (risk assessment), SDL (secure development), ACC, CRY, OPS in `compliance/controls.yaml` |

This is a STRIDE threat model of Fishtape as designed in `docs/BUILD-PLAN.md` and as configured in
`deploy/` and `.github/` on 2026-10-19. Much of the backend is being built right now, so each
control says where it stands:

- `[repo]` exists in this repository today (nginx config, deploy scripts, CI, GitHub settings).
- `[contract]` required by the backend contract in `docs/BUILD-PLAN.md`; workstream A is building it.
  Verify it with the tests in [pentest-checklist-asvs.md](pentest-checklist-asvs.md) once it lands.
- Everything in the "Gaps / planned" column is not built yet.

STRIDE letters: S spoofing, T tampering, R repudiation, I information disclosure, D denial of
service, E elevation of privilege.

Rating = likelihood x impact, each High, Medium or Low. H x H, H x M and M x H rate High;
M x M, H x L and L x H rate Medium; the rest rate Low. Ratings assume the `[repo]` and
`[contract]` controls are in place and working; a gap in a contract control raises the rating.

## System overview

- PWA (`electrical-app/`): vanilla ES modules, no build step, offline-first. Records live in
  IndexedDB and sync through a queue. Installed on office computers and shared iPads. Service
  worker `sw.js` caches the app shell.
- iOS app: Capacitor wrapper of the PWA plus a native ARKit measuring plugin. Calls the API
  cross-origin from `capacitor://localhost` with a bearer token.
- API: Node 22, Fastify, port 3410, behind nginx at `/api/`. Worker process for background jobs
  (queue table, `FOR UPDATE SKIP LOCKED`). One Docker image for both.
- Postgres 17 with row-level security. Roles: `fishtape_owner` (owns the schema, migrations
  only), `fishtape_app` (API, `NOBYPASSRLS`), `fishtape_hq` (`BYPASSRLS`, HQ only), plus the
  `postgres` superuser (bootstrap and backups).
- HQ: Kelvin's console for all tenants at `hq.fishtapehq.com` (`/api/hq/`), served by its own
  `hq-api` container (same image, loopback port 3411), the only process given the BYPASSRLS role.
- Client portal: each tenant's customers see their own estimates, invoices and jobs.
- Integrations per tenant: Stripe, Twilio, Resend, Meta Lead Ads; Google and Microsoft sign-in.
- AI: in-app assistant, CEC helper, agent API and MCP server, background agents. Each tenant
  brings its own AI key.
- Hosts: staging on Kelvin's shared DreamHost VPS (CloudPanel nginx, other sites on the same box);
  production on its own VPS at dotmoose (location and disk encryption not yet confirmed).
- Code: public GitHub repo, CI in GitHub Actions, deploys over SSH to a forced command.

## Data flows and trust boundaries

```
 [Office browser]   [Shared iPad]       [iOS app]     [Portal client]  [API keys, MCP,
  cookie ft_session  device token+PIN    Bearer        portal session    agents] Bearer ft_live_
        \                 |                 |                |               /
         +-- device storage: IndexedDB, Cache Storage, localStorage, Keychain (TB2)
                          |
                          | HTTPS only (HSTS)                [Stripe] [Twilio] [Resend] [Meta]
                          v                                       | webhooks in (TB7)
 ===================== TB1  edge: nginx ===========================v===========================
   app.fishtapehq.com     PWA files, /api/ -> api      staging: one CloudPanel vhost,
   hq.fishtapehq.com      HQ console; auth, /api/hq/, health    /hq/ on the same origin,
   status.fishtapehq.com  /api/v1/status, /api/healthz          /api/hq/ -> hq-api
 ===================== TB3  loopback 127.0.0.1:3410 (api), 127.0.0.1:3411 (hq-api) ==========
   api (Fastify)     hq-api (same image, HQ role)     worker (jobs_queue)     migrate (owner role)
     | withTenant: BEGIN; set_config(app.tenant_id, app.user_id [, app.portal_client_id])
     v
 ===================== TB4  database roles ===================================================
   fishtape_app (NOBYPASSRLS) | fishtape_hq (BYPASSRLS) | fishtape_owner | postgres (superuser)
   tenant tables: ENABLE + FORCE RLS   (TB5 tenant <-> tenant, staff <-> portal client)
   platform tables, no RLS: users, sessions, api_keys, devices, tenant_secrets, audit_events ...
 ===============================================================================================
   outbound HTTPS from API/worker (TB6): Stripe, Twilio, Resend, Meta Graph, Anthropic, OIDC
   model output -> tool calls (TB9: model output is untrusted)

 Host, root only: update.sh, backup.sh -> age (public key) -> /var/backups -> offsite (TB10)
 GitHub: public repo, Actions, environment secrets --SSH forced command (TB8)--> host
   pushes from Kelvin, contractors, AI coding agents
 Staging only: unrelated sites and services on the same VPS (TB11)
```

| id | boundary | what crosses it | main controls |
| --- | --- | --- | --- |
| TB1 | Internet to nginx | browser, iPad, iOS, portal, API-key and agent requests; webhooks | TLS 1.2/1.3, HSTS, CSP and headers, rate limits (production), unknown hosts dropped, path blocking `[repo]` |
| TB2 | Device storage | offline copy of tenant data, tokens, cached responses | per-device revocation `[contract]`; much of this boundary is still open (TM-DEV, TM-SYNC, TM-WEB-04) |
| TB3 | nginx to `api` (3410) and `hq-api` (3411) | proxied requests over loopback | ports bound to 127.0.0.1, `X-Forwarded-For` overwritten by nginx, HQ traffic routed only to `hq-api` `[repo]` |
| TB4 | API to Postgres | queries under one of four roles | role separation: owner URL only in the migrate container, HQ URL only in `hq-api` `[repo]`; RLS `[contract]` |
| TB5 | Tenant to tenant; staff to portal client | rows in shared tables | `ENABLE` + `FORCE` RLS, `set_config` per request, `app.portal_client_id` `[contract]` |
| TB6 | API/worker to third parties | API calls with tenant secrets | envelope-encrypted `tenant_secrets` `[contract]` |
| TB7 | Third parties to API | webhooks | signature verification (planned) |
| TB8 | GitHub to hosts | deploys | forced-command SSH key, pinned host key, approvals for production `[repo]` |
| TB9 | AI model to tools | tool calls generated from untrusted text | scoped API keys, audit as actor `agent` `[contract]` |
| TB10 | Host to backups and offsite | encrypted dumps | age public-key encryption, private key offline `[repo]` |
| TB11 | Fishtape staging to the rest of the shared VPS | loopback ports, files, root | localhost binding, strong DB passwords, root-owned checkout `[repo]` |
| TB12 | Release to iPads | iOS builds through the App Store | Apple signing (planned with the iOS app) |

Main flows:

1. Sign-in: email + password (argon2id) and TOTP, or Google/Microsoft OIDC; session cookie for
   the web, bearer token for iOS. Crew sign in on a registered iPad with name and PIN.
2. Sync: the PWA pushes queued mutations to `POST /api/v1/sync/push` and pulls changes from
   `GET /api/v1/sync/pull?since=`. Every write is validated with the shared JSON Schemas and audited.
3. REST and API keys: `/api/v1/{collection}` for the app, integrations and agents.
4. Portal: a tenant's customer signs in and sees only their own records.
5. HQ: Kelvin reads across tenants through `fishtape_hq`; every read is audited.
6. Webhooks in: Stripe payments, Twilio SMS, Resend events, Meta leads.
7. Outbound: API and worker call vendor APIs with the tenant's decrypted keys.
8. AI: the assistant and agents send tenant data to the tenant's AI provider and call tools.
9. Deploy: CI SSHes to `deploy <sha>` (staging) or `deploy <tag> <sha>` (production).
10. Backup: nightly `pg_dump` as superuser, streamed into `age`, optional offsite copy.
11. pdf.js: self-hosted in `electrical-app/vendor/pdfjs-4.10.38/`, loaded on demand when a PDF plan is imported.

## Assets

| asset | why it matters |
| --- | --- |
| Tenant business data | clients' names, addresses, phone numbers and emails; leads (including Meta lead forms); jobs, estimates, invoices, payments (card data stays with Stripe); inventory, permits, inspections |
| Employee data | names, contact details, roles, pay-related settings, time entries, certifications, crew PINs, location points and consent answers (TM-LOC) |
| Drawings and photos | plans of customers' homes and businesses (can show panel and alarm locations), AR measurements and snapshots |
| Identity data | password hashes, session and device tokens (hashed), TOTP seeds, recovery codes, OAuth identities, API key hashes, memberships |
| Tenant integration secrets | Stripe, Twilio, Resend, Anthropic and Meta credentials in `tenant_secrets` |
| Platform secrets | per-environment `.env` (role passwords, `SECRETS_MASTER_KEY`, OAuth client secrets), deploy keys, age keys |
| Audit trail | evidence for incidents, disputes and compliance |
| Backups | a full copy of everything above |
| Code and release integrity | repo, Actions, tags, Docker images, iOS builds |
| Availability | crews clock in and read drawings in the field; offices invoice |
| Domains, DNS, TLS, email reputation | phishing and outage risk if lost |
| Kelvin's accounts | GitHub, email, password manager, hosting and vendor consoles: the keys to all of the above |

## Actors

| actor | trust | reaches | notes |
| --- | --- | --- | --- |
| Tenant owner or admin | trusted inside their tenant | all tenant data, settings, keys, integrations | TOTP required `[contract]` |
| Office staff | trusted for their role | office modules | MFA optional |
| Crew on a shared iPad | low | crew modules on that device | device token + PIN, short crew session `[contract]` |
| Portal client (a tenant's customer) | untrusted beyond own records | own estimates, invoices, jobs | `app.portal_client_id` `[contract]` |
| HQ staff (Kelvin) | highest | every tenant through `fishtape_hq` | TOTP; every read audited `[contract]` |
| API-key client | scoped | routes allowed by scopes | tenant scripts and integrations |
| AI agents (assistant, background agents, MCP clients) | scoped; output untrusted | tools behind scoped API keys | audited as actor `agent` `[contract]` |
| Tenants' integrations (no-code tools, accountants' systems) | scoped | API keys they were given | keys often stored in third-party tools |
| Third-party services | trusted only after signature checks | webhook endpoints | Stripe, Twilio, Resend, Meta |
| Contractors and AI coding agents | write code only | branches in GitHub | no production secrets, SSH keys or GitHub admin |
| Opportunistic attacker | none | public endpoints | scanners, bots, credential stuffing |
| Targeted attacker | none | a specific tenant or Kelvin | phishing, account takeover |
| Malicious tenant | a paying or trial customer | their own tenant, legitimately | probes cross-tenant access, abuses integrations for SSRF or spam, plants stored XSS for HQ, runs up costs |
| Malicious insider at a tenant | legitimate user | their role's data, devices | ex-employee with an iPad or API key |
| Compromised neighbouring site on staging | local code execution on the shared VPS | loopback ports, world-readable files | CloudPanel sites and the app on `:3000` are not Fishtape's |
| Supply-chain attacker | none | code we run | npm, GitHub Actions, Docker Hub, vendored pdf.js, Capacitor plugins, App Store tooling |
| Hosting provider insider | physical or console access | disks, snapshots, consoles | DreamHost (staging), dotmoose (production) |
| Device thief | holds a device | offline data, stored tokens | iPads in trucks and on job sites |

## Threats by area

### Tenancy and row-level security (TM-TEN)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-TEN-01 | I, E | A route or job runs tenant queries outside `withTenant`, or takes the tenant id from client input (header, body, sync payload) instead of the authenticated membership. | Tenant A reads or changes tenant B's data. | `[contract]` one helper `withTenant(ctx, fn)`; policies compare `tenant_id` to `current_setting('app.tenant_id', true)`; unset means no rows; isolation tests in `server/test/isolation.test.js`. `[repo]` PR checklist item. | Lint/CI rule: no direct `pool.query` outside the database module; tenant id only from the session's membership; a test that every route returns nothing when the context is missing; isolation tests generated for every tenant table rather than hand-picked. | M x H = H |
| TM-TEN-02 | I | Tenant context leaks between requests on a pooled connection: `set_config(..., false)` or a plain `SET` makes the setting last for the connection, so the next request on it runs as the previous tenant. Same risk if a session-mode pooler (PgBouncer) is added later. | Intermittent cross-tenant reads and writes, hard to notice. | `[contract]` one transaction per request; `set_config(..., true)` is transaction-local. | Code rule: only `set_config(name, value, true)` after `BEGIN`; test with a pool of one connection (request as A, then as B; B sees nothing of A); reset the connection on release; transaction-mode pooling only, if a pooler is ever added. | L x H = M |
| TM-TEN-03 | E | `SECURITY DEFINER` functions, or views owned by a role that bypasses RLS (the `postgres` superuser, or anything with `BYPASSRLS`), return rows from every tenant. A definer function without a fixed `search_path` can be hijacked. Views run with their owner's rights by default. | Cross-tenant reads; privilege escalation inside the database. | `[contract]` `FORCE ROW LEVEL SECURITY` (applies RLS to the table owner too). | No `SECURITY DEFINER` without a security note; when needed: `SET search_path = pg_catalog, public`, `REVOKE EXECUTE ... FROM PUBLIC`, owned by `fishtape_owner`, never `postgres`. Views `WITH (security_invoker = true)`. CI query of `pg_proc.prosecdef` and views against an allow-list. | L x H = M |
| TM-TEN-04 | I | Generated columns and indexes as side channels: a unique index without `tenant_id` first turns "number already exists" into a cross-tenant oracle; a generated `client_id` that disagrees with what the app shows puts a record in the wrong portal; the global `change_seq` lets a tenant estimate other tenants' activity. | Existence and volume leaks; records shown to the wrong portal client. | `[contract]` primary key `(tenant_id, id)`; STORED generated columns derived from `data`. | Every unique index starts with `tenant_id`; constraint errors mapped to generic messages (no constraint name or value); a test that portal visibility uses the same field the UI shows; accept the `change_seq` volume leak for now. | L x M = L |
| TM-TEN-05 | E | The owner role or superuser is used outside migrations: the API started with `MIGRATE_DATABASE_URL`, or the owner password leaks. The owner can turn off `FORCE`; the superuser ignores RLS. | Every tenant exposed. | `[repo]` owner URL only in the `migrate` (and staging `seed`) containers; `api` and `worker` get only the app URL, `hq-api` alone gets the HQ URL; raw passwords blanked inside app containers; no Postgres host port in production; `restore-test.sh` checks every tenant table still has ENABLE + FORCE in each restored backup. `[contract]` FORCE RLS. | The API refuses to start unless `current_user` is `fishtape_app`, the role is `NOBYPASSRLS` and owns no tables; CI asserts the same against the test database. | L x H = M |
| TM-TEN-06 | T, E | A migration disables RLS (`DISABLE ROW LEVEL SECURITY`, `NO FORCE`), adds a tenant table without a policy, adds `USING (true)`, grants to `PUBLIC`, or a one-off data fix turns RLS off and nobody turns it back on. | Silent cross-tenant exposure from the next deploy on. | `[repo]` PR checklist for new tenant tables; CODEOWNERS on `server/migrations/`; restore-test catalogue check (on backups, after the fact). `[contract]` isolation tests. | CI migration lint that fails on those statements unless an allow-list entry and a security note exist; a post-migrate catalogue check (every table with `tenant_id` has ENABLE, FORCE and at least one policy) in the CI server job and in `update.sh` right after `migrate`, failing the deploy. | M x H = H |
| TM-TEN-07 | I | Portal scoping fails open: a policy like `portal_client_id IS NULL OR client_id = portal_client_id` shows the whole tenant if a portal code path forgets to set `app.portal_client_id`; collections without `client_id` (employees, time entries, settings, panels) are readable by portal sessions; a portal write sets `client_id` to another customer. | One contractor's customer sees other customers' invoices and addresses, or staff data. | `[contract]` `app.portal_client_id` set for portal sessions; generated `client_id` column. | Fail closed: identify portal sessions with their own setting (for example `app.actor_kind = 'portal'`) that policies require, or use a separate `fishtape_portal` role with SELECT on portal collections only; the server sets `client_id` on portal writes; isolation tests for client A1 vs A2 and for internal-only collections. | M x H = H |
| TM-TEN-08 | I | Platform tables have no RLS (`api_keys`, `devices`, `sessions`, `tenant_secrets`, `audit_events`, `portal_users`, `jobs_queue`); a query missing `WHERE tenant_id = $1` returns other tenants' rows. | Key metadata, device lists, audit history or encrypted secrets of other tenants. | `[contract]` the table list; API code filters by tenant. | Data-access functions for these tables take `tenantId` as a required argument, with tests; consider RLS on the tenant-keyed platform tables as well. | M x M = M |
| TM-TEN-09 | E | The worker processes jobs for every tenant. A job handler that skips `withTenant`, or trusts a tenant id or record id inside a job payload, crosses tenants. | Cross-tenant writes from background jobs (emails, SMS, AI agents). | `[repo]` the worker gets only the app role's URL (no `HQ_DATABASE_URL`), so it can't bypass RLS. `[contract]` `jobs_queue`, `withTenant`. | One job wrapper that always runs `withTenant(job.tenant_id)`; the tenant id set by the server when the job is queued, never from user input; ids in payloads resolved under RLS. | L x H = M |

### Authentication, MFA, sessions and OIDC (TM-AUTH)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-AUTH-01 | S | Credential stuffing and password spraying on sign-in. | Takeover of office accounts (MFA is optional for them), then the tenant's data. | `[contract]` argon2id; rate limits and lockouts on every auth route. `[repo]` production nginx: 10 requests/minute per IP (burst 20) on `/api/v1/auth/`. | Breached-password check and 12-character minimum; per-account and per-IP limits; same response and timing for unknown accounts; alert on spikes. Staging has no nginx rate limit (CloudPanel vhost), only the API's. | H x M = H |
| TM-AUTH-02 | D | Lockouts used as a weapon: an attacker locks out a tenant's owner, or everyone behind one job-site or office IP. | Office can't work; crews can't clock in. | `[contract]` lockouts. | Lock per account and IP pair with growing delays rather than hard locks; owners can still use OIDC or a reset link; unlock steps in a runbook. | M x M = M |
| TM-AUTH-03 | S | MFA bypass: TOTP brute force, code replay inside the time window, a "password OK, MFA pending" session that already reaches other routes, OIDC sign-in that skips TOTP for roles that need it, or a password reset that removes MFA. | Takeover of an owner, admin or HQ account. | `[contract]` TOTP required for owners, admins and HQ staff; recovery codes; rate limits on auth routes. | MFA-pending sessions reach only the TOTP route; a small per-factor attempt limit (for example 5 per 15 minutes); last used time step stored so a code works once; TOTP still required after OIDC for MFA roles; resets never remove MFA; TOTP seeds encrypted under the envelope key; passkeys later. | M x H = H |
| TM-AUTH-04 | S, E | Recovery codes and MFA resets abused: codes stored in plain text, reusable or unthrottled; or someone calls or emails Kelvin pretending to be an owner who lost their phone. | MFA defeated. | `[contract]` recovery codes exist. | Codes hashed, single use, high entropy, throttled like TOTP; using one sends an email; regenerating voids the old set; a written identity check before HQ resets anyone's MFA (call back on the number on file, confirm with another owner); every reset audited. | L x H = M |
| TM-AUTH-05 | S, E | OAuth account linking by email: someone signs in with Google or Microsoft using an identity whose email matches a Fishtape user and gets linked automatically. Microsoft's `email` claim is not a verified identifier (the "nOAuth" problem). | Account takeover without the password or TOTP. | `[contract]` Google and Microsoft OIDC; `oauth_identities` table. `[repo]` separate OAuth apps per environment. | Link only by the provider's stable subject (`sub` for Google; `oid` + `tid` for Microsoft); never auto-link an existing account by email; linking starts from a signed-in session (password + MFA); require `email_verified` for Google sign-up; `state`, `nonce` and PKCE; exact redirect URIs. | M x H = H |
| TM-AUTH-06 | S | Session fixation or token theft: token not rotated at sign-in or after MFA; very long sessions; a sibling site on the same parent domain sets a cookie that shadows `ft_session` (staging sits under `truecollarbuilt.com` with other sites). | Session hijack. | `[contract]` opaque random tokens, SHA-256 stored; httpOnly, Secure, SameSite=Lax cookie; bearer only on iOS. | New token at sign-in, after MFA and on tenant switch; idle and absolute timeouts per actor type; `__Host-` cookie prefix (siblings can't set or shadow it); users can list and revoke sessions; revoke all on password change or MFA reset. | L x H = M |
| TM-AUTH-07 | T | CSRF on cookie routes. SameSite=Lax does not separate `app.`, `hq.` and `status.fishtapehq.com` (same site), nor staging from other `truecollarbuilt.com` sites, and Lax allows top-level GET. | Actions taken as the victim (add users, change settings, send invoices). | `[contract]` Origin check + `X-Fishtape: 1` header on state-changing cookie requests; SameSite=Lax. | Origin must equal the exact expected origin, not a suffix match; a state-changing cookie request with no Origin is refused; no state changes on GET; CORS never allows credentials for other origins; sign-in and OIDC start checked too (login CSRF). | L x M = L |
| TM-AUTH-08 | S, I | Password reset and email verification tokens that are guessable, long-lived, reusable, or leak through Referer, logs or link scanners in mail systems. | Account takeover. | `[contract]` rate limits on auth routes. `[repo]` Referrer-Policy `strict-origin-when-cross-origin`; `/api/` access logs drop query strings (TM-LEAK-05). | Single use, 32+ random bytes, hashed at rest, short expiry; the landing page moves the token into a POST body; a reset revokes sessions and notifies the user. Fishtape's own sender for these emails is not in the contract yet ([secrets-management.md](secrets-management.md)). | L x H = M |
| TM-AUTH-09 | E | Privilege from the wrong source: the PWA keeps a `role` on `employees` records today; if the server trusts that field instead of `memberships`, anyone who can edit or sync an employee record can promote themselves. | Privilege escalation inside a tenant. | `[contract]` `memberships` (user, tenant, role) is a platform table. | Authorization reads `memberships` only; `employees.role` is display data, writable by owners and admins only; a test that a crew session pushing `employees.role = 'owner'` gains nothing. | M x M = M |
| TM-AUTH-10 | R | Auth events not recorded: no trail of sign-ins, failures, MFA changes, lockouts or key creation. | Can't investigate a takeover or tell a tenant what happened. | `[contract]` every write audited with actor, IP, user agent, request id. | Also record security events: sign-in success and failure, MFA enrol and reset, lockout, session revoke, API key and device create and revoke; users can see their recent sign-ins. | M x M = M |
| TM-AUTH-11 | E | A user in several tenants (Kelvin, contractors, bookkeepers) switches tenant and the old context stays on the session, or a request names a tenant the user doesn't belong to. | Cross-tenant action. | `[contract]` memberships; `withTenant`. | Active tenant stored server-side on the session and checked against `memberships` on every request; new token on switch. | L x H = M |

### Shared-iPad crew devices (TM-DEV)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-DEV-01 | S | PIN guessing on the device: a 4-digit PIN has 10,000 values. | Crew impersonation: clocking in or out for others, seeing that person's jobs. | `[contract]` PIN hashed with argon2, lockout; crew session limited to the device. | PIN checked on the server only; lockout per crew member per device with growing delays; manager notified; 6-digit PINs encouraged; rate limit per device token. | M x M = M |
| TM-DEV-02 | I | PINs available offline: today `js/auth.js` keeps the PIN on the `employees` record and compares it in the browser, and `employees` is a collection that will sync. If PINs or their hashes reach the device, a thief tries all of them offline in seconds. | Every crew PIN in the tenant exposed; plaintext PINs in the database, backups and every synced device. | None yet (pre-sync prototype; `auth.js` says it is not real security). | Remove `pin` from `employees` records and schemas before sync ships; PIN hashes stay server-side in a platform table; crew sign-in needs a connection, or a narrow offline mode that carries no PIN data. | H x M = H |
| TM-DEV-03 | S, I | Lost or stolen iPad: long-lived device token plus a full offline copy of tenant data in IndexedDB. | Tenant data read from the device; crew sign-in from it. | `[contract]` device tokens are revocable. | Managers (and HQ) revoke a device in the app; the next contact wipes IndexedDB, Cache Storage and localStorage; crew devices hold crew collections only; recommend iPad passcode and Guided Access or MDM; show last-seen time and network per device. | M x M = M |
| TM-DEV-04 | S | Device token copied off the device (XSS, dev tools on an unlocked browser, device backups). | Crew sign-in screen for that tenant reachable from anywhere. | `[contract]` revocable device token. | httpOnly cookie on the web, Keychain on iOS, never localStorage; stored hashed like sessions; the device token alone grants only the PIN screen; alert on use from a new network. | L x M = L |
| TM-DEV-05 | E | Crew session reaches more than crew work (invoices, clients, settings through REST or sync), is reused off the device, or never ends at shift change. | Crew member or thief reads or edits office data. | `[contract]` short crew session limited to the device. | Server-enforced crew permission matrix on REST and on sync push and pull; crew session bound to the device id; idle sign-out and end-of-day expiry. | M x M = M |
| TM-DEV-06 | I | The next person on a shared iPad sees the previous person's data: cached screens, drafts, `kc.*` keys in localStorage, service worker cache. | Pay rates, client details or messages seen by co-workers. | None specific. | Clear per-user UI state on sign-out; keep per-user data out of shared storage. | M x L = L |
| TM-DEV-07 | R | Buddy punching: one crew member clocks another in. | Payroll fraud. | `[contract]` audit records the signed-in user and device. `[repo]` optional location on each punch with notice and consent, off-site flags for review (TM-LOC). | Show who is signed in on every screen; optional photo on punch. | M x L = L |

### Offline sync (TM-SYNC)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-SYNC-01 | T, E | Forged mutations: a client pushes fields or collections its role may not write (`status: 'paid'` on an invoice, settings, `employees.role`, `createdBy`). | Fraud, privilege escalation, corrupted records. | `[contract]` JSON Schemas shared by browser and server (ajv); same validation and audit for sync and REST. | `additionalProperties: false`; server-owned fields (`tenant_id`, `version`, `created_by`, `updated_by`, timestamps) ignored from clients; one role-by-collection-by-operation matrix enforced on sync and REST alike. | M x H = H |
| TM-SYNC-02 | T | Replayed or colliding mutation ids (`mid`). | Duplicate writes, or a cross-tenant oracle if ids are global. | `[contract]` idempotent by `mid`. | Idempotency scoped to `(tenant_id, mid)`; `mid` must be a UUID; results kept for a fixed window. | L x M = L |
| TM-SYNC-03 | I, T | Cross-tenant ids: a push or REST call uses tenant B's record id, or puts B's ids in references (`jobId`, `clientId`) so server code that follows references (PDFs, emails, AI context) pulls B's data. | Cross-tenant read through server-side joins. | `[contract]` primary key `(tenant_id, id)`; RLS on every tenant table. | Reference lookups always inside `withTenant`, never on the HQ pool; isolation tests include reference-following paths. | L x H = M |
| TM-SYNC-04 | T | Conflict abuse: last-writer-wins lets a device that was offline for days, or a low-privileged user, overwrite a newer or approved record (approved time entries, sent invoices). | Payroll and billing integrity. | `[contract]` last-writer-wins per record, the loser kept in history. | Status-based write rules (approved, sent and paid records locked except for allowed roles); server time decides "last"; conflicts visible and restorable from history. | M x M = M |
| TM-SYNC-05 | D | Oversized or abusive payloads: huge mutations (plan images as data: URLs), thousands of mutations per push, deeply nested JSON, very large `limit` on pull. | API memory exhaustion; slow database for every tenant. | `[repo]` nginx `client_max_body_size 72m` and `client_body_timeout 60s` on `/api/` (1m on static paths in production); container memory, CPU and pids limits. `[contract]` pull `limit=500`. | Per-route body limits in Fastify (sync sized to the largest allowed record, everything else much smaller); maximum mutations per push; per-collection size limits in schemas (`maxLength`, `maxItems`); JSON depth limit; server-side cap on `limit`; move plan images out of JSON records, then lower the 72m limit. | M x M = M |
| TM-SYNC-06 | I | Stale offline data: a removed user or revoked device keeps its offline copy. | An ex-employee keeps client lists and pricing. | `[contract]` revocable devices and sessions. | Wipe on next contact after removal or revocation; fewer offline collections per role; tell tenants that a device which never reconnects keeps its copy. | M x M = M |
| TM-SYNC-07 | I | One IndexedDB database per origin (`kelbe-circuit` in `store.js`), not per tenant or user, so data stays and mixes when someone else signs in on the same browser. | Cross-tenant or cross-user exposure on shared computers and iPads. | None yet. | A database per tenant and user; wipe on sign-out; a "shared device" mode that keeps nothing after sign-out. | M x M = M |
| TM-SYNC-08 | I | Pull ignores role: `since=0` returns every record in the tenant, including collections a crew or portal session should not see. | Over-exposure inside a tenant. | `[contract]` RLS by tenant and portal client. | The same role filter on pull as on REST reads. | M x M = M |
| TM-SYNC-09 | T | Client clocks: a device sets `createdAt`, `updatedAt` or punch times to backdate work. | Payroll fraud. | None yet. | Server timestamps are authoritative; the client's punch time is stored separately and flagged when far from the time received. | M x L = L |

### HQ and the BYPASSRLS role (TM-HQ)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-HQ-01 | S, E | Stolen HQ session or credentials (phishing, malware on Kelvin's PC, session theft). HQ queries run as `fishtape_hq` with BYPASSRLS. | Every tenant's data: the worst single compromise. | `[repo]` HQ only on `hq.fishtapehq.com`, served by its own `hq-api` container; `/api/hq/` and `/hq/` return 404 on the app host; `X-Robots-Tag: noindex`; IP allow-list prepared but commented out. `[contract]` TOTP for HQ staff; every HQ read of tenant data writes an audit event. | Phishing-resistant MFA (passkeys) for HQ; short HQ sessions; HQ identity separate from Kelvin's TG Electrical owner account; turn on the IP allow-list once addresses are stable; email alert on every HQ sign-in. | M x H = H |
| TM-HQ-02 | E | The BYPASSRLS credential reachable from tenant code paths. It now lives only in `hq-api`, but `hq-api` runs the same image and entry point as the tenant API, so it also has the tenant routes compiled in. nginx keeps them unreachable: on `hq.fishtapehq.com` only `/api/v1/auth/`, `/api/hq/` and health reach `hq-api`, and every other `/api/` path is 404. A mistake in that routing, or a request to 127.0.0.1:3411 from the host itself, would expose tenant routes inside the process that holds BYPASSRLS. | Every tenant's data. | `[repo]` separate `hq-api` container on `127.0.0.1:3411`, the only one with `HQ_DATABASE_URL`; `api` and `worker` don't have it (the tenant `api` answers 503 on HQ routes); nginx sends `/api/hq/` (staging) and only `/api/v1/auth/`, `/api/hq/` and health on `hq.` (production) to `hq-api`, with 404 for any other `/api/` path there; the app host returns 404 for `/api/hq/`. | An HQ-only mode in the API so `hq-api` registers only HQ routes and the sign-in routes HQ needs; `hq-api` refuses requests whose Host is not the HQ host. | L x H = M |
| TM-HQ-03 | R, I | An HQ read that is not audited (a list endpoint missed, or the audit insert fails quietly). | Undetected snooping; no answer when a tenant asks who looked at their data. | `[contract]` every HQ read audited; `audit_events` append-only and hash-chained. | Audit insert in the same transaction as the read (no audit row, no data); a required reason field; tenants see HQ access in their audit view. | L x M = L |
| TM-HQ-04 | T | HQ writes into tenant data (support fixes, impersonation) cause damage or are misused. | Tenant data changed with HQ authority. | `[contract]` HQ writes audited with actor `hq staff`. | Prefer time-limited support access granted by the tenant owner; HQ read-only by default; writes need a reason and appear in the tenant's audit view. | L x M = L |
| TM-HQ-05 | T | Same-site attacks between `app.` and `hq.`: XSS in the PWA posts to the HQ API (SameSite doesn't separate them); tenant-supplied text (company or user names) rendered in the HQ console runs script in Kelvin's browser. On `hq.` all of `/api/` goes to `hq-api`, which runs the same code as the tenant API. | HQ actions performed for a malicious tenant. | `[repo]` same CSP and headers on `hq.`. `[contract]` Origin + `X-Fishtape` CSRF guard. | HQ Origin check equals `HQ_ORIGIN` exactly; the HQ console builds DOM with text nodes only (`h()` rules); host-only `__Host-` HQ cookie; the `hq.` block proxies only `/api/hq/`, the auth routes HQ needs, and health. | L x H = M |
| TM-HQ-06 | S | Staging serves `/hq/` on the same origin as the PWA. | XSS in the staging PWA could drive HQ with an HQ session. | Staging holds seeded data only. | Separate HQ accounts for staging; accept for staging, or give staging HQ its own host later. | L x L = L |

### API keys (TM-KEY)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-KEY-01 | I | An API key leaks (committed by a tenant, pasted into a no-code tool's logs, shipped in a web page). | Scoped access to that tenant's data until revoked. | `[contract]` hashed at rest, scoped, per tenant, rate-limited per key; `ft_live_` and `ft_test_` prefixes. | Shown once; a key id inside the key for lookup; last-used time and IP; one-click revoke; owner notified on creation; `ft_live_`/`ft_test_` pattern in `.gitleaks.toml`; GitHub secret scanning partner program later. | M x M = M |
| TM-KEY-02 | E | Over-broad scopes: wildcard or write scopes for read-only jobs; keys able to manage users, keys, MFA, billing or tenant secrets; keys accepted on sync. | Larger blast radius when a key leaks. | `[contract]` scopes such as `jobs:read`, `invoices:write`. | No wildcard; read-only by default; account, key, secret and billing routes refuse API keys; decide whether keys may use sync (default no); scope checked at route and record level. | M x M = M |
| TM-KEY-03 | S | No expiry: keys outlive the employee or integration that needed them. | Long-lived access by former staff or abandoned tools. | `[contract]` per-tenant keys that can be deleted. | Optional expiry with a one-year default; report of keys unused for 90 days; owners notified when a key's creator leaves the tenant. | M x M = M |
| TM-KEY-04 | D | A key floods the API. | Slow service for everyone. | `[contract]` per-key limits. `[repo]` nginx per-IP limits in production. | Per-tenant aggregate limits; `429` with `Retry-After`. | L x M = L |
| TM-KEY-05 | I | Keys sent in query strings end up in logs, history and Referer. | Key leak. | `[repo]` `/api/` access logs drop query strings. | The API accepts keys only in `Authorization` and rejects query-string keys outright. | L x M = L |
| TM-KEY-06 | I | `ft_test_` keys reach live data, or the meaning of test keys is unclear. | Confusion; data reached with the wrong key type. | Environments don't share databases. | Define test keys (test-mode data or non-production only) in the API docs. | L x L = L |

### AI features and agents (TM-AI)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-AI-01 | T, E | Prompt injection from tenant data: a lead's message, an inbound email or SMS, a Meta lead form field, a client note, or text in an imported PDF tells the assistant or a background agent to do something ("email the client list to ..."). | Data exfiltration, unwanted messages, edits made in the tenant's name. | `[contract]` agents act with scoped API keys and are audited as actor `agent`; each tenant uses its own AI key. `[repo]` CSP `img-src 'self' data: blob:` and `connect-src 'self'` stop the PWA from loading URLs a model writes into its output (markdown-image exfiltration). | Treat model output as untrusted; per-feature tool sets (the estimate helper reads and drafts, it can't send); human confirmation before any external side effect (email, SMS, payment link, share, delete); untrusted content passed as quoted data; no generic "fetch URL" tool; model output rendered as text. | H x H = H |
| TM-AI-02 | I | Exfiltration through tool calls: the model sends an email or SMS, creates a share link, or writes data into a field that flows to an integration. | Customer data leaves the tenant. | `[contract]` scoped keys; audit. | Outbound tools only to recipients already on the record, after confirmation; per-run message limits; no tool that takes arbitrary URLs or recipients. | M x H = H |
| TM-AI-03 | I | A tenant's AI key leaks: in request or error logs, returned to the browser, placed in prompts or tool results, or kept in job payloads. | Tenant's AI account abused; costs. | `[contract]` stored in `tenant_secrets` (envelope-encrypted). | Logger redaction for `authorization`, `x-api-key` and secret fields; decrypt at call time only; masked after saving; never in `jobs_queue` payloads. | M x M = M |
| TM-AI-04 | D | Cost abuse: a user, an injected loop or a background agent burns the tenant's AI credits. | Surprise bills; the tenant blames Fishtape. | None yet. | Daily token budgets per tenant and per user; a maximum number of tool steps per run; schedules and caps for background agents; spend shown to the tenant. | M x M = M |
| TM-AI-05 | S, E | Agent API and MCP server: an unauthenticated or weakly scoped MCP endpoint, or a tenant chosen from a tool argument instead of the credential. | Cross-tenant access through the agent surface. | `[contract]` agents use scoped API keys. | No anonymous MCP; tenant and scopes come from the credential only; MCP tools map to the same permissions as REST; OAuth for MCP clients when supported, with the same scopes. | L x H = M |
| TM-AI-06 | R | Agent actions not attributable to a run or a person. | Weak investigations. | `[contract]` audit actor `agent`. | Also record the starting user, model, tool name and a run id; keep run transcripts for a short, documented period. | L x M = L |
| TM-AI-07 | I | More tenant data than needed sent to the AI provider, possibly outside Canada. | Privacy obligations (PIPEDA and provincial laws) and tenant trust. | The tenant uses its own key and its own agreement with the provider. | Send the minimum; describe AI data flows in the privacy documents under `docs/compliance/`; a per-tenant switch to turn AI off. | M x M = M |
| TM-AI-08 | T | The CEC helper gives wrong code advice (invented rule numbers). | Unsafe installations; liability. | Build plan rule: code values cite their source; unverified values marked `VERIFY`. | Answers cite rule numbers from `js/lib/cec/` tables and are labelled as guidance, not approval; feedback logged. | M x M = M |

### Integrations and webhooks (TM-INT)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-INT-01 | S | Forged webhooks: a fake Stripe payment event, Twilio inbound SMS, Resend event or Meta lead. | Invoices marked paid; fake leads; automations triggered. | None yet (integrations are Phase 1). | Verify on the raw body before parsing: Stripe `Stripe-Signature` (HMAC-SHA256 with a timestamp), Twilio `X-Twilio-Signature`, Resend (Svix headers), Meta `X-Hub-Signature-256`; per-tenant webhook URLs with an unguessable id that selects the tenant's secret; reject on any failure. | M x H = H |
| TM-INT-02 | T | Replay of valid webhooks. | Duplicate payments recorded, duplicate leads and messages. | None yet. | Timestamp tolerance where the vendor signs one (Stripe, Svix); store processed event ids (Stripe event id, Svix id, Twilio MessageSid, Meta leadgen id); for money, re-fetch the object from Stripe before acting. | M x M = M |
| TM-INT-03 | I, E | SSRF: any feature that fetches a URL (tenant-configured outbound webhooks, import from URL, links in leads or emails, AI tools) is pointed at `127.0.0.1:3410`, `postgres:5432`, other services on the host (on staging, the neighbours' Postgres on `127.0.0.1:5432` and app on `:3000`) or a cloud metadata address. | Internal API or database reached; neighbours attacked from our address. | None yet. | One outbound HTTP helper: HTTPS only, port 443, resolve and block loopback, private, link-local and Docker ranges (re-checked after every redirect, or redirects off), timeouts and size caps; vendor SDKs call fixed vendor hosts only. | M x H = H |
| TM-INT-04 | I | Tenant secrets at rest: a dump or SQL injection exposes Stripe, Twilio, Resend, Anthropic and Meta credentials; ciphertext swapped between tenants. | Every tenant's vendor accounts. | `[contract]` `tenant_secrets` AES-256-GCM, envelope-encrypted with `SECRETS_MASTER_KEY`. `[repo]` the master key only in `.env` (root 600) and the password manager; backups age-encrypted. | Data key per secret, random 96-bit nonce, AAD binding tenant id, secret name and key version; key id column for rotation; shown once then masked; never logged ([secrets-management.md](secrets-management.md)). | L x H = M |
| TM-INT-05 | S, I | Meta Lead Ads: long-lived page tokens per tenant; Fishtape's Meta app secret (if one app serves every tenant) validates every webhook; lead fields are untrusted personal data and a prompt-injection source. | Leads of every tenant if the app secret or tokens leak. | None yet. | Minimum permissions (lead retrieval); page tokens in `tenant_secrets`; the app secret in `.env` (planned entry); handle token expiry and Meta's data deletion callback; lead fields treated as untrusted text (TM-AI-01). | L x H = M |
| TM-INT-06 | E | A tenant's Stripe secret key allows refunds and payouts if leaked; Twilio and Resend keys are often full-account keys. | Money moved; spam or phishing from the tenant's domain. | `[contract]` stored in `tenant_secrets`. | Prefer Stripe Connect (no tenant secret keys stored) or restricted keys with only what invoicing needs; Resend sending-only keys limited to the tenant's domain; a Twilio subaccount per tenant. | L x H = M |
| TM-INT-07 | D | SMS pumping and toll fraud: attackers trigger texts to premium or foreign numbers through forms, portal invites or sign-in codes. | The tenant's Twilio bill. | None yet. | No texts to unverified user-supplied numbers without rate limits; Canada and US only by default (Twilio geo permissions); daily SMS cap per tenant. | M x M = M |
| TM-INT-08 | T | Content injection in emails and SMS (line breaks in names or subjects, HTML in templates). | Spoofed content sent from the tenant's domain. | None yet. | Templates escape every field; plain-text part; vendor JSON APIs only (no hand-built mail headers). | L x M = L |

### iOS app (TM-IOS)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-IOS-01 | S | `capacitor://localhost` is an allowed CORS origin, but every Capacitor app uses it and any client can send that `Origin` header. | If cookies or credentials were allowed for it, any app could act as the user. | `[contract]` iOS uses `Authorization: Bearer`; `CORS_ORIGINS` adds `capacitor://localhost`. | No `Access-Control-Allow-Credentials` for that origin; cookie sessions never accepted with it; Origin never treated as authentication. | L x M = L |
| TM-IOS-02 | I | Bearer token kept in the WebView's localStorage or IndexedDB, readable by any script in the app. | Session theft from the device. | `[contract]` bearer tokens on iOS. | Store tokens in the Keychain through a native plugin (this device only, when unlocked); hold them in memory in JS. | M x M = M |
| TM-IOS-03 | T, E | Native bridges (the ARKit plugin) are callable by any script in the WebView; a release build that loads the live website (Capacitor `server.url`) exposes native APIs to remote content. | XSS becomes camera access or other native actions. | `[contract]` the plugin contract is two calls: `isAvailable` and `measurePath`. | Bundle the web assets in the app (no `server.url` and no extra `allowNavigation` hosts in release builds); the plugin does only what the contract says; a clear camera usage string. | L x M = L |
| TM-IOS-04 | T | iOS supply chain and accounts: Capacitor and plugin packages, CocoaPods or SPM, Xcode on Kelvin's Mac over SSH, signing certificates, and App Store Connect. A takeover ships a malicious update to every iPad. | Malicious app on tenant devices. | `[repo]` a Dependabot entry for `/mobile` is prepared (commented out). | Apple ID with hardware-key MFA; signing keys only on the Mac (FileVault, SSH keys only); lockfiles and Dependabot for `mobile/`; builds from tags; App Store Connect roles in the quarterly access review. | L x H = M |

### Web front end (TM-WEB)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-WEB-01 | T | XSS through `innerHTML`: `icons.js` sets `svg.innerHTML` from static strings, but `icon(name, size, extra)` also accepts raw markup when `name` starts with `<`, and appends `extra` as markup. Passing record data to it, or a `javascript:` URL to an `href` through `h()`, would be XSS. | Script in the app origin: session, offline data, every API call as the user. | `[repo]` `h()` turns children into text nodes and sets attributes with `setAttribute`; the CSP has no `'unsafe-inline'` or `'unsafe-eval'` for scripts, so inline handlers and `javascript:` URLs don't run; `check-csp.mjs` flags `eval`, `new Function`, string timers and `innerHTML` strings with `style=` or `on*=`. | `innerHTML` only in `icons.js` and only from constants; `icon()` stops accepting markup from callers; URL attributes limited to `https:`, `mailto:`, `tel:` and relative; Trusted Types later ([headers-csp.md](headers-csp.md)). | L x H = M |
| TM-WEB-02 | T | Stored XSS from tenant data rendered somewhere else: the HQ console (a malicious tenant names itself `<img src=x onerror=...>`), the portal, PDFs, emails, AI output. | HQ staff or a tenant's customers attacked. | `[repo]` same CSP on every host. | Every renderer uses text nodes; server-side templates escape; PDF and email generation escape; payload tests in every text field ([pentest-checklist-asvs.md](pentest-checklist-asvs.md), V5). | L x H = M |
| TM-WEB-03 | T | pdf.js from cdnjs: a compromised CDN serves malicious code at the pinned path; the script has no SRI; the worker is loaded by `importScripts` inside a blob wrapper, where SRI is impossible. pdf.js 3.11.174 is also affected by CVE-2024-4367 (a malicious PDF runs script through font compilation; fixed in 4.2.67). | Script in the app origin. | `[repo]` pdf.js 4.10.38 self-hosted in `electrical-app/vendor/pdfjs-4.10.38/` from the integrity-checked npm package; CSP `script-src`/`connect-src` are `'self'` only; `getDocument({ isEvalSupported: false })`; 4.2.67+ fixes CVE-2024-4367 (2026-10-19). | Review each pdf.js upgrade (new versioned folder); drop `blob:` from `worker-src` after a test pass. | L x M = L |
| TM-WEB-04 | I | The service worker caches tenant data: `sw.js` stores every successful same-origin GET in Cache Storage, `/api/` responses included, keyed by URL only. Cache Storage ignores `Cache-Control: no-store`, survives sign-out, and when offline serves whatever is cached (or `index.html`) to whoever is signed in. The cdnjs test is a substring match (`includes('cdnjs.cloudflare.com')`). | The previous user's or previous tenant's data on a shared iPad; data left on lost devices. | `[repo]` GET only; network first; same-origin only; `/api/` is never handled or cached by `sw.js` (2026-10-19); `sw.js` served `no-cache`. | Clear Cache Storage on sign-out as part of the per-company local data wipe (Phase 1 workstream G). | L x M = L |
| TM-WEB-05 | S | Clickjacking. | Tricked clicks on sign-in or payment screens. | `[repo]` `X-Frame-Options: DENY`; CSP `frame-ancestors 'none'`. | None. | L x L = L |
| TM-WEB-06 | T | Malicious uploads: SVG with script, PDFs aimed at the viewer, huge images. | XSS, browser crash. | `[repo]` the plan editor flattens imported images and PDF pages to JPEG on a canvas (4096 px maximum) and shows them through `img` or canvas; CSP. | Never inline user SVG; reject unknown types by content; size limits (TM-SYNC-05). | L x M = L |
| TM-WEB-07 | S | Open redirect after sign-in (`?next=`) or OIDC. | Phishing that starts on our domain. | None yet. | Only relative paths starting with a single `/`. | L x L = L |

### CI/CD and supply chain (TM-SUP)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-SUP-01 | T | A malicious or vulnerable npm package (typosquat, hijacked maintainer, install-script worm that steals tokens). | Code execution in CI, in the image, in production. | `[repo]` committed lockfile and `npm ci`; Dependabot weekly with a 7-day cooldown (14 for majors); `npm audit` (high and above) and osv-scanner on every lockfile; dependency review on PRs (fails on high; denies AGPL and SSPL); CodeQL; build tools only in the throwaway image stage. | Turn on Dependabot security updates (off today); review every new dependency (need, maintainers, install scripts, transitive count); keep server dependencies few; consider `--ignore-scripts` with an allow-list. | M x H = H |
| TM-SUP-02 | T | A third-party GitHub Action is repointed to malicious code (as happened to tj-actions/changed-files in 2025). | CI secrets or code stolen or changed. | `[repo]` every third-party action pinned to a full commit SHA; workflow permissions default to `contents: read`; Dependabot for actions; secrets only in environment-scoped deploy jobs. | No `pull_request_target`; review action updates like code. | L x H = M |
| TM-SUP-03 | S, E | Kelvin's GitHub account is taken over. | Push code, approve production deploys, change settings and secrets. | `[repo]` MFA on GitHub; CODEOWNERS; branch protection with the `ci-ok` check; production deploys need approval in the `production` environment. | Passkey or hardware key; no classic personal access tokens; quarterly review of authorized OAuth apps and GitHub Apps; signed release tags verified on the host (`REQUIRE_SIGNED_TAGS=1` with an allowed-signers file outside the repo) so a GitHub-only compromise can't produce a deployable release. | L x H = M |
| TM-SUP-04 | E | A deploy key is stolen, or used by a modified workflow on another branch. | Something deployed to staging or production. | `[repo]` one key per environment; `authorized_keys` `restrict,command=` forced command (`deploy-gate.sh`) allows only `deploy <sha>` (commit must be on the branch), `deploy <tag> <sha>` (tag on the release branch, equal to the CI-tested commit) and `status`; host key pinned; key deleted from the runner after use; production needs Kelvin's approval and `v*` tags. | Deployment branch rule on the `staging` environment (staging branch only); rotate deploy keys yearly. | L x M = L |
| TM-SUP-05 | T, E | AI coding agents push code. The cloud Claude Code session pushes straight to the branch that auto-deploys to staging, and production's `RELEASE_BRANCH` defaults to that same branch. A prompt injection (web page, issue text, a dependency's README, tool output) or a plain mistake adds harmful code. | Harmful code on staging (root on a shared box) and, if missed at release review, in production. | `[repo]` agents never get production secrets, SSH keys or GitHub admin; Co-Authored-By trailer; CI gates; the PR template asks who reviewed agent code; production needs a tag and Kelvin's approval. | Agents push only to their own `claude/*` topic branches; the deploy branch accepts merges through PRs with `ci-ok`; a separate protected release branch; line-by-line review of agent changes to `.github/`, `deploy/`, `server/db/`, migrations and auth. | M x H = H |
| TM-SUP-06 | T | A compromised or vulnerable base image (`node`, `postgres`). | Code execution in containers. | `[repo]` images pinned by digest; Dependabot for docker and docker-compose; the app image name ends in `.invalid` and can't be pulled. | Scan the built image in CI; rebuild when base digests change. | L x M = L |
| TM-SUP-07 | I | Secrets committed to the public repo. | Immediate exposure (forks, caches, scrapers). | `[repo]` gitleaks over full history in CI; GitHub secret scanning and push protection on; `check-committed-files.mjs` fails if an env file, private key, keystore, dump or age identity is tracked; `.gitignore`; `.dockerignore` allow-list. | Optional local pre-commit gitleaks; a gitleaks rule for `ft_live_`/`ft_test_`. | L x H = M |
| TM-SUP-08 | T | Release tags created or moved by someone other than Kelvin. | Unreviewed code proposed for production. | `[repo]` tag format and release-branch checks; the tag must equal the CI-tested commit; manual approval. | Tag ruleset: only Kelvin creates, moves or deletes `v*`; signed tags required on the host. | L x M = L |

### The shared staging box (TM-STG)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-STG-01 | E | A push to the staging branch is root on the shared VPS: `update.sh` runs as root and builds, migrates and runs `backup.sh` and Docker Compose from the commit it just checked out; the nightly backup timer runs `backup.sh` from the checkout and sources `backup.conf` there. | Root on a box that hosts unrelated sites. | `[repo]` GitHub MFA, branch protection, CI gates, forced-command deploy key (only commits already on the branch), root-owned checkout not writable by the web server; staging holds no production data or secrets. | Install `update.sh` and `backup.sh` as root-owned copies outside the checkout (as done for `deploy-gate.sh`); keep `.env`, `backup.conf` and `backup-recipients.txt` in `/etc/fishtape/staging/`; verify commit signatures before checkout against an allowed-signers file outside the repo; agents off the deploy branch (TM-SUP-05). | M x H = H |
| TM-STG-02 | I, E | A compromised neighbouring site runs code on the box: it can reach Postgres on `127.0.0.1:5433` (the image's default `pg_hba` allows password logins over TCP, the superuser included), call the API on `127.0.0.1:3410` and the HQ API on `127.0.0.1:3411` directly (no nginx limits or IP allow-list, forged `X-Forwarded-For`), and read world-readable files. With the app role's password alone it could set any tenant id. | Staging data; a root escalation would expose everything on the box. | `[repo]` ports bound to 127.0.0.1; random 32-byte hex passwords with scram-sha-256; `.env` root 600; root-owned checkout; containers non-root, read-only, `cap_drop: ALL`. | Stop publishing `127.0.0.1:5433` on staging (use `docker compose exec`); reject the superuser over TCP in `pg_hba`; keep staging free of real customer data. | M x M = M |
| TM-STG-03 | T | CloudPanel rewrites the vhost, or its admin panel is compromised; Fishtape's headers or path rules silently disappear. | CSP and HSTS lost; files exposed. | `[repo]` snippets installed by `install-nginx.sh` with `nginx -t` and rollback; README says to edit through CloudPanel if the site is listed there; `check-exposure.sh` after deploys. | CloudPanel admin behind MFA and an IP allow-list; run `check-exposure.sh` on a schedule as well, not only after deploys. | L x M = L |
| TM-STG-04 | I | Backups, logs and state files sit on a shared host. | Readable by anyone who gets root. | `[repo]` backups age-encrypted with only the public key on the server; backup directory 700; `.env` 600; status files hold no secrets. | API logs free of bodies and tokens; staging data stays seeded or synthetic. | L x M = L |
| TM-STG-05 | S | Staging shares the registrable domain `truecollarbuilt.com` with Kelvin's other sites: cookie tossing and same-site requests from siblings. | Session fixation or CSRF from a compromised sibling site. | `[contract]` Origin check. | `__Host-` cookie prefix; exact Origin match. | L x M = L |
| TM-STG-06 | D | Other sites use up CPU, memory or disk. | Staging down. | `[repo]` container CPU and memory limits; disk use in `host-status.json`. | Accept (staging RTO is 2 business days). | M x L = L |

### Data at rest and backups (TM-BCK)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-BCK-01 | I | Backup files stolen from the host or the offsite store. | The whole database, including tenant secret ciphertext. | `[repo]` `pg_dump` streamed into `age` with public-key recipients (nothing plaintext on disk); private keys offline with Kelvin; backup directory 700; offsite copies already encrypted. | Offsite target in Canada with provider-side retention or object lock (required for production; not set up yet). | L x H = M |
| TM-BCK-02 | D | The age private key is lost. | Backups unreadable when needed. | `[repo]` production has a sealed spare key as a second recipient; keys in the password manager and on an encrypted USB; `restore-test.sh` at least quarterly. | Record key fingerprints; test the spare key once a year. | L x H = M |
| TM-BCK-03 | T, D | An attacker with root, or ransomware, deletes local and offsite backups. | No recovery. | `[repo]` heartbeat ping after every backup when `HEARTBEAT_URL` is set (dead-man's switch); `backup.sh` never deletes offsite copies. | Offsite credentials that can write but not delete; object lock; alerting on a missed heartbeat. | L x H = M |
| TM-BCK-04 | I | The production disk is not encrypted, or provider staff, snapshots or disposed disks expose data. `SECRETS_MASTER_KEY` sits in `.env` on the same disk as the database, so full-disk access defeats envelope encryption. | All production data and tenant secrets. | `[repo]` `check-host.sh` reports disk encryption; the production README asks dotmoose about encryption, console access and disk disposal. | LUKS on the data volume, or the provider's answer in writing; a written agreement with dotmoose; later, keep the master key off the database host (a KMS or separate secrets service). | L x H = M |
| TM-BCK-05 | I | Restoring an old backup brings back data a tenant asked to delete. | Privacy obligation broken. | Retention rule: deleted tenant data ages out of backups in about 8 weeks. | A deletion log (ids only) re-applied after any restore; said plainly in the privacy notice. | L x M = L |
| TM-BCK-06 | D | No point-in-time recovery. | Up to 24 hours of data lost (production RPO 24 h). | `[repo]` nightly and pre-deploy backups. | WAL archiving (planned; RPO 15 minutes). | M x M = M |

### Audit trail (TM-AUD)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-AUD-01 | T, R | Audit rows rewritten: the app role can only insert, but the owner or superuser could edit rows and recompute the hash chain. | Evidence destroyed or forged. | `[contract]` `audit_events` append-only and hash-chained per tenant (`prev_hash`, `hash`); `fishtape_app` INSERT-only. | Copy each tenant's latest hash outside the database regularly (monthly evidence bundle, deploy log) so a rewrite shows; a chain verification job. | L x M = L |
| TM-AUD-02 | R | API key, agent and HQ actions logged without the person behind them. | Weak investigations. | `[contract]` actor types (user, api key, agent, system, hq staff), IP, user agent, request id. | Record the key id, the agent run id and the starting user. | L x M = L |
| TM-AUD-03 | I | Audit summaries carry personal data or secrets into a table kept for the life of the tenant plus a year. | Personal data spread and kept longer than needed. | Retention rule for `audit_events`. | Summaries hold ids and field names, not values; never secrets. | M x L = L |

### Data leakage through headers, URLs, static paths and logs (TM-LEAK)

Kelvin's rule: no `.env` file and no customer detail leaves through a header, a URL, a public
endpoint or a log.

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-LEAK-01 | I | Static file exposure: `.env`, `.git`, deploy scripts, SQL dumps, backups, keys, READMEs, tests or archives served from the web root. | Secrets and customer data published. | `[repo]` the web root is only `electrical-app/` (staging) or a copied release folder holding just `electrical-app/` and `hq/` (production, `/srv/fishtape/www/releases/<sha>`); `.env` files live outside it (`deploy/<env>/.env`, root:root 600); nginx serves an allow-list of app file types and returns 404 for unknown paths (no SPA fallback; the app uses a hash router); explicit 404 rules (production `deny.conf`, the same rules in the staging snippet) for dotfiles except `/.well-known/`, `*.env*`, `*.sql`, `*.sh`, `*.md`, config files, lockfiles, backups, dumps, keys and archives, and `/deploy`, `/server`, `/docs`, `/compliance`, `/tests` and other repo folders; `autoindex off`; `root`, not `alias`, so no off-by-slash traversal; `deploy/check-exposure.sh` after every deploy; `check-committed-files.mjs` and gitleaks in CI. | Staging serves straight from the git checkout, so a misplaced file with an allowed extension inside `electrical-app/` is public until noticed; keep the `check-exposure.sh` path list in step with new folders. | L x H = M |
| TM-LEAK-02 | I | Version and infrastructure banners: `Server` version, `X-Powered-By`, upstream addresses. | Easier targeting. | `[repo]` `server_tokens off`; `proxy_hide_header X-Powered-By`; `check-exposure.sh` fails on version banners. | None. | L x L = L |
| TM-LEAK-03 | I | API errors with stack traces, SQL, internal hostnames or IPs, or values from other rows. | Attack information; data leak. | `[contract]` errors are `{ error: { code, message, requestId } }`. `[repo]` `NODE_ENV=production` in the image. | A last-resort error handler that never returns raw database or library messages; tests that force 500s and inspect the body. | M x M = M |
| TM-LEAK-04 | I | Customer data kept by shared caches or the browser's disk cache. | Data left on shared computers or intermediaries. | `[repo]` nginx forces `Cache-Control: no-store` on `/api/` responses. | `sw.js` still copies API responses into Cache Storage, which ignores `no-store` (TM-WEB-04). | M x M = M |
| TM-LEAK-05 | I | Tokens, keys, emails or customer data in URLs end up in access logs, browser history and Referer. | Credential or personal data leak through logs and third parties. | `[repo]` `/api/` access logs use the `fishtape_*_noquery` formats (`$uri` without `$args`, Referer query stripped); Referrer-Policy `strict-origin-when-cross-origin`; hash routing keeps record ids and search terms out of server logs and Referer (fragments are never sent). | API rule for workstream A: no tokens, keys, emails or customer data in query strings (OIDC `code` and `state` are single-use exceptions); share links unguessable and expiring. Remaining: nginx error logs can still contain the full request line; on staging, CloudPanel's own access log for static files still records query strings. | M x M = M |
| TM-LEAK-06 | I | Application logs carry secrets or personal data: tokens, passwords, PINs, tenant secrets, AI prompts containing secrets, full request bodies. | Secrets copied into log files and support conversations. | `[repo]` container logs rotate (json-file driver; retention target 30 days). | The API's logging is not built yet: a redaction list (`authorization`, `cookie`, `x-api-key`, `password`, `pin`, `token`, `secret`), no bodies, request ids instead of payloads. json-file rotation is by size, so the 30-day target is not enforced by time. | M x M = M |
| TM-LEAK-07 | I | Public endpoints say too much: `/api/v1/status`, `/api/healthz`, `/api/readyz`, `/api/v1/openapi.json`. | Reconnaissance; the git SHA tells an attacker whether a public fix is deployed yet. | `[contract]` status shows no secrets, no tenant data and no version beyond the git SHA; readyz reports coarse states only. `[repo]` `/api/hq/*` returns 404 on the app host; `/api/docs` blocked in production; the status host serves only status and healthz. | Accept the SHA (the repo is public) or move it to HQ health only; deploy security fixes promptly after they merge. | L x L = L |

### Denial of service (TM-DOS)

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-DOS-01 | D | Volumetric DDoS on the single production VPS. | Outage for every tenant. | `[repo]` nginx rate limits; unknown hosts dropped. | An off-box status page; a fronting proxy or CDN if attacks happen (weigh TLS termination outside Canada). | L x H = M |
| TM-DOS-02 | D | Application-layer exhaustion: expensive queries, huge pulls, slow clients, report or PDF generation. | Slow or down for everyone. | `[repo]` production nginx: 20 requests/second per IP on `/api/` (burst 60) and 10/minute on auth (staging relies on the API's limits); body size and timeouts; proxy timeouts 60 s; container CPU, memory and pids limits; Postgres `idle_in_transaction_session_timeout=60s`. | `statement_timeout` on `fishtape_app`; pagination caps; per-tenant quotas; worker concurrency limits. | M x M = M |
| TM-DOS-03 | D | A noisy or malicious tenant takes most of the database or storage (huge drawings, bulk imports). | Other tenants degraded. | `[repo]` body limits. | Per-tenant rate limits and storage quotas; usage shown in HQ. | M x M = M |
| TM-DOS-04 | D | Dependency outages: certificate renewal fails, vendors are down. | Expired certificate; degraded features. | `[repo]` certificate expiry in `host-status.json` for HQ health; `check-host.sh` checks the certbot timer. | Self-host pdf.js; alert well before expiry; queue and retry outbound messages. | L x M = L |
| TM-DOS-05 | D | Disk fills (logs, backups, images, database). | Outage; failed backups. | `[repo]` log rotation; backup retention; image pruning in `update.sh`; disk use in host status. | Alerts at the thresholds `check-host.sh` uses (70 % warn, 85 % fail). | L x M = L |
| TM-DOS-06 | D | Webhook floods. | Queue backlog. | `[contract]` queue lag reported by `/api/readyz`. | Per-tenant webhook limits; unknown webhook ids dropped early. | L x M = L |

### Location while clocked in (TM-LOC)

Raw location points (`locationPoints`), consent answers (`locationConsents`) and the clock-in fix on
time entries. Policy in [privacy.md](../compliance/privacy.md#location-while-clocked-in).

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-LOC-01 | I | A manager, owner, API key, AI tool or a forgotten filter reads another worker's raw location points, turning the time clock into tracking. | Employee surveillance beyond the notice; privacy complaint against the tenant. | `[repo]` RESTRICTIVE RLS policy on `location_points`: rows only where `employee_id = app_member_employee_id()` (0140/0141), so even an owner session gets nothing; `ownRowsAlways` app filter on REST, sync and AI paths; `noApiKeys` (403 for any scope); not in the assistant's collections; the members routes refuse linking a membership to an employee record whose points another account recorded (the policy keys on that link); the HQ support view refuses `locationPoints` and `locationConsents` and drops entry coordinates (HQ has BYPASSRLS for the audited export and counts); the live map shows only people whose answer to the current notice is yes, and only points from after that answer; tests in `server/test/location.test.js` and `server/test/hq.test.js`. | Bind points to the user id as well as the employee link. | L x H = M |
| TM-LOC-02 | E | The narrow database scopes (`app.location_scope` = `system` or `crew`) are set on a request path that should not have them, or left set for the rest of a transaction. | Every point in the company readable. | `[repo]` set only in `services/location.js` (retention job, live map after the role and setting checks); transaction-local `set_config(..., true)`; the live map resets the scope after its query; `crew` is read-only in the policy's WITH CHECK; test that the foreman's own reads are unchanged after viewing the map. | A lint rule that `app.location_scope` appears only in `services/location.js`. | L x H = M |
| TM-LOC-03 | I | Location is captured off the clock: a bug, a stale native geofence after clock-out, or the app relaunched in the background with no open shift. | Off-hours tracking, the one thing the notice promises never happens. | `[repo]` every capture path checks the open shift first and drops a fix if the shift closed meanwhile (`clock.js` `recordPoint`, `shift-tracker.js`); the iOS monitor records nothing without a shift id, stop() at clock-out and whenever the app finds no open shift, and a shift older than 18 h stops itself; unit tests. | A device test on a real iPhone (background relaunch, force-quit, reboot): VERIFY. | L x H = M |
| TM-LOC-04 | T, R | A worker spoofs their location (mock-location apps, browser dev tools, a modified app) to look on site, or clocks in for someone else (TM-DEV-07). | Payroll fraud; billing a customer for work not on site. | `[repo]` the fix is evidence, not proof: off-site flags need a foreman's review; accuracy is stored; server time stamps every write; audit trail. | Treat location as a reminder, not a control; flag fixes with implausible accuracy (exactly 0 m) or speed between fixes. | M x L = L |
| TM-LOC-05 | I | Old location data outlives the retention promise: in tombstones, record history, backups, devices that never sync again. | Data kept longer than the notice says. | `[repo]` daily retention job empties and soft-deletes points and scrubs entry coordinates, audited; points never enter `record_history`, entry history copies omit coordinates; devices prune their own copies; backups age out in about 8 weeks (backup-retention.md). | Say in the notice that backups hold data up to 8 more weeks; a device that never reconnects keeps its copy (TM-SYNC-06). | L x M = L |
| TM-LOC-06 | I | Third parties learn about job sites from map tiles and address lookups (Natural Resources Canada). | Job addresses (customer addresses) seen by a government service. | `[repo]` tiles show the map area, never a person's position (pins drawn on the device; maps of people's points fetch only tiles near job sites, minimap.js tileNearSites); `referrerpolicy=no-referrer`, `credentials: 'omit'`; one lookup per job, only when a manager taps Find address; CSP allows only these two hosts. | List both on the sub-processor list; NRCan's written OK for commercial use of the Geolocator (VERIFY). | L x L = L |
| TM-LOC-07 | T | A worker edits approved time, or reviews their own off-site flag. | Payroll integrity. | `[repo]` approved entries are locked for anyone without `time-approve`; only managers can set `flag.reviewedAt` (`access.js`); tests. | Server time decides "last" (TM-SYNC-09). | L x M = L |

### QuickBooks Online sync (TM-QBO)

Each company connects its own QuickBooks Online company over OAuth; Fishtape holds the Intuit app
credentials (platform env vars) and each company's tokens (sealed in `tenant_secrets`). The
contract is [docs/integrations/quickbooks.md](../integrations/quickbooks.md); `[contract]` below
means a control that contract requires (section in brackets). Support steps:
[quickbooks-support.md](../runbooks/quickbooks-support.md).

| id | STRIDE | threat | impact | existing controls | gaps / planned | rating |
| --- | --- | --- | --- | --- | --- | --- |
| TM-QBO-01 | S, T | OAuth login CSRF: an attacker sends a fresh connect link (their own tenant) to a QuickBooks admin of another company, who approves it, so the victim's books connect to the attacker's tenant. | The attacker reads and writes another company's books. | `[contract]` (2.2) one-time ticket (120 s, single use, owner/admin with MFA); an interstitial naming the Fishtape company and the requester; a flow cookie and a server-side state row; `web` tickets need the issuer's own session; the connect notification names the QuickBooks company to every office user. | The residual risk needs a victim who reads past the interstitial within 120 s; accepted. | L x H = M |
| TM-QBO-02 | I | Token theft from the database or a backup. | Read and write access to a company's books until revoked. | `[contract]` (2.3) envelope AES-256-GCM with AAD bound to tenant and name, key outside the database (`SECRETS_MASTER_KEY`); refresh token revoked at Intuit on disconnect (failed revokes retried from `qbo_revoke_pending` for 14 days); the generic secret routes refuse the three QBO names; tokens and the realm id never in responses, logs, job payloads, audit or HQ. | Backups hold sealed tokens for up to 8 weeks (TM-BCK). | L x H = M |
| TM-QBO-03 | S, T | Forged Intuit webhooks drive reads or writes. | Wasted reads; at worst a confirmed change pulled early. | `[contract]` (5.9) HMAC-SHA256 on the raw body before anything is parsed, two verifiers during a rotation; events only mark the tenant dirty or name an id to read; webhook-only signals (deletes, merges, voids) confirmed by a read; failed signatures counted and alerted (`qbo_webhook_signature`). | | L x M = L |
| TM-QBO-04 | I, T | Cross-tenant routing of webhook events. | One company's changes written into another. | `[contract]` (3.2) realm hash unique per tenant (`qbo_realms` primary key); events stored only under the tenant found by hash; unknown realms dropped. | | L x H = M |
| TM-QBO-05 | D | A refresh-token race loses the rotated token. | The company has to reconnect. | `[contract]` (2.4) single flight per tenant (in-process and a row lease); the newest token stored in a short transaction; `invalid_grant` re-reads the stored token once before giving up. | | L x M = L |
| TM-QBO-06 | T | A sync loop or mass overwrite: a mapping or merge bug rewrites every record on one side. | A company's books or Fishtape records damaged at scale. | `[contract]` (5.4, 5.8) the system actor is never re-queued, SyncToken echoes dropped, a snapshot three-way merge; the safety brake (500 writes an hour per tenant) pauses the company and alerts HQ; `QBO_WRITES=off` platform switch; shadow mode for a first week; HQ pause. | | M x H = H |
| TM-QBO-07 | I | QuickBooks data reaches field crews or the client portal. | Customer balances and notes seen by people who should not see them. | `[contract]` (3.1, 4.2, 10.1) no QBO fields on records and none in `settings`; QBO customer `Notes` never pulled; every QBO route office-only; tests on `/sync/pull` for field roles. | The client portal must hide `needs_review` and pull-created documents until released (BACKLOG). | L x M = L |
| TM-QBO-08 | D | One tenant exhausts the workspace's Intuit read allowance (500,000 CorePlus reads a month on the free tier, hard-blocked above it). | QuickBooks sync stops for every company until the 1st. | `[contract]` (5.11) a per-tenant budget on every read with step-down and pause; rate caps on the scan and on pulls; a lower trial budget; a workspace budget under Intuit's cap; HQ alerts at 70% and 90% and per tenant at 50% and 80% (`qbo_budget`). | | M x M = M |
| TM-QBO-09 | I | The callback's code, the realm id or a connect ticket lands in logs or a Referer header. | Realm ids are customer identifiers Intuit requires encrypted; a code could be replayed within minutes. | `[contract]` (2.2, 10.1) the callback answers 302 only, warn-level logging (no request lines), `SECRET_QUERY` redaction of `code`, `state`, `realmId`, `ticket`; `Referrer-Policy` strict already. | nginx error logs can still hold a request line (TM-LEAK-05); look-up searches are POST bodies for that reason. | L x M = L |
| TM-QBO-10 | T | Old links are used against a different QuickBooks company or environment after a reconnect. | Writes land in the wrong company's books. | `[contract]` (2.2, 2.4, 3.2) the server refuses with `purge_required` until links are purged; `realm_hash` on every row carrying a QBO id, checked before acting (`realm_mismatch` alert); environment check before any Intuit call. | | L x H = M |
| TM-QBO-11 | D | A realm is squatted by a former employee's throwaway tenant, locking the real company out. | The company cannot connect its own books. | `[contract]` (2.9) takeover by a QuickBooks admin of that company (Intuit's consent proves it); HQ release (audited, reason required); auto-disconnect of long-paused, suspended or closed tenants. | | L x M = L |
| TM-QBO-12 | D | A failed connect revokes a token whose grant another tenant shares, disconnecting that tenant. | Denial of service against another company. | `[contract]` (2.2) revoke only when no tenant holds the realm; never on `realm_in_use`; a test models a grant-level revoke. | Intuit's revoke scope is VERIFY (contract 11.4). | L x M = L |
| TM-QBO-13 | D | A Fishtape platform credential error (a rotation typo, production keys against sandbox tokens) is read as every company revoking access. | Every company marked "reconnect needed" at once. | `[contract]` (2.4) `invalid_client` and other token-endpoint 4xx open a 10-minute token breaker and change no tenant's state; 5+ `invalid_grant` in 15 minutes stops marking tenants; HQ alerts `qbo_platform_credentials` and `qbo_mass_revoke`. | | L x M = L |
| TM-QBO-14 | I | Customer data (names, amounts, Intuit detail) leaks into job errors, worker logs or HQ. | Customer data seen by HQ or kept in logs. | `[contract]` (5.8) fixed-table error messages in every job error; Intuit's detail only in the tenant's own sync log after a name-safe scrub; HQ reads column-granted counts, states and Intuit transaction ids only (3.2, 9); tests in `leaks.test.js` and `hq-qbo.test.js`. | | L x M = L |
| TM-QBO-15 | T, E | Money written to the books by an API key, the assistant, an agent or a phished office user. | False invoices or payments in the company's books. | `[contract]` (5.2, 7.1) the origin rule: money from API keys and agents waits for an office user's approval; every QBO write route needs a two-step-verified session. | | L x H = M |
| TM-QBO-16 | T | QuickBooks query injection through look-up terms or names. | Reads outside what was asked (only the tenant's own company). | `[contract]` (7.8) `qboQuote` escapes `\` and `'` and rejects `%` and `_`; id patterns; length caps; unit tests. | | L x L = L |
| TM-QBO-17 | T | Duplicate postings from retries, crashes or two workers on one tenant. | Double invoices or payments in the books. | `[contract]` (5.3, 5.8) links committed `pending` before a create; a marker on every object and adopt-by-search before any retry; lease epoch fencing on every write; heartbeats; a separate QuickBooks worker pool. | | L x H = M |

## Top risks and next actions

In priority order. Each becomes a GitHub issue labelled `security`.

1. Code on the deploy branch runs as root on the shared staging box, and agents push to that
   branch directly; production's release branch is the same branch (TM-STG-01, TM-SUP-05,
   TM-SUP-08). Agents push to topic branches; the deploy branch takes PRs with `ci-ok`; root-run
   scripts and their config move out of the checkout; signed tags (`REQUIRE_SIGNED_TAGS=1`) and a
   separate protected release branch for production.
2. RLS gaps that fail open (TM-TEN-06, TM-TEN-07, TM-TEN-01, TM-TEN-05). Migration lint and a
   post-migrate catalogue check that stops the deploy; portal scoping that fails closed;
   isolation tests for every tenant table; the API refuses to start on the wrong role.
3. Front-end storage and third-party code (TM-WEB-04, TM-LEAK-04, TM-WEB-03). `sw.js` stops
   caching `/api/` and clears on sign-out before sync ships; self-host pdf.js with SRI and
   `isEvalSupported: false`.
4. Shared-iPad PINs and offline data (TM-DEV-02, TM-DEV-03, TM-SYNC-07). PINs out of `employees`
   records and server-side only; IndexedDB per tenant and user; wipe on sign-out and revocation.
5. Account takeover (TM-AUTH-05, TM-AUTH-03, TM-AUTH-01). Link OIDC identities by `sub` or
   `oid` + `tid` only; an MFA-pending state that grants nothing; TOTP after OIDC for MFA roles;
   breached-password check.
6. Prompt injection driving AI tools (TM-AI-01, TM-AI-02). Least-privilege tool sets per feature,
   confirmation before external side effects, budgets and step limits.
7. Webhook forgery and SSRF (TM-INT-01, TM-INT-03). Signature checks on the raw body, replay ids,
   and one outbound HTTP helper that blocks private ranges.
8. HQ, the key to every tenant (TM-HQ-01, TM-HQ-02). The `hq-api` split and the narrow nginx
   routing on `hq.` are done; next, an HQ-only mode so `hq-api` has no tenant routes at all,
   passkeys and short sessions for HQ staff.
9. Dependency supply chain (TM-SUP-01, TM-SUP-06). Turn on Dependabot security updates; review
   new dependencies; scan the built image.
10. Backups and keys before go-live (TM-BCK-01, TM-BCK-03, TM-BCK-04). Offsite copy in Canada
    with object lock; disk encryption confirmed on the production host; a restore test with both
    production keys.

## Review

Owner: Kelvin. Review this model at least once a year (next by 2027-10-19) and whenever one of
these happens:

- a new actor type, integration, AI tool or public endpoint;
- a change to authentication, sessions, roles, RLS, the database roles or HQ;
- a new host, hosting provider, CDN, proxy or connection pooler;
- the first real customer data in production, or Quebec launch;
- a SEV1 or SEV2 incident, or a High or Critical finding in an area this model rated Low.

At each review: re-rate every row, move finished gaps into "existing controls", add new rows,
update the top-risk list, and set "Last reviewed". Accepted risks go in the risk register with
an expiry date ([docs/compliance/README.md](../compliance/README.md)).
