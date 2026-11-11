# Fishtape data processing addendum (DRAFT)

> **Draft, not published.** This is a counsel-review draft, not a published or legally reviewed
> agreement. See [README.md](README.md). It is not in force until counsel has reviewed it, the
> placeholders are filled in, and it forms part of a signed or accepted subscription.

**Placeholders to fill in before publishing:**

- `{{COMPANY_LEGAL_NAME}}` — the legal name of the company that operates Fishtape
- `{{COMPANY_MAILING_ADDRESS}}` — a mailing address for notices
- `{{PRIVACY_CONTACT_EMAIL}}` — the contact address for notices and requests under this addendum
- `{{PROVINCE}}` — the governing-law province (matches the [terms of service](terms-of-service.md))
- `{{EFFECTIVE_DATE}}` — the date this addendum takes effect

---

**Effective date:** `{{EFFECTIVE_DATE}}`

This data processing addendum ("DPA") forms part of the [terms of service](terms-of-service.md)
between `{{COMPANY_LEGAL_NAME}}` ("Fishtape", "we", "us") and the subscriber ("you"). It describes
how we handle personal information that you keep in Fishtape. It is written to help both parties meet
Canada's *Personal Information Protection and Electronic Documents Act* (PIPEDA) and the equivalent
provincial laws where they apply. If this DPA conflicts with the terms of service on the handling of
personal information, this DPA governs.

## 1. Roles

- **You are the organization accountable** for the personal information you and your users put into
  Fishtape — your clients and portal users, crew, leads, and the people named in your jobs, tickets
  and messages. You decide what it is collected for and how it is used.
- **We are your service provider (processor).** We process that information **only on your
  instructions and only to provide and support the service.** Your configured use of Fishtape, and
  this DPA and the terms, are your instructions. We will tell you if we believe an instruction breaks
  a privacy law.

Under PIPEDA you remain accountable for personal information you transfer to us for processing, and
this DPA is the contractual protection PIPEDA expects you to have in place.

## 2. Purpose and collection limits

- We use your personal information only to provide, maintain, secure and support the service, and as
  this DPA allows. We do not sell it, use it for advertising, or use it to build the product.
- **Data minimization is built into the product.** Fishtape collects only the fields its features
  need. **There are no fields for Social Insurance Numbers, health information, or bank account
  numbers, and we do not collect them.** Payment card numbers are handled by Stripe and are never
  stored on our systems.
- Where location is recorded (crew location while clocked in; one fix at the signing of a field
  ticket), it is limited to the stated purpose, off unless you turn it on, and subject to notice to
  the people affected. You are responsible for telling your crew and obtaining any consent required.

## 3. Your responsibilities

You confirm that you have the right to put the personal information into Fishtape, that you have given
the notices and obtained the consents your customers and crew require (including for location
tracking and for CASL-governed marketing messages), and that your instructions to us comply with the
applicable privacy laws.

## 4. Confidentiality and security

- We keep your personal information confidential and restrict access to the staff and systems that
  need it to provide the service. Access by our team is logged.
- We maintain technical and organizational safeguards appropriate to the sensitivity of the data,
  including multi-factor authentication, **per-subscriber isolation enforced by database row-level
  security** (not by convention), encryption in transit and of backups, audit logging, and regular
  backups. Our safeguards are described in the policies under `docs/compliance/`.
- Our staff and AI coding agents do not use your real data to develop the product; they use synthetic
  test data.

## 5. Sub-processors

- We use the sub-processors in our [sub-processor list](subprocessors.md) to help provide the
  service. Each one is bound to protect personal information and to use it only to provide its part
  of the service, on terms no less protective than this DPA (**flow-down**).
- **We give you advance notice before engaging a new sub-processor** that would process your personal
  information, so you can tell your own customers and crew. The sub-processor list names each one,
  what it does, what data it sees, and the country where it processes data.
- Some providers (Stripe, Twilio, Resend, Meta, AI providers, QuickBooks Online) are ones **you
  connect with your own account or keys**. For those you are the provider's customer under your own
  agreement with them; we make the calls on your behalf. We remain responsible for the sub-processors
  we engage ourselves (such as our hosting provider).

## 6. Data location and transfers

Our stance is to prefer hosting and backups in Canada, and our **offsite backups are kept in
Canada**. Some sub-processors process data outside Canada; the [sub-processor list](subprocessors.md)
states the country for each, and marks "to confirm" any location not yet confirmed in writing. PIPEDA
permits processing outside Canada provided we remain accountable and are transparent, which the
sub-processor list provides. Where a province (for example Alberta) expects notice that a service
provider outside Canada is used, the sub-processor list supports that notice.

## 7. Personal-information requests

If an individual asks us to access, correct or delete personal information that belongs to your data
in Fishtape, we will not respond for you; we will forward the request to you promptly (within 2
business days) and tell the individual we have done so. At your instruction, we will help you answer
by exporting, correcting or deleting the data through the product or our console (an audited action),
in time for you to meet your legal deadline (30 days under PIPEDA, with extensions where allowed).

## 8. Breach notification

We handle any breach of our safeguards as a security incident
([`docs/compliance/incident-response.md`](../compliance/incident-response.md)). If personal
information you keep in Fishtape is, or is likely to be, lost, accessed without authorization, or
disclosed because of a breach of our safeguards, we will notify you **promptly, with a target of
within 72 hours of confirming the breach**, with what we know so far, and we will keep you updated as
we learn more. You, as the organization accountable, decide on any report to a privacy commissioner
and any notice to individuals; we will help with the facts and can draft notices. We keep a record of
every breach.

## 9. Return and deletion on offboarding

- **Export.** On request, or when you close your account, we provide an export of your data (records
  are exported per collection). We deliver it through an expiring link or an encrypted file.
- **Deletion.** After the notice period in your agreement (30 days by default), we delete your data.
  Because every subscriber table is tied to your account with cascading deletion, removing your
  account removes your records. The audit log outlives the account for up to one year, then is
  deleted (unless a legal hold applies). The hands-on process is in
  [`docs/runbooks/offboard-tenant.md`](../runbooks/offboard-tenant.md).
- **Connected services.** If you connected QuickBooks Online, we disconnect it first so the grant is
  revoked while we still hold the token. You should also revoke at the providers the keys you gave us
  (Stripe, Twilio, Resend, Meta, AI providers).
- **Backups.** Deleted data remains in our encrypted backups until they age out — up to about 8 weeks
  on the server and about 13 months in the offsite weekly copies — after which it is gone. We do not
  edit backups. We will tell you the date by which the backups age out.

## 10. Audit and assurance

On reasonable request and subject to confidentiality, we will provide the information you reasonably
need to confirm our compliance with this DPA, such as our compliance documentation and available
third-party security reports. **(Counsel to confirm the audit scope and any limits.)**

## 11. Changes

We may update this DPA as the service and sub-processors change, with notice of material changes and
with the sub-processor notice described in section 5. The effective date shows the current version.

## 12. Notices

Notices under this DPA go to `{{PRIVACY_CONTACT_EMAIL}}` or to `{{COMPANY_LEGAL_NAME}}`,
`{{COMPANY_MAILING_ADDRESS}}`, and to you at the contact on your account. This DPA is governed by the
law of the Province of `{{PROVINCE}}`, matching the terms of service.
