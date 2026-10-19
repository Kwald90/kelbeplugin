# Compliance

This folder holds Fishtape's security and privacy policies. Fishtape follows SOC 2-aligned controls
(the AICPA Trust Services Criteria) without a formal audit. The idea is simple: write down what we
do, do it on a schedule, and keep proof that it was done.

Fishtape is a one-person company. Kelvin Waldner owns every policy and does most of the work.
Contractors and AI coding agents follow the same rules with less access. Where a control normally
needs more than one person (segregation of duties, a security team, background checks), the policy
says so and describes the compensating control.

## Policies

| file | purpose | owner | review cadence |
| --- | --- | --- | --- |
| [information-security.md](information-security.md) | Umbrella policy: scope, roles, principles, exceptions, enforcement | Kelvin Waldner | Annually |
| [access-control.md](access-control.md) | Who can reach what, MFA, quarterly access reviews, privileged and break-glass access | Kelvin Waldner | Annually |
| [change-management.md](change-management.md) | How code and config reach staging and production; solo-developer compensating controls | Kelvin Waldner | Annually |
| [incident-response.md](incident-response.md) | Severities, roles, phases, evidence, notification, post-incident review | Kelvin Waldner | Annually and after every SEV1/SEV2 |
| [business-continuity.md](business-continuity.md) | Critical services, RPO/RTO, disaster scenarios, key-person risk, DR testing | Kelvin Waldner | Annually |
| [backup-retention.md](backup-retention.md) | Backups, encryption, offsite copies, restore tests, data retention schedule | Kelvin Waldner | Annually |
| [encryption.md](encryption.md) | Encryption in transit and at rest, key management | Kelvin Waldner | Annually |
| [vendor-management.md](vendor-management.md) | Vendor inventory, due diligence, shared responsibility for tenant keys | Kelvin Waldner | Annually |
| [risk-assessment.md](risk-assessment.md) | Risk method and the risk register | Kelvin Waldner | Annually and on major change |
| [data-classification.md](data-classification.md) | Four data classes and how to handle each | Kelvin Waldner | Annually |
| [privacy.md](privacy.md) | PIPEDA principles, provincial laws, breach notification, requests, CASL | Kelvin Waldner | Annually |
| [logging-monitoring.md](logging-monitoring.md) | What is logged, what must never be logged, alerts, review cadence | Kelvin Waldner | Annually |
| [asset-inventory.md](asset-inventory.md) | Devices, hosts, domains, accounts, repos, data stores, keys | Kelvin Waldner | Updated quarterly, reviewed annually |
| [hr-security.md](hr-security.md) | Contractors, AI agents as contributors, awareness training | Kelvin Waldner | Annually |
| [acceptable-use.md](acceptable-use.md) | Day-to-day rules for Kelvin, contractors and AI agents | Kelvin Waldner | Annually |

Every policy is also reviewed after a SEV1 or SEV2 incident and after a major change (new host,
new provider, new kind of data, entering Quebec).

Related material elsewhere: runbooks in [../runbooks/](../runbooks/), security docs in
[../security/](../security/), the vulnerability disclosure policy in [../../SECURITY.md](../../SECURITY.md).

## How policies map to controls

[compliance/controls.yaml](../../compliance/controls.yaml) is the controls register. Each control has an
id, the Trust Services Criteria it supports, how often it runs, where the evidence comes from, a
status (`implemented`, `partial` or `planned`) and links to the policy and scripts behind it.

Each policy lists its controls in the table at the top. Control ids use these prefixes:

| prefix | area | main criteria |
| --- | --- | --- |
| GOV | governance, policies, oversight | CC1-CC5 |
| RSK | risk assessment | CC3, CC9.1 |
| HRS | people: contractors, training | CC1.4, CC1.5 |
| ACC | access control | CC6.1-CC6.3 |
| CRY | encryption and keys | CC6.1, CC6.7 |
| AST | assets and devices | CC6.1, CC6.4 |
| CHG | change management | CC8.1 |
| SDL | secure development, processing integrity | CC6.8, CC7.1, CC8.1, PI1 |
| OPS | operations and monitoring | CC6.6, CC7.1, CC7.2, A1.1 |
| INC | incident response | CC7.3-CC7.5 |
| BCK | backup and continuity | A1.2, A1.3, CC9.1 |
| VND | vendors | CC9.2 |
| DAT | data classification and confidentiality | C1.1, C1.2 |
| PRV | privacy | P1-P8 |

