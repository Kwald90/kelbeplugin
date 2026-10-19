# Staging: tgelectrical.truecollarbuilt.com

Staging runs on Kelvin's shared VPS (208.113.210.97, Ubuntu 24.04, CloudPanel nginx, Docker 29).
The PWA is served by nginx straight from the git checkout; the API, worker and Postgres run in
the docker compose project `fishtape-staging`.

Other sites share this box. **Don't touch** the host's Postgres on 127.0.0.1:5432, the app on
127.0.0.1:3000, or other sites' files in `/etc/nginx/sites-enabled/`. **Never run**
`deploy/setup-vps.sh` here.

## What's in this folder

| file | what it does |
| --- | --- |
| `docker-compose.yml` | Postgres 17 (127.0.0.1:5433), API (127.0.0.1:3410), worker, and one-off `migrate`/`seed` |
| `.env.example` | every setting; `init-env.sh` turns it into `.env` with random secrets |
| `initdb/10-bootstrap.sh` | first start only: runs `server/db/bootstrap.sql` to create the roles and database |
| `update.sh` | deploy: fetch, build, back up, migrate, switch, health-check, roll back on failure |
| `backup.sh` | encrypted `pg_dump`, 14 daily / 8 weekly, optional offsite, writes `last-backup.json` |
| `restore-test.sh` | restores a backup into a throwaway container and checks it |
| `host-status.sh` | disk, certificate expiry and load for the HQ health page |
| `security-headers.conf` | HSTS, CSP, Permissions-Policy and friends |
| `nginx-api.conf.snippet` | everything Fishtape needs inside the vhost (static app, `/api/`, `/hq/`, caching) |
| `nginx-http.conf` | http-level part: a log format that drops query strings |
| `logrotate-nginx` | keeps the API access log 30 days |
| `install-nginx.sh` | copies the nginx files into `/etc/nginx/snippets/` and the logrotate file, runs `nginx -t`, reloads |
| `../check-exposure.sh` | after every deploy: sensitive paths must not be served, required headers must be there |
| `vhost.example.conf` | what the whole CloudPanel vhost should look like afterwards, for comparison |
| `deploy-gate.sh` | SSH forced command for the CI deploy key |
| `systemd/` | timers for the nightly backup and the host status snapshot |

## Where things live on the box

| path | |
| --- | --- |
| `/var/www/tgelectrical/current` | git checkout (root-owned after the first `update.sh`) |
| `/var/www/tgelectrical/current/deploy/staging/.env` | secrets, root 600 |
| `/var/lib/fishtape-staging/` | `deploy-log.jsonl`, `backup-log.jsonl`, `restore-tests.jsonl`, `current-image` |
| `/var/lib/fishtape-staging/status/` | `last-backup.json`, `last-deploy.json`, `host-status.json` (mounted read-only into the API) |
| `/var/backups/fishtape-staging/` | `daily/`, `weekly/`, `predeploy/` encrypted dumps |
| docker volume `fishtape-staging_pgdata` | the database |

## First-time setup

Do these once, in order, over SSH (`ssh -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97`).

### 1. Check the box

```bash
docker --version && docker compose version     # Docker 29, Compose v2+
sudo ss -tlnp | grep -E ':(3410|5433)\b'       # must print nothing: both ports free
sudo apt-get install -y age                    # backup encryption
```

### 2. Get this folder onto the box

```bash
sudo bash /var/www/tgelectrical/current/deploy/update-vps.sh     # the old script, one last time
```

From now on use `deploy/staging/update.sh`, which also updates the static app.
`update-vps.sh` chowns the checkout to `www-data`; `update.sh` makes it root-owned again because
the checkout contains scripts that run as root.

### 3. Secrets

```bash
cd /var/www/tgelectrical/current/deploy/staging
sudo ./init-env.sh
sudo nano .env        # check PUBLIC_ORIGIN, CORS_ORIGINS; add Google/Microsoft keys when you have them
```

Copy `SECRETS_MASTER_KEY` into the password manager now. Without it, tenant secrets stored in the
database can't be decrypted.

