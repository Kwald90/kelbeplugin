# Values to verify

Two lists: Release 1's tax, payroll and legal values (first), then the CEC values.

## Release 1: tax, payroll and legal values

From the [Release 1 contract](../releases/r1-get-paid.md) (section 14 has the questions and the
defaults the code uses). The rule-table keys (`platform_rules`, seeded by migration 0160, edited
on HQ → Rules; company overrides on Books → Rules) never drive a deadline while their status is
`verify`: a `rate` falls back and says so, a `policy` applies and shows "unconfirmed". Each stream
adds its VERIFY items here through its merge report; the Lead keeps the list.

Who confirms: **A** accountant, **L** construction lawyer, **K** Kelvin, **T** Travis, **HQ**
Fishtape staff (published values).

### Sales tax (R1-B; `docs/code/tax.md`)

| Item | What the app does now | Where | Who |
| --- | --- | --- | --- |
| When Manitoba RST is due on holdback: at the progress bill or at release (question 3) | Deferred to the release invoice; shown "unconfirmed" with a one-click override. If RST was due at billing, the deferred RST is remitted late with interest. | rule `tax.MB.rstHoldbackAtRelease`; `money.js holdbackSnapshot` | A |
| The same for SK and BC PST | Deferred to release | rules `tax.SK.pstHoldbackAtRelease`, `tax.BC.pstHoldbackAtRelease` | A |
| A separately billed out-of-pocket disbursement (hotel, meals) outside RST (question 26) | Offered in Manitoba as a line with RST off, "unconfirmed" | rule `tax.MB.passThroughAllowed`; `tax.js TAX_OFF_PRESETS` | A |
| The same line outside the holdback base (question 26) | Excluded | rule `holdback.excludePassThrough` | L |
| Exemption number formats: MB RST 7 digits, SK vendor's licence 7 digits, BC `PST-1234-5678` | Warnings only, never refused | `tax.js exemptNumberProblem` | A |
| Evidence each exemption basis needs (number; end customer for a GC passing on an exemption; registry number and band or reserve; farm certificate; federal department and number) | A Manitoba invoice without it is not sent | `exemption.js EXEMPT_EVIDENCE` | A |
| Current wording of Manitoba Bulletins 004, 030, 031 and 033 and RST Guide 700 | The hints quote Bulletins 004, 005 and 031 | `tax.js TREATMENTS['gst-only'].hints` | K (pull the PDFs) |
| RST on a security deposit follows GST's s.168(9) timing (question 4) | No tax until applied | `money.js depositInvoiceLine` | A |
| Tax on a forfeited deposit (Excise Tax Act s.182; question 27) | Flagged for the accountant; no tax computed. A forfeited prepayment counts as revenue. | `money.js revenueCents`; R1-D deposits | A |
| Bad-debt write-off: GST s.231 adjustment and the Manitoba RST bad-debt refund (question 27) | A credit note with reason `bad_debt`, flagged on the month-end export | R1-D, R1-E | A |
| Interest invoices are an exempt financial service (question 5) | `taxNoneReason: 'exempt'` | R1-D | A |
| Refund of RST a supplier charged in error on resale material: separate refund application and its time limit | "Ask the supplier for a credit"; write off to cost if refused | R1-E `rst.js` | A |
| Self-assessment on warranty material when the warranty was priced into an RST-charged contract; shrinkage not self-assessed (question 28) | Warranty material self-assessed; shrinkage not | R1-E `rst.js` | A |
| Fishtape's own Manitoba RST registration on subscriptions (what Bulletin 033 changed in 2026) | Not in the app | gap analysis section A.7 | A, K |

### Prompt payment, holdback and liens (R1-D)

