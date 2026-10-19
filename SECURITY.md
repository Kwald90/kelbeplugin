# Security policy

Fishtape is a small Canadian company. We welcome reports of security problems in Fishtape and
will work with you to fix them.

## Reporting a vulnerability

Report privately through GitHub: **[open a private security advisory](https://github.com/Kwald90/kelbeplugin/security/advisories/new)**
(Security tab → Report a vulnerability). Please don't open a public issue, pull request or
discussion for a security problem.

Include what you found, where (URL, endpoint, file), steps to reproduce, the impact you think it
has, and how to reach you. Proof-of-concept code is welcome; screenshots and request/response
pairs help.

What happens next:

| step | target |
| --- | --- |
| We acknowledge your report | 3 business days |
| We confirm or rule out the issue and give it a severity | 10 business days |
| We fix it | Critical 7 days, High 30 days, Medium 90 days, Low 180 days ([vulnerability management](docs/security/vulnerability-management.md)) |
| We tell you it's fixed and, if you want, credit you in the advisory | when the fix ships |

There is no paid bug bounty.

## Scope

In scope:

- `app.fishtapehq.com`, `hq.fishtapehq.com`, `status.fishtapehq.com`
- the staging site `tgelectrical.truecollarbuilt.com` (test data only)
- this repository: the web app in `electrical-app/`, the API in `server/`, the iOS app, CI workflows and deploy scripts

Out of scope:

- other websites hosted on the same servers, and third-party services we use (report those to their owners)
- denial-of-service and load testing, spam, and social engineering or phishing of people
- physical attacks, and attacks needing a stolen, unlocked device
- reports from automated scanners without a demonstrated impact, missing headers without an exploit, and version banners

## Testing rules

- Use your own accounts and test companies. Never access, change or delete another tenant's data;
  if you reach it by accident, stop, don't keep it, and tell us what you saw.
- No denial of service, no high-volume automated scanning, no spam through our email/SMS features.
- Don't test against production customer data when staging shows the same behaviour.
- Give us reasonable time to fix before you disclose publicly; we'll agree a date with you.

## Safe harbour

If you follow this policy in good faith, we will not pursue legal action against you for your
research, and we'll treat it as authorised. If a third party takes action against you over
research done under this policy, we will say that it was authorised.

## Supported versions

Only the current production release and the head of the staging branch receive fixes.

## Our side

How we handle security internally: [docs/security/](docs/security/) (threat model, secure
development, secrets, vulnerability management) and [docs/compliance/](docs/compliance/).
