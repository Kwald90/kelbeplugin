# Logging and monitoring policy

What Fishtape logs, what it must never log, how long logs are kept, and who looks at what, when.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Hosts, nginx, containers, the API and worker, Postgres, deploy and backup scripts, GitHub |
| Review cadence | Annually |
| Last reviewed | 2026-10-19 |
| Related controls | OPS-01 to OPS-05, BCK-03, SDL-02 |

## Purpose

Notice problems before tenants do, have the records needed to investigate an incident, and keep
secrets and unnecessary personal information out of logs.

## Scope

Staging and production. Local development logs are not kept.

## What is logged

| source | what | where | kept |
| --- | --- | --- | --- |
| nginx | Access (time, client IP, request line, status, bytes, user agent) and errors | Production: `/var/log/nginx/`. Staging: CloudPanel's site logs | 30 days |
| API and worker | Requests (method, route, status, duration, request id, tenant id, user id), errors, job results | Container stdout, Docker `json-file` driver | 30 days by rotation |
| Postgres | Queries slower than 500 ms, lock waits, large temp files, connections and disconnections (production settings) | Container stdout | 30 days by rotation |
| `audit_events` | Every write (sync, REST, HQ, agents): actor (user, API key, agent, system, HQ staff), action, collection, record id, summary, IP, user agent, request id; hash-chained per tenant | Postgres | Life of the tenant plus 1 year |
| Auth events | Sign-in success and failure, MFA challenges, lockouts, password resets, session and device revocations, API key creation and revocation | `audit_events` and API logs | As above |
| HQ access | Every HQ read of tenant data | `audit_events` | As above |
| Deploys | One JSON line per `update.sh` run; deploy-gate requests in the system journal (`fishtape-deploy-gate`) | `/var/lib/fishtape-<env>/deploy-log.jsonl` | 3 years (with evidence bundles) |
| Backups and restore tests | One JSON line per run (offsite drills: recorded through HQ health) | `backup-log.jsonl`, `restore-tests.jsonl`, `drills/restore-tests.jsonl` | 3 years |
| Host status | Disk, certificate expiry, load, memory, reboot and security-update flags, every 15 minutes | `status/host-status.json` (overwritten) | Latest only |
| SSH and system | Logins, sudo, fail2ban bans, ufw blocks | System journal and `/var/log/auth.log` | 30 days |
| GitHub | Account security log, workflow runs and approvals, security alerts | GitHub | GitHub's own limits; exported into evidence bundles |
| QuickBooks sync log (`qbo_sync_log`, per company) | Each push and pull: direction, outcome, action, collection, record id, a short label, Intuit's scrubbed detail, error code, Intuit transaction id (`intuit_tid`) | Postgres, the company's own rows (office users read it; HQ reads counts, codes and `intuit_tid` only) | 90 days |
| QuickBooks platform events (`qbo_platform_events`) | Kinds, times, environment and tenant id only (credential failures, `invalid_grant`, reconnects, bad webhook signatures, Intuit 5xx, safety brakes, realm mismatches, revokes given up, budget thresholds) | Postgres | 30 days |
| QuickBooks call counts (`qbo_api_usage`) | Reads (CorePlus) and writes (Core) per company per month, throttles, errors | Postgres | 13 months |

Fishtape's own nginx logs (the API log on staging; every host on production) go to
`/var/log/fishtape-<env>/`, in a format without query strings, and logrotate keeps them 30 days
(`deploy/*/logrotate-nginx`). Container log rotation is by size (5 x 10 MB per container on
staging, 10 x 20 MB on production). Check at the quarterly review that this covers about 30 days
at real traffic and change the sizes if it doesn't. CloudPanel's own access log for the staging
site is outside these settings.

## What must never be logged

