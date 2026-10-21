# Privacy policy (internal)

How Fishtape handles personal information under Canadian privacy law. This is the internal policy;
the public privacy notice and the sub-processor list for customers are separate (planned). This is
not legal advice. Where it says "confirm with counsel", do that before relying on it.

| | |
| --- | --- |
| Owner | Kelvin Waldner (privacy officer) |
| Applies to | All personal information Fishtape collects, holds or processes, for itself or for tenants |
| Review cadence | Annually (October), after any breach, and before entering a new province |
| Last reviewed | 2026-10-20 |
| Related controls | PRV-01 to PRV-07, DAT-03, DAT-04 |

## Purpose

Meet Fishtape's own privacy duties, and help tenants meet theirs for the data they keep in Fishtape.

## Scope and roles

Fishtape plays two roles. They carry different duties.

| data | Fishtape's role | who is accountable |
| --- | --- | --- |
| Tenant users' accounts (name, email, sign-in and MFA data), Fishtape's billing records, support conversations, Fishtape's own marketing contacts | Organization in control | Fishtape |
| Data tenants keep in Fishtape: their customers (portal users, clients), crew time and wages, leads, job records, messages sent through their Twilio or Resend accounts | Service provider processing on the tenant's behalf | The tenant, with Fishtape bound by contract to protect it and use it only to provide the service |

Under PIPEDA, an organization that transfers personal information to a third party for processing
stays accountable for it and must use contracts or other means to get comparable protection. Fishtape's
terms and data processing addendum (planned) are how tenants get that.

The privacy officer is Kelvin Waldner. Contact: a privacy address on fishtapehq.com (to be set up and
published in the privacy notice).

## Which laws apply

- PIPEDA applies to commercial activity in Ontario, Saskatchewan, Manitoba and the Atlantic provinces,
  and to personal information that crosses provincial or national borders.
- Alberta PIPA and BC PIPA apply instead of PIPEDA to private-sector organizations' activities within
  those provinces, and also cover employee personal information. PIPEDA covers employee information
  mainly for federally regulated employers. Fishtape protects crew data the same way everywhere.
