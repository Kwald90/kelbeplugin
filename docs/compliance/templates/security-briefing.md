# Security briefing (onboarding outline)

A one-page outline for the ~30-minute briefing a new contractor gets before or at the start of an
engagement, per [hr-security.md](../hr-security.md#onboarding) (control HRS-01). Walk through each
point, answer questions, and record the date and who attended in the next access review (see
[hr-security.md](../hr-security.md#evidence)). Nothing here is a secret.

**Contractor:** {{CONTRACTOR_NAME}} · **Date:** {{BRIEFING_DATE}} · **Given by:** Kelvin Waldner

## 1. What Fishtape is and the data we hold

- Multi-tenant SaaS for Canadian electrical contractors. Each tenant's data is theirs and is kept
  apart from every other tenant's.
- Data classes and how to handle them: [data-classification.md](../data-classification.md).
- The rule that matters most: **no production or customer data anywhere outside production.** Use
  seeded or synthetic data for all development and testing.

## 2. Phishing and account takeover

- Be suspicious of any unexpected request for a code, a payment, access or urgent action. Confirm
  through a second channel before acting.
- MFA is required on your GitHub account and every other account you get for this work. Use a
  hardware key or passkey where offered — they stop most credential phishing.
- Never share a login or an MFA device. Report a lost or stolen device right away.

## 3. Handling secrets

- **Never commit `.env` files, `SECRETS_MASTER_KEY`, keys, tokens or passwords.** They do not belong
  in git, chat, email, tickets, screenshots or AI prompts.
- Use the password manager for every password, one unique generated password per site.
- If you think a credential was exposed, say so at once. Rotating a key that turns out to be safe
  costs little (see [rotate-secrets.md](../../runbooks/rotate-secrets.md)).
- Push protection, gitleaks and the committed-files check are there to catch mistakes — don't
  disable or bypass them.

## 4. Branch and pull-request workflow

- You work as a GitHub collaborator in **your own branch**. All changes go in as **pull requests**.
- Kelvin reviews every change and it must pass CI before merge. No hand edits on servers.
- **No production access, no production secrets, no SSH keys, no HQ or vendor consoles.** Staging
  access only if your task needs it, with the reason recorded. Details:
  [acceptable-use.md](../acceptable-use.md#code-and-systems).

## 5. Device requirements

Any device used for Fishtape work must have (see
[acceptable-use.md](../acceptable-use.md#devices)):

- full-disk encryption,
- an automatic screen lock, and lock it when you walk away,
- current operating-system and app updates, and malware protection,
- no software from untrusted sources on a device used for Fishtape administration.

## 6. Reporting a problem

- Report anything that might be a security or privacy problem to Kelvin right away: a suspected
  phishing message, a lost device, a secret in the wrong place, data in the wrong tenant, odd system
  behaviour. **No blame for reporting.**
- The intake path and what counts as in scope: [SECURITY.md](../../../SECURITY.md). Incident
  handling: [incident-response.md](../incident-response.md).

## Acknowledgement

The contractor confirms they have received this briefing and read the
[acceptable-use policy](../acceptable-use.md).

- Contractor: ____________________  Date: ____________
