# Risk assessment policy and risk register

How Fishtape finds, scores and treats risks, and the current risk register.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Security, availability, confidentiality, privacy, legal and key-person risks to Fishtape and its tenants |
| Review cadence | Annually (September), and on major change |
| Last reviewed | 2026-10-19 |
| Related controls | RSK-01, RSK-02, RSK-03, GOV-04, SDL-03 |

## Purpose

Spend limited time on the risks that matter most, and write down the ones that are accepted.

## Scope

Everything in scope of [information-security.md](information-security.md), plus the business risks
that come from being a one-person company.

## Method

Score each risk on likelihood and impact, 1 to 5, and multiply.

| score | likelihood | impact |
| --- | --- | --- |
| 1 | Rare: not expected in 5 years | Negligible: no tenant notices |
| 2 | Unlikely: could happen in 5 years | Minor: one tenant inconvenienced, no data exposed |
| 3 | Possible: could happen this year | Moderate: outage of hours, or limited data exposure that is contained |
| 4 | Likely: expected this year | Major: outage of a day or more, exposure of one tenant's data, a regulator notice |
| 5 | Almost certain | Severe: cross-tenant breach, data lost beyond the RPO, or the business can't continue |

Bands: 15 to 25 high (treat now, with a dated plan), 8 to 12 medium (treat within the year or accept
in writing), 1 to 6 low (accept and watch).

Treatment options:

- Mitigate: add or improve controls.
- Accept: write it down with a reason, Kelvin's approval and a review date (no more than 90 days for
  vulnerability fix deadlines, no more than 12 months otherwise).
- Transfer: contract terms or insurance (cyber insurance to be considered before paying customers).
- Avoid: stop doing the risky thing.

## When to assess

- Every September, the whole register is re-scored.
- On major change: a new host or provider, a new integration or kind of data, an architecture change
  (for example moving the database), entering Quebec, the first paying customer, a SEV1 or SEV2.
- New threats from the threat model ([docs/security/threat-model.md](../security/threat-model.md)) and
  vulnerability findings are added as they come.

## Risk register

Scores are likelihood x impact today, with the current controls. Descriptions stay at a level that
doesn't help an attacker; details live in the encrypted evidence store.

