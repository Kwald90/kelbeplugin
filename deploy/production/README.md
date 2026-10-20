# Production: fishtapehq.com on the shared box

Production runs on Kelvin's VPS **208.113.210.97** (Ubuntu 24.04, CloudPanel nginx 1.30, Docker 29),
the same box as staging (`tgelectrical.truecollarbuilt.com`) and other people's sites. It is kept
separate from all of them: its own compose project, ports, paths, secrets, backup key, logs,
certificate and nginx file.

| host | serves |
| --- | --- |
| `fishtapehq.com` | the public marketing site (allow-list below) |
| `www.fishtapehq.com` | 301 to `https://fishtapehq.com` |
| `app.fishtapehq.com` | the PWA and the tenant API. `/hq/`, `/api/hq/` and the API docs UI are 404 here |
| `hq.fishtapehq.com` | the HQ console; its `/api/` goes to `hq-api`, the only process with the BYPASSRLS role |
| `status.fishtapehq.com` | `site/status.html` plus exactly the files it loads, `/api/v1/status`, `/api/readyz`, `/api/healthz` |

The marketing site (`fishtapehq.com`) serves only: `/` (`site/index.html` if it exists, else
`site/pricing.html`), `/site/*`, `/pricing` and `/signup` (short routes to `site/pricing.html` and
`site/signup.html`), the app assets the pages import (`/js/`, `/css/`, `/icons/`, `/vendor/`, read-only
from the release's `electrical-app/`), `/media/*` (videos and images from
`/var/lib/fishtape-production/media`), and the API routes `/api/v1/public/*`, `/api/v1/status` and
`/api/v1/webhooks/platform-stripe`, rate-limited. `/index.html` redirects to the app host,
`/site/status.html` to the status host. Everything else is 404. Same security headers and CSP as the app.

## What is whose on this box

| | production (this folder) | staging | not ours: never touch |
| --- | --- | --- | --- |
| code | `/srv/fishtape/repo` (clone at the deployed tag) | `/var/www/tgelectrical/current` | other sites' folders |
| web root | `/srv/fishtape/www/current` → `releases/<sha>/{electrical-app,hq,site}` | the checkout | |
| state, logs | `/var/lib/fishtape-production` (+ `media/`), `/var/log/fishtape-production` | `/var/lib/fishtape-staging`, `/var/log/fishtape-staging` | |
| backups | `/var/backups/fishtape-production`, own age key | `/var/backups/fishtape-staging`, staging key | |
| containers | compose project `fishtape-production`: api **127.0.0.1:3420**, hq-api **127.0.0.1:3421**, Postgres on the compose network only | `fishtape-staging`: 3410, 3411, 5433 | host Postgres 5432, the app on 3000 |
| nginx | `sites-enabled/zz-fishtape-production.conf` → `sites-available/fishtape-production.conf`, `snippets/fishtape-{headers,proxy,deny,tls}.conf` | `snippets/fishtape-staging-*.conf` in the CloudPanel vhost | every other file in `sites-enabled/` |
| certificate | Let's Encrypt lineage `fishtape` (webroot `/var/www/certbot`) | `tgelectrical.truecollarbuilt.com` | every other lineage |

The production nginx file has **no `default_server`** and no catch-all: unknown names and bare-IP
requests keep going wherever they went before. Its link name sorts last (`zz-`), so no Fishtape
server becomes nginx's implicit default either. Never run `deploy/setup-vps.sh` here, and don't
create a CloudPanel site for any `fishtapehq.com` name (it would claim the same names;
`install-nginx.sh` refuses to install next to one).

## First-time setup

Run these in order over SSH (`ssh -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97`). Every nginx
step backs up the files it changes, runs `nginx -t`, and reloads only if the test passes; on a
failed test it puts the old files back. Commands that print secrets say so: run those in your own
interactive terminal, not through a tool whose output is logged.

