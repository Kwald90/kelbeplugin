# Fishtape privacy notice (DRAFT)

> **Draft, not published.** This is a counsel-review draft, not a published or legally reviewed
> notice. See [README.md](README.md). Do not post it to a live site until counsel has signed off and
> every placeholder below is filled in.

**Placeholders to fill in before publishing:**

- `{{COMPANY_LEGAL_NAME}}` — the legal name of the company that operates Fishtape
- `{{COMPANY_MAILING_ADDRESS}}` — a mailing address for privacy correspondence
- `{{PRIVACY_OFFICER_NAME}}` — the named privacy officer (role is required under PIPEDA)
- `{{PRIVACY_CONTACT_EMAIL}}` — the published privacy contact address (to be set up on fishtapehq.com)
- `{{EFFECTIVE_DATE}}` — the date this notice takes effect

---

**Effective date:** `{{EFFECTIVE_DATE}}`

Fishtape is software for Canadian electrical contractors, operated by `{{COMPANY_LEGAL_NAME}}`
("Fishtape", "we", "us"). This notice explains what personal information we handle, why, and the
choices you have. It is written to meet Canada's *Personal Information Protection and Electronic
Documents Act* (PIPEDA) and the equivalent provincial laws where they apply.

This notice covers the Fishtape website, web app and mobile apps. It is a general-audience summary;
our internal privacy policy (`docs/compliance/privacy.md`) has the detail.

## The two roles we play

Fishtape works for two kinds of people, and our duties differ for each.

- **For businesses that subscribe to Fishtape (tenants):** we are the **service provider**. Your
  contractors' business runs in Fishtape, and the records they keep there — their clients, crew,
  jobs, invoices — belong to them. We process that information **only on their instructions**, to
  provide the service, and we do not decide what it is used for. If you are a customer, an employee
  or a lead of a business that uses Fishtape, that business is accountable for your personal
  information. Send requests about it to them; see "If a business uses Fishtape to serve you" below.
- **For our own relationship with a subscriber:** we are the organization **in control** of the
  account and billing information we collect to run Fishtape as a business.

Under PIPEDA, an organization that hands personal information to a service provider stays accountable
for it and must use a contract to get comparable protection. Our [terms of service](terms-of-service.md)
and [data processing addendum](data-processing-addendum.md) are how subscribers get that.

## What we collect and why

We collect only what a feature needs. **The product has no fields for Social Insurance Numbers,
health information, or bank account numbers, and we do not ask for them.** Payment card numbers are
handled by Stripe and never stored on our systems.

**Information we control (our own relationship with a subscriber):**

| What | Why |
| --- | --- |
| Account details — name, email, sign-in and multi-factor-authentication data | To create and secure accounts |
| Billing records — business contact, subscription and invoice history | To charge for and manage the subscription |
| Support conversations | To answer questions and fix problems |
| Marketing contacts, with consent | To tell subscribers and prospects about Fishtape, under Canada's anti-spam law (CASL) |

**Information a subscriber keeps in Fishtape, which we process on their behalf:**

This includes their clients and portal users (names, addresses, phone numbers, emails), crew time
entries and wages, leads, job records, estimates, invoices, drawings and photos, and the messages
they send through their own Twilio or Resend accounts. We use it only to run the service for them.

**Location while clocked in.** If a subscriber turns it on, Fishtape can record where a worker is
**only while they are clocked in**, to put hours and travel time against the right job. Employee
location is sensitive, so it is off unless chosen, each worker is shown a notice and can decline and
still clock in, and raw location points are deleted after a set period (90 days by default). Nothing
is recorded before clock-in, on days off, or after clock-out. The subscriber is the business in
control of its crew's location data; we are its service provider.

**Signatures on field tickets and documents.** When a customer signs an extra-work ticket, estimate
or change order, Fishtape keeps the signer's name, the signature, the time, and — if the subscriber
has it switched on — one location fix taken at the moment of signing, as evidence the work was
agreed. The signing screen tells the signer this before they sign and lets them ask for a copy.

