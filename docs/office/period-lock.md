# Closing a month: the period lock and payroll runs

Release 1 ([build contract](../releases/r1-get-paid.md) 2.6, 8.1, 8.2). Once the accountant has
last month's numbers, or a GST/RST return is filed, last month must stop changing. Fishtape does this
with two locks: the **books lock** (a closing date) and **payroll runs** (hours locked by the export
that paid them). Nothing a phone sends late is thrown away.

## The books lock

**Books → Closing date** (owners and admins, signed in with two-step sign-in, never a crew PIN).

1. Pick **Close through** (defaults to the end of last month) and tap **Check what is open**. The
   pre-close checklist lists, without amounts: time entries still open or not approved, shared iPads
   not seen since that day, draft invoices dated in the period, bills still in draft, stock counts
   counted but not posted, signed or refused field tickets not priced or billed, open disputes.
2. Tap **Close**. With anything still open you must say why (at least 10 characters); the counts you
   saw are kept with the lock.
3. Records on or before the date are now read-only everywhere (a lock icon in the app; the server
   refuses edits and deletes with "This is in a closed period (through 2026-09-30). Record a reversal
   dated today instead.").

| a locked… | is changed by |
| --- | --- |
| invoice | a credit note dated today |
| payment | a reversal payment dated today (a bounced cheque, a refund) |
| bill | a supplier credit dated today |
| stock move | an opposite move dated today |
| time entry | a correction entry (Time clock → Timesheets → **Add a correction**) |
| change order approved in the period | a new change order with a negative amount |

What still changes on a locked record: an invoice's status among sent, partially paid and paid (a
payment received today still marks a September invoice paid), its delivery and dispute details and
holdback the GC kept; a payment's card-processor details (the Stripe fee still lands); a bill's
status (open or paid) and its price-variance note. The QuickBooks push may still write an invoice
number.

**Draft invoices are never locked**: edit, re-date, delete or void them. Sending one that is dated in
the closed period is refused: "Re-date this invoice to today."

**Nothing moves into a closed period.** A sent invoice dated in an open month cannot be re-dated into
a closed one (keep its date, or issue a credit note and a new invoice). A change order cannot be
approved with, or moved to, an approval day in a closed period: approve it today. A record deleted
before the close and restored afterwards (by undo, or by QuickBooks) comes back like a late arrival:
posted on the first open day and flagged late.

**Moving the date back** (or clearing it) needs a reason and warns that payroll and filed returns
may no longer match. A closing date must be before today. Every move is kept in the history with who,
when and why, audited, and owners and admins are told.

### Records that arrive late

A payment, bill, stock move, time entry, equipment use or stock count dated in a closed period is
**accepted**: it keeps its own date (a wholesaler's invoice dated 28 Sep stays dated 28 Sep) and is
**posted** on the first open day (`postedOn`), flagged late. A phone that syncs September hours on
2 October, a bill keyed on 8 October, a QuickBooks or Stripe payment dated 30 September: all land.
The office is told once a day, and Books lists them under **Late postings**.

### Refused writes

When the server refuses a change (an offline edit of a locked invoice, say), the device keeps its copy
flagged with the reason, and **Books → Refused writes** lists it for owners, admins and office: who,
which record, why (never the data). Fix it the right way (a credit note, a correction) and **Mark
resolved**. Entries older than 90 days are removed.

### QuickBooks

When QuickBooks is connected, Books shows its own dates beside Fishtape's ("QuickBooks books closed
through 2026-09-30, GST filed through 2026-09-30") and warns when Fishtape's closing date is earlier
than QuickBooks'. Close both through the same day.

## Payroll runs

**Time clock → Timesheets → Export CSV** builds the payroll file as before, then:

- **Late hours and corrections from earlier periods** are listed, ticked, and go in the file as
  prior-period rows with their work date and a `late` column (Wagepoint's file has no dates: they join
  the person's job row). Their overtime is counted on their own week, against the hours earlier runs
  already paid for it: a +1 h correction on a Monday that already had 8 h goes in as 1 h of overtime
  (Manitoba), and a 9 h Friday that waited for approval goes in as 8 h regular and 1 h overtime.
- Entries in the week that are **still on the clock or not approved** are listed: "These 3 entries are
  not in this run. They will wait in Late hours for the next run." With the lock on, the file holds
  exactly what the run locks.
- **Lock these timesheets** is ticked by default. The run is recorded on the server
  (`POST /api/v1/closing/payroll-runs`) and its entries become read-only **by id**, approval included:
  "These hours were exported to payroll on 2026-10-06. Add a correction instead." Other entries on the
  same days are not locked.
- Offline, the file still downloads; the lock waits on **Books → Payroll** ("Lock them now").

**Books → Payroll** lists the runs and the **Late hours** queue: hours worked on or before the last
export that no run took (synced late, approved late or left out). They stay editable and approvable
and go in the next export. An owner or admin can **Reopen** a run with a reason (its hours unlock;
correct the payroll provider by hand); owners, admins and office are told.

`payrollThrough` ("payroll exported through") is informational: it feeds QuickBooks' time lock and the
Late hours queue. It never locks an entry by date.

Vacation and holiday pay: **Books → Payroll** says whether they are paid on each cheque (the default)
or accrued (the month-end export then accrues them).

## For developers

- Pure rules: `electrical-app/js/lib/closing.js` (`lockDay`, `postingFor`, `lockProblem`, `isLocked`,
  `locksFrom`, `isLateHours`); the server runs the same functions in
  `server/src/services/write-guards.js` on every write path (REST, sync, the QuickBooks pull).
- Locks: `server/src/services/period-lock.js` (`period_locks`, append-only; `settings.closing` is a
  server-written mirror devices cannot change). Writes take the tenant's write lock and then the shared
  closing advisory lock; a lock move takes the exclusive one, so they never interleave.
- Routes: `server/src/routes/v1/closing.js`. Refused writes: `sync_rejections` (migration 0160).
- Payroll runs: the `payrollRuns` collection, written only by the closing route (`system:closing`).

## VERIFY

- Late hours take the overtime they add to their own week (against what earlier runs paid). An earlier
  run's own split is never redone: if an earlier run was exported without the lock (and so without
  recording its entries), its hours are not counted and the office checks the late rows by hand.
- Whether a closed period should also refuse new **draft** invoices dated in it (today it does not).
