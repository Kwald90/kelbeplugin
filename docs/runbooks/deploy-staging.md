# Deploy to staging

Staging is https://tgelectrical.truecollarbuilt.com, built from the branch
`claude/electrical-concept-app-h4qz12`. First-time setup is in
[deploy/staging/README.md](../../deploy/staging/README.md); this is the routine path.

## Before

- The change is merged to the branch and CI shows **CI passed** for that commit.
- If it has a migration: it is expand/contract (the previous release still works against the new
  schema). Deploys never roll migrations back.
- If it changes `deploy/staging/security-headers.conf`, `nginx-*.conf` or the snippet: plan to run
  `install-nginx.sh` right after (step 3).

## 1. Deploy

Automatic, once `STAGING_DEPLOY_ENABLED=true`: every push to the branch that passes CI runs
`.github/workflows/deploy-staging.yml`, which SSHes to the deploy user's forced command and runs
`update.sh --sha <commit>`. Watch it in GitHub Actions.

By hand (or to redeploy a specific commit):

```bash
ssh -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97
sudo /var/www/tgelectrical/current/deploy/staging/update.sh                 # newest commit on the branch
sudo /var/www/tgelectrical/current/deploy/staging/update.sh --sha <commit>  # a specific one
```

`update.sh` fetches, refuses commits that aren't on the branch or that track server-only files,
builds the image tagged with the commit, takes an encrypted pre-deploy backup, migrates, starts
`api`, `hq-api` and `worker`, waits for `/api/readyz` on both APIs, and rolls back to the previous
image and commit if anything fails. Add `--seed` only on a fresh database (it prints generated
passwords once: put them in the password manager; never run it from CI).

## 2. Check

```bash
tail -n 1 /var/lib/fishtape-staging/deploy-log.jsonl        # "result":"success"
cat /var/lib/fishtape-staging/last-exposure-check.txt | tail -n 3
curl -s https://tgelectrical.truecollarbuilt.com/api/v1/status
```

- `last-exposure-check.txt` must end with `0 fail`. If the only failure is "live CSP differs",
  do step 3.
- Open the app on the iPad: close and reopen it to pick up the new service worker.

## 3. If nginx files changed

```bash
sudo /var/www/tgelectrical/current/deploy/staging/install-nginx.sh   # nginx -t; restores on failure
/var/www/tgelectrical/current/deploy/check-exposure.sh https://tgelectrical.truecollarbuilt.com
```

## If it fails

- `update.sh` printed "rolled back": staging is on the previous release. Read the message in the
  deploy log, fix forward on the branch.
- "ROLLBACK FAILED" or the site is down: [rollback.md](rollback.md), and treat it as an incident
  ([incident-response.md](incident-response.md)), SEV3 on staging.
- "tracks server-only files": someone committed `.env`, `backup.conf` or `backup-recipients.txt`.
  Remove it from git (`git rm --cached`), rotate whatever it contained ([rotate-secrets.md](rotate-secrets.md)).

## Record

Nothing extra: the deploy log line is the record. It is collected monthly into the evidence bundle.
