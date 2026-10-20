# Fishtape API

Everything under `/api/`. The machine-readable version is `GET /api/v1/openapi.json`
(OpenAPI 3.1, generated from the route schemas). Server code: `server/src/routes/`.

## Conventions

- **JSON in, JSON out.** Send `Content-Type: application/json`.
- **Errors** are always `{ "error": { "code", "message", "requestId", "details"? } }`.
  `code` is stable and machine-readable; `message` is a sentence safe to show a user.
  Validation errors list `details.errors[{ path, message }]`: field paths and rules, never the
  submitted values. Server errors (`500 internal`) carry no SQL, stack or data; only
  `APP_ENV=local` adds `details.debug`.
- **Request ids.** Every response has `X-Request-Id`. Send your own (8-64 chars of
  `A-Za-z0-9._-`) to correlate client and server logs; it is also stored in audit events.
- **Caching.** Every `/api` response is `Cache-Control: no-store`.
- **Headers carry no customer data.** Responses set only standard headers, CORS headers, the
  request id and, on sign-in, the session cookie. No `X-Powered-By`.
- **Query strings carry ids and codes only** (they end up in proxy access logs). The only query
  parameters anywhere are: `limit`, `cursor`, `includeDeleted`, `version`, `since`, `link`,
  the audit filters `collection`, `recordId`, `action`, and the record filters listed below
  (`clientId`, `jobId`, `status`, `stage`, `number`, `employeeId`, …), which are record ids,
  document numbers or status codes. Names, emails and phone numbers always go in request
  bodies. `test/leaks.test.js` fails if a new query parameter appears that is not on this list.
- **Money** is integer cents (CAD). **Lengths** are metres. **Dates** are `YYYY-MM-DD`,
  timestamps are ISO 8601.

