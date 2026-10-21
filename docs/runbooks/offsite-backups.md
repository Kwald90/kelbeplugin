# Offsite backups and the offsite restore drill

Use this to set up the offsite copy of the nightly backups, to prove every quarter that the offsite
copy restores (and that its secrets still decrypt), and to answer an HQ backup alert. The policy is
[backup-retention.md](../compliance/backup-retention.md); restoring onto a server is
[restore-from-backup.md](restore-from-backup.md).

What exists in the repo (Release 1, contract `docs/releases/r1-get-paid.md` section 5):

| piece | does |
| --- | --- |
| `deploy/<env>/backup.sh` | after each nightly and pre-deploy backup, copies the encrypted file and its `.sha256` to `daily/` or `predeploy/` on the offsite target, and the weekly one to `weekly/`. Records `offsite` (`ok`, `failed`, `skipped`), `offsiteTarget` (provider kind and remote or host name plus `OFFSITE_LABEL`; never keys, buckets or URLs) and `lastOffsiteOkAt` in `last-backup.json` |
| `deploy/<env>/offsite-drill.sh` | runs on your computer, never on the server: fetches the newest offsite daily with a read-only key, checks its checksum, restores it into a scratch Postgres with `restore-test.sh`, and with `--verify-secrets` checks that encrypted values decrypt (`server/scripts/verify-restore.mjs`). Writes one JSON line |
| HQ > Developer health | "Offsite copy" and "Restore drill" cards, the recent tests, and **Record a drill result** (paste the drill's JSON line) |
| `hq_backup_alerts` (worker, hourly) | emails `HQ_NOTIFY_EMAIL` once a day per problem: backup stale or failed, offsite failed, stale (over 26 hours) or not configured (production), restore drill overdue (over 92 days), no offsite drill yet |

Nothing here runs against a live server by itself. Setting up the bucket and `backup.conf` is a
change on the server: do it with this runbook, by hand, and record it.

## 1. Choose the storage (Kelvin, once)

Recommended: an S3-compatible bucket in a Canadian region, with a different provider from the
production host. Default (contract question 17): **AWS S3 `ca-central-1` (Montréal)**; `ca-west-1`
(Calgary) also works. Alternatives: Wasabi `ca-central-1` (Toronto), or another provider with a
Canadian region and object lock. VERIFY the current region list and per-GB price before choosing.

Size: the database holds plan sets (about 140 MB each) and photos, so expect tens of GB once 35
dailies and about 57 weeklies are kept. Check the provider's storage, request and egress prices
(a drill downloads one full backup each quarter).

Record the provider, region and bucket name in
[vendor-management.md](../compliance/vendor-management.md) (offsite backup storage row) and accept
the recovery point: up to 24 hours of server data, plus whatever phones have not synced yet (they
push it when they reach the restored server).

## 2. Create the bucket (Kelvin, in the provider's console)

1. Create the bucket in the Canadian region with **versioning on** and **object lock on**. Object lock
   can only be turned on when the bucket is created. Default retention: **compliance mode, 35 days**.
   Block all public access. Default encryption on (the files are already `age`-encrypted; this is a
   second layer).
2. Lifecycle rules, one per prefix (per environment, e.g. `production/daily/`):
   - `daily/`: expire current versions after **35 days**;
   - `weekly/`: after **400 days**;
   - `predeploy/`: after **30 days** (the 35-day lock keeps them a little longer; that is fine);
   - for all: delete noncurrent versions 1 day after they become noncurrent, and remove expired
     delete markers.
3. Two access keys, limited to this bucket:
   - **server key** (goes on the server): list the bucket, write objects, read objects; **no
     delete**, no bucket or lock settings. For AWS IAM: `s3:ListBucket` on the bucket and
     `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::<bucket>/*`.
   - **drill key** (goes on your computer only): `s3:ListBucket` and `s3:GetObject`. Read-only.
4. Put both keys in the password manager. Keep the `age` private key in at least two places: the
   password manager and an offline copy (USB or paper in a safe), not only on the PC. Keep
   `SECRETS_MASTER_KEY` for each environment in the password manager too.

## 3. Point the server at it (Lead or Kelvin, on the server)

As root on the server (the backup runs as root, so the rclone config is root's):

```bash
sudo rclone config        # n) new remote, name: offsite-ca, storage: s3, provider: AWS (or Wasabi),
                          # access key and secret: the SERVER key, region: ca-central-1,
                          # location_constraint: ca-central-1, then in the advanced options:
                          # no_check_bucket = true (a write-only key can't create or check buckets)
sudo rclone lsd offsite-ca:<bucket>          # the key works (lists prefixes, or nothing yet)
```

Type the keys at the prompts; never put them on a command line (shell history, `ps`).

Then in `deploy/<env>/backup.conf` (root, mode 600; see `backup.conf.example`):

```bash
OFFSITE_RCLONE_REMOTE=offsite-ca:<bucket>/production
OFFSITE_LABEL="s3 ca-central-1"
HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

Run one backup and check it:

```bash
sudo /srv/fishtape/repo/deploy/production/backup.sh
sudo cat /var/lib/fishtape-production/status/last-backup.json   # "offsite":"ok", "offsiteTarget":"rclone offsite-ca (s3 ca-central-1)", "lastOffsiteOkAt":"..."
```

If the upload is refused with a message about a missing `Content-MD5` or checksum on an object-lock
bucket, upgrade rclone (use a current release from rclone.org) and run it again. VERIFY on the first
upload: large backups go up in parts.

HQ > Developer health now shows "Offsite copy: ok". The production status file says `degraded`
until both the offsite target and `HEARTBEAT_URL` are set.

## 4. Your computer, for the drill (Kelvin, once)

The drill runs where the server's problems can't reach it. On Windows use WSL (Ubuntu) with Docker
Desktop's WSL integration turned on; Git Bash is not enough (age reads the key through a pipe that
native Windows programs can't open). A throwaway Linux VM works the same way.

In WSL:

```bash
sudo apt install age nodejs          # node 20 or later; any recent Docker Desktop works
rclone version                       # install a current rclone from rclone.org if missing or old
rclone config --config ~/.config/rclone/drill.conf
                                     # new remote "drill-ro", s3, the DRILL (read-only) key, region ca-central-1
rclone --config ~/.config/rclone/drill.conf lsf drill-ro:<bucket>/production/daily/ | tail -3
cd /mnt/f/Local/kelbeplugin && git pull   # the checkout (verify-restore.mjs runs from it; no npm install needed)
```

The drill refuses to run if it finds `/var/lib/fishtape-*` or `/var/backups/fishtape-*`, so it can't
be run on a server by mistake.

## 5. Run the drill (quarterly: January, April, July, October; and after changing backup.sh)

Look first (fetches nothing):

```bash
deploy/production/offsite-drill.sh --rclone-config ~/.config/rclone/drill.conf \
  --remote drill-ro:<bucket>/production --dry-run
```

Then the full drill. The `age` key and `SECRETS_MASTER_KEY` go in on stdin, are held in memory and
passed on through pipes; neither is written to disk:

```bash
{ cat /path/to/fishtape-production-backup.key
  printf 'SECRETS_MASTER_KEY=%s\n' "$(read -rsp 'SECRETS_MASTER_KEY: ' k </dev/tty; echo "$k")"
} | deploy/production/offsite-drill.sh --rclone-config ~/.config/rclone/drill.conf \
      --remote drill-ro:<bucket>/production --identity - --verify-secrets
```

(If the key file lives on the USB stick, read it from there; don't copy it into WSL.)

It prints the restore summary (tables, migrations, tenants, row-level security), the secrets
summary (one sample per kind: integration secrets, QuickBooks tokens, MFA secrets, pending
QuickBooks revokes; counts only) and `PASS`, then one JSON line, also appended to
`./restore-tests.jsonl`. The scratch database and the temp copy are deleted (`--keep` leaves the
database running for a look; it prints how to remove it).

Exit codes: 0 pass; 1 the download, checksum, restore or a check failed; 2 bad usage or a missing
tool; 3 no offsite target, or it can't be listed; 4 nothing to fetch; 5 secrets did not decrypt.
A failed drill (1 or 5) still writes a line (`"ok": false`): record it too.

**Record it:** HQ > Developer health > **Record a drill result**, paste the line. HQ checks it (time,
environment, fields), keeps only the known fields with your name, and audits it. Record a
production drill on production's HQ and a staging drill on staging's HQ (it refuses the other).
Put `restore-tests.jsonl` in the month's evidence bundle as well.

A secrets failure (exit 5) means this backup can't be fully used with the key in the password
manager: treat it as a SEV2, find out which key the server uses
([rotate-secrets.md](rotate-secrets.md)) and fix the password-manager copy before anything else.
One expected case: `SECRETS_MASTER_KEY` was rotated after this backup was taken. Values in it are
still wrapped by the previous key, so run the drill again with the previous key (kept until those
backups expire, [secrets-management.md](../security/secrets-management.md)).

## 6. HQ backup alerts

The worker checks hourly and emails `HQ_NOTIFY_EMAIL` at most once a day per problem (subject
"Backup alert (<env>): ..."). First steps:

| problem | first steps |
| --- | --- |
| backup is stale / last backup failed | `systemctl list-timers 'fishtape-*-backup*'`, `journalctl -u fishtape-<env>-backup`, then `sudo deploy/<env>/backup.sh` by hand |
| offsite backup failed | the local backup is fine. As root: `rclone lsd offsite-ca:<bucket>` to test the key and the network; check the key is still active and allowed to write; run `backup.sh` once |
| offsite backup stale | nothing has reached the bucket in 26 hours: check `last-backup.json` (`offsite` field) and the timer; `skipped` means `OFFSITE_RCLONE_REMOTE` is gone from `backup.conf` |
| offsite backup not configured | production has no offsite target: sections 1 to 3 |
| restore drill overdue | the last passing restore test or drill is over 92 days old: section 5 |
| no offsite restore drill yet | an offsite copy exists (or this is production) but no offsite drill has passed: section 5 |
| backup status / restore test log unreadable | the API can't read `BACKUP_STATUS_FILE` or `RESTORE_TESTS_FILE`: check the mounts (`/var/lib/fishtape-<env>/status`, and `drills/` owned by uid 1000; `update.sh` creates it) |

The emails carry file names, times and the target label only.

## 7. Restoring from the offsite copy

When the server is gone, follow [restore-from-backup.md](restore-from-backup.md) section C. Fetch
the backup with the drill key from your computer (`rclone copy drill-ro:<bucket>/production/daily/<file>
.` and its `.sha256`), check `sha256sum -c`, and copy both to the new host.

## 8. Keys and changes

- Rotate both bucket keys every year and whenever someone who had them leaves. Update root's
  `rclone.conf` on the server (server key) and your `drill.conf` (drill key), then run one backup and
  a dry-run drill.
- A new `age` key: [backup-retention.md](../compliance/backup-retention.md) ("After replacing a
  key"). Old offsite copies stay encrypted to the old key until they expire (up to 400 days for
  weeklies): keep the old private key that long.
- A lost or leaked drill key can read every backup in the bucket, but the files are `age`-encrypted:
  rotate the key, and treat it as an incident only if the `age` key may have leaked too (threat
  model TM-R1-04).

## Record

Each drill: the JSON line (HQ and the evidence bundle), and on failure an incident record with the
cause. Bucket setup and key rotations: a line in the change log of
[vendor-management.md](../compliance/vendor-management.md).

## Kelvin's checklist (contract section 15, items 1 to 9)

1. Pick an S3-compatible bucket in a Canadian region (section 1).
2. Versioning and object lock, compliance mode, 35 days (section 2).
3. Lifecycle: `daily/` 35 days, `weekly/` 400 days, `predeploy/` 30 days (section 2).
4. Two keys limited to the bucket: server (write and read, no delete) and drill (read-only).
5. The `age` private key in at least two places (password manager and offline); `SECRETS_MASTER_KEY`
   in the password manager.
6. On the server: `rclone config` as root, `OFFSITE_RCLONE_REMOTE` and `HEARTBEAT_URL` in
   `backup.conf`, one backup, `last-backup.json` says `offsite: ok` (section 3).
7. Docker Desktop (or WSL with Docker) and rclone on the PC with the read-only key; run
   `offsite-drill.sh --identity - --verify-secrets`; record the line on HQ health; repeat quarterly
   (HQ alerts after 92 days).
8. Provider and region in `docs/compliance/vendor-management.md`.
9. Accept the recovery point: up to 24 hours of server data plus whatever phones have not synced.
