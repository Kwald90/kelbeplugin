# Restore from backup

Backups are `pg_dump -Fc` files encrypted with `age` to an offline key
(`/var/backups/fishtape-<env>/{daily,weekly,predeploy}/*.dump.age`, plus the offsite copy for
production). The server can't read them: every restore needs the private key from the password
manager or the encrypted USB stick. Targets: production RPO 24 hours, RTO 8 hours
([business-continuity.md](../compliance/business-continuity.md)).

Three cases: A, prove a backup restores (quarterly, on the server copy and on the offsite copy);
B, put data back on a running host; C, rebuild a lost host.

## A. Restore test (quarterly, and after any change to backup.sh)

From your computer, with the key piped over SSH (it never touches the server's disk):

```bash
ssh <admin>@<host> 'sudo <checkout>/deploy/<env>/restore-test.sh --identity -' < fishtape-<env>-backup.key
```

Or on your computer with Docker, age and bash, after copying a backup down:

```bash
scp <admin>@<host>:/var/backups/fishtape-<env>/daily/<file>.dump.age* .
./deploy/<env>/restore-test.sh --file <file>.dump.age --identity ~/keys/fishtape-<env>-backup.key \
  --log restore-tests-<env>.jsonl
```

It restores into a throwaway container with no network and checks tables, migrations, tenants, the
newest audit row, and that every tenant table still has ENABLE and FORCE row-level security.
`PASS` is the result; the JSON line goes to `restore-tests.jsonl` on the server (or `--log`) and
into the monthly evidence bundle. On the server it also goes to
`/var/lib/fishtape-<env>/drills/restore-tests.jsonl`, which HQ > Developer health reads. A `FAIL`
is a SEV3 incident: no backup made the same way can be trusted until the cause is found.

### A2. Offsite drill (quarterly, from your computer)

The test above proves the copy on the server. The offsite drill proves the copy that survives
losing the server: it fetches the newest offsite daily with a read-only key, checks its checksum,
restores it with `restore-test.sh`, and with `--verify-secrets` checks that encrypted values
(integration secrets, QuickBooks tokens, MFA secrets) decrypt with `SECRETS_MASTER_KEY`. It never
runs on the server. Steps, keys and exit codes: [offsite-backups.md](offsite-backups.md) section 5.

```bash
{ cat fishtape-<env>-backup.key; printf 'SECRETS_MASTER_KEY=%s\n' "<from the password manager>"; } \
  | deploy/<env>/offsite-drill.sh --rclone-config ~/.config/rclone/drill.conf \
      --remote drill-ro:<bucket>/<env> --identity - --verify-secrets
```

Record its JSON line on HQ > Developer health ("Record a drill result"). HQ emails a reminder when
the last passing test is over 92 days old, and in production until an offsite drill has passed.
An exit code 5 (secrets did not decrypt) is a SEV2: the backup can't be fully used with the key you
hold.

## B. Restore onto a running host (data loss or corruption)

1. Incident record first ([incident-response.md](incident-response.md)). Decide the restore point:
   the newest backup from before the damage (`ls -1 /var/backups/fishtape-<env>/*/`), a
   `predeploy/` dump if a deploy caused it.
2. Stop writes and keep the damaged database for investigation:

```bash
cd <checkout>/deploy/<env>
sudo docker compose stop api hq-api worker
sudo docker compose exec -T postgres psql -U postgres -d fishtape -Atc "SELECT last_value FROM change_seq" \
  | sudo tee /root/change_seq_before_restore.txt                 # highest sync cursor issued
sudo docker compose exec -T postgres psql -U postgres -d postgres \
  -c "ALTER DATABASE fishtape RENAME TO fishtape_damaged_$(date +%Y%m%d)"
```

3. Restore (key from your computer on stdin, held in memory only):

```bash
ssh <admin>@<host> 'sudo bash -c '\''key="$(cat)"; cd <checkout>/deploy/<env> &&
  age -d -i <(printf "%s\n" "$key") /var/backups/fishtape-<env>/daily/<file>.dump.age |
  docker compose exec -T postgres pg_restore -U postgres --create --exit-on-error -d postgres'\''' \
  < fishtape-<env>-backup.key
```

4. Sync cursors must never go backwards. Devices hold cursors up to the old `change_seq`; move the
   sequence well past it so they pull everything written from now on:

```bash
OLD=$(cat /root/change_seq_before_restore.txt)              # if unknown (host lost), use a large margin
sudo docker compose exec -T postgres psql -U postgres -d fishtape -c "SELECT setval('change_seq', ${OLD:-0} + 10000000)"
```

5. Migrate (the backup may be older than the code), start, check:

```bash
sudo docker compose run --rm migrate
sudo docker compose up -d api hq-api worker
curl -fsS http://127.0.0.1:3410/api/readyz && curl -fsS http://127.0.0.1:3411/api/readyz   # staging
curl -fsS http://127.0.0.1:3420/api/readyz && curl -fsS http://127.0.0.1:3421/api/readyz   # production
```

   In HQ, verify the audit chain of a few tenants (`/api/hq/tenants/<id>/audit/verify`).
6. Tell affected tenants what was lost: changes made between the backup time and the incident are
   gone from the server; devices that still hold unsynced changes will push them on their next sync.
   Templates in [incident-response.md](incident-response.md).
7. When the investigation is done, drop the damaged copy:
   `sudo docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE fishtape_damaged_<date>"`.

## C. Rebuild a lost host

1. Incident (SEV1 for production). Start a new host from the checklist in
   [deploy/production/README.md](../../deploy/production/README.md) (or the staging README).
2. Restore `.env` from the password manager (same values, so tenant secrets still decrypt with the
   same `SECRETS_MASTER_KEY`), `backup.conf`, and `backup-recipients.txt`.
3. Bring up only Postgres (`sudo docker compose up -d postgres`); its first start runs
   `bootstrap.sql` with the role passwords from `.env`.
4. Fetch the newest backup from offsite with the read-only drill key, on your computer
   (`rclone --config ~/.config/rclone/drill.conf lsf drill-ro:<bucket>/<env>/daily/ | sort | tail -1`,
   then `rclone copy` that file and its `.sha256`), check it (`sha256sum -c <file>.sha256`), copy both
   to the new host (`scp`), then follow B from step 3 (drop the empty `fishtape` database created by
   bootstrap first: `DROP DATABASE fishtape`), and in step 4 use a large margin for `change_seq`.
   The quarterly offsite drill ([offsite-backups.md](offsite-backups.md)) rehearses exactly this
   fetch and restore.
5. Deploy the release that was running (`update.sh --tag <tag>` / `--sha <commit>`), point DNS at
   the new host, run `check-host.sh` and `check-exposure.sh`.
6. Rotate anything the old host held if it may be in someone else's hands
   ([rotate-secrets.md](rotate-secrets.md)).

## Record

Incident record with: restore point chosen and why, file name and sha256, times (start, service
back), data-loss window, tenants told. A rebuild doubles as the annual DR drill write-up
(`dr-drill-<date>.md` in the evidence store).
