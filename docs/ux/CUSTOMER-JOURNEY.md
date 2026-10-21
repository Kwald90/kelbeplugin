# Contractor customer journey

Status: planned. Existing email and invoice payment services are foundations;
a complete customer portal and authenticated approval journey were not verified
in the initial review. This file specifies intended behaviour, not shipped features.

## Journey

Enquiry -> quote -> approval -> scheduled visit -> work -> changes if needed ->
completion -> invoice -> payment -> handover and follow-up.

| Moment | Customer sees | Customer action | Staff sees |
| --- | --- | --- | --- |
| Quote | Scope, exclusions, options, total, validity and expected timing | Ask a question or approve | Delivery and decision state, exact version |
| Appointment | Date/window, site, preparation and contact details | Confirm or request a change | Acknowledgement or reschedule request |
| Work | Clear progress/milestones appropriate to the job | Contact contractor | Conversation linked to the job |
| Change | Added/removed work, price delta and timing impact | Approve or ask a question | Decision before additional work proceeds |
| Completion | Plain-language summary, selected photos and documents | Raise an issue or acknowledge | Open issues and acknowledgement |
| Invoice | Breakdown, amount paid, balance and payment choices | Pay | Pending, successful or failed payment |
| Handover | Receipt, relevant warranties/instructions and contact | Download or request service | Complete job history |

## Customer-facing design

Use the contractor's identity and contact details. Design for a phone and plain
language. Start with the current decision or next event. Avoid requiring a full
account for every small interaction, subject to an appropriate secure-link design.
Internal margins, labour costs, crew notes, draft documents, and other customers'
records never appear. Publish only intentionally selected photos and documents.

## Contracts to define before implementation

- Scope access by tenant, customer, document, and action. Define link lifetime,
  revocation, forwarding risks, and verification requirements.
- Keep immutable quote/change versions. Approval records identify the version,
  actor or verification method, time, and evidence. A changed quote requires a
  new decision; never silently apply old approval to new terms.
- Distinguish staff-recorded verbal/email approval from customer acceptance.
- Make approval and payment operations idempotent and handle stale pages.
- Payment success comes from the payment service, not merely a browser redirect.
- Define message preferences, rescheduling requests, and delivery failure recovery.
- Keep existing tenant isolation, audit, entitlement and no-store contracts.
- Resolve required approval wording and business terms before presenting binding
  acceptance. This is product design, not a claim of legal sufficiency.

## Pilot acceptance scenarios

1. A homeowner opens a quote on a phone and understands scope and total.
2. The customer can ask a question without approving the document.
3. An outdated link cannot approve a revised quote silently.
4. Staff can identify externally recorded versus customer-authenticated approval.
5. A customer sees only their own intentionally published information.
6. A change order explains the additional price and schedule impact.
7. Cancelled/failed payments remain unpaid; duplicate callbacks do not double-pay.
8. Completion documents remain accessible under the chosen retention policy.

Use service-call and commercial-project pilot examples. Payment provider, email,
and customer authentication integration tests are required before release.
