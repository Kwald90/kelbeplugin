# Roll back a release

`update.sh` already rolls back on its own when a deploy fails its checks: containers go back to
the previous image, the web root (production) back to the previous release folder, and the result
is logged as `rolled_back`. Use this runbook when that didn't happen or wasn't enough: the
rollback itself failed, or the problem showed up after a "successful" deploy.

Code rolls back. **Migrations do not.** Every migration is written so the previous release still
works against the new schema (expand/contract). If a migration damaged data, rolling the code back
won't fix it: go to [restore-from-backup.md](restore-from-backup.md).

## 1. Decide

- Open an incident record ([incident-response.md](incident-response.md)). Production down or
  data at risk is SEV1; a broken feature for many tenants is SEV2.
- Find the last good release:

```bash
tail -n 5 /var/lib/fishtape-<env>/deploy-log.jsonl      # "to" = commit, "tag" on production
cat /var/lib/fishtape-<env>/current-image /var/lib/fishtape-<env>/previous-image
```

## 2a. Roll back the normal way (redeploy the good release)

Staging (the commit must be on the branch):

```bash
sudo /var/www/tgelectrical/current/deploy/staging/update.sh --sha <good commit> --force
```

Production (redeploy the previous tag; GitHub approval path, or by hand on the host):

```bash
sudo /srv/fishtape/repo/deploy/production/update.sh --tag <previous tag> --force
```

This rebuilds from the good commit (the image is usually still cached), runs the migration step
(a no-op: the schema is already ahead) and switches back with the same checks as a deploy.

## 2b. Fast path (seconds, when the good image is still on the host)

```bash
cd <checkout>/deploy/<env>
sudo docker image ls fishtape.invalid/server          # the good commit's tag must be listed
sudo IMAGE_TAG=<good commit> docker compose up -d --no-build api hq-api worker
curl -fsS http://127.0.0.1:3410/api/readyz && curl -fsS http://127.0.0.1:3411/api/readyz   # staging
curl -fsS http://127.0.0.1:3420/api/readyz && curl -fsS http://127.0.0.1:3421/api/readyz   # production
sudo docker tag fishtape.invalid/server:<good commit> fishtape.invalid/server:current
echo <good commit> | sudo tee /var/lib/fishtape-<env>/current-image
```

Production web root as well (the previous release folder is kept):

```bash
ls -1t /srv/fishtape/www/releases/
sudo ln -sfn releases/<good commit> /srv/fishtape/www/current.next
sudo mv -Tf /srv/fishtape/www/current.next /srv/fishtape/www/current
```

Staging serves the PWA from the checkout, so also put the checkout back:

```bash
sudo git -c safe.directory=/var/www/tgelectrical/current -C /var/www/tgelectrical/current reset --hard <good commit>
```

The fast path isn't written to the deploy log by a script: add a line to the incident record
saying what you ran and when.

## 3. Check

```bash
<checkout>/deploy/check-exposure.sh https://<host> [--production]
curl -s https://<host>/api/v1/status                  # gitSha = the good commit
```

Watch HQ developer health (errors, queue lag) for 30 minutes.

## 4. Afterwards

- Fix forward on the branch; ship the fix through the normal deploy.
- Post-incident review within 5 business days for SEV1/SEV2.
- If tenants saw errors or lost work, tell them ([incident-response.md](incident-response.md), templates).
