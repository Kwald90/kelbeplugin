# Getting paid: tickets, deposits, payments, disputes, collections and closeout

Release 1 ([build contract](../releases/r1-get-paid.md) 4.1 to 4.8, 7.3, 10.1). This is the office's side of
getting paid. The crew's side (writing and signing field tickets) is in [field tickets](../field/tickets.md).
Prompt payment dates and alarms are in [prompt payment](prompt-payment.md).

Every screen here is office only: it needs the invoices permission, and crews never see prices, costs, limits
or totals. The libraries behind it are `electrical-app/js/lib/receivables.js`, `closeout.js`, `tickets.js` and
`esign.js`. The server's daily job (`server/src/services/receivables.js`) uses the same code.

## Field tickets in the office

Open **Field tickets**, or the **Tickets** tab on a job.

- **Fixed-price jobs.** A signed ticket, or one the customer refused to sign, is priced with **Price as change
  order**. Labour is priced at the job's T&M rates, material at the price book price (cost plus markup when an
  item has no price), and equipment at its bill rate. The change order is saved as pending. Check it and get it
  signed on the **Change orders** tab. A refused ticket's change order says "Unsigned: written notice given
  <date>". When an invoice line bills the change order, its tickets are marked billed when the invoice is
  marked sent.
- **T&M jobs.** Tickets are never priced as change orders. **Build invoice from time & material** picks up the
  job's signed and refused tickets in the date range and compares, day by day, the hours billed from time
  entries with the hours signed on tickets. A day with more hours billed than signed needs a reason before the
  invoice is created. The invoice keeps the tickets (`ticketIds`) and the day-by-day comparison. Saving it marks
  those tickets billed. With **Field tickets → Settings → T&M invoices bill hours from: Signed ticket hours**,
  labour is billed from the tickets instead (lib/tm.js, R1-E).
- **Service calls** (job kind "Service call" on the contract card). When a signed ticket syncs, the server
  drafts the invoice from it within 15 minutes and numbers it, and the office is told "Price within the hour".
  Check the prices and send it. The existing send flow emails or texts the pay link.
- **Written notice.** When a customer refuses to sign, the server emails the general contractor a written
  notice of the extra work: "Written notice of extra work: T-1042 on <job>, done <date>, refused by <name> at
  <time>", with the ticket attached and no money. This happens once, while **Send written notice when a customer
  refuses** is on. Unsigned drafts older than the stale days (default 3) are listed at the top of the ticket
  list. Nothing is sent for them automatically: open one and tap **Send as written notice**.
- **Copies.** When the signer gave an email, they get a copy once the ticket syncs. **Send copy now** sends
  another.
- **Accepted by email.** On a ticket, an estimate or a change order, **Customer accepted by email** records
  the acceptance with a photo or screenshot of the reply.
- Without email on the plan (Starter), print the ticket or the notice and hand it over.

## Signing estimates and change orders on the iPad

- **Estimate → Sign on this device.** The customer sees the number, title, scope, total with tax, valid-until
  date and notes, and signs. The estimate becomes accepted, and its signature is kept with a snapshot of what
  was signed. A signed estimate cannot be edited. **Revise** makes a copy. Accepting or signing the revision
  marks the original "superseded" and replaces the job's budget. Contract value never counts a superseded
  estimate.
- **Job → Change orders → Sign.** The customer sees the price and signs, and the change order is approved
  today. A signed change order cannot change: void it and add a new one. Change orders merge by id on the
  server, so a change order signed offline and one added by the office at the same time both survive.
- The location is recorded with a signature when **Record the location with each signature** is on
  (Field tickets → Settings). The signer is told before they sign.

## Deposits

