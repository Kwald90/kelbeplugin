# Fishtape sub-processor list (DRAFT)

> **Draft, not published.** This is a counsel-review draft, not a published list. See
> [README.md](README.md). Locations marked "to confirm" are not yet confirmed in writing and **must
> not be filled in from memory** — they come from
> [`docs/compliance/vendor-management.md`](../compliance/vendor-management.md), which is the source
> of truth. Do not publish until the "to confirm" entries are resolved and counsel has reviewed.

**Placeholders to fill in before publishing:**

- `{{COMPANY_LEGAL_NAME}}` — the legal name of the company that operates Fishtape
- `{{PRIVACY_CONTACT_EMAIL}}` — the address where subscribers can ask about or object to a sub-processor
- `{{EFFECTIVE_DATE}}` — the date this list is current as of

---

**Current as of:** `{{EFFECTIVE_DATE}}`

A sub-processor is an outside provider that processes personal information to help us provide
Fishtape. This list is kept current; we give subscribers **advance notice before adding a new
sub-processor that would see their data**, so they can tell their own customers and crew.

**Two kinds of provider.** Some sub-processors are **engaged by Fishtape** (for example our hosting
and backup providers). Others are **connected by the subscriber** with the subscriber's own account
or keys (for example Stripe, Twilio, Resend, Meta, AI providers and QuickBooks Online); for those the
subscriber is the provider's customer under its own agreement, and Fishtape makes the calls on the
subscriber's behalf. The "engaged by" note in the table shows which is which.

**Country notes.** Countries are taken only from
[`docs/compliance/vendor-management.md`](../compliance/vendor-management.md). "To confirm" means the
processing location has not been confirmed in writing. "US company" means the vendor is a United
States company; where its data-processing location is not confirmed, that is marked too. We have not
guessed any location.

## Sub-processors that may process personal information

| Sub-processor | Purpose | Data shared | Country / residency | Notice commitment |
| --- | --- | --- | --- | --- |
| Hosting provider (dotmoose) | Production hosting of the service (engaged by Fishtape) | All production data, including subscriber personal information | Data centre **to confirm** (Canada preferred) | Advance notice before change |
| Offsite backup storage — provider to be chosen (default AWS S3, `ca-central-1`) | Encrypted offsite backup copies (engaged by Fishtape) | `age`-encrypted backup files only; the provider never holds a key that can decrypt them, so it sees no readable personal data | **Canada** (region to confirm; provider not yet chosen) | Advance notice before change |
| GitHub | Source code, CI/CD, security alerts (engaged by Fishtape) | Source code (public repository), deploy keys, CI logs; **no subscriber personal data** in normal operation | US company; location **to confirm** | Advance notice before change |
| Stripe | Fishtape's own subscription billing; subscribers' invoice payments use their own Stripe accounts | Billing contact details; **card numbers stay with Stripe** and are not stored by Fishtape | **To confirm** | Advance notice before change |
| Anthropic | Optional in-app AI features (connected by the subscriber, using the subscriber's own key); also our AI coding agents, which do not use subscriber data | Subscriber data only under the subscriber's own key and enabled scope | US company; processing location **to confirm** | Subscriber turns the feature on; off by default |
| Twilio | SMS messaging (connected by the subscriber, using the subscriber's own key) | Customer phone numbers, message text | **To confirm** | Subscriber connects it |
| Resend | Email (connected by the subscriber, using the subscriber's own key; system email to confirm) | Email addresses, message content | **To confirm** | Subscriber connects it |
| Intuit (QuickBooks Online) | Two-way accounting sync with the subscriber's own QuickBooks Online company (connected by the subscriber) | The subscriber's customers, products and services, estimates, invoices, payments, supplier bills, purchase orders, and employee time (hours, job, employee name), both ways at the subscriber's request | US company; QuickBooks Canada data location **to confirm** | Subscriber connects it; can disconnect from either side |
| Meta (Facebook Lead Ads) | Lead capture into the subscriber's CRM (connected by the subscriber) | Lead names, contact details and form answers (inbound); page tokens | **To confirm** | Subscriber connects it |
| Google | Optional "Sign in with Google" (connected by the subscriber) | User name and email returned at sign-in | **To confirm** | Subscriber chooses it at sign-in |
| Microsoft | Optional "Sign in with Microsoft" (connected by the subscriber) | User name and email returned at sign-in | **To confirm** | Subscriber chooses it at sign-in |
| Cloudflare (cdnjs) | Serves the pdf.js library to browsers (engaged by Fishtape) | End users' IP addresses and request metadata | **To confirm** | Planned to be removed by self-hosting pdf.js |
| OpenStreetMap (OSM Foundation) | Map tiles for job-site maps (engaged by Fishtape) | Map area (`{z}/{x}/{y}` tile requests) near a job site only; **no personal data** and no person's position | Served from OSMF infrastructure that **may be outside Canada**; carries no personal data | Advance notice before change |
| Natural Resources Canada — Geolocator | "Find address" lookup for a job's street address (engaged by Fishtape) | A job's street address, when the button is used | **Canada** (a Government of Canada service) | Advance notice before change |

## Related providers that do not process subscriber personal data

These are part of how Fishtape runs, but in normal operation they do not process subscribers'
personal information. They are listed for transparency.

- **DreamHost** — staging server, shared with other sites. Staging uses seeded test data only;
  production subscriber data is never copied to staging. (US company; data centre to confirm.)
- **Apple** — developer account, App Store and TestFlight for the mobile apps (app builds and
  developer-account details only).
- **Let's Encrypt (ISRG)** — TLS certificates (domain names and an account email).
- **Docker Hub, npm registry** — base images and software dependencies (no personal data).
- **Password manager, DNS registrar and DNS host, optional uptime monitor** — operational accounts
  holding credentials, DNS records and public URLs, not subscriber personal data.

## Questions and objections

To ask about a sub-processor, or to object to a new one before it takes effect, contact
`{{PRIVACY_CONTACT_EMAIL}}`. This list is maintained by `{{COMPANY_LEGAL_NAME}}` and reviewed at
least annually and whenever a sub-processor is added or changed.
