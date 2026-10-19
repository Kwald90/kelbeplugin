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
| Backups and restore tests | One JSON line per run | `backup-log.jsonl`, `restore-tests.jsonl` | 3 years |
| Host status | Disk, certificate expiry, load, memory, reboot and security-update flags, every 15 minutes | `status/host-status.json` (overwritten) | Latest only |
| SSH and system | Logins, sudo, fail2ban bans, ufw blocks | System journal and `/var/log/auth.log` | 30 days |
| GitHub | Account security log, workflow runs and approvals, security alerts | GitHub | GitHub's own limits; exported into evidence bundles |

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
