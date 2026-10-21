# Backup and data retention policy

What is backed up, how it is protected, how long backups and other data are kept, and how restores
are proven.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Staging and production databases, their backups, logs, evidence, and all data types Fishtape stores |
| Review cadence | Annually, and after any change to `backup.sh` |
| Last reviewed | 2026-10-19 |
| Related controls | BCK-01, BCK-02, BCK-03, BCK-04, BCK-07, BCK-08, CRY-02, DAT-03 |

## Purpose

Be able to restore tenant data within the recovery targets in
[business-continuity.md](business-continuity.md), and keep data no longer than needed.

## Scope

Backups made by `deploy/<env>/backup.sh` and tested by `deploy/<env>/restore-test.sh` (identical
copies in staging and production; CI fails if they differ), and the retention of every data type in
the schedule below.

## Policy

1. The production database is backed up every night and before every deploy. A deploy doesn't
   start if the pre-deploy backup fails.
2. Backups are encrypted before they touch the disk. The server can write backups but can't read them.
3. Production backups are copied offsite, to a location in Canada, with provider-side retention or object lock.
4. A backup that hasn't been restored isn't trusted: a restore test runs every quarter, and once an
   offsite copy exists, a quarterly drill restores the offsite copy off the server and checks its
   secrets decrypt.
5. Data is kept only as long as the schedule below says, then deleted.

## What is backed up

| item | backed up how |
| --- | --- |
| PostgreSQL database `fishtape` (all tenants, platform tables, `audit_events`, encrypted `tenant_secrets`) | `backup.sh`: `pg_dump -Fc` as the superuser (FORCE RLS would hide rows from other roles), streamed into `age` |
| Code, deploy scripts, nginx config, migrations | Git (GitHub plus local clones) |
| Container images | Not backed up; rebuilt from git at a tag |
| `.env` secrets, `SECRETS_MASTER_KEY`, age private keys | Not in backups. Copies in the password manager and on an encrypted USB key |
| Logs | Not backed up. Deploy, backup and restore logs are copied into the monthly evidence bundle |

If file storage outside Postgres is added (photos, drawings, PDFs), it must be added to the backup
before it holds production data.

## How it's done here

### Encryption and keys

- `age` with public-key recipients from `backup-recipients.txt`. Only public keys are on the server.
- Staging: one key pair. Production: a primary key and a sealed spare, both listed as recipients;
  the spare is stored in a different place from the primary.
- Private keys stay offline: password manager plus encrypted USB. They are never written to a
  server's disk; `restore-test.sh --identity -` reads the key from stdin over SSH.
- Each backup gets a `.sha256` file; `restore-test.sh` checks it before restoring.
- After replacing a key, keep the old private key until every backup encrypted to it has aged out: 8 weeks on the server, about 13 months (400 days) for offsite weeklies.

### Schedule

| backup | when | kept |
| --- | --- | --- |
| Nightly | systemd timer: production 02:47, staging 03:17 server time, plus up to 10 minutes; missed runs catch up at boot | 14 daily |
| Weekly | Sunday's nightly, hard-linked (no extra space) | 8 weekly |
| Pre-deploy | Before migrations, by `update.sh` (required in production, optional in staging) | 5 most recent |
| Offsite (production) | After each backup: rclone (or rsync over SSH), encrypted files only, into `daily/`, `weekly/` (the weekly one) and `predeploy/` | Bucket lifecycle: `daily/` 35 days, `weekly/` 400 days, `predeploy/` 30 days; object lock (compliance mode) 35 days |

Deleted tenant data can stay in local backups for up to about 8 weeks, and in the offsite weeklies
for up to about 13 months (400 days), then ages out. The privacy notice and offboarding letter say
so (TM-BCK-05).

### Offsite

