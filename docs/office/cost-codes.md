# Cost codes

Release 1 ([build contract](../releases/r1-get-paid.md) 2.8). One short list of job phases, so the
estimate, the crew's time, the bills, the purchase orders and the reports all speak the same language.

## The standard nine

**Books → Cost codes → Add the standard codes** (adding them twice never duplicates):

| code | name | notes |
| --- | --- | --- |
| 100 | Rough-in | |
| 200 | Service and distribution | |
| 300 | Trim and finish | |
| 400 | Change orders | |
| 500 | Service calls | |
| 600 | Callbacks and warranty | not billable; material on it is own use (RST self-assessed) |
| 700 | Temporary power | |
| 800 | Low voltage | |
| 900 | General conditions | |

Add your own codes beside them (a code is up to 20 characters and unique among active codes; the
server refuses a duplicate). Turn a code off instead of deleting it, so old records keep their label.

## Where codes are used

Estimate and invoice lines, time entries, bill and purchase-order lines, stock moves, material
requests, field tickets, equipment use and change orders all carry `costCodeId`. A record without one
is "Uncoded" in the reports.

## The crew never picks a code

The office sets each job's **current phase** (Books → Cost codes → Current phase per job). When someone
clocks in to the job, their time takes that phase and their truck (Employees → the truck they drive)
without asking. The time clock shows both under the clock with a **Change** link. Warranty and callback
jobs take the callback code when no phase is set.

**Ask for a code at clock-in when the job has no phase set** (off by default) makes the time clock ask
once in that case.

A foreman or the office recodes a week's entries in approval: Time clock → Timesheets → a person →
**Change cost code**. Entries already exported to payroll are locked; add a correction with the right
code instead.

Code: `electrical-app/js/lib/cost-codes.js`, `electrical-app/js/lib/clock.js` (`clockCoding`),
`electrical-app/js/modules/books.js`, `electrical-app/js/modules/time.js`.

## Open question

Whether cost codes become QuickBooks classes later (question 14). Not in Release 1.