`.env` lives at `/var/www/tgelectrical/current/deploy/staging/.env`: outside the web root
(`electrical-app/`), owned by root, mode 600. `init-env.sh` sets that and every `update.sh` run
re-applies it. Never put a `.env` (or a copy, backup or `.env.bak`) under `electrical-app/`.
`update-vps.sh` chowns the whole checkout to `www-data`, which would make `.env` readable by the
web server's user, so don't run it again after step 2.

### 4. Backup key (on your own computer, not the server)

```bash
age-keygen -o fishtape-staging-backup.key       # prints "Public key: age1..."
```

- Keep `fishtape-staging-backup.key` offline: the password manager plus an encrypted USB stick.
  Optionally protect it with a passphrase: `age -p -o fishtape-staging-backup.key.age fishtape-staging-backup.key`.
- Put only the public key on the server:

```bash
echo 'age1...your public key...' | sudo tee /var/www/tgelectrical/current/deploy/staging/backup-recipients.txt
```

Optional: `sudo cp backup.conf.example backup.conf && sudo chmod 600 backup.conf` and set an
offsite target and a heartbeat URL.

### 5. Edit the vhost

The vhost is `/etc/nginx/sites-enabled/tgelectrical.truecollarbuilt.com.conf`. If the site is
listed in CloudPanel's **Sites**, make the edit in CloudPanel (Site → Vhost) instead, or CloudPanel
may write its own copy back over yours later.

```bash
# a) back up the live vhost
sudo cp -a /etc/nginx/sites-enabled/tgelectrical.truecollarbuilt.com.conf \
  /root/tgelectrical.vhost.$(date +%Y%m%d-%H%M%S).bak

# b) install the snippets and the log rotation (runs nginx -t; puts the old files back if it fails)
sudo /var/www/tgelectrical/current/deploy/staging/install-nginx.sh

# c) edit the vhost. Two additions, one removal:
#    - first line of the file, outside any server block:
#        include /etc/nginx/snippets/fishtape-staging-http.conf;
#    - inside the `listen 443` server block, delete the old Fishtape lines (root, index, the
#      sw.js / index.html / static-file locations, location /, the dot-file rule, the old
#      add_header lines) and put this in their place:
#        include /etc/nginx/snippets/fishtape-staging-site.conf;
#    - in the port 80 server block, add `server_tokens off;`
#    Keep listen, server_name, ssl_* and the /.well-known/acme-challenge/ location.
#    Compare with deploy/staging/vhost.example.conf.
sudo nano /etc/nginx/sites-enabled/tgelectrical.truecollarbuilt.com.conf

# d) test, then reload. Only reload if the test passes.
sudo nginx -t && sudo systemctl reload nginx

# e) check: headers present, nothing sensitive reachable, unknown paths 404
/var/www/tgelectrical/current/deploy/check-exposure.sh https://tgelectrical.truecollarbuilt.com
```

What nginx serves after this: the web root is `electrical-app/` and nothing else. The secrets in
`deploy/staging/.env` sit outside it (root-owned, mode 600). nginx serves only app file types
from the root (`/`, `.js`, `.css`, `.json` schemas, images, fonts, the manifest and service
worker), returns 404 for every other path including dotfiles, `*.env*`, `*.sql`, `*.sh`, `*.md`,
dumps, keys and archives, and for `/deploy`, `/server`, `/docs`, `/tests` and the other repo
folders. There is no SPA fallback: the app uses a hash router, so unknown paths are 404.
`/api/` responses carry `Cache-Control: no-store` and are logged to
`/var/log/fishtape-staging/nginx-api.access.log` without query strings (kept 30 days).

If `nginx -t` fails, nothing has changed yet: fix the file or restore the backup
(`sudo cp /root/tgelectrical.vhost.<stamp>.bak /etc/nginx/sites-enabled/tgelectrical.truecollarbuilt.com.conf`),
then `nginx -t` again. Open the app on the iPad and in a desktop browser with the developer
console open: there should be no `Content-Security-Policy` errors.

Later changes to the snippets: `sudo deploy/staging/install-nginx.sh` (no vhost edit needed).