| Item | What the app does now | Where | Who |
| --- | --- | --- | --- |
| Which contracts the Act covers (residential, value thresholds) | Alarms on every MB prime contract signed from 2025-04-01, with "check that the Act applies" | rule `pp.MB.appliesTo` | L |
| A deadline on a weekend or holiday moves to the next business day | Shown "may move" | rule `pp.MB.dayRollover` | L |
| Day counts 28, 14 and 7 and the in-force date (published guidance, `sourced`) | Alarms run with "based on published guidance" | rules `pp.MB.*` | L |
| A GC's notice period to its sub | No alarm | rule `pp.MB.subNonPaymentNoticeDays` | L |
| What a proper invoice must contain (question 16) | The seeded list, as warnings | rule `properInvoice.MB.fields` | L |
| Builders' Liens Act holdback percentage | The job's own percentage is used; the rule is shown for reference | rule `holdback.MB.pct` | L |
| Holdback release period: 60 days (MHCA) or 40 days from the certificate (question 2) | The office types the release date; no countdown | rule `holdback.MB.releaseDays` | L |
| Lien deadline under the amended Act | `lastSuppliedOn` recorded; no countdown | rule `lien.MB.days` | L |

### Payroll and burden (R1-E)

| Item | What the app does now | Where | Who |
| --- | --- | --- | --- |
| 2026 CPP, CPP2 and EI rates and maximums (question 9), each January after | The company's flat statutory % with a warning | rules `payroll.CA.*` | HQ |
| WCB Manitoba maximum assessable earnings (yearly) and TG's WCB rate | Flat fallback with a warning | rules `payroll.MB.wcb.maxAssessableCents`, `payroll.company.wcbRatePct` | HQ, T |
| Vacation 4% / 6% after 5 years and the construction holiday pay % (`sourced`) | Used | rules `payroll.MB.*` | A |
| Health and Post-Secondary Education Tax Levy liability (question 32) | Not in burden | rule `payroll.company.healthLevyPct` | A |
| Inventory cost method for the books (question 29) | Moving weighted average | R1-E `stock-counts.js` | A |

### QuickBooks (R1-F)

| Item | What the app does now | Where | Who |
| --- | --- | --- | --- |
| Holdback as a negative sales line on `item.holdback` | Pushed that way | `docs/integrations/quickbooks.md` 17 | A |
| Applying a credit memo with a zero-amount `Payment` | Held in review until confirmed in the sandbox | same | A |
| Grouped receipts (one cheque, several invoices) and the bank deposit | Each allocation is its own payment | same | A |
| Supplier credits as `VendorCredit`, resale RST to `account.rstRecoverable` | Pushed that way | same | A |
| Bad debt as a credit memo with memo "Bad debt write-off" | Pushed that way | same | A |

## CEC values

Everything in `electrical-app/js/lib/cec/` carries a source comment. The values below
could not be confirmed from a public source on 2026-10-19 and are marked `VERIFY` in the
code. They need a check against the printed CSA C22.1:24 (or the provincial edition).
CSA's text is copyrighted, so the code holds numbers and rule/table references only.

Order: things most likely to change a field answer first.

### High: can change a result

