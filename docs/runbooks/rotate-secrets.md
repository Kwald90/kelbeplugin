# Rotate secrets

When: on the schedule in [secrets-management.md](../security/secrets-management.md) (yearly for
most), immediately when a secret may have leaked (committed, pasted, logged, on a lost device), and
when someone with access leaves. On a leak: rotate first, investigate second.

Generate values the same way every time: `openssl rand -hex 32` for passwords that go into URLs,
`openssl rand -base64 32` for `SECRETS_MASTER_KEY`. Edit `.env` with `sudo nano`, keep it
`root:root 600` (`update.sh` re-applies that). Store the new value in the password manager in the
same sitting. Never paste values into chat, tickets or AI tools.

`<checkout>/deploy/<env>` is the working folder below; `dc` = `sudo docker compose`.

## Postgres role passwords (app, hq, owner)

The password lives in two places that must change together: the role in Postgres and `.env`.

```bash
cd <checkout>/deploy/<env>
NEW=$(openssl rand -hex 32)
sudo docker compose exec -T postgres psql -U postgres -d postgres \
  -c "ALTER ROLE fishtape_app PASSWORD '$NEW'"                  # or fishtape_hq / fishtape_owner
sudo sed -i "s/^FISHTAPE_APP_PASSWORD=.*/FISHTAPE_APP_PASSWORD=$NEW/" .env    # matching variable
unset NEW
sudo docker compose up -d api hq-api worker                     # recreated with the new URL
curl -fsS http://127.0.0.1:3410/api/readyz && curl -fsS http://127.0.0.1:3411/api/readyz
```

For the owner role, nothing restarts: the next `migrate` run uses it. Old connections keep working
until they close; restart the containers if the old password leaked.

## Postgres superuser

`POSTGRES_SUPERUSER_PASSWORD` is only used when the data volume is first created; the superuser
can't log in over TCP (the first-start hook rejects it). Rotate it with
`ALTER ROLE postgres PASSWORD '<new>'` via `docker compose exec`, then update `.env`.

## SECRETS_MASTER_KEY (tenant secrets envelope key)

It wraps the per-tenant data keys that protect Stripe/Twilio/Resend/Anthropic/Meta keys and MFA
secrets. Replacing it without re-wrapping makes every stored tenant secret unreadable.

- Scheduled rotation needs the API's re-wrap support (old key decrypt-only while data keys are
  re-wrapped with the new one). Until workstream A ships that, rotate only on suspected exposure.
- Suspected exposure, until then: treat every tenant secret as exposed. Ask each tenant to rotate
  their provider keys at the provider; generate a new master key; replace it in `.env`; restart;
  have tenants re-enter their keys in Settings. Record it as an incident.

## OAuth client secrets (Google, Microsoft)

Create a new secret in the provider console (Google Cloud credentials / Entra app registration),
put it in `.env`, `sudo docker compose up -d api hq-api`, test sign-in, then delete the old secret
at the provider.

## CI deploy key (STAGING_SSH_KEY / PRODUCTION_SSH_KEY)

```bash
ssh-keygen -t ed25519 -N '' -C github-actions-<env>-$(date +%Y%m) -f fishtape-<env>-ci
```

1. On the host, replace the line in `/home/fishtape-deploy/.ssh/authorized_keys` (keep
   `restrict,command="/usr/local/sbin/fishtape-<env>-deploy-gate"` in front of the new key).
2. In GitHub, environment `<env>`, update `<ENV>_SSH_KEY` with the private key.
3. Test: re-run the last deploy workflow, or `ssh -i fishtape-<env>-ci fishtape-deploy@<host> status`.
4. Delete the local copy of the private key.

If the host key changed (rebuild), update `<ENV>_KNOWN_HOSTS` from `ssh-keyscan -t ed25519 <host>`,
checked against the fingerprint printed on the host (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).

## age backup key

Rotate yearly or if the private key may be exposed.

1. On your computer: `age-keygen -o fishtape-<env>-backup-<year>.key` (store it like the old one).
2. On the host, put the new public key in `backup-recipients.txt` next to the old one, run a
   backup, and restore-test it with the new key.
3. Remove the old public key. Keep the old private key until the last backup made with it has aged
   out (8 weeks for weeklies, longer for anything offsite), then destroy it and note that in the
   evidence store.

If the old private key leaked: every backup encrypted to it is exposed. That's a security
incident: check where those files are (host, offsite) and who could reach them.

## Tenant API keys and HQ/staff sessions

Revoke in the app (Settings, API keys / members). For a person leaving: remove their membership,
which ends their sessions; for HQ staff also clear `platform_role`.

## Vendor and personal accounts

GitHub, DNS registrar, hosting panels, Stripe/Twilio/Resend/Meta/Apple/Google/Microsoft consoles:
change the password in the password manager, check MFA is still on, sign out other sessions, and
review recent activity.

## Record

A line per rotation in the evidence store: what, when, why (scheduled / leak / leaver), who.
GitHub secret "updated" dates and the quarterly access review confirm it.
