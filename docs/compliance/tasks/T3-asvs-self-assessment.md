# T3 — OWASP ASVS self-assessment (independent security testing)

**Closes toward green:** SDL-06 (`planned`); confirms RSK-03, SDL-02 as a side effect.
**Lane:** A/B — agent fills the checklist by reading the code; it is review work, not a feature.

## Why it isn't green

SDL-06 requires an annual OWASP ASVS self-assessment recorded in
`docs/security/pentest-checklist-asvs.md`. The checklist exists but is **not filled in** for the
current code.

## Deliverable

Work through `docs/security/pentest-checklist-asvs.md` against the **current** server and PWA code and
record a verdict per item: `PASS` / `GAP` / `N/A (pre-launch)` with a one-line justification and a
`file:line` or test reference. Focus the evidence on what exists today:

- Auth & session handling: `server/src/` auth routes, session token hashing, MFA (note where the API
  layer is still being built — those are honest `GAP (building)` not false PASS).
- Access control / tenant isolation: the `withTenant` helper and RLS — cross-ref
  `server/test/isolation.test.js`, `server/test/leaks.test.js`.
- Input validation: ajv schemas in `electrical-app/js/schema/`, server-side re-validation.
- Output encoding / XSS: the `h()` text-node sink pattern (`electrical-app/js/ui.js`).
- Secrets: `docs/security/secrets-management.md`, key redaction in `server/src/services/gemini.js`.
- Headers/CSP: `deploy/*/security-headers.conf`, `.github/scripts/check-csp.mjs`.
- Dependencies: current `npm audit` state (SDL-02).

At the top, write a dated summary: X PASS, Y GAP, Z N/A, and list every GAP with the control it maps
to and whether it's already tracked (Lane C/D in `path-to-green.md`). Fold any **fraud/misuse**
confirmations (RSK-03: MFA for owners/admins, audited secret changes, no prod access for contractors)
into the relevant ASVS rows.

## Acceptance

- The checklist is filled end-to-end, each item has a verdict + evidence reference, the summary tallies.
- Every GAP is cross-referenced to an existing control/task (no orphan findings).
- In the same commit, set SDL-06 `notes:` to "ASVS self-assessment completed <date>, N gaps all
  tracked"; move SDL-06 to `implemented` (the assessment is the deliverable; the gaps it finds are
  tracked elsewhere).

## Do not

- Do not mark an item PASS that depends on API auth code that isn't written yet — use `GAP (building)`
  and point at BUILD-PLAN. Honesty is the point of the control.