- Quebec's private-sector law, as amended by Law 25, applies once Fishtape has Quebec tenants (later).
- CASL applies to commercial emails and text messages, including tenants' marketing sequences.
- Some public bodies must keep personal information in Canada and pass that duty on to suppliers
  (for example under Nova Scotia's PIIDPA). Tenants doing public-sector work should check their contracts.

Confirm with counsel which of these apply to a given tenant or feature.

## PIPEDA's 10 principles at Fishtape

| principle | what Fishtape does |
| --- | --- |
| 1. Accountability | Kelvin is the privacy officer. This policy, the controls register and contracts with vendors. |
| 2. Identifying purposes | The privacy notice says why each kind of data is collected. Tenants set the purposes for their own data. |
| 3. Consent | Sign-up records acceptance of the terms and notice. CASL consent fields for marketing messages. Tenants obtain consent from their customers and crews. |
| 4. Limiting collection | Collect only fields the features need. No SIN, health or banking fields in the product. |
| 5. Limiting use, disclosure and retention | Tenant data used only to provide the service. Retention per [backup-retention.md](backup-retention.md#data-retention-schedule). No selling or sharing for advertising. |
| 6. Accuracy | Tenants and their users can correct records; sync keeps a history of overwritten versions. |
| 7. Safeguards | The controls in this folder: MFA, row-level security, encryption, audit logging, backups. |
| 8. Openness | Public privacy notice and sub-processor list (planned); these policies are public. |
| 9. Individual access | Access and correction requests handled as below. |
| 10. Challenging compliance | Complaints go to the privacy officer; people are told they can complain to the Privacy Commissioner of Canada or their provincial commissioner. |

## Data residency

Fishtape's stance: Canada preferred for hosting and backups. The production host's location is still
to be confirmed; the offsite backup location must be in Canada. Some vendors process data outside
Canada (see [vendor-management.md](vendor-management.md)), and AI features send tenant data to the
AI provider the tenant chose. PIPEDA doesn't forbid this, but Fishtape stays accountable and must be
open about it. Alberta PIPA also expects organizations to tell people when service providers outside
Canada are used (confirm with counsel). So Fishtape:

- publishes a sub-processor list with the country where each one stores or processes data;
- gives tenants that list so they can tell their own customers and crews;
- tells tenants before adding a sub-processor that will see their data.

## Breaches

A breach of security safeguards is any loss of, unauthorized access to, or disclosure of personal
information resulting from a breach of Fishtape's safeguards or a failure to have them. Handle it as
an incident ([incident-response.md](incident-response.md)), then:

1. Contain it and find out what data, which tenants and how many people are involved.
2. Assess whether there is a real risk of significant harm (RROSH). Consider how sensitive the
   information is and how likely it is to be misused. Significant harm includes humiliation, damage
   to reputation or relationships, financial loss, identity theft and loss of business opportunities.
3. Notify as required (below), and record the breach whether or not it is reported.

### Tenant data (Fishtape as service provider)

Notify every affected tenant promptly, with a target of within 72 hours of confirming the breach,
with what is known so far, so the tenant can meet its own duties. Keep helping with facts as they
come. The tenant, as the organization in control, decides on reports to commissioners and notices to
individuals; Fishtape can draft them.

### Fishtape's own data (Fishtape in control)

- PIPEDA: if there is a real risk of significant harm, report to the Office of the Privacy
  Commissioner of Canada and notify affected individuals as soon as feasible after determining the
  breach happened. Also notify other organizations or government institutions that may be able to
  reduce the harm (for example a bank, or the police).
- Alberta PIPA: notify the Alberta Information and Privacy Commissioner without unreasonable delay
  when a reasonable person would consider there is a real risk of significant harm. The Commissioner
  can require notice to individuals. Confirm with counsel.
- BC PIPA: had no mandatory private-sector breach reporting when this was written; voluntary reporting
  to the BC commissioner is encouraged. Amendments have been proposed, so confirm with counsel.
- Quebec (once there are Quebec users): a confidentiality incident that presents a risk of serious
  injury must be reported promptly to the Commission d'accès à l'information and to the people
  affected, and every confidentiality incident goes in a register (kept at least 5 years under the
  regulation; confirm with counsel).

### Breach record

Every breach, reported or not, gets a record kept for 3 years (PIPEDA requires at least 24 months
after the breach is determined). Stored in the encrypted evidence store. Fields:

- id, date and time the breach was determined, date or period it happened (or best estimate)
- how it was discovered, and a description of what happened
- personal information involved, number of people (or estimate), tenants affected, provinces
- whether Fishtape was in control or acting for a tenant
- the RROSH (or Quebec "serious injury") assessment and the reasoning
- reports made (OPC, Alberta, CAI, other) with dates and reference numbers, or why none were made
- tenants, individuals and organizations notified, with dates and method
- containment and recovery steps, root cause, follow-up actions and owners
- link to the incident record and post-incident review

## Access, correction and deletion requests

- A tenant's customer or crew member asks Fishtape: forward the request to the tenant within 5
  business days and tell the person it was passed on. Don't answer for the tenant.
- A tenant asks Fishtape for help: Fishtape provides the export or makes the correction or deletion
  through the product or HQ (audited), in time for the tenant to answer within the legal limit
  (30 days under PIPEDA, with extensions allowed in some cases).
- A request about Fishtape's own data (a tenant user's account): Fishtape answers within 30 days.
  Verify identity first, through the account or a known email.
- Deleting a whole tenant: [docs/runbooks/offboard-tenant.md](../runbooks/offboard-tenant.md).
  Deleted data stays in encrypted backups for up to about 8 weeks on the server and about 13 months in the offsite weekly copies, then ages out. Say so in the reply.

## Location while clocked in

Fishtape can fill in timesheets from where a worker is while they are clocked in: which job they
are at, and the time spent travelling between jobs. Employee location is sensitive. Canadian privacy
commissioners treat GPS tracking of employees as acceptable only when it serves a clear, legitimate
purpose, collects no more than that purpose needs, and employees are told about it in advance. That
is the standard here: PIPEDA principles 2 to 5 (and PIPEDA itself for federally regulated employers),
Alberta PIPA and BC PIPA for employee personal information in those provinces, and the same practice
everywhere else. Each tenant is the organization in control of its crew's location data; Fishtape
is its service provider. Confirm with counsel before launch, in particular whether a tenant may make
location a condition of using the clock (today it is the worker's choice).

| question | what Fishtape does | where |
| --- | --- | --- |
| Purpose | Hours and travel time against the right job, and checking timesheets before payroll. Not discipline about where someone goes on a break, not sold, not advertising. Stated in the notice. | `js/lib/location-policy.js` |
| When | **Only while clocked in.** A fix is taken at clock-in, clock-out, start of travel and arrival, and in the browser every 3 minutes while the app is open on a running shift. Every capture path first checks that the person has an open shift; the fix is dropped if they clocked out meanwhile. Nothing is captured before clock-in, on days off or after clock-out. | `js/lib/shift-tracker.js`, `js/lib/clock.js` `recordPoint` |
| iOS background | Only while a shift is open: region monitoring (one circle per job site, at most 18) and significant location changes, which iOS runs at low power. No continuous GPS, no route. Clock-out (or the app finding no open shift) stops it, and a shift left open more than 18 hours stops itself. "Always" permission is asked only after "While Using", with plain wording in `Info.plist`. | `mobile/ios/App/App/Plugins/FishtapeGeofencePlugin.swift` |
| Notice and consent | The first time each worker clocks in, a notice shows the company's policy text (the owner can edit it; a plain default is provided) and the current settings (retention period, live map on or off). The worker allows or declines; the answer is recorded per policy version (`locationConsents`, only the worker can record it). Changing the text, the live map or the retention asks everyone again. Declining still lets them clock in. They can change their answer any time under Time clock > My location. | `js/lib/location-ui.js` `ensureConsent` |
| Access | **Workers see all of their own location records** (Time clock > My location: map and list). Raw points are readable only by the person they belong to, managers and owners included, enforced by a RESTRICTIVE row-level-security policy on the member's employee id (`0140_location_access.sql`, `0141_location.sql`), by the API (own rows only), and never by API keys. Managers see time entries: the job, hours, travel, and the clock-in fix with its distance from the site and an "off site" flag to review. | `server/src/auth/access.js`, `server/src/collections.js` |
| Live tracking | **Off by default.** A company can turn on "Live crew map while clocked in"; then managers see the latest point of each person clocked in now (last 12 hours), never anyone off the clock and never a history. Turning it on re-asks every worker, and the map shows only those who said yes to that notice, from points recorded after they did. Every view of the map is written to the audit log. | `GET /api/v1/location/live` |
| Retention | Raw points are deleted after **90 days** (owner can set 7 to 730). A daily worker job empties and soft-deletes old points (the tombstone keeps only the worker's employee id so their devices drop their copy) and removes the clock-in/out coordinates from time entries that old; hours, jobs, distances and flags stay as payroll records. Devices also prune their own copies. Raw points are never copied into record history, and history copies of time entries leave coordinates out. Each run is audited. | `server/src/services/location.js` |
| Minimisation | 6 decimal places, accuracy in whole metres. Clock-in coordinates are left out for API keys and never sent to the AI assistant. HQ (BYPASSRLS) reads location tables only for the audited company export and counts. | `access.js` `redactForReader`, `ai/data.js` |
| Third parties | Map tiles come from Natural Resources Canada (CBMT, Open Government Licence – Canada); the request shows the map area of a job site, never a person's position (pins are drawn on the device; the My location and crew maps fetch only tiles near job sites and stay blank elsewhere). The "Find address" button sends a job's street address to NRCan's Geolocator. Both are Government of Canada services in Canada. Add both to the sub-processor list. | `js/lib/minimap.js`, `js/lib/geocode.js` |
| Requests | A worker's request to see or correct their location data goes to their employer (the tenant). Workers can already see everything held about them in My location; corrections are made to time entries by the foreman or office. | |

Tenants should tell their crews before turning location on, keep the policy text accurate for their
province and any collective agreement, and not use it for anything the notice doesn't say.

## Location, photos and signatures on field tickets and signed documents

From Release 1 (contract `docs/releases/r1-get-paid.md` 2.2, 2.10, 4.1, 4.2), a crew member's phone
records signed extra-work and T&M tickets, and the office's iPad records signatures on estimates and
change orders. Each signature keeps the signer's name (and title and email when given), the
signature image, the device time, a snapshot of what was signed and its digest, and, when
`settings.tickets.captureLocation` is on (the default, contract question 15), **one location fix
taken at the moment of signing** (latitude, longitude, accuracy, time). Tickets can carry up to four
photos of the work. The people involved are the customer's signer (often a general contractor's
site staff or a homeowner, not the tenant's employee) and the crew member who captured it.

| question | what Fishtape does |
| --- | --- |
| Purpose | Evidence that the extra work was requested and agreed, at the site, at that time: to get paid for it and to settle disputes. Not tracking of the signer or the crew, not marketing. |
| Notice | The signing screen tells the signer, before they sign, that their name, signature, the time and the device's location are kept with the ticket and that they can ask for a copy; a copy is emailed when they give an address. Kelvin tells TG's crews that a location is recorded with each ticket signature (contract section 15, item 17). |
| Minimisation | One fix at signing, never continuous and never in the background; no fix when the setting is off or the device refuses permission (the ticket is still accepted and the refusal is noted). Photos are downscaled on the device (at most 250 KB each). No ID numbers or other documents of the signer are collected. |
| Access | Office roles (the `invoices` permission) see tickets and signatures; a crew member sees the tickets they wrote; field roles never see prices. Signatures are never deleted, only voided with a reason by the office (audited). Not readable by the AI assistant or MCP agents (contract question 18). HQ reads them only through the audited company export. |
| Retention | Kept with the tenant's business records (the contract and billing evidence) for the life of the account, then exported and deleted at offboarding; they age out of backups like all tenant data. Per-record retention and legal hold come in Release 2. |
| Requests | A signer's request to see or correct their information goes to the tenant (the organization in control); a signed record is corrected by voiding it and signing again, never by editing it. |
| Third parties | None: the fix comes from the device, and no map or geocoding service is called for it. |

Counsel to confirm the notice wording and that recording a third party's location with their
signature is reasonable for this purpose in each province where Fishtape operates (VERIFY).

## QuickBooks Online

A tenant can connect its own QuickBooks Online company (contract:
[docs/integrations/quickbooks.md](../integrations/quickbooks.md)). Data then flows both ways, only
because the tenant asked for it: customers, products and services, estimates, invoices, payments,
supplier bills and receipts, purchase orders, and approved time (hours, job and the employee's name).
The tenant is the organization in control of that data on both sides; Fishtape is its service
provider, and uses the data only to run the sync.

| question | what Fishtape does |
| --- | --- |
| Who can see it | Office roles only (owner, admin, office). Nothing from QuickBooks is stored on records field crews read: QuickBooks ids, sync state and settings live in office-only tables, and QuickBooks customer notes are never pulled. HQ sees counts and states only, never the company's QuickBooks data. |
| Who can change it | Every change that reaches QuickBooks through Fishtape needs a person signed in with two-step verification; money written by an API key or the assistant waits for an office user's approval. |
| The assistant | Records that sync with QuickBooks (clients, invoices, bills, payments) are ordinary Fishtape records, and Fishtape's assistant, MCP and the tenant's API keys can read them like any other record. QuickBooks' own data (sync tables, look-up results) is never given to them. This is **disclosed** to Intuit, in the terms and the public privacy notice, and on the connect screen ("Fishtape's assistant can read your Fishtape records, including those that sync with QuickBooks"). If Intuit's review asks for opt-in, opt-in per company becomes the rule (contract, open question 13.11). |
| Security | Tokens and the QuickBooks company id are encrypted (AES-256-GCM, key outside the database) and never shown, logged or sent to HQ. |
| Disconnect and deletion | Disconnecting revokes Fishtape's access at Intuit at once. Links, sync history, mappings, reference lists and queued changes are deleted at once if the tenant ticks "delete now", else after 30 days. Records that came from QuickBooks stay the tenant's own Fishtape records (like any import). Closing a Fishtape account disconnects QuickBooks first. Backups age out in about 8 weeks. Retention: [backup-retention.md](backup-retention.md#data-retention-schedule). |
| Where it lives | On the Fishtape server whose hosting region was given to Intuit ([vendor-management.md](vendor-management.md#intuit-quickbooks-online)). Intuit's own processing is under its terms with the tenant. |
| Requests | A person's request about data in the tenant's books goes to the tenant (section above). Correcting a record in Fishtape syncs to QuickBooks. |

The public privacy notice and the terms (`site/privacy.html`, `site/terms.html`) must name Intuit
QuickBooks as a service the customer connects, carry the AI disclosure above, and the line
"QuickBooks and Intuit are trademarks of Intuit Inc." (checklist step 8 of the contract; a lawyer's
final text).


## CASL

Tenants use Fishtape to send email and SMS sequences, which are often commercial electronic messages.
The tenant is the sender and needs consent; Fishtape builds the tools so they can comply:

- Consent: record express consent (what, when, how, wording shown) or the basis for implied consent
  (for example a recent purchase or inquiry) on each contact. Sequences skip contacts without consent.
- Identification: every message names the sender and includes a mailing address and one other way
  to reach them (phone, email or website).
- Unsubscribe: every email has a working link, every SMS honours STOP. Unsubscribes take effect at
  once in Fishtape, well within the 10 business days CASL allows.
- Records: consent and unsubscribe records are kept while messages are sent, plus 3 years.

Fishtape's own marketing to tenants follows the same rules.

## Quebec (later)

Before the first Quebec tenant: a privacy impact assessment before personal information leaves
Quebec, the person in charge of personal information published on the website, a confidentiality
incident register, privacy-protective default settings, and French for contracts, the interface and
customer communications. Confirm the full list with counsel.

## Evidence

- Privacy notice and sub-processor list (once published), with git history.
- Breach records and tenant notices (encrypted evidence store).
- Request log: date received, type, who handled it, date answered.
- CASL consent records in the product (once built).

## Exceptions

None for legal duties. Process changes go through [information-security.md](information-security.md#exceptions).

## Review log

| date | reviewer | result | notes |
| --- | --- | --- | --- |
| 2026-10-19 | Kelvin Waldner | First version | Drafted with an AI agent; adopted when Kelvin merges it. Needs a review by privacy counsel before launch. |
| 2026-10-20 | Kelvin Waldner | Location while clocked in | New section for GPS time tracking, drafted with an AI agent. Counsel to confirm the consent model for each province before launch. |
| 2026-10-20 | Kelvin Waldner | QuickBooks Online | New section: two-way sync at the tenant's request, the AI disclosure, deletion on disconnect. |
| 2026-10-20 | Kelvin Waldner | Ticket signatures | New section: one location fix, photos and the signature kept with field tickets and signed documents (Release 1). Counsel to confirm the notice wording. Backup ageing updated for the offsite weeklies. |
