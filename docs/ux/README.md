# Fishtape customer experience programme

Started: 2026-10-20. Owner: Kelvin. Status: Sprint 01 integrated; Sprint 02
implemented and locally verified on `codex/ux-sprint-02`, pending review and merge.
Deployment and later roadmap work remain.

Make everyday electrical work easy to find, complete, and explain to the customer.
Keep Fishtape's warm neutral palette and yellow accent; improve hierarchy and the
journey from enquiry to payment. Apple-inspired here means clarity, familiar
controls, progressive disclosure, and accurate feedback, applied to a web ERP.

## Documents

- [Design brief and assessment](DESIGN-BRIEF.md): evidence, principles, and target experience.
- [Delivery roadmap](ROADMAP.md): phased work, dependencies, acceptance criteria, and measurement.
- [Customer journey](CUSTOMER-JOURNEY.md): customer-facing requirements and boundaries.
- [Sprint 01](SPRINT-01.md): current implementation scope, agent ownership, and verification.
- [Sprint 02](SPRINT-02.md): job overview, field guidance, progressive onboarding and R1 estimate guidance.

The [build plan](../BUILD-PLAN.md) remains the source for domain and API contracts.
This programme does not replace the existing [backlog](../BACKLOG.md).

## Review basis

The initial review inspected source code and five repository screenshots: phone
My day, estimate editor, invoice editor, work plan, and plan takeoff. The browser
connection was unavailable. Screenshots establish the previous visual direction;
they do not prove the current runtime or usability. No user-study baseline exists.

## First implementation previews

Captured from the integrated local app using synthetic demo data, then visually
reviewed. These show the implemented first sprint, not future portal concepts.

- [Desktop Today](previews/desktop-today.png)
- [Desktop quote editor](previews/desktop-estimate.png)
- [Phone navigation](previews/phone-navigation.png)
- [Phone quote editor](previews/phone-estimate.png)

## Sprint 02 previews

Captured on 2026-10-21 from the integrated demo at desktop and 390px phone widths.
These are browser emulation captures, not physical-device validation.

- [Desktop job overview](previews/sprint02-desktop-job.png)
- [Phone job overview](previews/sprint02-phone-job.png)
- [Phone My day](previews/sprint02-phone-field.png)
- [Desktop setup](previews/sprint02-desktop-onboarding.png)
- [Phone setup](previews/sprint02-phone-onboarding.png)
- [Phone estimate guidance](previews/sprint02-phone-estimate.png)

## Success

A first-time office user can find and prepare a quote, connect approved work to a
job, and identify today's next action. An electrician can find their work and see
whether it has been saved. A contractor's customer can understand scope, timing,
changes, and payment without learning the internal ERP.

## References

- [Apple design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
- [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple touch design tips](https://developer.apple.com/design/tips/)

Apple's point-based native sizing is a reference; validate CSS hit areas and zoom
in the web app on real devices.
