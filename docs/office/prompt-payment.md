# Prompt payment: the Manitoba day-14 and day-28 dates

Release 1 ([build contract](../releases/r1-get-paid.md) 7). Manitoba's prompt payment rules (The Builders' Liens
Amendment Act, in force 2025-04-01) apply to construction contracts. For a prime contract (yours, with the
owner), the owner must do one of two things after receiving a **proper invoice**: give a notice of non-payment
within 14 days, or pay within 28 days. A contractor then pays its subcontractors within 7 days of being paid.
Fishtape shows these dates on the invoice and tells the office the day after a date passes.

Based on published guidance, not legal advice. Confirm deadlines with your lawyer.

## Set up the job

On **Job → Contract and payment → Edit**:

- **Our role**: a prime contract with the owner, or a subcontract to a general contractor.
- **Our contract signed on** (prime), or **Prime contract signed on** for a subcontract (owner and GC; leave it
  blank if you don't know it).
- **Proper invoices required**: every invoice on the job is marked a proper invoice. You can also tick it on
  one invoice.
- Contract number, holdback %, payment terms, the GC's billing cutoff day, the people who may sign for the
  customer, substantial performance and holdback release dates, and the last day you supplied work or material
  (suggested from the last time entry, material move or ticket).

The rules apply when all of these hold:

- the invoice is in Manitoba (the invoice's province, else the company's);
- the governing contract was signed on or after the in-force date;
- the invoice is a proper invoice;
- every day count it uses is confirmed in the rules table.

When a date is missing, the job card says which one to add, and there are no dates or alarms. Contracts signed
before 2025-04-01, or outside Manitoba, get no dates.

## The dates

On the invoice's **Prompt payment** card:

| role | dates |
| --- | --- |
| prime | delivered; notice of non-payment due (delivered + 14 days); payment due (delivered + 28 days) |
| sub | none from day 14 or 28 (they run on the GC's own invoice to the owner). Once you record **The owner paid the GC**, the GC must pay you within 7 days. Until then an information line: "Expected latest about <delivered + 28 + 7> if the GC billed the owner promptly." |

- **Delivered**: the day you record with **When and how was this delivered?** (emailed, uploaded to the GC's
  portal, by hand, by mail, sent from QuickBooks). It defaults to the day Fishtape emailed the invoice. A proper
  invoice with no delivery date asks the question on the invoice and on **Ready to bill**.
- All counts are calendar days. While the weekend rule is unconfirmed, a date that falls on a Saturday or
  Sunday shows "Sat 2026-11-14 (may move to Mon)". Holidays are not known: check them yourself.
- **Record notice of non-payment**: the day it arrived, the amount disputed and the reason.
- While the rule on which contracts the Act covers is unconfirmed, the card adds "Check that the Act applies
  to this contract (residential and value exclusions)."

## The alarms

The daily job (07:00 in the company's zone) tells everyone with the invoices permission, once per invoice and
step:

- **day 14** (prime), the day after the notice was due, when no notice of non-payment is recorded: "No notice of
  non-payment on INV-3010 by day 14: the full amount is due by 2026-11-18."
- **day 28** (prime), the day after payment was due, while an undisputed balance is left: "INV-3010 is past its
  prompt-payment date."
- **gc7** (sub), the day after the GC's 7 days, while a balance is left.

Turn the dates and alarms off on **Invoices → Collections → Prompt payment**.

## Where the day counts come from

Every count is a row in the rules table (Books → Rules, [rules table](rules-table.md)):
`pp.MB.inForceFrom`, `pp.MB.paymentDays` (28), `pp.MB.nonPaymentNoticeDays` (14), `pp.MB.subPaymentDays` (7),
`pp.MB.appliesTo` and `pp.MB.dayRollover`. A deadline never runs on a value with status **verify**. To stop
the dates and alarms while you check a count with your lawyer, add a company row for it with status verify.
They come back when the row is confirmed (sourced or verified).

## To verify (with a lawyer)

- Which contracts the Act excludes (residential, value thresholds): `pp.MB.appliesTo`.
- Whether a deadline on a weekend or holiday moves to the next business day: `pp.MB.dayRollover`.
- The GC's notice period to its sub (`pp.MB.subNonPaymentNoticeDays`); no alarm in Release 1.
- What a Manitoba proper invoice must contain (`properInvoice.MB.fields`); missing fields are warnings only.
- The holdback release period and lien deadline: no countdowns in Release 1. The office types the holdback
  release date on the job.