- Passwords, PINs, TOTP codes, recovery codes.
- Session tokens, device tokens, API keys, OAuth codes and tokens, `Authorization` and `Cookie` headers.
- `.env` values, `SECRETS_MASTER_KEY`, database passwords, private keys.
- Tenant integration keys (Stripe, Twilio, Resend, Meta, Anthropic) or webhook signing secrets.
- Full payment card data (Fishtape never receives it).
- AI prompt or tool contents that include secrets. Prompts with tenant data are not logged in full;
  log the request id, model, token counts and outcome instead.
- Full request or response bodies with personal information. Log ids, not contents.
- QuickBooks: tokens, the realm id (company id), connect tickets, OAuth `code` and `state`, the
  webhook verifier, Intuit request URLs (they carry the realm id), query text and request or
  response bodies. The QuickBooks client logs method, entity name, status, fault code and
  `intuit_tid` only. Errors that leave the company (`jobs_queue.last_error`, worker stdout, HQ)
  carry fixed-table messages ("QuickBooks rejected a duplicate name"), never Intuit's detail, a
  name or an id; Intuit's detail goes only to that company's own sync log, after a name-safe scrub.
  The OAuth callback and start routes log at `warn` (no request lines), and the logger redacts
  `realmId`, `realm_id` and `ticket` query parameters as well.

The API's logger must redact the headers and field names above, and a test should prove it. If a
secret does end up in a log, treat it as exposed: rotate it, then remove the log lines.

## Monitoring and alerts

| check | how | alerts | status |
| --- | --- | --- | --- |
| Uptime | External monitor on `https://app.fishtapehq.com/api/readyz` and `https://status.fishtapehq.com/api/v1/status` | Kelvin's phone | Planned |
| Backup heartbeat | `backup.sh` pings `HEARTBEAT_URL` (or `/fail`); the monitor alerts if no ping arrives in about 25 hours | Kelvin's phone | Planned |
| HQ developer health | `/api/hq/health`: DB latency, pool, migrations, queue depth and failures, last backup, error counts, memory, uptime, git SHA, certificate expiry, disk | Shown in HQ | Planned (with the API) |
| Readiness | `/api/readyz` returns 503 when the DB, migrations or queue aren't ready; `update.sh` won't finish a deploy without it | Deploy fails and rolls back | Implemented in `update.sh` |
| Certificate expiry | `host-status.json` `daysLeft`; certbot renews at 30 days | Investigate below 20 days | Partial |
| Disk | `host-status.json`; `check-host.sh` warns at 70% and fails at 85% | Investigate at 70% | Partial |
| Pending security updates, reboot required | `host-status.json`, `check-host.sh` | Weekly glance | Partial |
| Code and dependency alerts | Dependabot, CodeQL, secret scanning, `security.yml` weekly run | GitHub email notifications | Partial (Dependabot security updates off) |
| Backups, offsite copy and restore drills | The `hq_backup_alerts` job hourly (general worker pool, `server/src/services/backup-alerts.js`) reads `last-backup.json` and `RESTORE_TESTS_FILE`: backup stale or failed, offsite failed, stale (over 26 hours) or not configured in production, restore drill overdue (over 92 days), no offsite drill yet. HQ > Developer health shows the same lines. First steps in `docs/runbooks/offsite-backups.md` | Email to `HQ_NOTIFY_EMAIL`, at most one per problem a day | Built in Release 1 |
| QuickBooks | The `hq_qbo_alerts` job every 10 minutes (general worker pool) (`server/src/qbo/alerts.js`), rules below; HQ > Developer > QuickBooks for the month's reads against the budget; HQ > the company > QuickBooks for one company's health | Email to `HQ_NOTIFY_EMAIL`, at most one per alert an hour (budget thresholds once a month) | Built with the QuickBooks sync |

### QuickBooks alerts

Sources: `qbo_platform_events`, `jobs_queue` (failed `qbo_*` jobs), `qbo_api_usage`, and a
per-company read of `qbo_connections` for the backlog. The emails name the companies (HQ sees
those anyway), never their customers or records. First steps are in each email and in
[quickbooks-support.md](../runbooks/quickbooks-support.md).

