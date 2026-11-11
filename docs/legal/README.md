# Public legal documents (DRAFTS — pending counsel review)

This folder holds **drafts** of the public-facing legal documents tenants (subscribers) are given:
a privacy notice, terms of service, a data processing addendum, and a sub-processor list.

> **These are drafts, not published and not legally reviewed.** They were drafted with an AI agent
> from the internal compliance policies. **Privacy counsel must review and approve them, and every
> `{{PLACEHOLDER}}` must be filled in, before any of them is published or relied on.** Nothing here
> is in force. Do not post any of it to a live site yet.

## The documents

| File | What it is |
| --- | --- |
| [privacy-notice.md](privacy-notice.md) | Public privacy notice (PIPEDA-aligned): what personal information is handled and why, Fishtape's service-provider role, retention, the privacy contact, and how to complain to the OPC or a provincial commissioner. |
| [terms-of-service.md](terms-of-service.md) | Tenant terms: service description, acceptable use, availability (no hard SLA pre-launch), liability, governing law. |
| [data-processing-addendum.md](data-processing-addendum.md) | DPA: our processor obligations, purpose and collection limits, sub-processor flow-down, 72-hour breach notice, data location, and deletion on offboarding. |
| [subprocessors.md](subprocessors.md) | Sub-processor list with countries, built from the vendor inventory. |

## Source of truth

The substance comes from the internal policies, which stay the source of truth. If an internal policy
changes, update the matching draft here:

- [`docs/compliance/privacy.md`](../compliance/privacy.md) — privacy program, roles, breaches,
  location, QuickBooks, CASL
- [`docs/compliance/data-classification.md`](../compliance/data-classification.md) — data classes and
  the "no SIN, health or banking fields" position
- [`docs/compliance/acceptable-use.md`](../compliance/acceptable-use.md) — acceptable use
- [`docs/compliance/incident-response.md`](../compliance/incident-response.md) — breach and incident
  handling
- [`docs/compliance/vendor-management.md`](../compliance/vendor-management.md) — sub-processors and
  their locations (**the only source for countries; "to confirm" means not confirmed**)
- [`docs/runbooks/offboard-tenant.md`](../runbooks/offboard-tenant.md) — export and deletion on
  offboarding

## Placeholders to fill in before publishing

Each file lists its own placeholders at the top. Across the set they are:

- `{{COMPANY_LEGAL_NAME}}` — the legal name of the company that operates Fishtape
- `{{COMPANY_MAILING_ADDRESS}}` — a mailing address for privacy and legal correspondence
- `{{PRIVACY_OFFICER_NAME}}` — the named privacy officer
- `{{PRIVACY_CONTACT_EMAIL}}` — the privacy/legal contact address (to be set up on fishtapehq.com)
- `{{PROVINCE}}` — the governing-law province (terms and DPA)
- `{{EFFECTIVE_DATE}}` — the date each document takes effect

Plus the "to confirm" sub-processor locations in
[`docs/compliance/vendor-management.md`](../compliance/vendor-management.md), which must be confirmed
in writing before the sub-processor list is published.

## Status against the controls register

These drafts are progress toward GOV-05, PRV-01, PRV-02 and PRV-06, which stay **`partial`** until
the documents are reviewed by counsel and published. Publishing and sign-off is the remaining step.
