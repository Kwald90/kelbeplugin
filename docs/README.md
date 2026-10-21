# Fishtape docs

Start with the [build plan](BUILD-PLAN.md) (decisions, the 13 layers, contracts, who owns
what) and the [backlog](BACKLOG.md) (what's open, and what needs Kelvin).

| folder | what's in it | start with |
| --- | --- | --- |
| [architecture/](architecture/) | how the system fits together | [13 layers](architecture/13-layers.md) |
| [code/](code/) | Canadian Electrical Code research, provincial adoption, sales tax | [code README](code/README.md) |
| [field/](field/) | how the field tools work and the rules behind them | [wire runs](field/wire-runs.md) |
| [ai/](ai/) | the assistant, CEC helper, background agents and MCP server | [AI README](ai/README.md) |
| [integrations/](integrations/) | contracts for third-party integrations | [QuickBooks Online two-way sync](integrations/quickbooks.md) |
| [mobile/](mobile/) | the iOS app: build, signing, App Store | [mobile README](mobile/README.md) |
| [security/](security/) | threat model, CSP, secrets, vulnerability handling | [security README](security/README.md) |
| [compliance/](compliance/) | SOC 2-aligned policies (no formal audit) | [compliance README](compliance/README.md) |
| [runbooks/](runbooks/) | step-by-step operations | [runbooks README](runbooks/README.md) |

## Releases

- [Release 1 "Get paid and know the margin": the build contract](releases/r1-get-paid.md) (RST fixes,
  signed tickets, deposits, collections, offsite backups, job costing, prompt payment, period lock) ·
  [Gap analysis 2026-10](releases/gap-analysis-2026-10.md)

## Architecture

- [13 layers](architecture/13-layers.md): each layer's goal, what's built, what's next
- [Environments](architecture/environments.md): local, staging, production
- [API](architecture/api.md) · [Data model](architecture/data-model.md)
- Decisions: [ADR 001 own API + Postgres RLS](architecture/adr-001-own-api-postgres-rls.md) ·
  [ADR 002 sync protocol](architecture/adr-002-sync-protocol.md) ·
  [ADR 003 auth and sessions](architecture/adr-003-auth-sessions.md)

## Canadian Electrical Code and tax

- [Code book overview](code/README.md) · [Provincial adoption](code/adoption.md) ·
  [Sales tax by province](code/tax.md) · [Values still to verify](code/verify.md)

## Field tools

- [Pipe bending](field/bending.md) · [Box placement and CEC checks](field/box-placement.md) ·
  [Wire runs](field/wire-runs.md)

## AI

- [How the AI works](ai/README.md) · [Connecting an agent over MCP](ai/mcp.md)

## Integration setup guides (shown inside the app)

[Stripe](../electrical-app/guides/stripe.md) · [Resend](../electrical-app/guides/resend.md) ·
[Twilio](../electrical-app/guides/twilio.md) · [Facebook Lead Ads](../electrical-app/guides/facebook.md) ·
[Anthropic](../electrical-app/guides/anthropic.md) · QuickBooks (`electrical-app/guides/quickbooks.md`,
with the QuickBooks screens)

QuickBooks Online sync: [the contract](integrations/quickbooks.md) ·
[support runbook](runbooks/quickbooks-support.md) · [threat model TM-QBO](security/threat-model.md#quickbooks-online-sync-tm-qbo)

## Security

- [Overview](security/README.md) · [Threat model](security/threat-model.md) ·
  [Headers and CSP](security/headers-csp.md) · [Secrets](security/secrets-management.md) ·
  [Secure development](security/secure-sdlc.md) · [Vulnerabilities](security/vulnerability-management.md) ·
  [Pen-test checklist (ASVS L2)](security/pentest-checklist-asvs.md)
- Disclosure policy: [SECURITY.md](../SECURITY.md)

## Compliance (SOC 2-aligned)

Policies: [information security](compliance/information-security.md) ·
[access control](compliance/access-control.md) · [change management](compliance/change-management.md) ·
[incident response](compliance/incident-response.md) · [business continuity](compliance/business-continuity.md) ·
[backup and retention](compliance/backup-retention.md) · [encryption](compliance/encryption.md) ·
[vendors](compliance/vendor-management.md) · [risk](compliance/risk-assessment.md) ·
[data classification](compliance/data-classification.md) · [privacy](compliance/privacy.md) ·
[logging and monitoring](compliance/logging-monitoring.md) · [assets](compliance/asset-inventory.md) ·
[people](compliance/hr-security.md) · [acceptable use](compliance/acceptable-use.md)

Controls mapped to the Trust Services Criteria: [`compliance/controls.yaml`](../compliance/controls.yaml)
(also shown in HQ → Compliance). Evidence collector: `compliance/evidence/collect.mjs`.

## Runbooks

[Deploy staging](runbooks/deploy-staging.md) · [Deploy production](runbooks/deploy-production.md) ·
[Roll back](runbooks/rollback.md) · [Restore from backup](runbooks/restore-from-backup.md) ·
[Incident response](runbooks/incident-response.md) · [Rotate secrets](runbooks/rotate-secrets.md) ·
[Onboard a company](runbooks/onboard-tenant.md) · [Offboard a company](runbooks/offboard-tenant.md) ·
[On call](runbooks/on-call.md) · [QuickBooks support](runbooks/quickbooks-support.md)

## Elsewhere in the repo

- [App (PWA)](../electrical-app/README.md) · [Server](../server/README.md)
- Deploy kits: [staging](../deploy/staging/README.md) · [production](../deploy/production/README.md)
