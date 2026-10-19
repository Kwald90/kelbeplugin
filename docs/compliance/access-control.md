# Access control policy

Who can reach which system, how access is granted and removed, and how it is checked.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Every account on every Fishtape system, vendor console and environment, including service accounts and keys |
| Review cadence | Annually; access itself is reviewed quarterly (January, April, July, October) |
| Last reviewed | 2026-10-19 |
| Related controls | ACC-01 to ACC-09, OPS-06, HRS-02, CRY-04 |

## Purpose

Make sure only the right people and processes can reach Fishtape systems and data, with the least
access they need, and that access ends when it should.

## Scope

GitHub, servers (staging and production), databases, the HQ console, the password manager, email,
DNS, hosting panels, vendor consoles, CI/CD secrets, API keys, and access inside the product for
tenant users, portal users and crew devices.

## Policy

1. Access is granted for a reason, at the lowest level that works, and removed when the reason ends.
2. Accounts are personal. No shared logins, except the `ubuntu` admin account on the shared staging
   box, which only Kelvin uses.
3. MFA is required on the accounts listed below. Hardware keys (passkeys or FIDO2) are preferred for
   GitHub, email and the password manager.
4. Every credential lives in the password manager or in a system built for secrets (GitHub
   environment secrets, the server's root-only `.env`). Never in git, chat, email or tickets.
5. Contractors and AI agents never get production access, production secrets, SSH keys or GitHub admin.
6. Access is reviewed every quarter, and the review is kept as evidence.

## MFA requirements

| where | requirement |
| --- | --- |
| GitHub | Required. Hardware key or passkey preferred. Contractors must have 2FA on before they are added. |
| Hosting panels (DreamHost, dotmoose) | Required |
| DNS registrar | Required |
| Password manager | Required. Hardware key preferred. |
| Email (Kelvin's) | Required. Hardware key preferred. |
| Stripe, Twilio, Resend, Meta, Apple developer, Google and Microsoft consoles | Required |
| Fishtape app: tenant owners and admins | TOTP required, with recovery codes |
| Fishtape HQ staff | TOTP required |

Where a vendor doesn't offer MFA, note it in [vendor-management.md](vendor-management.md) and use a
unique generated password.

## Accounts by system

| system | accounts | notes |
| --- | --- | --- |
| GitHub `Kwald90/kelbeplugin` | Kelvin (owner). Contractors as collaborators while engaged. The cloud Claude session through its GitHub integration. | Branch protection on the release branch; CODEOWNERS `* @Kwald90`. |
| GitHub environments `staging`, `production` | Deploy SSH keys and pinned `known_hosts` as environment secrets | `production` requires Kelvin's approval and allows `v*` tags only. |
| Staging VPS (shared, CloudPanel) | `ubuntu` (Kelvin's key), `fishtape-deploy` (CI, forced command) | Other sites share the box; their accounts are outside Fishtape's control. |
| Production VPS | A named admin account for Kelvin with sudo, `fishtape-deploy` (CI, forced command) | Keys only, no root login, `AllowUsers` set. dotmoose's own access to be documented. |
| PostgreSQL | `postgres` (superuser: backups and admin via `docker compose exec`), `fishtape_owner` (migrate container only), `fishtape_app` (API, NOBYPASSRLS), `fishtape_hq` (BYPASSRLS, HQ only) | Production Postgres has no host port. |
| HQ console | HQ staff accounts (Kelvin only today) | TOTP required; only on `hq.fishtapehq.com`. |
| Vendor consoles | Kelvin | Stripe, Twilio, Resend, Meta, Apple, Google, Microsoft, Anthropic, DNS registrar, hosting panels, uptime monitor, offsite storage. |
| Password manager, email | Kelvin | Emergency access for the backup contact (planned). |

## How it's done here

### Quarterly access review

Done in January, April, July and October. The evidence collector writes a pre-filled checklist,
`access-review-<date>.md`. Work through it, note what was removed or changed, and store it in that
month's evidence bundle.

- [ ] GitHub collaborators and their 2FA status; the GitHub integration used by the cloud agent session.
- [ ] Deploy keys and GitHub environment secrets (names, last updated) for `staging` and `production`.
- [ ] Branch protection on the release branch and the `production` environment rules.
- [ ] Server accounts with a login shell and every `authorized_keys` file, on both hosts.
- [ ] `/etc/sudoers` and `/etc/sudoers.d/` on both hosts.
- [ ] HQ staff accounts and their MFA.
- [ ] OAuth app owners and admins (Google, Microsoft).
- [ ] Vendor console users: Stripe, Twilio, Resend, Meta, Apple, Google, Microsoft, DNS registrar, hosting panels.
- [ ] `sudo ./check-host.sh --json` on production (login accounts, SSH settings).
- [ ] The asset inventory ([asset-inventory.md](asset-inventory.md)) is current.

Anything unexpected is removed the same day, or written up as an exception.

### Joiners, movers, leavers

- Joiner (contractor): signed agreement, then a GitHub collaborator invite with write access to
  work branches only, after 2FA is confirmed. No server, database, HQ or vendor-console access
  unless the task needs it and Kelvin records why. See [hr-security.md](hr-security.md).
- Mover: when a task changes, adjust access to match; remove what is no longer needed.
- Leaver: all access removed within 24 hours of the end of the engagement. Rotate any secret they
  could have seen ([docs/runbooks/rotate-secrets.md](../runbooks/rotate-secrets.md)).
- AI agents: a new session gets a worktree and a branch, nothing more. The cloud session's GitHub
  access is limited to this repository.

### Privileged access

- sudo: only named admin accounts (Kelvin). `fishtape-deploy` may run exactly one command with sudo:
  that environment's `update.sh` (`/etc/sudoers.d/fishtape-<env>-deploy`).
- HQ and BYPASSRLS: the `fishtape_hq` role is used only behind `/api/hq/` on `hq.fishtapehq.com`.
  Every HQ read of tenant data writes an audit event. HQ staff need TOTP. An IP allow-list for HQ is
  ready in the nginx config and should be turned on once staff addresses are fixed.
- Production database: direct `psql` (via `docker compose exec`) only for an incident or planned
  maintenance. Take a backup before any manual write. Record what was run and why in the incident
  record or the monthly change review.

### Break-glass

If Kelvin's normal access fails (lost SSH key, GitHub locked, deploy pipeline down):

1. Use the hosting provider's out-of-band console with credentials from the password manager.
2. Do only what the incident needs. Keep notes with UTC times.
3. Afterwards, rotate any credential that was used or exposed, and review the use within 2 business days.

If Kelvin is unavailable, the backup contact follows the sealed instructions in
[business-continuity.md](business-continuity.md). They have no standing access.

### Service accounts and deploy keys

- One `fishtape-deploy` user per host. Its key is limited by an `authorized_keys` forced command
  (`deploy-gate.sh`) to `deploy <sha>` (staging), `deploy <tag> <sha>` (production) or `status`.
- Deploy private keys exist only in GitHub environment secrets; the local copy is deleted after upload.
  Host keys are pinned (`STAGING_KNOWN_HOSTS`, `PRODUCTION_KNOWN_HOSTS`).
- Offsite-backup credentials can write backups and, where the provider allows it, can't delete them.
- Rotate deploy keys yearly and whenever someone who could have seen them leaves.

### API keys

- Tenant API keys (`ft_live_...`, `ft_test_...`) are created by tenant owners and admins, shown once,
  stored as sha-256 hashes, scoped (for example `jobs:read`, `invoices:write`), rate-limited per key,
  and revocable at any time. Every use that writes data is audited. AI agents use these keys too.
- Fishtape's own vendor keys (for example Stripe for subscriptions) live in the production `.env`
  and the password manager, with the narrowest scope the vendor offers (restricted keys where possible).

### Network boundary

On production, ufw allows only 22, 80 and 443 inbound. Every container port is bound to
`127.0.0.1` (Docker-published ports skip ufw, so `check-host.sh` checks this). nginx drops unknown
host names, rate-limits `/api/` and the sign-in routes, blocks the API docs UI, and serves HQ only
on `hq.fishtapehq.com`.

### Tenant and customer access inside the product

Tenants manage their own users: owners and admins invite, change roles and remove users, and
register or revoke shared-iPad crew devices. Fishtape enforces what tenants can't switch off: TOTP
MFA for owners and admins, rate limits and lockouts on every sign-in route, hashed session tokens,
short crew sessions tied to one device, and portal users limited to their own records. Fishtape
staff don't look at tenant data except through HQ, which is audited.

## Evidence

- `access-review-<date>.md` (completed) and `branch-protection.json` in the quarterly evidence bundle.
- `check-host-production.json`.
- GitHub settings pages: collaborators, environments, branch rules (screenshots when the API can't export them).
- HQ access audit events (once HQ ships).

## Exceptions

Through the process in [information-security.md](information-security.md#exceptions). Known
standing exception: the staging box is shared with other sites and uses the `ubuntu` account; it
never holds production data or secrets.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
