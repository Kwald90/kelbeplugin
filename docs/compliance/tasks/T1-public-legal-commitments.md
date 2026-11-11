# T1 — Public legal commitments (privacy notice, terms + DPA, sub-processor list)

**Closes toward green:** GOV-05, PRV-01, PRV-02, PRV-06 (all `partial`).
**Lane:** A — agent drafts, Kelvin + counsel review before publish. Keep controls `partial` until
counsel signs off; the draft existing is real progress and should be noted.

## Why these aren't green

The internal policies exist in `docs/compliance/`, but there is **no public-facing** privacy notice,
terms of service, data processing addendum (DPA), or sub-processor list. Those are what GOV-05 /
PRV-01 / PRV-02 / PRV-06 require tenants to be given.

## Deliverable

Create drafts under a new `docs/legal/` folder. Plain, Canadian, PIPEDA-aligned; no invented facts —
where a detail isn't known (company legal name, address, privacy contact email), use a clearly marked
`{{PLACEHOLDER}}` and list every placeholder at the top of the file.

1. `docs/legal/privacy-notice.md` — public privacy notice. Must name: what personal information is
   collected and why, that Fishtape is a **service provider/processor** acting on the tenant's
   instructions, retention, the privacy contact, and how to complain to the OPC / a provincial
   commissioner. Source of truth for substance: `docs/compliance/privacy.md`,
   `docs/compliance/data-classification.md`. (PRV-01, GOV-05)
2. `docs/legal/terms-of-service.md` — tenant terms. Service description, acceptable use (cross-ref
   `docs/compliance/acceptable-use.md`), availability expectations (no hard SLA pre-launch), liability,
   governing law = the relevant Canadian province `{{PROVINCE}}`. (PRV-02)
3. `docs/legal/data-processing-addendum.md` — DPA. Processor obligations, purpose/collection limits
   (the product has **no SIN, health or banking fields** — state it), sub-processor flow-down, breach
   notice (target 72h, cross-ref `docs/compliance/incident-response.md`), data location, deletion on
   offboarding (cross-ref `docs/runbooks/offboard-tenant.md`). (PRV-02, GOV-05)
4. `docs/legal/subprocessors.md` — sub-processor list with countries, built from
   `docs/compliance/vendor-management.md`. One table: sub-processor, purpose, data shared, country,
   notice commitment. Mark any country "to confirm" that `vendor-management.md` marks to confirm —
   **do not guess locations.** (PRV-06)

Add a short `docs/legal/README.md` explaining these are drafts pending counsel review, and link them
from `docs/compliance/privacy.md` and `docs/compliance/vendor-management.md`.

## Acceptance

- Four drafts + README exist, internally consistent, every unknown is a listed `{{PLACEHOLDER}}`.
- No personal data, secrets, or invented legal facts.
- `node .github/scripts/check-committed-files.mjs` passes.
- In the same commit, update GOV-05 / PRV-01 / PRV-02 / PRV-06 `notes:` to "public drafts written in
  docs/legal/, pending counsel review"; **leave status `partial`** (publish + counsel sign-off is the
  remaining step, which goes to Lane C in path-to-green.md).

## Do not

- Do not publish anything or change any live site.
- Do not mark these `implemented` — counsel review is required first.