| alert | fires when | first steps |
| --- | --- | --- |
| `qbo_platform_credentials` | Intuit refused Fishtape's own client id or secret (the token breaker opened) | Check `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET` and `QBO_ENVIRONMENT` against the Intuit portal; fix and restart api and worker. No company was marked "reconnect". |
| `qbo_mass_revoke` | 5 or more `invalid_grant` within 15 minutes | Don't ask companies to reconnect yet; check Intuit's status and the app keys; `QBO_WRITES=off` if writes look wrong. |
| `qbo_reconnect_spike` | 3 or more companies entered "reconnect needed" in an hour | Look for a common cause (Intuit outage, an app setting, a key rotation). |
| `qbo_webhook_signature` | Any failed webhook signature in the last hour | Mid-rotation: set `QBO_WEBHOOK_VERIFIER_PREVIOUS`. Otherwise check nginx logs for a probe. |
| `qbo_jobs_failing` | 5 or more `qbo_*` jobs failed for good in an hour | HQ > Health > Queue; worker running? Intuit up? Pause the companies concerned. |
| `qbo_inbox_backlog` | An active company has had changes waiting more than 2 hours | Check the worker's QuickBooks pool and `qbo_dispatch`; look at the company's throttle and budget in HQ. |
| `qbo_intuit_5xx` | More than 20 Intuit 5xx answers in 10 minutes | Intuit's status page; syncs retry with backoff. |
| `qbo_budget` | The workspace at 70% and 90% of `QBO_READ_BUDGET`; a company at 50% and at 80% of its own budget | Decide on Intuit's Silver tier before 90% (look-ups and the 6-hourly catch-up stop for everyone there); look for a loop or heavy look-ups at a company. |
| `qbo_safety_brake` | Any company's sync stopped itself (500+ writes in an hour) | Read the company's counts, ask what changed, keep it paused from HQ if it looks like a bug. |
| `qbo_realm_mismatch` | The sync refused rows written for another QuickBooks company | Treat as a bug: pause the company from HQ. |
| `qbo_revoke_gave_up` | A refresh token still failed to revoke after 14 days | Ask the company to disconnect Fishtape in QuickBooks (Apps > My apps). |

## Review cadence

- Weekly: glance at HQ health. Until HQ ships, read `last-backup.json` and `host-status.json` on each host.
- Monthly (with evidence collection): auth failures and lockouts (look for spikes and repeated
  targets), every HQ access audit event (each should match a support request or incident), deploy and
  backup logs, GitHub security alerts.
- Quarterly (with the access review): SSH logins and sudo use on both hosts, fail2ban activity,
  log rotation coverage, and an export of the GitHub account security log.

Anything unexplained becomes an incident ([incident-response.md](incident-response.md)).

## Time sync

Hosts keep time with NTP (`timedatectl` shows `System clock synchronized: yes`; `check-host.sh`
checks it). Containers use the host clock. Scripts and evidence use UTC in ISO 8601.

## Audit log integrity

The API role can only insert into `audit_events`, never update or delete. Each event carries the hash
of the previous one for that tenant, so a removed or edited row breaks the chain. Verifying the chain
on a schedule and showing the result in HQ is planned.

## Evidence

- `deploy-log-<env>.jsonl`, `backup-log-<env>.jsonl`, `restore-tests-<env>.jsonl`, `security-alerts.json`.
- Monthly review notes in the evidence bundle.
- Monitor configuration screenshots at the quarterly review.

## Exceptions

Through [information-security.md](information-security.md#exceptions).

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
| 2026-10-20 | Kelvin Waldner | QuickBooks added | Sync log, platform events, call counts, what QuickBooks code never logs, the HQ alerts. |
| 2026-10-20 | Kelvin Waldner | Backup alerts | The hourly HQ backup alerts and the offsite drill record (Release 1, section 5). |