| Item | What the app uses now | File |
| --- | --- | --- |
| **Table 9 conduit areas** (2021+: Tables 9A-9H, two per fill level; 40% = 9G) | Confirmed: EMT 16 = 181.3 mm², RMC 16 = 202.3, RMC 21 = 354.0 (from 40% values ÷ 0.4). All other sizes and PVC, ENT, FMC are NEC Chapter 9 Table 4 converted to mm². CSA EMT 16 is 7.5% smaller than the US figure, so **unconfirmed EMT sizes probably read a little generous**. Leave margin until checked. | `conduit.js` |
| Table 6 conductor areas (6A RW90 XLPE 600 V unjacketed, 6K TWN75/T90 Nylon) | Confirmed: RW90 #14 = 8.867 mm², #10 = 15.69 mm². Others are NEC Table 5 (THHN, XHHW) converted. | `conduit.js` |
| Rule 8-202(3)(a) apartment demand bands | 100% / 65% (next 2) / 40% (next 2) are confirmed; **25% for the next 15 and 10% for the rest** are not. | `amendments.js` (`RULE_PARAMS['8-202']`) |
| Rule 8-202 heating across units and 2024 EV demand factors | Section 62 demand applied to the total heating of all units; EV at 100% (City of Vancouver form; Manitoba amendment says 100% unless an EMS). ESA's Ontario example used 90%. | `loads.js` |
| Table 13 rows and the breaker rating series | Next standard rating up to 800 A (cap confirmed for 2024). Fuse ratings 15-600 A confirmed (CSA Class H series); breaker steps and steps above 600 A are the NEC 240.6(A) list. | `conductors.js` |
| Table 2 / Table 4 60 °C columns | Confirmed for #14 and #12 Cu (15, 20 A) and #6 Al (40 A). The rest equal NEC Table 310.16. | `conductors.js` |
| Table 4 rows 12, 10, 3 AWG Al | Equal NEC Table 310.16. | `conductors.js` |
| Table 5A points other than 90 °C @ 40 / 50 °C and 75 °C @ 40 °C | Formula values, same as NEC. (Pre-2012 CEC values were lower.) | `conductors.js` |
| Rule 12-3034 details | Bare bonding conductors not counted (the rule counts insulated conductors); the deduction for devices deeper than 25.4 mm is not modelled; connectors as 1 per pair (ABB's reading). | `boxes.js` |
| Table 23 itself | Volumes from the ABB/Iberville catalogue (CEC 2012 basis). 3 × 2 × 2-3/4 in, 3 × 2 × 3-1/2 in and utility boxes are not listed. | `boxes.js` |

### Medium

| Item | What the app uses now | File |
| --- | --- | --- |
| Table 16 rows other than 20, 60, 200, 800 A | Nexans handbook reprint of the table (older edition). Whether Rule 10-614 or 10-616 points to it in 2024 (sources differ). | `bonding.js` |
| Tables 44 and 45, 2024 column set | Handbook reprint has 115/230/460/575 V (3φ) and 115/230 V (1φ); our 200 V and 208 V columns are 230 V +15% / +10% per the table note. Values equal NEC 430.250 / 430.248. | `motors.js` |
| Table 29 for other motor types and starting methods | Only squirrel-cage across-the-line is modelled (175 / 300 / 250%). | `motors.js` |
| Table 1 60 °C column, all of Table 3 | NEC Table 310.17 values. Free-air sizing is an option in the wire-size calculator. | `conductors.js` |
| Table 5B (several single conductors in free air) | Not applied. | — |
| Voltage-drop resistance | DC resistance at 75 °C from NEC Chapter 9 Table 8, converted to Ω/km. Check against the CEC Appendix D voltage-drop data. Rule 8-102(3) and the dwelling branch-circuit length table (e.g. #14 Cu on 15 A = 38 m) are not modelled. | `voltage-drop.js` |
| CSA C235 voltage table | System list taken from utility service pages and Rule 8-100's divisors; the standard itself is paywalled. | `systems.js` |
| Rule 62-118 details | 10 kW at 100% then 75% where each room has a thermostat; central heat at 100%. Subrule letters not confirmed. | `loads.js` |

### Not built (no source)

- **Table 14** (W/m² and demand factors by occupancy, Rule 8-210): only one unreliable figure
  (offices 50 W/m²) was found, so the non-dwelling occupancy calculator was not built.
- Rule numbers for: hallway receptacles, the split / 20 A T-slot counter circuit rule,
  microwave and bathroom dedicated circuits, the 14-30R dryer receptacle, the panel
  directory rule (2-100 covers marking), fault-current labels, working-space illumination,
  NMSC bending radius, flush box mounting (12-3016?). These items are left off the CEC
  checklists rather than given a guessed number.

### Adoption facts to confirm

- Nunavut's edition in force (last found: CEC 2015).
- City of Vancouver's adoption date for CEC 2024; whether Winnipeg amended its by-law.
- Alberta's Electrical Code Regulation number; Yukon's 2024 variance bulletins; PEI's
  department name and the Schedule 1 rule for services over 200 A.
- New Brunswick: the regulation says 2026-03-15; a third-party table says July 2026.