The branch on GitHub must already contain this kit (this README, `issue-cert.sh`, the 3420/3421
ports): merge it into `claude/electrical-concept-app-h4qz12` and push first.

### 0. Look before touching anything

```bash
sudo nginx -t                                                  # must pass now, before any change
ls /etc/nginx/sites-enabled/
sudo grep -l 'fishtapehq' /etc/nginx/sites-enabled/* 2>/dev/null || echo "no vhost uses fishtapehq yet"
sudo ss -tlnp | grep -E '127\.0\.0\.1:(3420|3421)\b' || echo "3420/3421 free"
for n in fishtapehq.com www.fishtapehq.com app.fishtapehq.com status.fishtapehq.com hq.fishtapehq.com; do
  printf '%-24s %s\n' "$n" "$(dig +short "$n" A | tr '\n' ' ')"     # each: 208.113.210.97
done
docker --version && docker compose version
command -v certbot age || sudo apt-get install -y certbot age
df -h / /var/lib/docker                                        # room for another Postgres and image
```

### 1. Code

The repository is public, so it clones over HTTPS without a key.

```bash
sudo install -d -m 755 /srv/fishtape
sudo git clone --branch claude/electrical-concept-app-h4qz12 https://github.com/Kwald90/kelbeplugin.git /srv/fishtape/repo
sudo chmod 750 /srv/fishtape/repo
```

### 2. Secrets (`.env`)

```bash
cd /srv/fishtape/repo/deploy/production
sudo ./init-env.sh                     # fresh random DB passwords and SECRETS_MASTER_KEY; refuses to overwrite
sudo sed -i -E \
  -e 's#^PUBLIC_ORIGIN=.*#PUBLIC_ORIGIN=https://app.fishtapehq.com#' \
  -e 's#^CORS_ORIGINS=.*#CORS_ORIGINS=https://app.fishtapehq.com,https://fishtapehq.com,https://hq.fishtapehq.com,capacitor://localhost#' \
  -e 's#^TRIAL_DAYS=.*#TRIAL_DAYS=14#' \
  -e 's#^HQ_NOTIFY_EMAIL=.*#HQ_NOTIFY_EMAIL=info@tgelectrical.ca#' .env
sudo grep -E '^(PUBLIC_ORIGIN|CORS_ORIGINS|TRIAL_DAYS|HQ_NOTIFY_EMAIL)=' .env
```

`CORS_ORIGINS` lists the app, the marketing site (its Enterprise form posts to `/api/v1/public/`)
and the iOS app, plus HQ: the API's CSRF check compares the browser's `Origin` with this list, so
without `https://hq.fishtapehq.com` HQ sign-in fails. The status page's origin (`STATUS_PUBLIC_URL`,
`https://status.fishtapehq.com`) is allowed automatically for its email subscribe, confirm and unsubscribe posts.

Kelvin, in your own terminal (these are secrets):

- copy `SECRETS_MASTER_KEY` into the password manager: `sudo grep ^SECRETS_MASTER_KEY= .env`.
  Production's own value, never staging's. Without it, stored company secrets can't be decrypted.
- Fishtape's billing uses the **True Collar Built** Stripe account: put its live
  `STRIPE_SECRET_KEY` in `.env` now (`sudo nano .env`); `STRIPE_WEBHOOK_SECRET` comes in step 10.
  Keys go into this file on the server only, never into git, chat or a ticket.
- optional now, needed for password-reset email: `RESEND_API_KEY` and `EMAIL_FROM`.

Never `cat` the whole `.env` in a session whose output is kept.

### 3. Backup key

On your own computer (not the server). A different key from staging's:

```bash
age-keygen -o fishtape-production-backup.key           # prints "Public key: age1..."
age-keygen -o fishtape-production-backup-spare.key     # sealed spare, stored somewhere else
```

Both private keys stay offline (password manager + encrypted USB; the spare in a different place).
Only the public keys go on the server:

```bash
F=/srv/fishtape/repo/deploy/production/backup-recipients.txt
echo 'age1...production public key...' | sudo tee "$F"
echo 'age1...spare public key...'      | sudo tee -a "$F"
sudo grep -qFxf /var/www/tgelectrical/current/deploy/staging/backup-recipients.txt "$F" \
  && echo "STOP: a staging key is in the production recipients" || echo "ok: not staging's key"
cd /srv/fishtape/repo/deploy/production
sudo cp backup.conf.example backup.conf && sudo chmod 600 backup.conf
sudo nano backup.conf          # OFFSITE_* target (in Canada, another provider) and HEARTBEAT_URL
```

Backups run without the offsite target and heartbeat, but report `degraded` until both are set.

### 4. nginx, ACME bootstrap

```bash
sudo /srv/fishtape/repo/deploy/production/install-nginx.sh --acme-bootstrap
```

This enables a port-80-only site for the five names that serves `/.well-known/acme-challenge/`
from `/var/www/certbot` and 404 for everything else. No other site changes.

### 5. Certificate

```bash
sudo /srv/fishtape/repo/deploy/production/issue-cert.sh --dry-run --email info@tgelectrical.ca   # rehearsal (Let's Encrypt staging)
sudo /srv/fishtape/repo/deploy/production/issue-cert.sh --email info@tgelectrical.ca
```

`issue-cert.sh` keeps only the names whose A record is this box (and whose AAAA, if any, is too),
checks that nginx here serves the challenge path for each, then runs
`certbot certonly --webroot -w /var/www/certbot --cert-name fishtape --expand -d …`. It touches
no other certificate and stores the nginx reload in this lineage's own renewal config (no global
hook). Run it again whenever a name starts resolving here (it adds it); when nothing is new it does
nothing. Renewal is the box's existing `certbot.timer`; check it with `sudo certbot renew --cert-name fishtape --dry-run`.

### 6. nginx, full config

```bash
sudo /srv/fishtape/repo/deploy/production/install-nginx.sh
```

It installs the sites and snippets, removes the bootstrap site, runs `nginx -t`, refuses if
another vhost already uses a `fishtapehq.com` name, checks the Fishtape servers are really loaded,
and reloads. Until the first deploy the hosts answer 404 (no release yet) and the API routes 502.
Then check the neighbours are unaffected:

```bash
curl -s -o /dev/null -w 'staging %{http_code}\n' https://tgelectrical.truecollarbuilt.com/
echo | openssl s_client -connect 127.0.0.1:443 -servername unknown.invalid 2>/dev/null | openssl x509 -noout -subject   # not a fishtapehq name
```

### 7. First release: tag `v0.1.0` and deploy it