## How we use information, and what we do not do

- We use subscriber data only to provide the service and support it.
- **We do not sell personal information, and we do not use it for advertising.**
- We do not share one subscriber's data with another. Isolation between subscribers is enforced in
  the database, not by convention.
- Our staff and AI coding agents do not use real subscriber data to build the product; they work
  with synthetic test data.

**AI features.** Fishtape includes optional AI features that a subscriber can turn on. When used,
they send that subscriber's own data to the AI provider the subscriber chose, using the subscriber's
own key, within the limits the subscriber set. These features are off by default.

**Connected services (QuickBooks Online).** A subscriber can connect its own Intuit QuickBooks Online
company. Data then flows both ways, only because the subscriber asked for it, so the two systems
stay in sync. Fishtape's AI, integrations and API keys can read the subscriber's Fishtape records,
including records that sync with QuickBooks; this is disclosed to Intuit and on the connect screen.
QuickBooks and Intuit are trademarks of Intuit Inc.

## Who else sees it (sub-processors)

We rely on a short list of outside providers to host, secure and deliver the service — for example
the company that hosts our servers, and the payment, email and messaging providers that subscribers
connect with their own accounts. Our [sub-processor list](subprocessors.md) names each one, what it
does, what data it sees, and the country where it processes data. Where a location is not yet
confirmed in writing, the list says "to confirm" rather than guessing.

Our stance is to prefer hosting and backups in Canada, and our offsite backups must be in Canada.
Some providers process data outside Canada; PIPEDA allows this as long as we stay accountable and
are open about it, which is the purpose of the sub-processor list. We give subscribers notice before
adding a new sub-processor that would see their data.

## How long we keep it

We keep account and billing information while an account is open and for as long as the law requires
afterward. Subscriber data is kept while the subscriber uses the service and is exported and deleted
when the subscriber leaves; see the [data processing addendum](data-processing-addendum.md) and the
offboarding process. Deleted data can remain in our encrypted backups for a limited time before it
ages out — up to about 8 weeks in the daily and weekly copies on the server and about 13 months in
the offsite weekly copies — after which it is gone. We do not edit backups.

## Your rights, and how to reach us

You can ask to see the personal information we hold about you, to have it corrected, and in many
cases to have it deleted.

- **If a business uses Fishtape to serve you** (you are its customer, employee or lead): that
  business is accountable for your information. Send your request to them. If you send it to us, we
  will pass it to them and let you know we did.
- **About your own Fishtape account** (you are a subscriber's user): contact us and we will answer
  within 30 days, after confirming your identity.

**Privacy contact:**

- Privacy Officer: `{{PRIVACY_OFFICER_NAME}}`
- Email: `{{PRIVACY_CONTACT_EMAIL}}`
- Mail: `{{COMPANY_LEGAL_NAME}}`, `{{COMPANY_MAILING_ADDRESS}}`

## Security and breaches

We protect personal information with multi-factor authentication, database row-level security,
encryption, audit logging and backups. If a breach of our safeguards creates a real risk of serious
harm, we assess it, contain it, and notify as the law requires. When a breach affects data we hold
for a subscriber, we aim to notify that subscriber within 72 hours of confirming it so they can meet
their own duties. See our [data processing addendum](data-processing-addendum.md) and incident
process for detail.

## Complaints

If you are not satisfied with how we handle your personal information, please contact our Privacy
Officer first so we can try to put it right. You can also complain to the **Office of the Privacy
Commissioner of Canada** (priv.gc.ca, 1-800-282-1376), or to your **provincial privacy
commissioner** where one applies — for example the Office of the Information and Privacy Commissioner
of Alberta or of British Columbia, or (once Fishtape serves Quebec) the Commission d'accès à
l'information du Québec.

## Changes to this notice

We may update this notice as Fishtape changes. The effective date at the top shows the current
version, and past versions are kept in our records. We will give subscribers notice of material
changes.
