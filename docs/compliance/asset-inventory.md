# Asset inventory

The devices, hosts, domains, accounts, repositories, data stores and keys that Fishtape runs on, and
the rules for the devices.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Every asset that stores, processes or gives access to Fishtape code or data |
| Review cadence | Updated quarterly with the access review (January, April, July, October) and whenever an asset is added or retired; policy reviewed annually |
| Last reviewed | 2026-10-19 |
| Related controls | AST-01, AST-02, DAT-03 |

## Purpose

You can't protect what you don't know you have. This list is also what someone else would need to
take over in an emergency.

## Scope

Hardware, servers, domains, vendor accounts, repositories, data stores, keys and certificates.
Serial numbers, the physical location of key copies and anything else sensitive are kept in the
password manager, not here (this repository is public).

## Hardware

| asset | owner | used for | data class | notes |
| --- | --- | --- | --- | --- |
| Development PC (Windows 11) | Kelvin | Development, administration, evidence collection | Restricted (SSH keys, password manager session) | BitLocker: to confirm. Microsoft Defender on. |
| Mac | Kelvin | iOS builds over SSH, Apple signing | Restricted (signing certificates) | FileVault: to confirm. |
| iPads | Kelvin / TG Electrical | Field use of the PWA and iOS app, shared crew mode | Confidential (offline tenant data) | Passcode required. Registered as crew devices when shared. |
| Phone | Kelvin | MFA authenticator, alerts, on-call | Restricted (MFA) | Passcode and biometric lock. |
| Hardware security keys | Kelvin | MFA for GitHub, email, password manager | Restricted | None recorded yet. Recommended: two keys, one kept apart as a backup. |
| Encrypted USB key(s) | Kelvin | Offline copies of age backup keys and `SECRETS_MASTER_KEY` | Restricted | Location recorded in the password manager. |

## Servers and hosts

| host | provider | role | details | data class |
| --- | --- | --- | --- | --- |
| Staging VPS | DreamHost | `tgelectrical.truecollarbuilt.com` | 208.113.210.97, Ubuntu 24.04, CloudPanel nginx, Docker 29; shared with unrelated sites | Internal (test data only) |
| Production VPS | dotmoose | `app.`, `hq.`, `status.fishtapehq.com` | OS, sizing and data-centre location to confirm; layout `/srv/fishtape/` | Restricted |

## Domains and DNS

| domain | registrar | DNS host | used for |
| --- | --- | --- | --- |
| `fishtapehq.com` | To confirm | To confirm | Production names; CAA allows only Let's Encrypt |
| `fishtapehq.ca` | Planned | | Redirect |
| `truecollarbuilt.com` | To confirm | To confirm | Staging subdomain `tgelectrical.` |

## Vendor and cloud accounts

See [vendor-management.md](vendor-management.md) for the full list and the data each one sees.
Accounts held: GitHub (`Kwald90`), the password manager, Kelvin's email, DNS registrar, DreamHost,
dotmoose, Stripe, Twilio, Resend, Meta for Developers, Apple Developer, Google Cloud (OAuth client),
Microsoft Entra (app registration), Anthropic, and when chosen: uptime monitor and offsite storage.

## Code repositories

| repository | where | notes |
| --- | --- | --- |
| `Kwald90/kelbeplugin` | GitHub, public | Default branch `main` is the old WordPress plugin. Fishtape lives on `claude/electrical-concept-app-h4qz12` (the release branch). |
| Local clones | Kelvin's PC (plus worktrees for AI agents) and Mac | Full history; kept up to date weekly as a continuity copy. |

## Data stores

| store | where | data class | backed up |
| --- | --- | --- | --- |
| Postgres, staging | Docker volume `fishtape-staging_pgdata` | Internal | Nightly, `/var/backups/fishtape-staging/` |
| Postgres, production | Docker volume in project `fishtape-production` | Restricted | Nightly and pre-deploy, `/var/backups/fishtape-production/` and offsite |
| Offsite backup storage | To be chosen, in Canada | Restricted (encrypted) | Provider retention |
| Browser storage (IndexedDB) | Tenant devices | Confidential | Synced to the server |
| Evidence store | Password manager attachment or encrypted bucket | Internal to Restricted | Its own redundancy |
| Password manager | Vendor | Restricted | Vendor; emergency kit sealed |

## Keys and certificates

The full list, with custodian and rotation, is the key management table in
[encryption.md](encryption.md#key-management). Certificates: the Let's Encrypt certificate `fishtape`
on production (three names), the staging certificate for `tgelectrical.truecollarbuilt.com`, and
Apple signing certificates on the Mac.

## Device rules

These apply to any device used for Fishtape work, including contractors' devices.

- Full-disk encryption on (BitLocker, FileVault, iOS and Android passcode encryption).
- Screen lock after 5 minutes or less, with a passcode, PIN or biometric.
- Supported operating system; security updates installed within 14 days, critical ones within 7.
- Built-in malware protection on (Microsoft Defender on Windows, XProtect on macOS).
- Credentials only in the password manager. SSH keys passphrase-protected.
- No jailbroken or rooted devices.
- No tenant data on a personal device that doesn't meet these rules.
- Lost or stolen device: report to Kelvin at once. Revoke its sessions and device tokens, rotate any
  key it held, and treat it as a possible incident.

MDM is not required yet. Revisit when there are employees or more than a handful of company iPads.

## Disposal

- Devices: sign out of every account, remove the device from Apple/Google/Microsoft accounts and
  from Fishtape's crew devices, then erase it (factory reset with encryption on is enough for
  modern encrypted devices). Record the date and method here.
- Disks and servers: when a VPS is cancelled, destroy its volumes and snapshots and get the
  provider's confirmation. Retire the host's keys and remove its DNS records.
- Paper (sealed instructions, printed recovery codes): shred when replaced.

## How it's kept current

Updated during each quarterly access review and whenever an asset is added or retired. The git
history of this file is the record of changes.

## Evidence

- Git history of this file; the quarterly `access-review-<date>.md`.
- Disposal records (date, asset, method) in the table notes or the evidence bundle.

## Exceptions

Through [information-security.md](information-security.md#exceptions).

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. Several entries marked "to confirm". |
