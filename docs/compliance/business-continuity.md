# Business continuity and disaster recovery policy

How Fishtape keeps going, or gets back, when a host, a provider, the data or Kelvin is lost.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Production and staging, the services they depend on, and the people who run them |
| Review cadence | Annually, after a SEV1, and after each DR drill |
| Last reviewed | 2026-10-19 |
| Related controls | BCK-02, BCK-04, BCK-05, BCK-06, BCK-07, OPS-01, RSK-01 |

## Purpose

Set recovery targets, list what Fishtape depends on, plan for the likely disasters, and prove the
plan works by testing it.

## Scope

The production service (`app.`, `hq.`, `status.fishtapehq.com`), staging, the code repository,
DNS, keys and secrets, and the key person.

## Recovery targets

| environment | RPO (data that can be lost) | RTO (time to restore service) |
| --- | --- | --- |
| Production | 24 hours (nightly encrypted dump). 15 minutes once WAL archiving is added (planned). | 8 hours (rebuild a host from the checklist and restore) |
| Staging | 24 hours | 2 business days |

Pre-deploy backups mean a bad release can usually be undone with far less loss than the RPO.

The PWA is offline-first. Field tools (time clock, drawings, calculators, bending, wire runs, today's
jobs) keep working on devices during an outage, and queued changes sync when the API is back.
Office tools need a connection.

## Critical services and dependencies

| service or dependency | why it matters | criticality |
| --- | --- | --- |
| Production host (dotmoose VPS) | Runs the API, worker, Postgres and nginx | Critical |
| PostgreSQL data and its backups | All tenant data | Critical |
| DNS for `fishtapehq.com` and the registrar account | Every name resolves through it | Critical |
| Kelvin | Only operator; only person with production access | Critical |
| Password manager | Holds keys needed to restore (backup keys, `SECRETS_MASTER_KEY`) | Critical |
| TLS certificates (Let's Encrypt) | 90-day certificates, renewed at 30 days left; a short outage is survivable | Important |
| GitHub | Code, CI, deploy pipeline. Not needed to keep production running | Important |
| Offsite backup storage | Restores when the host is lost | Important |
| Kelvin's email and phone | Alerts and vendor recovery | Important |
| Stripe, Twilio, Resend, Meta | Tenant payments, SMS, email, leads (tenants' own accounts) | Important, per feature |
| Staging VPS | Testing only | Low |

## Scenarios

### Production host lost or unusable

1. Provision a new VPS (dotmoose or another provider in Canada).
2. Follow [deploy/production/README.md](../../deploy/production/README.md) from "Host prerequisites".
3. Restore the newest good backup from offsite ([docs/runbooks/restore-from-backup.md](../runbooks/restore-from-backup.md)).
4. Deploy the last release tag, point DNS at the new host, issue certificates, run `check-host.sh`.
5. Tell tenants what happened and what data, if any, was lost.

### Hosting provider outage or the provider stops serving us

dotmoose is a friend's hosting, so the risk includes the provider becoming unavailable for personal
reasons. Same steps as host loss, on another provider. Keep DNS TTLs short enough (for example 300
seconds on `app`, `hq`, `status`) to move quickly. Offsite backups must not sit with the same provider.

### Data corruption (bad migration, bug, mistaken bulk change)

1. Stop the damage: roll back the release, pause the worker if it is involved.
2. Restore the pre-deploy or nightly backup into a separate database, not over production.
3. Repair the affected records from it, by tenant, and record what was changed.
4. Restore over production only when repair isn't possible; anything after the backup is lost.

### Ransomware or host compromise

Treat as a SEV1 security incident ([incident-response.md](incident-response.md)). Backups are encrypted
to a public key, so an attacker on the host can't read them. They can delete local copies, which is
why the offsite copy must have provider-side retention or object lock. Rebuild on a clean host;
never restore onto the compromised one. Rotate every secret from the old host.

### Loss of Kelvin (key-person risk)

Fishtape depends on one person. Until there is a second operator:

- Sealed instructions, kept by the trusted backup contact: what Fishtape is, the hosts and vendors,
  how to post a status notice, who to call for technical help, how to give tenants their data and,
  if needed, wind down the service in an orderly way.
- Emergency access to the password manager for the trusted person (the manager's emergency-access
  feature, or its emergency kit in the sealed envelope), with a waiting period so Kelvin can refuse.
- The runbooks in [docs/runbooks/](../runbooks/) are written so a competent developer can follow them.
- Reviewed every year; status: planned until the trusted person is named and the envelope exists.

### GitHub lost or unavailable

Production keeps running. Local clones on Kelvin's PC and Mac hold the full history. In an outage,
deploy by hand from a local clone (an emergency change). If the account is lost, recreate the
repository from a clone, recreate environment secrets with new deploy keys, and update the remote on
the hosts. Keep at least one clone up to date every week.

### DNS or registrar account lost

Registrar lock and auto-renew on, MFA on the registrar account, and a recovery email that is not on
the same domain. Keep a copy of the DNS zone (records, TTLs, CAA) in the evidence bundle each quarter
so it can be rebuilt at another DNS provider.

## Testing

| test | when | how | evidence |
| --- | --- | --- | --- |
| Restore test | Quarterly, staging and production | `restore-test.sh` with the offline key | `restore-tests-<env>.jsonl` |
| DR rebuild drill | Annually (May) | Build a fresh VPS from the production README, restore the latest backup, deploy the current tag, run smoke checks; time it against the 8-hour RTO; destroy the VPS afterwards | `dr-drill-<date>.md` in the evidence bundle: start and end times, steps that were wrong, fixes made |
| Tabletop | Annually (March) | See [incident-response.md](incident-response.md#testing) | Tabletop write-up |

Fix any step the drill shows is wrong in the README or runbook in the same week.

## Evidence

- `restore-tests-<env>.jsonl`, `last-backup-<env>.json`, `backup-log-<env>.jsonl`.
- DR drill write-ups.
- A note in the evidence bundle confirming the sealed instructions were reviewed (annually).

## Exceptions

RPO of 24 hours (no WAL archiving) is accepted while Fishtape is pre-revenue; see the risk register.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