- **New deposit invoice** (on a job's money tab, or on an accepted estimate): an amount, or a % of the estimate.
  - **Prepayment** (the default, Invoices → Collections). Taxed now; the % is of the estimate before tax. The
    invoice says "Prepayment: GST/RST charged now and credited on the final invoice."
  - **Security deposit**: no tax until it is applied (Excise Tax Act s.168(9); VERIFY with your accountant that
    RST follows the same timing).
- **Apply deposits** (a draft invoice on the job): lists paid deposits on the job and the client's deposits
  with no job, with what is left. Only paid money can be applied. A prepayment is applied before tax and taxed
  like the deposit was, so tax is not charged twice. It can be applied only on an invoice with the same tax set
  (province, taxes, treatment, exemption). Otherwise, issue a credit note against the deposit and bill again.
  A security deposit is applied with no tax, and tax is charged on the full final amount.
- **Refund** (on the deposit invoice): a credit note against the deposit (reason "deposit refund"), applied to
  it, plus the refund payment going out. This is not the same as a bounced payment (a reversal).
- **Keep deposit** (the customer cancelled): the deposit is marked kept. A kept prepayment counts as revenue
  that day. A kept security deposit is flagged "Ask your accountant" (Excise Tax Act s.182, VERIFY); no tax is
  worked out.

## Receiving payments

**Invoices → Receive payment** (or from a client). Enter one cheque, EFT or deposit. Fishtape splits it across
the client's open invoices, oldest due date first, up to what is collectible on each: the balance less open
disputes and less holdback the customer kept. Edit the split as needed. Every part of the cheque shares a
receipt id, and anything left over is saved **on account**. **Apply credit** later uses on-account money against
an invoice.

A payment recorded while online asks the server to recheck the client's hold right away. Offline payments
are picked up by the next morning's run.

## Disputes, credit notes, back-charges and bad debt

On a sent invoice, under **Disputes and adjustments**:

- **Record dispute**: the amount not paid, the line (optional) and why. Reminders, interest and the past-due
  hold run on the undisputed balance.
- **Concede**: a credit note for the amount (reason "dispute") is made and applied to the invoice, and the
  dispute is closed. **Won**: the dispute is closed and the amount is collected as usual.
- **Back-charge** (the GC deducted cleanup or damage): a credit note with reason "back-charge", applied to the
  invoice it was taken from. It reduces job revenue.
- **Credit note**: for any other reason. A credit note keeps the original invoice's taxes and exemption, so it
  is never re-rated at today's rates. It prints the original invoice's number and date, your GST and RST
  numbers, the reason and the tax adjusted (Excise Tax Act s.232). Numbers run CR-1001 and up.
- **Write off as bad debt**: a credit note for what is left (reason "bad debt"), flagged for your accountant
  (GST s.231 adjustment and the Manitoba RST bad-debt refund, VERIFY).
- An amount agreed "tax included" is turned into a before-tax credit line. GST and RST each round to the cent,
  so a credit for $350.00 may come out as $350.01.

An invoice dated in a closed month is read-only. The **Issue credit note** button replaces editing
([period lock](period-lock.md)).

## Holdback

- **Holdback on an invoice** (a draft standard or progress invoice): **Take holdback** fills in the job's
  holdback %. GST, and the provincial tax while its rule holds, on the holdback are charged at release. The
  invoice prints "Holdback retained (10%)" as a deduction before tax. A holdback that the taxes can't express is
  refused: split those lines onto another invoice.
- **Holdback the customer kept**: on a sent invoice without a holdback, **Customer retained holdback** records
  the amount. The invoice's tax and total do not change. The amount stays owed on that invoice but leaves
  ageing, reminders, interest and the hold. It appears on statements and in the job's holdback ledger.
  **Request holdback release** (job → money) prints a letter listing it per invoice. No release invoice is
  issued for it.
- **Invoice holdback release** (job → money) is offered from the job's holdback release date. The release
  invoice bills what the invoices held back, taxed by the deferred taxes only, and is dated on the release day.

## Collections

**Invoices → Collections** (office) holds these settings:

| setting | default | what it does |
| --- | --- | --- |
| Deposit kind and % | prepayment, none | the defaults on a new deposit invoice |
| Terms printed on invoices | blank | snapshotted on each new invoice (`termsText`) |
| Interest | off | % per year and grace days; see below |
| Hold work when past due more than | 60 days | the past-due hold |
| Hold when over the credit limit | on | exposure over the client's limit holds work too |
| Billing cutoff notice | 3 days before | the GC billing cutoff reminder |
| Remind to close out a complete job after | 14 days | the closeout reminder |
| Prompt payment | on | the Manitoba dates and alarms |
| Reminder steps | none | off until you add a step |

- **Interest.** Interest is charged only on invoices issued with the interest sentence in their terms (Interest
  Act s.4: the yearly rate is always shown, e.g. "Overdue accounts are charged 1.5% per month (18% per year)
  from the due date."). It is simple interest per day on the undisputed balance, less holdback kept, from the
  end of the grace period. It is never charged on interest invoices, and never twice for the same days.
  **Charge interest now** drafts one interest invoice per client. Interest invoices are exempt (VERIFY with your
  accountant).
- **Reminder steps.** **Add the suggested steps** adds four: 3 days before the due date, then 1, 15 and 30 days
  after. Each morning at 07:00 the server queues, for each open invoice, the latest step whose day has come,
  once. The reminder's amount is the undisputed balance less holdback kept. It goes to the client's statement
  email, else their email, else a text to their phone. No reminder is sent for drafts, void, paid, credit and
  interest invoices, release invoices before their due date, a balance that is all disputed, a recorded notice
  of non-payment covering the whole balance, a client with reminders paused, or a client with no contact. Texts
  honour STOP. An invoice shows its reminders.
- **The past-due hold.** Each morning a client goes on hold when something collectible on its invoices is more
  than the hold days past due, or (with "hold over the limit") its exposure is over its credit limit. Exposure
  is open invoices (disputes included), plus holdback still to be released, plus unbilled T&M at sell. The
  office's override on the client's Credit card (hold or release, until a date) wins. The job header shows
  "Past due: hold work". Assigning that client's job on the schedule asks "Dispatch anyway", and the answer
  is recorded on the schedule entry. Field roles see the flag, never an amount.
- **Statements**: **Invoices → Statements**: pick the client and the period. A statement shows the opening
  balance, invoices, credit notes, payments and refunds with a running balance, and ageing of what is
  collectible. Holdback kept, disputed amounts, on-account money, credit notes not applied and deposits held
  are on their own lines. **Print**, or **Email** (company email, Pro and Business).

## Ready to bill

**Invoices → Ready to bill** lists everything that can be billed now, oldest first:

- signed or refused tickets not priced (fixed price) or not billed (T&M);
- approved change orders not billed;
- unbilled T&M;
- complete jobs not invoiced;
- holdback releases that are due;
- proper invoices with no delivery date;
- open disputes.

Two numbers sit on top. **Invoice lag** is the median number of days from a job's completion, or a ticket's
signature, to its invoice, over the last 90 days. **DSO** is days sales outstanding over the last 90 days. The
dashboard shows the count and the oldest item, and price variances (bills above the PO or the price book).
Before a GC's billing cutoff day (job contract card), the office is told: "J-1042: GC billing cutoff on the
25th; 3 items ready to bill".

## Closing out a job

- Setting a job to **complete** shows the final-billing checklist, every item as a warning, and saves it.
  After the closeout reminder days (default 14), the office is told "J-1042 complete 14 days, not closed out".
- Setting a job to **invoiced** runs the checklist again. These items must be cleared first:
  - approved change orders not billed;
  - tickets not priced or billed, and drafts older than the stale days;
  - unbilled T&M;
  - paid deposits not applied, refunded or kept;
  - holdback not released, once its release date has passed.
  These items are warnings only:
  - time waiting for approval;
  - unpaid deposit invoices;
  - open disputes;
  - draft invoices;
  - open purchase orders;
  - permits without a passed final inspection;
  - substantial performance recorded with contract value unbilled (GST may be due: Excise Tax Act
    s.168(3)(c)).
  With a must-clear item open, the office may still mark the job invoiced by giving a reason (at least 10
  characters). The server refuses the change without a checked closeout.
- When substantial performance is recorded and contract value is unbilled, the office is told once (GST may
  be due).

## The daily job and the server

| job | when | does |
| --- | --- | --- |
| `receivables_daily` | 07:00 in the company's zone, once a day | reminders, holds, prompt-payment alarms, GST at substantial completion, billing cutoff, closeout due, holdback due |
| `receivables_client` | after a Stripe payment, and on `POST /api/v1/receivables/recheck/:clientId` | recomputes one client's hold |
| `tickets_sweep` | every 15 minutes (tickets module on) | ticket notifications, copies, written notices on refusal, service-call drafts |

Everything is keyed so it happens once: reminder outbox ids `rem-<invoice>-<step>`, notification refs
(`pp:<invoice>:<step>`, `cutoff:<job>:<month>`, `closeout:<job>`, `holdback_due:<job>`, `gst:<job>`), ticket outbox ids
`tcopy-<ticket>` and `tnotice-<ticket>`, and the service draft `svc-<ticket>`. Holds are written by the system
actor `receivables` only when they change. No other writer can set them.

Routes: `GET /api/v1/statements/:clientId?from&to[&format=html]`, `POST /api/v1/statements/:clientId/send`,
`POST /api/v1/receivables/recheck/:clientId`, `POST /api/v1/tickets/:id/send { kind: 'copy'|'notice' }`. All
need the invoices permission.

## To verify

- RST timing on security deposits (Excise Tax Act s.168(9) covers GST).
- Tax on a kept security deposit (Excise Tax Act s.182).
- Interest invoices as an exempt financial service.
- Bad debt: GST s.231 adjustment and the Manitoba RST bad-debt refund, and how the accountant books it.
