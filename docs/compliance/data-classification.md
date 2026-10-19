# Data classification policy

Four classes of data, with Fishtape examples and the handling rules for each.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | All data Fishtape creates, receives or stores, in every environment and on every device |
| Review cadence | Annually, and when a new kind of data is added |
| Last reviewed | 2026-10-19 |
| Related controls | DAT-01, DAT-02, DAT-03, DAT-04 |

## Purpose

Make it easy to decide how to store, share and delete a piece of data without thinking it through
from scratch each time.

## Scope

Data in the database, backups, logs, the repository, devices, vendor systems, email and chat. When
unsure, treat data as Confidential. When data of two classes is mixed, the higher class applies.

## Classes

| class | meaning | Fishtape examples |
| --- | --- | --- |
| Public | Meant to be seen by anyone | This repository (code, docs, policies), the marketing site, `/api/v1/status`, the OpenAPI document, CEC rule references (numbers only, never CSA text) |
| Internal | Not secret, but not published; minor harm if exposed | Roadmap and pricing drafts, vendor contracts, HQ health figures, logs with no personal information, aggregate usage numbers, access-review results, risk acceptance details |
| Confidential | Tenant and personal data; harm to tenants or people if exposed | Tenant job and client records, estimates, invoices, drawings and photos, price lists; customer (portal) names, addresses, phone numbers and emails; crew time entries, wages and PIN-protected identities; leads from Meta; `audit_events` (actions, IPs, user agents); application logs that contain personal information |
| Restricted | Exposure would compromise systems or many tenants at once | Secrets: `.env` files, `SECRETS_MASTER_KEY`, database passwords, age private keys, SSH and deploy keys, OAuth client secrets, tenant integration keys, session and API tokens; database backups and dumps; full-tenant exports; incident evidence and breach records |

Fishtape never stores full payment card numbers. Card data stays with Stripe.

## Handling rules

| | Public | Internal | Confidential | Restricted |
| --- | --- | --- | --- | --- |
| Storage | Anywhere | Company accounts and devices | Production database and backups, the tenant's devices, approved vendors; never in git, staging or local dev | Password manager, root-only files on the host, GitHub environment secrets, encrypted backups; never in git, email, chat or tickets |
| Sharing | Anyone | Kelvin, contractors who need it | The tenant it belongs to and its authorized users; approved vendors under contract; never between tenants | Only Kelvin, and only the system that needs it |
| In transit | Any | TLS | TLS | TLS, plus encryption of the data itself where possible (age for backups) |
| On devices | Any | Disk encryption | Disk encryption and a screen lock; tenant data only on tenant-authorized devices | Only in the password manager or an encrypted USB key |
| AI coding agents | Yes | Yes | No. Use seeded or synthetic data. Never paste tenant records into a prompt | Never |
| In-app AI features | Yes | Not applicable | Only the tenant's own data, sent with the tenant's own AI key, within the scope the tenant enabled | Never in a prompt or tool output |
| HQ console | Yes | Yes | Only through audited HQ reads, for support or an incident | Never shown in HQ |
| Logging | Yes | Yes | Only identifiers and what is needed to investigate (see [logging-monitoring.md](logging-monitoring.md)) | Never |
| Deletion | Not needed | When no longer useful | On the [retention schedule](backup-retention.md#data-retention-schedule); at tenant offboarding | Rotate on suspected exposure; destroy a backup key only after its backups have aged out |

## How it's done here

- Production data never goes to staging or local development. Staging uses seeded test tenants and
  TG Electrical demo data. Bugs are reproduced with synthetic data, not by copying records out of production.
- Tenant isolation is enforced by Postgres row-level security, not by convention.
- The repository is public, so it may only hold Public data. Push protection and gitleaks block
  secrets; review blocks everything else.
- Exports of tenant data (offboarding, access requests) are Restricted while in transit: deliver
  through an expiring link or an encrypted file, and delete Fishtape's copy afterwards.
- Disposal of devices and disks: see [asset-inventory.md](asset-inventory.md#disposal).

## Evidence

- The retention schedule and the offboarding runbook records.
- `check-host-production.json` (`.env` permissions).
- Security scanning results showing no secrets in git (`security-alerts.json`, gitleaks job).

## Exceptions

Through [information-security.md](information-security.md#exceptions). There is no exception for
copying production data to staging or local development. If realistic data is needed, generate
synthetic data, or anonymize it inside production before anything leaves.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