| status | codes you will see |
| --- | --- |
| 400 | `validation_failed`, `bad_request`, `bad_json`, `bad_mutation`, `weak_password`, `weak_pin`, `invalid_code`, `invalid_token` |
| 401 | `unauthenticated`, `session_expired`, `session_revoked`, `invalid_credentials`, `invalid_api_key`, `invalid_device`, `invalid_pin` |
| 403 | `forbidden`, `csrf_failed`, `mfa_required` (`details.mfa = "verify"`), `mfa_enrolment_required` (`details.mfa = "enrol"`), `no_tenant`, `tenant_inactive`, `membership_inactive`, `signup_closed` |
| 404 | `not_found` (also for other tenants' ids: existence is never confirmed) |
| 405 | `method_not_allowed` (writes to `auditLog`) |
| 409 | `conflict`, `version_conflict` (`details.version`), `email_in_use`, `mfa_not_enrolled` |
| 413 | `too_large` |
| 423 | `account_locked`, `pin_locked`, `device_locked` |
| 429 | `rate_limited` |
| 500 / 503 | `internal`, `unavailable` |

## Authentication

Three kinds of credentials (details in [adr-003](adr-003-auth-sessions.md)):

| credential | how it is sent | who |
| --- | --- | --- |
| Session (web) | httpOnly, Secure, SameSite=Lax cookie `ft_session` | the PWA in a browser |
| Session (bearer) | `Authorization: Bearer fts_…` (sign in with `"mode": "bearer"`) | the iOS app (`capacitor://localhost`) |
| API key | `Authorization: Bearer ft_live_…` (production) / `ft_test_…` (elsewhere) | integrations, agents |
| Device token | `X-Fishtape-Device: ftd_…`, the `ft_device` cookie, or Bearer | a registered shared iPad (crew sign-in only) |

**CSRF.** Any `POST`/`PUT`/`PATCH`/`DELETE` without an `Authorization` header (that is, any
cookie request, including sign-in) must send `X-Fishtape: 1`, and if the browser sends an
`Origin` it must be `PUBLIC_ORIGIN`, a `CORS_ORIGINS` entry or `capacitor://localhost`.
Otherwise `403 csrf_failed`.

**MFA.** Owners, admins (in any company) and HQ staff must have TOTP. Until they enrol, every
data route answers `403 mfa_enrolment_required`. Anyone with TOTP enrolled gets
`403 mfa_required` on a new session until it is verified. Crew PIN sessions and API keys are
exempt (see adr-003).

**Rate limits** (per minute, in memory per process): auth routes 10 per IP per route,
password reset requests 5, everything else 600 per IP or per bearer credential, API keys 300.
Over the limit: `429 rate_limited`.

## Auth endpoints

| method and path | auth | body / notes |
| --- | --- | --- |
| `GET /api/v1/auth/providers` | public | `{ password, google, microsoft, signupOpen }` |
| `POST /api/v1/auth/signup` | public, only while the `signup_open` flag is on | `{ email, password, name, companyName, province?, mode? }` → 201 `{ mfa: "enrol", me, tenant, token? }` |
| `POST /api/v1/auth/login` | public | `{ email, password, tenantId?, mode? }` → `{ mfa: null\|"verify"\|"enrol", expiresAt, me, token? }`. `token` only with `mode: "bearer"`; otherwise the cookie is set. |
| `POST /api/v1/auth/logout` | session | 204, cookie cleared |
| `GET /api/v1/me` | session (even before MFA) | `{ user, session: { kind, expiresAt, mfa, mfaEnrolled }, tenant: { id, name, role, employeeId, perms } \| null, memberships[] }` |
| `POST /api/v1/auth/switch-tenant` | user | `{ tenantId }` → same shape as `/me` |
| `POST /api/v1/tenants` | user, only while `signup_open` | `{ name, province? }` → 201; you become its owner and it becomes your active company |
| `POST /api/v1/auth/mfa/totp/enrol` | session | → `{ secret, otpauthUri }` (shown once; render the URI as a QR code) |
| `POST /api/v1/auth/mfa/totp/confirm` | session | `{ code }` → `{ recoveryCodes[10] }` (shown once); the session counts as verified |
| `POST /api/v1/auth/mfa/verify` | session | `{ code }` or `{ recoveryCode }` → `{ ok, recoveryCodesLeft? }`. 5 wrong codes end the session. |
| `POST /api/v1/auth/mfa/recovery-codes` | user | → new `{ recoveryCodes }` |
| `POST /api/v1/auth/password/change` | user | `{ currentPassword, newPassword }`; signs out your other sessions |
| `POST /api/v1/auth/password/forgot` | public | `{ email }` → always 202; emails a 1-hour link to `PUBLIC_ORIGIN/#/reset-password?token=…` (the token is in the URL fragment, which browsers never send to servers) |
| `POST /api/v1/auth/password/reset` | public | `{ token, newPassword }`; also accepts invite tokens (7 days); signs out every session |
| `GET /api/v1/auth/oidc/{google\|microsoft}/start` | public (`?link=1` while signed in links the account) | 302 to the provider |
| `GET /api/v1/auth/oidc/{provider}/callback` | public | 302 to `PUBLIC_ORIGIN/#/` (or `#/sign-in?mfa=verify`, or `#/sign-in?error=<code>`) |

Passwords: 12–256 characters, not the email, not one repeated character. Login failures:
5 in a row lock the account for 15 minutes (`423 account_locked`); unknown emails and wrong
passwords get the same answer and take the same time.

## Self-serve sign-up

The form is `site/signup.html`; the flow and the Stripe facts it relies on are in
`server/src/services/signup.js`.

| method and path | auth | body / notes |
| --- | --- | --- |
| `GET /api/v1/public/signup` | public | `{ open, trialDays, depositCents, currency, plans, maxUsers, termsVersion }` |
| `POST /api/v1/public/signup` | public; 10 per IP and 100 overall per hour (`SIGNUP_RATE_LIMIT_*`, always on) | `{ companyName, province, name, email, password, plan, users, acceptTerms: true, website? }` → 201 `{ url }` (Stripe Checkout: plan + extra users, `TRIAL_DAYS` trial, $1.00 CAD deposit charged now). `website` is a honeypot (looks accepted, nothing stored). 409 `email_in_use`, 409 `signup_pending`, 400 `weak_password`, 503 `signup_unavailable`. A second try with the same email replaces the open one. |
| `POST /api/v1/public/signup/welcome` | public (auth rate limit) | `{ token, mode? }` from the welcome email's `#/welcome?token=` link, once, 7 days → `{ mfa, expiresAt, token? }`; verifies the email and starts a session (owners then set up TOTP) |
| `GET /api/hq/signups` | HQ staff | `?status=` one of pending, completed, expired, abandoned, failed → `{ data[], byStatus, stripeConfigured }` |

The signed `POST /api/v1/webhooks/platform-stripe` handles `checkout.session.completed`,
`.async_payment_succeeded`, `.expired` and `.async_payment_failed` for sessions whose metadata
carries `fishtape_signup_id`: company + owner + trialing subscription, welcome email, then a
−$1.00 CAD customer balance credit so the deposit comes off the first invoice. Idempotent per
event id and per session. Codes added: `signup_pending` (409), `signup_unavailable` (503).

## Company administration

| method and path | auth | notes |
| --- | --- | --- |
| `GET /api/v1/members` | manager | members with role, status, `employeeId`, `hasPin` |
| `POST /api/v1/members` | admin | `{ name, role, email?, employeeId? }`. With an email: invite email, status `invited` until the password is set. Without: a PIN-only crew member. Only owners add owners. |
| `PATCH /api/v1/members/{id}` | admin | `{ role?, employeeId?, status? }`. Only owners change owners; the last active owner cannot be removed or demoted. Disabling signs them out. |
| `PUT /api/v1/members/{id}/pin` | managers for anyone, members for themselves | `{ pin }` (4–8 digits, not all the same) |
| `DELETE /api/v1/members/{id}` | admin | removes the membership, signs them out of this company |
| `POST /api/v1/devices` | manager | `{ name }` → 201 `{ device, deviceToken }` (shown once; also set as the `ft_device` cookie for browsers) |
| `GET /api/v1/devices` | manager | |
| `DELETE /api/v1/devices/{id}` | manager | revokes the device and every crew session on it |
| `GET /api/v1/devices/crew` | device | `{ company, crew: [{ membershipId, name, role }] }`: members with a PIN |
| `POST /api/v1/devices/crew/sign-in` | device | `{ membershipId, pin, mode? }` → crew session (12 h, 2 h idle). 5 wrong PINs lock that member 15 min; 20 on a device lock the device. |
| `GET /api/v1/api-keys` | admin | never returns the key |
| `POST /api/v1/api-keys` | admin | `{ name, scopes[], expiresAt? }` → 201 `{ apiKey, key }` (key shown once) |
| `DELETE /api/v1/api-keys/{id}` | admin | revoke |
| `GET /api/v1/secrets` | admin | names and dates only |
| `PUT /api/v1/secrets/{name}` | admin | `{ value }`; envelope-encrypted; never readable over the API |
| `DELETE /api/v1/secrets/{name}` | admin | |

`manager` = owner, admin, office or foreman (a full session, not a crew PIN session, not an
API key). `admin` = owner or admin.

**API key scopes:** `<collection>:read`, `<collection>:write` (implies read), `*:read`,
`*:write`, for any collection below. A key acts for its company only and never reaches the
auth, member, key, device or secret endpoints.

## Records: `/api/v1/{collection}`

Collections (same names as `electrical-app/js/store.js`): `clients, leads, sequences,
enrolments, outbox, jobs, schedule, estimates, invoices, payments, items, locations,
stockMoves, employees, timeEntries, drawings, sops, permits, inspections, certifications,
checklists, panels, settings, wireRuns, bends, benderProfiles`, plus read-only `auditLog`.

| method and path | notes |
| --- | --- |
| `GET /api/v1/{c}` | `{ data[], cursor, more }`, newest first. `limit` (1–500, default 50), `cursor` (opaque, from the last page), `includeDeleted=true` (tombstones come back as `{ id, version, deleted: true }`), and the collection's filters. |
| `GET /api/v1/{c}/{id}` | the record, or 404 |
| `POST /api/v1/{c}` | create; `id` optional (UUID generated). 409 if the id exists in your company. |
| `PATCH /api/v1/{c}/{id}` | shallow merge, like `store.update`. `If-Match: <version>` (or `?version=`) → 409 `version_conflict` if it changed. |
| `DELETE /api/v1/{c}/{id}` | soft delete → `{ id, version, deleted: true }`; syncs as a tombstone. `If-Match` supported. |

A record is the body the PWA stores plus `version`: `{ id, createdAt, updatedAt, version, ...fields }`.
Bodies are validated against `electrical-app/js/schema/<collection>.json` (known fields typed,
extra fields kept). `updatedAt` is set to now unless you send one; a client time more than
5 minutes in the future is clamped.

Filters per collection (all exact match on the record field):

| collection | filters |
| --- | --- |
| clients, sequences, locations, employees, sops, settings, benderProfiles | none |
| leads | `clientId`, `stage` |
| enrolments | `leadId`, `sequenceId`, `status` |
| outbox | `status`, `relatedId` |
| jobs | `clientId`, `status`, `number` |
| schedule | `jobId`, `employeeId`, `date` |
| estimates, invoices | `clientId`, `jobId`, `status`, `number` |
| payments | `invoiceId` |
| items | `sku` |
| stockMoves | `jobId`, `itemId` |
| timeEntries | `employeeId`, `jobId` |
| drawings, checklists, panels, bends | `jobId` |
| permits | `jobId`, `status`, `number` |
| inspections | `jobId`, `permitId`, `result` |
| certifications | `employeeId` |
| wireRuns | `jobId`, `drawingId` |
| auditLog | `collection`, `recordId`, `action` |

### Who can read and write what

Server-side, per collection, with the same roles and permission keys as
`electrical-app/js/auth.js`. A role may read a collection when it has any of the listed keys.
Examples: `invoices` and `payments` need `invoices` (or `estimates`/`clients` to read invoices);
`jobs` are readable by everyone with `jobs` but writable only by managers; `settings` are
readable by every member. The full table is `server/src/collections.js`. Extra rules:

- **Time entries:** non-managers see and write only entries whose `employeeId` is their own
  (`memberships.employee_id`), and cannot change `approved` (needs `time-approve`).
- **SOPs:** non-managers may only append their own acknowledgement to `acks`.
- **Settings:** without the `settings` permission, only `nextNumbers` may change (document
  numbering when creating jobs, estimates and invoices).
- **Employees:** `pin` is never stored (crew PINs go through `/members/{id}/pin`, hashed);
  `rateCents` is hidden from members without the `employees` permission.
- **Crew sessions** (PIN on a shared device) act with their role capped at `foreman`.

## Sync: `/api/v1/sync/*`

Protocol and conflict rules: [adr-002](adr-002-sync-protocol.md).

```
POST /api/v1/sync/push
{ "mutations": [ { "mid", "collection", "id", "op": "upsert"|"delete", "baseVersion", "data" } ] }   (max 500)
→ { "results": [ { "mid", "status": "ok", "version", "changeSeq" }
               | { "mid", "status": "conflict", "server": { "id", "version", "deleted", "data" } }
               | { "mid", "status": "rejected", "error": { "code", "message", "details"? } } ] }

GET /api/v1/sync/pull?since=<changeSeq>&limit=500        (limit 1–1000)
→ { "changes": [ { "collection", "id", "version", "deleted", "data" } ], "cursor", "more" }
```

`cursor` is a string; pass it back as `since`. Start with `since=0`. Keep pulling while
`more` is true. Pages also stop at about 8 MB of record data, so a page with big drawings may
hold fewer than `limit` changes.

## Health

| path | auth | answer |
| --- | --- | --- |
| `GET /api/healthz` | public | `{ status: "ok" }` while the process runs |
| `GET /api/readyz` | public | 200 `{ status: "ready", checks }` or 503 `not_ready`. Checks: database ping, migrations current, queue lag under `READY_MAX_QUEUE_LAG_S`. |
| `GET /api/v1/status` | public | `{ status: "ok"\|"degraded", version, environment, gitSha (12 chars), time }` |
| `GET /api/hq/health` | HQ staff | DB latency, pool, migration state, queue depth/failures/lag, 5xx counts by route, memory, uptime, git SHA, last backup (`BACKUP_STATUS_FILE`), cert expiry (`TLS_CERT_FILE`), disk |
| `GET /api/hq/tenants` | HQ staff | companies with member counts |
| `GET /api/hq/tenants/{id}/audit/verify` | HQ staff | checks that company's audit hash chain; writes an `hq.audit_verify` event into it |

None of the public endpoints say anything about tenants or users.

## QuickBooks Online

The full contract (every request and response shape, the rules behind them) is
[docs/integrations/quickbooks.md](../integrations/quickbooks.md) section 7. In short:

- Every `/api/v1/qbo/*` route is for office roles only (owner, admin, office sessions): field roles,
  crew sessions and API keys get 403 `forbidden`. Connect, disconnect and takeover are owner/admin.
  Every route that changes anything needs a two-step-verified session (403 `mfa_required`),
  whatever the role. Plan feature `quickbooks` (Pro) except status and disconnect. Practice mode and
  Go live (`option.writeMode` in `PUT /api/v1/qbo/mappings`) are owner/admin.
- Responses never carry tokens, the realm id or Intuit request URLs. Look-up searches are POST bodies,
  so customer names never sit in a URL.
- Extra codes: 409 `qbo_not_connected`, `qbo_reconnect_needed`, `qbo_not_ready`, `qbo_paused`
  (`details.pauseReason`; sync is off, so actions that call Intuit wait), `qbo_busy`, `qbo_pause_locked`,
  `qbo_brake_count` (`details.count`), `qbo_reconnect_not_allowed`, `qbo_already_linked`,
  `qbo_option_locked`, `qbo_conflict_closed`, `qbo_not_unlinked`, `setup_incomplete`; 429
  `qbo_throttled` (`details.retryAfterS`), `lookup_budget`, `qbo_budget`; 502 / 503 `qbo_unavailable`.
- `POST …/records/{collection}/{id}/sync` and `POST /api/v1/qbo/reference/refresh` answer 202 with
  JSON (`{ queued: true, state }` and `{ queued: true }`); a `merged` conflict lists both Fishtape
  records in `recordIds`.

| group | routes |
| --- | --- |
| Connection | `GET /api/v1/qbo/status`, `POST /api/v1/qbo/connect`, `GET`/`POST /api/v1/qbo/oauth/start`, `GET /api/v1/qbo/oauth/callback` (302 only), `GET /api/v1/qbo/oauth/done`, `GET /api/v1/qbo/launch`, `GET /api/v1/qbo/disconnected`, `POST /api/v1/qbo/connect/takeover`, `POST /api/v1/qbo/disconnect`, `POST /api/v1/qbo/pause` |
| Webhook | `POST /api/v1/webhooks/qbo` (Intuit-signed; 401 `invalid_signature`) |
| Setup wizard | `POST /api/v1/qbo/setup/scan`, `GET`/`PUT /api/v1/qbo/setup/matches`, `GET /api/v1/qbo/setup/plan`, `POST /api/v1/qbo/setup/apply`, `POST /api/v1/qbo/setup/cancel` |
| Sync and records | `POST /api/v1/qbo/sync`, `GET /api/v1/qbo/records/status`, `GET /api/v1/qbo/records/{collection}/{id}`, `POST …/sync`, `POST …/renumber`, `PUT`/`DELETE …/link`, `GET /api/v1/qbo/checks`, `GET /api/v1/qbo/log` |
| Mappings | `GET`/`PUT /api/v1/qbo/mappings`, `POST /api/v1/qbo/reference/refresh` |
| Conflicts | `GET /api/v1/qbo/conflicts`, `GET /api/v1/qbo/conflicts/{id}`, `POST /api/v1/qbo/conflicts/{id}/resolve` |
| Look-up | `POST /api/v1/qbo/lookup/{customers\|invoices\|estimates}`, `GET /api/v1/qbo/lookup/{entity}/{qboId}`, `POST …/import` |

HQ (HQ staff unless noted; counts and states only, never the company's QuickBooks data):

| method and path | notes |
| --- | --- |
| `GET /api/hq/tenants/{id}` | gains `quickbooks`: `{ connected, state, pauseReason, reconnectReason, environment, edition, connectedAt, lastPullAt, lastPushAt, lastWebhookAt, refreshExpiresAt, hardExpiresAt, links: { synced, pending, error, blocked, conflict, needs_review }, errors24h, conflictsOpen, inboxBacklog, outboxWaiting, outboxOldestAt, pausedSince, lastCheckAt, usageThisMonth: { core, coreplus, budget }, recentErrors: [{ at, direction, action, collection, errorCode, intuitTid }] }`, `{ connected: false, state: "not_connected" }`, or `null` on a server without the QuickBooks tables |
| `POST /api/hq/tenants/{id}/quickbooks/pause` | `{ paused, reason }` (reason at least 5 characters); audited `hq.qbo.pause` in the company's log; answers the `quickbooks` block. Only HQ resumes an HQ pause (409 otherwise); 404 when the company has no connection |
| `POST /api/hq/tenants/{id}/quickbooks/release` | HQ admin; `{ reason }`; disconnects the company and frees its QuickBooks company; audited `hq.qbo.release`; the worker then revokes and deletes the tokens |
| `POST /api/hq/tenants/{id}/delete` | also queues `qbo_token_housekeeping` for the company at once, so its QuickBooks grant is revoked long before the purge |
| `GET /api/hq/developer/quickbooks` | `{ enabled, environment, writesEnabled, month, budget, tenantBudget, trialBudget, intuitCap, production: { core, coreplus, pct }, sandbox: { core, coreplus }, states: { <state or paused:reason>: n }, top: [20 × { tenantId, tenantName, environment, coreplus, core, throttled, errors }], events24h: [{ kind, count, lastAt }], revokePending }` |

Stripe (the company's own webhook, `POST /api/v1/webhooks/stripe/{tenantId}`) also takes
`payout.paid`, `payout.failed`, `payout.canceled` and `payout.updated`: the payout is stored in
`stripe_payouts`, the worker reads its balance transactions (`stripe_payout_fetch`) and queues it for
QuickBooks. After every Stripe payment the worker reads its fee (`stripe_fee_fetch`) into the
payment's `stripe.chargeId`, `stripe.balanceTransactionId`, `stripe.feeCents` and `stripe.netCents`.
The amount the pay link charges and the invoice status both follow the amount due (total − payments,
plus the QuickBooks tax adjustment when one applies).

## Public service status

The status page (status.fishtapehq.com, `site/status.html`) reads these. They are part of the
status site, not the developer API, so they are left out of `openapi.json`. Routes:
`server/src/routes/hq-status.js`; rules: `server/src/services/status-page.js`; operations:
[docs/runbooks/status-page.md](../runbooks/status-page.md).

| path | auth | answer |
| --- | --- | --- |
| `GET /api/v1/public/status` | public; `Cache-Control: public, max-age=30`, ETag (304) | `{ generatedAt, overall: operational\|degraded\|outage\|maintenance\|unknown, components: [{ id, name, status, checkedAt }], uptime: { days: 90, from, to, byComponent: { <id>: [90 × { date, pct, checks, outages, degraded }] }, pct: { <id> } }, notices: { active, upcoming, recent }, subscribe: { enabled } }`. Component ids: `app`, `api`, `hq`, `signin`, `email`, `payments`. A component not checked in the last 20 minutes is `unknown`. Notices are published ones only: `{ id, kind, title, impact, status, components, startsAt, endsAt, resolvedAt, createdAt, updatedAt, updates: [{ status, body, at }] }` (newest update first). |
| `POST /api/v1/public/status/subscribe` | public; `X-Fishtape: 1`; 5 per IP per hour | `{ email, website? }` → always 202 (`website` is a honeypot). 404 `subscriptions_off` until HQ turns subscriptions on. Emails a confirm link `STATUS_PUBLIC_URL#confirm=<token>` (7 days). |
| `POST /api/v1/public/status/confirm` | public; `X-Fishtape: 1` | `{ token }` → 200 `{ ok: true }` or 400 `invalid_token` |
| `POST /api/v1/public/status/unsubscribe` | public; `X-Fishtape: 1` | `{ token }` from a notice email's `#unsubscribe=` link → always 200 |
| `GET /api/hq/status-notices` | HQ staff | every notice (drafts too) with its timeline, the components now, 90-day uptime per component, subscriber counts, `settings.subscribeEnabled` |
| `POST /api/hq/status-notices` | HQ admin; audited | `{ kind, title, impact?, components?, status?, published?, startsAt?, endsAt?, update?, notify? }` → 201 |
| `PATCH /api/hq/status-notices/{id}` | HQ admin; audited | any of `title, impact, components, status, published, startsAt, endsAt, notify` (resolved / completed sets `resolvedAt`; `notify` emails subscribers when this publishes it) |
| `POST /api/hq/status-notices/{id}/updates` | HQ admin; audited | `{ status, body, notify? }` → 201; adds a timeline entry and sets the notice status |
| `DELETE /api/hq/status-notices/{id}` | HQ admin; audited | 204 |
| `PUT /api/hq/status-settings` | HQ admin; audited | `{ subscribeEnabled }` (off by default) |

`POST /api/v1/public/enterprise-leads` also takes an optional `service`
(`setup-integrations`, `data-import`, `price-book`, `crew-training`, `plan-templates`, `enterprise`,
`contact`): the lead is stored with source `svc-<service>` instead of `pricing`.