Required for production, optional for staging. The location must be in Canada and with a different
provider from the production host. Recommended: an S3-compatible bucket in a Canadian region
(default AWS S3 `ca-central-1`; VERIFY region and price when choosing) with versioning and object
lock. Two keys limited to the bucket: the server's can write and read but not delete; the drill's
is read-only and lives only on Kelvin's computer. Configured in `backup.conf` (root, mode 600) and
root's `rclone.conf`. Setup: [docs/runbooks/offsite-backups.md](../runbooks/offsite-backups.md).
Status: planned; the provider is still to be chosen (contract question 17).

`last-backup.json` records the offsite result (`ok`, `failed`, `skipped`), the target by provider
kind and remote or host name only (never keys, bucket paths or URLs), and the time of the last good
offsite copy, kept across failed runs.

### Monitoring

- `last-backup.json` (status `ok`, `degraded` when offsite failed, or `failed`; time of last success;
  the offsite result, target and last good offsite copy) is read by HQ > Developer health.
- `RESTORE_TESTS_FILE` (`/var/lib/fishtape-<env>/drills/restore-tests.jsonl`) holds restore tests and
  offsite drills; HQ health shows the last pass, where it ran and whether secrets were checked.
- The worker's hourly `hq_backup_alerts` job emails HQ (at most once a day per problem) when the
  backup is stale or failed, the offsite copy failed, is over 26 hours old or (production) is not
  configured, the last passing restore test is over 92 days old, or no offsite drill has passed.
- `backup-log.jsonl` keeps one line per run.
- A heartbeat ping goes to `HEARTBEAT_URL` after each run (the `/fail` URL on failure); the monitor
  alerts Kelvin's phone if no ping arrives.
- `check-host.sh` fails if the last production backup is not `ok` or is older than 26 hours.

### Restore testing

Quarterly (January, April, July, October) for each environment, and after any change to `backup.sh`:

    ssh <admin>@<host> 'sudo /path/to/deploy/<env>/restore-test.sh --identity -' < fishtape-<env>-backup.key

The script restores into a throwaway Postgres container with no network and checks tables,
migrations, tenants, the newest audit row, and that every tenant data table still has ENABLE and
FORCE row-level security. On the server it appends a line to `restore-tests.jsonl`, collected as
`restore-tests-<env>.jsonl`. When run on Kelvin's own computer instead, add
`--log restore-tests-<env>.jsonl` and put that file in the month's evidence bundle. A failed test is at least a SEV3: find the cause before relying on any
backup made the same way.

Once an offsite copy exists, the quarterly test for that environment is the **offsite drill**:
`offsite-drill.sh` on Kelvin's computer (never the server) fetches the newest offsite daily with
the read-only key, checks its checksum, restores it into a scratch Postgres, and with
`--verify-secrets` checks that a sample of every kind of encrypted value decrypts with
`SECRETS_MASTER_KEY` (`server/scripts/verify-restore.mjs`). Its JSON line (`"source": "offsite"`,
`"host": "off-box"`) is recorded on HQ health and goes in the evidence bundle. A drill whose secrets
don't decrypt is a SEV2. Steps: [docs/runbooks/offsite-backups.md](../runbooks/offsite-backups.md).

## Data retention schedule

