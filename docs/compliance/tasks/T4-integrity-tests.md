# T4 — Calculation & output integrity tests (CEC / tax / money)

**Closes toward green:** SDL-10 (`partial`).
**Lane:** B — real tests that run in CI. Verifiable, independent of the API build.

## Why it isn't green

SDL-10 requires money as integer cents, measurements in SI units, and CEC/tax/electrical formulas to
**cite their source and be covered by unit tests**. Unit tests exist for electrical calculations and
units (`electrical-app/tests/electrical.test.mjs`, `units.test.mjs`), but CEC-table, tax-rate, and
money tests are called out as still being added.

## Deliverable

Add focused unit tests under `electrical-app/tests/` (and `server/test/` if money math lives
server-side). Before writing, read the modules under test:

- CEC: `electrical-app/js/lib/cec/` (checklists, ampacity/derating tables, conductor sizing). Assert a
  handful of known-good values against a **cited** rule/table and that each table entry carries its
  source reference. Pure functions — no network, no DOM.
- Tax: find the GST/PST/HST rate source (search `electrical-app/js` for tax/rate). Assert rates per
  province and that a line-item total computes correctly in **integer cents** (no floating-point
  drift: e.g. 3 × 999¢ = 2997, not 29.97 rounding errors).
- Money: assert money is stored/computed as integer cents end-to-end for an estimate/invoice path;
  round only at display. Add a regression test for a known rounding trap.

Keep each test deterministic and self-describing (the `describe`/`test` names cite the rule/rate).

## Acceptance

- New tests pass: `node --test electrical-app/tests/*.test.mjs` (and the server test if added via
  `cd server && node scripts/with-embedded-pg.js node --test test/<file>.test.js`).
- Tests assert on **source-cited** values, not just "it runs".
- `node .github/scripts/check-csp.mjs` still passes (no inline/eval introduced).
- In the same commit, set SDL-10 `notes:` to "CEC/tax/money reproducibility tests added"; move SDL-10
  to `implemented` once CEC + tax + money each have coverage.

## Do not

- Do not copy CSA/CEC copyrighted table *text* into the repo — assert against numeric values with a
  rule-number citation only (matches the existing `electrical-app/js/lib/cec/` convention).
