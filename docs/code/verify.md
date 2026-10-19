# CEC values to verify

Everything in `electrical-app/js/lib/cec/` carries a source comment. The values below
could not be confirmed from a public source on 2026-10-19 and are marked `VERIFY` in the
code. They need a check against the printed CSA C22.1:24 (or the provincial edition).
CSA's text is copyrighted, so the code holds numbers and rule/table references only.

Order: things most likely to change a field answer first.

## High: can change a result

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

## Medium

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

## Not built (no source)

- **Table 14** (W/m² and demand factors by occupancy, Rule 8-210): only one unreliable figure
  (offices 50 W/m²) was found, so the non-dwelling occupancy calculator was not built.
- Rule numbers for: hallway receptacles, the split / 20 A T-slot counter circuit rule,
  microwave and bathroom dedicated circuits, the 14-30R dryer receptacle, the panel
  directory rule (2-100 covers marking), fault-current labels, working-space illumination,
  NMSC bending radius, flush box mounting (12-3016?). These items are left off the CEC
  checklists rather than given a guessed number.

## Adoption facts to confirm

- Nunavut's edition in force (last found: CEC 2015).
- City of Vancouver's adoption date for CEC 2024; whether Winnipeg amended its by-law.
- Alberta's Electrical Code Regulation number; Yukon's 2024 variance bulletins; PEI's
  department name and the Schedule 1 rule for services over 200 A.
- New Brunswick: the regulation says 2026-03-15; a third-party table says July 2026.
