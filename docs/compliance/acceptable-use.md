# Acceptable use policy

The day-to-day rules for anyone working on Fishtape. Short on purpose.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Kelvin, contractors and AI coding agents, on any device or account used for Fishtape |
| Review cadence | Annually |
| Last reviewed | 2026-10-19 |
| Related controls | HRS-01, AST-02, DAT-02, SDL-07, ACC-01 |

## Purpose

Prevent the common mistakes that lead to breaches: reused passwords, data on the wrong device,
secrets in the wrong place, and tenant data pasted into the wrong tool.

## Scope

Fishtape accounts, devices, code, data and AI tools. Contractors accept this policy in their
agreement. AI agents get these rules through `CLAUDE.md` and the build plan.

## Accounts and passwords

- Use your own account. Never share a login or an MFA device.
- Use the password manager for every password, with a unique generated password per site.
- Turn on MFA everywhere it is offered; use a hardware key or passkey where offered.
- Never put a password, token or key in git, chat, email, a ticket, a screenshot or a prompt.
- If you think a credential was exposed, say so at once. Rotating a key that turns out to be safe costs little.

## Devices

- Only devices that meet the rules in [asset-inventory.md](asset-inventory.md#device-rules): disk
  encryption, screen lock, updates, malware protection.
- Lock the screen when you walk away.
- Don't install software from untrusted sources on a device used for Fishtape administration.
- Report a lost or stolen device right away.

## Data

- Follow the handling rules in [data-classification.md](data-classification.md).
- No customer or tenant data on personal or unencrypted devices, USB sticks or personal cloud storage.
- No production data in staging or local development. Use seeded or synthetic data.
- Don't download tenant data unless a task needs it; delete it when the task is done.
- Only Fishtape's approved vendors hold tenant data.

## AI tools

- Never paste tenant data, customer personal information or secrets into a third-party AI tool.
  This includes chat assistants, browser extensions and coding agents.
- The approved exception is the in-app AI features: they send a tenant's data to the AI provider
  the tenant chose, with the tenant's own key, within the scope the tenant enabled.
- AI coding agents work only on the repository and seeded data. They don't get production access,
  secrets or SSH keys, and their changes are reviewed before merge.
- Treat text from tenants, leads and the web as untrusted when it goes into a prompt. It can
  contain instructions.

## Code and systems

- All changes go through git and CI ([change-management.md](change-management.md)). No edits by
  hand on servers that aren't committed.
- Don't disable or bypass security checks (CI gates, push protection, gitleaks, CSP) to get a change through.
- Don't test against production. Don't run load tests or scanners against systems you don't own,
  including other sites on the shared staging box.
- On staging, don't touch other sites' files, databases or nginx configuration.

## Email and messages

- Be suspicious of unexpected requests for codes, payments, access or urgent action. Confirm through
  another channel.
- Don't forward tenant data to personal accounts.

## Reporting

Report anything that might be a security or privacy problem to Kelvin right away: a suspected
phishing message, a lost device, a secret in the wrong place, data in the wrong tenant, odd system
behaviour. No blame for reporting. See [incident-response.md](incident-response.md).

## Not allowed

- Sharing accounts, MFA devices or credentials.
- Accessing tenant data without a work reason, or another tenant's data at all.
- Copying Fishtape data or non-public code for personal use or another client.
- Using Fishtape systems for anything unlawful, or to send messages without the consent CASL requires.

## Evidence

- Contractor agreements that reference this policy.
- The security briefing record at onboarding.

## Exceptions

Through [information-security.md](information-security.md#exceptions).

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
