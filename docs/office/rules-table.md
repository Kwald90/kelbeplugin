# The rules table

Release 1 ([build contract](../releases/r1-get-paid.md) 2.7). Day counts, percentages and yearly
maximums that come from law are never written into the code. Fishtape keeps them in a table, with
where each value came from and whether anyone has confirmed it.

## Statuses and kinds

| status | means |
| --- | --- |
| verified | a lawyer, accountant or the official text confirmed it; who and when are recorded |
| sourced | a published source is cited, not yet confirmed for us |
| verify | unconfirmed or missing |

| kind | used for | on `verify` |
| --- | --- | --- |
| deadline | an alarm or a countdown (prompt-payment day 14 and day 28) | **never runs** |
| rate | a calculation (CPP, EI, vacation pay in burden) | the calculation uses its fallback and says so |
| policy | a yes/no or list Kelvin chose (RST on holdback deferred to release) | applies, and every screen using it says "unconfirmed" |

A yearly value (CPP, EI, the WCB maximum) whose newest row is from an earlier year is treated as
`verify` until this year's value is loaded.

## Where the values live

- **Fishtape's values** (`platform_rules`, seeded by migration 0160): maintained by Fishtape HQ staff
  on the HQ Rules page. Each January HQ loads the year's CPP, CPP2, EI and WCB values from canada.ca
  and WCB Manitoba.
- **Your company's values** (the `rules` collection): **Books → Rules → Override**. A company value
  must name its source; marking it verified needs who confirmed it. For each rule the newest value in
  force wins; on the same date your company's value wins. When Fishtape later publishes a newer value,
  Books warns that yours is older.

Every change is audited. The PWA keeps the last copy for offline use; in the demo the rules table
says "The rules table loads when you're signed in."

`GET /api/v1/rules/effective?province=MB&on=2026-10-20` (any signed-in member) returns the definitions
and the rules in force. (Not `/api/v1/rules`: that path is the `rules` collection itself, the company
overrides, with the usual REST routes.)

## Seeded values (Manitoba unless noted)

| rule | value | status | source |
| --- | --- | --- | --- |
| Prompt payment in force for prime contracts signed on or after | 2025-04-01 | sourced | Manitoba proclamation, S.M. 2023 c. 30 |
| Owner pays a proper invoice within | 28 days | sourced | MHCA; MLT Aikins |
| Owner's notice of non-payment within | 14 days | sourced | MHCA |
| Contractor pays its sub within | 7 days | sourced | MHCA |
| A contractor's notice to its sub | not set | VERIFY | |
| Contracts the rules apply to | not set | VERIFY with a lawyer | |
| Deadline on a weekend or holiday | not set | VERIFY (Interpretation Act) | |
| Adjudicator's determination paid within | 10 days | sourced | MHCA (shown only) |
| Holdback percentage | not set | VERIFY | invoices use the job's holdback % |
| Holdback release period | not set | VERIFY (60 or 40 days) | |
| Out-of-pocket disbursements outside the holdback base (all provinces) | yes | VERIFY with a lawyer | |
| Lien deadline | not set | VERIFY | |
| What a proper invoice must contain | 10 fields | VERIFY with a lawyer | warnings only |
| GST on holdback when released (all) | yes | sourced | Excise Tax Act s.168(7) |
| GST due at substantial completion (all) | yes | sourced | Excise Tax Act s.168(3)(c) |
| RST on holdback when released | yes | VERIFY with the accountant | Kelvin's default |
| PST on holdback when released (SK, BC) | yes | VERIFY with the accountant | |
| Out-of-pocket disbursements without RST | yes | VERIFY (Bulletin 031) | |
| Vacation pay | 4% | sourced | Employment Standards |
| Vacation pay after 5 years | 6% | sourced | Employment Standards |
| General holiday pay (construction) | 4% | sourced | Manitoba construction fact sheet |
| EI employer factor (all) | 1.4 | sourced | Employment Insurance Act s.68 |
| CPP, CPP2, EI rates and maximums for 2026 (all) | not set | VERIFY | HQ loads them before release |
| WCB maximum assessable earnings 2026 | not set | VERIFY | WCB Manitoba |

Company-only rules (no Fishtape value): **Your WCB rate** (from your assessment notice) and the
**Health and Post-Secondary Education Tax Levy** (leave empty when under the exemption threshold).

## VERIFY list

Every `verify` row above is open. A deadline marked VERIFY never raises an alarm; confirm it with the
person named (lawyer or accountant), record who and when, and mark it verified.

Code: `electrical-app/js/lib/rules.js` (definitions, `resolveRules`, `ruleValue`), `server/src/routes/v1/rules.js`,
`electrical-app/js/modules/books.js` (Books → Rules).
