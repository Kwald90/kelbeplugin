# QuickBooks Online two-way sync: the contract

Status: contract, revision 2, 2026-10-20. Nothing here is built yet. Implementers in parallel worktrees
build from this file alone. If the code needs to differ from it, change this file first (in the owning
workstream's branch) and say so in the merge report. Revision 2 folds in an accounting/data-integrity
review and a security/operations review; findings that were not taken are listed with reasons in
section 14.

Words used here:

- **QBO** means QuickBooks Online. It appears in code, table names and this file only. Screens, emails,
  guides and notifications always say "QuickBooks" or "QuickBooks Online", and "Intuit" in full (Intuit's
  branding rules ban "QB" and "QBO" in anything a user sees).
- **Realm** is one QuickBooks company (Intuit's `realmId`).
- **Tenant** is one Fishtape company. TG Electrical (Manitoba) is the first.
- **Office roles** are `owner`, `admin` and `office`. **Field roles** are `foreman`, `electrician` and
  `apprentice`. Crew (PIN) sessions count as field roles whatever the member's role is.
- **Link** is one row of `qbo_links`: a Fishtape record paired with a QBO object.
- **Snapshot** is the canonical form of a linked pair as it was when both sides last agreed. It is the
  base of the three-way merge.
- **Core** calls are QBO writes (free). **CorePlus** calls are QBO reads, queries and CDC (metered, see
  section 1.4).

Sources: the Intuit research of 2026-10-20 (rendered copies in the session scratchpad `qbo/` folder) and
the Fishtape code as of commit `6ce2a95`. Every Intuit fact not confirmed on a primary page is marked
**VERIFY** and collected in section 11.4.

---

## 1. Scope, non-goals and what Kelvin does outside the code

### 1.1 In scope (first release)

Everything below ships together, behind the plan feature `quickbooks` (Pro and up).

| Area | What it does |
| --- | --- |
| Connection | Each tenant connects its own QuickBooks Online company over OAuth 2.0. One realm per tenant, one tenant per realm. Canada (`Country = CA`, home currency CAD) only. |
| Customers | Fishtape `clients` and QBO `Customer`, two-way. Jobs become QBO sub-customers (push only) for job costing. |
| Products and services | Fishtape `items` and QBO `Item` (Service, NonInventory, Inventory), two-way. |
| Estimates and invoices | Two-way create, update, void/delete and look-up, with per-line tax codes, markup, the estimate-to-invoice link and T&M invoices. |
| Payments | Two-way. A QBO payment applied to several invoices becomes several Fishtape payments. Stripe payments go to QBO with their fees, and Stripe payouts become transfers. Invoices settled in QBO by credit memos or journals show as settled in Fishtape. |
| Time | Approved Fishtape time entries become QBO `TimeActivity` records (push only), for payroll and job costing. |
| Purchasing (new in Fishtape) | New collections `vendors`, `bills` (supplier bills and paid receipts) and `purchaseOrders`. Vendors two-way; bills and receipts two-way for those tagged to a job; purchase orders push only. |
| Look-up | Live search of QBO customers, invoices and estimates from Fishtape, with "import into Fishtape". |
| First connect | A matching wizard so nothing duplicates, then a bulk sync with progress. |
| Operations | Sync log, conflicts screen, per-record badges, reconnect warnings, a daily "doesn't match" balance check, shadow mode for a first week, HQ health with counts only, HQ alerts, HQ pause and release, a platform write switch. |

### 1.2 Non-goals (not in this release)

- QuickBooks Desktop, QuickBooks Online outside Canada, and companies whose home currency is not CAD.
- Creating QBO Projects (the premium GraphQL Projects API needs the Silver partner tier). Existing QBO
  projects can be **linked** to Fishtape jobs (section 4.3).
- Custom Fields, the Sales Tax API, the Workforce/Payroll API (`PayrollItemRef`), overtime pay types.
- Progress invoicing, more than one invoice linked to the same estimate, Group/bundle items, QBO
  inventory quantities (Fishtape keeps stock; items push as NonInventory).
- Creating credit memos, refund receipts and Stripe refunds (BACKLOG already lists Stripe refunds; until
  then a refund is entered by hand in QuickBooks). Fishtape never creates a credit memo. When a credit
  memo or journal entry settles a linked invoice in QBO, Fishtape shows it as a pull-only settlement
  payment (4.9). Payment lines that Fishtape does not own (credit memos, journals, unlinked invoices,
  unapplied amounts) are never changed or removed by a push (4.9).
- Customer payments with no invoice (retainers taken before any invoice exists). They are not pushed;
  the badge says "Not sent: no invoice" and the bookkeeper enters them in QBO.
- Stripe charges made before the Stripe cutover date (4.9) and payouts that contain them. They are
  already in the books another way.
- Bill payments made from Fishtape. Fishtape only reads whether a bill is paid.
- Journal entries, transfers other than Stripe payouts, deposits other than the deposit inside an
  invoice, sales receipts.
- QBO's own email sending. Fishtape keeps emailing estimates and invoices.
- Multi-currency transactions. With multicurrency on in QBO, only CAD customers and vendors sync.
- An Intuit App Store listing (the app stays private and unlisted).
- Sending any `qbo_*` table content or look-up result to the AI assistant, MCP or API keys. Ordinary
  Fishtape records that sync with QuickBooks (clients, invoices, bills, payments) are still records the
  assistant can read; that is disclosed to Intuit and to tenants (10.1, open question 13.11).
- The client portal. No portal route serves records yet (only RLS exists). Before a portal ships it
  must hide documents in `needs_review` and documents created by the QBO pull until an office user
  releases them (BACKLOG item, W6).

Starter keeps the CSV export at `#/import/export` (`electrical-app/js/lib/qbo-export.js`) unchanged.

### 1.3 Checklist for Kelvin (outside the code)

Do these in order. Steps 1 to 6 unblock development and staging; steps 7 to 13 are needed before real
companies other than a test one connect.

1. **Intuit developer account.** Sign up at https://developer.intuit.com with a Fishtape business email
   (not a personal Gmail). Fill in the account profile (business name, address, phone).
2. **Create the app.** In the developer portal: Dashboard > Create an app > QuickBooks Online and
   Payments. Name it **Fishtape** (no "Quick", "QB", "Intuit" or "tuit" in the name). Scope:
   `com.intuit.quickbooks.accounting` only (not Payments, not OpenID).
3. **Create a Canadian sandbox company.** Dashboard > Sandbox > Add a sandbox: country **Canada**,
   QuickBooks Online **Plus** (purchase orders and classes need Plus). Add a second one later for
   Essentials testing.
4. **Development settings** (Keys & credentials > Development):
   - Redirect URI: `https://tgelectrical.truecollarbuilt.com/api/v1/qbo/oauth/callback`
     (exact, no trailing slash, no query string).
   - Webhooks > Development: endpoint `https://tgelectrical.truecollarbuilt.com/api/v1/webhooks/qbo`.
     Tick these entities: Customer, Vendor, Employee, Item, Account, Class, Department, Term,
     PaymentMethod, Estimate, Invoice, Payment, Deposit, Bill, BillPayment, Purchase, PurchaseOrder,
     TimeActivity, Transfer, Preferences. Choose the CloudEvents payload if a format toggle is shown.
   - Copy the **verifier token** shown after saving the webhook.
5. **Put the development keys on staging** (each command asks for the value hidden; run them after the
   W1 workstream has merged, because `set-env.sh` only accepts names listed in `.env.example`):

       ssh -t -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 "sudo /var/www/tgelectrical/current/deploy/set-env.sh staging QBO_ENVIRONMENT"     # type: sandbox
       ssh -t -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 "sudo /var/www/tgelectrical/current/deploy/set-env.sh staging QBO_CLIENT_ID"
       ssh -t -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 "sudo /var/www/tgelectrical/current/deploy/set-env.sh staging QBO_CLIENT_SECRET"
       ssh -t -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 "sudo /var/www/tgelectrical/current/deploy/set-env.sh staging QBO_WEBHOOK_VERIFIER"

   Never paste these values into a chat, an email or the repo.
6. **TG Electrical's own QuickBooks** (in QuickBooks, as a QuickBooks admin): check the plan (Plus is
   needed for purchase orders; Essentials covers the rest); turn on Settings > Account and settings >
   Sales > **Custom transaction numbers**; confirm sales tax is set up with an active **GST/PST MB** code
   at 5% + 7% (an old 8% PST rate may still exist; it must not be the one used); write down whether the
   company uses QuickBooks Projects, QuickBooks Payroll, and QuickBooks Time (Workforce) for hours; write
   down the date of the last GST return filed and the last pay period run. Answer the open questions in
   section 13.
7. **Accountant decisions** (TG's bookkeeper or accountant). Defaults are set; the accountant confirms
   or changes them:
   - Manitoba RST (and any PST) paid on supplier bills is **not recoverable**: Fishtape posts it into the
     cost of each line and uses a GST-only purchase code (4.8). The accountant confirms.
   - The tax code for Stripe fees (default: no tax, until the accountant says Stripe's fees carry GST
     that can be claimed).
   - The QBO codes for each "no tax" reason: zero-rated, exempt, out of scope, Indian Act relief (4.8).
   - Which income and expense accounts new items use, and the job-cost expense account for bill lines
     without an item.
   - The "Stripe clearing" bank account (create it in QBO as a Bank account named "Stripe") and the
     **Stripe cutover date**: the first day whose Stripe charges Fishtape books (default `syncFrom`).
     Payouts holding any earlier charge stay with the bookkeeper (4.9).
   - Whether payroll hours come from Fishtape or from QuickBooks Time (never both), and the pay-period
     lock rule (option `timeLockedThrough`, 4.11).
8. **Legal pages.** Intuit requires a EULA URL and a privacy policy URL. `site/terms.html` and
   `site/privacy.html` are drafts; they need a lawyer's final text that names Intuit/QuickBooks as a
   service the customer connects, says whether Fishtape's assistant reads records that sync with
   QuickBooks (open question 13.11), carries the line "QuickBooks and Intuit are trademarks of Intuit
   Inc.", and has a public URL on the confirmed marketing domain.
9. **Production app details** (Keys & credentials > Production, then the app's settings pages):
   - Contact email, EULA URL, privacy policy URL, host domain `app.fishtapehq.com`.
   - Launch URL: `https://app.fishtapehq.com/api/v1/qbo/launch`
   - Connect/reconnect URL: `https://app.fishtapehq.com/api/v1/qbo/launch?connect=1`
   - Disconnect URL: `https://app.fishtapehq.com/api/v1/qbo/disconnected`
   - Redirect URIs (Production allows several): `https://app.fishtapehq.com/api/v1/qbo/oauth/callback`
     and, while TG Electrical works on staging, `https://tgelectrical.truecollarbuilt.com/api/v1/qbo/oauth/callback`.
   - Webhook (Production): `https://app.fishtapehq.com/api/v1/webhooks/qbo` with the same entities as
     step 4 (see open question 13.2 about staging before production exists). Copy the production verifier.
   - Categories (up to 4): Field service / Construction / Invoicing / Time tracking (pick what the
     form offers).
   - Regulated industries: tick payments / money movement only if Intuit's wording covers it, and name
     **Stripe** as the payment platform Fishtape uses for invoice payments (Fishtape never moves money
     through Intuit). **VERIFY** with Intuit support which box applies.
   - Hosting region: answer with where the data really lives. Staging (208.113.210.97) is probably a
     DreamHost server in the US (**VERIFY** with DreamHost before answering). Do not answer "Canada"
     unless the server that will hold real QuickBooks data is in Canada, and do not put production
     Intuit keys on a server whose region differs from the answer. Record the host's region in
     `docs/compliance/vendor-management.md`. Accepted Connections: **Canada** only.
10. **App Assessment Questionnaire.** Complete it; production keys appear only after Intuit approves it.
    Answers that the code supports: tokens and realm IDs encrypted with AES-256-GCM, key held outside
    the database (`SECRETS_MASTER_KEY`); callback answers with a 302; cookies Secure and HttpOnly; data
    used only to run the sync; deletion on disconnect (section 10.4); support at the support address;
    every user who can change QuickBooks data through Fishtape signs in with two-step verification
    (7.1); AI use as decided in open question 13.11. Intuit may ask for a vulnerability scan within 2
    weeks and an annual security review: put both in the compliance calendar.
11. **Production keys on the production server** (once it exists), same `set-env.sh` commands with
    `production` and `QBO_ENVIRONMENT=production`. Moving TG from staging to production follows the
    cutover runbook (`docs/runbooks/quickbooks-support.md`, "Moving a server"): writes off on staging
    first, never two servers holding live tokens for the same company.
12. **First week for TG.** Run TG in shadow mode (option `writeMode: 'shadow'`, 5.8) for a week: the
    sync computes and logs every change but writes nothing. Kelvin and the bookkeeper read the "would
    change" log, then switch to live.
13. **Partner programme.** Every app starts on the free **Builder** tier: unlimited writes, **500,000
    CorePlus reads a month for the whole Fishtape workspace**, hard-blocked (HTTP 429) above that, no
    bill. Fishtape's design uses about 1,500 to 3,000 reads per tenant per month (section 5.11), so
    Builder covers roughly 150 to 300 tenants. HQ shows the month's total; at 70% Kelvin decides whether
    to buy **Silver** (Intuit's Canadian example: CA$425/month for 1M reads, CA$4.85 per 1,000 over;
    **VERIFY** the current Canadian prices on the Partner FAQ before buying). Sandbox calls are free and
    are counted separately (they never count toward `QBO_READ_BUDGET`). Calls to production free-trial
    QuickBooks companies count. The 500,000 belongs to the Intuit app, not to a server: two servers
    using the same production keys share it.

### 1.4 Costs in one place

| Item | Cost |
| --- | --- |
| Intuit developer account, app, sandbox | Free |
| Writes (create, update, delete, void, upload) | Free (Core) |
| Reads, queries, CDC, company info, preferences | Builder: free up to 500,000/month for the workspace, then blocked until the 1st |
| Silver tier (only if needed) | about CA$425/month (VERIFY) |
| Stripe API calls for fees and payouts | Free (tenant's own Stripe account) |

---

## 2. Connection lifecycle

### 2.1 Configuration (platform, env vars)

Intuit's client id, client secret and webhook verifier are **platform** credentials (BUILD-PLAN
convention): they live in env vars, never in `tenant_secrets`.

| Env var | Required | Meaning |
| --- | --- | --- |
| `QBO_ENVIRONMENT` | yes to enable | `sandbox` or `production`. Unset or empty: the integration is off (status says "Not available on this server"). |
| `QBO_CLIENT_ID` | yes | Intuit app client id for that environment |
| `QBO_CLIENT_SECRET` | yes | Intuit app client secret |
| `QBO_WEBHOOK_VERIFIER` | yes | Verifier token for that environment's webhook |
| `QBO_WEBHOOK_VERIFIER_PREVIOUS` | no | The old verifier during a rotation; a body signed with either is accepted. Remove it once Intuit shows only the new one. |
| `QBO_WRITES` | no (default `on`) | `off` is the platform kill switch: no request that writes to QBO is sent for any tenant; pulls continue and pushes wait in the outbox (5.8). |
| `QBO_READ_BUDGET` | no (default 450000) | Workspace CorePlus budget per calendar month (UTC), production only, kept under Intuit's 500,000 |
| `QBO_TENANT_READ_BUDGET` | no (default 20000) | Per-tenant CorePlus budget per month for **every** read the tenant causes (sync, CDC, checks, scan, look-ups), 5.11 |
| `QBO_TRIAL_READ_BUDGET` | no (default 5000) | The same budget for a tenant in its free trial (open question 13.12) |
| `WORKER_QBO_CONCURRENCY` | no (default 2) | Worker slots reserved for `qbo_*` jobs; they never use the general `WORKER_CONCURRENCY` slots (5.8) |
| `QBO_API_BASE`, `QBO_OAUTH_BASE` | tests only | Point the client at the fake QBO server. Ignored unless `APP_ENV` is `test` or `local`. |

Derived values (from `PUBLIC_ORIGIN`): redirect URI `${PUBLIC_ORIGIN}/api/v1/qbo/oauth/callback`.
Fixed values: authorize `https://appcenter.intuit.com/connect/oauth2`, token
`https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, revoke
`https://developer.api.intuit.com/v2/oauth2/tokens/revoke`, API base
`https://quickbooks.api.intuit.com/v3/company/{realmId}` (sandbox
`https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}`), every request with
`?minorversion=75`, `Accept: application/json`, and a **30-second timeout** on every Intuit request
(token calls 15 s). Scope: `com.intuit.quickbooks.accounting`.

With `QBO_ENVIRONMENT` unset, every QBO code path returns before touching the database (the records
hook included). Edits made while it is unset are picked up later by the Fishtape-side sweep (5.12).

### 2.2 Connect (OAuth 2.0 authorization code)

The flow must work in a desktop browser and in the iOS app, where the Intuit page opens in the system
browser (Capacitor `Browser.open`) that shares no cookies with the app. It must also stop the classic
OAuth "connect someone else's books to my tenant" attack. So it uses a one-time **ticket**, a browser
**flow cookie** and a server-side **state** row:

1. **Ticket.** An owner or admin presses "Connect to QuickBooks". The PWA calls
   `POST /api/v1/qbo/connect` `{ returnTo: 'web'|'app' }`. The server checks role, plan
   (`quickbooks`), that QBO is enabled on the server and that the tenant is not already connected
   (unless this is a reconnect, 2.6). It inserts a `qbo_oauth_states` row (stage `ticket`) holding
   `sha256(ticket)`, tenant, user, `returnTo`, `reconnect`, expiry **120 seconds**, and returns
   `{ url: "<origin>/api/v1/qbo/oauth/start?ticket=<43-char base64url>" }`.
2. **Start.** The PWA opens that URL (web: `location.assign`; iOS: `Browser.open`). `GET
   /api/v1/qbo/oauth/start?ticket=` (public) does **not** consume the ticket. It checks the ticket
   exists, is unexpired and in stage `ticket`; for `returnTo: 'web'` it also requires an `ft_session`
   cookie belonging to the ticket's user (else the `state_invalid` result). It answers a small static
   **interstitial** page (headers as the done page, plus `form-action 'self'` in the CSP): "Connect
   QuickBooks to the Fishtape company **<tenant name>**, requested by **<user email>**", a Connect button
   and a Cancel link. The button POSTs the ticket in a hidden field to `POST /api/v1/qbo/oauth/start`
   (public, `csrf: false`; the single-use ticket is the CSRF token). The POST consumes the ticket once:
   it must exist, be unexpired and in stage `ticket`. It generates `state` (32 random bytes, base64url)
   and `flow` (32 random bytes), stores
   `sha256(state)`, `sha256(flow)` and, when PKCE is on, the sealed PKCE verifier; moves the row to stage
   `authorizing` with a new 10-minute expiry; sets cookie `ft_qbo_flow=<flow>` (HttpOnly, Secure,
   SameSite=Lax, `Path=/api/v1/qbo/oauth`, Max-Age 600); and answers **302** to Intuit's authorize URL
   with `client_id`, `response_type=code`, `scope`, `redirect_uri`, `state` (and `code_challenge`,
   `code_challenge_method=S256` when PKCE is on).
3. **Callback.** Intuit sends the browser to `GET /api/v1/qbo/oauth/callback?code&state&realmId`
   (or `?error=access_denied&state`). The handler logs at `warn` level only (no request line with the
   code or realm), clears the flow cookie and always answers **302** (never HTML), to
   `/#/quickbooks?connect=<result>` for `web` or `/api/v1/qbo/oauth/done?result=<result>` for `app`.
   It checks, in order, and stops at the first failure:
   - the state row exists, stage `authorizing`, unexpired, and `sha256(cookie ft_qbo_flow)` equals its
     flow hash (else `state_invalid`); the row is deleted now (single use);
   - for `web`, when an `ft_session` cookie is present it must belong to the same user (else
     `state_invalid`);
   - the user is still an active owner or admin of that tenant and the tenant is entitled (else
     `forbidden` / `plan`);
   - Intuit sent `error` instead of `code` (the user cancelled): `denied`;
   - exchange the code **once** (`exchangeCode`); failure: `exchange_failed`;
   - read `CompanyInfo` and `Preferences`: `Country` must be `CA` (else `not_canada`), home currency
     CAD (else `not_cad`);
   - realm uniqueness: `qbo_realm_owner(realm_hash)` (W1 `connection.js`; reads `qbo_realms`, 3.2) must
     return null or this tenant. Another tenant: result `realm_in_use`, and the takeover offer of 2.9;
   - **same company rule, enforced on the server whatever `reconnect` says**: if this tenant has a
     `qbo_connections` row (any state, `disconnected` included) whose `realm_hash` or `environment`
     differs from the new one, the result is `wrong_company` for a reconnect and `purge_required` for a
     first connect ("Delete the links to <old company> first"). Nothing is stored. Old links can never
     be used against another company or the other environment;
   - **revoke rule**: after a failure that follows the exchange, revoke the new refresh token **only**
     when `qbo_realm_owner` returns null for that realm. Never revoke when the realm belongs to another
     tenant (`realm_in_use`, or `wrong_company` pointing at a realm someone else holds): Intuit's revoke
     may end the whole app grant for that realm and would disconnect the other tenant (**VERIFY**,
     11.4). The tokens are then simply discarded (kept sealed only for the takeover offer, 2.9).
   On success, in one tenant transaction: store the tokens and realm id (2.3), upsert
   `qbo_connections` (state `setup` for a first connect, the previous state for a reconnect), insert
   `qbo_realms`, write the audit event `qbo.connect` (or `qbo.reconnect`), notify office roles, and
   enqueue `qbo_reference_refresh`. Result `ok`.
4. **Done page.** `GET /api/v1/qbo/oauth/done?result=` (public) returns a tiny static HTML page with no
   data: "QuickBooks is connected. Go back to Fishtape." (or the error in words, from a fixed table).
   Headers: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `Cache-Control:
   no-store`. The iOS app polls `GET /api/v1/qbo/status` every 3 seconds while the browser is open and
   closes it when the state changes.

PKCE: Intuit's pages do not document PKCE for confidential clients. Before W1 merges, someone reads the
discovery document (`https://developer.api.intuit.com/.well-known/openid_configuration`) by hand once
and records the answer in 11.4 (tests never call real Intuit URLs). If it lists
`code_challenge_methods_supported` containing `S256`, set the constant `QBO_PKCE = true` in
`server/src/qbo/oauth.js`, else `false`. The state/flow binding above is the CSRF protection either way.

Residual risk (threat model TM-QBO-01): an attacker sends a fresh ticket URL (their own tenant) to a
QuickBooks admin of another company. Within 120 seconds that admin must open it, read past the
interstitial that names the attacker's Fishtape company and email, press Connect and approve Intuit's
consent screen. Only then would the admin's company connect to the attacker's tenant. Tickets are
single use, expire in 120 s and are only issued to MFA-verified owners and admins; `web` tickets need the
issuing user's own session at start; the connect notification names the QuickBooks company to every
office user.

### 2.3 Token storage

Stored with `services/secrets.js` `setSecret` (envelope AES-256-GCM, AAD bound to tenant and name).
Three new names, marked `internal: true`. For an internal name `isSecretName(name)` returns **false**, so
the existing `GET`, `PUT` and `DELETE /api/v1/secrets/:name` routes (`routes/v1/admin.js`) answer 400
`Unknown secret name` without any change to `admin.js`, and `listSecrets` never lists them. QBO code
reads and writes them through `getSecret`/`setSecret`/`deleteSecret` with the option `{ internal: true }`;
without that option those functions refuse internal names.

| Secret name | Value |
| --- | --- |
| `qbo.refresh_token` | Latest refresh token (up to 512 chars) |
| `qbo.access_token` | Current access token (up to 4096 chars) |
| `qbo.realm_id` | The realm id (Intuit requires it encrypted at rest) |

Non-secret timing lives in `qbo_connections`: `access_expires_at`, `refresh_expires_at` (from
`x_refresh_token_expires_in`), `refresh_hard_expires_at` (from `x_refresh_token_hard_expires_in`;
always send header `x-include-refresh-token-hard-expires-in: true` on code exchange and refresh),
`last_refresh_at`. The realm is also stored as `realm_hash` = `sealer.mac('qbo-realm',
environment + ':' + realmId)` (HMAC-SHA256 with an HKDF subkey of the master key) so webhooks can find
the tenant without decrypting anything. Because the hash depends on `SECRETS_MASTER_KEY`, a master-key
rotation or a move to a server with another key must run `node server/scripts/qbo-rehash.js` (W1) in the
same maintenance window as the re-wrap: it decrypts each `qbo.realm_id`, recomputes `realm_hash` in
`qbo_realms`, `qbo_connections` and every table that carries it (3.2), in one transaction per tenant.
`docs/runbooks/rotate-secrets.md` gains that step (W6).

Tokens and the realm id never appear in responses, logs, error messages, audit summaries, job payloads
or HQ.

### 2.4 Using and refreshing the access token

`withAccessToken(db, sealer, cfg, tenantId)` is the only way to get a token:

0. If the connection's `environment` differs from `cfg.environment`, never call Intuit: set
   `reconnect_needed` (reason `environment`) and throw `QboError{kind:'auth'}`. If the platform token
   breaker (step 5) is open, throw `QboError{kind:'unavailable', retry: true}`.
1. If `access_expires_at > now + 5 min`, return the stored access token and realm id.
2. Otherwise, single-flight per tenant without holding a database transaction across the network call:
   an in-process promise map keyed by tenant id, then a row lease in a short transaction:
   `UPDATE qbo_connections SET refreshing_until = now() + interval '30 seconds' WHERE tenant_id = $1 AND
   (refreshing_until IS NULL OR refreshing_until < now()) RETURNING access_expires_at`. No row: another
   process is refreshing; poll every 250 ms (up to 20 s) until `refreshing_until` clears, then re-read
   and return its token. Got the lease: re-read `access_expires_at`; if another process refreshed in the
   meantime, clear the lease and return its token.
3. Call the token endpoint with `grant_type=refresh_token` (client_secret_basic, 15 s timeout), with no
   transaction open. Then, in one short transaction, store the **new** refresh token, access token and
   expiries and clear `refreshing_until`.
4. `invalid_grant` only: re-read the stored refresh token once (another process may have rotated it); if
   it changed, retry once with it. Still `invalid_grant`: set state `reconnect_needed` (reason
   `revoked`), notify, throw `QboError{kind:'auth'}`. Network error or 5xx: throw retryable; keep the old
   tokens.
5. **Platform credential failures never change a tenant's state.** `invalid_client`, any 401, or any
   other 400 from the token endpoint means Fishtape's own client id or secret is wrong (a rotation typo,
   production keys against sandbox tokens). The client opens a process-wide **token breaker** for 10
   minutes (no tenant calls the token endpoint), throws `QboError{kind:'unavailable', retry: true}`, and
   raises the HQ alert `qbo_platform_credentials` (section 9). A second guard: if 5 or more tenants reach
   `invalid_grant` within 15 minutes, the next ones are not marked `reconnect_needed`; they throw
   retryable and the alert `qbo_mass_revoke` is raised for a person to look.

A 401 from the API with a token that should be valid triggers one forced refresh and one retry.

Rolling expiry: the daily job `qbo_token_housekeeping` refreshes any connection whose
`last_refresh_at` is older than 30 days, so the 100-day window never lapses for a quiet tenant. It does
**not** refresh a connection that has been `paused` with reason `plan` for more than 60 days, whose
tenant has been `suspended` for more than 60 days, or whose tenant is `closed`; it disconnects those
instead (2.7, with revoke and purge, audit `qbo.auto_disconnect`, email to the tenant's owners), so
abandoned trials and closed companies never keep a grant alive. It also retries `qbo_revoke_pending`.

Hard expiry (5 years): the same job notifies office roles 30, 7 and 1 days before
`refresh_hard_expires_at` ("Reconnect to QuickBooks before <date>"). Accounting tokens issued from
October 2023 start expiring in October 2028.

### 2.5 Connection states

`qbo_connections.state`:

| State | Meaning | Sync | Shown to office |
| --- | --- | --- | --- |
| `setup` | Connected, wizard not applied | Off (only reference reads and the scan) | "Finish setting up" |
| `active` | Normal | On | Last sync times |
| `paused` | `pause_reason` = `user` (paused by an office user), `plan` (plan below Pro), `budget` (workspace read budget used up), `tenant_budget` (this tenant's read budget used up), `brake` (safety brake, 5.8), `hq` (paused by HQ) | Off; webhooks still mark the tenant dirty | Reason and how to resume (`hq`: "Paused by Fishtape support") |
| `reconnect_needed` | `reconnect_reason` = `revoked`, `expired`, `not_canada`, `not_cad`, `environment` (the server's `QBO_ENVIRONMENT` differs from the connection's) or `error` | Off; webhooks still mark the tenant dirty | "Reconnect to QuickBooks" |
| `disconnected` | Disconnected; links kept until `purge_after` | Off; webhooks ignored | "Connect to QuickBooks" |

A tenant with no row is "not connected". Entering `reconnect_needed` notifies office roles once per
day (`notify` kind `quickbooks`, ref `qbo:reconnect:<YYYY-MM-DD>`, link `#/quickbooks`) and writes the
audit event `qbo.reconnect_needed`.

**Fishtape edits while sync is off are never lost.** The records hook (5.2) queues an outbox row in
every state while a `qbo_connections` row exists (`disconnected` included). Only an `active` pass
processes the outbox; rows wait otherwise. Every move back to `active` (resume, reconnect, plan
upgrade, brake release, budget reset, HQ resume) runs the Fishtape-side sweep (5.12) before the first
push, which also catches writes made while QBO was unset on the server or that bypassed `records.js`.

Plan changes: a tenant whose effective plan drops below Pro is set to `paused/plan` by the next sync job
(it checks `tenantHas(t, 'quickbooks')` at the start); an upgrade resumes it the same way. Data and
tokens are kept (for at most 60 days, 2.4). `paused_since` records when any pause began.

Tenant lifecycle: the dispatcher and every `qbo_*` handler work only on tenants whose `tenants.status`
is `active` (5.8). `qbo_token_housekeeping` disconnects, with revoke and purge, every connection whose
tenant is `closed` (scheduled for deletion), so the grant is ended long before the tenant row is deleted;
a `suspended` tenant is not synced and is auto-disconnected after 60 days (2.4). The HQ close action
(`routes/hq-tenants.js`, W6) enqueues `qbo_token_housekeeping` for that tenant at once, and
`docs/runbooks/offboard-tenant.md` gains the step (W6).

### 2.6 Reconnect

Same flow as 2.2 with `reconnect: true`, allowed in states `reconnect_needed`, `paused`, `active` and
`disconnected` (before purge). The new realm and environment must equal the stored ones; otherwise
`wrong_company`, and the revoke rule of 2.2 decides whether the new token is revoked. After success:
state returns to what it was before (`active` or `setup`; from `disconnected`, `active` if the wizard had
been applied, else `setup`), and a `qbo_sync` job runs the Fishtape-side sweep (5.12), then CDC from
`cdc_cursor` (or a full reconcile if the cursor is older than 29 days).

### 2.7 Disconnect

`POST /api/v1/qbo/disconnect` `{ purge: boolean }` (owner or admin, any plan; `purge` defaults to
`false`, and the PWA checkbox "Also delete the links to <company> now" starts unticked):

1. Fence the engine: increment `lease_epoch` and clear `lease_until`, so a pass still running stops
   before its next write (5.8 checks the epoch on every write).
2. Revoke the refresh token at Intuit (15 s timeout). If the revoke fails, the sealed refresh token is
   moved to the platform table `qbo_revoke_pending` (3.2) and `qbo_token_housekeeping` retries it daily
   for 14 days (then deletes it and logs `revoke_gave_up`). The token is never just dropped while the
   grant may still be live.
3. Delete the three secrets, delete the `qbo_realms` row and queued `qbo_*` jobs for the tenant
   (`DELETE FROM jobs_queue WHERE tenant_id = $1 AND kind LIKE 'qbo_%' AND status = 'queued'`).
   `qbo_outbox` rows are **kept** (a reconnect of the same company pushes them); they go at purge.
4. Set state `disconnected`, `disconnected_at = now()`, `purge_after = now() + 30 days`.
5. If `purge` is true, or when `purge_after` passes (hourly `qbo_purge` job): delete the tenant's rows
   from `qbo_links`, `qbo_conflicts`, `qbo_candidates`, `qbo_reference`, `qbo_inbox`, `qbo_outbox`,
   `qbo_sync_log`, `qbo_mappings` and `qbo_connections`. `stripe_payouts` rows stay (they are Stripe
   data).
6. Audit `qbo.disconnect` (summary says whether data was purged). Notify office roles.

Fishtape records that came from QuickBooks (clients, invoices, payments...) stay: they are the tenant's
records now. Reconnecting the **same** realm and environment within 30 days keeps the links and skips
the wizard. Connecting a **different** realm or environment is refused on the server with
`purge_required` until a purge has run (2.2); the PWA offers the purge ("This forgets the links to
<old company>").

A disconnect started inside QuickBooks shows up as `invalid_grant` on the next call and becomes
`reconnect_needed` (reason `revoked`). Intuit's disconnect URL (`GET /api/v1/qbo/disconnected`) only
shows a static page explaining how to reconnect; it changes nothing (it carries no proof of who calls).

### 2.8 Edition and feature detection

On connect, daily (`qbo_reference_refresh`) and on a `Preferences` webhook, read `CompanyInfo` and
`Preferences` and store `qbo_connections.features`:

```json
{
  "edition": "QuickBooks Online Plus",
  "salesTax": true,
  "customTxnNumbers": true,
  "purchaseCustomTxnNumbers": false,
  "estimates": true,
  "discounts": true,
  "deposits": true,
  "bills": true,
  "timeTracking": true,
  "purchaseOrders": true,
  "classes": false,
  "locations": false,
  "projects": false,
  "multicurrency": false,
  "payroll": true,
  "bookCloseDate": "2025-12-31",
  "taxFiledThrough": "2026-09-30",
  "province": "MB"
}
```

`taxFiledThrough` is the latest `LastFileDate` across the company's `TaxAgency` objects (read daily with
the reference refresh; **VERIFY** the field name and that it is set when a return is filed in QBO). It
drives the filed-period rule (4.8). When QBO has no value, the office can set
`option.taxFiledThrough` by hand on the mappings screen; the later of the two applies.

Sources: `CompanyInfo.NameValue` (`OfferingSku`, `PayrollFeature`), `CompanyInfo.CompanyAddr.
CountrySubDivisionCode`, `Preferences.TaxPrefs.UsingSalesTax`, `SalesFormsPrefs.CustomTxnNumbers`,
`AllowEstimates`, `AllowDiscount`, `AllowDeposit`, `VendorAndPurchasesPrefs` / `OtherPrefs`
`UseCustomTxnNumbers`, `AccountingInfoPrefs.ClassTrackingPerTxn|ClassTrackingPerTxnLine`,
`TrackDepartments`, `BookCloseDate`, `OtherPrefs ProjectsEnabled`, `CurrencyPrefs.MultiCurrencyEnabled`,
`TimeTrackingPrefs`. `bills`, `timeTracking` and `purchaseOrders` start from the edition table (Lite:
none; Essentials: bills and time; Plus and Advanced: all) and turn false when QBO answers fault **5030**
for that entity. A feature that turns off moves its links to state `blocked` (reason `feature_missing`);
turning it back on re-queues them.

### 2.9 Realm takeover and HQ release

A realm held by another tenant (for example a former employee, still a QuickBooks admin, connected TG's
company to a throwaway trial) must not lock TG out for good.

- **Takeover.** When the callback ends in `realm_in_use`, the new tokens are sealed into the state row,
  which moves to stage `takeover` with a 10-minute expiry, and the result is `realm_in_use`. The PWA
  shows "This QuickBooks company is connected to another Fishtape company" (the other tenant is never
  named) and, for an MFA-verified owner or admin, the button "Move it to <this company>".
  `POST /api/v1/qbo/connect/takeover` `{ confirm: true }` (admin) takes the caller's own latest
  `takeover` row. In one platform transaction it disconnects the old tenant with purge and **without**
  revoke, since the grant is shared and now belongs to the new tenant (2.7 steps 1, 3 to 6, under that
  tenant's `withTenant`). It then completes the connect for the caller (2.2 success path). Audit
  `qbo.takeover` on both tenants. Email to the old tenant's owners: "QuickBooks company <name> was
  connected to another Fishtape company by a QuickBooks admin of that company on <date>". Completing
  Intuit's consent already proves QuickBooks admin rights over the books.
- **HQ release.** HQ can release a realm from a tenant (`POST /api/hq/tenants/:id/quickbooks/release`,
  audited `hq.qbo.release`, reason required). With HQ's grants (3.2) it sets that tenant's connection to
  `disconnected` (bumping `lease_epoch`) and deletes its `qbo_realms` row, in one transaction. The
  tenant's next `qbo_token_housekeeping` run sees a `disconnected` connection that still has secrets and
  finishes 2.7 (revoke, delete secrets).
- **HQ pause.** `POST /api/hq/tenants/:id/quickbooks/pause` `{ paused }` (audited `hq.qbo.pause`) sets
  `paused/hq` (keeping `state_before`, bumping `lease_epoch`), or puts back `state_before`. Only HQ can resume an `hq`
  pause.

---

## 3. Data model

### 3.1 Principles

- **QBO ids, sync tokens and snapshots never go into Fishtape records.** They live in `qbo_links`.
  Field crews read `clients`, `items` and `settings` today, so anything stored on records would reach
  them. With this rule `auth/access.js` needs no QBO redaction at all.
- **QBO settings never go into `settings`** (which every member reads). Mappings live in
  `qbo_mappings`. The existing `settings.accounting.qbo` stays the CSV export's own setting.
- Every tenant table has RLS `ENABLE` and `FORCE` with the 0040 policy shape. Platform tables hold no
  customer data: hashes, ids and counts only (and, in `qbo_revoke_pending`, sealed tokens).
  `qbo_realms` and `qbo_api_usage` also have RLS: anyone may read, a tenant may write only its own rows.
- Migration range **0150-0159**. `0150_qbo.sql` is hand-written (W1). `0151_purchasing.sql` is generated
  by `server/scripts/gen-collections-sql.js --migration 0151` (W5). 0152-0159 stay free for fixes.

### 3.2 `server/migrations/0150_qbo.sql` (exact DDL)

```sql
-- 0150 QuickBooks Online two-way sync (docs/integrations/quickbooks.md).
-- Tokens and the realm id live in tenant_secrets (qbo.refresh_token, qbo.access_token, qbo.realm_id).
-- Nothing in this file holds a plain secret. Tenant tables: RLS enabled and forced, like the rest.

-- ---- platform tables (read before a tenant is known; no customer data) ----

-- Which tenant owns a realm. realm_hash = HMAC-SHA256 (sealer.mac('qbo-realm', env || ':' || realmId)).
-- The primary key makes one tenant per realm; UNIQUE (tenant_id) makes one realm per tenant.
-- Anyone may read (hashes and tenant ids only: webhook routing, realm_in_use); only the tenant itself
-- may insert or delete its row.
CREATE TABLE qbo_realms (
  realm_hash  bytea PRIMARY KEY CHECK (length(realm_hash) = 32),
  tenant_id   uuid NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qbo_realms ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_realms FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_realms_read ON qbo_realms FOR SELECT USING (true);
CREATE POLICY qbo_realms_insert ON qbo_realms FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY qbo_realms_delete ON qbo_realms FOR DELETE USING (tenant_id = app_tenant_id());

-- Connect tickets, OAuth state and takeover offers (the callback arrives with no tenant context).
CREATE TABLE qbo_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stage           text NOT NULL CHECK (stage IN ('ticket', 'authorizing', 'takeover')),
  ticket_hash     bytea NOT NULL UNIQUE CHECK (length(ticket_hash) = 32),
  state_hash      bytea UNIQUE CHECK (length(state_hash) = 32),
  flow_hash       bytea CHECK (length(flow_hash) = 32),
  verifier_sealed text CHECK (length(verifier_sealed) <= 400),
  realm_hash      bytea CHECK (length(realm_hash) = 32),          -- takeover only
  tokens_sealed   text CHECK (length(tokens_sealed) <= 12000),    -- takeover only: sealed TokenSet + realm id
  return_to       text NOT NULL CHECK (return_to IN ('web', 'app')),
  reconnect       boolean NOT NULL DEFAULT false,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qbo_oauth_states_expires_idx ON qbo_oauth_states (expires_at);

-- CorePlus/Core call counts per tenant per month (budgets, HQ). Counts only. Everyone reads (the
-- workspace total is a sum over tenants); a tenant writes only its own rows.
CREATE TABLE qbo_api_usage (
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  environment    text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  core_calls     integer NOT NULL DEFAULT 0,
  coreplus_calls integer NOT NULL DEFAULT 0,
  throttled      integer NOT NULL DEFAULT 0,
  errors         integer NOT NULL DEFAULT 0,
  alerted_pct    smallint NOT NULL DEFAULT 0,   -- highest per-tenant budget alert sent this month (50, 80, 100)
  PRIMARY KEY (month, tenant_id, environment)
);
ALTER TABLE qbo_api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_api_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_api_usage_read ON qbo_api_usage FOR SELECT USING (true);
CREATE POLICY qbo_api_usage_insert ON qbo_api_usage FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY qbo_api_usage_update ON qbo_api_usage FOR UPDATE USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Refresh tokens whose revoke failed (disconnect, purge, tenant close). Survives tenant deletion on
-- purpose (no FK), so a live grant is never forgotten. Retried daily for 14 days.
CREATE TABLE qbo_revoke_pending (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment   text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  token_sealed  text NOT NULL CHECK (length(token_sealed) <= 2000),   -- sealed with AAD 'qbo-revoke:' || id
  attempts      integer NOT NULL DEFAULT 0,
  next_try_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Platform health events for HQ alerts (section 9). Kinds and counts only, no customer data.
-- Written by W1 (client, webhook, connection) and W3 (engine); read by W6's alerts job and HQ.
CREATE TABLE qbo_platform_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind ~ '^[a-z_]{2,40}$'),
  -- platform_credentials, invalid_grant, reconnect_needed, webhook_signature, intuit_5xx, safety_brake,
  -- realm_mismatch, revoke_gave_up, budget_threshold
  environment text CHECK (environment IN ('sandbox', 'production')),
  tenant_id   uuid REFERENCES tenants (id) ON DELETE CASCADE
);
CREATE INDEX qbo_platform_events_kind_idx ON qbo_platform_events (kind, at);

-- ---- tenant tables ----

CREATE TABLE qbo_connections (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  environment             text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  realm_hash              bytea NOT NULL CHECK (length(realm_hash) = 32),
  state                   text NOT NULL CHECK (state IN ('setup', 'active', 'paused', 'reconnect_needed', 'disconnected')),
  state_before            text CHECK (state_before IN ('setup', 'active', 'paused')),
  pause_reason            text CHECK (pause_reason IN ('user', 'plan', 'budget', 'tenant_budget', 'brake', 'hq')),
  paused_since            timestamptz,
  reconnect_reason        text CHECK (reconnect_reason IN ('revoked', 'expired', 'not_canada', 'not_cad', 'environment', 'error')),
  company_name            text CHECK (length(company_name) <= 200),
  features                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  connected_at            timestamptz,
  connected_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  access_expires_at       timestamptz,
  refresh_expires_at      timestamptz,
  refresh_hard_expires_at timestamptz,
  last_refresh_at         timestamptz,
  refreshing_until        timestamptz,                 -- token refresh lease (2.4)
  sync_from               date,
  setup                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(setup) = 'object'),
  cdc_cursor              timestamptz,                 -- one cursor; every CDC call asks for every entity (5.4)
  time_cursor             timestamptz,                 -- TimeActivity (not in CDC)
  fishtape_cursor         bigint,                      -- highest change_seq the Fishtape-side sweep has covered (5.12)
  dirty_at                timestamptz,                 -- a webhook arrived since the last pull
  ref_refreshed_at        timestamptz,
  last_pull_at            timestamptz,
  last_push_at            timestamptz,
  last_webhook_at         timestamptz,
  last_scan_at            timestamptz,
  last_manual_pull_at     timestamptz,
  last_check_at           timestamptz,                 -- daily balance check (5.13)
  throttled_until         timestamptz,
  lease_until             timestamptz,
  lease_by                text CHECK (length(lease_by) <= 200),
  lease_epoch             bigint NOT NULL DEFAULT 0,   -- fencing token (5.8)
  brake_allow_until       timestamptz,                 -- "allow once" after a safety brake (5.8)
  brake_allow_count       integer,
  disconnected_at         timestamptz,
  purge_after             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qbo_links (
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  realm_hash     bytea NOT NULL CHECK (length(realm_hash) = 32),
  collection     text NOT NULL CHECK (collection IN ('clients', 'jobs', 'items', 'employees', 'vendors', 'estimates',
                   'invoices', 'payments', 'bills', 'purchaseOrders', 'timeEntries', 'stripePayouts')),
  record_id      text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  role           text NOT NULL DEFAULT 'main' CHECK (role IN ('main', 'fee', 'deposit', 'settlement')),
  qbo_entity     text NOT NULL CHECK (qbo_entity IN ('Customer', 'Item', 'Employee', 'Vendor', 'Estimate', 'Invoice',
                   'Payment', 'Bill', 'Purchase', 'PurchaseOrder', 'TimeActivity', 'Transfer')),
  qbo_id         text CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  qbo_line       text NOT NULL DEFAULT '' CHECK (length(qbo_line) <= 40),
  sync_token     text CHECK (sync_token ~ '^[0-9]{1,10}$'),
  qbo_updated_at timestamptz,
  fishtape_version bigint,
  state          text NOT NULL CHECK (state IN ('pending', 'synced', 'conflict', 'error', 'blocked',
                   'needs_review', 'deleted_remote', 'deleted_local', 'unlinked')),
  owner          text NOT NULL DEFAULT 'both' CHECK (owner IN ('both', 'fishtape', 'quickbooks', 'none')),
  snapshot       jsonb,
  prev_values    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(prev_values) = 'object'),
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  reason         text CHECK (length(reason) <= 60),
  attempts       integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error     text CHECK (length(last_error) <= 500),
  synced_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, collection, record_id, role)
);
CREATE UNIQUE INDEX qbo_links_remote_key ON qbo_links (tenant_id, qbo_entity, qbo_id, qbo_line, role)
  WHERE qbo_id IS NOT NULL AND state <> 'unlinked';
CREATE INDEX qbo_links_state_idx ON qbo_links (tenant_id, state, next_attempt_at);

-- Fishtape changes waiting to go to QBO (one row per record; written by the records afterWrite hook,
-- by the Fishtape-side sweep and by recordStripePayout). Kept while sync is off; deleted only in the
-- transaction that records the link outcome (5.3), or at purge.
CREATE TABLE qbo_outbox (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  collection    text NOT NULL CHECK (length(collection) <= 40),
  record_id     text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  op            text NOT NULL CHECK (op IN ('upsert', 'delete')),
  stale         boolean NOT NULL DEFAULT false,
  held          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(held) = 'object'),  -- device money values kept out of the record (5.2)
  actor_type    text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'field_user', 'api_key', 'agent', 'stripe', 'system', 'sweep')),
  rank          smallint NOT NULL CHECK (rank BETWEEN 0 AND 99),
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  not_before    timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claimed_epoch bigint,
  PRIMARY KEY (tenant_id, collection, record_id)
);
CREATE INDEX qbo_outbox_due_idx ON qbo_outbox (tenant_id, rank, not_before);

-- Webhook events that CDC cannot replace: TimeActivity (not in CDC) and merges. One row per object;
-- a newer event overwrites the older one, so the table stays bounded while sync is off. Other entities
-- only set qbo_connections.dirty_at.
CREATE TABLE qbo_inbox (
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  realm_hash   bytea NOT NULL CHECK (length(realm_hash) = 32),
  entity       text NOT NULL CHECK (entity IN ('TimeActivity', 'Customer', 'Vendor', 'Item')),
  qbo_id       text NOT NULL CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  op           text NOT NULL CHECK (op IN ('created', 'updated', 'deleted', 'merged')),
  deleted_id   text CHECK (deleted_id ~ '^[0-9]{1,20}$'),
  event_time   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  attempts     smallint NOT NULL DEFAULT 0,
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, entity, qbo_id)
);
CREATE INDEX qbo_inbox_pending_idx ON qbo_inbox (tenant_id, event_time) WHERE processed_at IS NULL;

CREATE TABLE qbo_conflicts (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  link_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('fields', 'review', 'deleted', 'merged')),
  collection  text NOT NULL CHECK (length(collection) <= 40),
  record_id   text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  label       text CHECK (length(label) <= 200),
  reason      text CHECK (length(reason) <= 60),
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array'),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text CHECK (length(resolved_by) <= 200),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, link_id) REFERENCES qbo_links (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX qbo_conflicts_open_key ON qbo_conflicts (tenant_id, link_id) WHERE status = 'open';

CREATE TABLE qbo_sync_log (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL DEFAULT now(),
  direction   text NOT NULL CHECK (direction IN ('push', 'pull', 'system')),
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'skipped', 'conflict', 'error', 'warning', 'info', 'shadow')),
  action      text NOT NULL CHECK (action ~ '^[a-z_]{2,40}$'),
  actor_type  text CHECK (actor_type IN ('user', 'field_user', 'api_key', 'agent', 'stripe', 'system', 'sweep')),
  collection  text CHECK (length(collection) <= 40),
  record_id   text CHECK (length(record_id) <= 128),
  qbo_entity  text CHECK (length(qbo_entity) <= 40),
  label       text CHECK (length(label) <= 200),
  message     text CHECK (length(message) <= 500),
  error_code  text CHECK (length(error_code) <= 60),
  intuit_tid  text CHECK (length(intuit_tid) <= 100),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX qbo_sync_log_at_idx ON qbo_sync_log (tenant_id, at DESC);
CREATE INDEX qbo_sync_log_record_idx ON qbo_sync_log (tenant_id, collection, record_id, id DESC);

CREATE TABLE qbo_mappings (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  realm_hash bytea NOT NULL CHECK (length(realm_hash) = 32),
  kind       text NOT NULL CHECK (kind IN ('item', 'taxCode', 'purchaseTaxCode', 'account', 'paymentMethod',
               'depositTo', 'paidFrom', 'class', 'department', 'term', 'option')),
  key        text NOT NULL CHECK (key ~ '^[A-Za-z0-9+|._:-]{1,64}$'),
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text CHECK (length(updated_by) <= 200),
  PRIMARY KEY (tenant_id, kind, key)
);

-- QBO lists Fishtape needs for choices and lookups (accounts, tax codes, ...). Refreshed on connect,
-- daily and on webhooks. TaxCode/TaxRate are not in CDC, so the daily read is their only source.
-- data holds only the allow-listed fields of section 3.8, never whole QBO objects.
CREATE TABLE qbo_reference (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  realm_hash bytea NOT NULL CHECK (length(realm_hash) = 32),
  kind       text NOT NULL CHECK (kind IN ('Account', 'Item', 'TaxCode', 'TaxRate', 'TaxAgency', 'PaymentMethod',
               'Class', 'Department', 'Term', 'Employee', 'Vendor')),
  qbo_id     text NOT NULL CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  name       text NOT NULL CHECK (length(name) <= 200),
  active     boolean NOT NULL DEFAULT true,
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, qbo_id)
);

-- First-connect matching candidates (the wizard). Deleted 30 days after the scan that wrote them.
CREATE TABLE qbo_candidates (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  realm_hash    bytea NOT NULL CHECK (length(realm_hash) = 32),
  kind          text NOT NULL CHECK (kind IN ('customers', 'jobs', 'items', 'employees', 'vendors', 'estimates', 'invoices', 'payments')),
  fishtape_id   text CHECK (length(fishtape_id) <= 128),
  qbo_id        text CHECK (qbo_id ~ '^[0-9]{1,20}$'),
  qbo_summary   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qbo_summary) = 'object'),
  score         smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  reasons       text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL CHECK (status IN ('matched', 'ambiguous', 'fishtape_only', 'quickbooks_only')),
  choice        text NOT NULL CHECK (choice IN ('link', 'create_in_qbo', 'create_in_fishtape', 'skip')),
  diffs         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diffs) = 'array'),          -- link candidates: [{ field, fishtape, quickbooks }] display values
  field_choices jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_choices) = 'object'), -- { field: 'fishtape'|'quickbooks' }
  confirmed     boolean NOT NULL DEFAULT false,      -- explicit tick for creates dated on or before taxFiledThrough
  chosen_by     text CHECK (length(chosen_by) <= 200),
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  error         text CHECK (length(error) <= 500),
  PRIMARY KEY (tenant_id, id),
  CHECK (fishtape_id IS NOT NULL OR qbo_id IS NOT NULL)
);
CREATE INDEX qbo_candidates_kind_idx ON qbo_candidates (tenant_id, kind, status);

-- Stripe payouts seen on the tenant's Stripe webhook (written by integrations, pushed as QBO Transfers).
-- fee_cents is informational only (Stripe's payout summary) and is never posted: fees are booked per
-- payment (4.9). balance_txns is the payout's balance-transaction list, money only, no customer data.
CREATE TABLE stripe_payouts (
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payout_id          text NOT NULL CHECK (payout_id ~ '^po_[A-Za-z0-9]{8,64}$'),
  amount_cents       bigint NOT NULL,
  currency           text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  arrival_date       date NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'canceled')),
  paid_seen          boolean NOT NULL DEFAULT false,   -- true once 'paid' was ever seen (a later 'failed' reverses)
  automatic          boolean NOT NULL DEFAULT true,
  livemode           boolean NOT NULL,
  payment_intent_ids text[] NOT NULL DEFAULT '{}',
  earliest_charge_at timestamptz,
  balance_txns       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(balance_txns) = 'array'),
  -- [{ id, type, amountCents, feeCents, paymentIntentId|null, created }]
  fee_cents          bigint,
  received_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, payout_id)
);

-- RLS (same shape as 0040) on every tenant table.
ALTER TABLE qbo_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY qbo_connections_tenant ON qbo_connections
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
-- ... repeat ENABLE, FORCE and the same policy (named <table>_tenant) for: qbo_links, qbo_outbox,
-- qbo_inbox, qbo_conflicts, qbo_sync_log, qbo_mappings, qbo_reference, qbo_candidates, stripe_payouts.

GRANT SELECT, INSERT, DELETE ON qbo_realms TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_oauth_states, qbo_revoke_pending TO fishtape_app;
GRANT SELECT, INSERT, DELETE ON qbo_platform_events TO fishtape_app;
GRANT SELECT ON qbo_platform_events TO fishtape_hq;
GRANT SELECT, INSERT, UPDATE ON qbo_api_usage TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_connections, qbo_links, qbo_outbox, qbo_inbox, qbo_conflicts,
  qbo_sync_log, qbo_mappings, qbo_reference, qbo_candidates, stripe_payouts TO fishtape_app;

-- HQ (BYPASSRLS): health and counts only, never customer data (column grants), plus pause and release.
GRANT SELECT ON qbo_api_usage TO fishtape_hq;
GRANT SELECT (tenant_id, environment) ON qbo_realms TO fishtape_hq;
GRANT DELETE ON qbo_realms TO fishtape_hq;                                   -- HQ release (2.9)
GRANT SELECT (tenant_id, environment, state, state_before, pause_reason, paused_since, reconnect_reason,
  features, connected_at, refresh_expires_at, refresh_hard_expires_at, last_pull_at, last_push_at,
  last_webhook_at, last_check_at, throttled_until, disconnected_at) ON qbo_connections TO fishtape_hq;
GRANT UPDATE (state, state_before, pause_reason, paused_since, lease_epoch, lease_until, updated_at)
  ON qbo_connections TO fishtape_hq;                                         -- HQ pause and release (2.9)
GRANT SELECT (tenant_id, collection, state, reason, updated_at) ON qbo_links TO fishtape_hq;
GRANT SELECT (tenant_id, status, created_at) ON qbo_conflicts TO fishtape_hq;
GRANT SELECT (tenant_id, at, direction, outcome, action, actor_type, collection, error_code, intuit_tid)
  ON qbo_sync_log TO fishtape_hq;
GRANT SELECT (tenant_id, received_at, processed_at, attempts) ON qbo_inbox TO fishtape_hq;
GRANT SELECT (tenant_id, collection, enqueued_at) ON qbo_outbox TO fishtape_hq;
GRANT SELECT (id, environment, attempts, created_at) ON qbo_revoke_pending TO fishtape_hq;
```

The file spells out the repeated policy blocks in full (no `...`). `features` for HQ holds no customer
data (edition and switches only). The `company_name` column is not granted to HQ.

`realm_hash` on links, inbox, mappings, reference rows and candidates is the realm the row was written
for. The engine, the wizard and every route load only rows whose `realm_hash` equals the connection's,
and refuse to act (log `realm_mismatch`, HQ alert) on any other. This backs up the server-side purge
rule of 2.2. Cross-tenant reads the app needs go through the permissive `SELECT` policies of
`qbo_realms` and `qbo_api_usage` (hashes, tenant ids and counts only): webhook routing, the
`realm_in_use` check (`qbo_realm_owner(hash)` in W1's `connection.js` is a plain `SELECT tenant_id FROM
qbo_realms WHERE realm_hash = $1`), the dispatcher's list of connected tenants (`qbo_realms` joined with
`tenants WHERE status = 'active'`) and the workspace budget total.

### 3.3 What each table is for

| Table | Written by | Read by | Kept |
| --- | --- | --- | --- |
| `qbo_realms` | connect, disconnect, takeover, HQ release | webhook ingress, connect, dispatcher | while connected |
| `qbo_oauth_states` | connect, start, callback | start, callback, takeover | deleted on use; expired rows deleted hourly |
| `qbo_api_usage` | QBO client (every call) | budget checks, HQ | 13 months |
| `qbo_revoke_pending` | disconnect, purge, tenant close | housekeeping | until revoked, at most 14 days |
| `qbo_platform_events` | client, webhook, connection, engine | alerts job, HQ | 30 days |
| `qbo_connections` | connection, engine, HQ pause/release | everything | until purge |
| `qbo_links` | engine, wizard, link/unlink routes | engine, status routes | until purge |
| `qbo_outbox` | records hook, sweep, `recordStripePayout` | engine | until processed, or purge |
| `qbo_inbox` | webhook ingress (TimeActivity and merges only) | engine | processed rows 30 days |
| `qbo_conflicts` | engine | conflicts routes, engine | resolved rows 90 days |
| `qbo_sync_log` | engine, connection | log routes, HQ counts | 90 days |
| `qbo_mappings` | mappings route, wizard | engine | until purge |
| `qbo_reference` | reference refresh | mappings route, engine | until purge |
| `qbo_candidates` | wizard scan | wizard | deleted 30 days after the scan that wrote them (applied or not) |
| `stripe_payouts` | Stripe webhook (W6) | engine | with Stripe data (7 years, like payments) |

### 3.4 Link rows

One link per (collection, record, role). `role` is `main` except:

- `payments` with role `fee`: the QBO `Purchase` that books a Stripe fee. It depends on the `main`
  link (5.3): it is never pushed before the main Payment exists, and deleting or voiding the main
  Payment deletes the fee Purchase too.
- `payments` with role `deposit`: a Fishtape payment created from an invoice's QBO `Deposit` field.
- `invoices` with role `settlement`: the pull-only Fishtape payment that shows the part of an invoice
  settled in QBO by credit memos or journal entries (4.9). `record_id` is that payment's id;
  `qbo_entity` `Invoice`, `qbo_line` `'settlement'`.
- `stripePayouts` with role `fee`: the `Purchase` that books payout-level Stripe fees (4.9).

`qbo_line` tells apart several Fishtape records that share one QBO object: for a QBO `Payment` applied
to several invoices, each Fishtape payment's link has `qbo_line` = the QBO invoice id it applies to
(`'deposit'` for the deposit case). Empty otherwise.

Link `state`:

| State | Meaning | Badge |
| --- | --- | --- |
| `pending` | Queued to create or update. A link is inserted and **committed** in `pending` before its first create call (5.3); `reason` `tax_override` while a create waits for its tax override | "Sending to QuickBooks" |
| `synced` | Both sides equal the snapshot | "In QuickBooks" |
| `conflict` | An open conflict; neither side is written | "Needs a decision" |
| `error` | Retries used up (poison) or a permanent QBO error; `reason` and `last_error` say why | "Not in QuickBooks" |
| `blocked` | Waiting on something: `reason` is `dependency`, `employee_not_linked`, `mapping_missing`, `tax_reason`, `feature_missing`, `module_off`, `currency`, `books_closed`, `no_invoice`, `duplicate_number_local`, `totals_mismatch`, `stripe_unbooked` | "Waiting: <reason in words>" |
| `needs_review` | A person must look before anything is written: pulled document Fishtape cannot represent exactly (`tax_shape`, `totals_differ`, `tax_inclusive`), a change to a filed GST period (`filed_period`), time in a paid pay period (`payroll_locked`), a money write from an API key or agent (`origin`), a payout with items Fishtape cannot book (`payout_items`), a wizard document that differs (`wizard_differs`). For pulled documents the QBO copy is the truth (`owner = 'quickbooks'`) until resolved | "Check in QuickBooks" |
| `deleted_remote` | Deleted or deactivated in QBO; Fishtape record kept | "Removed in QuickBooks" |
| `deleted_local` | Deleted in Fishtape; QBO object voided, deleted or deactivated | none (record is gone) |
| `unlinked` | Tombstone left by an unlink (5.6, 7.5). Nothing is pushed or pulled for the record until a person presses "Send to QuickBooks as new" (which deletes the tombstone and creates) or links it again | "Not linked to QuickBooks" |

`owner`: `both` (normal two-way), `fishtape` (push only: jobs, time, purchase orders, Stripe fee and
payout objects), `quickbooks` (QBO is the truth; Fishtape changes are not pushed; the badge says "Edit
in QuickBooks"), `none` (tombstone).

`meta` keys (all optional):

| Key | Meaning |
| --- | --- |
| `displayName` | Exact DisplayName/Name sent to QBO |
| `qboType` | QBO item `Type` (items only; `Inventory` items are costed through accounts, 4.4) |
| `marker` | The marker stamped on the QBO object at create: `Fishtape ref <first 12 hex of link id>` (5.3) |
| `createRequestId`, `createStartedAt` | Stable create request id and the time the first create call was sent (5.3) |
| `lineIds` | Fishtape line index to QBO `Line.Id`; lines Fishtape does not model are kept by `Line.Id` on updates |
| `docNumber` | QBO DocNumber when it differs from Fishtape's number |
| `taxDeltaCents` | QBO total minus Fishtape total when a tax override was refused (4.8) |
| `qboBalanceCents`, `qboTotalCents` | From the last pull of an invoice, bill or customer (record view, 5.13) |
| `unappliedCents`, `foreignLines` | QBO Payment amounts not owned by any Fishtape payment (4.9) |
| `estimateLinked` | Boolean: this estimate's invoice link was sent |
| `lossyLines` | Indexes of lines pulled as qty 1 (4.7) |
| `remoteAlias` | `{ field: sha256 of R's canonical value }`: R values that count as equal to the snapshot (6.4) |
| `fieldSeenAt` | `{ field: time }`: when the engine first saw R's value of the field change (5.5) |
| `dependsOn` | Link ids this link waits for (5.3) |
| `globalTax` | `GlobalTaxCalculation` of the QBO object, kept on every update (4.8) |

### 3.5 New Fishtape collections (W5)

Three collections, all office-only (read and write need the `invoices` permission, which only owner,
admin and office have), plan feature `purchasing` (Pro), module switch `purchasing`. They are added to
the end of `COLLECTIONS` in both `server/src/collections.js` and `electrical-app/js/store.js`, in this
order: `'vendors', 'bills', 'purchaseOrders'`.

Registry entries (`server/src/collections.js` DEFS):

```js
vendors: { table: 'vendors', gen: [], read: ['invoices'], write: ['invoices'], portal: null, maxBytes: 16 * KB, migration: '0151' },
bills: { table: 'bills', gen: [g('vendor_id', 'vendorId'), JOB, STATUS, g('day', 'date'), g('purchase_order_id', 'purchaseOrderId')],
  read: ['invoices'], write: ['invoices'], portal: null, maxBytes: 3 * MB, migration: '0151' },
purchaseOrders: { table: 'purchase_orders', gen: [g('vendor_id', 'vendorId'), JOB, STATUS, NUMBER],
  read: ['invoices'], write: ['invoices'], portal: null, maxBytes: 64 * KB, migration: '0151' },
```

`LATER` in `gen-collections-sql.js` gains `'0151': '0151_purchasing.sql'`; the file is generated with
`node scripts/gen-collections-sql.js --migration 0151`. `COLLECTION_FEATURES` (server entitlements) and
`COLLECTION_SWITCHES` (`electrical-app/js/lib/modules.js`) map all three to `['purchasing']`. The new
switch: `{ id: 'purchasing', group: 'money', label: 'Purchasing', desc: 'Suppliers, bills, receipts and
purchase orders.', modules: ['purchasing'] }` (not core).

Schemas (`electrical-app/js/schema/<name>.json`, draft-07, house style: `id`, `createdAt`, `updatedAt`
typed like the others, nullable types, `additionalProperties: true`, money in integer cents, listed in
`index.json`):

**vendors.json**

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string, max 100 | Display name. QBO `DisplayName`. |
| `companyName` | string, max 100 | |
| `email` | string, max 254 | |
| `phone` | string, max 40 | |
| `address` | string, max 500 | One string, like clients |
| `accountNumber` | string, max 100 | Fishtape's account number with the supplier (QBO `AcctNum`) |
| `terms` | string, max 60 | Free text; not synced |
| `t5018` | boolean | Subcontractor reported on the T5018 (QBO `T5018Eligible`, **VERIFY** field name) |
| `active` | boolean | Missing means true |
| `notes` | string, max 2000 | |

**bills.json** (supplier bills and paid receipts)

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `bill` \| `receipt` | `bill` = pay later (QBO `Bill`); `receipt` = already paid (QBO `Purchase`). A refund or credit from the supplier is a receipt with negative amounts (QBO `Purchase` with `Credit: true`, 4.10). |
| `vendorId` | string | Required before it can sync |
| `number` | string, max 40 | Supplier's invoice or receipt number (QBO `DocNumber`, max 21; longer is cut and the full value goes to `PrivateNote`) |
| `date` | YYYY-MM-DD | |
| `dueDate` | YYYY-MM-DD | Bills only |
| `jobId` | string | Default job for lines without one |
| `purchaseOrderId` | string | The PO this bill is for |
| `status` | `draft` \| `open` \| `paid` \| `void` | Receipts are `paid` from the start. `paid` on bills comes from QBO (Balance 0). |
| `paidWith` | `card` \| `cash` \| `cheque` \| `debit` \| `transfer` | Receipts only; picks the paid-from account |
| `lines` | array, max 200 | `{ description (max 4000), qty, unitCents, amountCents, itemId?, jobId?, costType ('material'\|'subcontract'\|'equipment'\|'other'), poLine? { purchaseOrderId, index } }`. `amountCents` = round(qty × unitCents) unless typed. |
| `taxes` | array, max 4 | `{ id ('GST'\|'HST'\|'PST'\|'RST'\|'QST'), label, cents }` as printed on the bill |
| `taxProvince` | string | Default the company province |
| `totalCents` | integer | As printed. Saving is allowed with a mismatch, but a bill whose lines + taxes differ from it by more than 2 cents is not pushed (link `blocked`, reason `totals_mismatch`, shown "Bill total doesn't add up") until fixed |
| `notes` | string, max 2000 | |
| `receipt` | object | `{ dataUrl (image/jpeg, image/png or application/pdf, max 2.5 MB), name, takenAt }` until object storage |
| `materialRequestIds` | string[] | Requests this bill covers |

**purchaseOrders.json**

| Field | Type | Notes |
| --- | --- | --- |
| `number` | string, max 40 | `PO-5001` from `store.nextNumber('po')`; `settings.nextNumbers.po` defaults to 5001 |
| `vendorId` | string | |
| `jobId` | string | Default job for lines |
| `date`, `expectedDate` | YYYY-MM-DD | |
| `status` | `draft` \| `open` \| `sent` \| `closed` \| `cancelled` | `closed` may come from QBO |
| `lines` | array, max 200 | `{ itemId?, description, qty, unit, unitCents, jobId?, materialRequestIds[] }` |
| `shipTo` | string, max 500 | |
| `notes` | string, max 2000 | Shown to the vendor (QBO `Memo`) |
| `sentAt`, `closedAt` | ISO time | |

Material requests do not change shape: a PO line lists the request ids it covers, and creating a PO sets
those requests to `status: 'ordered'`, `orderedAt` (the existing office flow).

### 3.6 Existing schemas

No QBO fields are added to any existing record. The only existing-record changes are:

- `payments`: Stripe payments gain `stripe.chargeId`, `stripe.balanceTransactionId`, `stripe.feeCents`,
  `stripe.netCents` (W6; typed in `payments.json` as optional properties of the existing `stripe` object).
  The `method` description gains `credit` (W6): a pull-only settlement payment made by the QBO sync for
  credit memos and journals (4.9), with `source: 'quickbooks'`. Office users cannot create or edit a
  `credit` payment (the payments editor hides it; the engine re-sets it on every pull).
- `estimates` and `invoices`: optional `taxNoneReason`: `zero` \| `exempt` \| `out_of_scope` \| `relief`
  (W2 owns the two schema changes; W4 the picker). It says why a document charges no tax (4.8).
- `electrical-app/js/lib/tax.js` gains the treatment `gst-only` ("PST/RST exempt, GST charged"; for a
  customer quoting their PST/RST licence or exemption number) for every PST/RST province, and the `none`
  treatment's hint stops mentioning PST/RST licences (W2).
- `settings.nextNumbers.po` (W5, `store.js` `DEFAULT_SETTINGS`).

### 3.7 Secrets registry

`server/src/services/secrets.js` gains:

```js
'qbo.refresh_token': { provider: 'qbo', label: 'QuickBooks refresh token', guide: 'quickbooks', internal: true },
'qbo.access_token': { provider: 'qbo', label: 'QuickBooks access token', guide: 'quickbooks', internal: true },
'qbo.realm_id': { provider: 'qbo', label: 'QuickBooks company id', guide: 'quickbooks', internal: true },
```

`listSecrets` skips `internal` names and `isSecretName` returns false for them (2.3), so the generic
secret routes refuse them; a W1 test sends `GET`, `PUT` and `DELETE /api/v1/secrets/qbo.refresh_token`
(and the other two) as an owner and expects 400 with nothing stored or deleted. `providers.js` is **not** changed: QBO is not a paste-the-key
provider and has no `PROVIDERS` entry, so `GET /api/v1/integrations` and `PUT /integrations/:provider`
never touch these names. The `integration_settings` and `integration_events` CHECK constraints are not
changed either; QBO keeps its own status tables.

### 3.8 `qbo_reference.data` allow-list

The reference refresh stores only these fields (W3 `reference.js`; a test rejects any other key):

| Kind | Fields kept |
| --- | --- |
| Account | `Id`, `Name`, `AccountType`, `AccountSubType`, `Active`, `CurrentBalance` (only for the Stripe clearing account) |
| Item | `Id`, `Name`, `Type`, `Active` |
| TaxCode | `Id`, `Name`, `Active`, `SalesTaxRateList` and `PurchaseTaxRateList` rate ids |
| TaxRate | `Id`, `Name`, `RateValue`, `AgencyRef`, `Active`, `EffectiveTaxRate` dates |
| TaxAgency | `Id`, `DisplayName`, `LastFileDate` |
| PaymentMethod, Class, Department, Term | `Id`, `Name`, `Active` (Term also `DueDays`) |
| Employee | `Id`, `DisplayName`, `GivenName`, `FamilyName`, `PrimaryEmailAddr`, `Active` |
| Vendor | `Id`, `DisplayName`, `PrimaryEmailAddr`, `Active` |

Never stored: birth dates, SIN, home addresses, bill rates, tax identifiers, notes.

---

## 4. Entity mapping

Direction: **both** (two-way), **push** (Fishtape to QBO only), **pull** (QBO to Fishtape only),
**link** (matched, never created by sync).

### 4.1 Summary

| Fishtape | QBO | Direction | Created in QBO when | Created in Fishtape when |
| --- | --- | --- | --- | --- |
| `clients` | `Customer` (top level) | both | a client is created after connect, or the wizard says so | a new active top-level QBO customer appears, or a pulled document needs it |
| `jobs` | `Customer` with `Job: true` (sub-customer) | push (+ link to existing projects) | first needed by a pushed estimate, invoice, bill, PO or time entry, when the option `jobsAsSubCustomers` is on | never (wizard can link) |
| `items` | `Item` (NonInventory on create) | both | first used on a pushed document (option `items: 'on_use'`, default) or always (`'all'`) | a new active Service, NonInventory or Inventory item appears (Category and Group ignored) |
| `employees` | `Employee` (or `Vendor` for subcontractors) | link | never | never |
| `vendors` | `Vendor` | both | created in Fishtape | new active QBO vendor |
| `estimates` | `Estimate` | both | status leaves `draft` (or "Send to QuickBooks now") | new QBO estimate dated on or after `sync_from` |
| `invoices` | `Invoice` | both | status leaves `draft` | new QBO invoice dated on or after `sync_from` |
| `payments` | `Payment` (+ `Purchase` for a Stripe fee) | both | created for a pushed invoice, from an allowed origin (5.2) | QBO payment applied to a linked invoice; a settlement payment for credit memos and journals (pull only) |
| `bills` kind `bill` | `Bill` | both (pull only if a line is tagged to a linked client or job) | status leaves `draft` | QBO bill with a line `CustomerRef` to a linked client or job |
| `bills` kind `receipt` | `Purchase` | both (same pull rule) | status leaves `draft` | same, for QBO expenses |
| `purchaseOrders` | `PurchaseOrder` | push (+ pull of `POStatus`) | status `open`, `sent` or `closed` | never |
| `timeEntries` | `TimeActivity` | push | approved, dated on or after `sync_from`, employee linked | never |
| `stripe_payouts` rows | `Transfer` (+ `Purchase` for payout-level fees) | push | payout `paid`, live mode, CAD, every charge booked (4.9) | never |

### 4.2 Customers (`clients` and `Customer`)

| Fishtape | QBO | Direction | Rule |
| --- | --- | --- | --- |
| `name` | `DisplayName` | both | Sent through `qboName` (no `:`, tab, newline or `"`; max 100). Duplicate name (6240): the rule below. The exact name sent is stored in `meta.displayName`; when reading back, a QBO name equal to `meta.displayName` means "unchanged". |
| `type` | `CompanyName` | both | `commercial`/`industrial`: `CompanyName` = name. `residential`: no `CompanyName`. Pull: `CompanyName` present means `commercial` unless the record already says `industrial`. |
| `email` | `PrimaryEmailAddr.Address` | both | |
| `phone` | `PrimaryPhone.FreeFormNumber` | both | |
| `address` (one string) | `BillAddr` | both | Push: `addressToQbo` (the `splitAddress` rules of qbo-export.js; `Country: 'CA'`). Pull: `addressFromQbo` joins `Line1`-`Line5`, `City`, `CountrySubDivisionCode`, `PostalCode`. Compared with `addressKey` (lower case, punctuation and repeated spaces removed). |
| `notes` | `Notes` | **push** | max 4000. QBO `Notes` is never pulled: it often holds credit and collections notes, and Fishtape client records are readable by field roles (`drawings`, `jobs`, `dashboard`). A client created from QBO starts with no notes. |
| deleted | `Active: false` | both | Fishtape delete: deactivate in QBO. QBO refuses while the customer has an open balance: link `error/open_balance` ("Customer has an open balance in QuickBooks"), no retry loop. QBO deactivate: link `deleted_remote`, Fishtape client kept, log. |
| (none) | `CurrencyRef` | push | Sent as CAD only when multicurrency is on. A QBO customer in another currency is `blocked/currency`. |

**Duplicate name (6240)** on a create or rename of a customer (and the same for vendors and job
sub-customers), before any suffix:

1. If the link has `meta.createRequestId` and the create's outcome was unknown, run adopt-by-search
   first (5.3): the "duplicate" may be our own earlier create.
2. Query the name (`select * from Customer where DisplayName = '<qboQuote(name)>'`, then Vendor and
   Employee if not found). The holder is an **unlinked Customer** (Vendor for vendors) and its email or
   last-10-digit phone equals ours: link it (no create), reconcile with B = null (every differing field
   becomes a conflict, nothing is overwritten). Unlinked Customer without that match: link `needs_review`
   (reason `name_taken`) with the choices "Link to this QuickBooks customer" and "Create as a new
   customer" (the latter adds the suffix).
3. Suffix (" (2)", " (3)"... up to 9) only when the holder is a vendor, an employee, or a customer that is
   already linked to another Fishtape record. After 9: `error/duplicate_name`.

QBO `merged` event (`data.deletedid`): confirmed by reading both ids first (the deleted id must answer
"not found" or inactive, the survivor must exist), never acted on from the webhook alone. Then the link
pointing at the deleted id moves to the surviving id. If the surviving id is already linked to another
Fishtape client, open a conflict of kind `merged` ("These two clients were merged in QuickBooks; merge
them in Fishtape or unlink one").

### 4.3 Jobs (sub-customers) - decision

**Decision: yes, each Fishtape job that takes part in QBO becomes a QBO sub-customer** (`Job: true`,
`ParentRef` = the client's customer, `BillWithParent: true`), created lazily when the first estimate,
invoice, bill, PO or time entry for it is pushed. Option `jobsAsSubCustomers` (default true) turns it off.
The option is chosen in the wizard and **locked** once any document has been pushed (the mappings
screen shows it read-only): switching it later would change `CustomerRef` on invoices that already have
payments, which QBO refuses.

Reasons:

1. Job costing in QuickBooks needs a customer on every line (`CustomerRef` on bill, purchase and PO lines
   and on `TimeActivity`). A sub-customer gives TG a profit-and-loss by job in QBO without anything else.
2. QBO Projects can only be **created** through the premium GraphQL API (Silver tier, about CA$425 a
   month) and only exist on Plus and Advanced. Sub-customers work on every edition through the free
   REST API.
3. `BillWithParent` keeps invoices addressed to the client, and Fishtape's own job costing
   (`lib/tm.js jobCosting`) is unaffected.

Rules:

- `DisplayName` = `qboName("<job.number> <job.title>")` (e.g. "J-1042 Panel upgrade 12 Elm"), unique
  across the whole QBO name list, collisions handled like customers. `BillAddr`/`ShipAddr` = job
  address.
- A job with no client cannot become a sub-customer; its documents use no job (QBO customer = the
  document's client) and its time entries go without `CustomerRef`.
- Job renamed or re-numbered in Fishtape: update the sub-customer. Job deleted: deactivate. Changes made
  to the sub-customer in QBO are ignored (push only) except deactivation, which sets the link to
  `deleted_remote` and stops using it (documents then go to the parent customer).
- **Existing QBO projects or sub-customers**: the wizard (section 6) offers to link a Fishtape job to an
  existing QBO sub-customer or project (a `Customer` with `IsProject: true`). A linked project's
  customer id is used as `CustomerRef` (**VERIFY** that QBO accepts a project id as `CustomerRef`; if
  not, use `CustomerRef` = parent and `ProjectRef` = project id). Fishtape never creates projects.
- When the option is off, every document and cost goes to the client's top-level customer.

### 4.4 Items (`items` and `Item`)

| Fishtape | QBO | Direction | Rule |
| --- | --- | --- | --- |
| `name` | `Name` | both | `qboName`, unique among items; collision: adopt-by-search first when a create's outcome was unknown (5.3); link if the existing QBO item is unlinked and has the same `nameKey`; add " (2)" only when the holder is already linked. |
| `sku` | `Sku` | both | |
| `description` (if present) | `Description` | both | |
| `priceCents` | `UnitPrice` | both | dollars with 2 decimals |
| `costCents` | `PurchaseCost` | both | |
| (none) | `Type` | push on create | `NonInventory` always. Pulled Service items become Fishtape items too. |
| (none) | `IncomeAccountRef`, `ExpenseAccountRef` | push on create | From mappings `account.income.default`, `account.expense.default` |
| deleted | `Active: false` | both | as for customers |

Items pulled from QBO keep their QBO `Type` in the link (`meta.qboType`). A Fishtape bill or PO line on
an item whose QBO type is `Inventory` is pushed as an `AccountBasedExpenseLineDetail` to the job-cost
account for its cost type (item name in the description), not as an item line: an item line on an
Inventory item would post to the inventory asset instead of job cost.
| `unit`, `category`, `labourHours`, `stock`, `reorderPoint`, `symbol` | none | Fishtape only | never sent |

QBO `TrackQtyOnHand`, `QtyOnHand`, tax codes on items: never written. Items need the `inventory` plan
feature (Pro, so always present when `quickbooks` is) and the `pricebook` or `inventory` module switch.
With both switches off, items sync stops (`blocked/module_off`) and documents use the generic items.

**Generic items** (mappings `item.*`), used on document lines without a linked item: `material`,
`labour`, `other`, `markup` (default: same as `material`), `travel` (default: same as `labour`),
`deposit` (for negative "less deposit" lines; default: same as `other`). Pulled lines on a generic item
map back to `kind` as named.

### 4.5 Employees

Link only. The wizard matches crew to QBO `Employee` rows by email, then name. Fishtape never creates or
edits QBO employees (payroll owns them). A subcontractor crew member may instead be linked to a QBO
`Vendor`; their time then goes out with `NameOf: 'Vendor'`. An unlinked employee's approved time stays
`blocked/employee_not_linked`, listed on the QuickBooks screen.

### 4.6 Vendors

| Fishtape | QBO | Direction |
| --- | --- | --- |
| `name` | `DisplayName` (rules as customers) | both |
| `companyName` | `CompanyName` | both |
| `email`, `phone`, `address` | `PrimaryEmailAddr`, `PrimaryPhone`, `BillAddr` | both |
| `accountNumber` | `AcctNum` | both |
| `t5018` | `T5018Eligible` (**VERIFY**) | both |
| `notes` | `Notes` | both |
| `active` / deleted | `Active` | both |

The vendor "Stripe" (for fee expenses) is created in QBO on first use and kept in mapping
`option.stripeVendorId`; it is not a Fishtape vendor.

### 4.7 Estimates and invoices

Header:

| Fishtape | QBO | Direction | Rule |
| --- | --- | --- | --- |
| `number` | `DocNumber` | both | Numbering, below. |
| `clientId` (+ `jobId`) | `CustomerRef` | both | Job linked and sub-customers on: the job's customer. Else the client's. Pull: a sub-customer maps to its job (if linked) and its parent's client. A change of client or job on an invoice that already has QBO payments is never pushed: it opens a `fields` conflict ("QuickBooks can't move an invoice with payments to another customer"). |
| `issueDate` (invoice), `createdAt` date (estimate) | `TxnDate` | both | Dates are taken in the company zone (`integrations/payments.js ZONES`), never the UTC date: an estimate created at 19:00 in Winnipeg is dated that day. Estimates gain no new field: pulled `TxnDate` goes to `issueDate`, which estimates may carry as an extra field. |
| `dueDate` | `DueDate` | both | invoices |
| `validUntil` | `ExpirationDate` | both | estimates |
| `notes` | `CustomerMemo.value` | both | max 1000 in QBO (**VERIFY**); longer notes are cut on push and flagged in the log. Canonical comparison cuts **both** sides to the same length, so a cut note never comes back and overwrites the full Fishtape note. |
| `title` | `PrivateNote` | push | `"<marker> · <title>"` (marker, 5.3). QBO edits to `PrivateNote` are ignored; the marker is put back on the next push. |
| `estimateId` | `LinkedTxn [{ TxnType: 'Estimate' }]` | both | Only the **first** invoice pushed for an estimate carries the link (QBO allows one invoice per estimate link); `meta.estimateLinked` on the estimate's link records it. |
| `status` | `TxnStatus` / void | both | Status rules, below. |
| (client email) | `BillEmail` | push | from the client |
| (none) | `GlobalTaxCalculation` | push on create | `TaxExcluded` when `features.salesTax`, else `NotApplicable`. Updates never change it: the value read from QBO is stored in `meta.globalTax` and sent back unchanged (4.8). |
| (none) | `EmailStatus`, `PrintStatus` | push | `NotSet` (Fishtape sends documents itself) |
| (none) | `AllowOnlineCreditCardPayment`, `AllowOnlineACHPayment` | push | `false` |
| (none) | `ClassRef`, `DepartmentRef`, `SalesTermRef` | push on create | Mapping defaults `class.default`, `department.default`, `term.default` when the feature is on and a default is set. Updates keep whatever QBO has. |
| (none) | `CurrencyRef` | push | CAD, only when multicurrency is on |
| `tm`, `payLink`, `billingMode`, `markupPct` | none | Fishtape only | `markupPct` is sent as a line (below) |

Lines (each Fishtape line becomes one `SalesItemLineDetail` line):

| Fishtape line | QBO line | Rule |
| --- | --- | --- |
| `itemId` (linked item) or `kind` | `SalesItemLineDetail.ItemRef` | Linked item, else the generic item for the kind (`material`, `labour`, `other`). An unlinked Fishtape item with `items: 'on_use'` is created first. |
| `description` | `Description` | |
| `qty` | `SalesItemLineDetail.Qty` | Sent with at most 5 decimals. |
| `unitCents` | `SalesItemLineDetail.UnitPrice` | unitCents / 100 |
| `lineCents(l)` | `Amount` | always `round(qty × unitCents) / 100`, the same rounding as money.js. QBO may refuse an `Amount` that differs from its own `Qty × UnitPrice` (fault 6000; **VERIFY**, 11.4). If the sandbox shows it does, a line whose 5-decimal `Qty × UnitPrice` does not round to `Amount` is sent as `Qty 1`, `UnitPrice` = amount, with " (<qty> h × $<rate>)" added to `Description` and its index recorded in `meta.lossyLines` (common on T&M hours such as 2.6667 h × $95.00). |
| kind + document taxes | `SalesItemLineDetail.TaxCodeRef` | Tax, 4.8 |
| `labourHours`, `changeOrderId` | none | kept in Fishtape; `meta.lineIds` keeps the line pairing so a pull does not lose them |
| (QBO-only line attributes) | `ServiceDate`, `ClassRef`, line `DepartmentRef` | Never modelled. A full or sparse update sends the whole `Line` array, so each Fishtape line is matched to its QBO line by `meta.lineIds` and the QBO line's unmodelled attributes are copied onto the line sent. |
| markup | an extra line | When `docTotals(doc).markupCents > 0`: one line on the `markup` item, qty 1, amount = markupCents, description "Materials markup (<pct>%)", tax code of material lines. |
| negative line (credit, "less deposit") | `SalesItemLineDetail` with negative `Amount` on the `deposit` item | **VERIFY** that QBO accepts negative sales lines. If it does not: send a `DiscountLineDetail` (amount, not percent) when `features.discounts` **and** the document's tax applies to every kind alike (QBO spreads a discount over every taxable line, while Fishtape's negative `other` line reduces only the `other` base; under BC rules the PST would differ). Otherwise the document goes to `error/negative_line`. |

Pulled QBO lines become Fishtape lines:

- `SalesItemLineDetail`: `kind` from the item (generic item: its kind; linked Fishtape item: `material`;
  unlinked Service item: `labour`; other unlinked items: `material`, and the item is pulled first).
  `qty` = `Qty`, `unitCents` = `round(UnitPrice × 100)` when `round(qty × unitCents)` equals
  `round(Amount × 100)`; otherwise the line becomes qty 1 with `unitCents` = amount cents and the
  description gets " (<Qty> × $<UnitPrice>)", index recorded in `meta.lossyLines`.
- A line on the `markup` item whose description starts "Materials markup": if its amount equals
  `round(materialCents × markupPct / 100)` for the record's current `markupPct`, it stays as
  `markupPct`; otherwise `markupPct` becomes 0 and the line becomes a material line.
- `DescriptionOnly`: a Fishtape line with `kind: 'other'`, qty 0, unitCents 0 and the text.
- `DiscountLineDetail`: an `other` line, qty 1, negative amount, description "Discount".
- `SubTotalLineDetail`: ignored. `GroupLineDetail`: each inner line as above.

Comparison and merge use the **canonical line** `{ itemRef, kind, description, amountCents, taxCodeId }`
(qty and unit price are not compared; the amount is the money; the tax is compared as the QBO `TaxCode`
id the line's key maps to, 4.8). For lines listed in `meta.lossyLines` the canonical description strips
the " (<Qty> × $<UnitPrice>)" suffix, so the lossy pull never ping-pongs, and a lossy line is never
pushed back unless its amount, item or tax changed (then it is sent as qty 1 with the plain
description).

**Numbering (DocNumber)**, option `numbering`:

- `fishtape` (default, needs `features.customTxnNumbers`): Fishtape assigns numbers, also offline.
  Pushes send `DocNumber` = `number` (max 21 characters; longer: `error/number_too_long`). QBO-created
  documents keep their QBO `DocNumber` as Fishtape `number`. After a pull, if the number matches
  `^<prefix>-(\d+)$` (`INV`, `E`) and is at or above `settings.nextNumbers.<kind>`, the engine raises
  `nextNumbers.<kind>` to number + 1 with a system patch that keeps the settings record's `updatedAt`
  (so an offline settings edit on a device still wins LWW, and `rebaseSettings` keeps the higher number).
  The guide recommends that documents created in QuickBooks use another prefix (for example plain
  numbers), so the two never meet. Never send `include=allowduplicatedocnum`.
- **Fishtape-side duplicates** (two offline iPads both issued INV-3005): before pushing a create, the
  engine looks for another non-deleted Fishtape document of the same kind with the same `number`. If one
  exists and is already linked, this one is `blocked/duplicate_number_local` and the badge offers
  "Renumber".
- QBO fault 6140 (duplicate DocNumber): first adopt-by-search (5.3; the holder may be our own earlier
  create). Otherwise the link goes to `error/duplicate_number` and the badge offers "Renumber".
- **Renumber** (`POST /api/v1/qbo/records/:collection/:id/renumber`) takes the next number on the server
  (the highest of `settings.nextNumbers.<kind>` and every Fishtape and QBO number of that kind, plus 1),
  patches the record and the setting, and re-pushes. If the document has `sentAt` (the customer already
  has it), the sheet warns "The customer has this as <old number>" and the PWA asks to confirm first.
- `quickbooks`: allowed only when `features.customTxnNumbers` is false. Pushes omit `DocNumber`; after
  create, the Fishtape `number` is replaced with QBO's (system patch, `updatedAt` kept). The mappings
  screen warns that a document already emailed from Fishtape will change number. In this mode, creates
  rely on the marker for adopt-by-search (no DocNumber to collide).
- At setup the wizard shows the highest numeric QBO `DocNumber` per kind and offers to raise
  `nextNumbers` above it.

**Status rules**

The canonical `status` of an invoice is `open` or `void` only. Fishtape's `sent`, `partial` and `paid`
all canonicalise to `open` (they follow from payments and from the QBO balance), so a Stripe payment
never causes a status push or a status conflict.

| Fishtape invoice status | QBO |
| --- | --- |
| `draft` | not pushed (unless "Send to QuickBooks now", which pushes it as a normal invoice) |
| `sent`, `partial`, `paid` | normal invoice |
| `void` | `POST /invoice?operation=void`, only when the QBO `Balance` equals its `TotalAmt` (no payments or credits applied). Otherwise a `deleted`-kind conflict opens: "This invoice has payments in QuickBooks. Remove them there first, or keep it open." Nothing is unapplied silently. |

Pull order for invoices: **void detection comes first and only sets status**. A QBO void is recognised by
a `voided` webhook confirmed by the CDC object, or by a CDC object with `TotalAmt` 0, every line amount 0
and `PrivateNote` starting "Voided" (**VERIFY** a reliable void marker). A voided object sets Fishtape
`status: 'void'` and nothing else: its zeroed lines are never merged into Fishtape. Payment lines that the
void unapplied are handled by 4.9 (never a silent delete). A deleted QBO invoice also sets
`status: 'void'`, appends "Deleted in QuickBooks on <date>" to `notes`, and sets the link to
`deleted_remote` (Fishtape never hard-deletes an invoice from a pull). Otherwise Fishtape status is
recomputed with `refreshInvoiceStatus` (server `integrations/payments.js`) after payments.

Un-void: QBO cannot un-void. A Fishtape invoice set back from `void` to `sent` whose QBO copy is voided
opens a `deleted` conflict: "Voided in QuickBooks. Create a new invoice in QuickBooks?" (`'restore'`
creates a new QBO invoice; `number` must change first if `numbering` is `fishtape`, so the resolve
renumbers).

| Fishtape estimate status | QBO `TxnStatus` (push) | QBO to Fishtape (pull) |
| --- | --- | --- |
| `draft` | not pushed | |
| `sent` | `Pending` | `Pending` to `sent` |
| `accepted` | `Accepted` (+ `AcceptedDate` today, company zone) | `Accepted`, `Closed`, `Converted` to `accepted` |
| `declined` | `Rejected` | `Rejected` to `declined` |

`TxnStatus` is sent only when the canonical status changed since the snapshot, and never when QBO's
current `TxnStatus` is `Closed` or `Converted` (that would reopen an estimate QBO already converted and
invite a second conversion).

Fishtape delete of a linked estimate: QBO delete. QBO delete of a linked estimate: Fishtape soft delete
by the system actor, unless Fishtape changed it since the snapshot (then a `deleted` conflict).
Fishtape delete of a linked invoice: QBO **void** (never delete; keeps QBO's audit trail), under the same
balance rule as a Fishtape void. If QBO refuses (a deposited payment, closed books, a balance), the engine
**restores** the Fishtape record (`records.restoreRecord` as the system actor) and opens a `deleted`
conflict, so Fishtape never shows an invoice as gone while it is open or paid in QBO.

Restore in Fishtape of an invoice whose link is `deleted_local` (QBO copy voided): the link is kept
pointing at the voided QBO object and a `deleted` conflict opens ("Voided in QuickBooks; create a new
invoice in QuickBooks?"), as for un-void. It is never re-created under the voided DocNumber by itself.

**T&M invoices** are ordinary invoices: their lines (labour hours at the rate, travel, material at cost
plus markup) go out like any lines; `tm` stays in Fishtape. Time entries billed on them were pushed as
`NotBillable` time (4.11), so QBO never offers them for billing again.

**Change orders** reach QBO only as invoice or estimate lines (Fishtape keeps `changeOrderId` through
`meta.lineIds`). QBO's premium change-order API is not used.

**Deposits and progress billing**: Fishtape bills a deposit as its own invoice and credits it on the
final invoice with a negative "less deposit" line (rules above). QBO progress invoicing is not used. A
pulled QBO invoice with a `Deposit` amount gets a Fishtape payment for that amount (link role `deposit`,
method `transfer`, reference "Deposit in QuickBooks").

### 4.8 Canadian sales tax

Fishtape's model: each document carries `taxes[]` components (`{ id, label, pct, applies: { material,
labour, other } }`, from `lib/tax.js`), taxed per kind on the summed base and rounded once per
component (`money.js docTotals`). QBO's model: a `TaxCodeRef` per line; QBO sums the taxable amounts
per **rate** and rounds per rate (`TxnTaxDetail.TaxLine` per rate).

**Tax key per line.** `lineTaxIds(doc, kind)` and `taxKey(ids, doc.taxProvince)` from
`electrical-app/js/lib/qbo-export.js` (the CSV export's keys): `'GST+RST|MB'`, `'GST'`, `'HST|ON'`,
the legacy `'TAX'`... Each line (and the markup line) gets the key of its kind. W2's `lineTaxKey`
refines `'NONE'` with the document's `taxNoneReason`: `'NONE|ZERO'` (zero-rated), `'NONE|EXEMPT'`
(exempt supply), `'NONE|OOS'` (out of scope), `'NONE|RELIEF'` (Indian Act s.87 or similar relief). A
document with `NONE` lines and no `taxNoneReason` is not pushed: `blocked/tax_reason` ("Pick why this
has no tax"). Each reason lands on different GST return lines, so each has its own mapping. A customer
who quotes a PST/RST licence still pays GST: that is the new `gst-only` treatment (3.6), key `'GST'`,
never `NONE`.

**Key to QBO code.** Mapping `taxCode.<key>` holds a QBO `TaxCode` id. Setup requires a mapping for
every key the company uses: the keys of `taxComponents` for the company province and each of its
treatments (`treatmentsFor(province)`), the four `NONE|*` keys, and any key found on open documents
(the legacy `TAX` included). The mappings screen suggests codes **by rates, never by name alone**: for
`GST+RST|MB` an active code whose `SalesTaxRateList` holds exactly an active 5% and an active 7% rate (so
the legacy 8% PST MB rate is never picked). `NONE|ZERO` suggests a code named like "Zero-rated",
`NONE|EXEMPT` "Exempt", `NONE|OOS` "Out of Scope"; `NONE|RELIEF` has no suggestion (the accountant picks).

**Reverse (pull).** Several keys may map to one code (`GST+RST|MB` and the legacy `TAX` at 12% both to
"GST/PST MB"). Canonical lines compare the **code id** (above), so the choice of key never makes a
difference by itself. On pull, a line keeps the key the Fishtape document already uses for that kind
when that key maps to the pulled code; otherwise it takes the first non-legacy key mapped to it. The
province comes from the key's suffix (`'HST|ON'` gives ON), not from the company province, so a TG job
in Kenora taxed "HST ON" in QBO pulls as HST. A pulled document gets `taxProvince` from those keys (the
company province when no key has a suffix), and `taxes[]` built from the keys used per kind: components
from `taxComponents({ province, treatment, date: TxnDate })` filtered to the key's ids, with
`applies[kind]` true for each kind whose lines carry that key; `taxPct` = `combinedPct`.
`taxTreatment` = the treatment whose components produce those keys (else `custom`); a `NONE|*` key sets
`taxNoneReason`. If one kind has lines with **different** keys (QBO allows per-line codes; Fishtape taxes
per kind), or a code has no mapping, the document is still created but goes to `needs_review` (reason
`tax_shape`), owner `quickbooks`.

**Tax-inclusive documents.** Push always creates with `TaxExcluded`. On pull, the engine reads
`GlobalTaxCalculation` first:

- Invoices and estimates with `TaxInclusive` are not converted. The Fishtape copy carries QBO's gross
  line amounts and no `taxes[]` (so its total equals QBO's), and goes to `needs_review` (reason
  `tax_inclusive`), owner `quickbooks`, with QBO's tax shown. The office decides in QBO.
- Bills and receipts (QBO `Bill`, `Purchase`) with `TaxInclusive` (receipts are usually entered that way):
  the lines are converted to net amounts. Each line's net = its amount minus its share of
  `TxnTaxDetail.TotalTax`, shared pro rata by line amount among the lines whose code carries tax, the
  rounding remainder on the largest line; `taxes[]` come from the `TaxLine`s. The link is owner
  `quickbooks` (Fishtape edits are not pushed; the badge says "Edit in QuickBooks"), so the conversion
  never goes back.
- No update ever changes `GlobalTaxCalculation` on an existing QBO object: `meta.globalTax` holds what QBO
  has and is sent back as is.

**Before a create or a tax-changing update** (no CorePlus call: rates come from `qbo_reference`):
compute QBO's expected tax per rate from the mapped codes' `TaxRate` percentages in force on `TxnDate`.
If the mapped code's rates do not equal the document's `taxes[].pct` (for example the code still holds
the old 8% PST), the push is refused before anything reaches QBO: `blocked/mapping_missing`, message
"QuickBooks code <name> charges 5% + 8%; this invoice charges 5% + 7%".

**Totals check after the write** (the create/update response carries `TxnTaxDetail`, so no extra read).
A create and its override are one state machine: the link stays `pending` with reason `tax_override`
until the override is done or refused, then moves to `synced` (or `error`):

- compare Fishtape's per-component cents (`docTotals`) with QBO's `TaxLine` amounts, matched by rate;
- equal: done;
- each rate differs by **2 cents or less**: send one sparse update with `TxnTaxDetail` holding a
  `TaxLine` for **every** `TaxRateRef` of the code(s), with Fishtape's amounts, and `TotalTax` =
  Fishtape's tax. If QBO refuses (a `ReadOnly` rate, fault 6000/-37100), keep QBO's amounts, store
  `meta.taxDeltaCents` (QBO total minus Fishtape total) and log a warning; the badge says "QuickBooks tax
  differs by $0.01". From then on the amount due and the status of that invoice use the QBO total (4.9,
  "Amount due");
- more than 2 cents on any rate after a **create**: the engine deletes the invoice it just created (it is
  seconds old and has no payments; `POST /invoice?operation=delete`), clears `qbo_id`, and sets
  `error/tax_mismatch` with both totals. Nothing wrong stays in AR or in the GST return. After an
  **update**: QBO keeps the update, the link goes to `error/tax_mismatch`, and the office is notified at
  once (not only in the daily summary).

On pull, Fishtape recomputes its own tax. If that differs from QBO's `TotalTax` by 2 cents or less per
rate, the engine pushes the same override back to QBO (Fishtape's arithmetic is the truth, because it is
what the customer saw) unless the invoice has payments in QBO, in which case it only records
`meta.taxDeltaCents`. More than 2 cents: `needs_review` (reason `totals_differ`).

**Filed GST periods.** A push that would change the lines, tax, total or `TxnDate` of a QBO document
dated on or before `taxFiledThrough` (2.8) is not sent: the link goes to `needs_review` (reason
`filed_period`, "This changes a GST period already filed"). The office either confirms (resolve
`'fishtape'`, which sends it) or reverts the edit in Fishtape. A new document dated on or before that
date is also held this way, except wizard creates the office ticked explicitly (6.4). `BookCloseDate`
still applies as before (`blocked/books_closed`).

`GlobalTaxCalculation`: if QBO sales tax is off (`features.salesTax` false) and the company charges tax,
setup cannot finish ("Turn on sales tax in QuickBooks first"); sales tax cannot be turned on through the
API.

TG Electrical: `GST+RST|MB` (Manitoba default treatment `pst-all`, RST on the whole contract) maps to
"GST/PST MB" at 5% + 7%; `GST` (the new `gst-only` treatment) to "GST"; `NONE|EXEMPT` to "Exempt";
`NONE|ZERO` to "Zero-rated"; `NONE|OOS` to "Out of Scope". The sandbox must confirm the code names and
that the response has two `TaxLine`s (**VERIFY**).

**Purchases (bills and receipts).** Mapping `purchaseTaxCode.<key>`, where the key comes from the bill's
`taxes[]` ids and province (`'GST+RST|MB'`, `'GST'`, `'NONE'`). Default rule, which the accountant only
confirms (checklist step 7): **PST and RST paid on purchases are not recoverable**; GST, HST and QST are
(input tax credits and refunds). So:

- a purchase key containing `PST` or `RST` maps to a code carrying only its recoverable part (`GST+RST|MB`
  to the GST purchase code; `GST+PST|BC` to GST; `HST|ON` keeps HST; `GST+QST|QC` keeps both);
- the bill's printed PST/RST cents are added into the line amounts, pro rata by line amount, rounding
  remainder on the largest line, so the RST lands in job cost. W2's canonical bill form applies the same
  spread, so the round trip is stable; a bill later pulled back shows the spread line amounts and the
  recoverable tax only;
- the mappings screen refuses (400 `validation_failed`) a `purchaseTaxCode` for any key whose code's
  `PurchaseTaxRateList` holds a rate whose agency is a provincial PST/RST agency (by `TaxRate.AgencyRef`
  and the agency name; **VERIFY** how QBO's Canadian tax engine treats MB PST on purchases, 11.4);
- after the push, if QBO's recoverable tax differs from the printed recoverable cents, the engine
  overrides `TxnTaxDetail` with the printed amounts (**VERIFY** overrides on purchases).

### 4.9 Payments

| Fishtape payment | QBO `Payment` | Direction |
| --- | --- | --- |
| `invoiceId` | `Line[].LinkedTxn [{ TxnId: <invoice>, TxnType: 'Invoice' }]` | both |
| `amountCents` | `Line[].Amount` (and `TotalAmt`, below) | both |
| `date` | `TxnDate` | both |
| `method` | `PaymentMethodRef` (mapping `paymentMethod.<method>`) | both |
| `reference` | `PaymentRefNum` (max 21; canonical comparison cuts both sides to 21, so a cut reference never comes back over the full one) | both |
| (the invoice's QBO customer) | `CustomerRef` = the linked QBO invoice's own `CustomerRef` (the job sub-customer when there is one; **VERIFY** whether QBO also accepts the parent) | push |
| (method, source) | `DepositToAccountRef` (mapping `depositTo.<method>`, default Undeposited Funds; Stripe payments: `account.stripeClearing`) | push |
| (marker) | `PrivateNote` = `"<marker>"` plus, for Stripe, `" · <PaymentIntent id>"` | push |

Method keys are normalised before any mapping lookup: `cheque` and `check` are one key, `check`;
`etransfer`, `e-transfer` and `interac` are `e-transfer`; unknown methods use `paymentMethod.other`
(optional; none set means no `PaymentMethodRef`).

**Push rules**

- The invoice must have a link with a `qbo_id` (any state, 5.3); otherwise `blocked/dependency`.
  Payments on void invoices are not pushed. A payment with no `invoiceId` is never pushed
  (`blocked/no_invoice`, "Not sent: no invoice").
- Money payments follow the origin rule of 5.2 (an API key's or agent's payment waits for an office
  user).
- **Applied amount cap.** The amount applied to the invoice is at most the QBO invoice's current
  `Balance` (read from the CDC object or the link's last pull). Any excess goes to the payment as
  unapplied (`TotalAmt` includes it) with a log warning ("$0.01 left as credit in QuickBooks"). This
  absorbs a refused tax override (4.8) and never fails the push.
- **Fishtape owns only its own lines.** A QBO Payment can carry lines Fishtape does not own: lines on
  credit memos, journal entries, invoices that are not linked (often dated before `syncFrom`), and an
  unapplied amount. The pull records them in `meta.foreignLines` and `meta.unappliedCents` and logs
  them. A push never removes or changes them:
  - a change of `method`, `reference` or `date` only is a **sparse header update** (no `Line`, no
    `TotalAmt`; **VERIFY** sparse on Payment, else a full update built from the current object with
    every `Line` kept unchanged);
  - a money change starts from the **current** QBO `Line` array, replaces only the lines Fishtape owns
    (matched by `qbo_line` = invoice id), keeps every other line as it is, and sets `TotalAmt` = Σ(new
    owned lines) + Σ(foreign lines) + the unapplied amount as it was;
  - if the payment is already in a QBO deposit (its `DepositToAccountRef` is a bank account, or it is
    linked from a `Deposit`) and `TotalAmt` would change, nothing is sent: a `fields` conflict opens
    ("Deposited in QuickBooks; change it there").
- **Fishtape delete** of a payment:
  - the QBO Payment has no other owned line, no foreign line and no unapplied amount: void it
    (`POST /payment?operation=update&include=void`, sparse); if it is deposited, `error/deposited`
    ("Remove it from the deposit in QuickBooks first");
  - otherwise only this Fishtape payment's line is removed and its amount becomes unapplied (`TotalAmt`
    unchanged). If the payment is deposited, a `deleted` conflict opens instead;
  - a payment that has lines Fishtape does not own is **never voided**.

**Pull rules**

- A QBO payment applied to **several** linked invoices becomes one Fishtape payment per applied invoice
  (links share the QBO id, `qbo_line` = invoice id).
- **QBO delete or void of a payment**, or a line that disappears (for example unapplied by a QBO void of
  the invoice), or a line that moves to another invoice:
  - Fishtape payments with `source: 'stripe'`, and any payment first created in Fishtape (its link was
    created by a push), are **never deleted by a pull**: a `deleted` conflict opens ("Removed in
    QuickBooks: <date>. The money was received in Stripe. Keep it in Fishtape and send it again, or
    delete it here?");
  - a line that moved to another invoice opens a `fields` conflict on `invoiceRef`; it is never read as a
    delete plus a create;
  - payments first created in QBO (pulled) are soft-deleted by the system actor as before, and the
    invoice status is refreshed.
- **Settlement in QBO.** After an invoice's pull, when none of its payment links is `pending`, the
  engine computes `settled` = (QBO `TotalAmt` − QBO `Balance`) − Σ(amounts of QBO payment lines on this
  invoice that are linked to Fishtape payments). This is what QBO applied by credit memos, journal
  entries, or payments Fishtape does not have (for example before `syncFrom`). If `settled > 0`, the
  engine creates or updates one Fishtape payment (link role `settlement` on the invoice, owner
  `quickbooks`, never pushed): `method: 'credit'`, `source: 'quickbooks'`, `amountCents` = settled, `date`
  = the latest of those QBO transactions' dates (else today), `reference` "Credited or paid in
  QuickBooks". If `settled` drops to 0, the engine deletes that payment. So an invoice settled in QBO is
  shown paid in Fishtape, its pay link stops and its reminders stop, without new rules elsewhere. The
  same runs after a look-up import (7.8) and after the wizard links an invoice.
- **Amount due.** W6 adds `amountDueCents(tx, invoice)` to `integrations/payments.js` (total − payments
  + the registered adjustment) and uses it in `refreshInvoiceStatus` (paid when ≤ 0) and for the Stripe
  pay-link amount. W3 registers the adjustment through `registerAmountDueAdjuster(fn)` at start-up: for an
  invoice whose link has `meta.taxDeltaCents`, it returns that delta, so the customer is charged the QBO
  total and a $1,120.00 QBO payment marks a $1,120.01 Fishtape invoice paid.

**Stripe payments** (Fishtape payments with `source: 'stripe'`), the clearing-account pattern:

0. **Cutover.** Mapping `option.stripeCutover` (a date, default `syncFrom`, set in the wizard). A Stripe
   payment whose charge was created before it is never pushed (`skipped`, "Already in your books"), and
   neither is any payout that contains such a charge (below). Before the cutover the bookkeeper's own way
   of booking Stripe stays in charge.
1. `Payment` for the **gross** amount into `account.stripeClearing` (a QBO Bank account named "Stripe"),
   method `paymentMethod.card`, `PaymentRefNum` = the PaymentIntent id cut to 21 characters (the full id
   is in `PrivateNote`).
2. When `stripe.feeCents` is known (W6 fills it shortly after the webhook), a `Purchase` (link role
   `fee`, `meta.dependsOn` = the main link): `PaymentType: 'Cash'`, `AccountRef` =
   `account.stripeClearing`, `EntityRef` = the "Stripe" vendor, one `AccountBasedExpenseLineDetail` line
   to `account.stripeFees` for the fee, `TaxCodeRef` from `purchaseTaxCode.stripeFee` (default `NONE`;
   accountant decides), `TxnDate` = payment date, `PrivateNote` "<marker> · Stripe fee <charge id>".
   Option `recordStripeFees` (default true). It is never pushed before the main Payment exists; if the
   main Payment is deleted or voided (either side), the fee Purchase is deleted too.
3. Each Stripe **payout** (`stripe_payouts`) becomes a `Transfer` from `account.stripeClearing` to
   `account.stripePayoutBank` for `amount_cents`, `TxnDate` = arrival date, `PrivateNote` "<marker> ·
   Stripe payout <po id>", option `recordStripePayouts` (default true), under these rules:
   - skipped (log only): `livemode` false (test mode), currency not `cad`, or `earliest_charge_at`
     before the cutover;
   - W6 stores the payout's balance transactions (`GET /v1/balance_transactions?payout=<id>`, automatic
     payouts only) in `balance_txns`. A manual payout (`automatic` false) cannot be itemised and goes to
     `needs_review/payout_items`;
   - each `charge`/`payment` item must belong to a Fishtape Stripe payment whose `main` link is `synced`
     and, with `recordStripeFees`, whose `fee` link is `synced`; otherwise the payout waits
     (`blocked/stripe_unbooked`, `meta.dependsOn` = those links). A charge that is not a Fishtape payment
     (the tenant uses Stripe for something else) sends the payout to `needs_review/payout_items`;
   - fee items that belong to no charge (`stripe_fee` such as Radar or Billing fees, the payout's own
     fee for instant payouts, dispute fees) are booked as one `Purchase` (link role `fee` on the payout's
     link) to `account.stripeFees`, paid from the clearing account, one line per item;
   - refunds, dispute amounts, reversals and other adjustments are not booked by Fishtape: the payout
     goes to `needs_review/payout_items` listing them. Resolving with "I entered these in QuickBooks"
     (`'fishtape'`) pushes the Transfer;
   - `fee_cents` (Stripe's summary) is informational and never posted;
   - a payout that turns `failed` after `paid` (`paid_seen` true): the engine deletes its Transfer and
     its payout fee Purchase, and logs it. A `canceled` payout is never pushed.
   With every charge, fee and payout booked this way, the clearing account moves by exactly what Stripe
   moved. The daily check (5.13) compares its QBO balance with the expected one.

Stripe refunds are out of scope; a refund that reaches a payout sends that payout to review (above),
and the guide explains how to enter it by hand.

### 4.10 Bills, receipts and purchase orders

Bill (`kind: 'bill'`) to QBO `Bill`; receipt (`kind: 'receipt'`) to QBO `Purchase`:

| Fishtape | QBO | Rule |
| --- | --- | --- |
| `vendorId` | `VendorRef` (Bill) / `EntityRef` (Purchase) | vendor pushed first |
| `number` | `DocNumber` | max 21 (longer: cut, and the full number goes to `PrivateNote`; canonical comparison cuts both sides) |
| `date`, `dueDate` | `TxnDate`, `DueDate` | |
| `paidWith` | `PaymentType` (`CreditCard` for card, `Cash` for cash and debit, `Check` for cheque and transfer) and `AccountRef` = mapping `paidFrom.<paidWith>` | receipts |
| line with linked `itemId` | `ItemBasedExpenseLineDetail { ItemRef, Qty, UnitPrice }` | except items whose QBO type is `Inventory`: sent as an account line (4.4) |
| line without item | `AccountBasedExpenseLineDetail { AccountRef }` = mapping `account.jobCost.<costType>` (default `account.jobCost.material`) | |
| line `jobId` (or bill `jobId`) | `CustomerRef` = the job's sub-customer (or the job's client) | job costing |
| (all lines) | `BillableStatus: 'NotBillable'` | Fishtape bills T&M material itself; QBO never offers these for invoicing |
| `taxes` + province | `TaxCodeRef` per line from `purchaseTaxCode.<key>` (recoverable part only; PST/RST spread into line amounts), then `TxnTaxDetail` override (4.8) | |
| (QBO-only line attributes) | `ClassRef`, line `DepartmentRef`, `BillableStatus` of a line already billed, `CustomerRef` on lines Fishtape has no job for | Kept: updates start from the current QBO lines matched by `Line.Id` (`meta.lineIds`) and copy these attributes onto the lines sent |
| `poLine` | `LinkedTxn [{ TxnId: <PO>, TxnType: 'PurchaseOrder', TxnLineId: <QBO PO line id> }]` on that line | Bills only; the PO must be pushed first |
| `notes` | `PrivateNote` | `"<marker> · <notes>"` |
| `receipt` | `Attachable` upload (`POST /upload`, `Category: 'Receipt'`) to the Bill/Purchase | push once; replaced if the photo changes |
| `status: 'void'` or deleted | QBO delete (Bills and Purchases have no void). Paid bills: `error/paid`. QBO refuses: the Fishtape record is restored and a `deleted` conflict opens (as for invoices, 4.7) | |
| `kind` changed on a linked bill (`bill` to `receipt` or back) | the old QBO object is deleted and the new one created, in that order, only while the bill is unpaid in QBO; a paid bill's `kind` change is not pushed (`fields` conflict, "Paid in QuickBooks; change it there") | |
| negative receipt (supplier refund or card credit) | `Purchase` with `Credit: true` and positive amounts | sign mirrored both ways: a pulled `Credit: true` Purchase becomes a receipt with negative line amounts and taxes |
| `status: 'paid'` | from QBO only: a pulled Bill with `Balance` 0 sets `paid`; a later balance sets `open` | |
| `totalCents` | (none) | Not sent; QBO computes its total. A bill whose lines + taxes differ from `totalCents` by more than 2 cents is not pushed (`blocked/totals_mismatch`), so AP always matches the supplier's statement. |

Pull: a QBO Bill or Purchase is pulled only if at least one line has `CustomerRef` pointing to a linked
client or job (option `pullJobCosts`, default true). Others are ignored, so the general books stay out
of Fishtape. A `BillPayment` change re-reads the bills it links to (through CDC) to update `status`. A
pulled `TaxInclusive` Bill or Purchase is converted to net amounts and linked owner `quickbooks` (4.8).

Purchase order (push, needs `features.purchaseOrders`):

| Fishtape | QBO `PurchaseOrder` |
| --- | --- |
| `vendorId` | `VendorRef` |
| `number` | `DocNumber` (if `features.purchaseCustomTxnNumbers`, else omitted) |
| `date`, `expectedDate` | `TxnDate`, `DueDate` (**VERIFY** `ExpectedDate` vs `DueDate`) |
| lines | `ItemBasedExpenseLineDetail { ItemRef (linked or generic material), Qty, UnitPrice, CustomerRef (job) }` |
| `shipTo` | `ShipAddr` |
| `notes` | `Memo` |
| `status` `open`/`sent` | `POStatus: 'Open'` |
| `status` `closed` | `POStatus: 'Closed'` |
| `status` `cancelled` or deleted | delete if no bill links it, else close |

Pull for POs: only `POStatus` (QBO closes a PO when bills use it up): `Closed` sets Fishtape `closed`,
`closedAt`. Other QBO edits are ignored and logged.

### 4.11 Time (`timeEntries` to `TimeActivity`)

Pushed when `approved === true`, the entry has a clock-out, its date is on or after `sync_from`, the
employee is linked, `features.timeTracking` is on, option `syncTime` is on (default true) and option
`timeOwner` is `fishtape` (the wizard asks: "Which system holds payroll hours: Fishtape or QuickBooks
Time?"; with `quickbooks`, no time is pushed, so hours are never entered twice).

| Fishtape | QBO `TimeActivity` |
| --- | --- |
| employee link | `NameOf: 'Employee'` + `EmployeeRef` (or `NameOf: 'Vendor'` + `VendorRef`) |
| `jobId` | `CustomerRef` = the job's sub-customer, or the job's client, or none |
| `kind` (`work`/`travel`) | `ItemRef` = generic `labour` or `travel` item |
| clock-in local date (company zone, `integrations/payments.js ZONES`) | `TxnDate` |
| net worked minutes: `Math.round(entryHours(e) × 60)` (`money.js entryHours` already deducts `breakMins`; do not deduct it again) | `Hours` + `Minutes` (net; no start/end times, so time zones cannot shift it) |
| `note`, job number and title | `Description` ("J-1042 Panel upgrade - <note> · <marker>", max 4000; the marker is the adopt-by-search key, 5.3) |
| (none) | `BillableStatus: 'NotBillable'` (never changed later; QBO cannot change it after create) |

Edits after push (a re-approval after a manager's edit): update the TimeActivity. Un-approved or
deleted in Fishtape: delete the TimeActivity.

**Pay-period lock.** Option `timeLockedThrough` (a date; the office moves it forward after each pay run,
and the wizard sets it to the last pay period run). An update or delete of a TimeActivity dated on or
before it is not sent: the link goes to `needs_review` (reason `payroll_locked`, "Hours already paid;
change them in QuickBooks Payroll if needed"). A new approved entry dated on or before it is held the same
way. Paid history is never rewritten from Fishtape. Changed or deleted in QBO: not merged (Fishtape is the
truth for time); a QBO change is logged as a warning and the next Fishtape change overwrites it; a QBO
delete sets the link to `deleted_remote` and the record page offers "Send to QuickBooks again".

Payroll: whether API-created TimeActivity pre-fills Canadian QuickBooks Payroll cheques is unconfirmed
(`timesheet.js` notes QBO Payroll Canada has no hours import; BACKLOG says VERIFY). The integration
pushes the time either way; open question 13.7 covers what TG uses for payroll.

---

## 5. The two-way sync engine

### 5.1 Overview

```
 device/REST write ─► records.js ─► qbo hook ─► qbo_outbox ─┐
 Fishtape-side sweep (5.12) ───────────────────► qbo_outbox ─┤
                                                             ├─► qbo_sync job (one per tenant at a time)
 Intuit webhook ─► verify ─► dirty_at / qbo_inbox ──────────┘        │
 schedules: qbo_dispatch (1 min), qbo_cdc (6 h), qbo_check + housekeeping (daily)
                                                                      ▼
                         push: outbox by rank ─► reconcile(link) ◄─ pull: CDC (all entities) by entity rank
                                       │                 │
                         system patch to Fishtape     sparse update / create in QBO
                         (devices get it on next pull)   (requestid, SyncToken, marker)
```

Everything runs in the worker's QuickBooks pool (5.8). One `qbo_sync` job per tenant runs at a time
(lease, 5.8). Each pass: pull first (so pushes merge against fresh QBO data), then push, then pull once
more if the push wrote anything (picks up QBO-side recalculation such as tax). Only a connection in
`active` pushes; `setup` runs reference reads, the scan and the wizard apply only.

### 5.2 Push: the records hook

`server/src/services/records.js` (W3) calls the QBO hook after every write and **every delete** (REST
and sync paths, including the delete paths that have no hook today):

```js
qboAfterWrite(tx, coll, id, before, after, who, { stale, held })   // after create, update, restore
qboAfterDelete(tx, coll, id, before, who, { stale })                // after soft delete
```

`stale` is true when a sync mutation was not fresh (`baseVersion !== cur.version`); `held` holds device
money values kept out of the record (below). The hook:

1. returns at once when QBO is not configured on the server (`cfg.qbo.enabled` false; no query);
2. returns unless `coll` is one of `clients, jobs, items, vendors, estimates, invoices, payments, bills,
   purchaseOrders, timeEntries`;
3. returns when `who.actor.type === 'system' && who.actor.id === 'qbo'` (the engine's own writes:
   loop prevention, first layer);
4. returns unless the tenant has a `qbo_connections` row, **in any state** (one query per transaction,
   cached on the `TenantTx`). Rows written while sync is off wait (2.5);
5. classifies the actor as `actor_type`: `api_key` (`who.kind === 'api_key'`), `agent` (`who.actor.type
   === 'agent'`: the assistant and background agents), `stripe` (the Stripe system actor), `system`
   (other system actors), `field_user` (a session whose role is foreman, electrician or apprentice, or a
   crew session), else `user`;
6. upserts `qbo_outbox (collection, record_id, op, stale, held, actor_type, rank, not_before = now() +
   20 s)`. On conflict: keep the earliest `enqueued_at`; `stale = old OR new`; `held` = old merged with
   new; `op` = the new op; `actor_type` = the new one unless the old one is `api_key` or `agent` (a burst
   that includes an API-key or agent write stays held for review); move `not_before` to now + 20 s;
   clear `claimed_until` (a newer edit must not be deleted by the pass that claimed the older one, 5.3);
7. when the connection is `active` (shadow mode included): enqueues `qbo_sync` with
   `dedupeKey: 'qbo_sync:<tenantId>'`, `runAt: now + 20 s`, `tenantId`, in the same transaction (the
   20 s debounce groups a burst of edits into one pass).

It never throws (it runs in a savepoint; a failure is logged, and the dispatcher and the sweep catch up).

**Origin rule** (checked when the outbox row is processed, 5.3; QBO is the books, so money only reaches it
from people allowed to handle money):

| Collections | Pushed when `actor_type` is | Otherwise |
| --- | --- | --- |
| `estimates`, `invoices`, `payments`, `bills`, `purchaseOrders` | `user` (owner, admin, office), `stripe`, `system`, `sweep` (the sweep takes the type from the record's `updated_by`) | `needs_review` (reason `origin`, "Made by <API key name / the assistant>; approve to send to QuickBooks"). Resolve `'fishtape'` sends it. |
| `timeEntries` | `user`, `field_user` (a foreman's approval; open question 13.13), `system`, `sweep` | `needs_review/origin` |
| `clients`, `jobs`, `items`, `vendors` | any | |

`qbo_sync_log.actor_type` records who caused each push.

**Stale device writes on QBO-linked records** (also W3, in `records.js` `applyMutation`). When a sync
upsert is not fresh, the collection is in the list above and the tenant has a `qbo_connections` row:

1. The fields the device changed are `m.fields` when sent; otherwise (an older app) the fields where
   `m.data` differs from the `record_history` row at `baseVersion` (when that row exists; else fall back
   to whole-record LWW plus the stale revert guard of 5.5).
2. For each such field that is a **money** field (W2 `MONEY_RECORD_KEYS[collection]`, the record keys
   behind the money fields of 5.5): if any `record_history` version after `baseVersion` was written by
   `system:qbo` and changed that key, the device's value is **not** applied. The server value stays, and
   the device value goes into `held` (`{ <key>: deviceValue }`) for the hook. The engine then opens a
   `fields` conflict with base = the value before the pull (`prev_values`), fishtape = the device value,
   quickbooks = R. This runs whatever the latest `updated_by` is (an office edit after the pull does not
   switch it off).
3. The remaining changed fields are stored over the server copy (`{ ...cur.data, ...pick(m.data,
   fields) }`, `updatedAt` = the later of the two) instead of whole-record LWW, and the device gets
   `conflict` with the merged copy when it differs from what it sent (same as `mergeWrite`).

This keeps a QBO change that reached the server after the device went offline, and never lets an offline
edit silently overwrite a QBO money edit.

**Rank** (dependency order): clients 10, vendors 10, jobs 20, items 20, employees 20, estimates 30,
invoices 40, purchaseOrders 40, payments 50, bills 50, timeEntries 60, stripePayouts 70.

### 5.3 Push: processing

The `qbo_sync` pass claims due outbox rows (`not_before <= now()`, unclaimed or claim expired) ordered by
`rank, enqueued_at`, 50 at a time: `UPDATE qbo_outbox SET claimed_until = now() + interval '5 minutes',
claimed_epoch = $epoch ... RETURNING`. A row is deleted **only** in the transaction that records its
link outcome, and only if its `claimed_until` is still set (a newer edit cleared it; then the row stays for
the next pass). A crash leaves the claim to expire and the row is processed again. For each row:

1. **Eligibility** (4.1): not eligible (a draft, unapproved time, before `sync_from`, option off) and no
   link: skip. Not eligible but linked (e.g. an invoice went back to draft): push the change anyway
   (QBO cannot un-send). A link in state `unlinked` or owner `none`: skip. Owner `quickbooks`: skip
   (log `skipped`, "Edit in QuickBooks").
2. **Origin** (5.2) and the holds of 4.7 (local duplicate number), 4.8 (tax reason, rates, filed period)
   and 4.11 (pay-period lock).
3. **Dependencies**: the client, job sub-customer, items, vendor, invoice (for payments), PO (for bill
   lines), employee and, for a fee link, the main link. A dependency is met when its link has a `qbo_id`
   (whatever its state, except `unlinked`). An unmet dependency is pushed first in the same pass. If it
   cannot be (its own `error`, `blocked`, `needs_review`, `conflict` without a `qbo_id`), this link
   becomes `blocked/dependency` with `meta.dependsOn`. Whenever a link gets a `qbo_id` or reaches
   `synced`, the engine re-queues (outbox upsert) every link whose `meta.dependsOn` contains it.
4. **Reconcile** (5.5) with L = the current Fishtape record, R = the current QBO object (from this pass's
   CDC batch when present, else read it), B = the snapshot.

**Create protocol** (new record, no link). Retried creates must never make a second object:

1. In its own committed transaction, insert the link with state `pending`, `meta.marker` = `Fishtape
   ref <first 12 hex of link id>`, `meta.createRequestId` = `requestIdFor([tenantId, link.id,
   'create'])` (never includes the version) and `meta.createStartedAt` = now.
2. Send the create with `?requestid=<createRequestId>` and the marker stamped on the object:
   `PrivateNote` on Estimate, Invoice, Payment, Bill, Purchase, PurchaseOrder and Transfer;
   `Description` on TimeActivity; the exact `DisplayName`/`Name` on Customer, Vendor and Item.
3. Answer received: in one transaction (epoch-checked, 5.8) store `qbo_id`, `sync_token`,
   `qbo_updated_at`, `snapshot` = the canonical form of what QBO returned, `fishtape_version`,
   state `synced` (or `pending` with reason `tax_override`, 4.8), and delete the outbox row.
4. **Unknown outcome** (timeout, network error, 5xx, or a later pass finding a `pending` link that has
   `createRequestId` and no `qbo_id`, which is what a worker crash leaves): before any retry,
   **adopt-by-search**. Query the entity with the narrowest filter QBO allows: `DocNumber` when one was
   sent; otherwise `MetaData.CreateTime >= createStartedAt − 5 minutes` with the customer, vendor or
   employee ref (TimeActivity: `TxnDate` and the employee ref; Transfer and Purchase: `TxnDate`); names:
   `DisplayName`/`Name` equal. Among the results, the object whose `PrivateNote`/`Description` contains
   the marker (names: equal name and created after `createStartedAt − 5 minutes`) is ours: adopt it as
   in step 3. None: retry the create with the same `createRequestId`. Intuit's `requestid` dedupe window
   is not documented as long, so correctness never depends on it (**VERIFY** which fields are
   filterable, 11.4).
5. Fault **6140** (duplicate DocNumber) or **6240** (duplicate name) on a link that has
   `createRequestId`: adopt-by-search first; only then the rules of 4.7 (Renumber) and 4.2 (names).

**Updates, deletes and voids** send `?requestid=` = `requestIdFor([tenantId, link.id, op,
fishtape_version, sync_token])`. A retry after a timeout reuses it. If the record changed in between,
the new request carries the same `sync_token`: if the first update had landed, QBO answers 5010 and the
merge re-runs against the fresh object, so nothing is applied twice.

`fishtape_version` is always the version of the Fishtape row that L was built from, or the version the
engine's own patch produced. The sweep (5.12) relies on that.

### 5.4 Pull

Sources of QBO changes:

- **Webhooks** (5.9) set `qbo_connections.dirty_at` (and, for TimeActivity and merges, write
  `qbo_inbox`) and enqueue `qbo_sync`.
- **CDC catch-up**: `qbo_cdc` every 6 hours per active tenant, and right after a reconnect or worker
  start-up when `last_pull_at` is older than 1 hour.
- **Initial import**: the wizard (section 6).

A pull pass:

1. **CDC from the one cursor, for every entity:** `GET /cdc?entities=Customer,Vendor,Item,Estimate,
   Invoice,Payment,Bill,Purchase,PurchaseOrder,Deposit,Transfer&changedSince=<cdc_cursor − 2 min>`. Every
   CDC call asks for every entity and starts at the cursor, so a lost webhook for one entity is still
   caught by the next pass whatever triggered it (one call either way, so CorePlus use is the same).
   More than 1,000 objects: split the window in halves until each call returns under 1,000. A cursor
   older than 29 days triggers a **full reconcile**: query each entity page by page and reconcile all
   links; linked ids missing from the results are read by id, and "not found" (or `status: 'Deleted'`)
   is a delete.
2. **Echoes** (loop prevention, second layer, no read needed): an object whose `SyncToken` equals the
   link's `sync_token` is our own write coming back; nothing is written.
3. **TimeActivity** (not in CDC): read by id (`select * from TimeActivity where Id in (...)`) for its inbox
   rows, and every 6 hours `select * from TimeActivity where MetaData.LastUpdatedTime > '<time_cursor>'`
   (**VERIFY** that filter). A `deleted` inbox row is confirmed by reading the id ("not found" =
   deleted) before the link moves to `deleted_remote`.
4. **Merges** from the inbox: confirmed by reads (4.2).
5. Process objects by entity rank (Customer, Vendor, Item, Employee; Estimate; Invoice, PurchaseOrder;
   Payment, Bill, Purchase, Deposit; TimeActivity; Transfer), then by `MetaData.LastUpdatedTime`. For
   each, first the checks that only set state: void detection (4.7), tax-inclusive (4.8). Then:
   - Linked: reconcile (5.5) with R = the object; then, for an invoice, the settlement step (4.9) and
     `meta.qboBalanceCents`/`qboTotalCents`.
   - `status: 'Deleted'`: the delete rules of section 4.
   - Not linked: the creation rules of section 4.1 (create the Fishtape record and a link with
     `snapshot` = its canonical form), or ignore and log `skipped` at debug level.
6. Set `cdc_cursor` = the CDC response time minus 1 minute (only when the CDC calls covered the whole
   window from the old cursor), `last_pull_at`, and clear `dirty_at` unless a newer webhook arrived. Mark
   inbox rows processed. An inbox row that fails 5 times is marked processed anyway, with its link in
   `error` and a log entry, so one bad event never holds anything back.

Reference lists (Account, TaxCode, TaxRate, TaxAgency, PaymentMethod, Class, Department, Term,
Employee): webhook events for these (except TaxCode, TaxRate and TaxAgency, which send none) and the
daily refresh re-read the whole list into `qbo_reference` with one query per kind, keeping only the
allow-listed fields (3.8).

### 5.5 Three-way merge per entity

`reconcile(link)` builds three canonical forms with W2's mappers:

- **B** = `link.snapshot` (what both sides agreed on last time),
- **L** = `fishtapeToCanon(collection, record, ctx)`,
- **R** = `qboToCanon(entity, object, ctx)`.

Canonical forms are built so that both sides are compared alike: the same cuts (notes to 1,000 for
`CustomerMemo`, `number` and `reference` to 21), the same normalisers (addresses, names, method keys),
the lossy-line suffix stripped (4.7), invoice status collapsed to `open`/`void`, tax as code ids (4.8).
A field of R whose hash equals `meta.remoteAlias[field]` counts as equal to B (6.4); the alias is
dropped as soon as R's value changes.

`threeWayMerge(collection, B, L, R, opts)` decides per field:

| Case | Result |
| --- | --- |
| L = B and R = B | nothing to do |
| L = B, R ≠ B | take R (write Fishtape) |
| R = B, L ≠ B | take L (write QBO) |
| L = R ≠ B | both changed the same way; update the snapshot only |
| L ≠ B, R ≠ B, L ≠ R, field is **auto** | the side edited later wins, using per-field times (below); logged as `auto_resolved`. If the two times are within 10 minutes of each other, or either time is unknown: a `fields` conflict instead |
| L ≠ B, R ≠ B, L ≠ R, field is **money** | conflict: nothing is written for this record; a `fields` conflict is opened |
| B is null (relink, 7.5) | every field where L ≠ R is a conflict; nothing is written |

**Per-field edit times.** QBO's `LastUpdatedTime` moves when a payment is applied and Fishtape's
`updatedAt` moves with any field, so record-level times are not used. Remote time: `meta.fieldSeenAt
[field]`, set by the pull that first sees R's value of that field differ from B (it takes that object's
`LastUpdatedTime` at that sighting, which is the edit itself) and cleared when the snapshot moves. Local
time: the `updated_at` of the first `record_history` version after the snapshot's `fishtape_version` that
changed the field's record keys (W3 reads it; history is indexed by record).

Field classes (W2 exports them as `FIELD_RULES`, and `MONEY_RECORD_KEYS` mapping each money field to the
record keys behind it):

| Collection | money fields (conflict) | auto fields (later edit wins) | push-only fields |
| --- | --- | --- | --- |
| clients | none | name, type, email, phone, address, active | notes |
| vendors | none | all | |
| items | priceCents, costCents | name, sku, description, active | |
| estimates | number, clientRef, jobRef, date, lines, status | validUntil, notes | title |
| invoices | number, clientRef, jobRef, date, lines, status (`open`/`void`) | dueDate, notes, estimateRef | title |
| payments | invoiceRef, amountCents, date | method, reference | |
| bills | vendorRef, number, date, lines, taxes, kind | dueDate, notes, paidWith | |

`lines` is one field (compared as the list of canonical lines); taxes are inside it (code id per line).
Push-only collections (jobs, purchaseOrders, timeEntries, payout transfers) skip the merge: L is
written to QBO whenever L ≠ B or R ≠ B (a QBO-side edit is overwritten and logged as a warning), except
the pulled PO status.

**Stale revert guard.** `prev_values` holds, for each field the last pull changed in Fishtape, the
Fishtape value it replaced. If the outbox row was `stale` and L's value for a field equals
`prev_values[field]` (a device that never saw the pull put the old value back), that field is treated as
a conflict (money) or as "R wins" (auto), never pushed. `prev_values` is cleared for a field once the
snapshot moves past it. Device money values held by `records.js` (`held`, 5.2) always open a conflict.

**Writing the result.**

- Fishtape side: one `records.patchRecord` with the system principal (5.7) containing only the
  changed fields, with `updatedAt` = the later of L's `updatedAt` and R's `LastUpdatedTime` (clamped to
  now), so last-writer-wins against devices compares real edit times.
- QBO side: a **sparse** update for entities that support it (Customer, Invoice, Estimate, Deposit) and a
  full update otherwise (Item, Vendor, Payment, Bill, Purchase, PurchaseOrder, TimeActivity, Transfer),
  built from the current QBO object with our fields replaced, so fields Fishtape does not manage are
  kept. **VERIFY** whether `sparse: true` works on the second group; if it does, use it. Whenever `Line`
  is sent, it is built from the current QBO lines matched by `Line.Id` (unmodelled line attributes kept,
  4.7, 4.10); `GlobalTaxCalculation` is sent back as read (4.8); `TxnStatus` only as 4.7 allows; a
  payment's foreign lines as 4.9 requires.
- Snapshot = the merged canonical form, `sync_token` and `qbo_updated_at` from QBO's response,
  `fishtape_version` from the patched row (or L's row), state `synced`.

### 5.6 Conflicts

A `fields` conflict stores `[{ field, label, base, fishtape, quickbooks }]` (display values: money in
cents, lines as a short list) and sets the link to `conflict`. While open, neither side is written for
that record; later changes on either side re-run the merge, and if L and R become equal the conflict
closes itself (`resolved`, `resolved_by: 'system'`).

Other kinds: `review` (`needs_review` links: tax shape, totals differ, tax inclusive, filed period, pay
period locked, origin, payout items, wizard differences, name taken), `deleted` (deleted or voided on one
side, changed or still needed on the other; QBO refused a delete; payment removed in QBO), `merged` (QBO
merged two customers that are both linked).

Resolve (`POST /api/v1/qbo/conflicts/:id/resolve`):

- `choice: 'fishtape'`: L wins every conflicting field; written to QBO.
- `choice: 'quickbooks'`: R wins; written to Fishtape.
- `choice: 'fields'` with `fields: { lines: 'quickbooks', date: 'fishtape' }`: per field.
- `review` conflicts: `'fishtape'` makes `owner = 'both'` and pushes Fishtape's version (for pulled
  documents QBO's lines and tax are replaced; for `origin`, `filed_period`, `payroll_locked` and
  `payout_items` it is the approval that sends the held write); `'quickbooks'` keeps `owner =
  'quickbooks'` (or drops the held write) and closes the conflict; `'unlink'` leaves a tombstone (below).
  For `name_taken`: `'link'` (link to the QBO customer) or `'create'` (create with a suffix).
- `deleted`: `'restore'` (recreate on the side that deleted; a voided invoice is re-created as a new QBO
  invoice with a new number) or `'delete'` (delete or void on the other side, under 4.7 and 4.9 rules).
- `merged`: `'unlink'` with `recordId` of the Fishtape record to unlink.

**Unlink** (from a resolution or `DELETE …/link`, 7.5) never deletes the link row: it becomes a
tombstone (state `unlinked`, owner `none`, `qbo_id` kept for reference). No later Fishtape edit creates a
second QBO object for that record. "Send to QuickBooks as new" (`POST …/sync` with `{ asNew: true }`)
deletes the tombstone and creates; relinking (`PUT …/link`) replaces it.

Each resolution writes the audit event `qbo.conflict.resolve` and a log row. Conflict resolution and the
other API actions that write run under the tenant lease (5.8).

### 5.7 The system actor and how pulled changes reach devices

Pulled changes are written by `systemPrincipal(tenantId, 'qbo', 'QuickBooks sync')` (from
`integrations/state.js`): owner permissions, actor `{ type: 'system', id: 'qbo', label: 'QuickBooks sync' }`.
They go through `records.createRecord`, `patchRecord`, `deleteRecord` and `restoreRecord` like any write,
so validation, history, audit (`created_by`/`updated_by` = `system:qbo`), plan checks and module switches
all apply, and `change_seq` moves. Devices get them on their next pull (every 30 s, on focus and when
back online).

If a write is refused with `module_turned_off` or `feature_not_in_plan`, the link becomes
`blocked/module_off` (or the connection `paused/plan`) and the event is kept; turning the module back on
re-queues blocked links.

### 5.8 Ordering, single flight, rate limits, retries

- **QuickBooks worker pool.** `queue.js` `claim` gains `{ kinds, excludeKinds }` (SQL `kind LIKE
  'qbo_%'` or `NOT LIKE`). `worker.js` runs two loops in the same process: the general loop
  (`WORKER_CONCURRENCY` slots, never claims `qbo_*`) and the QuickBooks loop (`WORKER_QBO_CONCURRENCY`
  slots, only `qbo_*`). Password resets, invites, Stripe follow-ups and notifications never wait behind
  QuickBooks. The QuickBooks loop holds no database connection across an Intuit call (2.4, 5.3).
- **Heartbeat.** `queue.js` gains `heartbeat(db, jobId)`; every `qbo_*` handler calls it every 60 s, so
  `reclaimStuck` (15 minutes) never puts a running QuickBooks job back in the queue.
- **One worker per tenant, fenced.** Every tenant-scoped `qbo_*` job (`qbo_sync`, `qbo_cdc`,
  `qbo_setup_scan`, `qbo_setup_apply`, `qbo_reference_refresh`, `qbo_check`) acquires the
  lease: `UPDATE qbo_connections SET lease_until = now() + interval '2 minutes', lease_by = $worker,
  lease_epoch = lease_epoch + 1 WHERE tenant_id = $1 AND (lease_until IS NULL OR lease_until < now())
  RETURNING lease_epoch`. Renew every 30 s while working; release at the end. No lease: complete the job
  at once (the holder or the dispatcher will see the new rows). **Every** transaction that writes links,
  the outbox, conflicts, candidates or Fishtape records first runs `SELECT lease_epoch FROM
  qbo_connections WHERE tenant_id = $1 FOR SHARE` and rolls back (ending the job) if it is not the
  job's epoch. A worker paused past its lease (GC, a slow call) therefore cannot write after another took
  over; any QBO object it created meanwhile is found by adopt-by-search (5.3).
- **Time limits.** A `qbo_sync` pass stops after 4 minutes. The wizard's scan and apply work in
  resumable chunks of at most 4 minutes (progress in `qbo_connections.setup`, per candidate
  `applied_at`), each chunk ending by enqueuing the next one. When work remains, the job enqueues
  `qbo_sync` with `dedupeKey: 'qbo_sync:<tenantId>:cont'` (its own key `qbo_sync:<tenantId>` is still
  `running`, so the same key would be dropped), `runAt` now + 5 s.
- **API actions take the lease.** Conflict resolve, `PUT/DELETE …/link`, renumber, look-up import and
  "Send now" acquire the same lease, waiting up to 10 s; else 409 `qbo_busy` ("QuickBooks sync is busy;
  try again in a minute").
- **Dispatcher.** `qbo_dispatch` runs every minute (like `integrations_dispatch`, dedupe key
  `qbo_dispatch:<YYYY-MM-DDTHH:MM>`). It lists connected tenants from `qbo_realms JOIN tenants ON
  tenants.id = qbo_realms.tenant_id WHERE tenants.status = 'active'` (platform read, 3.2), then per tenant
  inside `withTenant` checks for an `active` connection with due outbox rows, `dirty_at`, pending inbox
  rows or links whose `next_attempt_at` has passed, and enqueues `qbo_sync`. Suspended or closed tenants
  are never synced.
- **Rate limits per realm.** The QBO client keeps an in-process token bucket per tenant: 8 requests per
  second and 400 per minute (Intuit: 10/s and 500/min), and at most 1 request in flight per tenant from
  the worker (one lease holder) and 2 from each API process (look-ups), well under Intuit's 10
  concurrent requests per realm. Every caller, look-ups included, checks `throttled_until` before each
  call. On HTTP 429: set `throttled_until = now() + 60 s`; the job ends and is re-enqueued for after that
  time; a look-up answers 429 `qbo_throttled`.
- **Retries.** Per link: `attempts` and `next_attempt_at` with backoff 1, 2, 4, 8, 16, 32, 60, 60 minutes.
  Retryable: network errors, timeouts, 5xx, 429, 5010 after three re-merges, fault 140/150 (company
  locked). Not retryable: validation (400, 6000), 610 for a referenced object, 6140 and 6240 after
  adopt-by-search and the rules of 4.2 and 4.7, permission (5020), feature (5030; becomes
  `blocked/feature_missing`), books closed (6000 with the closing-date message; becomes
  `blocked/books_closed`), open balance on deactivation (`error/open_balance`).
- **Poison records.** After 8 attempts, or at once for a non-retryable error: state `error`, `reason`,
  and `last_error`. Not retried until the Fishtape record changes, a mapping changes (every `error` and
  `blocked` link is re-queued) or someone presses Retry. A daily notification to office roles summarises
  new errors (ref `qbo:errors:<date>`).
- **Error text.** `QboError.message` is built from a fixed table keyed by `kind` and `faultCode` (for
  example "QuickBooks rejected a duplicate name") and never contains Intuit's `Detail`, a URL, a name or
  an id. Intuit's detail goes only to the tenant's `qbo_sync_log.message` and `qbo_links.last_error`,
  after `scrub`, which W1 extends with a name-safe rule (Intuit's quoted values, the text after
  "name:" and anything in quotes are replaced with `[…]`). Job handlers catch every error and rethrow
  `new Error(qboError.message)`, so `jobs_queue.last_error`, worker stdout and HQ's queue page carry no
  customer data and no realm id.
- **SyncToken.** Every update sends the link's `sync_token`. Fault **5010**: re-read the object (or take
  it from the CDC batch), re-run the merge with the fresh R, retry; after three 5010s in one pass, retry
  later.
- **Idempotency.** 5.3: stable create ids plus marker and adopt-by-search; versioned ids for updates.
  Request ids are base32 of SHA-256, 36 characters (fits batch `bId`).
- **Batches.** The wizard's bulk create uses `POST /batch` with at most **10** items (Intuit's pages
  disagree between 10 and 30; **VERIFY**), never two dependent items in one batch. Each item follows the
  create protocol of 5.3 on its own: its link is committed `pending` before the batch is sent, its
  `bId` is its own `createRequestId`, and after a failure or timeout each item is resolved one by one
  (adopt-by-search, then a single retry). A whole batch is never re-sent. The normal pass uses single
  calls.
- **Ordering guarantees.** Within a tenant: pushes in rank order with dependencies first; pulls in
  entity rank then QBO time order. Across tenants: none needed.
- **Safety brake.** Counted per tenant per rolling hour, not per pass: if writes on either side (outside
  the wizard's apply) would pass 500 in the last hour, the pass stops before writing, sets `paused` with
  `pause_reason = 'brake'`, logs `safety_brake` with the counts, notifies office roles and raises an HQ
  alert. Resume from the brake asks the person to confirm the count ("Allow 742 changes"); it sets
  `brake_allow_count` and `brake_allow_until = now() + 1 hour`, so the same pass can finish once instead
  of tripping again. This catches a mapping or merge bug before it rewrites a whole book.
- **Platform write switch.** `QBO_WRITES=off` (2.1): the client refuses every Core call before sending
  (`QboError{kind:'unavailable', retry: true}`), so pushes stay in the outbox; pulls continue. The
  overview says "Sending to QuickBooks is paused by Fishtape". For an incident across all tenants.
- **Shadow mode.** Option `writeMode`: `live` (default) or `shadow`. In shadow the engine runs every pass
  in full but writes nothing on either side: each would-be QBO write and Fishtape patch is logged with
  outcome `shadow`, action, collection, record and the changed field names; links, snapshots and
  cursors do not move (the outbox rows stay, so switching to live sends them). The wizard in shadow
  applies phase 1 (links) only (6.4); switching to live runs the remaining phases. Recommended for a
  first tenant's first week (checklist step 12).

### 5.9 Webhook ingress

`POST /api/v1/webhooks/qbo` (public, CSRF off, raw body, body limit 4 MB, log level `warn`):

1. Verify: base64 of HMAC-SHA256(raw body, `QBO_WEBHOOK_VERIFIER`) compared in constant time with the
   `intuit-signature` header; if that fails and `QBO_WEBHOOK_VERIFIER_PREVIOUS` is set, the same with it.
   Bad or missing: 401 `invalid_signature`, nothing stored; the failure is counted (HQ alert above 0 per
   hour, section 9).
2. Parse: a JSON array of CloudEvents (`id`, `type` = `qbo.<entity>.<op>.v1`, `time`, `intuitentityid`,
   `intuitaccountid`, `data.deletedid`). A legacy `{ eventNotifications: [...] }` body is converted to the
   same shape (cheap insurance). Unknown types are dropped.
3. Group by `intuitaccountid`; for each realm compute `realm_hash` and look it up in `qbo_realms`.
   Unknown realm: drop. Known, in one `withTenant` transaction: a `disconnected` connection drops;
   otherwise set `dirty_at` and `last_webhook_at`; upsert TimeActivity events and `merged` events into
   `qbo_inbox` (one row per object, the newer event wins, `processed_at` reset); enqueue `qbo_sync`
   (dedupe) when the connection is `active`. Other events carry nothing that is stored: the CDC call of
   the next pass reads every change from the cursor. Webhook-only signals (TimeActivity deletes, merges,
   voids) are confirmed by a read or the CDC object before anything is written (5.4).
4. Answer 200 `{ received: n }` (within Intuit's 3 seconds; nothing slow happens here).

nginx: `/api/v1/webhooks/` gets its own `limit_req` zone keyed on the path, not the client IP, so
Intuit's few sender IPs are never limited by the per-IP `/api/` zone (W1, both nginx kits, 12.2).

### 5.10 Offline device edits while QuickBooks changed the same record

Example 1, different fields: the office edits invoice INV-3001's due date in QuickBooks; meanwhile a
manager's iPad, offline, changes the invoice's notes.

1. The QBO change arrives (webhook, CDC). Reconcile: L = B, R ≠ B on `dueDate`: Fishtape is patched by
   `system:qbo`, snapshot updated, `prev_values.dueDate` = the old date.
2. The iPad comes online and pushes its whole invoice with `fields: ['notes']` and an old `baseVersion`.
   `records.js` sees a stale write and stores the server copy with the iPad's `notes` on top. The iPad
   gets `conflict` with the merged copy and takes it. Both changes survive.
3. The hook queues the invoice (`stale: true`). Reconcile: L ≠ B on `notes`, R = B: notes go to QBO.
4. If the iPad's push had no `fields` (an older app), `records.js` works out the changed fields from the
   `record_history` row at `baseVersion` (5.2) and behaves as in step 2. Only when that row is gone does
   LWW by edit time decide; the stale revert guard then sees `dueDate` equal to `prev_values.dueDate` and
   does not push it back; because `dueDate` is an auto field, R wins and Fishtape is patched back to
   QBO's date.

Example 2, same money field: the bookkeeper changes INV-3001's lines in QuickBooks; the pull patches
Fishtape. A foreman's iPad, offline with the old copy, also edited `lines`. On its stale push,
`records.js` finds a `system:qbo` version after the iPad's `baseVersion` that changed `lines`, keeps the
server's lines, holds the iPad's lines in `held`, and the engine opens a `fields` conflict (base = the
lines before the pull, Fishtape = the iPad's, QuickBooks = the bookkeeper's). Nothing is overwritten
until a person chooses.

### 5.11 CorePlus budget

The client counts each call in `qbo_api_usage` per environment (Core: create, update, delete, void,
upload, batch with only writes; CorePlus: read, query, CDC, company info, preferences, batch items that
are queries; **VERIFY** the classification once Intuit's help article is readable). Sandbox counts are
kept apart and never count toward any budget. Rules:

- Writes never read back: create/update responses carry the full object.
- Echoes are dropped without a read (5.4).
- One CDC call covers all entity types per pass.
- Expected use per tenant per month: CDC every 6 h (about 120), webhook-driven CDC (about 300 to 900),
  TimeActivity reads (about 150), daily reference refresh (about 300), daily check (about 60), look-ups
  (about 600). Roughly 1,500 to 3,000.
- **Per tenant, every CorePlus call counts** (sync, CDC, scan, checks, relink and look-ups) against
  `QBO_TENANT_READ_BUDGET` (`QBO_TRIAL_READ_BUDGET` during a free trial). At 50% and 80% office roles and
  HQ get a notice. At 80% look-ups stop (429 `lookup_budget`). At 100% the 6-hourly CDC, the daily check
  and the scan stop, and pulls run only when a webhook marked the tenant dirty, at most once an hour. At
  150% the tenant goes `paused/tenant_budget` until the 1st (UTC). Other tenants are never affected.
- **Rate caps:** the scan at most once every 15 minutes per tenant (429 `qbo_throttled` with
  `retryAfterS`); `POST /qbo/sync` with a pull at most once every 5 minutes (a push-only request at most
  once a minute); reference refresh at most once every 5 minutes.
- **Workspace** (production only), total of all tenants for the month against `QBO_READ_BUDGET`: at 70%
  an HQ alert; at 90% look-ups and the 6-hourly CDC stop for everyone (webhook-driven pulls continue)
  and HQ is alerted again. At 100%, or on an Intuit 429 that persists more than 10 minutes with the
  monthly cap message, every connection goes `paused/budget` until the 1st (UTC).
- The budget belongs to the Intuit app: two servers using the same production keys share it (13.2).

### 5.12 Fishtape-side sweep

CDC is how QBO-side changes are never missed; the sweep does the same for Fishtape-side changes that
did not reach the outbox (edits while QBO was unset on the server, a hook that failed, writes that
bypassed `records.js` such as direct SQL, scrubs and imports). It runs (`sweep(deps, tenantId)`, W3) at
the start of the first pass after any move back to `active` (2.5), after a reconnect, after the wizard
apply, and once a day from `qbo_check`:

1. **Changed linked records:** every link (states other than `unlinked`, `deleted_local` and owner
   `quickbooks`) whose Fishtape record's `version` differs from `link.fishtape_version`: upsert an outbox
   row (`actor_type` `sweep`, `stale` false).
2. **New records:** every record of a QBO collection with `change_seq > fishtape_cursor` and no link
   that is eligible (4.1): upsert an outbox row. Then set `fishtape_cursor` to the highest `change_seq`
   seen. On the first sweep after the wizard apply, `fishtape_cursor` starts from the scan time's
   `change_seq`.
3. **Deleted records:** linked records whose row has `deleted_at` set and whose link is not
   `deleted_local`: upsert an outbox row with `op: 'delete'`.

The sweep reads only the Fishtape database (no CorePlus). It respects the origin rule through each
record's `updated_by`.

### 5.13 Daily balance check

`qbo_check` (daily per active tenant, under the lease; about 2 CorePlus calls per 1,000 open documents):

- **AR:** query QBO invoices with `Balance > '0'` or changed in the last 35 days (paged). For each
  linked invoice compare QBO `Balance` with Fishtape's amount due (4.9) and QBO `TotalAmt` with
  Fishtape's total (allowing `taxDeltaCents`). Store `meta.qboBalanceCents`/`qboTotalCents`.
- **AP:** the same for linked bills (`Balance`, total).
- **Stripe clearing:** read the clearing account's `CurrentBalance` and compare it with the expected
  balance: the opening balance stored at the Stripe cutover (`option.stripeClearingOpeningCents`, read
  when the cutover is set) plus pushed Stripe payments, minus pushed fees and payout transfers.
- Differences above 2 cents go on the overview's **"Doesn't match"** list (`GET /qbo/checks`, 7.5) with
  both amounts and a link to the record, and the record's badge shows "Doesn't match QuickBooks". The
  daily summary notification counts them. Nothing is written by the check.
- It also runs the daily sweep (5.12) and refreshes `features.taxFiledThrough` (2.8).

---

## 6. First-connect matching wizard

Starts when the connection is in `setup`. The PWA walks through it (8.3); the server keeps all state, so
it can be left and resumed on another device.

### 6.1 Settings step

Stored as `option.*` mappings:

| Option | Default | Meaning |
| --- | --- | --- |
| `syncFrom` | first day of the current month | Documents, payments, bills and time dated before this are not synced, except open invoices (balance above 0) and pending estimates, which are matched whatever their date |
| `importCustomers` | `active` | Which QBO-only customers the wizard creates in Fishtape: `active` (a transaction on or after `syncFrom`, or an open balance) or `all` (every active customer). Open question 13.14. |
| `numbering` | `fishtape` (`quickbooks` if custom numbers are off) | 4.7 |
| `jobsAsSubCustomers` | true | 4.3; locked once a document has been pushed |
| `items` | `on_use` | `on_use` or `all` |
| `pushDrafts` | false | push draft estimates and invoices too |
| `syncTime` | true | push approved time |
| `timeOwner` | asked, no default | `fishtape` or `quickbooks` (QuickBooks Time / Workforce holds payroll hours; nothing is pushed). The wizard cannot continue until it is answered when `syncTime` is on. |
| `timeLockedThrough` | the end of the last pay period run (asked) | 4.11 |
| `taxFiledThrough` | from QBO (2.8), else asked | the last day of the last GST period filed (4.8) |
| `pullJobCosts` | true | pull QBO bills and expenses tagged to linked clients or jobs |
| `recordStripeFees`, `recordStripePayouts` | true | 4.9 |
| `stripeCutover` | `syncFrom` | 4.9: the first day whose Stripe charges Fishtape books. Setting it reads the clearing account's balance into `stripeClearingOpeningCents` (5.13). |
| `writeMode` | `live` (`shadow` recommended for the first tenant's first week) | 5.8 |

### 6.2 Mappings step

The mappings screen (8.4) with the required entries; the wizard cannot continue until every required
mapping is set (list in section 7.6).

### 6.3 Scan

`POST /api/v1/qbo/setup/scan` (at most once every 15 minutes per tenant, 5.11) enqueues
`qbo_setup_scan`, which reads (CorePlus, about one call per 1,000 rows): all customers (incl.
sub-customers and projects), items (Service, NonInventory, Inventory), employees, vendors, open invoices
(`Balance > '0'`), invoices and estimates dated on or after `syncFrom` minus 14 days (for the duplicate
pass below), estimates with `TxnStatus = 'Pending'` or `'Accepted'`, and payments on or after `syncFrom`
plus those applied to the open invoices read. It writes `qbo_candidates` and progress into
`qbo_connections.setup`, in chunks of at most 4 minutes (5.8). For each `link` candidate it also stores
`diffs` (below).

Matching (W2 `match.js`; normalizers equal to `importers.js` `normEmail`, `phoneKey`, `nameKey`, `skuKey`,
checked by a parity test; postal codes compared upper case without spaces):

| Kind | Rules (highest score wins) | Default choice |
| --- | --- | --- |
| customers | email equal 100; last-10-digit phone equal 80; `nameKey` of DisplayName, CompanyName or Given+Family equal to the client name, **and** the postal code equal, 75; name only 70 | unique match at 75+: `link`. A name-only match (70) is always `ambiguous` (two "Dana Smith"s are common, and a wrong link would post invoices to the wrong customer's AR). Two or more at the top score: `ambiguous`. Fishtape-only: `create_in_qbo` if the client has an estimate, invoice or job on or after `syncFrom` or an open invoice, else `skip`. QBO-only active: `create_in_fishtape` when `importCustomers` allows it, else `skip`; inactive: `skip`. |
| jobs | QBO sub-customer or project whose parent is matched to the job's client and whose name contains the job number, or whose `nameKey` equals the job title: 90 / 70 | match: `link`; Fishtape-only: `skip` (created on use); QBO-only: `skip` (never created in Fishtape) |
| items | `skuKey` equal 100; `nameKey` equal 70; Category and Group items excluded | match: `link`; Fishtape-only: `skip` with `items: 'on_use'`, `create_in_qbo` with `'all'`; QBO-only active: `create_in_fishtape` |
| employees | email 100; `nameKey` (Fishtape name vs Given + Family or DisplayName) 70 | match: `link`; anything else: `skip` (choices limited to `link` and `skip`) |
| vendors | as customers | match: `link`; name-only: `ambiguous`; one side only and active: create on the other side |
| invoices, estimates | **Pass 1**: same `DocNumber`/`number`, customer matched (or about to be linked), totals within 2 cents per tax rate: 100. Same number but totals differ: `ambiguous` with both totals. **Pass 2** (documents left unmatched): customer matched, total within 2 cents per tax rate, `TxnDate` within 14 days: `ambiguous` with reason `possible_duplicate` (a document keyed into QBO by hand under another number) | 100: `link`. `possible_duplicate`: never `create_in_qbo` by default; the user links or confirms "Create anyway". Fishtape-only non-draft dated on or after `syncFrom` (or open): `create_in_qbo`. QBO-only open or on/after `syncFrom`: `create_in_fishtape`. Any `create_in_qbo` dated on or before `taxFiledThrough` needs its `confirmed` tick ("This adds to a GST period already filed"); without it apply skips it. |
| payments | Per linked invoice pair. If the QBO `Balance` equals Fishtape's amount due: pair payments by equal amount in any order, dates ignored; a Fishtape Stripe payment also pairs with a QBO payment equal to its gross minus `stripe.feeCents` (net entered by the bookkeeper; the link gets `meta.remoteAlias.amountCents`). Leftovers on either side: `skip` (the balances already agree). If the balances differ: pairs as above score 100, the rest are one-sided | match: `link`. One side only: create on the other side, **unless** that would take the other side's invoice balance below 0: then `ambiguous` (never a double payment). QBO-only leftovers that are not created become part of the settlement payment (4.9). |

`qbo_summary` holds only what the screen shows: name, email, phone, type, DocNumber, date, total and
balance in cents, status. It never holds addresses or notes. `diffs` holds, for `link` candidates only,
the display values of the fields that differ (address and notes included, office-only, deleted with the
candidate 30 days after the scan).

### 6.4 Choices, plan and apply

- `GET /api/v1/qbo/setup/matches` lists candidates per kind with filters; `PUT /api/v1/qbo/setup/matches`
  changes choices, field choices and the filed-period tick (also in bulk: "create all unmatched in
  QuickBooks", "use Fishtape's values for all differences", "use QuickBooks' values for all differences").
- `GET /api/v1/qbo/setup/plan` returns counts per kind and action and the warnings: unmapped tax keys on
  documents, documents with no-tax lines and no `taxNoneReason`, employees left unlinked, number
  collisions, **possible duplicates** (count), **differences still to decide** (count), **creates dated in a
  filed GST period** (count, ticked and unticked), the highest QBO number per kind with an offer to raise
  `nextNumbers`. Apply is refused (409 `setup_incomplete`) while a `link` candidate has a differing
  field with no choice.
- **Baseline per field (no silent overwrite on the first reconcile).** For each `link` candidate, apply
  builds the snapshot field by field from L and R:
  - equal: that value;
  - one side empty, the other not: B = the empty side's value, so the first reconcile copies the
    non-empty value to the empty side (a QBO customer with no phone gets Fishtape's phone, never the
    reverse);
  - both non-empty and different (customers, vendors, items, jobs): the Review step shows the field with
    both values and the user picks a side (`field_choices`). B = the value **not** chosen, so the first
    reconcile writes the chosen value to the other side;
  - documents (estimates, invoices): when totals and per-rate tax agree within 2 cents and the lines'
    amounts and tax codes agree (as multisets), the lines are treated as equal even if items or
    descriptions differ (generic items, CSV-imported text): B.lines = L.lines and
    `meta.remoteAlias.lines` = the hash of R.lines, so neither side is rewritten until someone really
    edits. A document that differs by more than that is linked in `needs_review` (reason
    `wizard_differs`), owner `quickbooks`, with both versions shown; nothing is written either way until
    a person resolves it;
  - payments: as documents, with `remoteAlias` for a net-of-fee match.
- `POST /api/v1/qbo/setup/apply` enqueues `qbo_setup_apply`, which runs the phases in order, in chunks
  (5.8), and records `setup = { phase, done, total, errors, startedAt, finishedAt }`:
  1. links (no writes on either side; per-field baselines above). In `writeMode: 'shadow'` apply stops
     here, the connection goes `active` in shadow, and the remaining phases run when the office switches
     to live;
  2. vendors and customers both ways;
  3. jobs (sub-customers) needed by later phases;
  4. items both ways;
  5. estimates, then invoices, both ways (QBO creates in batches of 10, oldest first, each item under the
     create protocol of 5.3);
  6. payments both ways (after their invoices), then the settlement step (4.9) for every linked invoice;
  7. bills, purchase orders, time (dated on or after `syncFrom`; time after `timeLockedThrough`);
  8. state `active`, `cdc_cursor` = the scan start time, `fishtape_cursor` = the `change_seq` at the scan
     start, audit `qbo.setup.apply`, notify, then the first pass runs the Fishtape-side sweep (5.12).
  A candidate that fails gets `error` and the apply continues; failures show in the plan screen with
  Retry. A crash or a reclaimed chunk resumes at the first candidate without `applied_at`, and creates
  already sent are resolved by adopt-by-search (5.3), never re-sent blind. `POST
  /api/v1/qbo/setup/cancel` stops after the current chunk.

Nothing is written to either side before apply. Re-running the scan replaces candidates that have no
`applied_at`. Candidates are deleted 30 days after the scan that wrote them, applied or not.

---

## 7. API routes

All under the API origin. Every route: `Cache-Control: no-store`, errors as `{ error: { code, message,
requestId } }`, audit on state changes, no QBO tokens, realm ids, or Intuit ids of the realm in
responses. Money is integer cents.

### 7.1 Who may call

| Level | Rule | Implementation |
| --- | --- | --- |
| `office` | Session (not crew, not API key) whose role is owner, admin or office | `config: { auth: 'manager', apiKey: false }` plus preHandler `requireQboRole('office')` (W1 `server/src/qbo/roles.js`). `manager` alone would let foremen in. |
| `admin` | Owner or admin session | `config: { auth: 'admin', apiKey: false }` |
| `public` | Signed or token-bound; no session | `config: { auth: 'public', csrf: false }` only where noted |

Field roles, crew sessions and API keys get **403** `forbidden` from every QBO route. Nothing in
`/api/v1/sync/pull` or the record routes carries QBO data, so they need no change.

**Two-step verification.** Every QBO route that changes anything (connection, pause, sync now, setup
choices and apply, mappings, conflict resolution, link, unlink, renumber, retry, import) requires a
session with `mfa_verified_at` set, whatever the role: an office user without two-step sign-in gets 403
`mfa_required` ("Turn on two-step sign-in to change QuickBooks data") with a link to set it up. Read-only
routes (status, log, record states and views, conflict and match lists, plan, look-up search) do not.
`requireQboRole(level, { write: true })` enforces it (W1 `roles.js`). This lets the Intuit questionnaire
answer "yes" to MFA for users who can change QuickBooks data (open question 13.1).

Plan: every `office`/`admin` route except `GET /qbo/status` and `POST /qbo/disconnect` uses
`requireFeature(db, 'quickbooks')` (403 `feature_not_in_plan`). Server not configured
(`QBO_ENVIRONMENT` unset): 503 `qbo_unavailable` from every route except status.

Common errors: 409 `qbo_not_connected`, 409 `qbo_reconnect_needed`, 409 `qbo_not_ready` (setup not
finished), 429 `qbo_throttled` (with `retryAfterS`), 429 `lookup_budget`, 502 `qbo_unavailable` (Intuit
down), 404 `not_found`, 400 `validation_failed`.

### 7.2 Connection (route file `server/src/routes/v1/qbo-connect.js`)

| Method and path | Level | Request | Response |
| --- | --- | --- | --- |
| `GET /api/v1/qbo/status` | office | | `Status` (below) |
| `POST /api/v1/qbo/connect` | admin | `{ returnTo: 'web'\|'app', reconnect?: boolean }` | `{ url }` |
| `GET /api/v1/qbo/oauth/start?ticket=` | public | | interstitial HTML (2.2), or 302 to the error result |
| `POST /api/v1/qbo/oauth/start` | public, `csrf: false` | form field `ticket` | 302 to Intuit (sets `ft_qbo_flow`) or 302 to the error result |
| `GET /api/v1/qbo/oauth/callback?code&state&realmId` | public | | 302 (2.2) |
| `GET /api/v1/qbo/oauth/done?result=` | public | | static HTML |
| `GET /api/v1/qbo/launch[?connect=1]` | public | | 302 to `/#/quickbooks` (or `/#/quickbooks?connect=1`) |
| `GET /api/v1/qbo/disconnected` | public | | static HTML: "Fishtape is disconnected from QuickBooks. To connect again, sign in to Fishtape and open QuickBooks." |
| `POST /api/v1/qbo/connect/takeover` | admin | `{ confirm: true }` | `{ ok: true }` (2.9); 404 when no takeover offer is open for the caller |
| `POST /api/v1/qbo/disconnect` | admin | `{ purge?: boolean }` (default false) | `{ ok: true, purged: boolean }` |
| `POST /api/v1/qbo/pause` | office | `{ paused: boolean, allowCount?: number }` | `Status`. Resuming from `brake` needs `allowCount` ≥ the tripped count (5.8); `hq`, `plan`, `budget` and `tenant_budget` pauses cannot be resumed here (409 `qbo_pause_locked`) |

`Status`:

```json
{
  "available": true,
  "environment": "sandbox",
  "plan": { "entitled": true, "needs": "pro" },
  "state": "active",
  "pauseReason": null,
  "reconnectReason": null,
  "companyName": "TG Electrical Ltd.",
  "features": { "edition": "QuickBooks Online Plus", "salesTax": true, "customTxnNumbers": true, "purchaseOrders": true, "timeTracking": true, "bills": true, "classes": false, "locations": false, "projects": false, "multicurrency": false },
  "connectedAt": "2026-10-21T15:02:11Z",
  "connectedBy": "Kelvin Waldner",
  "syncFrom": "2026-10-01",
  "lastPullAt": "2026-10-21T15:40:02Z",
  "lastPushAt": "2026-10-21T15:39:40Z",
  "counts": { "pending": 3, "error": 1, "blocked": 2, "conflict": 0, "needsReview": 0, "mismatch": 0, "waitingOffline": 0 },
  "writeMode": "live",
  "writesEnabled": true,
  "refreshExpiresAt": "2027-01-29T15:40:02Z",
  "hardExpiresAt": "2031-10-20T15:02:11Z",
  "setup": { "phase": "done", "done": 412, "total": 412 },
  "lookupsEnabled": true
}
```

`state` is `not_connected` when there is no row. `companyName` is the QBO company name (office users
may see it). `waitingOffline` counts outbox rows held while sync is off. `writesEnabled` is false when
`QBO_WRITES=off`. The result `realm_in_use` adds `"takeoverOffer": true` for an admin with an open offer.

### 7.3 Webhook (route file `server/src/routes/v1/qbo-webhook.js`)

| Method and path | Level | Response |
| --- | --- | --- |
| `POST /api/v1/webhooks/qbo` | public, signed | 200 `{ received: n }`; 401 `invalid_signature` |

### 7.4 Setup wizard (route file `server/src/routes/v1/qbo.js`)

| Method and path | Level | Request | Response |
| --- | --- | --- | --- |
| `POST /api/v1/qbo/setup/scan` | office | | 202 `{ setup }`; 429 `qbo_throttled` within 15 minutes of the last scan |
| `GET /api/v1/qbo/setup/matches?kind=&status=&choice=&q=&cursor=&limit=` | office | | `{ data: [Candidate], cursor, more, counts }` |
| `PUT /api/v1/qbo/setup/matches` | office | `{ choices: [{ id, choice, qboId?, fishtapeId?, fieldChoices?: { field: 'fishtape'\|'quickbooks' }, confirmed?: boolean }] }` (max 500) or `{ bulk: { kind, status, choice } \| { kind, fieldsFrom: 'fishtape'\|'quickbooks' } }` | `{ updated }` |
| `GET /api/v1/qbo/setup/plan` | office | | `{ phases: [{ kind, link, createInQbo, createInFishtape, skip }], warnings: [{ code, message, count }], numbers: { invoice: { qboHighest, fishtapeNext }, estimate: {...} } }` |
| `POST /api/v1/qbo/setup/apply` | office | `{ raiseNumbers?: boolean }` | 202 `{ setup }` |
| `POST /api/v1/qbo/setup/cancel` | office | | `{ setup }` |

`Candidate`:

```json
{
  "id": "6f1c...", "kind": "customers", "status": "ambiguous", "choice": "link", "score": 70,
  "reasons": ["name"],
  "fishtape": { "id": "c-18", "label": "Smith, Dana", "email": "dana@example.ca", "phone": "204-555-0101" },
  "quickbooks": { "qboId": "58", "label": "Dana Smith", "email": "dana@example.ca", "phone": null, "active": true },
  "alternatives": [{ "qboId": "77", "label": "Dana Smith (2)" }],
  "diffs": [{ "field": "phone", "label": "Phone", "fishtape": "204-555-0101", "quickbooks": "" }],
  "fieldChoices": {},
  "confirmed": false
}
```

For documents `fishtape`/`quickbooks` carry `{ number, date, totalCents, balanceCents, status }`.
`qboId` is returned to office users here and in look-ups (needed to choose); it is the id of an object in
their own company, not the realm id.

### 7.5 Sync, records and log

| Method and path | Level | Request | Response |
| --- | --- | --- | --- |
| `POST /api/v1/qbo/sync` | office | `{ direction: 'both'\|'push'\|'pull' }` | 202 `{ queued: true }`; `push` at most once a minute, `both`/`pull` at most once every 5 minutes per tenant (else 429 `qbo_throttled`, 5.11) |
| `GET /api/v1/qbo/records/status?collection=&ids=` | office | `ids` comma list, max 200; omitted = every link of the collection | `{ data: { "<recordId>": RecordState } }` |
| `GET /api/v1/qbo/records/:collection/:id` | office | | `{ state: RecordState, quickbooks: { entity, docNumber, updatedAt, totalCents?, balanceCents?, unappliedCents?, url }, log: [LogEntry] (last 20), conflict: Conflict\|null }`. Built from the link (snapshot, `meta.qboTotalCents`, `qboBalanceCents`, `unappliedCents`, `qbo_updated_at`): no QBO call. Add `?live=1` for a fresh read (one CorePlus call, counted, look-up limits apply). For clients, `balanceCents` is the QBO customer's balance from the last pull. |
| `POST /api/v1/qbo/records/:collection/:id/sync` | office | `{ force?: boolean, asNew?: boolean }` | 202; also the Retry button and "Send to QuickBooks now" (pushes a draft). `asNew` (only on an `unlinked` tombstone): delete the tombstone and create in QBO |
| `POST /api/v1/qbo/records/:collection/:id/renumber` | office | | `{ number }` (estimates and invoices with `duplicate_number`) |
| `PUT /api/v1/qbo/records/:collection/:id/link` | office | `{ qboId }` | link to a different QBO object. The target must be the collection's entity type, exist and be active in QBO, and not be linked to another record (409 `qbo_already_linked`). The new link starts with B = null: every field that differs becomes a conflict, nothing is written either way (5.5). Audit `qbo.relink` |
| `DELETE /api/v1/qbo/records/:collection/:id/link` | office | | unlink: the link becomes an `unlinked` tombstone (5.6); both records kept; audit `qbo.unlink` |
| `GET /api/v1/qbo/checks?cursor=&limit=` | office | | the "Doesn't match" list of the last daily check (5.13): `{ data: [{ collection, recordId, label, kind: 'balance'\|'total'\|'clearing', fishtapeCents, quickbooksCents, checkedAt }], cursor, more }` |
| `GET /api/v1/qbo/log?cursor=&limit=&outcome=&collection=&recordId=` | office | | `{ data: [LogEntry], cursor, more }` |

`RecordState`:

```json
{ "state": "error", "reason": "tax_mismatch", "message": "QuickBooks tax $127.82, Fishtape $127.80. Check the tax code for GST/PST MB.", "syncedAt": "2026-10-21T15:39:40Z", "conflictId": null, "docNumber": "INV-3001" }
```

`url` is QBO's web link for the object (`https://app.qbo.intuit.com/app/invoice?txnId=<id>` and the
matching paths; sandbox `https://app.sandbox.qbo.intuit.com/...`; **VERIFY** the paths). `LogEntry`:
`{ id, at, direction, outcome, action, actorType, collection, recordId, label, message, errorCode,
intuitTid }`. The Intuit transaction id is shown in the log's detail view (office users may need it for
Intuit support) and to HQ (column grant, 3.2); it identifies a request, not a customer.

### 7.6 Mappings and reference lists

| Method and path | Level | Request | Response |
| --- | --- | --- | --- |
| `GET /api/v1/qbo/mappings` | office | | `{ mappings, choices, required, suggestions }` |
| `PUT /api/v1/qbo/mappings` | office | `{ set: [{ kind, key, value }], remove: [{ kind, key }] }` | same as GET; audit `qbo.mappings` |
| `POST /api/v1/qbo/reference/refresh` | office | | 202; at most once every 5 minutes |

`mappings` is `{ "<kind>": { "<key>": value } }`. Values: QBO ids as strings for `item`, `taxCode`,
`purchaseTaxCode`, `account`, `paymentMethod`, `depositTo`, `paidFrom`, `class`, `department`, `term`;
JSON values for `option`. Keys:

| Kind | Keys |
| --- | --- |
| `item` | `material`, `labour`, `other`, `markup`, `travel`, `deposit` |
| `taxCode` | tax keys (`GST+RST\|MB`, `GST`, `NONE\|ZERO`, `NONE\|EXEMPT`, `NONE\|OOS`, `NONE\|RELIEF`, `TAX`, ...) |
| `purchaseTaxCode` | purchase tax keys (`GST+RST\|MB`, `GST`, `NONE`, ...), plus `stripeFee` |
| `account` | `income.default`, `expense.default`, `jobCost.material`, `jobCost.subcontract`, `jobCost.equipment`, `jobCost.other`, `stripeClearing`, `stripeFees`, `stripePayoutBank` |
| `paymentMethod` | `cash`, `check` (also used for `cheque`), `card`, `transfer`, `e-transfer`, `other` (4.9 normalises method names first) |
| `depositTo` | the same method keys |
| `paidFrom` | `card`, `cash`, `cheque`, `debit`, `transfer` |
| `class`, `department`, `term` | `default` |
| `option` | the keys of 6.1, plus `stripeVendorId`, `stripeClearingOpeningCents` (set by the engine) |

`required` lists missing mappings that block setup or sync: every company tax key (the four `NONE|*`
keys only once a document uses that reason), `option.timeOwner` when `syncTime` is on, `item.material`,
`item.labour`, `item.other`, `account.income.default`, `account.expense.default`, `depositTo` for every
method used by existing payments, `account.jobCost.material` when purchasing is on,
`account.stripeClearing`, `account.stripeFees` and `account.stripePayoutBank` when Stripe is connected
and the options are on, `paidFrom` for each method used by receipts.

`choices` comes from `qbo_reference`: `{ items: [{ id, name, type }], accounts: [{ id, name, type,
subType }], taxCodes: [{ id, name, active, salesRates: [{ name, pct }], purchaseRates: [...] }],
paymentMethods, classes, departments, terms }`. PUT validates each id against `qbo_reference` and its
type: income accounts `Income`; expense and job cost `Expense`, `Other Expense` or `Cost of Goods Sold`;
Stripe clearing and payout bank `Bank`; Stripe fees `Expense`; sales tax codes active with sales rates
whose percentages equal the key's components on today's date (4.8); purchase tax codes active with
purchase rates and, for a key containing PST or RST, no provincial PST/RST purchase rate (4.8). Options
are validated by type; `jobsAsSubCustomers` is refused (409 `qbo_option_locked`) once a document has
been pushed. Every PUT re-queues `error` and `blocked` links.

### 7.7 Conflicts

| Method and path | Level | Request | Response |
| --- | --- | --- | --- |
| `GET /api/v1/qbo/conflicts?status=open&cursor=&limit=` | office | | `{ data: [Conflict], cursor, more }` |
| `GET /api/v1/qbo/conflicts/:id` | office | | `Conflict` |
| `POST /api/v1/qbo/conflicts/:id/resolve` | office | `{ choice, fields?, recordId? }` (5.6) | `Conflict` (resolved) |

```json
{
  "id": "0b7e...", "kind": "fields", "collection": "invoices", "recordId": "inv-77", "label": "Invoice INV-3001",
  "status": "open", "createdAt": "2026-10-21T15:41:00Z",
  "fields": [
    { "field": "lines", "label": "Lines", "base": "3 lines, $1,065.00", "fishtape": "4 lines, $1,215.00", "quickbooks": "3 lines, $1,105.00" },
    { "field": "date", "label": "Date", "base": "2026-10-20", "fishtape": "2026-10-20", "quickbooks": "2026-10-21" }
  ]
}
```

### 7.8 Live look-up

Search terms are customer names, so they never go in a URL (nginx error logs record request lines,
TM-LEAK-05): searches are `POST` with a JSON body.

| Method and path | Level | Body or path | Response |
| --- | --- | --- | --- |
| `POST /api/v1/qbo/lookup/customers` | office | `{ q (2 to 100 chars; DisplayName LIKE 'q%'), limit (max 25) }` | `{ data: [{ qboId, name, companyName, email, phone, balanceCents, active, isJob, linked: { collection, id } \| null }] }` |
| `POST /api/v1/qbo/lookup/invoices` | office | `{ clientId (Fishtape) or qboCustomerId, status ('open'\|'all'), q (DocNumber prefix, max 21), limit }` | `{ data: [{ qboId, docNumber, date, dueDate, customer, totalCents, balanceCents, status, linked }] }` |
| `POST /api/v1/qbo/lookup/estimates` | office | as invoices; `status` (`pending`\|`all`) | as invoices with `status` from `TxnStatus` |
| `GET /api/v1/qbo/lookup/:entity/:qboId` | office | `entity` = `customer`\|`invoice`\|`estimate` | the object summarised: header, lines `{ description, qty, amountCents, taxCode }`, tax, totals, `linked` |
| `POST /api/v1/qbo/lookup/:entity/:qboId/import` | office (write, MFA) | | `{ collection, id }` after creating the Fishtape record and link (its dependencies first). An imported invoice gets its settlement payment (4.9), so one paid before `syncFrom` shows as paid. Runs under the tenant lease (5.8). |

Input rules (W3 `lookup.js`, unit-tested with `'`, `%`, `_` and `\`): every value placed in QBO query text
goes through W2's `qboQuote(s)`, which escapes `\` and `'` and rejects `%` and `_` (400
`validation_failed`); `qboId` and `qboCustomerId` must match `^\d{1,20}$`; `q` is at most 100
characters. The scan and every engine query use `qboQuote` too.

Look-ups are CorePlus: cached in memory for 60 seconds per tenant and query, limited to 30 per minute per
user, respect `throttled_until`, and are stopped by the budgets (5.11). Results are never stored, except
by import.

### 7.9 Plan, entitlements and registries

- `electrical-app/js/plans.js` `FEATURE_PLAN` gains `quickbooks: 'pro'` and `purchasing: 'pro'`. Both are
  also module ids (the PWA module files are `quickbooks.js` and `purchasing.js`; `plans.test.mjs` requires
  each module file name to be a `FEATURE_PLAN` key). HQ overrides come for free (`OVERRIDE_KEYS`).
- `GET /api/v1/me` already returns entitlements; the PWA uses `quickbooks` from there.
- `server/src/services/entitlements.js` `COLLECTION_FEATURES`: `vendors`, `bills`, `purchaseOrders` map
  to `['purchasing']`.

---

## 8. PWA screens

Office only: the `quickbooks` module has `perm: 'invoices'` (owner, admin, office; not foreman). All
text says "QuickBooks" in full. The connect control is Intuit's official "Connect to QuickBooks" button
image (green, from Intuit's developer site, unaltered, in `electrical-app/img/intuit/`; W4 records the
asset's licence terms in `electrical-app/img/intuit/README.md` and shows it at its intrinsic size; the
service worker caches the file as is); the disconnect control reads "Disconnect from QuickBooks".
Fishtape's own name stays larger than any Intuit mark. The QuickBooks screens' footer and the guide end
with "QuickBooks and Intuit are trademarks of Intuit Inc., used with permission." (**VERIFY** the exact
wording Intuit's branding guidelines ask for).

### 8.1 Module and routes

`electrical-app/js/modules/quickbooks.js`: `{ id: 'quickbooks', title: 'QuickBooks', group: 'money',
perm: 'invoices', render }`. Not tied to a module switch (always on when the plan has it). Routes:

| Hash | Screen |
| --- | --- |
| `#/quickbooks` | Overview: connection card, status, counts, Sync now, Pause, links to the rest |
| `#/quickbooks?connect=1` | Starts the connect flow at once (the Intuit launch and reconnect URLs land here) |
| `#/quickbooks?connect=<result>` | Shows the callback result (`ok` or an error in words) |
| `#/quickbooks/setup` | The wizard (8.3) |
| `#/quickbooks/mappings` | Mappings (8.4) |
| `#/quickbooks/activity` | Sync log with filters |
| `#/quickbooks/conflicts` and `#/quickbooks/conflicts/<id>` | Conflicts list and resolve |
| `#/quickbooks/lookup` | Live look-up |

### 8.2 Overview card states

- Not entitled: the usual locked-module upgrade card (`app.js` does this).
- Server not configured: "QuickBooks isn't available on this server yet."
- Not connected: what syncs, a short guide link (`guides/quickbooks.md`), the Connect button (owner and
  admin; office sees "Ask an owner or admin to connect").
- Setup: progress and "Continue setup".
- Active: company name, edition, last sync times, counts as links (errors, waiting, conflicts, to check,
  doesn't match), Sync now, Pause, Disconnect (owner and admin, with the purge choice, unticked).
- Shadow mode: a banner "Practice mode: nothing is written. Read the 'would change' list" with a link to
  the log filtered to `shadow`, and "Go live" (owner or admin).
- `QBO_WRITES=off`: a banner "Sending to QuickBooks is paused by Fishtape. Your changes are kept and will
  be sent."
- Paused / reconnect needed: the reason in words, the number of changes waiting to be sent
  (`waitingOffline`), and the action (Resume, Reconnect, Upgrade). A safety-brake pause shows the counts
  and asks to confirm "Allow N changes". An HQ pause says "Paused by Fishtape support" with no Resume.
- Result `realm_in_use`: "This QuickBooks company is connected to another Fishtape company." For an
  owner or admin with an open offer: "Move it to <this company>" (2.9), with a confirmation that names
  what happens.
- "Doesn't match" card: the daily check's list (7.5) with both amounts.

The Integrations screen (`modules/integrations.js`, owner/admin) shows a QuickBooks card that links to
`#/quickbooks`. Settings > "Accounting and imports" links to it as well; the CSV export stays.

### 8.3 Wizard

Steps: 1 Connect; 2 Settings (6.1, plain words: "Start syncing from" date picker, "Which system holds
payroll hours?", "Last pay period run", "Last GST return filed", "Book Stripe from", "Practice week first"
switch); 3 Tax codes, products and accounts (8.4 in wizard mode, required items first); 4 Match: tabs
Customers, Jobs, Products, Employees, Suppliers, Invoices, Estimates, Payments, each a table with Fishtape
| QuickBooks | score | choice, filters (Matched, Needs a choice, Possible duplicates, Only in Fishtape,
Only in QuickBooks), bulk actions; 5 Review: differences per linked record (each field with both values
and a Fishtape / QuickBooks choice, bulk "use Fishtape for all" / "use QuickBooks for all"), possible
duplicates, creates in a filed GST period with their ticks, counts per kind and action, warnings, the
numbering offer; Apply stays disabled until every difference has a choice; 6 Apply with a progress bar
that polls `/qbo/status` every 3 s, then a summary with failures and Retry.

### 8.4 Mappings screen

Sections: Tax codes (each Fishtape tax situation in words, e.g. "GST + Manitoba RST", "GST only (customer
has a PST/RST number)", "No tax: zero-rated", "No tax: exempt", "No tax: out of scope", "No tax: Indian Act
relief", with a picker showing each QuickBooks code's rates; codes whose rates differ from Fishtape's,
e.g. a PST 8% rate, are refused with the reason); Purchase tax codes (with the line "PST and RST you pay
on purchases are added to the cost; only GST/HST/QST is claimed", and refusal of codes that would claim
PST/RST); Filed GST period ("Last GST return filed", read-only when QuickBooks provides it); Payroll
lock ("Last pay period run"); Products and services (Materials, Labour, Other, Markup, Travel, Deposits); Accounts (income and
expense for new products, job cost accounts per cost type, Stripe clearing, Stripe fees, payout bank,
paid-from per receipt method); Payment methods and where each is deposited; Class and location defaults
(only when on in QuickBooks); Numbering; Options (6.1). Save shows what changed and re-queues errored and
waiting records.

### 8.5 Per-record badges

`electrical-app/js/lib/qbo-ui.js` exports `qboBadge(ctx, collection, recordId) → Element|null` and
`qboStatusCache` (loads `GET /qbo/records/status?collection=` once per screen, 30 s cache, in memory
only). It returns null unless the user can use QuickBooks (`auth.can('invoices')`), the plan has it and
the tenant is connected and active. Badge text by state is in 3.4; clicking opens a small sheet with the
record state, the last log lines, "Open in QuickBooks" (the `url`), Retry, Renumber, Unlink and the
conflict link. Mount points (one call each):

- invoices: list status column (`modules/invoices.js` around l.108), detail `drawStatus` (l.225-239,
  next to `invoiceOnlineTools`), payments list rows (`drawPayments` l.241-250, collection `payments`);
- estimates: list column (l.62) and detail `drawStatus` (l.233-245);
- clients: contact card badge row (`modules/clients.js` l.132);
- purchasing screens (bills, vendors, POs) and the time approval list (approved entries).

Badge extras: an `unlinked` tombstone offers "Send to QuickBooks as new" and "Link…"; a record on the
"Doesn't match" list shows "Doesn't match QuickBooks" with both amounts; an `origin` review shows
"Approve and send". Settlement payments (method `credit`, 4.9) appear in the invoice's payments list as
"Credited or paid in QuickBooks" and cannot be edited or deleted there (W4, `modules/invoices.js`).

**No-tax reason** (W4, `modules/invoices.js` and `modules/estimates.js`): when the document's treatment
is `none` (or any kind has no tax), the tax section shows "Why no tax?" with Zero-rated, Exempt, Out of
scope, Indian Act relief (field `taxNoneReason`). It shows for every tenant, connected or not, since it
also matters for the GST return.

### 8.6 Look-up panel

A search box on `#/quickbooks/lookup` and a "Look up in QuickBooks" action on the client page (prefilled
with the client) and on the new-invoice and new-estimate screens. Results show linked records with a
link to them, others with "Import into Fishtape". Disabled with a reason when look-ups are off (budget)
or offline.

### 8.7 Offline

QuickBooks screens need a connection: offline they show "You're offline; QuickBooks needs a connection"
and the last loaded status greyed. Badges are hidden offline. Editing records offline works as before;
changes reach QuickBooks after the device syncs and the 20-second debounce. Nothing from QuickBooks is
stored on the device except the Fishtape records themselves; the status cache is memory only.

### 8.8 Notifications

Kind `quickbooks` (`lib/notify.js` `KIND_LABEL: 'QuickBooks'`, icon `link`): reconnect needed, token
expiring (30/7/1 days), daily summary (new errors, new conflicts and reviews, "doesn't match" count),
setup finished, safety brake, read budget at 50%/80%/100%, a tax mismatch after an update (at once),
company moved to another Fishtape company (takeover, also by email to owners), auto-disconnect. All to
`role: ['owner', 'admin', 'office']`, link `#/quickbooks...`.

### 8.9 Purchasing module (W5)

`electrical-app/js/modules/purchasing.js`: `{ id: 'purchasing', title: 'Purchasing', group: 'money',
perm: 'invoices' }`, routes `#/purchasing` (bills and receipts list), `#/purchasing/bills/<id>`,
`#/purchasing/vendors`, `#/purchasing/vendors/<id>`, `#/purchasing/orders`, `#/purchasing/orders/<id>`.
Receipt capture uses the existing downscaled photo capture (JPEG, max 2.5 MB) and accepts a PDF. The
office material-requests list (`modules/materials.js`) gains "Create purchase order" for selected
requests (grouped by chosen vendor, numbered `PO-`, requests set to `ordered`). Works with or without
QuickBooks connected.

---

## 9. HQ

HQ sees health, never customer data.

- `GET /api/hq/tenants/:id` (`services/hq-tenants.js` `tenantDetail`) gains:

  ```json
  "quickbooks": {
    "connected": true, "state": "active", "pauseReason": null, "reconnectReason": null,
    "environment": "production", "edition": "QuickBooks Online Plus",
    "connectedAt": "...", "lastPullAt": "...", "lastPushAt": "...", "lastWebhookAt": "...",
    "refreshExpiresAt": "...", "hardExpiresAt": "...",
    "links": { "synced": 1520, "pending": 3, "error": 1, "blocked": 2, "conflict": 0, "needs_review": 0 },
    "errors24h": 4, "conflictsOpen": 0, "inboxBacklog": 0, "outboxWaiting": 0, "outboxOldestAt": null,
    "pausedSince": null, "lastCheckAt": "...",
    "usageThisMonth": { "core": 812, "coreplus": 1430, "budget": 20000 }
  }
  ```

  from the column-granted tables only. No company name, no record ids, no messages.
- `hq/js/pages/tenant.js` shows it as a card; "reconnect needed" and errors in red.
- `GET /api/hq/developer/quickbooks` (`routes/hq-developer.js`): month, workspace CorePlus and Core
  totals, budget and percentage, Intuit's cap (500,000), tenants by state (counts), the top 20 tenants
  by CorePlus use (tenant name from `tenants`, counts only). Shown on `hq/js/pages/developer.js` next
  to "Companies' integrations".
- Queue health already lists `qbo_*` job kinds (`hq-health.js queueDetail`). Their `last_error` holds
  only the fixed-table messages of 5.8, never customer data or realm ids.
- **Actions** on the tenant page (HQ staff, reason required, audited): "Pause QuickBooks sync" /
  "Resume" and "Release QuickBooks company" (2.9), through `routes/hq-tenants.js`.
- **Alerts** (W6 `server/src/qbo/alerts.js`, run by `qbo_alerts` every 10 minutes in the worker, email to
  `HQ_NOTIFY_EMAIL` through `platform-email.js`, at most one email per alert kind per hour). Sources:
  `qbo_platform_events` (3.2), `jobs_queue` (failed `qbo_*` jobs), `qbo_api_usage`, and, for the inbox
  backlog, a per-tenant `withTenant` loop over connected tenants like the dispatcher's:
  `qbo_platform_credentials` (token breaker opened, 2.4), `qbo_mass_revoke` (5+ `invalid_grant` in 15
  minutes), `qbo_reconnect_spike` (3+ tenants entering `reconnect_needed` in an hour), `qbo_webhook_signature`
  (any failed signature in the last hour), `qbo_jobs_failing` (5+ failed `qbo_*` jobs in an hour),
  `qbo_inbox_backlog` (a tenant dirty for more than 2 hours while `active`), `qbo_intuit_5xx` (more than 20
  Intuit 5xx answers in 10 minutes), `qbo_budget` (workspace at 70% and 90%; a tenant at 50%),
  `qbo_safety_brake` (any tenant), `qbo_realm_mismatch` (3.2), `qbo_revoke_gave_up`. `docs/compliance/
  logging-monitoring.md` and `docs/runbooks/incident-response.md` list them with the first steps.
- HQ settings (`services/hq-settings.js envSettings`) shows `QBO_ENVIRONMENT`, `QBO_WRITES` and the
  budgets, and whether `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER` and
  `QBO_WEBHOOK_VERIFIER_PREVIOUS` are set (never values).
- The `qbo_*` support views of a tenant's records follow the existing audited support-access grant; HQ
  gets no QBO-specific data access beyond the column grants of 3.2 (Intuit transaction ids included, for
  Intuit support).

---

## 10. Security and privacy

### 10.1 Rules

- Tokens and realm ids: encrypted in `tenant_secrets`; never in responses, logs, job payloads, audit,
  URLs Fishtape builds (except the API URL sent to Intuit) or HQ. The generic secret routes cannot read,
  write or delete them (2.3).
- Logs: the QBO client logs method, entity name, status, fault code and `intuit_tid` only, never the URL
  (it contains the realm id), query text or body. `http.js` `scrub` is applied to every QBO message
  stored in `last_error`, `qbo_sync_log.message` or shown to users; W1 adds patterns for long base64url
  strings (tokens) and the name-safe rule of 5.8. Errors that leave the tenant (`jobs_queue.last_error`,
  worker stdout, HQ) carry only the fixed-table messages of 5.8.
- `server/src/logger.js` `SECRET_QUERY` gains `realmId`, `realm_id` and `ticket` (W1), so any request or
  error log line on the start, callback or launch routes is redacted even if the warn-level rule is
  bypassed. The callback and start routes still log at `warn` (no request lines). nginx already drops
  query strings from `/api/` access logs; its error log can still hold a request line (TM-LEAK-05), which
  is why look-up searches are `POST` bodies (7.8) and nothing else sensitive is put in a QBO URL.
- Response headers carry no QBO data. The callback answers 302 only.
- Webhook: HMAC check on the raw body before anything is parsed or stored (two verifiers during a
  rotation); unknown realms dropped; events are triggers only, and webhook-only signals are confirmed by a
  read before anything is written (5.9).
- No QBO data in `settings` or any synced record field (3.1), so field crews and offline devices never
  hold it. QBO customer `Notes` are never pulled (4.2), because client records are readable by field
  roles.
- Money reaches QBO only from office users, Stripe or the system; API-key and agent writes wait for an
  office user's approval (origin rule, 5.2). Every QBO write route needs a two-step-verified session
  (7.1).
- QuickBooks query text is built only with `qboQuote` and id patterns (7.8).
- AI: `qbo_*` tables and look-up results are never given to the assistant, background agents, MCP or
  API keys. Records that sync with QuickBooks (clients, invoices, bills, payments) are ordinary tenant
  records and stay readable by the assistant, MCP and API keys like any other record; this is
  **disclosed** in the Intuit questionnaire, the EULA and the privacy policy, and on the connect screen
  ("Fishtape's assistant can read your Fishtape records, including those that sync with QuickBooks").
  If Kelvin chooses opt-in instead (open question 13.11), W3 adds the exclusion to
  `server/src/ai/data.js` and `server/src/routes/mcp.js` (records with a `qbo_links` row are skipped
  unless `option.aiAccess` is true).
- Client portal: not built yet; the rule for when it is (hide `needs_review` and pull-created documents
  until released) is a BACKLOG item (1.2).

### 10.2 Tests that must exist

- Isolation (W3 adds to `server/test/isolation.test.js`): tenant B cannot read or change A's links, log,
  conflicts, mappings, candidates or status through any QBO route; a webhook for A's realm never writes
  B's rows; a connect ticket or state issued to A's user cannot connect B; two tenants cannot hold the
  same realm (`realm_in_use`); a reconnect with another realm fails (`wrong_company`); **a first connect
  to a different realm, or the other environment, after a disconnect without purge is refused
  (`purge_required`) and no request ever carries an old QBO id**; switching `QBO_ENVIRONMENT` from
  sandbox to production leaves the tenant `reconnect_needed/environment` with no Intuit call;
  `qbo_realms` and `qbo_api_usage` refuse inserts and deletes for another tenant.
- Roles: every QBO route returns 403 to foreman, electrician, apprentice, crew sessions and API keys;
  connect, disconnect and takeover return 403 to office; every write route returns 403 `mfa_required` to a
  session without two-step verification.
- Secrets: `GET`, `PUT` and `DELETE /api/v1/secrets/qbo.refresh_token`, `qbo.access_token` and
  `qbo.realm_id` return 400 and change nothing (W1).
- Leaks (W3 adds to `server/test/leaks.test.js`): no token, realm id, refresh token, verifier or ticket
  in any response body, header, log line or error, across connect, start, callback, status, look-ups and
  failures (use distinctive fake values like the existing `SECRET_VALUES` test). A forced 6240 with a
  distinctive customer name never appears in `jobs_queue.last_error`, worker output or any HQ response.
  A failing callback and a failing start log no `realmId` and no `ticket`.
- Records: a field role's `/sync/pull` and record reads contain no QBO keys after a full sync, and no
  text from a QBO customer's `Notes`.
- `qbo_reference`: storing an Employee or Vendor keeps only the allow-listed keys (3.8).
- Origin: an API-key payment and an assistant-created invoice go to `needs_review/origin`; an office
  user's go straight out; a foreman's time approval goes out (or not, per 13.13).
- Revoke: `realm_in_use` never calls revoke; the fake QBO models a grant-level revoke, and a test shows
  tenant A keeps working after tenant B's failed connect for A's realm.
- Platform credentials: a token-endpoint `invalid_client` leaves every tenant's state unchanged, opens
  the breaker and raises `qbo_platform_credentials`.
- Lifecycle: a suspended or closed tenant is not synced; closing a tenant revokes; a failed revoke lands
  in `qbo_revoke_pending` and is retried.
- Webhooks: a body signed with the previous verifier is accepted while it is set; a TimeActivity delete or
  a merge from a webhook is acted on only after the confirming read; the inbox holds one row per object
  however many events arrive while paused; a poison inbox row stops after 5 attempts.

### 10.3 Threat model additions (`docs/security/threat-model.md`, W6)

| Id | Threat | Mitigation |
| --- | --- | --- |
| TM-QBO-01 | OAuth login CSRF: someone else's QuickBooks connected to an attacker's tenant | Ticket (120 s, single use, owner/admin with MFA) + interstitial naming the Fishtape company and requester + flow cookie + state row; `web` tickets need the issuer's session; connect notification names the company (2.2) |
| TM-QBO-02 | Token theft from the database or backups | Envelope encryption with AAD; key outside the database; revoke on disconnect; generic secret routes refuse QBO names |
| TM-QBO-03 | Forged webhooks driving reads or writes | HMAC on the raw body (two verifiers during rotation); events only mark the tenant dirty or name an id to read; webhook-only signals confirmed by a read |
| TM-QBO-04 | Cross-tenant routing of webhook events | realm hash unique per tenant; events stored under the tenant found by hash only |
| TM-QBO-05 | Refresh-token race losing the rotated token | Single-flight per tenant (in-process + row lease); newest token stored in a short transaction |
| TM-QBO-06 | Sync loop or mass overwrite (a bug writes every record) | Actor check, SyncToken echo drop, snapshot merge; safety brake per tenant per hour (`paused/brake`); `QBO_WRITES=off`; shadow mode; HQ pause |
| TM-QBO-07 | QBO data reaching field crews or the client portal | No QBO fields on records; QBO `Notes` never pulled; office-only routes; portal rule in BACKLOG; tests |
| TM-QBO-08 | CorePlus exhaustion by one tenant blocking everyone | Per-tenant budget on every read with step-down and pause; scan and pull rate caps; trial budget; workspace budget; HQ alerts |
| TM-QBO-09 | Callback code, realm or ticket in logs or Referer | 302 only, warn-level logging, `SECRET_QUERY` redaction of `code`, `state`, `realmId`, `ticket`; `Referrer-Policy` already strict |
| TM-QBO-10 | Old links used against a different company or environment | Server-side `purge_required`; `realm_hash` on every QBO-id row; environment check before any call (2.2, 2.4, 3.2) |
| TM-QBO-11 | A realm squatted by a former employee's tenant | Takeover by a QuickBooks admin; HQ release; auto-disconnect of long-paused or inactive tenants (2.4, 2.9) |
| TM-QBO-12 | Denial of service to another tenant through revoke | Revoke only when no tenant holds the realm (2.2) |
| TM-QBO-13 | Platform credential error read as mass revocation | Token breaker and mass-revoke guard; HQ alert (2.4) |
| TM-QBO-14 | Customer data in job errors, worker logs and HQ | Fixed-table error messages; name-safe scrub (5.8) |
| TM-QBO-15 | Money written to the books by an API key, agent or phished office user | Origin rule; MFA on write routes (5.2, 7.1) |
| TM-QBO-16 | QuickBooks query injection | `qboQuote`, id patterns, length caps (7.8) |
| TM-QBO-17 | Duplicate postings from retries, crashes or overlapping workers | Committed pending links, marker, adopt-by-search, lease epoch fencing, heartbeat, QuickBooks worker pool (5.3, 5.8) |

### 10.4 Data retention and deletion

- Disconnect: tokens deleted and revoked at once (a failed revoke is retried from `qbo_revoke_pending`
  for 14 days); sync stops at once; links, snapshots, mappings, reference lists, candidates, the outbox
  and the log are deleted at once with "Delete QuickBooks data now", else after 30 days. This meets
  Intuit's "stop accessing, securely delete on request" terms.
- Records created from QuickBooks stay as the tenant's own records (same as any import).
- Tenant close or deletion: QuickBooks is disconnected with revoke first (2.5); then deletion cascades all
  `qbo_*` rows (FK `ON DELETE CASCADE`). `qbo_revoke_pending` has no tenant FK on purpose.
- Retention: sync log 90 days, processed inbox 30 days, resolved conflicts 90 days, usage counts 13
  months, candidates 30 days after their scan, OAuth states and takeover offers deleted on use or
  expiry (OAuth state rows also cascade when the user is deleted), platform events 30 days. W1's
  `qbo_purge` (hourly) applies all of these and the 30-day disconnect purge.
- Backups keep deleted rows until they age out (8 weeks), as for all tenant data
  (`docs/compliance/backup-retention.md`).

### 10.5 Compliance documents (W6)

- `docs/compliance/vendor-management.md`: add Intuit (QuickBooks Online). Each tenant connects its own
  QuickBooks; Fishtape holds the platform app credentials under the Intuit Developer Terms; data: the
  tenant's customers, items, documents, payments, bills, employee time; review: annual Intuit security
  review and questionnaire. Record the hosting region of each server that holds QuickBooks data.
- `docs/compliance/privacy.md`: QuickBooks data flows both ways at the tenant's request; Fishtape is the
  tenant's service provider; deletion on disconnect; the AI disclosure of 10.1.
- `docs/compliance/backup-retention.md`: the retention rows above.
- `docs/compliance/logging-monitoring.md`: the QBO log rules and the HQ alerts of section 9.
- `docs/security/secrets-management.md`: the three internal secret names, `QBO_CLIENT_SECRET`,
  `QBO_WEBHOOK_VERIFIER(_PREVIOUS)`, and `qbo_revoke_pending`.
- `docs/runbooks/rotate-secrets.md`: rotating `QBO_CLIENT_SECRET` (both values never live at once at
  Intuit, so expect the breaker for a minute), rotating the webhook verifier with
  `QBO_WEBHOOK_VERIFIER_PREVIOUS`, and the `qbo-rehash.js` step with a master-key rotation (2.3).
- `docs/runbooks/offboard-tenant.md`: disconnect QuickBooks (revoke) before closing a tenant.
- `docs/runbooks/incident-response.md`: `QBO_WRITES=off` first, then HQ pause of the tenants concerned.
- `docs/runbooks/quickbooks-support.md` (new): reconnect, token problems, reading the sync log, finding
  an `intuit_tid` for Intuit support, pausing and releasing a tenant, takeover, purging, the safety
  brake, the "doesn't match" list, and **moving a server** (staging to production): set `QBO_WRITES=off`
  and empty `QBO_ENVIRONMENT` on the old server and stop its worker; move the data with the same
  `SECRETS_MASTER_KEY` (or re-wrap and run `qbo-rehash.js`); point Intuit's webhook at the new server;
  set the keys there; check one tenant in shadow mode before going live. Never two servers holding live
  tokens for the same company.

---

## 11. Testing strategy

### 11.1 Fake QBO server (`server/test/support/fake-qbo.js`, W1)

An in-memory QuickBooks used through `setFetch` (unit and route tests) or as a real HTTP server
(`listen()`, for e2e with `QBO_API_BASE`/`QBO_OAUTH_BASE`). It must support:

- OAuth: authorize redirect (returns a code for a chosen realm), code exchange (second use:
  `invalid_grant`), refresh with rotation (the old token stops working; reuse returns `invalid_grant`),
  revoke, hard-expiry header, forced `invalid_grant` to simulate a disconnect in QuickBooks, forced
  `invalid_client` (platform credentials), and **grant-level revoke** (revoking any token of an app and
  realm ends every token of that pair, the pessimistic reading until 11.4 settles it).
- Per realm: CompanyInfo (country, currency, edition), Preferences, entities Customer, Vendor,
  Employee, Item, Account, TaxCode, TaxRate, TaxAgency, PaymentMethod, Class, Department, Term, Estimate,
  Invoice, Payment (several lines, lines on credit memos and unlinked invoices, unapplied amounts),
  CreditMemo (applied to invoices), Bill, Purchase (incl. `Credit: true`), PurchaseOrder, TimeActivity,
  Transfer, Attachable upload; `GlobalTaxCalculation` `TaxInclusive` on any transaction.
- Create, read, full and sparse update with `SyncToken` increments and **5010** on a stale token; delete
  and void; `requestid` replay returns the first response (with a configurable dedupe window, default
  off, so tests prove correctness does not rely on it); "create then time out" (the object is created but
  the response is dropped); `MetaData.CreateTime` and `LastUpdatedTime`.
- Query: the subset Fishtape uses (`select * | count(*) from X where a op 'v' [and ...] orderby
  startposition maxresults`, `like 'x%'`, `in (...)`).
- CDC with `changedSince`, the 1,000-object cap and deleted stubs.
- Batch (max 30, configurable to 10).
- Sales tax maths for Canadian codes (GST/PST MB 5% + 7%, per-rate rounding on summed amounts, two
  `TaxLine`s, `ReadOnly` rates refusing overrides), duplicate DocNumber 6140 and duplicate name 6240.
- Fault injection: next N calls 429 / 500 / 503 / 401, latency beyond the 30 s timeout, fault 5030 for
  an entity, 6000 closed-books, 6000 "Amount is not equal to UnitPrice x Qty", refusal to deactivate a
  customer with a balance, refusal to void a payment in a deposit.
- Webhook emitter: builds CloudEvents bodies for changes it made and signs them with a verifier (or a
  second one); can drop events, to prove CDC catches up.
- Call log with Core/CorePlus counts; fails the test on any unexpected URL (like `integrations.test.js`).

### 11.2 Unit tests (no database)

- W2: mappers both directions for every entity (golden JSON fixtures in `server/test/fixtures/qbo/`),
  name rules, address round trip, lossy lines, markup round trip, negative lines, tax key mapping,
  `taxesFromCodes`, tolerance rules, override builder; `threeWayMerge` table-driven over every case of
  5.5 for each collection, the stale revert guard, lines as one field, auto vs money, the 10-minute
  window, B = null, `remoteAlias`; canonical cuts (notes, number, reference) and lossy-suffix stripping
  never produce a difference on round trip; status collapse; tax code id comparison and many-to-one
  reverse mapping (legacy `TAX`, `HST|ON` province from the key); `NONE|*` keys; RST spread on purchases
  (pro rata, remainder on the largest line); tax-inclusive bill conversion; Payment line rebuild that
  keeps foreign lines and the unapplied amount; settlement amount; match scoring (name-only is
  ambiguous, possible-duplicate pass, payment matching on balance, net-of-fee) and normalizer parity
  with `importers.js`; per-field wizard baselines; `requestIdFor` stability and length; `qboQuote` with
  `'`, `%`, `_` and `\`; `tax.js` `gst-only` treatment.
- W1: env parsing, authorize URL, webhook signature (valid, wrong, missing, tampered body, previous
  verifier), CloudEvents and legacy parsing, error classification of every fault code in section 5.8,
  fixed-table error messages (no Intuit detail), name-safe scrub, limiter maths, `logger.js` redaction of
  `realmId` and `ticket`.

### 11.3 Server tests with the embedded Postgres (`npm run test:embedded`)

- W1: migration 0150 (RLS ENABLE+FORCE and a policy on every tenant table, the `qbo_realms` and
  `qbo_api_usage` policies, grants, HQ column grants, realm uniqueness); connect flow at service level
  (ticket, interstitial, start, callback success and every failure, `purge_required`, the revoke rule,
  takeover); token single-flight (two concurrent `withAccessToken` calls make one refresh, no
  transaction held during the call); rotation stored; `invalid_grant` to `reconnect_needed` with a
  notification, after the re-read; `invalid_client` breaker; environment mismatch; disconnect with and
  without purge, outbox kept, failed revoke to `qbo_revoke_pending`; housekeeping auto-disconnect;
  webhook ingest (routing, dirty flag, inbox upsert, unknown realm); usage counting and budgets; the
  secret routes refusing QBO names; `qbo-rehash.js`.
- W3: route tests for every route in section 7 (roles, plan, shapes, errors); push of each entity;
  pull of each entity; CDC catch-up after downtime and the >29-day full reconcile; webhook to pull end
  to end; loop prevention (a pushed change produces a webhook that causes no write); 5010 handling;
  429 backoff and `throttled_until`; poison records; dependency blocking; module switch off; plan drop
  to Starter; conflicts open and every resolve choice; stale device write merge in `records.js`
  (5.10 both examples); the safety brake per hour and "allow once"; wizard scan, choices, apply with
  injected failures; look-up cache and budget; Stripe fee and payout objects. Plus the **data-integrity
  matrix**:
  - timeout then edit then retry, for a TimeActivity, an invoice and a customer: exactly one QBO object
    each (adopt-by-search), also after a simulated worker crash between QBO's answer and the commit;
  - a wizard batch that fails half-way is resumed item by item with no duplicate;
  - a multi-line QBO payment (two linked invoices, a credit-memo line, an unlinked 2025 invoice, $500
    unapplied): a Fishtape reference edit and a Fishtape delete of one part leave the other lines,
    `TotalAmt` and the unapplied amount exactly as they were;
  - pause, `reconnect_needed`, brake and plan drop, each with edits made meanwhile: all edits are pushed
    after resume; a write made by direct SQL is picked up by the sweep;
  - an offline money-field edit racing a QBO pull opens a conflict; a non-money field merges;
  - a wizard run with an invoice re-keyed in QBO under another number (possible duplicate, no create)
    and Stripe payments entered in QBO on the payout day or net of fees (linked, no double payment);
    a name-only customer match stays ambiguous; a QBO customer with no phone gets Fishtape's phone;
  - a tax-inclusive QBO Expense pulled as a net bill; a tax-inclusive QBO invoice to `needs_review`;
  - a Manitoba bill with GST and RST: GST-only code, RST in line cost; the mappings PUT refuses a code
    that claims RST;
  - a payout whose charges include one before the cutover (skipped), one with a dispute fee (fee
    Purchase), one with a refund (review), a test-mode payout (skipped), and `failed` after `paid`
    (Transfer deleted);
  - a create whose QBO tax differs by more than 2 cents is deleted again; a mapped code with 8% PST is
    refused before the create;
  - a one-cent refused override: pay link charges the QBO total, a QBO payment of that total marks the
    invoice paid;
  - an invoice settled in QBO by a credit memo shows paid in Fishtape through the settlement payment;
  - a QBO void zeroes no Fishtape lines; a Fishtape void of an invoice with QBO payments opens a
    conflict; a refused Fishtape delete restores the record;
  - unlink then edit creates nothing; restore of a voided invoice opens a conflict;
  - a QBO delete of a Stripe payment opens a conflict and never reopens the invoice;
  - a CDC pass triggered by an Invoice webhook still pulls a Bill whose webhook was lost;
  - a time edit on or before `timeLockedThrough`, and a document edit on or before `taxFiledThrough`, go
    to review;
  - two overlapping workers (one paused past its lease) write nothing twice (epoch fencing);
  - `qbo_*` jobs cannot occupy the general worker slots; a long apply is not reclaimed while it
    heartbeats.
- W5: CRUD and permissions for the three new collections (crew 403/none in pull, office allowed),
  plan and switch gating, generated migration matches.
- W6: Stripe fee fetch, payout balance-transaction fetch and payout handling with a fake Stripe
  (test mode, non-CAD, manual payout, `failed` after `paid`); `amountDueCents` with and without an
  adjuster; HQ block contains counts only (a test asserts no customer strings appear); HQ pause and
  release actions are audited and need a reason; the alert rules fire on their thresholds; tenant close
  revokes first.

### 11.4 Sandbox checks before go-live (VERIFY list)

Run against the Canadian sandbox (Plus, then Essentials) and record results in this file:

1. PKCE support (2.2), read once by hand from the discovery document.
2. `GlobalTaxCalculation` required; GST/PST MB gives two `TaxLine`s; per-rate rounding; override
   accepted on sales and on purchases; `ReadOnly` rates.
3. Negative sales lines; `Amount` vs `Qty × UnitPrice` validation and how many `Qty` decimals QBO keeps
   (T&M hours such as 2.6667).
4. A project id as `CustomerRef`; sub-customer jobs on Essentials.
5. `sparse: true` on Item, Vendor, Payment, Bill, Purchase, PurchaseOrder, TimeActivity; a sparse Payment
   update without `Line` keeps the lines.
6. Void markers on invoices in CDC; payment void call.
7. TimeActivity `MetaData.LastUpdatedTime` filter; API-created TimeActivity pre-filling Canadian payroll.
8. Batch size limit (10 vs 30).
9. `T5018Eligible` field name; `CustomerMemo` length; PurchaseOrder `DueDate` vs `ExpectedDate`.
10. Which calls Intuit meters as CorePlus (CDC, batch queries).
11. Whether Intuit still sends the legacy webhook format.
12. QBO web link paths for "Open in QuickBooks".
13. Estimate status after an invoice links it.
14. Partner tier prices in CAD.
15. Revoke scope: does revoking one refresh token end other tokens of the same app and realm (2.2)?
16. How long Intuit honours a `requestid` for dedupe; which fields can filter a query for adopt-by-search
    (`MetaData.CreateTime`, `CustomerRef`, `EmployeeRef`, `DocNumber`, `TxnDate`) (5.3).
17. `TaxAgency.LastFileDate` (name, and whether QBO sets it when a return is filed) (2.8).
18. How QBO's Canadian tax engine treats Manitoba PST/RST on purchases (recoverable or not, which
    agency) and whether a GST-only purchase code exists by default (4.8).
19. Whether a Payment's `CustomerRef` may be the parent of the invoice's sub-customer (4.9).
20. `GlobalTaxCalculation` on pulled Expenses entered in the QBO UI (usually `TaxInclusive`?).
21. The trademark attribution wording and the Connect button's licence terms (8).
22. Hosting region of staging (DreamHost, 208.113.210.97) and of the production host (checklist step 9).
23. Applying a credit memo or journal entry to an invoice makes that invoice appear in CDC (its `Balance`
    changed), so the settlement step (4.9) runs; if not, the daily check (5.13) catches it.

### 11.5 End to end

`electrical-app/tests/e2e/quickbooks.e2e.mjs` (W4): fake QBO in HTTP mode; owner connects (ticket,
start, callback), runs the wizard with a mix of matches, applies; office creates and sends an invoice
(badge goes to "In QuickBooks"); a QuickBooks-side change arrives by signed webhook and shows in
Fishtape; a conflicting edit appears on the conflicts screen and is resolved; the wizard's Review step
refuses Apply until a differing field is chosen; shadow mode shows the "would change" list and writes
nothing; an office user without two-step sign-in can read the status but gets `mfa_required` on Sync now;
a foreman signs in and sees no QuickBooks module, no badges, and gets 403 from `/api/v1/qbo/status`. `purchasing.e2e.mjs` (W5):
vendor, bill with a receipt photo, PO from material requests.

---

## 12. Workstreams

Six workstreams, each in its own worktree. **Every new or changed file has exactly one owner**; touch
only your files. Shared registries each have one owner (listed). Need a change in someone else's file?
Put it in your merge report.

### 12.1 Order

```
W1 platform ──┬──────────────────────► W3 engine + API + wiring ──► W4 PWA QuickBooks + PWA registries
W2 mapping ───┤                              ▲
W5 purchasing ┴──────────────────────────────┤
W6 Stripe/HQ/alerts/docs (after W1) ─────────┘
```

Merge order: **W1, W2, W5, W6, W3, W4**. W2, W5 and W6 can start at once (W5's server tests need W1's
`plans.js` change, so W5 merges after W1; W6's HQ and alert code reads W1's tables). W4 can build against
this contract with a mocked API from the start, and merges last. W3 starts coding at once against the
signatures below and rebases on W1, W2, W5 and W6.

### 12.2 W1 Platform: connection, tokens, client, webhook ingest, tables

**Scope.** Everything between Fishtape and Intuit that is not sync logic: migration 0150 with its RLS
and grants; env parsing; the OAuth connect flow with ticket, interstitial, flow cookie and state; the
same-company and revoke rules; takeover; token storage, the refresh lease and the platform token
breaker; disconnect, purge and `qbo_revoke_pending`; housekeeping (refresh, hard-expiry notices,
auto-disconnect, revoke retries, retention deletes); the QBO HTTP client (timeouts, budgets, rate limits,
`QBO_WRITES`, fixed-table errors, usage counting); webhook verification and ingest (two verifiers, dirty
flag, bounded inbox); QBO role and MFA gates; secret-name hardening; log redaction; the nginx webhook
zone; the realm re-hash script; the fake QBO server.

Owns (new):
`server/migrations/0150_qbo.sql`, `server/src/qbo/env.js`, `server/src/qbo/oauth.js`,
`server/src/qbo/connection.js`, `server/src/qbo/client.js`, `server/src/qbo/limiter.js`,
`server/src/qbo/webhook.js`, `server/src/qbo/roles.js`, `server/src/qbo/platform-jobs.js`,
`server/src/qbo/pages.js` (the static interstitial, done and disconnected HTML),
`server/scripts/qbo-rehash.js`,
`server/test/support/fake-qbo.js`, `server/test/qbo-unit.test.js`, `server/test/qbo-connect.test.js`,
`server/test/qbo-client.test.js`, `server/test/qbo-webhook.test.js`, `server/test/qbo-migrations.test.js`,
`server/test/qbo-secrets.test.js`.

Owns (changed): `server/src/config.js` (`qbo: readQboConfig(env)`, `worker.qboConcurrency`),
`server/src/lib/crypto.js` (`sealer.mac`), `server/src/services/secrets.js` (3 names; `internal` names
fail `isSecretName` and need `{ internal: true }`), `server/src/integrations/http.js`
(`LABELS.qbo = 'QuickBooks'`, token-shaped and name-safe `scrub` patterns), `server/src/logger.js`
(`SECRET_QUERY` gains `realmId`, `realm_id`, `ticket`), `electrical-app/js/plans.js` (`quickbooks`,
`purchasing`), `server/.env.example`, `deploy/staging/.env.example`, `deploy/production/.env.example`,
`deploy/set-env.sh` (the new names; `QBO_ENVIRONMENT`, `QBO_CLIENT_ID`, `QBO_WRITES` shown plain),
`deploy/staging/nginx-http.conf` and `deploy/staging/nginx-api.conf.snippet` and
`deploy/production/nginx/fishtape.conf` (a `limit_req_zone` keyed on the path for
`/api/v1/webhooks/`, and that location using it instead of the per-IP `/api/` zone).

Depends on: nothing.

Exports (contract):

```js
// env.js
export function readQboConfig(env): QboConfig
// { enabled, environment, clientId, clientSecret, webhookVerifiers: string[] (current first), writesEnabled,
//   apiBase, oauth: { authorize, token, revoke }, minorVersion: 75, readBudget, tenantReadBudget,
//   trialReadBudget, requestTimeoutMs: 30000, redirectUri(publicOrigin) }

// oauth.js
export const QBO_PKCE: boolean
export function authorizeUrl(cfg, { state, redirectUri, codeChallenge }): string
export async function exchangeCode(cfg, { code, redirectUri, codeVerifier }): TokenSet
export async function refreshTokens(cfg, refreshToken): TokenSet   // throws QboError kind 'auth' (invalid_grant) or 'platform'
export async function revokeToken(cfg, token): void
// TokenSet = { accessToken, refreshToken, expiresIn, refreshExpiresIn, refreshHardExpiresIn|null }

// connection.js
export async function createConnectTicket(db, cfg, { tenantId, userId, returnTo, reconnect }): { url }
export async function startPage(db, cfg, ticket, { sessionUserId }): { html } | { redirect }   // GET: interstitial, ticket not consumed
export async function startFromTicket(db, sealer, cfg, ticket): { redirect, flowCookie }       // POST: consumes the ticket
export async function completeCallback(db, sealer, cfg, { code, state, realmId, error, flowCookie, sessionUserId }): { redirect, tenantId|null, result }
export async function takeover(db, sealer, cfg, { tenantId, userId, actor, request }): { ok }
export async function qboRealmOwner(db, realmHash): string|null
export async function loadConnection(tx): ConnectionRow|null          // no secrets
export async function withAccessToken(db, sealer, cfg, tenantId): { accessToken, realmId }
export async function markReconnectNeeded(db, tenantId, reason): void
export async function setPaused(db, tenantId, paused, reason, { allowCount }): void
export async function disconnect(db, sealer, cfg, tenantId, { actor, request, purge, revoke = true }): { purged }
export async function tenantForRealm(db, sealer, cfg, realmId): string|null
export function realmHash(sealer, cfg, realmId): Buffer

// client.js
export function createQboClient({ db, sealer, config, tenantId, purpose: 'sync'|'lookup'|'check', log }): QboClient
// QboClient: read(entity, id), query(text, { all, max }), cdc(entities, since), create(entity, body, { requestId }),
//   update(entity, body, { requestId, sparse }), remove(entity, { Id, SyncToken }, { requestId }),
//   voidTxn(entity, { Id, SyncToken }, { requestId }), upload({ entity, id }, { fileName, contentType, bytes }, { requestId }),
//   batch(items), companyInfo(), preferences()
// Every call: 30 s timeout, throttled_until check, budget check, usage count, QBO_WRITES check for Core calls.
export class QboError extends Error // { kind: 'auth'|'platform'|'stale'|'duplicate_number'|'duplicate_name'|'not_found'|'validation'
//   |'throttled'|'unavailable'|'budget'|'feature'|'closed_books'|'permission'|'open_balance'|'other',
//   faultCode, status, intuitTid, retryAfterS, retry, detail /* scrubbed Intuit detail, tenant log only */ }
// message comes from a fixed table keyed by kind and faultCode (5.8).

// webhook.js
export function verifyIntuitSignature(raw: Buffer, header: string, verifiers: string[]): boolean
export function parseWebhook(raw: Buffer): QboEvent[]  // { id, realmId, entity, op, qboId, deletedId, time }
export async function ingestWebhook(db, sealer, cfg, events): { accepted, dropped }

// roles.js
export const QBO_ROLES = ['owner', 'admin', 'office']
export const QBO_ADMIN_ROLES = ['owner', 'admin']
export function canUseQbo(principal): boolean
export function requireQboRole(level: 'office'|'admin', { write }?): FastifyPreHandler   // write: needs mfa_verified_at
export const QBO_ACTOR = { type: 'system', id: 'qbo', label: 'QuickBooks sync' }

// platform-jobs.js
export const QBO_PLATFORM_HANDLERS // { qbo_token_housekeeping, qbo_purge }
export async function scheduleQboPlatformJobs(db): void
```

Tests: everything in 11.2 (W1 part) and 11.3 (W1 part).

### 12.3 W2 Mapping and merge library (pure functions) and the tax model change

**Scope.** Pure, database-free code: canonical forms with matching cuts and normalisers; mappers in
both directions for every entity (lossy lines, markup, negative lines, unmodelled line attributes kept by
`Line.Id`, Payment line rebuild with foreign lines, settlement amount, tax-inclusive conversion, RST
spread on purchases, credit receipts); the three-way merge with per-field times, B = null and
`remoteAlias`; tax keys with `NONE` reasons, code-id comparison, reverse mapping, pre-push tax check,
override builder; wizard matching (name-only ambiguous, possible duplicates, payments on balance and net
of fee) and per-field baselines; names, `qboQuote`, markers and request ids. Plus the Fishtape tax model
change: the `gst-only` treatment in `tax.js` and `taxNoneReason` in the two document schemas.

Owns (new): `server/src/qbo/map/canon.js`, `server/src/qbo/map/to-qbo.js`,
`server/src/qbo/map/to-fishtape.js`, `server/src/qbo/map/merge.js`, `server/src/qbo/map/tax.js`,
`server/src/qbo/map/match.js`, `server/src/qbo/map/baseline.js`, `server/src/qbo/map/names.js`,
`server/src/qbo/map/requestid.js`, `server/test/qbo-map-unit.test.js`, `server/test/qbo-merge-unit.test.js`,
`server/test/qbo-match-unit.test.js`, `server/test/fixtures/qbo/**`.

Owns (changed): `.dockerignore` (adds `!electrical-app/js/lib/qbo-export.js`; `money.js` and `tax.js`
are already allowed; no other PWA lib may be imported by QBO server code: `match.js` has its own
normalizers with a parity test), `electrical-app/js/lib/tax.js` (`gst-only` treatment for every PST/RST
province, the `none` hint no longer mentions licences), `electrical-app/tests/tax.test.mjs`,
`electrical-app/js/schema/estimates.json` and `electrical-app/js/schema/invoices.json` (optional
`taxNoneReason`).

Depends on: nothing (reads `qbo-export.js`, `money.js`, `tax.js`).

Exports:

```js
// ctx for every mapper: { collection, mappings, features, company: { province, zone }, refs, link, now }
// refs: { qboIdFor(collection, fishtapeId) -> string|null, fishtapeIdFor(entity, qboId) -> string|null,
//         itemKind(qboItemId) -> 'material'|'labour'|'other'|null, itemType(qboItemId) -> string|null }
export function fishtapeToCanon(collection, record, ctx): Canon
export function qboToCanon(entity, object, ctx): Canon
export function canonToQbo(collection, canon, ctx, { existing }): { entity, body }   // body has no Id/SyncToken; keeps existing unmodelled line attributes, GlobalTaxCalculation, foreign payment lines
export function canonToFishtape(collection, canon, ctx, { existing }): object        // record patch
export const FIELD_RULES       // { [collection]: { money: string[], auto: string[], pushOnly: string[] } }
export const MONEY_RECORD_KEYS // { [collection]: { [moneyField]: string[] /* record keys */ } }
export function threeWayMerge(collection, base, local, remote, { localAt, remoteAt, prevValues, stale, held, remoteAlias }):
  { merged, toLocal: string[], toRemote: string[], conflicts: [{ field, base, fishtape, quickbooks }], autoResolved: [{ field, winner }] }
export function displayValue(collection, field, value): string   // for conflict screens
export function canonHash(value): string                         // for remoteAlias
// to-qbo.js / to-fishtape.js helpers
export function rebuildPaymentLines(currentPayment, ownedLines: [{ invoiceQboId, amountCents }]): { Line, TotalAmt }
export function settlementCents(qboInvoice, linkedPaymentLineCents: number[]): number
export function taxInclusiveToNet(qboTxn, rates): { lines, taxes }   // bills and receipts
export function markerFor(linkId): string                           // 'Fishtape ref <12 hex>'
export function normMethod(method): string
// tax.js
export function lineTaxKey(doc, kind): string                       // adds NONE|<reason>
export function taxesFromCodes(keysByKind, { province, date, existingKeys }): { taxes, taxPct, taxTreatment, taxNoneReason, ok }
export function expectedTax(doc, codeIdsByKind, rates, date): { ok, perRate, mismatch: { codeName, codePcts, docPcts }|null }
export function compareTax(fishtapeTotals, txnTaxDetail, rates): { equal, withinTolerance, perRate: [{ rateId, fishtapeCents, qboCents }] }
export function taxOverride(fishtapeTotals, codeIds, rates): object|null  // TxnTaxDetail
export function spreadPurchaseTax(lines, taxes, recoverableIds): { lines, taxes }   // PST/RST into line cost
export function purchaseCodeClaimsPst(code, rates, agencies): boolean
export function suggestTaxCodes(keys, taxCodes, taxRates): { [key]: codeId|null }
// match.js
export function normEmail(s), phoneKey(s), nameKey(s), skuKey(s), postalKey(s)
export function matchCustomers(clients, customers), matchJobs(jobs, customers, links), matchItems(items, qboItems),
  matchEmployees(employees, qboEmployees), matchVendors(vendors, qboVendors),
  matchDocs(kind, docs, qboDocs, links, { taxFiledThrough }), matchPayments(pairs): Candidate[]
// baseline.js
export function wizardBaseline(collection, L, R, fieldChoices): { snapshot, remoteAlias, needsChoice: string[], differs: boolean }
// names.js
export function qboName(s), nextDisplayName(base, attempt), jobDisplayName(job), addressToQbo(s), addressFromQbo(addr), addressKey(s)
export function qboQuote(s): string   // escapes \ and ', throws on % and _
// requestid.js
export function requestIdFor(parts: string[]): string  // 36 chars
```

Tests: 11.2 (W2 part), with fixtures for TG Electrical-style Manitoba documents, and `tax.test.mjs` for
the new treatment.

### 12.4 W3 Sync engine, jobs, HTTP API and server wiring

**Scope.** The engine and everything that runs it: the records hook with actor classification and the
stale-write field merge with `held` money values; outbox claiming and the create protocol with markers
and adopt-by-search; dependencies and re-queueing; the pull from one CDC cursor with SyncToken echo drop,
TimeActivity and merge confirmation, full reconcile with by-id reads; reconcile and writing results;
conflicts, unlink tombstones and relink; the origin rule and the filed-period, pay-period and tax holds;
settlement payments and the amount-due adjuster; the Fishtape-side sweep and the daily balance check;
the wizard (scan, matches, baselines, apply in chunks, shadow); look-ups; the lease with epoch fencing,
heartbeats, the QuickBooks worker pool and the safety brake; every QBO route; worker and app wiring.

Owns (new): `server/src/qbo/hooks.js`, `server/src/qbo/engine.js`, `server/src/qbo/pull.js`,
`server/src/qbo/push.js`, `server/src/qbo/sweep.js`, `server/src/qbo/check.js`,
`server/src/qbo/reference.js`, `server/src/qbo/wizard.js`, `server/src/qbo/conflicts.js`,
`server/src/qbo/log.js`, `server/src/qbo/lookup.js`, `server/src/qbo/lease.js`, `server/src/qbo/jobs.js`,
`server/src/routes/v1/qbo-connect.js`, `server/src/routes/v1/qbo-webhook.js`, `server/src/routes/v1/qbo.js`,
`server/test/qbo-sync.test.js`, `server/test/qbo-api.test.js`, `server/test/qbo-wizard.test.js`,
`server/test/qbo-integrity.test.js` (the data-integrity matrix of 11.3).

Owns (changed): `server/src/services/records.js` (hooks on write and delete, `restoreRecord` for the
system actor if missing, stale-write field merge with `record_history` and `held`),
`server/src/services/queue.js` (`claim` with `{ kinds, excludeKinds }`, `heartbeat`),
`server/src/app.js` (registers `qbo-connect.js`, `qbo-webhook.js`, `qbo.js`; registers the amount-due
adjuster), `server/src/worker.js` (the general and QuickBooks loops; merges `QBO_HANDLERS`,
`QBO_PLATFORM_HANDLERS` and `QBO_ALERT_HANDLERS`; calls `scheduleQboJobs`, `scheduleQboPlatformJobs`,
`scheduleQboAlerts`; registers the amount-due adjuster), `server/test/isolation.test.js`,
`server/test/leaks.test.js`. Only if Kelvin answers 13.11 with opt-in: `server/src/ai/data.js` and
`server/src/routes/mcp.js` (skip records with a `qbo_links` row unless `option.aiAccess`).

Depends on: W1 (tables, client, connection, roles), W2 (mappers, merge, match, baseline), W5 (the three
collections in `collections.js`), W6 (`amountDueCents`/`registerAmountDueAdjuster`,
`stripe_payouts.balance_txns` written, `QBO_ALERT_HANDLERS`).

Exports:

```js
// hooks.js
export async function qboAfterWrite(tx, coll, id, before, after, who, { stale, held }): void
export async function qboAfterDelete(tx, coll, id, before, who, { stale }): void
export const QBO_COLLECTIONS, QBO_RANK
export function actorTypeOf(who): 'user'|'field_user'|'api_key'|'agent'|'stripe'|'system'
// engine.js
export async function syncTenant(deps, tenantId, { budgetMs }): { pushed, pulled, conflicts, errors, shadow }
export async function reconcileLink(deps, tenantId, linkId, { remote, force }): LinkState
export async function pushRecord(deps, tenantId, collection, id, { force, asNew }): LinkState
export function amountDueAdjustment(tx, invoiceId): Promise<number>   // registered with W6
// deps = { db, sealer, config, records, now, log }
// lease.js
export async function acquireLease(db, tenantId, workerId, { waitMs }): { epoch }|null
export async function renewLease(db, tenantId, epoch): boolean
export async function assertEpoch(tx, tenantId, epoch): void   // SELECT … FOR SHARE, throws when fenced
export async function releaseLease(db, tenantId, epoch): void
// sweep.js / check.js
export async function sweep(deps, tenantId): { queued }
export async function runCheck(deps, tenantId): { mismatches }
// wizard.js
export async function scan(deps, tenantId): void
export async function apply(deps, tenantId): void
// conflicts.js
export async function resolveConflict(deps, tenantId, conflictId, { choice, fields, recordId }, who): Conflict
// lookup.js
export async function lookup(deps, tenantId, entity, params): object
// jobs.js
export const QBO_HANDLERS // { qbo_sync, qbo_dispatch, qbo_cdc, qbo_check, qbo_setup_scan, qbo_setup_apply, qbo_reference_refresh }
export async function scheduleQboJobs(db): void
```

Route plugins call W1's services for connect, start, callback, takeover, webhook and status. Tests: 11.3
(W3 part) and 10.2 (isolation, roles, leaks, origin).

### 12.5 W4 PWA: QuickBooks screens and PWA registries

**Scope.** Everything the office sees: the QuickBooks module (overview with every state, shadow and
write-switch banners, brake confirmation, takeover offer, "Doesn't match" list), the wizard (settings
questions, matching tabs, Review step with per-field choices, possible duplicates and filed-period
ticks), the mappings screen (tax situations including no-tax reasons, purchase tax rule, filed period,
payroll lock), the conflicts and activity screens, look-up (POST searches), per-record badges and their
sheet (tombstone actions, approve-and-send), `mfa_required` handling, trademark attribution and the
Intuit button asset, the no-tax reason picker on invoices and estimates, settlement payments shown
read-only, the guide, and the PWA registries.

Owns (new): `electrical-app/js/modules/quickbooks.js`, `electrical-app/js/lib/qbo-ui.js`,
`electrical-app/js/lib/qbo-api.js` (fetch wrappers over `session.js apiFetch`), `electrical-app/css/quickbooks.css`,
`electrical-app/guides/quickbooks.md`, `electrical-app/img/intuit/**` (Intuit's official buttons and a
`README.md` with their licence terms), `electrical-app/tests/qbo-ui.test.mjs`,
`electrical-app/tests/e2e/quickbooks.e2e.mjs`.

Owns (changed): `electrical-app/js/modules/index.js` (imports and lists `quickbooks` and `purchasing`),
`electrical-app/js/app.js` (`MODULE_COLLECTIONS.purchasing = ['vendors', 'bills', 'purchaseOrders']`),
`electrical-app/js/modules/billing.js` (`FEATURE_LABELS.quickbooks = 'QuickBooks Online sync'`,
`FEATURE_LABELS.purchasing = 'Supplier bills and purchase orders'`), `electrical-app/js/lib/notify.js`
(kind `quickbooks`), `electrical-app/js/modules/integrations.js` (QuickBooks card),
`electrical-app/js/modules/settings.js` (link in "Accounting and imports"),
`electrical-app/js/modules/invoices.js` (badge mount points, the "Why no tax?" picker, settlement
payments read-only), `electrical-app/js/modules/estimates.js` (badge mount points, the picker),
`electrical-app/js/modules/clients.js`, `electrical-app/js/modules/time.js` (badge mount points only),
`electrical-app/sw.js` (only if it lists module files), `site/pricing.html` (only if the pricing test
needs the new labels), `site/features/integrations.html` and `electrical-app/tests/site-pages.test.mjs`
(the "coming" note becomes the live feature, at release).

Depends on: W3's API (section 7; mock it until W3 merges), W2's `taxNoneReason` schema field and
`gst-only` treatment, W5's module file for the registry line.

Tests: `qbo-ui.test.mjs` (badge helper logic, status-to-text, role and plan gating, `mfa_required`
messages, no QBO data persisted), e2e 11.5.

### 12.6 W5 Purchasing: vendors, bills, receipts, purchase orders

**Scope.** The new Fishtape purchasing feature, usable with or without QuickBooks: three collections
with schemas and the generated migration, the purchasing module (bills, receipts with photos or PDFs,
negative receipts for refunds, vendors, purchase orders), purchase orders from material requests, bill
total checks (mismatch shown), plan and module gating.

Owns (new): `electrical-app/js/schema/vendors.json`, `electrical-app/js/schema/bills.json`,
`electrical-app/js/schema/purchaseOrders.json`, `server/migrations/0151_purchasing.sql` (generated),
`electrical-app/js/modules/purchasing.js`, `electrical-app/js/lib/purchasing.js` (pure: bill totals and
the 2-cent check, PO from material requests, number helpers), `electrical-app/css/purchasing.css`,
`electrical-app/tests/purchasing.test.mjs`, `electrical-app/tests/e2e/purchasing.e2e.mjs`,
`server/test/purchasing.test.js`.

Owns (changed): `server/src/collections.js` (COLLECTIONS + DEFS), `electrical-app/js/store.js`
(COLLECTIONS, `DEFAULT_SETTINGS.nextNumbers.po = 5001`), `electrical-app/js/schema/index.json`,
`server/scripts/gen-collections-sql.js` (`LATER['0151']`), `server/src/services/entitlements.js`
(`COLLECTION_FEATURES`), `electrical-app/js/lib/modules.js` (switch and `COLLECTION_SWITCHES`),
`electrical-app/js/modules/materials.js` ("Create purchase order"), `electrical-app/tests/modules.test.mjs`
(only if switch counts change).

Depends on: W1 (`plans.js` `purchasing`).

Note: the module is registered in `modules/index.js` by W4. Test the screen locally with an uncommitted
registry line; do not commit it. `purchasing.e2e.mjs` runs once W4 has merged.

### 12.7 W6 Stripe fees and payouts, amount due, HQ, alerts, docs and compliance

**Scope.** The Stripe side of the books (fee fetch per payment, payout webhooks including `failed` after
`paid` and `canceled`, payout balance-transaction itemisation, live-mode and currency fields), the
`amountDueCents` seam used by the invoice status and the pay link, the `credit` payment method; HQ's
QuickBooks card, developer page, settings, pause and release actions, close-path housekeeping trigger;
the alert rules and their job; and every document, runbook and policy change (threat model, compliance,
secrets, rotation, offboarding, incident response, the QuickBooks support runbook with "Moving a
server", API docs, BACKLOG, BUILD-PLAN, README).

Owns (new): `server/src/qbo/alerts.js`, `server/test/stripe-fees.test.js`, `server/test/hq-qbo.test.js`,
`server/test/qbo-alerts.test.js`, `docs/runbooks/quickbooks-support.md`.

Owns (changed): `server/src/integrations/stripe.js` (`fetchStripeFee`, `fetchPayout`,
`fetchPayoutTransactions`), `server/src/integrations/payments.js` (fee fields after a Stripe payment,
`recordStripePayout`, `amountDueCents`, `registerAmountDueAdjuster`, `refreshInvoiceStatus` and the
pay-link amount use `amountDueCents`), `server/src/integrations/jobs.js` (`stripe_fee_fetch` and
`stripe_payout_fetch` handlers), `server/src/routes/v1/webhooks.js` (Stripe `payout.paid`,
`payout.failed`, `payout.canceled`, `payout.updated`), `electrical-app/js/schema/payments.json` (typed
`stripe` fee fields; `method` description gains `credit`), `electrical-app/guides/stripe.md` (the
restricted key also needs read access to PaymentIntents, Charges, Balance transactions and Payouts; the
webhook needs the payout events), `server/src/services/hq-tenants.js` (QuickBooks block),
`server/src/routes/hq-tenants.js` (pause and release actions; the close action enqueues
`qbo_token_housekeeping`), `server/src/routes/hq-developer.js`, `server/src/services/hq-settings.js`,
`hq/js/pages/tenant.js`, `hq/js/pages/developer.js`, `docs/security/threat-model.md`,
`docs/security/secrets-management.md`, `docs/compliance/vendor-management.md`,
`docs/compliance/privacy.md`, `docs/compliance/backup-retention.md`,
`docs/compliance/logging-monitoring.md`, `docs/runbooks/rotate-secrets.md`,
`docs/runbooks/offboard-tenant.md`, `docs/runbooks/incident-response.md`, `docs/architecture/api.md`,
`docs/BACKLOG.md` (incl. the portal rule of 1.2), `docs/BUILD-PLAN.md` (a short "QuickBooks
(migrations 0150-0159)" section pointing here), `docs/README.md` (any further links; this file's line is
already there).

Depends on: W1 (tables and grants for HQ and alerts; `disconnect` used by housekeeping).

Exports:

```js
// integrations/stripe.js
export async function fetchStripeFee(secretKey, paymentIntentId): { chargeId, balanceTransactionId, feeCents, netCents, currency, created }
export async function fetchPayout(secretKey, payoutId): { amountCents, currency, arrivalDate, status, automatic, livemode, feeCents }
export async function fetchPayoutTransactions(secretKey, payoutId): [{ id, type, amountCents, feeCents, paymentIntentId|null, created }]
// integrations/payments.js
export async function recordStripePayout(tx, payout): { inserted: boolean }  // upserts stripe_payouts (paid_seen, earliest_charge_at, balance_txns) and queues it for QBO
export function registerAmountDueAdjuster(fn: (tx, invoiceId) => Promise<number>): void
export async function amountDueCents(tx, invoice): number   // docTotals total − payments + adjustment
// qbo/alerts.js
export const QBO_ALERT_HANDLERS // { qbo_alerts }
export async function scheduleQboAlerts(db): void   // every 10 minutes
```

`recordStripePayout` queues the payout for QBO by inserting a `qbo_outbox` row (`collection
'stripePayouts'`, `record_id` = payout id, rank 70, `actor_type` `stripe`) and enqueuing `qbo_sync`, using
the same SQL as the W3 hook (it must not import W3 code; the table contract is enough). Tests: fee fetch
and payout itemisation with a fake Stripe, payout webhooks, `amountDueCents`, HQ block has counts only,
HQ actions audited, alert thresholds.

### 12.8 Shared registries and their single owner

| Registry | Owner |
| --- | --- |
| `electrical-app/js/plans.js` | W1 |
| `server/src/services/secrets.js` (`SECRETS`, `isSecretName`) | W1 |
| `server/src/integrations/providers.js`, `server/src/routes/v1/admin.js` | nobody (unchanged; `isSecretName` does the work) |
| `server/src/integrations/http.js` (`LABELS`, `scrub`), `server/src/logger.js` | W1 |
| `server/src/config.js`, `.env.example` files, `deploy/set-env.sh`, nginx kits | W1 |
| `.dockerignore`, `electrical-app/js/lib/tax.js`, `schema/estimates.json`, `schema/invoices.json` | W2 |
| `server/src/app.js`, `server/src/worker.js`, `server/src/services/queue.js` | W3 |
| `server/src/services/records.js` | W3 |
| `server/src/ai/data.js`, `server/src/routes/mcp.js` | W3, only if 13.11 is opt-in; else unchanged |
| `server/src/collections.js`, `electrical-app/js/store.js`, `schema/index.json`, `gen-collections-sql.js` (`LATER`) | W5 |
| `server/src/services/entitlements.js` (`COLLECTION_FEATURES`), `electrical-app/js/lib/modules.js` | W5 |
| `electrical-app/js/modules/index.js`, `electrical-app/js/app.js`, `modules/billing.js` (`FEATURE_LABELS`), `lib/notify.js` | W4 |
| `server/src/integrations/payments.js`, `schema/payments.json` | W6 |
| migrations: 0150 | W1; 0151 W5; 0152-0159 reserved (ask in the merge report) |
| `docs/README.md`, `docs/BUILD-PLAN.md`, `docs/BACKLOG.md`, `docs/architecture/api.md`, `docs/security/**`, `docs/compliance/**`, `docs/runbooks/**` | W6 |
| `server/test/isolation.test.js`, `server/test/leaks.test.js` | W3 |

Everyone follows the BUILD-PLAN definition of done: tests next to the existing ones, `node --test
electrical-app/tests/*.test.mjs`, `cd server && npm run test:embedded`, `node .github/scripts/check-csp.mjs`
all pass; commit on the worktree branch, no push, no deploy.

---

## 13. Open questions for Kelvin

Each has the default the code uses until he answers.

1. **Who may connect, and who may change QuickBooks data?** Default: owners and admins connect and
   disconnect; office users do everything else (setup, mappings, conflicts, look-up, sync now), but every
   change needs two-step sign-in, also for office users (7.1). The alternative is office read-only, with
   changes at admin level.
2. **TG's real books before the production server exists.** Default: staging uses the Intuit sandbox
   only. TG connects its real QuickBooks only on a server whose hosting region matches what Fishtape
   tells Intuit (checklist step 9; staging is probably in the US). If Kelvin wants TG live on staging
   anyway, the questionnaire must say where staging is, the production webhook points at staging, and
   the later move follows "Moving a server" (10.5): writes off on staging first, same master key (or
   re-wrap and re-hash), never two servers live for one company. The Intuit read allowance is shared by
   both servers.
3. **Sync start date for TG.** Default: the first day of the month of connecting, plus every open invoice
   and pending estimate whatever its date. Older paid history stays only in QuickBooks.
4. **Numbering.** Default: Fishtape numbers documents (INV-3001, E-2001) and QuickBooks "Custom
   transaction numbers" must be on; documents created in QuickBooks should use another numbering (plain
   numbers). Should Fishtape instead continue QuickBooks' current numbers? (The wizard can raise
   Fishtape's next numbers above QuickBooks' highest.)
5. **Jobs in QuickBooks.** Default: each Fishtape job used in QuickBooks becomes a sub-customer under the
   client ("J-1042 Panel upgrade 12 Elm"). If TG already uses QuickBooks Projects, the wizard links jobs
   to them instead. The choice is locked once invoices are sent. Is that how TG wants to see job profit?
6. **Stripe in the books.** Default: a "Stripe" clearing bank account in QuickBooks; each card payment
   recorded gross, each Stripe fee as an expense, each payout as a transfer to the bank; Fishtape books
   Stripe from the sync start date on (earlier payouts stay with the bookkeeper); refunds and disputes are
   flagged for the bookkeeper to enter. Fee tax code: none, until the accountant says Stripe's fees carry
   claimable GST.
7. **Payroll.** Default: approved time goes to QuickBooks as timesheets (not billable, hours only) unless
   the wizard is told QuickBooks Time holds the hours. Does TG run payroll in QuickBooks Payroll (then we
   test that the hours pre-fill cheques), in Wagepoint (then QuickBooks time is for job costing only), or
   with QuickBooks Time (then Fishtape sends no hours)? Edits to hours already paid are held for review.
8. **TG's QuickBooks plan.** Default: if it is Essentials, purchase orders stay in Fishtape only
   (QuickBooks Plus is needed for them); everything else works.
9. **Partner tier.** Default: stay on Intuit's free Builder tier; HQ warns at 70% of the monthly read
   allowance, and Kelvin decides then whether to pay for Silver (about CA$425 a month, VERIFY).
10. **A practice week for TG.** Default: yes. TG's first week runs in shadow mode (nothing written;
    Kelvin and the bookkeeper read the "would change" list), then goes live.
11. **The assistant and QuickBooks data.** Default: records that sync with QuickBooks stay readable by
    Fishtape's assistant like any record, and this is disclosed to Intuit, in the terms and privacy
    policy, and on the connect screen. The alternative is opt-in per company (the assistant, MCP and API
    keys skip synced records unless the company turns it on). If Intuit's review asks for opt-in, the
    alternative becomes the rule.
12. **Free trials.** Trials currently run on the Business plan, so they would get QuickBooks. Default:
    trials may connect, with a read allowance of 5,000 a month (`QBO_TRIAL_READ_BUDGET`); a trial that
    lapses is disconnected after 60 days. The alternative is QuickBooks only after the first payment.
13. **Foreman approval and payroll.** Foremen can approve time today. Default: a foreman's approval sends
    the hours to QuickBooks like an office approval. The alternative holds foreman-approved hours until an
    office user confirms.
14. **Which QuickBooks customers come into Fishtape.** Default: only customers with a transaction since
    the sync start date or an open balance; the rest stay in QuickBooks (look-up can import one any time).
    The alternative imports every active customer. Field crews can see client contact details in
    Fishtape, which is the reason for the default.
15. **"No tax" reasons and "GST only".** Default: yes. Every company (connected or not) gets the
    "PST/RST exempt, GST charged" choice for customers who quote a PST/RST number, and a "Why no tax?"
    picker (zero-rated, exempt, out of scope, Indian Act relief) on no-tax estimates and invoices. Today's
    "No tax" also covers PST/RST-licence customers, who still owe GST.
16. **RST on supplier bills.** Default: not recoverable; Fishtape adds it to the cost of each line and
    claims only GST (4.8). TG's accountant confirms.

---

## 14. Considered and rejected

Review findings that were not taken, or were taken in another form, with the reason:

| Finding | Decision and reason |
| --- | --- |
| Accounting M15: allocate invoice numbers on the server when an invoice leaves draft | Not taken. Fishtape numbers documents offline by design. Instead the engine refuses to push a Fishtape-side duplicate number (`blocked/duplicate_number_local`) and Renumber allocates on the server (4.7). |
| Accounting M4: convert legacy `TAX` documents to components once at setup | Not taken. Comparing tax by QBO code id and keeping the document's own key on pull stops the key flipping without editing customer documents in bulk (4.8). |
| Accounting H11: per-entity CDC cursors | Taken in the other form the finding offered: every CDC call asks for every entity from the one cursor (same CorePlus cost, simpler) (5.4). |
| Accounting C5: alternatively, a Transfer equal to the booked charges with the rest on a report | Not taken. A Transfer that differs from the payout would not match the bank feed. Payouts are itemised from Stripe's balance transactions, and anything Fishtape cannot book goes to review (4.9). |
| Accounting H6: void the just-created invoice when its tax differs by more than 2 cents | Changed to **delete**. A void keeps the DocNumber, so the corrected push would hit 6140. The invoice is seconds old, has no payments, and QBO's audit log still records it (4.8). |
| Accounting H4: keep the QBO balance and show "Settled in QuickBooks", switching off the pay link and reminders | Taken in the "better still" form: a pull-only settlement payment (method `credit`). Pay link, reminders and status follow from the balance with no new rules in other modules (4.9). |
| Accounting C4: record the held device value in `record_history` | Changed. History rows are versions of the record, and a value that was never applied would misrepresent it. The value is held in the outbox (`held`) and shown in the conflict (5.2). |
| Accounting M12: API actions enqueue onto the worker | Changed to: API actions take the same lease (wait up to 10 s, else 409 `qbo_busy`), which keeps synchronous answers for resolve and import (5.8). |
| Security 1: purge every `qbo_*` row automatically in `completeCallback` when the realm differs | Not taken. The server refuses with `purge_required`, so deleting a company's links is always a person's explicit choice (2.2). |
| Security 21: add the `openid email` scope and compare the Intuit user's email | Not taken. The person who approves in QuickBooks is often the bookkeeper, with a different email, so the check would block legitimate connects. It would also add a scope and personal data. The interstitial naming the Fishtape company and the requester covers the attack (2.2). |
| Security 25: delete `qbo_oauth_states` of removed users | Not needed. Rows live at most 10 minutes, expired rows are deleted hourly, and rows cascade when a user is deleted (10.4). Candidates now go 30 days after the scan, as the finding asked. |
| Security 24: a `SECURITY DEFINER` function for realm look-up | Changed. Permissive `SELECT` policies (hashes, tenant ids and counts only) with tenant-only `INSERT`/`DELETE`/`UPDATE` give the same protection with less code; HQ uses column grants, as elsewhere (3.2). |
| Security 13: a portal-hidden flag on pulled documents | Deferred. No portal route serves records yet. The rule is recorded for when the portal is built (1.2, BACKLOG). The other part, not pulling QBO `Notes`, is taken (4.2). |
| Security 20: exclude synced records from AI | The default is disclosure (10.1); exclusion is the alternative in open question 13.11, with its owner named (W3). |
| Security 11: office users read-only | The default is two-step sign-in for every QBO change instead (7.1); read-only office is the alternative in open question 13.1. |