Production deploys only `v*` tags that are on the release branch. Cut the first one where you push
from (the lead's PC), on the commit you want live:

```bash
git fetch origin
git switch claude/electrical-concept-app-h4qz12 && git pull --ff-only
git tag -a v0.1.0 -m "v0.1.0: first production release"
git push origin v0.1.0
git rev-parse 'v0.1.0^{commit}'          # the 40-character commit, for --sha below
```

Pushing the tag starts `deploy-production.yml`: it checks the tag and runs CI; the deploy job stays
off until `PRODUCTION_DEPLOY_ENABLED` is set (step 11). On the server:

```bash
sudo /srv/fishtape/repo/deploy/production/update.sh --tag v0.1.0 --sha <commit from above>
```

`update.sh` checks the tag (format, on the branch, pointing at `--sha`), builds the image, starts
Postgres (its first start creates the roles and database), takes an encrypted pre-deploy backup,
migrates, starts `api`, `hq-api` and `worker` on 3420/3421 and waits for `/api/readyz`, publishes
`electrical-app/`, `hq/` and `site/` as a new release and flips `current`, and checks
`app.fishtapehq.com` through nginx. A failure up to here rolls everything back. It then checks the
apex, status and hq hosts and runs `check-exposure.sh` on each: problems there are warnings (in the
output and the deploy log), not a rollback. hq is skipped with a warning while it doesn't resolve or
isn't on the certificate.

```bash
tail -n 1 /var/lib/fishtape-production/deploy-log.jsonl        # "result":"success"
sudo docker compose -f /srv/fishtape/repo/deploy/production/docker-compose.yml ps
curl -s https://app.fishtapehq.com/api/v1/status; echo
```

### 8. Timers

```bash
cd /srv/fishtape/repo/deploy/production/systemd
sudo cp fishtape-production-*.service fishtape-production-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fishtape-production-backup.timer fishtape-production-host-status.timer
sudo systemctl start fishtape-production-host-status.service fishtape-production-backup.service
cat /var/lib/fishtape-production/status/last-backup.json
```

`host-status.sh` (every 15 minutes) also records `probes` in `host-status.json`: the HTTP code (0 = no
answer in 5 s) of https://app.fishtapehq.com/, …/api/readyz, https://hq.fishtapehq.com/api/healthz,
https://fishtapehq.com/ and https://status.fishtapehq.com/. The worker's 5-minute status job reads the
file (`HOST_STATUS_FILE`, through the read-only status mount) and, while it is under 20 minutes old, a
failing app / api / hq probe marks that component down on the public status page for that run
(`docs/runbooks/status-page.md`). Codes only: no bodies, headers or secrets are stored.

The backup runs nightly at 02:47 (staging's at 03:17). Then prove a restore from your computer:

```bash
ssh -i ~/.ssh/kelvindale_vps ubuntu@208.113.210.97 \
  'sudo /srv/fishtape/repo/deploy/production/restore-test.sh --identity -' < fishtape-production-backup.key
```

### 9. Exposure checks

```bash
X=/srv/fishtape/repo/deploy/check-exposure.sh
$X https://app.fishtapehq.com --production
$X https://fishtapehq.com --marketing
$X https://status.fishtapehq.com --status
$X https://hq.fishtapehq.com --hq
cat /var/lib/fishtape-production/last-exposure-check.txt        # the same checks, from update.sh
```

Each must end `0 fail`. Also open each host in a browser with the developer console open: no CSP
errors.

### 10. First company and HQ admin

Production has no seed. TG Electrical's owner and the first HQ admin are the same account,
`info@tgelectrical.ca`: create the company first, then give that account the HQ role.

The tools run inside the running `api` container with `docker compose exec` (the output of an exec
never reaches the container logs). A secret is printed only to a terminal; otherwise the tool
refuses before changing anything, unless `--secret-to-stdout` sends it on purpose to a root-only file.

```bash
cd /srv/fishtape/repo/deploy/production

# a) The company and its owner. Prints a generated password once.
#    Kelvin, in an interactive terminal:
sudo docker compose exec api node src/cli/create-tenant.js \
  --name "TG Electrical" --email info@tgelectrical.ca --owner "Kelvin Waldner" --province AB
#    or, when the lead runs it over non-interactive SSH, into a root-only file Kelvin reads later:
sudo sh -c 'umask 077; cd /srv/fishtape/repo/deploy/production && docker compose exec -T api node src/cli/create-tenant.js --name "TG Electrical" --email info@tgelectrical.ca --owner "Kelvin Waldner" --province AB --secret-to-stdout > /root/fishtape-first-signin.txt'
#    (Kelvin: sudo cat /root/fishtape-first-signin.txt && sudo shred -u /root/fishtape-first-signin.txt)

# b) The same account becomes the HQ admin. Prints nothing secret.
sudo docker compose exec -T api node src/cli/create-hq-admin.js --email info@tgelectrical.ca --promote
```

Then Kelvin signs in at https://app.fishtapehq.com with that password, changes it, and sets up
two-step sign-in (required for owners and HQ). HQ at https://hq.fishtapehq.com uses the same email,
password and authenticator. More HQ people later: `create-hq-admin.js --email … --name "…"
[--role hq_staff]` creates the account and prints a one-time set-password link (7 days, single
use) instead of a password. Public signup stays closed (`signup_open` flag) until you open it in HQ.

Billing (Fishtape's own Stripe, the True Collar Built account), once `STRIPE_SECRET_KEY` is in `.env`:

```bash
cd /srv/fishtape/repo/deploy/production
sudo docker compose up -d --no-build --force-recreate api hq-api worker  # reload .env
sudo docker compose exec api node scripts/stripe-setup.js --dry-run
sudo docker compose exec api node scripts/stripe-setup.js --live         # creates the Fishtape products and CAD prices
```

In Stripe: add the webhook endpoint `https://app.fishtapehq.com/api/v1/webhooks/platform-stripe`
with the events the script lists, put its signing secret in `.env` as `STRIPE_WEBHOOK_SECRET`
(Kelvin, on the server), run the `up -d --no-build --force-recreate` line again, and turn on the
customer portal.

### 11. Later: deploys from CI

Same as staging (`deploy/staging/README.md` step 8), with a **separate user** so the staging key
can never deploy production: user `fishtape-prod-deploy`, gate
`/usr/local/sbin/fishtape-production-deploy-gate` from `deploy-gate.sh` (its header has the exact
lines), sudoers file `/etc/sudoers.d/fishtape-production-deploy` allowing only
`/srv/fishtape/repo/deploy/production/update.sh`, and a new key `fishtape-production-ci`.
GitHub → Settings → Environments → `production`: required reviewer Kelvin, tags `v*` only, secrets
`PRODUCTION_SSH_KEY`, `PRODUCTION_HOST` (`208.113.210.97`), `PRODUCTION_USER`
(`fishtape-prod-deploy`), `PRODUCTION_KNOWN_HOSTS`; then the repository variable
`PRODUCTION_DEPLOY_ENABLED=true`.

## Day to day

```bash
sudo /srv/fishtape/repo/deploy/production/update.sh --tag v0.1.1 --sha <commit>   # by hand; CI does the same after approval
sudo /srv/fishtape/repo/deploy/production/install-nginx.sh                          # update.sh does this when the installed files differ
sudo /srv/fishtape/repo/deploy/production/issue-cert.sh                             # after adding a name to DNS
cd /srv/fishtape/repo/deploy/production && sudo docker compose logs -f --tail=200 api
sudo docker compose exec postgres psql -U postgres -d fishtape                     # admin; Postgres has no host port
```

Hero media for the marketing site: copy files into `/var/lib/fishtape-production/media/`
(`.mp4`, `.webm`, `.jpg`, `.png`, `.webp`; plain names, mode 644) and reference them as
`/media/<name>`. They are cached 30 days, so give a changed file a new name
(`hero-2026-11.mp4`) instead of overwriting it.

Rollback, restore, secret rotation and incidents: `docs/runbooks/` (production ports are 3420/3421).

## Risks of sharing the box (read before real customer data)

- **Staging can reach production.** Staging deploys whatever is pushed to the branch and runs its
  scripts as root here, and root on this box can read production's `.env`, database and backups.
  Until production has its own host: only Kelvin (and the lead) push to the branch, branch
  protection on, and consider turning staging's CI deploy off (`STAGING_DEPLOY_ENABLED`).
- Other sites' code runs on the same kernel. A compromised neighbour that gets root gets
  production too; one that doesn't can still reach 127.0.0.1:3420/3421 (sign-in is still required).
- The status page lives on the box it reports on. Before launch, point `status.` at an external
  status service (`docs/architecture/environments.md`).
- `docs/compliance/` still describes a dedicated production host (dotmoose); record this box
  instead (data-centre location, disk encryption, who has root).
- `check-host.sh` was written for a dedicated host: on this box expect FAILs for listeners and
  firewall rules that belong to CloudPanel and the other sites. Read it as a report, not a gate.