| id | risk | L | I | score | treatment | related controls |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Anyone who can push to the release branch can get root on the shared staging VPS through the deploy, which also hosts other sites. | 3 | 4 | 12 | Mitigate: GitHub MFA, branch protection requiring `ci-ok`, agents and contractors push to their own branches only, forced-command deploy key, root-owned checkout, no production data or secrets on staging. Consider a dedicated staging VPS. | ACC-03, ACC-05, CHG-01, CHG-07 |
| R-02 | Key person: Kelvin is unavailable and nobody can operate, recover or wind down the service. | 2 | 5 | 10 | Mitigate: sealed instructions, password-manager emergency access, a named trusted person, runbooks a developer can follow. | BCK-06, GOV-02 |
| R-03 | Production host location, disk encryption and staff access at dotmoose are unknown, and there is no written agreement. | 3 | 4 | 12 | Mitigate before production data: get answers and a written agreement; move to a Canadian provider if they can't be given. | VND-03, CRY-02 |
| R-04 | A bug in row-level security or a missing tenant context exposes one tenant's data to another. | 2 | 5 | 10 | Mitigate: ENABLE and FORCE RLS, one `withTenant` helper, isolation tests in CI, RLS check in every restore test, security review of data-access changes. | ACC-09, SDL-01 |
| R-05 | Theft or misuse of an HQ session gives cross-tenant read access through the BYPASSRLS role. | 2 | 5 | 10 | Mitigate: HQ only on its own host name, TOTP, every tenant-data read audited, monthly review of HQ access events, IP allow-list when practical, and running HQ in its own process. | ACC-07, OPS-04 |
| R-06 | Prompt injection in tenant data (a lead's message, a PDF) makes an AI feature or agent leak data or take an unwanted action. | 3 | 4 | 12 | Mitigate: agents act through scoped API keys, no secrets in prompts, human confirmation before sending messages or moving money, every action audited. | SDL-08 |
| R-07 | Tenant-supplied keys (Stripe, Twilio, Anthropic) leak from the database, logs or a backup. | 2 | 4 | 8 | Mitigate: envelope encryption, never logged, master key kept out of backups, backups encrypted. | CRY-03, VND-04, OPS-03 |
| R-08 | Supply-chain compromise through an npm package, a base image or a GitHub Action. | 3 | 4 | 12 | Mitigate: lockfiles and `npm ci`, images pinned by digest, actions pinned to SHAs, Dependabot with a 7-day cooldown, osv-scanner, `npm audit`, dependency review. | SDL-02, SDL-04 |
| R-09 | A lost or stolen iPad, phone or laptop exposes offline tenant data or an active session. | 4 | 3 | 12 | Mitigate: device passcodes and disk encryption, short crew sessions, managers revoke device tokens, sessions revocable from the app. MDM when the fleet grows. | AST-02, ACC-08 |
| R-10 | The backup private key is lost, so backups can't be restored. | 2 | 5 | 10 | Mitigate: two offline copies, a sealed spare for production, quarterly restore tests prove the key works. | CRY-02, BCK-04 |
| R-11 | No WAL archiving: a host failure loses up to 24 hours of data. | 2 | 3 | 6 | Accept while pre-revenue; add WAL archiving (15-minute RPO) before paying customers rely on it. | BCK-07 |
| R-12 | The public repository shows internal details (host names, paths, deploy scripts, control status) that help an attacker plan. | 3 | 2 | 6 | Accept with conditions: no secrets (push protection, gitleaks), sensitive findings kept private. Decide whether to make the repository private. | GOV-05, SDL-02 |
| R-13 | No segregation of duties: one person writes, reviews, approves and deploys. | 3 | 3 | 9 | Mitigate with compensating controls: CI, required approval pause, AI-assisted security review, monthly self-review. | CHG-07 |
| R-14 | Phishing or account takeover of Kelvin's GitHub, email, registrar or password manager. | 3 | 5 | 15 | Mitigate now: hardware keys or passkeys on GitHub, email and the password manager; MFA everywhere; registrar lock; awareness training. | ACC-01, HRS-03 |
| R-15 | Privacy non-compliance (PIPEDA, Alberta and BC PIPA, Quebec Law 25, CASL): a missed breach notice, missing consent, data stored outside Canada without notice. | 3 | 4 | 12 | Mitigate: privacy policy and breach steps, sub-processor list, CASL tools, a privacy impact assessment before Quebec, counsel review before launch. | PRV-01 to PRV-06 |
| R-16 | Single production host and provider: an outage, or the provider stops serving us. | 3 | 4 | 12 | Mitigate: offsite backups in Canada with another provider, rebuild checklist, annual DR drill against the 8-hour RTO. | BCK-02, BCK-05 |
| R-17 | Unpatched vulnerabilities in hosts or dependencies (Dependabot security updates are off today). | 3 | 4 | 12 | Mitigate: turn on Dependabot security updates, unattended-upgrades, fix deadlines by severity, monthly alert review. | SDL-02, SDL-03, OPS-05 |
| R-18 | Fraud: a tenant's payment settings or Stripe key are changed to redirect payments, or a contractor misuses access. | 2 | 4 | 8 | Mitigate: MFA for owners and admins, audit of secret changes, alert tenant owners when payment settings change, contractors get no production access. | RSK-03, ACC-08, HRS-01 |

## Exceptions and risk acceptances

| id | what is accepted | reason | compensating control | approved | expires |
| --- | --- | --- | --- | --- | --- |
| A-01 | RPO of 24 hours (R-11) | Pre-revenue; WAL archiving adds operational work | Nightly and pre-deploy backups; offline-first devices hold recent changes | Kelvin Waldner, 2026-10-19 | 2027-09 (risk assessment) or first paying customer |

Vulnerability exceptions to the fix deadlines are recorded here too, with an expiry no more than 90
days out. Keep only an id and a one-line summary here; the details go in a private security advisory.

## Evidence

- This register and its git history; the September re-scoring commit.
- Change-triggered assessments, noted in the pull request that made the change.
- Expired or renewed acceptances, checked monthly.

## Exceptions

Not applicable: this document is where exceptions are recorded.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Initial register of 18 risks. Drafted with an AI agent; adopted when Kelvin merges it. |
