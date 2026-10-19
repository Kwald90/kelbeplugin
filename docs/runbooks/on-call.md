# Solo on-call

Kelvin is the only on-call. The aim is not to watch dashboards: alerts reach the phone, a few
minutes a day catch slow problems, and a backup person can act if Kelvin can't.

## Alerts (set up once; each must reach the phone)

| what | how | means |
| --- | --- | --- |
| Production down | external uptime check on `https://app.fishtapehq.com/api/readyz` and `https://status.fishtapehq.com/api/v1/status` every minute (UptimeRobot, Better Stack or similar) | SEV1/SEV2 |
| Backup missed or degraded | `HEARTBEAT_URL` in `backup.conf` (healthchecks.io-style); alerts when the nightly ping is late or ends in `/fail` | SEV3 (SEV2 if two nights in a row) |
| Certificate expiring | the uptime service's certificate check, 14 days ahead; `host-status.json` shows `daysLeft` too | SEV3 |
| Security alerts | GitHub notifications for Dependabot, code scanning and secret scanning; reports through SECURITY.md | per [vulnerability-management.md](../security/vulnerability-management.md) |
| Deploy failed | GitHub Actions failure emails for `Deploy staging` / `Deploy production` | as the impact says |
| Staging down | a cheaper 5-minute check on `https://tgelectrical.truecollarbuilt.com/` | SEV3 |

Quiet hours: SEV1 pages any time. Everything else waits for morning (SEV2 within 4 hours overnight).

## When an alert fires

1. Acknowledge it (so it doesn't page again), open [incident-response.md](incident-response.md).
2. Look before you touch: `curl -s https://status.fishtapehq.com/api/v1/status`, HQ developer
   health, then on the host `sudo docker compose ps`, `sudo docker compose logs --tail=200 api`,
   `df -h`, `tail -n 3 /var/lib/fishtape-production/deploy-log.jsonl` (was there a deploy?).
3. Most likely fixes, in order: roll back a fresh deploy ([rollback.md](rollback.md)); restart a
   crashed container (`sudo docker compose up -d api hq-api worker`); free disk (old images:
   `docker image ls fishtape.invalid/server`; logs rotate on their own); renew the certificate
   (`sudo certbot renew`).

## Daily (2 minutes)

- Uptime and heartbeat dashboards green.
- HQ developer health: errors, queue lag, last backup ok, certificate days left, disk.

## Weekly (15 minutes, Monday)

- GitHub Security tab and Dependabot PRs: triage by the SLAs.
- `tail` the deploy and backup logs on both hosts; any `degraded`, `failed` or `rolled_back`?
- `last-exposure-check.txt` from the latest deploy ends in `0 fail`.
- Pending security updates and reboot flag in `host-status.json`; reboot in a quiet hour if needed.

## Monthly

- Evidence bundle: `node compliance/evidence/collect.mjs --ssh staging=... --ssh production=...`,
  add the by-hand items listed in its `SUMMARY.md`, zip, store encrypted.
- Review auth failures, lockouts and HQ access audit events.

## Away, sick or travelling

- Before leaving: no production deploys in the last 2 days, alerts tested, phone has the
  password manager and an SSH key (passphrase-protected).
- Longer than 3 days with no laptop: tell the backup person, freeze production deploys (turn off
  `PRODUCTION_DEPLOY_ENABLED`), and post expected response times to tenants if needed.
- The backup person has sealed instructions (business continuity policy): how to reach the
  hosting provider, post a status notice, and call in outside help. They don't hold production
  secrets day to day; the password manager's emergency access gives them what they need if Kelvin
  can't be reached for 24 hours during a SEV1.

## Record

Each page: a line in the incident log (time, alert, what you did, severity). Alerts that fired
for nothing get their thresholds fixed the same week.