| data | where | kept | then |
| --- | --- | --- | --- |
| Tenant business records (jobs, clients, estimates, invoices, drawings, wire runs, time entries) | Postgres, devices (IndexedDB) | Life of the tenant account | Exported to the tenant on request and deleted at offboarding ([docs/runbooks/offboard-tenant.md](../runbooks/offboard-tenant.md)) |
| Customer (portal) personal information | Postgres | Life of the tenant account, or until the tenant deletes it | Deleted with the tenant |
| Soft-deleted records (tombstones) | Postgres | Long enough for devices to sync the delete | Purge schedule to be set (planned) |
| Sessions, device tokens | Postgres (hashed) | Until expiry or revocation | Purged |
| API keys | Postgres (hashed) | Until revoked | Deleted; audit events keep the history |
| Tenant secrets (integration keys) | Postgres (encrypted) | Until replaced or the tenant leaves | Deleted at offboarding |
| `audit_events` | Postgres | Life of the tenant plus 1 year | Deleted with the tenant, unless on legal hold |
| Application and container logs | Hosts | 30 days (rotation) | Rotated out |
| nginx logs | Hosts | 30 days | Rotated out |
| Deploy, backup and restore logs | Hosts and evidence bundles | 3 years | Deleted |
| Evidence bundles | Encrypted store outside git | 3 years | Deleted |
| Database backups | Hosts and offsite | Host: 14 daily, 8 weekly, 5 pre-deploy. Offsite: dailies 35 days, weeklies 400 days, pre-deploy 30 days (35-day object lock) | Pruned by `backup.sh` on the host; expired by the bucket's lifecycle rules offsite |
| Breach records | Encrypted evidence store | 3 years (law requires at least 24 months) | Deleted |
| CASL consent and unsubscribe records | Postgres | While messages are sent to the contact, plus 3 years | Deleted |
| Fishtape's own billing and tax records | Stripe, accounting records | 6 years (Canada Revenue Agency) | Deleted |
| QuickBooks tokens and company id (`tenant_secrets`, internal names) | Postgres (encrypted) | While connected | Revoked at Intuit and deleted at disconnect; a failed revoke is retried from `qbo_revoke_pending` for at most 14 days, then deleted |
| QuickBooks links, snapshots, mappings, reference lists, queued changes, conflicts, candidates and the connection row | Postgres | While connected | Deleted at once on "Delete QuickBooks data now", else 30 days after disconnect (`qbo_purge`, hourly); with the tenant |
| QuickBooks sync log | Postgres | 90 days | Deleted by `qbo_purge` |
| Processed QuickBooks webhook events (`qbo_inbox`) | Postgres | 30 days after processing | Deleted by `qbo_purge` |
| Resolved QuickBooks conflicts | Postgres | 90 days | Deleted by `qbo_purge` |
| QuickBooks wizard candidates | Postgres | 30 days after the scan that wrote them, applied or not | Deleted by `qbo_purge` |
| QuickBooks connect tickets, OAuth states and takeover offers | Postgres | Until used, or 10 minutes (tickets 120 s) | Deleted on use; expired rows deleted hourly; with the user who started them |
| QuickBooks call counts (`qbo_api_usage`) | Postgres | 13 months | Deleted by `qbo_purge` |
| QuickBooks platform events (`qbo_platform_events`, no customer data) | Postgres | 30 days | Deleted by `qbo_purge` |
| Stripe payouts (`stripe_payouts`: amounts, dates, balance-transaction ids, no customer data) | Postgres | 7 years, like payments; kept when QuickBooks is disconnected (they are Stripe data) | Deleted with the tenant (no earlier purge yet) |
| Records that came from QuickBooks (clients, invoices, payments, bills) | Postgres, devices | As tenant business records (first row) | As tenant business records |

Every QuickBooks table cascades when the tenant is deleted; closing a company disconnects
QuickBooks (with revoke) first. Backups keep deleted rows until they age out (about 8 weeks on the server, 13 months for offsite weeklies), as
for all tenant data.

Tenants decide how long to keep their own business records (for example, CRA expects business
records to be kept six years). Fishtape keeps them while the account is active and provides an export
when the tenant leaves.

## Evidence

- `backup-log-<env>.jsonl`, `last-backup-<env>.json`, `restore-tests-<env>.jsonl` in each monthly bundle, plus `drills/restore-tests.jsonl` (restore tests and offsite drills recorded through HQ) and the drill output saved on Kelvin's computer.
- `check-host-production.json` (backup timer and last-backup checks).
- The heartbeat monitor's history (screenshot at the quarterly review).

## Exceptions

Staging pre-deploy backups are optional. RPO of 24 hours is accepted until WAL archiving is added.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
| 2026-10-20 | Kelvin Waldner | QuickBooks rows | Retention of the QuickBooks sync tables and Stripe payouts (contract 10.4). |
| 2026-10-20 | Kelvin Waldner | Offsite drill | Offsite retention (35/400/30 days, object lock), offsite tracking in `last-backup.json`, the quarterly offsite drill with a secrets check, HQ backup alerts (contract r1-get-paid.md section 5). |
