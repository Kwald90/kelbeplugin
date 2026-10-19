# Information security policy

This is the umbrella policy. It sets the scope, the roles and the principles that every other policy
in this folder builds on.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Kelvin, contractors, AI coding agents, and every Fishtape system and environment |
| Review cadence | Annually, and after a SEV1/SEV2 incident or a major change |
| Last reviewed | 2026-10-19 |
| Related controls | GOV-01, GOV-02, GOV-03, GOV-04, GOV-05, RSK-01, HRS-01 |

## Purpose

Protect the data that electrical contractors (tenants) and their customers trust Fishtape with, keep
the service available, and be able to show how. Fishtape follows SOC 2-aligned controls; it does not
claim a certification or an audit.

## Scope

- The Fishtape service: the PWA, the iOS app, the API and worker, PostgreSQL, the HQ console, and the
  status endpoint.
- Environments: local development, staging (`tgelectrical.truecollarbuilt.com`) and production
  (`app.`, `hq.` and `status.fishtapehq.com`).
- The GitHub repository `Kwald90/kelbeplugin`, its CI/CD workflows and secrets.
- Vendor accounts that run or support the service ([vendor-management.md](vendor-management.md)).
- Devices used to build or operate Fishtape ([asset-inventory.md](asset-inventory.md)).
- All data Fishtape holds, by class ([data-classification.md](data-classification.md)).

Out of scope: the old WordPress plugin on branch `main`, and tenants' own accounts with Stripe,
Twilio, Resend, Meta or Anthropic (see the shared responsibility table in
[vendor-management.md](vendor-management.md)).

## Roles

| role | who | responsibilities |
| --- | --- | --- |
| Owner, security officer, privacy officer | Kelvin Waldner | Owns every policy and control. Approves every production change. Incident commander. Runs the reviews in the [calendar](README.md#compliance-calendar). |
| Backup contact | To be named (a trusted person) | Follows the sealed instructions if Kelvin can't be reached during a serious incident or for an extended time. No standing access to systems. See [business-continuity.md](business-continuity.md). |
| Contractors | Engaged per task | Work in their own branch, through pull requests. Least-privilege access, removed within 24 hours of the end of the engagement. See [hr-security.md](hr-security.md). |
| AI coding agents | Claude Code sessions, local and one cloud session | Work in git worktrees and branches. Never get production secrets, SSH keys or GitHub admin. Kelvin reviews and deploys their changes. Commits carry a `Co-Authored-By: Claude ...` trailer. |
| In-app AI agents | Background agents and the agent API, per tenant | Act with scoped API keys under the tenant's own AI provider key. Every write is audited. Treated as system actors, not people. |
| Tenants | Each electrical company | Manage their own users, roles, integration keys and their customers' requests. |

There is no board and no separate security team. Kelvin is the only person who can approve a
production deploy, change GitHub settings or reach production hosts. The compensating controls for
that are in [change-management.md](change-management.md) (CHG-07) and in GOV-02.

## Principles

1. Least privilege. Every account, key and role gets only what it needs, and loses it when the need ends.
2. MFA everywhere it is offered, hardware keys where possible ([access-control.md](access-control.md)).
3. Every change goes through git and CI. Production only from a `v*` tag with Kelvin's approval.
4. Tenant data never crosses tenants. Postgres row-level security is enforced (ENABLE and FORCE) on every tenant table.
5. Production data stays in production. Staging and local development use seeded or synthetic data only.
6. Encrypt in transit and at rest; keep keys offline where possible ([encryption.md](encryption.md)).
7. Log what matters, never log secrets, and keep evidence ([logging-monitoring.md](logging-monitoring.md)).
8. Plan for failure, including the loss of Kelvin ([business-continuity.md](business-continuity.md)).
9. Prefer well-known, maintained tools over clever ones. No home-made cryptography.
10. Say what is planned as planned. Don't claim a control that isn't operating.

## Policy set

All policies are listed in [README.md](README.md). Each one names an owner, a review cadence and its
controls in `compliance/controls.yaml`. Policies are published in this repository so contractors,
agents and customers can read them.

## Exceptions

Sometimes a rule can't be followed. An exception is allowed only when it is written down first
(or, in an emergency, within 2 business days):

1. What rule, which system, and why.
2. The risk, and the compensating control while the exception lasts.
3. An expiry date: no more than 90 days for a vulnerability fix deadline, no more than 12 months for anything else.
4. Kelvin's approval.

Exceptions and risk acceptances are recorded in the table in [risk-assessment.md](risk-assessment.md#exceptions-and-risk-acceptances)
(with sensitive details kept in the encrypted evidence store). Open exceptions are checked every month;
an expired exception is either renewed in writing or closed.

## Enforcement

- Contractors: breaking a policy can mean losing access immediately and ending the engagement.
  Deliberate misuse of data may be reported to the authorities.
- AI coding agents: a session that breaks a rule is stopped, its branch is not merged, and any
  exposed credential is rotated. The rule that was missed is added to `CLAUDE.md` or the build plan.
- Kelvin: there is nobody above Kelvin to enforce the rules. The deploy log, CI history, the monthly
  self-review and the evidence bundles make lapses visible, and the annual review records them.

## How it's done here

- Policies live in `docs/compliance/`, controls in `compliance/controls.yaml`, evidence in monthly
  bundles from `node compliance/evidence/collect.mjs`.
- Contributors learn the rules from `CLAUDE.md`, `docs/BUILD-PLAN.md`, the pull request template's
  security checklist and, for contractors, a short briefing at onboarding.
- Security reports from outside come in through [SECURITY.md](../../SECURITY.md).
- Findings from reviews, tests and incidents are tracked to closure: non-sensitive ones as GitHub
  issues, security-sensitive ones in a private security advisory or the encrypted evidence store.

## Evidence

- Git history of `docs/compliance/` and the review log in each policy (GOV-01).
- Monthly evidence bundles, including `controls-summary.json` (GOV-03).
- The exceptions table in the risk register (GOV-04).

## Exceptions to this policy

Handled by the exceptions process above.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
