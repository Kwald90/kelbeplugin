# Deploy to production

Production is app.fishtapehq.com (with hq., status. and the public site on fishtapehq.com), on the
shared VPS next to staging. It only ever runs a `v*` tag on the
release branch, after CI passes and Kelvin approves. First-time setup and the host checklist:
[deploy/production/README.md](../../deploy/production/README.md).

## Before

- The commit has been on staging and works there (at least a day for anything touching auth,
  sync, migrations or HQ).
- Migrations are expand/contract. A contract step (dropping a column the previous release still
  reads) ships one release after the code stopped using it.
- Release notes written: what changed, migrations, anything tenants will notice.
- Not on a Friday evening or before you're away: you are the on-call.

## 1. Tag

```bash
git switch claude/electrical-concept-app-h4qz12 && git pull
git tag -a v1.4.0 -m "v1.4.0: <one line>"
git push origin v1.4.0
```

`deploy-production.yml` then:

1. checks the tag (format `vX.Y.Z`, on the release branch, has `server/`),
2. runs the full CI on the tagged commit,
3. waits for approval in the `production` environment.

## 2. Approve

In GitHub, Actions, the run, **Review deployments**. Before approving, pause and check:
the CI run is green, the diff since the last tag (`git log v1.3.0..v1.4.0 --oneline`) is what you
meant to ship, and staging is healthy. Approving is the change-management sign-off; write one
line in the approval comment (what and why).

The job SSHes to the deploy user's forced command, which runs
`update.sh --tag v1.4.0 --sha <tested commit>`. `update.sh` refuses the tag if it now points
elsewhere, requires an encrypted pre-deploy backup, migrates, switches `api`, `hq-api` and
`worker`, waits for readiness, publishes the static files as a new release folder, flips the
web root, checks the app host through nginx, and rolls everything back on failure. It then checks
the apex, status and hq hosts and runs `deploy/check-exposure.sh` on each (warnings only). The
workflow runs the same exposure checks from outside.

By hand, on the host, if GitHub is unavailable (this is an emergency change: record it, see
[change-management.md](../compliance/change-management.md)):

```bash
sudo /srv/fishtape/repo/deploy/production/update.sh --tag v1.4.0
```

## 3. Check

```bash
tail -n 1 /var/lib/fishtape-production/deploy-log.jsonl     # "result":"success", "tag":"v1.4.0"
tail -n 3 /var/lib/fishtape-production/last-exposure-check.txt
curl -s https://status.fishtapehq.com/api/v1/status
```

Then sign in to HQ and look at the developer health page (migrations current, queue lag, errors,
last backup). Watch it for 30 minutes after anything touching sync or auth.

If nginx files changed: `sudo /srv/fishtape/repo/deploy/production/install-nginx.sh`, then
`/srv/fishtape/repo/deploy/check-exposure.sh https://app.fishtapehq.com --production` (and
`https://fishtapehq.com --marketing`, `https://status.fishtapehq.com --status`,
`https://hq.fishtapehq.com --hq`). A new host name in DNS: `sudo .../issue-cert.sh` first.

## If it fails

- Rolled back automatically: production is on the previous release. Investigate on staging.
- Rollback failed, or errors appear after a "success": [rollback.md](rollback.md) and
  [incident-response.md](incident-response.md) (SEV2 or SEV1 by impact).
- Pre-deploy backup failed: nothing was changed. Fix the backup first
  ([restore-from-backup.md](restore-from-backup.md) has the checks). `--skip-backup` exists for
  emergencies only and is recorded in the deploy log.

## Record

The deploy log line, the GitHub approval (with your comment) and the CI run are the evidence.
