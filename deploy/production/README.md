# Production: app.fishtapehq.com

Production runs on its own VPS at dotmoose (a friend's hosting; OS and location still to be
confirmed). It serves three names from one box:

| host | serves |
| --- | --- |
| `app.fishtapehq.com` | the PWA and the tenant API (`/api/`). `/api/hq/` and `/hq/` return 404 here. |
| `hq.fishtapehq.com` | the HQ console and its API (`/api/hq/`, BYPASSRLS role) |
| `status.fishtapehq.com` | `/api/v1/status` only (prefer an external status service; see `docs/architecture/environments.md`) |

Deploys come only from `v*` tags, after CI passes and Kelvin approves in the GitHub
`production` environment. Nothing is shared with staging: own host, own secrets, own backup
key, own OAuth apps, own deploy key.

## Host prerequisites

Work through this list before the first deploy, then run `sudo ./check-host.sh`, which checks
most of it and changes nothing. Keep its JSON output as evidence
(`sudo ./check-host.sh --json /var/lib/fishtape-production/check-host-$(date +%F).json`).

**Ask dotmoose first**

- [ ] Where is the data centre? Aim for Canada. PIPEDA doesn't forbid storing data abroad, but
      Fishtape stays accountable and has to tell customers; Quebec (Law 25) needs a privacy
      assessment before data leaves Quebec; and public-sector work (for example under Nova
      Scotia's PIIDPA) can require Canadian storage. Record the answer in
      `docs/compliance/vendor-management.md`.
- [ ] Is the disk encrypted at rest? Who at dotmoose can reach the console, snapshots and backups?
- [ ] Is there a written agreement (even an email) covering confidentiality, breach notice to
      you, and what happens to disks and snapshots when the server is cancelled?
- [ ] Out-of-band console access for when SSH is broken, and how snapshots work.
- [ ] Sizing: 4+ vCPU, 8+ GB RAM, 80+ GB SSD to start.

**Operating system**

- [ ] Ubuntu Server LTS (24.04 or newer), fully updated: `sudo apt update && sudo apt full-upgrade`.
- [ ] Hostname set; timezone UTC is fine (`timedatectl set-timezone UTC`).
- [ ] Time sync on: `timedatectl` shows `System clock synchronized: yes`.
- [ ] Automatic security updates: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.
      Decide when reboots happen (`Unattended-Upgrade::Automatic-Reboot` at a quiet hour, or reboot by hand weekly).
- [ ] Disk encryption if the provider offers it (or LUKS on a data volume for `/var/lib/docker` and `/var/backups`).

**Access**

- [ ] A named admin account for Kelvin with sudo; SSH keys only (ed25519), the private key passphrase-protected.
- [ ] `/etc/ssh/sshd_config.d/10-fishtape.conf`:
      `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`,
      `X11Forwarding no`, `MaxAuthTries 3`, `AllowUsers <kelvin> fishtape-deploy`. Then `sudo sshd -t && sudo systemctl reload ssh`
      (keep a second session open while testing).
- [ ] No other accounts with a login shell; the provider's own access documented.

**Network**

- [ ] `sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable`.
- [ ] Docker-published ports skip ufw. Every port in `docker-compose.yml` is bound to `127.0.0.1`; keep it that way.
- [ ] fail2ban with the sshd jail: `sudo apt install fail2ban` (the default `sshd` jail is on in Ubuntu's package).

**Software**

- [ ] Docker Engine and the compose plugin from Docker's apt repository.
      `/etc/docker/daemon.json`: `{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"10"},"live-restore":true}`.
- [ ] nginx (`sudo apt install nginx`) and remove the default site: `sudo rm /etc/nginx/sites-enabled/default`.
- [ ] certbot (`sudo apt install certbot`) and `age` (`sudo apt install age`).
- [ ] Optional: rclone, for offsite backups to object storage.

**Monitoring**

- [ ] An external uptime check on `https://app.fishtapehq.com/api/readyz` and
      `https://status.fishtapehq.com/api/v1/status` (UptimeRobot, Better Stack or similar), alerting Kelvin's phone.
- [ ] A heartbeat check for the nightly backup (`HEARTBEAT_URL` in `backup.conf`).

## Layout on the host

| path | |
| --- | --- |
| `/srv/fishtape/repo` | git checkout at the deployed tag (root-owned, not served) |
| `/srv/fishtape/repo/deploy/production/.env` | secrets, root 600 |
| `/srv/fishtape/www/releases/<sha>/` | static files per release (`electrical-app/`, `hq/`) |
| `/srv/fishtape/www/current` | symlink to the live release; flipped atomically by `update.sh` |
| `/var/lib/fishtape-production/` | `deploy-log.jsonl`, `backup-log.jsonl`, `restore-tests.jsonl`, `status/` |
| `/var/backups/fishtape-production/` | encrypted dumps (`daily/`, `weekly/`, `predeploy/`) |

## First-time setup

### 1. DNS

A (and AAAA if the host has IPv6) records for `app`, `hq` and `status` under `fishtapehq.com`
pointing at the production host. Add a CAA record allowing only Let's Encrypt:
`fishtapehq.com. CAA 0 issue "letsencrypt.org"`.

### 2. Code

```bash
sudo install -d -m 755 /srv/fishtape
sudo git clone https://github.com/Kwald90/kelbeplugin.git /srv/fishtape/repo
sudo chmod 750 /srv/fishtape/repo
```

(If the repo goes private, add a read-only deploy key for root and clone over SSH.)

### 3. Secrets

```bash
cd /srv/fishtape/repo/deploy/production
sudo ./init-env.sh
sudo nano .env       # origins, production OAuth apps, PG_* sizing for this host
```

Store `SECRETS_MASTER_KEY` in the password manager, separately from staging's.

### 4. Backup key (on your own computer)

```bash
age-keygen -o fishtape-production-backup.key
age-keygen -o fishtape-production-backup-spare.key    # sealed spare, stored somewhere else
```

Both private keys stay offline (password manager + encrypted USB; the spare in a different
place). Both public keys go in `/srv/fishtape/repo/deploy/production/backup-recipients.txt`, one
per line. Then `sudo cp backup.conf.example backup.conf && sudo chmod 600 backup.conf` and set
the offsite target (required for production) and `HEARTBEAT_URL`.

### 5. TLS

```bash
sudo /srv/fishtape/repo/deploy/production/install-nginx.sh --acme-bootstrap
sudo certbot certonly --webroot -w /var/www/certbot --cert-name fishtape \
  -d app.fishtapehq.com -d hq.fishtapehq.com -d status.fishtapehq.com \
  --email <kelvin's email> --agree-tos --no-eff-email
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo /srv/fishtape/repo/deploy/production/install-nginx.sh          # full config; removes the bootstrap site
sudo certbot renew --dry-run
```

### 6. Timers

```bash
cd /srv/fishtape/repo/deploy/production/systemd
sudo cp fishtape-production-*.service fishtape-production-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fishtape-production-backup.timer fishtape-production-host-status.timer
```

### 7. Deploy user for CI

Same as staging (`deploy/staging/README.md` step 8) with these names:
`/usr/local/sbin/fishtape-production-deploy-gate` from `deploy-gate.sh`, sudoers file
`/etc/sudoers.d/fishtape-production-deploy` allowing
`/srv/fishtape/repo/deploy/production/update.sh`, a new key `fishtape-production-ci`.

GitHub → Settings → Environments → `production`:

- Required reviewers: Kelvin. Deployment branches and tags: tags matching `v*` only.
- Environment secrets: `PRODUCTION_SSH_KEY`, `PRODUCTION_HOST`, `PRODUCTION_USER` (`fishtape-deploy`),
  `PRODUCTION_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`, checked against the host's fingerprint).
- Repository variable `PRODUCTION_DEPLOY_ENABLED` = `true`; optional `RELEASE_BRANCH` if releases
  move off `claude/electrical-concept-app-h4qz12`.

### 8. First release

```bash
git tag -a v0.1.0 -m "First production release" && git push origin v0.1.0
```

CI runs, the deploy waits for approval in GitHub, then runs `update.sh --tag v0.1.0 --sha <commit>`
on the host. By hand on the host instead: `sudo /srv/fishtape/repo/deploy/production/update.sh --tag v0.1.0`.

Then run `sudo ./check-host.sh`, a manual backup (`sudo systemctl start fishtape-production-backup.service`)
and a restore test from your computer (`docs/runbooks/restore-from-backup.md`).

## Hardening differences from staging

- No seed service and no `--seed`; production starts empty (TG Electrical is onboarded with
  `docs/runbooks/onboard-tenant.md`).
- Postgres has no host port. Admin access: `sudo docker compose exec postgres psql -U postgres -d fishtape`.
- No API docs UI (`/api/docs`, `/api/documentation` return 404); HQ only on `hq.`.
- Pre-deploy backup is required; deploys only from tags on the release branch, matching the commit CI tested.
- nginx rate limits on `/api/` and stricter ones on `/api/v1/auth/`; unknown hosts get no response.
- Static files are versioned release folders; rollback flips a symlink.
