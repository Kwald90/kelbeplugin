# Encryption policy

How data is encrypted in transit and at rest, and how keys are kept.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | All Fishtape environments, backups, devices, and every key and certificate |
| Review cadence | Annually, and when a host, provider or algorithm changes |
| Last reviewed | 2026-10-19 |
| Related controls | CRY-01, CRY-02, CRY-03, CRY-04 |

## Purpose

Keep data unreadable to anyone who intercepts it or gets a copy of the disk or a backup, and make
sure keys are neither lost nor exposed.

## Scope

Network traffic to and from Fishtape, data stored on hosts, backups and devices, secrets inside the
application, and the keys that protect all of these.

## Policy

1. All traffic over the internet uses TLS 1.2 or 1.3. Plain HTTP only redirects to HTTPS.
2. Backups are always encrypted. Tenant secrets are encrypted inside the database.
3. Passwords, PINs, session tokens and API keys are never stored in a reversible form.
4. Use standard algorithms through well-known libraries. No home-made cryptography.
5. Every key has a custodian, a storage place and a rotation rule (table below).

## In transit

- Production nginx: `ssl_protocols TLSv1.2 TLSv1.3`, ECDHE with AES-GCM or ChaCha20-Poly1305 only,
  session tickets off, HTTP/2. Unknown host names get no TLS handshake.
- HSTS: one year, `includeSubDomains`. Not preloaded yet (preload is hard to undo; revisit once
  every `fishtapehq.com` name is HTTPS-only).
- Certificates from Let's Encrypt, renewed automatically by certbot. A CAA record allows only Let's Encrypt.
- Staging TLS is set by the CloudPanel vhost. Confirm it allows only TLS 1.2 and 1.3.
- The iOS app talks to the API over HTTPS only.
- Calls to vendors (Stripe, Twilio, Resend, Anthropic, Google, Microsoft, Meta) use HTTPS. Incoming
  webhooks are checked with the vendor's signature.
- Offsite backup copies travel over SSH (rsync) or HTTPS (rclone), and are already encrypted.

Internal traffic is not encrypted: nginx to the API over `127.0.0.1`, and the API to Postgres over
the private Docker network. This is acceptable because the traffic never leaves the host, every
container port is bound to `127.0.0.1`, production Postgres has no host port, and anyone able to read
that traffic already has root on the host and could read the data directly. If the database ever
moves to another host or a managed service, TLS with certificate verification (`sslmode=verify-full`)
becomes required.

## At rest

| what | how | status |
| --- | --- | --- |
| Production host disk | Provider disk encryption, or LUKS on a data volume for `/var/lib/docker` and `/var/backups` | Unknown for dotmoose: to confirm before production data |
| Staging host disk | Provider-managed | Unknown: to confirm. Staging holds no production data |
| Backups | `age` public-key encryption (X25519, ChaCha20-Poly1305); private keys offline | Implemented in `backup.sh` |
| Tenant secrets (Stripe, Twilio, Resend, Anthropic, Meta keys) | AES-256-GCM with a per-tenant data key; data keys wrapped (envelope encryption) with `SECRETS_MASTER_KEY` | Planned with the API |
| TOTP secrets | Need to be readable by the server, so encrypted with the same envelope scheme | To confirm with the API design |
| Passwords and crew PINs | argon2id | Planned with the API |
| Session tokens, device tokens, API keys | sha-256 of a long random token; the raw value is shown once and never stored | Planned with the API |
| MFA recovery codes | Hashed; use argon2id if the codes are short | To confirm with the API design |
| Devices (PC, Mac, iPads, phones) | Full-disk encryption: BitLocker, FileVault, iOS data protection with a passcode | See [asset-inventory.md](asset-inventory.md) |
| Evidence bundles | Encrypted storage outside git | See [README.md](README.md#evidence) |

A fast hash (sha-256) is fine for tokens and API keys because they are long random values; a slow
hash (argon2id) is needed for passwords and PINs because people choose them.

## Key management

| key | purpose | stored | custodian | rotation |
| --- | --- | --- | --- | --- |
| TLS certificate keys | HTTPS | `/etc/letsencrypt` on each host | Kelvin (certbot) | Automatic; certificates last 90 days and renew at 30 days left |
| `SECRETS_MASTER_KEY` (one per environment) | Wraps tenant data keys | Host `.env` (root, 600); copies in the password manager and on encrypted USB | Kelvin | On suspected exposure or when someone who could have seen it leaves; rewrap per [rotate-secrets](../runbooks/rotate-secrets.md). Never shared between environments |
| Postgres role passwords (superuser, owner, app, hq) | Database login | Host `.env` | Kelvin | Yearly and on suspected exposure |
| age backup key, staging | Decrypt staging backups | Offline: password manager and encrypted USB | Kelvin | On suspected exposure; keep the old key until its backups age out |
| age backup keys, production (primary and sealed spare) | Decrypt production backups | Offline; the spare sealed and stored separately | Kelvin | Same as staging |
| Deploy SSH keys (one per environment) | CI to the forced command | GitHub environment secrets only | Kelvin | Yearly and when a collaborator leaves |
| Kelvin's admin SSH keys | Server administration | Kelvin's devices, passphrase-protected (hardware-backed preferred) | Kelvin | Yearly, and at once if a device is lost |
| SSH host keys | Prove the server's identity | Each host; fingerprints pinned in GitHub secrets | Kelvin | When a host is rebuilt |
| OAuth client secrets (Google, Microsoft, per environment) | Sign-in | Host `.env` and the vendor console | Kelvin | Before the expiry set in the console (Microsoft secrets expire) and on exposure |
| Fishtape's own vendor keys (Stripe subscriptions, system email) | Billing, email | Production `.env`, password manager | Kelvin | Yearly and on exposure |
| Offsite backup credentials | Upload backups | `backup.conf` or root's rclone config (root, 600) | Kelvin | Yearly |
| Apple signing certificates | iOS builds | Kelvin's Mac keychain | Kelvin | At Apple's expiry |
| Tenant-supplied keys | Tenant integrations | `tenant_secrets` (encrypted) | The tenant | By the tenant |

Rotation steps are in [docs/runbooks/rotate-secrets.md](../runbooks/rotate-secrets.md) and
[docs/security/secrets-management.md](../security/secrets-management.md). Losing `SECRETS_MASTER_KEY` makes
stored tenant secrets unreadable (tenants would re-enter them); losing all copies of an age key makes
its backups useless. That is why both have two offline copies.

## Evidence

- `check-host-production.json` (disk encryption result, `.env` permissions, age installed).
- `last-backup-<env>.json` (`"encryption":"age"`).
- TLS scan output (for example `testssl.sh` or an online scanner) saved at the annual review.
- The key table above, checked during the November secret rotation.

## Exceptions

Unencrypted internal traffic on the host, as explained above.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