### 6. First deploy

```bash
sudo /var/www/tgelectrical/current/deploy/staging/update.sh --seed
```

This builds the image, starts Postgres (the first start runs `bootstrap.sql`), takes a backup
(skipped with a warning while the backup key isn't set up), migrates, seeds the test tenants and
TG Electrical, starts the API and worker and waits for `/api/readyz`. Then:

```bash
curl -s https://tgelectrical.truecollarbuilt.com/api/v1/status
sudo docker compose -f /var/www/tgelectrical/current/deploy/staging/docker-compose.yml ps
```

### 7. Timers

```bash
cd /var/www/tgelectrical/current/deploy/staging/systemd
sudo cp fishtape-staging-*.service fishtape-staging-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fishtape-staging-backup.timer fishtape-staging-host-status.timer
sudo systemctl start fishtape-staging-backup.service        # one backup now
cat /var/lib/fishtape-staging/status/last-backup.json
```

Then prove it restores, from your computer (the key never touches the server's disk):

```bash
ssh -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 \
  'sudo /var/www/tgelectrical/current/deploy/staging/restore-test.sh --identity -' < fishtape-staging-backup.key
```

### 8. Automatic deploys from CI (optional, after step 6 works)

`.github/workflows/deploy-staging.yml` runs after CI passes on the staging branch. It is off
until you turn it on. The CI key gets a dedicated user whose only power is "deploy a commit
that is on the branch".

On the server:

```bash
sudo adduser --system --group --shell /bin/bash --home /home/fishtape-deploy fishtape-deploy
sudo install -o root -g root -m 0755 /var/www/tgelectrical/current/deploy/staging/deploy-gate.sh \
  /usr/local/sbin/fishtape-staging-deploy-gate
echo 'fishtape-deploy ALL=(root) NOPASSWD: /var/www/tgelectrical/current/deploy/staging/update.sh' \
  | sudo tee /etc/sudoers.d/fishtape-staging-deploy
sudo chmod 440 /etc/sudoers.d/fishtape-staging-deploy && sudo visudo -cf /etc/sudoers.d/fishtape-staging-deploy
```

On your computer, make a key just for this (no passphrase; it lives only in GitHub):

```bash
ssh-keygen -t ed25519 -N '' -C github-actions-staging -f fishtape-staging-ci
```

On the server, authorise it with the forced command:

```bash
sudo install -d -o fishtape-deploy -g fishtape-deploy -m 700 /home/fishtape-deploy/.ssh
echo "restrict,command=\"/usr/local/sbin/fishtape-staging-deploy-gate\" $(cat fishtape-staging-ci.pub)" \
  | sudo tee /home/fishtape-deploy/.ssh/authorized_keys      # paste the .pub contents if running on the server
sudo chown fishtape-deploy: /home/fishtape-deploy/.ssh/authorized_keys && sudo chmod 600 /home/fishtape-deploy/.ssh/authorized_keys
```

Test from your computer: `ssh -i fishtape-staging-ci fishtape-deploy@208.113.210.97 status`.

In GitHub (Settings → Environments → New environment `staging`), add environment secrets:

| secret | value |
| --- | --- |
| `STAGING_SSH_KEY` | contents of `fishtape-staging-ci` (the private key) |
| `STAGING_HOST` | `208.113.210.97` |
| `STAGING_USER` | `fishtape-deploy` |
| `STAGING_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 208.113.210.97`, checked against `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server |

and a repository variable (Settings → Secrets and variables → Actions → Variables):
`STAGING_DEPLOY_ENABLED` = `true`. Delete the local copy of the private key once it is in GitHub.

## Day to day

```bash
cd /var/www/tgelectrical/current/deploy/staging
sudo ./update.sh                              # deploy the newest commit on the branch
sudo ./update.sh --sha <commit>               # a specific commit (rollback to a known-good one)
sudo docker compose logs -f --tail=200 api
sudo docker compose run --rm migrate
tail -n 5 /var/lib/fishtape-staging/deploy-log.jsonl
```

Rollback, restore and incident steps: `docs/runbooks/`.
