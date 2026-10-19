# Vendor management policy

Which outside companies Fishtape relies on, what data they see, and how they are chosen and checked.

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | Every vendor that hosts, processes, stores or delivers Fishtape code or data, or supplies software the service runs |
| Review cadence | Annually (June), and before adding a vendor that will see Confidential or Restricted data |
| Last reviewed | 2026-10-19 |
| Related controls | VND-01, VND-02, VND-03, VND-04, PRV-06 |

## Purpose

Know every vendor, understand the risk each one adds, and keep the security evidence that shows the
risk is acceptable.

## Scope

Hosting, development and CI, AI, payments and messaging, sign-in providers, software supply chain,
and optional monitoring and backup services. Tenant-chosen providers are covered by the shared
responsibility section.

## Policy

1. No vendor sees Confidential or Restricted data until it has been through the onboarding checks below.
2. Prefer vendors that store data in Canada. Where data leaves Canada, say so in the privacy notice
   and sub-processor list ([privacy.md](privacy.md#data-residency)).
3. MFA is on for every vendor account that offers it.
4. Every vendor is reviewed once a year.
5. Locations below say "to confirm" until confirmed in writing. Don't fill them in from memory.

## Vendor inventory

Classes are from [data-classification.md](data-classification.md). Criticality: high (service stops
or data is exposed if the vendor fails), medium (a feature stops), low.

| vendor | service | data shared | class | location / residency | criticality | security evidence to collect | MFA | next review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dotmoose | Production VPS | Everything in production | Restricted | Data centre to confirm (Canada preferred) | High | Written agreement (confidentiality, breach notice, disk and snapshot disposal, staff access), data-centre location, disk encryption | Required; to confirm | Before the first production deploy |
| DreamHost | Staging VPS (shared with other sites) | Test data, staging secrets | Internal | US company; data centre to confirm | Low | Terms of service, security page | Required; to confirm | 2027-06 |
| GitHub | Code, CI/CD, environment secrets, security alerts | Source code (public), deploy keys, CI logs | Restricted (secrets) | US company; location to confirm | High | SOC 2 report, DPA | Required (hardware key preferred) | 2027-06 |
| Anthropic | AI coding agents (Kelvin's account); in-app AI uses each tenant's own key | Source code; tenant data only under the tenant's key | Confidential | US company; processing location to confirm | Medium | SOC 2 report, commercial terms and data-use settings, DPA | Required; to confirm | 2027-06 |
| Stripe | Fishtape's own subscriptions; tenant invoice payments use tenants' own accounts | Tenant billing contacts; card data stays with Stripe | Confidential | To confirm | High (billing) | PCI DSS attestation, SOC 2 report, DPA | Required | 2027-06 |
| Twilio | SMS, with tenants' own keys | Customer phone numbers, message text | Confidential | To confirm | Medium | SOC 2 report or ISO 27001, DPA | Required (tenant accounts: tenant's duty) | 2027-06 |
| Resend | Email, with tenants' own keys; system email to confirm | Email addresses, message content | Confidential | To confirm | Medium | SOC 2 report, DPA | Required | 2027-06 |
| Meta (Facebook Lead Ads) | Lead webhooks into tenants' CRM | Lead names, contact details, form answers (inbound); page tokens | Confidential | To confirm | Medium | Platform terms, data-processing terms | Required | 2027-06 |
| Apple | Developer account, App Store, TestFlight | App builds, developer account details | Internal | To confirm | Medium | Developer program terms | Required | 2027-06 |
| Google | OAuth sign-in | User name and email returned at sign-in | Confidential | To confirm | Medium | ISO 27001 or SOC 2 report | Required | 2027-06 |
| Microsoft | OAuth sign-in (Entra app registration) | User name and email returned at sign-in | Confidential | To confirm | Medium | ISO 27001 or SOC 2 report | Required | 2027-06 |
| Let's Encrypt (ISRG) | TLS certificates | Domain names; account email | Public | Not applicable | Medium | None needed | No account login | 2027-06 |
| Docker Hub | Base images (`node`, `postgres`), pinned by digest | None | Public | Not applicable | Medium (supply chain) | Official image provenance; Dependabot updates | Required if an account is used | 2027-06 |
| npm registry | Server dependencies via lockfile | None | Public | Not applicable | Medium (supply chain) | osv-scanner, `npm audit`, dependency review | Required if an account is used | 2027-06 |
| Cloudflare (cdnjs) | pdf.js loaded by browsers at a pinned path | End users' IP addresses and request metadata | Internal | To confirm | Low | None; plan is to self-host pdf.js and remove this vendor | No account | When self-hosted |
| Offsite backup storage (optional, required for production) | Encrypted backup copies | Encrypted dumps only | Restricted (encrypted) | Must be in Canada | High | SOC 2 or ISO 27001, object lock or retention feature, DPA | Required | When chosen |
| Uptime and heartbeat monitor (optional) | External checks, dead-man's switch | Public URLs, ping times | Public | To confirm | Medium | Terms | Required | When chosen |
| Password manager | Holds all credentials and keys | Restricted (encrypted on the client side) | Restricted | To confirm | High | Security whitepaper, independent audit report | Required (hardware key preferred) | 2027-06 |
| DNS registrar and DNS host | `fishtapehq.com`, `truecollarbuilt.com` | DNS records | Public | To confirm | High | Registrar lock, account recovery options | Required | 2027-06 |

## How it's done here

### Onboarding a vendor

Before a new vendor sees Confidential or Restricted data:

1. Say what data it will get and why. Use the least data that works.
2. Collect what is available: SOC 2 Type II report or ISO 27001 certificate, the DPA or privacy terms,
   the sub-processor list, breach-notice terms, and where data is stored.
3. Check MFA, export and deletion options, and what happens to data when the account is closed.
4. Add a row to the table above and to the asset inventory. Add the vendor to the sub-processor list
   if it handles tenant data.
5. For a host: confirm data-centre location and disk encryption, and get a written agreement
   (an email is better than nothing) covering confidentiality, breach notice to Fishtape, staff
   access, and disposal of disks and snapshots when the server is cancelled.

### Annual review (June)

For each vendor: is it still used, did the data shared change, is the evidence current (download
the newest SOC 2 report or certificate), any breaches reported, is MFA on, do the account users
match the access review. Save notes and documents in the evidence bundle. Update this table.

### Offboarding a vendor

Export what Fishtape needs, delete the rest at the vendor and ask for confirmation, revoke keys and
OAuth grants, remove the account, update the table, the asset inventory and the sub-processor list.

## Tenant-supplied keys: shared responsibility

Each tenant signs up with Stripe, Twilio, Resend, Meta or Anthropic itself and enters its own keys in
Fishtape. The tenant is that provider's customer; Fishtape is the tool that holds the key and makes
the calls on the tenant's behalf.

| | the tenant | Fishtape |
| --- | --- | --- |
| Contract with the provider, its terms and its DPA | Yes | No |
| Choosing the provider and accepting where it stores data | Yes | Discloses which features send data to which provider |
| Creating, scoping and rotating the key; MFA on the provider account | Yes | Setup guides recommend restricted keys and MFA |
| Storing the key | | Encrypted in `tenant_secrets`; never logged or shown again after entry |
| Using the key only for the features the tenant turned on | | Yes; every use that changes data is audited |
| Consent for SMS and email marketing (CASL) | Yes | Provides consent fields, unsubscribe links and STOP handling ([privacy.md](privacy.md#casl)) |
| Responding to a breach at the provider | Yes | Helps: revokes or replaces the stored key on request |

## Evidence

- This table and its git history.
- Vendor documents and annual review notes in the June evidence bundle.
- The production host agreement (when signed).

## Exceptions

dotmoose is a friend's hosting without a formal agreement yet. It must not hold production data
until the onboarding checks for a host are done, or Kelvin records a risk acceptance.

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. |