When a control changes (new evidence, new status), update `controls.yaml` and the policy in the same commit.

## Evidence

Evidence is collected once a month, and before and after any audit-like review (for example a
customer security questionnaire):

    node compliance/evidence/collect.mjs

It writes `compliance/evidence/out/<YYYY-MM-DD>/`, which is gitignored. The bundle holds
`manifest.json`, `git-changes.json`, `ci-runs.json`, `branch-protection.json`, `security-alerts.json`,
`npm-audit-server.json`, `osv-scanner.json` (if installed), `deploy-log-<env>.jsonl`,
`backup-log-<env>.jsonl`, `last-backup-<env>.json`, `restore-tests-<env>.jsonl`,
`check-host-production.json` (if present), `controls-summary.json` and a pre-filled
`access-review-<date>.md` checklist.

After each run:

1. Add anything collected by hand (a completed access review, restore-test output run from your own
   computer, a DR drill write-up, a breach record, screenshots of GitHub settings).
2. Zip the folder and store it outside git in an encrypted place: a password manager attachment or a
   private, encrypted storage bucket. Name it `fishtape-evidence-<YYYY-MM-DD>.zip`.
3. Keep bundles for 3 years, then delete them.
4. Delete the unzipped folder from the working copy.

Evidence never goes into the repository. The repository is public.

## Compliance calendar

Monthly, every month (first week):

- Run the evidence collector and store the bundle.
- Review security alerts (Dependabot, code scanning, secret scanning, osv-scanner, npm audit) against
  the fix deadlines in [docs/security/vulnerability-management.md](../security/vulnerability-management.md).
- Self-review the deploy log and merged changes ([change-management.md](change-management.md)).
- Review auth failures, lockouts and HQ access audit events once the API is live ([logging-monitoring.md](logging-monitoring.md)).
- Check open exceptions and risk acceptances for expiry ([risk-assessment.md](risk-assessment.md)).

Weekly: glance at the HQ developer health page (until HQ ships: `last-backup.json` and `host-status.json`).

| month | quarterly | annual |
| --- | --- | --- |
| January | Access review, restore test (staging and production), asset inventory update | |
| February | | Security awareness self-training ([hr-security.md](hr-security.md)) |
| March | | Tabletop incident exercise ([incident-response.md](incident-response.md)) |
| April | Access review, restore test, asset inventory update | |
| May | | DR rebuild drill on a fresh VPS ([business-continuity.md](business-continuity.md)) |
| June | | Vendor review ([vendor-management.md](vendor-management.md)) |
| July | Access review, restore test, asset inventory update | |
| August | | Independent security test or ASVS self-assessment ([docs/security/pentest-checklist-asvs.md](../security/pentest-checklist-asvs.md)) |
| September | | Risk assessment ([risk-assessment.md](risk-assessment.md)) |
| October | Access review, restore test, asset inventory update | Policy review (all policies), privacy review |
| November | | Secret rotation per [docs/runbooks/rotate-secrets.md](../runbooks/rotate-secrets.md) |
| December | | Plan next year: carry over open findings, confirm the calendar |

The first quarterly access review and restore test are due in October 2026.

## Recording a policy review

Each policy ends with a "Review log" table. To record a review:

1. Read the policy against what is actually done today. Fix anything that drifted, in the policy or in practice.
2. Add a row to the review log: date, reviewer, result (`no change` or `updated`), and a short note.
3. Change "Last reviewed" in the table at the top of the policy.
4. Update `compliance/controls.yaml` if a control's status, evidence or frequency changed.
5. Commit with a message like `compliance: annual review of access-control policy`. The commit is the evidence.

The first rows (2026-10-19) record the first version, drafted with an AI agent. A policy is adopted
when Kelvin has read it and merged it.

## What not to put in this folder

The repository is public. Policies and the controls register can be read by anyone, which is fine:
customers may ask for them. Never put these here: secret values, unpatched vulnerability details,
incident details, access-review results, personal information, the physical location of key copies,
or evidence bundles. Those go in the encrypted evidence store, or in a private GitHub security
advisory for vulnerabilities.
