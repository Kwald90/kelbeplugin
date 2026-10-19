# Incident response policy

What counts as an incident, how fast Fishtape responds, who does what, and what must be recorded
and reported. The hands-on steps are in [docs/runbooks/incident-response.md](../runbooks/incident-response.md).

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Security, availability and privacy incidents affecting Fishtape systems, data or vendors |
| Review cadence | Annually, and after every SEV1 or SEV2 |
| Last reviewed | 2026-10-19 |
| Related controls | INC-01 to INC-04, PRV-05, OPS-03 |

## Purpose

Limit harm, restore service, meet legal notice duties, and learn from each incident.

## Scope

An incident is any event that harms, or could harm, the confidentiality, integrity or availability
of Fishtape or its data. Examples: an outage, a leaked secret, a cross-tenant data exposure, a
compromised account or host, a lost device with tenant data, a vendor breach that touches our data,
a vulnerability being exploited.

## Severities

| severity | meaning | response | updates |
| --- | --- | --- | --- |
| SEV1 | Production down for all tenants, or a confirmed or likely data breach or cross-tenant exposure | Immediately, 24/7 | Every hour |
| SEV2 | Major feature down or degraded for many tenants, a suspected breach, or an active exploitation attempt | Within 1 hour during waking hours, 4 hours overnight | When status changes |
| SEV3 | Partial degradation, one tenant affected, a workaround exists | Next business day | When status changes |
| SEV4 | Minor issue | Backlog | None |

When unsure, pick the higher severity. Severity can be lowered later.

## Roles

| role | who |
| --- | --- |
| Incident commander | Kelvin Waldner. Decides, acts, communicates, keeps the timeline. |
| Backup contact | A trusted person, to be named. If Kelvin can't be reached during a SEV1 for more than 24 hours, follows the sealed instructions: posts the status notice, contacts the hosting provider, and calls in outside help. |
| Outside help (arrange ahead) | A developer or security firm who can be engaged quickly, and privacy counsel for breach decisions. To be arranged. |
| Vendors | GitHub, hosting providers, Stripe and others, when their systems or our credentials with them are involved. |

## Phases

1. Detect and report. Sources: uptime alerts, the backup heartbeat, HQ health, GitHub security
   alerts, reports through [SECURITY.md](../../SECURITY.md), tenants, vendors. Anyone (contractor,
   tenant, agent output) who sees a possible incident tells Kelvin right away.
2. Triage. Decide whether it is an incident, assign a severity, open an incident record (below).
3. Contain. Stop the harm: revoke sessions or keys, block an IP, take a feature offline, put a
   host behind the firewall, rotate a secret. Prefer reversible steps.
4. Eradicate. Remove the cause: patch, remove the attacker's access, fix the bug.
5. Recover. Restore service and data (rollback, restore from backup) and watch closely afterwards.
6. Notify. Tenants, regulators and individuals as required ([privacy.md](privacy.md#breaches)).
7. Review. Post-incident review within 5 business days.

## Evidence preservation

Before changing a compromised system, if it can be done without adding harm:

- Take a provider snapshot of the host.
- Copy logs off the host: nginx, `docker compose logs`, the system journal and `auth.log`, the
  deploy, backup and restore logs, and an export of relevant `audit_events`.
- Record sha-256 hashes of the copies. Store everything in the encrypted evidence store, not in git.
- Keep a timeline in UTC: what was seen, what was done, by whom.

Don't power off a host unless that is the only way to stop the harm; memory and running state are lost.

## Communications

- Tenants: affected tenants hear from Fishtape as soon as the impact is understood. For a breach of
  data Fishtape holds for tenants, the target is within 72 hours of confirming it, so tenants can
  meet their own duties. Updates follow the cadence in the severity table.
- Status: post on the status page or by email for SEV1 and SEV2.
- Regulators and individuals: decided with the breach steps in [privacy.md](privacy.md#breaches),
  which also covers keeping breach records.
- Vendors and law enforcement: when their systems are involved or a crime is suspected.
- Say what is known, what isn't, and when the next update comes. Don't guess at causes in public.

## Post-incident review

Within 5 business days of closing a SEV1 or SEV2 (SEV3 when useful), write a short, blameless
review: summary, timeline, impact (tenants, records, duration), root cause, what went well, what
didn't, and actions with owners and dates. Store it in the encrypted evidence store. Track the
actions to closure. Update policies, runbooks and `controls.yaml` if they were wrong.

## Testing

An annual tabletop exercise (March): walk through one scenario with the runbook, for example a
leaked deploy key or a cross-tenant exposure, including who is notified and when. Record what was
learned as you would for a real incident.

## Evidence

- Incident records and post-incident reviews (encrypted evidence store).
- Breach records ([privacy.md](privacy.md#breach-record)).
- Tabletop write-ups.
- Changes to runbooks and policies that followed.

## Exceptions

None. If a step can't be followed during an incident, say so in the incident record.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
