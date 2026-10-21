# Release 1, "Get paid and know the margin": the build contract

Revision 2, 2026-10-20. Base commit `7f31af3` on `claude/electrical-concept-app-h4qz12`.
Approved by Kelvin: gap items 1 to 6 of [the gap analysis](gap-analysis-2026-10.md) (section A has the
verified Manitoba RST rules from Bulletin 031).

Implementers build from this file alone. If code needs to differ from it, the change goes into this file
first (the Lead edits it; streams propose changes in their merge report). Everything here follows the
[build plan](../BUILD-PLAN.md) conventions and its definition of done, and the
[QuickBooks contract](../integrations/quickbooks.md) for anything that syncs.

**What changed in revision 2** (from the owner and controller reviews; findings not taken are in
section 16):

- Nothing a phone sends late is thrown away. Bills, payments, stock moves, equipment use, time and counts
  get a posting date (`postedOn`): a record dated in a closed period is accepted and posted on the first
  open day, flagged late, and shown to the office (2.6). Payroll locks entries by id, never by date, and
  late hours roll into the next run (2.6, 8.2). Draft invoices are never locked.
- Signatures are never rejected for their content: a mismatch is stored `unverified` and the office is
  told. Snapshots are versioned. Ticket numbers come from the server. Snapshot amounts are stripped for
  field roles (2.5, 2.10).
- T&M tickets are billed by the T&M builder and reconciled against invoiced hours; tickets carry a pricing
  basis; refused tickets can still be priced and billed with written notice; batch signing; email-reply
  acceptance (4.1).
- Cash flows that a shop actually meets: one cheque across several invoices with on-account credit,
  line disputes, back-charges, holdback the GC kept without being invoiced, a ready-to-bill queue with a
  billing-cutoff alarm, service calls drafted for the office as soon as the customer signs, deposit
  refunds (4.3 to 4.8).
- Credit notes are fully specified and do not collide with the QuickBooks settlement payment (2.6, 9.2).
- Exemptions apply per job, with evidence per basis (2.9, 3.1).
- Costing: effective-dated rates, overtime premium, material returns, server-stamped move costs, a
  moving-average item cost, truck charges once per truck and day, a frozen estimate budget, superseded
  revisions, a revenue definition that holds for holdback and deposits, loss provision in WIP (6, 11).
- Prompt-payment alarms only for prime contracts; subs get the 7-day rule only (7.5).
- Month-end accruals corrected (wages, WIP, named accounts), inventory valued as of the cutoff (8.3, 8.4).
- Backup drill runs off the server and checks secrets decrypt (5).
- Ownership: credit notes, the settings screens, clock-in and the dashboard now have one owner each (13).

Contents:

1. Scope, defaults and rules for every stream
2. Shared foundations (what other streams code against)
3. Item 1: RST fixes
4. Item 2: Get paid
5. Item 3: Offsite backups
6. Item 4: Job costing that tells the truth
7. Item 5: Prompt-payment basics
8. Item 6: Period lock and month-end close
9. QuickBooks impact (all items)
10. Background jobs and notifications
11. Reports
12. Tests and end-to-end scenarios
13. Workstreams, file ownership and waves
14. Open questions for Kelvin and Travis (with defaults)
15. Kelvin's checklist outside the code
16. Considered and rejected

---

## 1. Scope, defaults and rules for every stream

### 1.1 In scope

| # | item | summary |
| --- | --- | --- |
| 1 | RST fixes | Section A changes 1 to 6: per-province `gst-only` hints, exemption basis and evidence per job and document (printed; send blocked in MB without it, warned in BC and SK and on estimates), `docs/code/tax.md` rows, purchase tax per bill line (resale or own use), own-use tags on stock moves and material requests feeding an RST self-assessment view, an out-of-pocket disbursement line with RST off, RST on progress bills net of holdback. |
| 2 | Get paid | Signed T&M and extra-work tickets on the phone (signature, time, photos, GPS, pricing basis, linked to a change order or the T&M invoice), batch and email-reply acceptance, written notice on refusal, on-device signature on estimates and change orders, deposit invoices (prepayment or security deposit, refunds), receiving payments across invoices with disputes and back-charges, collections (statements, disclosed overdue interest, reminder steps on the outbox, past-due hold at dispatch), a ready-to-bill queue and billing-cutoff alarm, service calls drafted for the office when signed, GC credit application and limit, final-billing checklist at job completion and close. |
| 3 | Offsite backups | A drill, run off the server, that restores the newest **offsite** copy into a scratch Postgres and checks secrets decrypt; monitoring and HQ alerts when offsite is missing or stale or the drill is overdue; Kelvin's checklist for an S3-compatible bucket in a Canadian region. No change to the live servers. |
| 4 | Job costing | `jobCosting()` reads bills, receipts, received-not-billed and committed PO cost; bill price above PO or price book is flagged; shared cost codes; burden per employee (statutory % with CPP/EI yearly maximums, plus non-productive %) on effective-dated wages with overtime premium; truck and equipment rates charged to jobs once per truck and day; break-even billing rate; job-profit and WIP reports. Office roles only. |
| 5 | Prompt payment | Contract-signed and substantial-performance dates on jobs, holdback on invoices (including holdback the GC kept on its own) and a holdback release invoice, proper-invoice fields, day-14 and day-28 alarms for Manitoba prime contracts signed on or after 2025-04-01 (subs: the 7-day rule only), every day count in the rules table, GST on holdback at release. |
| 6 | Period lock and month-end | A company closing date with a pre-close checklist (older records read-only, changed by reversal, late arrivals posted to the first open day), timesheets locked once payroll is exported (by entry), a month-end cutoff export with named accrual accounts, inventory valuation by location as of the cutoff with count sheets. |

### 1.2 Not in this release

Schedule of values and CCDC pay applications (gap 14; R1 prints a contract summary block on progress
invoices instead, 7.3), lien countdowns and holdback release countdowns until a lawyer confirms the day
counts (R1 records `lastSuppliedOn`, 7.1), notices of non-payment forms and adjudication packs (gap 23),
object storage (gap 7; photos and signatures stay small data URLs), a per-device sync window for ticket
photos (with object storage), the customer portal (gap 16), payroll rules for Manitoba construction
(gap 8), record retention per record type and legal hold (Release 2 with object storage), pushing
month-end journal entries to QuickBooks (export only), cost codes as QuickBooks classes, Stripe refund
and dispute webhooks, prices on field devices (`serviceTechSeesPrices` is an R3 idea, not a setting).

### 1.3 Defaults until Travis answers (gap section D)

Everything is per company and configurable. No assumption about GC volume beyond holdback basics: any
invoice can carry a holdback, there is no schedule of values. Deposits default to the prepayment model.
Overdue interest is off. Reminders are off until the office turns them on. No credit limits. Vacation and
holiday pay are paid on each cheque (no accrual). T&M invoices bill from time entries. Every default is
listed with its question in section 14.

### 1.4 Rules that apply to every stream

- **The server enforces everything.** The PWA hides and disables; the server refuses (RLS, roles,
  entitlements, module switches, write rules, the period lock). Every new endpoint: permission check,
  entitlement check where gated, audit event on writes, `Cache-Control: no-store`, a cross-tenant test.
- **Field roles never see money.** Electricians and apprentices (and foremen unless
  `settings.foremanSeesCosts`) never receive prices, costs, rates, limits or totals: not in records, not in
  notifications, not in API responses. New money fields are listed in 2.5.
- **Offline first, and nothing from the field is lost.** Field tools (tickets, signatures, clock-in,
  counts) work offline and sync through the queue. The server never rejects a field record for being late
  or for what was signed; it posts it, flags it and tells the office (2.6, 2.10). Office tools that change
  shared state on the server (moving the closing date, locking payroll, sending statements, field
  receiving) need a connection and say so.
- **No legal number in code.** Day counts, percentages and yearly maximums that come from law live in the
  rules table (2.7). A value marked VERIFY never drives a deadline or a countdown.
- **Integer cents, SI units, vanilla ES modules, `h()` from `ui.js`, tokens-only CSS.** New CSS files are
  loaded by their module (the way `modules/purchasing.js` loads `css/purchasing.css`), so `index.html`
  does not change.
- **No new dependencies.** SHA-256 uses `crypto.subtle` in the browser and `node:crypto` on the server.
- **CSP stays strict.** `node .github/scripts/check-csp.mjs` passes. No inline scripts or styles.
- **Any PWA file the server imports is in the `.dockerignore` allow-list** (owner R1-A, list in 2.12).
- **Settings screens.** `modules/settings.js` does not change in R1. Each new setting is edited on the
  screen of the stream that uses it (2.4 names the screen).
- **No deploys, no SSH, no pushes.** Commit on your worktree branch; the Lead merges and deploys.

---

## 2. Shared foundations

Owned by R1-A unless a row says otherwise. Every other stream codes against the names in this section.

### 2.1 Migrations and numbering

| number | file | kind | owner | contents |
| --- | --- | --- | --- | --- |
| 0160 | `0160_r1_platform.sql` | hand-written | R1-A | `platform_rules`, `period_locks`, `sync_rejections`, `doc_counters`, platform rule seed rows (2.7) |
| 0161 | `0161_r1_collections.sql` | generated (`node scripts/gen-collections-sql.js --migration 0161`) | R1-A | the eight new collection tables (2.2) |
| 0162 | `0162_r1_qbo.sql` | hand-written, only if needed | R1-F | `qbo_links.role` adds `'apply'` (9.4) |
| 0163 | reserved | | R1-D | only if needed; say so in the merge report |
| 0164 | reserved | | R1-E | only if needed |
| 0165-0169 | reserved for release fixes | | Lead | |

`server/scripts/gen-collections-sql.js` gets `LATER['0161'] = '0161_r1_collections.sql'`.

`0160_r1_platform.sql` (exact DDL; the seed `INSERT`s follow 2.7):

```sql
-- 0160 Release 1: rules table, period locks, sync rejections, server document counters
-- (docs/releases/r1-get-paid.md 2.6, 2.7, 2.10).

-- Platform rules: legal and statutory values Fishtape maintains for every company (HQ edits them).
-- A company may override a row with its own record in the `rules` collection (0161).
CREATE TABLE platform_rules (
  key            text NOT NULL CHECK (key ~ '^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,5}$'),
  province       text NOT NULL DEFAULT '' CHECK (province = '' OR province ~ '^[A-Z]{2}$'),
  effective_from date NOT NULL DEFAULT '1900-01-01',
  value          jsonb,                       -- NULL = not set; never used by any calculation
  status         text NOT NULL CHECK (status IN ('verified', 'sourced', 'verify')),
  source         text CHECK (source IS NULL OR length(source) <= 500),
  source_url     text CHECK (source_url IS NULL OR (source_url ~ '^https://' AND length(source_url) <= 500)),
  note           text CHECK (note IS NULL OR length(note) <= 1000),
  confirmed_by   text CHECK (confirmed_by IS NULL OR length(confirmed_by) <= 200),
  confirmed_at   timestamptz,
  updated_by     text NOT NULL CHECK (length(updated_by) <= 200),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, province, effective_from),
  CHECK (status <> 'verified' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
GRANT SELECT ON platform_rules TO fishtape_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_rules TO fishtape_hq;

-- Period locks: append-only history. The current lock of a kind is its newest row.
CREATE TABLE period_locks (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id         bigint GENERATED ALWAYS AS IDENTITY,
  kind       text NOT NULL CHECK (kind IN ('books', 'payroll')),
  through    date,                            -- books: records posted on or before are read-only; payroll: exported through (informational); NULL = none
  previous   date,
  reason     text CHECK (reason IS NULL OR length(reason) <= 500),
  preflight  jsonb,                           -- the pre-close counts the owner saw (2.6), no money
  actor      text NOT NULL CHECK (length(actor) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX period_locks_kind_idx ON period_locks (tenant_id, kind, id DESC);
ALTER TABLE period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY period_locks_tenant ON period_locks
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT ON period_locks TO fishtape_app;
GRANT SELECT ON period_locks TO fishtape_hq;

-- Writes the server refused (sync, REST or a system actor): who, what and why, never the data.
CREATE TABLE sync_rejections (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL CHECK (length(actor) <= 200),
  device_id   text CHECK (device_id IS NULL OR length(device_id) <= 128),
  collection  text NOT NULL CHECK (length(collection) <= 64),
  record_id   text NOT NULL CHECK (length(record_id) <= 128),
  code        text NOT NULL CHECK (length(code) <= 64),
  message     text CHECK (message IS NULL OR length(message) <= 500),
  resolved_at timestamptz,
  resolved_by text CHECK (resolved_by IS NULL OR length(resolved_by) <= 200),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX sync_rejections_open_idx ON sync_rejections (tenant_id, at DESC) WHERE resolved_at IS NULL;
ALTER TABLE sync_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_rejections_tenant ON sync_rejections
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_rejections TO fishtape_app;
GRANT SELECT ON sync_rejections TO fishtape_hq;

-- Numbers the server hands out so offline devices never collide (field tickets in R1).
CREATE TABLE doc_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('ticket')),
  next      integer NOT NULL CHECK (next > 0),
  PRIMARY KEY (tenant_id, kind)
);
ALTER TABLE doc_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_counters_tenant ON doc_counters
  USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
  WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);
GRANT SELECT, INSERT, UPDATE ON doc_counters TO fishtape_app;
```

`sync_rejections` rows older than 90 days are deleted by the insert path (one `DELETE … WHERE tenant_id =
$1 AND at < now() - interval '90 days'` per request that inserts).

### 2.2 New collections

Appended in this order to `COLLECTIONS` in both `electrical-app/js/store.js` and `server/src/collections.js`
(the unit test checks they match): `costCodes`, `rules`, `payrollRuns`, `signatures`, `fieldTickets`,
`equipment`, `equipmentUse`, `stockCounts`. All `migration: '0161'`, `portal: null`.

| collection | table | generated columns | read | write | flags | maxBytes | plan feature (`COLLECTION_FEATURES`) | module switch (`COLLECTION_SWITCHES`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `costCodes` | `cost_codes` | `code` (code) | jobs, time, today, estimates, invoices, inventory, dashboard | estimates | | 8 KB | none | none |
| `rules` | `rules` | `rule_key` (key) | invoices, jobs, time, estimates, employees | invoices | unique (key, province, effectiveFrom) (2.6 guards) | 16 KB | none | none |
| `payrollRuns` | `payroll_runs` | `period_to` (to), `status` | employees, time-approve | employees | `managerWrite`; device writes refused (2.6) | 512 KB | `time` | `time` |
| `signatures` | `signatures` | `job_id`, `doc_id` (docId), `doc_type` (docType), `status` | jobs, today, estimates, invoices | jobs, today, estimates | append-only (2.10) | 400 KB | none | none |
| `fieldTickets` | `field_tickets` | `job_id`, `employee_id`, `status`, `number`, `day` (date) | jobs, today, invoices, estimates | jobs, today | `ownRows` | 1.5 MB | `tickets` | `tickets` |
| `equipment` | `equipment` | none | jobs, time, today, inventory | inventory | `managerWrite` | 16 KB | none | `reports`, `inventory`, `time` |
| `equipmentUse` | `equipment_use` | `job_id`, `employee_id`, `equipment_id` (equipmentId), `day` (date) | jobs, inventory, today | jobs, today, inventory | `ownRows` | 8 KB | none | `reports`, `tickets` |
| `stockCounts` | `stock_counts` | `location_id` (locationId), `status`, `day` (date) | inventory | inventory | van owners write their van's counts (2.6 rules) | 512 KB | `inventory` | `inventory` |

Record shapes (every record also has `id`, `createdAt`, `updatedAt`; "?" means optional, nullable):

```
costCodes:    code (≤ 20, unique among active codes), name (≤ 80), group ('rough-in'|'service'|'trim'|
              'change-order'|'service-call'|'callback'|'temp-power'|'low-voltage'|'general'|'other'),
              billable (default true), ownUse? ('warranty'|'callback'|null), active, order, note?
rules:        key, province? ('MB'... or null for all), value (number|string|boolean|array|null),
              effectiveFrom? (YYYY-MM-DD), status ('verified'|'sourced'|'verify'), source?, sourceUrl?,
              confirmedBy? { name, role }, confirmedAt?, note?
payrollRuns:  from, to (YYYY-MM-DD), format (a PAYROLL_FORMATS key), employeeIds[], entryIds[] (≤ 5000),
              lateEntryIds[] (entries from earlier periods included in this run), totals { minutes,
              otMinutes, entries }, exportedAt, exportedBy { id, name }, status ('exported'|'reopened'),
              lockThrough? (YYYY-MM-DD), leftOut? [{ entryId, employeeId, reason }] (acknowledged at export),
              reopenedAt?, reopenedBy?, reopenReason?
signatures:   v (snapshot version, integer), docType ('estimate'|'changeOrder'|'fieldTicket'|'ticketBatch'),
              docId (for a batch: the batch id), docIds[]? (ticketBatch: the tickets, ≤ 30), jobId?,
              clientId?, changeOrderId?, signerName (≤ 120), signerTitle?, signerEmail?,
              method ('on-device'|'email-reply'), dataUrl? (JPEG ≤ 60 KB, safety.js SIGNATURE_MAX_BYTES;
              required for on-device), evidence? { dataUrl (JPEG ≤ 300 KB: a photo or screenshot of the
              reply), receivedAt, from } (email-reply only), signedAt (device ISO time),
              loc? { lat, lng, accuracyM, at }, locStatus?, capturedBy { employeeId?, name, userId? },
              device? (≤ 120), snapshot (2.10), digest (64 hex), status ('valid'|'unverified'|'void'),
              unverifiedReason?, voidedAt?, voidedBy?, voidReason?
fieldTickets: number (null on the device; the server assigns 'T-1001' on the first accepted write, 2.10),
              jobId, clientId?, kind ('tm'|'extra'), date, title (≤ 200), description (≤ 4000),
              requestedBy? (customer's person, ≤ 120), pricingBasis ('contract-rates'|'quote-to-follow'),
              rateSheetRef? (≤ 120, e.g. "rates in contract 24-117"),
              labour [{ employeeId?, name, hours, travel?, timeEntryIds[]? }] (≤ 50),
              materials [{ itemId?, description, qty, unit, stockMoveId?, fromLocationId? }] (≤ 100),
              equipment [{ equipmentId?, description, qty, unit ('hour'|'day') }] (≤ 20),
              photos [{ id, dataUrl, takenAt, width, height }] (≤ 4, each ≤ 250 KB, safety-capture downscale),
              agreementText (snapshot of settings.tickets.agreementText plus the pricing basis sentence),
              signatureId?, signedAt?, signerName?, refusal? { at, by, reason },
              notice? { outboxId, queuedAt, to, kind ('refusal'|'unsigned') },
              status ('draft'|'signed'|'refused'|'priced'|'billed'|'void'),
              changeOrderId?, invoiceId?, costCodeId?, employeeId (author), loc? { lat, lng, accuracyM, at },
              office? { pricedAt, pricedBy, note }
equipment:    name, kind ('truck'|'equipment'|'tool'), unitNo?, plate?, rateCents (cost to the job),
              rateUnit ('hour'|'day'), rateHistory [{ from (YYYY-MM-DD), rateCents, rateUnit }],
              billRateCents? (T&M bill rate), locationId? (its van stock location), defaultEmployeeId?,
              active, note?
equipmentUse: equipmentId, jobId, date, qty, unit ('hour'|'day'), costCodeId?, employeeId, note?,
              source ('manual'|'ticket'), ticketId?, postedOn (server, 2.6), late?
stockCounts:  locationId, date, status ('draft'|'counted'|'posted'|'void'),
              lines [{ itemId, expectedQty, countedQty }] (≤ 2000), countedBy?, countedAt?, postedAt?,
              postedBy?, moveIds[] (the adjustment moves posting made), postedOn (server), note?
```

No money is stored on field tickets, equipment use or stock counts: the office prices tickets into change
orders or the T&M invoice, and costs come from the rate in force on the day (6.1).

Sync budget: a ticket is at most about 1.1 MB (4 photos at 250 KB plus text). At 50 tickets a week an
office device downloads about 55 MB a week; a crew phone downloads only its own (`ownRows`). Object
storage (Release 2) removes photos from sync.

### 2.3 New fields on existing collections

All optional (old records stay valid). R1-A adds them to the JSON Schemas with types and descriptions;
other streams do not edit schemas (a missing field goes in the merge report).

| collection | new fields |
| --- | --- |
| `clients` | `taxExemptNumber` (≤ 40), `taxExemptBasis` (`'resale'|'subtrade'|'pass-on'|'federal'|'first-nations'|'farm'|null`), `taxExemptProvince`, `taxExemptDetails` `{ name, registryNo, band, reserve, farmCertNo, department, endCustomer, note }`, `taxExemptCheckedAt` (evidence on file; it does not apply by itself, 2.9); `credit` `{ applicationStatus ('none'|'sent'|'received'|'approved'|'declined'), applicationSentAt, applicationReceivedAt, approvedAt, approvedBy, limitCents, termsDays, statementEmail, remindersPaused, hold { on, reason ('past_due'|'over_limit'), since, overdueDays, setAt }, holdOverride { mode ('auto'|'hold'|'release'), until, by, at, reason }, note }` |
| `estimates` | `taxExemptNumber`, `taxExemptBasis`, `taxExemptDetails`, `exemptionConfirmed` `{ by, at }` (snapshot); `signatureId`, `signedAt`, `signedName`, `acceptedVia` (`'signature'|'manual'|'quickbooks'`), `revisionOf`; `status` gains `'superseded'` |
| `invoices` | the three `taxExempt*` fields and `exemptionConfirmed`; `kind` (`'standard'|'deposit'|'progress'|'holdback-release'|'credit'|'interest'`, missing = standard); `depositModel` (`'prepayment'|'security'`, deposit invoices); `forfeitedOn` (deposit invoices, 4.3); `holdback` `{ pct, cents, deferTaxIds[], retainedByCustomerCents, retainedRecordedAt, retainedRecordedBy }`; `holdbackInvoiceIds[]` (release invoices); `creditsInvoiceId`, `creditReason` (`'error'|'price'|'dispute'|'backcharge'|'bad_debt'|'deposit-refund'|'other'`), `creditTaxSnapshot` (credit notes, 2.6); `interestFor[{ invoiceId, from, to, cents }]`; `termsText` (≤ 2000, snapshot); `interestDisclosed` (boolean snapshot); `properInvoice` (boolean); `periodFrom`, `periodTo`; `contractRef`; `promptPayment` `{ deliveredOn, deliveredVia ('fishtape-email'|'email'|'gc-portal'|'hand'|'mail'|'quickbooks'), gcPaidOn, nonPaymentNotice { receivedOn, disputedCents, reason, note } }`; `disputes[{ id, lineIndex?, cents, reason (≤ 500), status ('open'|'conceded'|'won'), openedAt, openedBy, resolvedAt?, resolvedBy?, creditNoteId? }]`; `ticketIds[]`; `ticketReconciliation[{ day, billedMinutes, signedMinutes, reason? }]`; `sentAt` |
| estimate and invoice lines | `costCodeId`; `taxOff` (array of `'GST'|'HST'|'PST'|'RST'|'QST'|'*'`; only on `labour` and `other` lines); `passThrough` (boolean); `lineType` (`'deposit'|'holdback'|'interest'|null`); `depositInvoiceId` |
| `payments` | `postedOn` (server, 2.6), `late`; `clientId` (required when `invoiceId` is null); `receiptId` (groups the allocations of one cheque or deposit, 4.4); `appliedFromId` (an application of on-account credit, 4.4); `creditNoteId` (a credit note applied to this invoice); `reversesId` (a reversal of an earlier payment); `method` gains `'credit-note'` (an application of a Fishtape credit note; office) and `'refund'` (money paid back to the customer). Negative `amountCents` is allowed only with `reversesId` or `method: 'refund'`. `'credit'` stays the QuickBooks-only settlement payment. |
| `jobs` | `status` known values gain `'cancelled'`; `kind` (`'standard'|'service'|'warranty'|'callback'`), `billable` (default true; false for warranty and callback), `currentCostCodeId` (the phase the office set; clock-ins use it, 2.8), `taxExempt` `{ basis, number, endCustomer, details { name, registryNo, band, reserve, farmCertNo, department }, confirmedBy, confirmedAt }` (2.9), `contract` `{ role ('prime'|'sub'), signedOn, primeSignedOn, ownerName, gcClientId, contractNo, valueCents, holdbackPct, paymentTermsDays, billingCutoffDay (1-31), authorizedSigners [{ name, title }] (≤ 10), substantialPerformanceOn, substantialPerformanceCertOn, holdbackReleaseOn, completedOn, lastSuppliedOn, properInvoiceRequired }`, `closeout` `{ checkedAt, checkedBy, open[] (keys), override { by, at, reason } }`, `costing` `{ estCostOverrideCents, pctCompleteOverride, budget { at, estimateId, labourHours, labourCostCents, materialCents, subCents, equipmentCents, otherCents, byCostCode } }`; change orders gain `signatureId`, `signedAt`, `signedName`, `approvedOn`, `estCostCents`, `ticketIds[]`, `costCodeId` |
| `timeEntries` | `costCodeId`, `equipmentId` (truck driven), `postedOn` (server, 2.6), `late`; correction entries: `kind: 'correction'`, `correctsId`, `workDay` (YYYY-MM-DD), `adjustMinutes` (± integer, never 0) |
| `stockMoves` | `use` (`'job'|'own-use'|'transfer'|'adjust'|'receive'`; missing = derived as today), `ownUseReason` (`'warranty'|'no-charge'|'shop'|'truck'|'tools'|'other'`), `unitCostCents` (server-stamped, 2.6), `costCodeId`, `countId`, `reversesId`, `poId`, `poLineIndex`, `billId`, `billLineIndex`, `ticketId`, `postedOn` (server), `late` |
| `materialRequests` | `use` (`'job'|'own-use'`), `ownUseReason`, `costCodeId` |
| `bills` | `postedOn` (server), `late`; lines gain `taxUse` (`'resale'|'own-use'`; missing = from `costType` and the vendor, 3.5), `costCodeId`, `equipmentId` (fuel, repairs, lease for a truck; such lines carry no `jobId`), `resaleCreditWrittenOff` `{ by, at }`; bill gains `varianceAck` `{ by, at, note }`, `reversesId` |
| `vendors` | `meSubtrade` (boolean: an electrical or mechanical subcontractor whose work TG resells) |
| `purchaseOrders` | lines gain `costCodeId`, `receivedQty`, `receivedAt`, `quoteRef` (≤ 60, a wholesaler's job quote) |
| `items` | `avgCostCents` (moving average, server-maintained, 8.4) |
| `employees` | `hireDate`, `billRateCents` (already read by `tm.js`, now in the schema), `defaultEquipmentId`, `rateHistory [{ from (YYYY-MM-DD), rateCents }]`, `burden` `{ vacationPct, holidayPct, wcbPct, nonProductivePct, benefitsCentsPerHour, annualHours }` |
| `schedule` | `holdAck` `{ by, at }` (dispatching a held client's job, 4.5) |

### 2.4 Settings additions

`DEFAULT_SETTINGS` (R1-A) gains:

```json
{
  "nextNumbers": { "ticket": 1001, "credit": 1001 },
  "costCodes": { "requireOnTime": false },
  "tickets": {
    "captureLocation": true,
    "agreementText": "I confirm the work listed above was requested and done.",
    "billFrom": "time",
    "draftStaleDays": 3,
    "noticeOnRefusal": true
  },
  "deposits": { "defaultModel": "prepayment", "defaultPct": null },
  "collections": {
    "reminders": [],
    "interest": { "enabled": false, "annualPct": null, "graceDays": 0 },
    "holdAfterDays": 60,
    "holdOverLimit": true,
    "termsText": "",
    "cutoffNoticeDays": 3
  },
  "closeout": { "remindAfterDays": 14 },
  "promptPayment": { "enabled": true },
  "costing": {
    "annualHours": 2000,
    "overheadAnnualCents": null,
    "targetMarginPct": null,
    "statutoryPctFallback": null,
    "nonProductivePctDefault": 10,
    "priceVariancePct": 2
  },
  "payroll": { "vacationPayMode": "each-cheque", "holidayPayMode": "each-cheque" }
}
```

`settings.closing` `{ booksThrough, payrollThrough, lockedAt, lockedBy }` is a server-written mirror of
`period_locks` (2.6). It is never in `DEFAULT_SETTINGS`; device writes keep the stored value.
`nextNumbers.ticket` is only the starting value of the server counter (`doc_counters`).

Where each setting is edited (no change to `modules/settings.js`):

| setting | screen | owner |
| --- | --- | --- |
| `costCodes.*` | Books → Cost codes | R1-A |
| `payroll.*` | Books → Payroll | R1-A |
| `tickets.*` | Field tickets → Settings tab (office) | R1-D |
| `deposits.*`, `collections.*`, `closeout.*`, `promptPayment.*` | Invoices → Collections | R1-D |
| `costing.*` | Job costing → Rates | R1-E |

A reminder step: `{ key ('r1'...), dayOffset (days after the due date; negative = before), channel
('email'|'sms'), subject, body, active }`. Body placeholders: `{client}`, `{number}`, `{balance}`,
`{dueDate}`, `{payLink}`, `{company}`.

### 2.5 Money visibility

`server/src/auth/access.js` `MONEY_FIELDS` gains (R1-A):

| collection | fields stripped for readers without money |
| --- | --- |
| `clients` | `credit.limitCents` |
| `jobs` | `contract.valueCents`, `costing`, change orders' `estCostCents` (plus the existing change-order handling) |
| `settings` | `costing` |
| `equipment` | `rateCents`, `billRateCents`, `rateHistory` |
| `employees` | `rateHistory` (plus `burden`, below) |
| `stockMoves` | `unitCostCents` |
| `items` | `avgCostCents` |
| `signatures` | every key ending in `Cents`, at any depth of `snapshot` (estimate `totalCents` and `taxCents`, change-order `amountCents`, any future key) |

`redactForReader` for `employees` also removes `burden` for readers without the `employees` permission.
Money collections (`invoices`, `payments`, `bills`, `purchaseOrders`, `vendors`) stay office-only by
permission. Notifications to field roles never carry amounts. Reports routes need the `invoices`
permission. `clients.credit.hold` carries no money and is visible to everyone who reads clients (the
dispatch flag). The field receiving route (6.6) returns quantities only.

Server-written fields that device writes cannot change (`restoreHiddenFields`, R1-A):
`settings.closing`, `clients.credit.hold` (only the system actor `receivables`), `payrollRuns` records
(only the system actor `closing`), `postedOn` and `late` on every collection that has them,
`stockMoves.unitCostCents`, `items.avgCostCents` (only the system actor `receiving`),
`fieldTickets.number`.

### 2.6 The period lock and the other write guards

**Where they run.** New `server/src/services/write-guards.js`:

```js
/**
 * Every R1 guard for one write, after checkRules and before the row is written. Throws ApiError,
 * or returns the data to store with server-stamped fields (postedOn, late, number, unitCostCents).
 * before: stored data or null (create); after: data to store or null (delete).
 */
export async function runWriteGuards(tx, p, coll, before, after, who) -> after
```

`services/records.js` calls it in every write path: `createRecord`, `patchRecord`, `deleteRecord`,
`restoreRecord`, and each branch of `applyMutation` (insert, merge, QuickBooks stale merge, plain update,
delete), for every actor including the QuickBooks pull (`system:qbo`). Only the closing route's own
writes (`system:closing`) skip the lock check. A refused write is recorded in `sync_rejections` (actor,
device, collection, id, code, message) by `records.js` and the sync route; sync turns the error into
`{ status: 'rejected', error }` as today, and the device keeps its copy flagged and shows the message.
Books shows "N writes were refused this week" with the list (owner, admin, office), and "Mark resolved".

Guards in R1:

| guard | collections | does |
| --- | --- | --- |
| posting date | payments, bills, stockMoves, timeEntries, equipmentUse, stockCounts | stamps `postedOn` and `late` on create; never refuses a create |
| period lock (books) | the above plus invoices, jobs (change orders) | 409 `period_locked` on edits and deletes of locked records; invoices also on leaving draft |
| payroll lock | timeEntries | 409 `payroll_locked` on any change to an entry in an exported run |
| signature reference | estimates, jobs (change orders), fieldTickets | 422 `signature_invalid` only when the reference is missing or for another document (2.10) |
| ticket number | fieldTickets | assigns `T-####` from `doc_counters` on the first accepted write |
| move cost | stockMoves | stamps `unitCostCents` = `items.avgCostCents ?? items.costCents` on create (any actor), unless the receiving route set it |
| change-order merge | jobs | merges `changeOrders` by id (`mergeChangeOrders` in `access.js`, the `mergeTask` pattern); a signed change order is never removed (only `status: 'void'`); a change order with `approvedOn` on or before `booksThrough` is frozen |
| unique cost code | costCodes | 409 `duplicate_code` |
| unique rule | rules | 409 `duplicate_rule` on the same (key, province, effectiveFrom) |

**Concurrency.** `runWriteGuards` takes `pg_advisory_xact_lock_shared(hashtext(tenant_id || ':closing'))`
before reading the locks; `setLock` takes the exclusive form. A write and a lock move never interleave.

**Lock logic** is pure and shared: new `electrical-app/js/lib/closing.js` (R1-A):

```js
export const DOC_DATE_FIELD    // { invoices: 'issueDate', payments: 'date', bills: 'date', stockMoves: 'date',
                               //   timeEntries: 'clockIn' (corrections: 'workDay'), equipmentUse: 'date', stockCounts: 'date' }
export const POSTED_COLLECTIONS // ['payments', 'bills', 'stockMoves', 'timeEntries', 'equipmentUse', 'stockCounts']
export const LOCK_SAFE_FIELDS  // { invoices: ['status', 'payLink', 'sentAt', 'promptPayment', 'disputes',
                               //   'holdback.retainedByCustomerCents', 'holdback.retainedRecordedAt',
                               //   'holdback.retainedRecordedBy', 'updatedAt'],
                               //   payments: ['stripe', 'updatedAt'], bills: ['status', 'varianceAck', 'updatedAt'] }
                               // plus, for the actor system:qbo only: invoices 'number' (the push writes DocNumber)
/** The day a record falls in for the lock: postedOn for POSTED_COLLECTIONS (old records without it: the document day). */
export function lockDay(coll, record, { zone }) -> 'YYYY-MM-DD' | null
/** On create: { postedOn, late } = max(document day, booksThrough + 1 day). */
export function postingFor(coll, record, locks, { zone, today }) -> { postedOn, late }
/** locks: { booksThrough, payrollThrough, payrollEntryIds: Set, qboBookCloseDate } */
export function lockProblem(locks, coll, before, after, { zone, actor }) -> null | { code, through, message }
export function isLocked(locks, coll, record, { zone }) -> boolean          // PWA read-only display
export function locksFrom(settings, payrollRuns) -> locks                    // PWA side
export function isLateHours(entry, locks, { zone }) -> boolean              // clock-in day ≤ payrollThrough and not in a run
```

Rules:

- **Posting date.** On create in a posted collection the server sets `postedOn` = the document day, or
  the day after `booksThrough` when the document day is on or before it, and then `late: true`. The
  document date is kept as typed (an invoice from the wholesaler dated 28 Sep stays dated 28 Sep). A
  create is never refused for its date, for any actor: a phone that syncs September hours on 2 Oct, a bill
  keyed on 8 Oct, a Stripe or QuickBooks payment dated 30 Sep. Late postings notify the office once a day
  (kind `late_posting`, ref `late_posting:<day>`, counts only) and are listed on Books.
- **Locked records.** A record is locked when its `lockDay` is on or before `booksThrough`. Deleting it or
  changing any field other than its `LOCK_SAFE_FIELDS` is refused. `postedOn` never changes after create,
  so editing the document date of an open record does not move it into or out of a closed period.
- **Invoices.** The lock day is `issueDate` (the GST date). Drafts are never locked (edit, re-date, delete,
  void). Leaving draft (draft→sent) is refused while `issueDate` is on or before `booksThrough`:
  "Re-date this invoice to today." A sent invoice dated in a closed period is not created by a device. The
  QuickBooks pull may create one dated on or before QuickBooks' own `bookCloseDate` (a historical import);
  other pulled creates in the closed period go to review (9.6).
- Status changes allowed on locked records: invoices only among `sent`, `partial`, `paid` (never to or from
  `draft` or `void`); bills only `open` and `paid`. So a payment received today still marks a September
  invoice paid, and the Stripe fee still lands.
- **Payroll lock is by entry, never by date.** A time entry is payroll-locked when its id is in an
  `exported` payroll run. Every field is locked, approval included. `payrollThrough` means "payroll
  exported through": it feeds QuickBooks' `timeLockedThrough` (9.6) and `isLateHours`. An entry dated on
  or before `payrollThrough` that is in no run (synced late, approved late, or left out of a run) is
  "late hours": it stays editable and approvable, sits on Books → Payroll → Late hours, and the next
  payroll export includes it (8.2).
- **Change orders** approved on or before `booksThrough` (`approvedOn`) are frozen; they change through a
  new change order with a negative amount.
- Message: "This is in a closed period (through 2026-09-30). Record a reversal dated today instead." The
  payroll one: "These hours were exported to payroll on 2026-10-06. Add a correction instead."

**Changes by reversal** (no edit of a locked record):

| locked record | how it is changed |
| --- | --- |
| invoice | a credit note (below) |
| payment | a reversal payment dated today, negative `amountCents`, `reversesId` (a bounced cheque, a Stripe refund or chargeback) |
| bill | a supplier credit: bill with negative lines, `reversesId`, dated today |
| stock move | an opposite move dated today with `reversesId` |
| time entry (books or payroll lock) | an office correction entry: `{ kind: 'correction', correctsId, workDay, adjustMinutes, jobId, costCodeId, employeeId, note }`, posted today. `adjustMinutes` is negative for fewer hours. Overtime counts it on `workDay`; payroll takes it in the next run as a prior-period adjustment |
| time entry (payroll lock, a mistake in the run) | an owner or admin may still reopen the payroll run with a reason; the payroll provider is corrected by hand |

**Credit notes** (lib R1-B in `money.js`, UI R1-D in `invoices.js`, schema R1-A):

- `creditNoteFrom(invoice, { lines, reason, today }) -> invoice`: `kind: 'credit'`, number `CR-1001`
  (`nextNumbers.credit`), dated today, `creditsInvoiceId`, `creditReason`, negative lines, and the
  original's `taxProvince`, `taxes`, `taxTreatment`, `taxNoneReason`, `taxExempt*` fields
  (`creditTaxSnapshot` records them), so the note is never re-rated by `newDocTax(today)`. A credit note
  for an invoice with holdback carries a negative `holdback.cents` in proportion, which reduces
  `holdbackLedger.retainedCents`.
- Applying it: a payment `{ method: 'credit-note', creditNoteId, invoiceId: <original>, amountCents }`.
- `creditNoteBalance(note, payments) = totalCents + Σ amountCents of payments with creditNoteId = note.id`
  (zero when fully applied). Aging and statements show only a note's unapplied part. Cash-receipt
  figures exclude `credit-note` payments.
- `invoicePaidCents` counts `credit-note` applications on the original (it already sums by `invoiceId`);
  `invoiceStatus` of a credit note is `applied` or `open` from `creditNoteBalance`, never `paid`.
- Print (Excise Tax Act s.232 contents): "Credit note", the original invoice number and date, the GST and
  RST registration numbers, the reason, and the tax adjusted per tax.

**Who moves the lock.** `server/src/services/period-lock.js` (R1-A):

```js
export async function loadLocks(tx) -> { booksThrough, payrollThrough, payrollEntryIds: Set<string>, qboBookCloseDate }  // cached per transaction
export async function setLock(tx, { kind, through, reason, preflight, actor, request }) -> { through, previous }
export async function preflight(tx, { through, zone }) -> { counts, lists }   // below
```

`setLock` takes the advisory lock, appends a `period_locks` row, patches `settings.closing` through
`records.patchRecord` with `systemPrincipal(tenantId, 'closing', 'Period lock')`, writes audit
`closing.books` or `closing.payroll`, and notifies owners and admins (kind `period_lock`). Moving a lock
earlier, or clearing it, needs a reason of at least 10 characters. A lock date must be before today in the
company's zone.

**Pre-close checklist.** `preflight(through)` returns counts and short lists (ids, numbers, names; no
money) of: open or unapproved time entries dated on or before `through`; devices whose `last_seen_at` is
before `through` + 1 day (from the `devices` table); draft invoices and open bills dated in the period;
`counted` stock counts not posted; signed or refused tickets not priced or billed; open disputes. The
Books screen shows it before "Close"; closing with anything open needs a reason, and the counts are stored
on the `period_locks` row.

**Routes** (`server/src/routes/v1/closing.js`, R1-A):

| route | who | does |
| --- | --- | --- |
| `GET /api/v1/closing` | `invoices` or `employees` permission | current locks, the last 50 lock changes, late postings this period, open `sync_rejections` count, and when QuickBooks is connected its `bookCloseDate`, `taxFiledThrough` and `timeLockedThrough` |
| `GET /api/v1/closing/preflight?through=` | owner or admin | the pre-close checklist |
| `PUT /api/v1/closing/books` `{ through, reason? }` | owner or admin (`settings` permission), full session with recent MFA (the check the QuickBooks write routes use; never a crew PIN) | moves the books lock |
| `GET /api/v1/closing/rejections`, `POST /api/v1/closing/rejections/:id/resolve` | owner, admin, office | the refused-writes list |
| `POST /api/v1/closing/payroll-runs` `{ from, to, format, entryIds[], lateEntryIds[], employeeIds[], totals, lockThrough, leftOutAck }` | `employees` permission | checks every entry exists, is approved and closed, falls in `from..to` (late entries: before `from`), and is in no other exported run (409 `already_exported`); with `lockThrough: true` and any entry in `from..to` (any employee) that is open, unapproved or not in this or an earlier exported run, refuses with 409 `unexported_entries` listing them unless `leftOutAck: true`, then stores them in `leftOut`; writes the `payrollRuns` record as `system:closing`; with `lockThrough` moves `payrollThrough` to `to` |
| `POST /api/v1/closing/payroll-runs/:id/reopen` `{ reason }` | owner or admin, full session with recent MFA | sets the run `reopened` (its entries unlock); if `payrollThrough` covers the run, moves it back to the day before `from`; notifies owners, admins and office (kind `payroll_reopened`) |

The Books page warns when Fishtape's books lock is earlier than QuickBooks' `bookCloseDate`.
QuickBooks interplay is in 9.6.

### 2.7 The rules table

**Definitions in code, values in data.** `electrical-app/js/lib/rules.js` (R1-A) holds only the
definitions: key, label, unit, kind, scope, `yearly` (a value that must exist for each calendar year),
description and what uses it. No values.

```js
export const RULE_STATUS = ['verified', 'sourced', 'verify'];
export const RULE_DEFS = {
  'pp.MB.paymentDays': { label: 'Owner pays a proper invoice within', unit: 'days', kind: 'deadline',
    scope: 'province', province: 'MB', usedBy: ['prompt-payment alarms'], description: '…' },
  …
};
/** Effective rules for one province and date. For each key the row with the newest effectiveFrom ≤ on wins;
    on a tie the company row wins. A company row older than a newer platform row is returned with
    staleOverride: true (the Rules screen warns). A yearly key whose winning row is from an earlier year
    is returned with status 'verify' and missingYear. */
export function resolveRules(platformRows, companyRecords, { province, on }) -> Map<key, { value, status, source, sourceUrl, origin: 'platform'|'company', effectiveFrom, confirmedBy, confirmedAt, staleOverride?, missingYear? }>
/** The value a calculation may use, or null.
    deadline: status 'verified' or 'sourced' and a non-null value; never on 'verify'.
    rate:     'verified' or 'sourced'; on 'verify' only when allowVerify is true (the caller then shows "unconfirmed").
    policy:   any status with a non-null value; on 'verify' the caller shows "unconfirmed". */
export function ruleValue(resolved, key, { allowVerify = false } = {}) -> value | null
export function ruleUnconfirmed(resolved, key) -> boolean   // true when the status is not 'verified'
export function ruleProblem(def, value) -> string | null   // type check for the edit forms and the HQ route
```

Statuses: **verified** (a lawyer, accountant or the official text confirmed it; `confirmedBy` and
`confirmedAt` required), **sourced** (a published source is cited, not yet confirmed for us), **verify**
(unconfirmed or missing). Kinds: **deadline** (drives an alarm or countdown: never runs on `verify`),
**rate** (drives a calculation: on `verify` the calculation uses its fallback and says so), **policy**
(a yes/no or list Kelvin chose: it applies on any status and every screen using it shows "unconfirmed"
until it is `verified`, with a one-click company override on Books → Rules).

**Where values live.** Platform rows in `platform_rules` (seeded by 0160, edited by Fishtape HQ staff on
the HQ "Rules" page, R1-C). Company overrides in the `rules` collection, edited by owners, admins and office
on Books → Rules (R1-A). An override must name its source; marking it `verified` needs who confirmed it.
Every change is audited (HQ audit for platform rows, record audit for company rows).

**Reading them.** `GET /api/v1/rules?province=MB&on=2026-10-20` (R1-A, any signed-in member):

```json
{
  "defs": { "pp.MB.paymentDays": { "label": "Owner pays a proper invoice within", "unit": "days", "kind": "deadline" } },
  "rules": [
    { "key": "pp.MB.paymentDays", "province": "MB", "value": 28, "status": "sourced", "origin": "platform",
      "source": "MHCA, Understanding prompt payment rules now in effect", "sourceUrl": "https://mhca.mb.ca/…",
      "effectiveFrom": "2025-04-01", "confirmedBy": null, "confirmedAt": null }
  ]
}
```

The PWA keeps the last response in store meta for offline use. Demo mode has no rules; screens that need
one say "The rules table loads when you're signed in."

**Seed rows in 0160** (platform, province MB unless noted; `updated_by` = `migration:0160`):

| key | value | unit | kind | status | source |
| --- | --- | --- | --- | --- | --- |
| `pp.MB.inForceFrom` | `"2025-04-01"` | date | deadline | sourced | Manitoba proclamation 2023 c30 (in force 2025-04-01); applies to prime contracts signed on or after |
| `pp.MB.paymentDays` | 28 | days | deadline | sourced | MHCA, MLT Aikins |
| `pp.MB.nonPaymentNoticeDays` | 14 | days | deadline | sourced | MHCA |
| `pp.MB.subPaymentDays` | 7 | days | deadline | sourced | MHCA |
| `pp.MB.subNonPaymentNoticeDays` | null | days | deadline | verify | VERIFY: a GC's notice period to its sub (no alarm in R1) |
| `pp.MB.appliesTo` | null | list | policy | verify | VERIFY with a lawyer: exclusions (residential, value thresholds) |
| `pp.MB.dayRollover` | null | text | policy | verify | VERIFY: whether a deadline on a weekend or holiday moves to the next business day (Interpretation Act) |
| `pp.MB.adjudicationPayDays` | 10 | days | deadline | sourced | MHCA (shown only; no alarm in R1) |
| `holdback.MB.pct` | null | pct | rate | verify | VERIFY: Builders' Liens Act holdback percentage (display only; invoices use the job's `contract.holdbackPct`) |
| `holdback.MB.releaseDays` | null | days | deadline | verify | VERIFY: MHCA says 60 days; older guidance 40 days from the certificate |
| `holdback.excludePassThrough` (province '') | true | bool | policy | verify | VERIFY with a lawyer: out-of-pocket disbursements outside the holdback base |
| `lien.MB.days` | null | days | deadline | verify | VERIFY: lien deadline under the amended Act |
| `properInvoice.MB.fields` | `["contractorName","contractorAddress","invoiceDate","periodFrom","periodTo","contractRef","description","amountDue","paymentTerms","payeeContact"]` | list | policy | verify | VERIFY with a lawyer: what a proper invoice must contain |
| `tax.CA.gstHoldbackAtRelease` (province '') | true | bool | policy | sourced | Excise Tax Act s.168(7) |
| `tax.CA.gstDueAtSubstantialCompletion` (province '') | true | bool | policy | sourced | Excise Tax Act s.168(3)(c) |
| `tax.MB.rstHoldbackAtRelease` | true | bool | policy | verify | Kelvin's default. If the accountant later says RST was due at billing, the deferred RST is remitted late with interest: the "unconfirmed" text says so |
| `tax.SK.pstHoldbackAtRelease` (province SK) | true | bool | policy | verify | VERIFY with the accountant |
| `tax.BC.pstHoldbackAtRelease` (province BC) | true | bool | policy | verify | VERIFY with the accountant |
| `tax.MB.passThroughAllowed` | true | bool | policy | verify | VERIFY: Bulletin 031 wording on separately billed out-of-pocket disbursements |
| `payroll.MB.vacationPct` | 4 | pct | rate | sourced | Manitoba Employment Standards |
| `payroll.MB.vacationPctLong` | 6 | pct | rate | sourced | Manitoba Employment Standards |
| `payroll.MB.vacationLongYears` | 5 | years | rate | sourced | Manitoba Employment Standards |
| `payroll.MB.constructionHolidayPct` | 4 | pct | rate | sourced | Manitoba construction fact sheet |
| `payroll.CA.ei.employerFactor` (province '') | 1.4 | factor | rate | sourced | Employment Insurance Act s.68 |
| `payroll.CA.cpp.rate`, `payroll.CA.cpp.ympe`, `payroll.CA.cpp.basicExemption`, `payroll.CA.cpp2.rate`, `payroll.CA.cpp2.yampe`, `payroll.CA.ei.rate`, `payroll.CA.ei.mie` (province '', effective 2026-01-01, yearly) | null | pct or cents | rate | verify | HQ loads the 2026 values from canada.ca before release (14, Q9) |
| `payroll.MB.wcb.maxAssessableCents` (effective 2026-01-01, yearly) | null | cents | rate | verify | WCB Manitoba, yearly |

Company-only keys (no platform row): `payroll.company.wcbRatePct` (from the company's WCB assessment),
`payroll.company.healthLevyPct` (Manitoba Health and Post-Secondary Education Tax Levy; null = not
liable, the usual case for a shop under the exemption threshold).

### 2.8 Cost codes

`electrical-app/js/lib/cost-codes.js` (R1-A):

```js
export const STANDARD_COST_CODES  // [{ id: 'cc-rough-in', code: '100', name: 'Rough-in', group: 'rough-in', billable: true }, …]
export const costCodeLabel = (cc) => `${cc.code} ${cc.name}`
export function activeCostCodes(list) -> sorted active codes
export function defaultCostCode(job, codes) -> id | null      // job.currentCostCodeId, else warranty and callback jobs get cc-callback
```

Standard set (deterministic ids, so "Add the standard codes" twice never duplicates): `100 Rough-in`,
`200 Service and distribution`, `300 Trim and finish`, `400 Change orders`, `500 Service calls`,
`600 Callbacks and warranty` (billable false, ownUse callback), `700 Temporary power`,
`800 Low voltage`, `900 General conditions`.

Cost codes are shared by estimate lines, invoice lines, time entries, bill lines, PO lines, stock moves,
material requests, field tickets, equipment use and change orders, all through `costCodeId`. Missing
means "no code" and reports group it as "Uncoded".

**Clock-in picks nothing.** `lib/clock.js clockIn` and `lib/shift-tracker.js clockInFlow` (R1-A) set
`costCodeId = defaultCostCode(job, codes)` (the phase the office set on the job, `jobs.currentCostCodeId`)
and `equipmentId = employee.defaultEquipmentId`, without asking. Every screen that clocks in (`time.js`,
`jobs.js`, `dashboard.js`) goes through `clockInFlow`, so no other stream changes clock-in. The time clock
(`time.js`) shows the code and truck with a "Change" link. When `settings.costCodes.requireOnTime` is on and
the job has no phase set, `time.js` asks once. The foreman recodes the day's entries in weekly approval
(`time.js`, "Change cost code" on selected entries).

### 2.9 Tax exemption

An exemption applies per contract (Bulletin 031), not per customer. The client card holds the evidence; the
job (or, for a document with no job, the document itself) says the exemption applies.

`electrical-app/js/lib/exemption.js` (R1-A, pure, imported by the server):

```js
export const EXEMPT_BASES  // [{ id: 'resale', label }, { id: 'subtrade', label: 'Electrical or mechanical subtrade' },
                           //  { id: 'pass-on', label: 'General contractor passing on its customer's exemption' },
                           //  { id: 'federal' }, { id: 'first-nations' }, { id: 'farm' }]
/** What each basis needs: subtrade, resale → number; pass-on → number (the end customer's) and endCustomer;
    first-nations → registryNo and band or reserve; farm → farmCertNo; federal → department and number. */
export const EXEMPT_EVIDENCE
/** PST/RST not charged on any work line. Lines with a lineType or taxOff are not counted. */
export function provincialTaxOff(doc) -> boolean
/** MB invoices: block when RST is off and the basis's evidence is missing. MB estimates, BC and SK: warn.
    Skipped: kind interest, credit (follows its original), holdback-release, deposit with depositModel security,
    and documents with no work lines. Real-property (BC) is not an exemption. */
export function exemptionProblem(doc) -> null | { level: 'block'|'warn', code: 'exemption_required', message, missing: [] }
/** The exemption for a new document: the job's taxExempt, else nothing. The client's evidence prefills the
    editor when the office ticks "This work is exempt" (exemptionConfirmed). */
export function exemptionFor({ job, client, province }) -> { taxExemptNumber, taxExemptBasis, taxExemptDetails } | {}
export function exemptionPrintLines(doc) -> string[]   // e.g. ['RST exemption: subtrade, RST no. 1234567']
```

Server enforcement (pure, in `checkWriteRules`, R1-A): an invoice moving from `draft` (or created) to any
other status is refused with 422 `exemption_required` when `exemptionProblem` says `block`. Estimates are
never blocked. System actors (the QuickBooks pull) are not blocked; R1-F sends such a pulled document to
review (9.7). The email-document and pay-link routes run the same check (R1-B).

### 2.10 Signatures and their digests

`electrical-app/js/lib/signing.js` (R1-A, pure):

```js
export const SNAPSHOT_VERSION = 1
/** What the customer saw, as a small object (no photos, no data URLs), in the given version's shape. */
export function snapshotOf(docType, doc, extra = {}, v = SNAPSHOT_VERSION) -> snapshot
/** Canonical string: keys sorted, strings NFC, numbers as integers, no whitespace. */
export function signedContent(snapshot) -> string
/** Browser: hex SHA-256 through crypto.subtle. The server computes the same with node:crypto. */
export async function digestHex(text) -> string
/** Keys of a document frozen once it carries a valid signature. Every key snapshotOf reads is in here. */
export const SIGNED_KEYS  // { estimates: ['number','issueDate','lines','taxes','taxTreatment','taxProvince','taxNoneReason',
                          //   'markupPct','title','notes','validUntil','clientId','jobId'],
                          //   changeOrder: ['title','lines','amountCents'], fieldTickets: [every content field except number] }
```

Snapshots (version 1; every snapshot carries `v`):

```
estimate:    { v, docType, id, number, clientId, jobId, title, issueDate, validUntil, totalCents, taxCents,
               lines: [{ description, qty }] (≤ 200), notes (≤ 2000) }
changeOrder: { v, docType, jobId, changeOrderId, title, amountCents, lines: [{ description, qty }] }
fieldTicket: { v, docType, id, jobId, kind, date, title, description, requestedBy, pricingBasis, rateSheetRef,
               labour: [{ name, hours }], materials: [{ description, qty, unit }],
               equipment: [{ description, qty, unit }], photoIds: [], agreementText }
ticketBatch: { v, docType, jobId, tickets: [fieldTicket snapshots] }
```

The ticket snapshot uses the ticket's `id`, never its `number` (the server assigns the number later).

Server rules (R1-A):

- **A signature is never rejected for its content.** On create the server rebuilds the snapshot with the
  `snapshotOf` of the snapshot's own `v` (the server keeps every shipped version) and recomputes the
  digest. Any mismatch (snapshot drift, an old service worker, a formatting difference) stores the
  signature with `status: 'unverified'` and `unverifiedReason`, and notifies the `invoices` permission
  (kind `signature_unverified`). Only a schema violation or an oversized image is refused (422); the PWA
  checks size before the pad closes (`signaturePad` re-encodes at lower quality until it fits 60 KB) and
  photos before they are added.
- A signature can only change `status` to `void` (from `valid` or `unverified`), with `voidReason`, by a
  user with the `invoices` permission in a full session (not a crew PIN), with an audit event
  (`signature.void`). It is never deleted.
- A document that sets or keeps a `signatureId` must reference a signature with status `valid` or
  `unverified` whose `docId` (or `docIds`, for a batch) contains the document (otherwise 422
  `signature_invalid`). For `valid` signatures the document must also produce an equal snapshot, so it
  cannot drift from what was signed. Once signed, the `SIGNED_KEYS` of the document cannot change for
  anyone; a signed estimate is changed by a revision (a new estimate with `revisionOf`).
- `method: 'email-reply'` (the customer accepted by email) is recorded only by users with the `invoices`
  permission, with `evidence`; it has no pad image.
- The PWA writes the signature record first and the document second, in the same tick, so the queue
  pushes them in that order. If the signature write is refused for size, the ticket stays `draft` on the
  phone with the pad reopened.

### 2.11 Plans, features, modules, switches

`electrical-app/js/plans.js` `FEATURE_PLAN` gains (generous, per Kelvin):

| key | plan | what |
| --- | --- | --- |
| `books` | starter | module: period lock, payroll runs, rules table, cost codes |
| `tickets` | starter | module: field tickets |
| `reports` | starter | module: job profit, RST view, rates and break-even, price variances, ready to bill |
| `reports.wip` | pro | the WIP report and its API |
| `monthend` | pro | module: month-end cutoff export and inventory valuation |

Everything else in R1 (exemptions, signatures, deposits, holdback, statements, receive payment, disputes,
credit holds, prompt payment, burden, truck rates) is in every plan. Emailed reminders, statements,
ticket copies and written notices go through the company's outbox, so they need `integrations.email` or
`integrations.sms` (Pro and Business today); on Starter the office prints them (question 24).

`electrical-app/js/lib/modules.js` (R1-A): new switches `tickets` (group work, core true, modules
`['tickets']`), `reports` ("Job costing and reports", group money, core true, modules `['reports']`),
`monthend` (group money, core false, modules `['monthend']`). `books` joins `ALWAYS_ON`.
`COLLECTION_SWITCHES` per the table in 2.2.

New PWA modules (the Lead adds them to `modules/index.js`):

| id | title | icon | group | perm | owner |
| --- | --- | --- | --- | --- | --- |
| `books` | Books | `lock` | money | `invoices` | R1-A |
| `tickets` | Field tickets | `pen` | work | `jobs` | R1-D |
| `reports` | Job costing | `activity` | money | `invoices` | R1-E |
| `monthend` | Month-end | `calendar` | money | `invoices` | R1-E |

No new permission keys: `auth.js` and `server/src/auth/permissions.js` do not change.

### 2.12 Shared module contracts (exports other streams import)

| file | owner | exports |
| --- | --- | --- |
| `electrical-app/js/lib/rules.js` | R1-A | `RULE_STATUS`, `RULE_DEFS`, `resolveRules`, `ruleValue`, `ruleUnconfirmed`, `ruleProblem` |
| `electrical-app/js/lib/closing.js` | R1-A | `DOC_DATE_FIELD`, `POSTED_COLLECTIONS`, `LOCK_SAFE_FIELDS`, `lockDay`, `postingFor`, `lockProblem`, `isLocked`, `locksFrom`, `isLateHours` |
| `electrical-app/js/lib/cost-codes.js` | R1-A | `STANDARD_COST_CODES`, `costCodeLabel`, `activeCostCodes`, `defaultCostCode` |
| `electrical-app/js/lib/exemption.js` | R1-A | `EXEMPT_BASES`, `EXEMPT_EVIDENCE`, `provincialTaxOff`, `exemptionProblem`, `exemptionFor`, `exemptionPrintLines` |
| `electrical-app/js/lib/signing.js` | R1-A | `SNAPSHOT_VERSION`, `snapshotOf`, `signedContent`, `digestHex`, `SIGNED_KEYS` |
| `electrical-app/js/lib/timesheet.js` | R1-A | existing exports; `allocateOvertime` counts correction entries on `workDay`; `payrollRows` takes late entries and corrections (a `late` column) |
| `electrical-app/js/lib/tax.js` | R1-B | existing exports; `newDocTax(settings, date, { client, job } = {})` (exemption-aware default treatment and snapshot); `TAX_OFF_PRESETS` |
| `electrical-app/js/lib/money.js` | R1-B | existing exports; `docTotals` returns also `holdbackCents`, `holdbackBaseCents`, `workSubtotalCents`, `netSubtotalCents` (`totalCents` = net subtotal + tax); `lineTaxed(line, tax)`; `holdbackProblem(doc)`; `invoiceKind(inv)`; `creditNoteFrom`, `creditNoteBalance`; `revenueCents(inv)` (11); `progressSummary(invoice, { job, invoices })` |
| `electrical-app/js/lib/doc-view.js` | R1-B | existing exports; `exemptionEditor({ doc, job, client, onChange, readOnly })`; `sendCheck(doc) -> { block: string|null, warn: string|null }` |
| `electrical-app/js/lib/receivables.js` | R1-D | `depositsAvailable`, `holdbackLedger`, `statement`, `interestDue`, `reminderPlan`, `creditHold`, `creditExposure`, `undisputedBalance`, `allocateReceipt`, `readyToBill`, `invoiceLagDays`, `dso`, `reminderText` |
| `electrical-app/js/lib/prompt-payment.js` | R1-D | `promptPaymentApplies`, `promptPaymentDates`, `promptPaymentAlarms` |
| `electrical-app/js/lib/closeout.js` | R1-D | `closeoutChecklist(job, sources, { at: 'complete'|'invoiced' }) -> [{ key, label, count, link, severity: 'block'|'warn' }]` |
| `electrical-app/js/lib/tickets.js` | R1-D | `newTicket`, `ticketProblems`, `ticketToChangeOrder`, `ticketToInvoiceLines`, `prefillLabour`, `TICKET_STATUSES` |
| `electrical-app/js/lib/tm.js` | R1-E | `jobCosting` (extended, old keys kept), `buildTmInvoice` (tickets, 4.1), `unbilledTm` and the existing exports |
| `electrical-app/js/lib/costing.js` | R1-E | `jobActuals`, `jobProfit`, `budgetFromEstimate`, `contractValue`, `wipRow`, `wipReport`, `priceVariances`, `committedCost`, `receivedNotBilled`, `truckCharges`, `rateOn`, `breakEven` |
| `electrical-app/js/lib/burden.js` | R1-E | `burdenRate(employee, { rules, settings, year, on })` |
| `electrical-app/js/lib/rst.js` | R1-E | `rstSelfAssessment(...)`, `billLineTaxUse(line, { vendor })` |
| `electrical-app/js/lib/month-end.js` | R1-E | `cutoff(...)`, `cutoffCsv(...)` |
| `electrical-app/js/lib/stock-counts.js` | R1-E | `countSheet`, `countAdjustments`, `valuationByLocation`, `movingAverage` |

`.dockerignore` (R1-A) adds every file in this table plus `electrical-app/js/lib/purchasing.js`,
`electrical-app/js/lib/workplan.js` and `electrical-app/js/lib/geo.js` if not already there (missing files
in the allow-list are harmless until they exist).

---

## 3. Item 1: RST fixes

### 3.1 Hints and treatments (R1-B, `lib/tax.js`)

- `TREATMENTS['gst-only'].hints.MB`, exact text:
  "Manitoba: only when the customer is another electrical or mechanical contractor subcontracting this
  work to you, a reseller, or a general contractor passing on an exempt customer's exemption (federal
  government RST number, Status Indian or band on reserve, farm-use certificate). A general contractor on
  an ordinary building job pays RST (Bulletins 031, 005). The exemption is for this contract only: record
  it on the job and their 7-digit RST number on the invoice (Bulletin 004). Travel time and permits are
  part of the taxable price."
- `hints.SK`, same pattern: "Saskatchewan: only when the customer gives a PST vendor's licence or
  exemption for this work (a licensed contractor buying for resale, or an exempt customer). A general
  contractor on an ordinary building job pays PST (Bulletin PST-12). Record their number on the invoice."
- `hints.BC` for `gst-only`: "British Columbia: only for a customer who gives a PST number for goods they
  will resell. Record the number on the invoice."
- `newDocTax(settings, date, { client, job })`: when `exemptionFor({ job, client, province })` returns an
  exemption, the default treatment is `gst-only` (basis `first-nations` on reserve: `none` with
  `taxNoneReason: 'relief'`) and the result includes that snapshot. A client's evidence alone never
  changes the default; the office ticks "This work is exempt" on the document (`exemptionConfirmed`).
  Callers without a job or client are unchanged.

### 3.2 Exemption on clients, jobs and documents

- Clients → "Tax exemption" card (R1-B, `modules/clients.js`): the evidence on file: basis, number,
  province, First Nations details (name, registry number, band, reserve), farm certificate number, federal
  department, last checked date. Number format checks are warnings only (formats are VERIFY in
  `docs/code/tax.md`). The card says: "This is evidence on file. Mark the exemption on each job it applies
  to."
- Jobs → "Tax exemption" row on the "Contract and payment" card (R1-D, `jobs.js`, using R1-B's
  `exemptionEditor`): basis, number, end customer (pass-on), details, prefilled from the client, with who
  confirmed it.
- Documents: `exemptionEditor` shows under the tax picker when the treatment is `gst-only` or `none`,
  prefilled from the job or (after the tick) the client, editable while draft. `documentNode` prints
  `exemptionPrintLines` on estimates and invoices.
- Sending: `sendCheck(doc)` blocks MB invoices and warns on MB estimates and in BC and SK (2.9). The server
  refuses the invoice status change and the email and pay-link routes (2.9, R1-B for the routes).

### 3.3 `docs/code/tax.md` (R1-B)

- Manitoba row, other treatments: federal government (RST number), farm (certificate) and a GC passing
  on an exemption are `gst-only`, not `none`. `none` is for First Nations relief only (Indian Act s.87;
  GST relief too). Same fix for Saskatchewan.
- A new "Purchases" section: resale versus own use per bill line (M&E subcontracts resale, other
  subcontracts own use), RST recoverable when a supplier charged RST on resale material, self-assessment
  on own-use material (3.5), shrinkage not self-assessed (VERIFY), self-assessment on warranty material
  when the warranty was priced into an RST-charged contract (VERIFY), the Bulletin 031 rules from gap
  section A with sources.
- The data model section: `taxOff`, `passThrough`, holdback (and the holdback base), exemption fields
  per job and document, credit notes.
- `docs/code/verify.md` (R1-B) lists every R1 VERIFY item handed to it by other streams' merge reports.

### 3.4 Out-of-pocket disbursement line (R1-B)

`TAX_OFF_PRESETS` in `tax.js`: `{ id: 'pass-through', label: 'Out-of-pocket disbursement at cost (hotel,
meals; not travel time or permits)', kind: 'other', passThrough: true, taxOff: ['PST', 'RST'] }`. Only
`kind: 'other'` lines may carry `passThrough`. The line editor's "Add line" menu offers it when
`tax.MB.passThroughAllowed` is set (policy: shows "unconfirmed" until verified); choosing it shows
"Travel time and permits are taxable. Use a normal line for them." The line prints "(at cost, no RST)".
`docTotals` leaves the line out of the PST and RST bases (it still carries GST) and, while
`holdback.excludePassThrough` holds, out of the holdback base.

### 3.5 Purchase tax per bill line and the RST self-assessment view (R1-E)

- Bill lines get `taxUse`. Default (`rst.js billLineTaxUse(line, { vendor })`, the only place the default
  lives; R1-F imports it): `material` resale; `subcontract` resale only when the vendor is `meSubtrade`,
  otherwise own use; `equipment` and `other` own use. In the bill editor each line shows Resale or Own use.
- Cost of a bill line for job costing (`costing.js`): amount + its pro-rata share of non-recoverable tax
  for own-use lines; resale lines carry no PST/RST in cost. GST, HST and QST are never cost.
- A resale line on a bill that charged RST is flagged on the bill and in the RST view: "Supplier charged
  RST on resale materials. Ask them for a credit." (`rst.js`). "Write off to cost" (`resaleCreditWrittenOff`)
  moves that RST into the line's cost when the supplier won't credit it. The QuickBooks side is 9.3.
- Own-use tags (R1-E, inventory and material request screens): stock moves and material requests can be
  tagged own use with a reason (warranty, no charge, shop, truck, tools, other). Moves onto a job whose
  `kind` is `warranty` or `callback`, or whose `billable` is false, default to own use. Count adjustments
  are never own use.
- RST view (`#/reports/rst`, R1-E): for a date range (default last month), three lists and totals:
  self-assess (own-use stock moves and requests at cost × the RST rate on that day; own-use bill lines in
  MB with no RST charged, typical for out-of-province sellers), resale credits to claim from suppliers
  (resale lines where RST was charged and not written off), and a CSV for the accountant. It uses the same
  de-duplication as 6.1 (a request covered by a move or a bill counts once; an own-use line already charged
  RST is not self-assessed). It files nothing: QuickBooks Online produces the Manitoba RST report, and it
  will not include self-assessed RST, so the view and the month-end journal (8.3) say "Add this to your RST
  return" and suggest Dr expense (or job cost) / Cr RST payable.
- Self-assessed RST on own-use material moved onto a warranty or callback job is part of that job's cost
  (6.1).
- `rstSelfAssessment({ stockMoves, materialRequests, bills, vendors, items, jobs, from, to, province, zone })
  -> { selfAssess: [{ source, id, date, jobId, description, costCents, rstCents, reason }], resaleCredits:
  [{ billId, lineIndex, vendorId, rstCents }], totals: { selfAssessCents, creditCents } }`. Rates come from
  `tax.js ratesOn`.

### 3.6 RST on progress bills net of holdback

Covered by the holdback model in 7.3: deferred taxes (`holdback.deferTaxIds`) are charged on the progress
invoice net of holdback and on the release invoice. RST is deferred while
`tax.MB.rstHoldbackAtRelease` holds (policy, `verify`: screens show "unconfirmed: if your accountant says
RST is due at billing, change this on Books → Rules", with the one-click override).

---

## 4. Item 2: Get paid

### 4.1 Field tickets: signed extras and T&M tickets on the phone (R1-D)

Flow (crew, offline):

1. From My day, a job, or Field tickets → New: pick the job, T&M or Extra, describe the work, who asked.
   The number shows as "T-pending a3f9" (the id's first characters) until the server assigns one.
2. Labour rows prefill (`prefillLabour`) from today's time entries on that job (mine; a foreman sees the
   crew's), **including the open entry counted to now**, with their `timeEntryIds`; hours stay editable.
   Material rows: from van stock (choosing a van item creates the job-use stock move from that van, with
   `ticketId`, so van stock and job cost update; the row keeps `stockMoveId`), from material requests on
   the job, or free text. Equipment from the equipment list (no rates shown); a truck already on today's
   clock-in is shown but not charged again (6.1). Up to 4 photos (`safety-capture.js photoStrip`).
3. Pricing basis: "Our contract rates" (default; with `rateSheetRef`, e.g. "rates in contract 24-117") or
   "Quote to follow". The sentence is added to the agreement text: "Billed at the rates in contract 24-117."
   or "Price to follow by quote; this confirms the work only."
4. "Get it signed": a full-screen sheet shows the ticket without any money, the agreement text, signer
   name and title, the signature pad (`safety-capture.js signaturePad`). When the job has
   `contract.authorizedSigners` and the signer is not on it, the sheet warns ("Not on the GC's list of
   signers") but allows it. On Sign: the device takes a location fix when
   `settings.tickets.captureLocation` is on (`lib/geo.js`, shown as "Location recorded with the
   signature"), builds the snapshot and digest, writes the `signatures` record, then the ticket
   `{ status: 'signed', signatureId, signedAt, signerName }`. All offline.
5. "Sign several tickets": a foreman or the office picks the job's unsigned tickets (up to 30) and the
   super signs once over the list (`ticketBatch` signature; each ticket gets the batch `signatureId`).
6. "Customer won't sign": records `refusal`, status `refused`. "Super isn't here": the ticket stays
   `draft`.
7. Copies: with an email for the signer, the server sends a copy through the outbox (kind `ticket_copy`)
   once the ticket arrives (the tickets sweep, 10.1).

Written notice (`server/src/services/tickets.js`, R1-D): when a `refused` ticket arrives and
`settings.tickets.noticeOnRefusal` is on, the sweep queues an email to the job's GC contact (the
`contract.gcClientId` client's email, else the job's client): "Written notice of extra work: T-1042 on
<job>, done <date>, refused by <name> at <time>", the ticket without money attached, and stores
`notice { outboxId, queuedAt, to, kind: 'refusal' }` on the ticket. Drafts older than
`tickets.draftStaleDays` are listed for the office with "Send as written notice" (one tap, kind
`unsigned`); nothing is sent on its own for drafts. "Send copy now" and "Send as written notice" call
`POST /api/v1/tickets/:id/send { kind: 'copy'|'notice' }` (`invoices` permission, online). Without email
on the plan, the office prints the notice.

Email-reply acceptance (office): on a ticket, estimate or change order, "Customer accepted by email"
records a signature with `method: 'email-reply'` and a photo or screenshot of the reply as `evidence`.

Office: the ticket list (`#/tickets`, filters by status and job, the ticket settings tab) and:

- **Fixed-price jobs**: "Price as change order": `ticketToChangeOrder(ticket, { job, items, equipment,
  settings })` builds change-order lines (labour hours at the job's T&M rates, materials at cost plus
  markup or the price book price, equipment at `billRateCents`), the office edits and saves it into
  `job.changeOrders` with `ticketIds`, and the ticket goes to `priced` with `changeOrderId`. Signed and
  refused tickets can both be priced; a refused one prints "Unsigned: written notice given <date>" on the
  change order. An invoice line with that `changeOrderId` moves the ticket to `billed` (the invoice records
  `ticketIds`).
- **T&M jobs**: tickets are never priced as change orders (`ticketToChangeOrder` refuses). They are billed
  by the T&M builder: `buildTmInvoice` (R1-E, `tm.js`) takes `fieldTickets`, picks up signed and refused
  tickets on the job dated in `from..to`, returns `ticketIds` and `ticketReconciliation` per day (billed
  minutes from time entries vs signed minutes from tickets). Where billed exceeds signed the builder flags
  the day and the invoice screen (R1-D, `jobs.js`) requires a reason before saving. With
  `settings.tickets.billFrom: 'tickets'`, labour lines bill the signed ticket hours instead of time entries
  (materials still come from moves and requests). Saving the invoice moves those tickets to `billed`.
- **Service jobs** (`job.kind: 'service'`): when a signed ticket arrives, the tickets sweep creates a draft
  invoice from it (`ticketToInvoiceLines`, the job's rates and price book; number assigned on the server the
  way the QuickBooks pull numbers invoices) and notifies the `invoices` permission "Price within the hour:
  service call T-1042 signed" (kind `service_draft`). When the office sends it, the existing send flow
  emails or texts the pay link.

Server rules (R1-A, `checkWriteRules`): crew write only their own tickets and only while `draft`; they may
move `draft` to `signed` (with a `signatureId` that passes 2.10) or `refused`. After `signed` or `refused`
the content fields are frozen for everyone; users with the `invoices` permission may set `priced`,
`billed`, `void`, `changeOrderId`, `invoiceId`, `office`, `notice`. Voiding a signed ticket needs the
`invoices` permission and a full session (not a crew PIN), and is audited. Deleting a signed or refused
ticket is refused (void it).

### 4.2 On-device signature on estimates and change orders (R1-D)

- Estimate detail → "Sign on this device": the customer sees number, title, scope lines, total with tax,
  valid-until and notes, then signs. Writes the signature, then the estimate `{ status: 'accepted',
  signatureId, signedAt, signedName, acceptedVia: 'signature' }`, and the job's
  `costing.budget = budgetFromEstimate(estimate, …)` (R1-E's function; 6.2). A signed estimate shows
  "Signed by …" and offers "Revise" (a copy with `revisionOf`). Accepting or signing a revision sets the
  estimate it revises to `superseded` in the same write batch (`status` is not a signed key) and replaces
  the job budget; contract value never counts a superseded estimate.
- Change orders (job → Change orders): money roles only (the customer must see the price). Signing writes
  the signature and sets the change order `{ status: 'approved', approvedOn, signatureId, signedAt,
  signedName }`. Change orders merge by id on the server (2.6), so an iPad signing CO-3 offline and the
  office adding CO-4 both survive.
- `lib/esign.js` (R1-D) wraps the sheet: `signatureSheet({ title, summary, agreementText, signers,
  onSigned })` built on `safety-capture.js signaturePad`. No portal needed.

### 4.3 Deposit invoices (R1-D, money from R1-B)

- "New deposit invoice" on a job or accepted estimate: amount or % of the estimate total, model
  `prepayment` or `security` (default `settings.deposits.defaultModel`), one line
  `{ kind: 'other', lineType: 'deposit', description: 'Deposit on E-2001' }`.
  - Prepayment: taxed like the job (GST is due when the deposit is invoiced or paid). The invoice notes
    "Prepayment: GST/RST charged now and credited on the final invoice."
  - Security deposit: the line has `taxOff: ['*']`, the invoice `taxNoneReason: 'out_of_scope'` for that
    line's key, note "Security deposit: no tax until it is applied (Excise Tax Act s.168(9))". VERIFY with
    the accountant that RST follows the same timing.
- Applying deposits on a later invoice: "Apply deposits" lists paid deposit invoices on the job (and the
  client's unassigned ones) with what is left (`depositsAvailable`). Each application is a negative line
  `{ kind: 'other', lineType: 'deposit', depositInvoiceId, qty: 1, unitCents: -X }`: prepayment lines are
  taxed like the deposit was (so tax is not charged twice); security lines carry `taxOff: ['*']` (tax is
  charged on the full final amount). A prepayment can be applied only when the later invoice's tax set
  (province, taxes, treatment, exemption) equals the deposit's; otherwise the screen offers a credit note
  against the deposit invoice and a new invoice.
- `depositsAvailable(invoices, payments, { jobId, clientId }) -> [{ invoiceId, number, model, paidCents,
  appliedCents, availableCents }]`. Only paid amounts can be applied.
- **Refund** (cancelled job or overpayment): a credit note against the deposit invoice
  (`creditReason: 'deposit-refund'`) applied to it, and a payment `{ method: 'refund', invoiceId:
  <deposit>, amountCents: -X, date }` for the cheque or card refund. Distinct from a bounced payment
  (`reversesId`).
- **Forfeit** (the customer cancels and the deposit is kept): "Keep deposit" sets `forfeitedOn` on the
  deposit invoice. A forfeited prepayment is revenue on that day (11). A forfeited security deposit is
  flagged "Ask your accountant: tax on a forfeited deposit (Excise Tax Act s.182, VERIFY)"; no tax is
  computed in R1.
- Unapplied deposits show on the client, the job, the statement and the month-end export (a liability).

### 4.4 Receiving payments, disputes and back-charges (R1-D)

- **Receive payment** (`#/invoices/receive`, and from a client): one cheque, EFT or deposit (date, method,
  reference, amount) split across the client's open invoices (`allocateReceipt` suggests oldest first, the
  office edits). Each allocation is a payment with the same `receiptId`; anything left is an on-account
  payment (`invoiceId: null`, `clientId`). On-account credit is applied later with "Apply credit": a
  payment `{ invoiceId, appliedFromId: <on-account payment>, amountCents }` and the on-account payment's
  remaining balance drops by the same amount (`Σ appliedFromId` against it).
- **Short-pays and disputes**: an amount the customer did not pay is recorded on the invoice as a dispute
  `{ lineIndex?, cents, reason }`. `undisputedBalance(invoice, payments)` = balance − open disputes.
  Reminders, interest and the past-due hold run on the undisputed balance. "Concede" creates a credit
  note for the amount (`creditReason: 'dispute'`, linked by `creditNoteId`) and closes the dispute; "Won"
  closes it and the amount is collected normally.
- **Back-charges** (the GC deducts cleanup or damage): a credit note with `creditReason: 'backcharge'` on
  the job, applied to the invoice it was taken from. It reduces job revenue (11).
- **Bad debt**: a credit note with `creditReason: 'bad_debt'`, flagged for the accountant on the month-end
  export ("GST s.231 adjustment and the Manitoba RST bad-debt refund; VERIFY").

### 4.5 Collections (R1-D)

- **Statements**: `#/invoices/statements` (pick a client, a period) and from the client page.
  `statement(clientId, { from, to, invoices, payments, asOf }) -> { openingCents, rows: [{ date, type,
  number, chargeCents, creditCents, balanceCents }], aging: { current, d30, d60, d90, d90p }, closingCents,
  holdbackRetainedCents, disputedCents, onAccountCents, depositsUnappliedCents }`. Holdback retained and
  disputed amounts show on their own lines, out of aging. Print uses the existing print flow. Email:
  `POST /api/v1/statements/:clientId/send { from, to, toEmail? }` (R1-D, `invoices` permission) builds the
  HTML on the server from the same library and queues an outbox item (kind `statement`, transactional).
- **Interest**: only when `settings.collections.interest.enabled` and the invoice was issued with
  `interestDisclosed: true`. The collections screen builds the terms sentence from the settings, always
  with the annual rate ("Overdue accounts are charged 1.5% per month (18% per year) from the end of the
  grace period", Interest Act s.4); `interestDisclosed` is true only when that sentence is in the
  invoice's `termsText` snapshot. `interestDue(invoice, payments, { annualPct, graceDays, asOf }) -> cents`:
  simple interest per day on the undisputed balance from the end of grace (due date + `graceDays`). Never
  on interest invoices, holdback retained, or release invoices before their due date. "Charge interest"
  (monthly, office) creates an invoice `kind: 'interest'`, lines `lineType: 'interest'`, `taxNoneReason:
  'exempt'` (interest is an exempt financial service; VERIFY), `interestFor` listing each invoice and
  period, so no period is charged twice.
- **Reminder steps**: `#/invoices/collections` edits `settings.collections.reminders` (presets offered:
  3 days before due, 1, 15 and 30 days after). The daily job (10.1) queues outbox items with the
  deterministic id `rem-<invoiceId>-<stepKey>` (a second run never doubles), kind `invoice_reminder`,
  channel email or SMS, to the client's `credit.statementEmail`, else email, else phone. The amount in the
  reminder is the undisputed balance less holdback retained. Skipped: draft, void, paid, credit and
  interest invoices, release invoices before their due date, an undisputed balance of zero, a recorded
  notice of non-payment covering the whole balance, `client.credit.remindersPaused`, no contact. SMS
  honours STOP (the outbox already refuses opted-out numbers). The invoice shows its reminders from the
  outbox (`relatedId`).
- **Past-due hold at dispatch**: the daily job computes `creditHold(client, invoices, payments, settings,
  asOf) -> { on, reason, overdueDays }`: past due more than `holdAfterDays` on the undisputed balance
  (holdback retained excluded), or `creditExposure` over `limitCents` when `holdOverLimit`. Exposure = open
  AR (disputed included) + holdback retained + unbilled T&M at sell (`tm.js unbilledTm`). It patches
  `clients.credit.hold` as `system:receivables` when it changes; it runs again for a client after a
  payment through the same job queued with a dedupe key. `holdOverride` (office) forces `hold` or
  `release` (until a date). Schedule (assigning a job of a held client) shows "Past due: hold work" and
  needs "Dispatch anyway", recorded on the schedule entry as `holdAck { by, at }`. The job header shows
  the flag. No amounts reach field roles.

### 4.6 GC credit application and limit (R1-B for the client card, R1-D for its effects)

The client "Credit" card (R1-B, `clients.js`): application status and dates, approved by and on, credit
limit (money roles only), terms in days, statement email, reminders paused, hold override. "Print credit
application" prints a blank form (company details, legal name, addresses, contacts, trade references,
bank reference, terms, authorised signature) from a template in `clients.js`. The limit feeds
`creditHold` (R1-D). A new invoice for a client over its limit shows a warning (R1-D).

### 4.7 Ready to bill and the billing cutoff (R1-D)

- `#/invoices/ready` (`readyToBill(sources, { asOf })`): signed or refused tickets not priced (fixed-price
  jobs) or not billed (T&M jobs); approved change orders not billed; unbilled T&M by age; jobs `complete`
  but not `invoiced`; holdback releases due (`holdbackReleaseOn` reached); proper invoices with no
  `deliveredOn` ("When and how was this delivered?"); open disputes. Each row shows its age in days and a
  button to the action.
- KPIs on the same page: invoice lag (`invoiceLagDays`: median days from a job's `complete`, or a ticket's
  signature, to its invoice, last 90 days) and DSO (`dso`, last 90 days).
- Dashboard card (R1-D, `dashboard.js`, money roles only): ready-to-bill count and oldest age, plus the
  price variance count (R1-E's `priceVariances`).
- `jobs.contract.billingCutoffDay`: the daily job notifies the `invoices` permission
  `collections.cutoffNoticeDays` before it ("J-1042: GC billing cutoff on the 25th; 3 items ready to
  bill", kind `billing_cutoff`, ref `cutoff:<jobId>:<month>`).

### 4.8 Final-billing checklist (R1-D)

`closeoutChecklist(job, sources, { at })` items:

| key | severity at `invoiced` | when |
| --- | --- | --- |
| `co_unbilled` | block | an approved change order has no invoice line with its `changeOrderId` |
| `tickets_open` | block | a signed or refused ticket is not priced (fixed price) or billed (T&M), or a draft ticket is older than `tickets.draftStaleDays` |
| `tm_unbilled` | block | a T&M job has unbilled approved time or material (`unbilledTm`) |
| `time_unapproved` | warn | time on the job waits for approval |
| `holdback_unreleased` | block when `holdbackReleaseOn` has passed, warn otherwise | retained holdback has no release invoice |
| `deposits_unapplied` | block | a paid deposit on the job is not applied, refunded or forfeited |
| `deposit_unpaid` | warn | an unpaid deposit invoice on the job (void it or collect it) |
| `disputes_open` | warn | open disputes on the job's invoices |
| `drafts` | warn | draft invoices on the job |
| `po_open` | warn | open purchase orders, or received PO lines with no bill |
| `permit_open` | warn | a permit without a passed final inspection |
| `gst_substantial` | warn | substantial performance is recorded and contract value is unbilled (GST may be due: ETA s.168(3)(c)) |

- Setting a job to `complete` runs the checklist with every item as a warning, shows it, and saves
  `closeout.open`. The daily job notifies "J-1042 complete 14 days, not closed out"
  (`closeout.remindAfterDays`, kind `closeout_due`, ref `closeout:<jobId>`).
- Setting a job to `invoiced` runs it with the severities above. With nothing blocking the job saves
  `closeout { checkedAt, checkedBy, open: [] }`; otherwise the office records `override { by, at, reason }`
  (at least 10 characters). Server (R1-A, `checkWriteRules`): a change of `status` to `invoiced` needs
  `closeout.checkedAt` and either `open` empty or an `override.reason`.
- The release invoice is not pushed early: "Invoice holdback release" is offered from `holdbackReleaseOn`
  (the daily job notifies on that day, kind `holdback_due`), and the release invoice's issue and due dates
  default to that day.

---

## 5. Item 3: Offsite backups (R1-C)

Facts today: `deploy/<env>/backup.sh` encrypts with `age`, keeps 14 daily, 8 weekly, 5 pre-deploy, and
copies offsite when `OFFSITE_RSYNC_TARGET` or `OFFSITE_RCLONE_REMOTE` is set (neither is). It writes
`last-backup.json` with `offsite: ok|failed|skipped`. `restore-test.sh` already restores a local file
into a throwaway container. HQ health reads the backup status but ignores offsite.

Recovery point: at most 24 hours of server data (the daily backup), plus whatever is still unsynced on
phones (it syncs when they reconnect to the restored server).

### 5.1 Scripts (identical in `deploy/production/` and `deploy/staging/`; CI checks they match)

- `backup.sh`: add `lastOffsiteOkAt` and `offsiteTarget` (provider kind and region or host only, never
  keys or full URLs) to `last-backup.json` and the log line.
- New `offsite-drill.sh`: **runs on any machine with Docker and rclone, never on the production or staging
  server** (Kelvin's PC through Docker Desktop or WSL, or a throwaway VM). It uses a read-only bucket key
  from its own rclone config, fetches the newest daily backup and its `.sha256` into a private temp
  directory, checks the checksum, runs `restore-test.sh --file <tmp> --identity -` (identity on stdin,
  never on disk), then with `--verify-secrets` runs `node server/scripts/verify-restore.mjs` from the
  checkout against the scratch database with `SECRETS_MASTER_KEY` read from stdin: the migration version,
  row counts per tenant for the main tables, and one encrypted column per kind decrypts (QuickBooks
  tokens, integration secrets). It records a JSON line with `"source": "offsite"` and `"host": "off-box"` in
  `restore-tests.jsonl`, and deletes the temp copy. Options: `--identity -`, `--verify-secrets`, `--keep`,
  `--log`, `--dry-run` (lists what it would fetch). Exit codes: 0 pass, 1 failed restore, 2 bad usage, 3
  no offsite target, 4 nothing to fetch, 5 secrets did not decrypt.
- No script runs against the live servers as part of this release. The Lead or Kelvin runs them.

### 5.2 Monitoring

- `server/src/services/hq-health.js` `readBackupStatus` adds `offsite: { status, lastOkAt, ageHours,
  stale (> 26 h), target }` and reads `RESTORE_TESTS_FILE` (new env var in `config.js`, R1-C) into
  `restoreTest: { lastPassAt, lastSource ('local'|'offsite'), lastHost, secretsChecked, ageDays,
  stale (> 92 days) }`. The drill's JSON line reaches the server when Kelvin uploads it through the HQ
  health page ("Record a drill result", HQ staff only), which appends it to that file.
- `healthLevel` problems: "offsite backup not configured" (production), "offsite backup failed",
  "offsite backup stale", "restore drill overdue", "no offsite restore drill yet".
- New `server/src/services/backup-alerts.js`: job `hq_backup_alerts` (hourly, general pool) emails HQ
  through the platform email once per problem per day (dedupe key `hq_backup_alerts:<problem>:<day>`).
  `scheduleBackupAlerts(db)` and `BACKUP_ALERT_HANDLERS`; the Lead registers both in `worker.js`.
- The HQ Developer health page shows the offsite and restore-drill lines.

### 5.3 Runbook and Kelvin's checklist

`docs/runbooks/offsite-backups.md` (new) and updates to `restore-from-backup.md` and
`docs/compliance/backup-retention.md`. Kelvin's steps are in section 15 (items 1 to 9).

---

## 6. Item 4: Job costing that tells the truth (R1-E)

### 6.1 What counts as cost (`costing.js jobActuals`)

Every source is filtered to dates on or before `asOf` when one is given.

| source | cost | notes |
| --- | --- | --- |
| time entries on the job | straight-time hours × the burdened cost per paid hour **on the entry's day** (`rateOn(employee.rateHistory, day)` with `burden.js` for that year), plus the overtime premium | travel included; split into wage, burden and `otPremiumCents`. Overtime: `timesheet.js allocateOvertime` under the company's province rule marks the minutes that crossed the daily or weekly threshold, in time order; those minutes add 0.5 × wage × (1 + statutory %) |
| correction entries | `adjustMinutes` at the rate on `workDay` | negative corrections reduce cost |
| trucks on time entries (`equipmentId`) | `truckCharges`: per (equipment, day), an hour rate is charged on the **union** of the intervals of every entry carrying that truck (two people in one truck count once); a day rate is charged once per day; either is split across that day's jobs by hours on each | rate from `equipment.rateHistory` on the day |
| equipment use records | qty × the equipment's rate on the day | a `source: 'ticket'` record for a truck already charged through a time entry that day is ignored |
| bills and receipts (status open or paid) | line amount for lines whose `jobId` (or the bill's) is the job; own-use lines add their share of PST/RST; resale lines add none (unless written off) | by `costType` and `costCodeId`. Lines whose PO line was received into a stock location are inventory, not job cost (the issue move carries the cost); lines with `equipmentId` are truck cost, never job cost. Supplier credits (negative lines, `reversesId`) inherit the original line's `jobId` |
| stock moves onto the job | qty × `unitCostCents` (server-stamped) or the item's `avgCostCents ?? costCents` for old moves | own-use moves onto warranty and callback jobs add self-assessed RST (3.5). Moves with `jobId` and a `toLocationId` (returns from the job to a van or the shop) count as negative job use. Receive moves straight to the job (`use: 'receive'`, `jobId`) count at their PO unit cost |
| fulfilled material requests | qty × `costCents` | only when no stock move covers it and no bill covers it (the bill's `materialRequestIds`, or a PO line's `materialRequestIds` on a PO a bill line references through `poLine`) |
| received not billed | PO lines on the job: (received qty − billed qty) × PO unit price (`receivedNotBilled`) | added to cost to date as "accrued"; dropped as bills arrive |
| committed | open and sent PO lines on the job: (qty − received qty − billed-without-receipt qty) × unit price (`committedCost`) | shown separately, never added to cost to date |

### 6.2 `jobCosting()` in `lib/tm.js`, budgets and contract value

Signature gains `bills`, `purchaseOrders`, `equipment`, `equipmentUse`, `rules`, `settings`, `asOf`. Old
keys stay with these meanings: `labourCents` is now burdened labour including overtime premium (when no
burden data exists it equals the bare wage and `burdenMissing: true` is set), `materialCents` includes
stock and requests net of returns, `costCents` is every cost. New keys: `labourWageCents`, `burdenCents`,
`otPremiumCents`, `billsCents`, `subcontractCents`, `equipmentCents`, `otherCents`, `accruedCents`,
`committedCents`, `byCostCode { [id|'none']: { estCents, actualCents, hours } }`, `varianceCount`,
`burdenMissing`. `jobs.js` keeps calling it unchanged and shows better numbers.

- `contractValue(job, estimates, { asOf })` = `contract.valueCents` when set, else the latest accepted
  estimate that is not `superseded`, plus change orders approved on or before `asOf` (by `approvedOn`).
  The old "sum of every accepted estimate" goes away.
- `budgetFromEstimate(estimate, { items, employees, rules, settings, on })` -> `{ labourHours,
  labourCostCents, materialCents, subCents, equipmentCents, otherCents, byCostCode }`: labour at
  `breakEven().burdenedCostPerProductiveHourCents` on the acceptance day (the same basis as actual labour),
  material at the item's cost then, `other` and subcontract lines at cost (their cost, else the price over
  1 + markup). R1-D stores it on the job at acceptance (`jobs.costing.budget`); jobs accepted before R1
  compute it on the fly. A change order's budget is its `estCostCents` (office, optional), else its amount
  × (budget total ÷ the estimate's subtotal).
- Estimated cost = `costing.estCostOverrideCents`, else budget + change-order budgets.

### 6.3 Price variances

`priceVariances(bill, { purchaseOrders, items, tolerancePct }) -> [{ lineIndex, billUnitCents,
refUnitCents, refKind: 'po'|'price-book', overPct, overCents }]`: a bill line with `poLine` compares with
that PO line's price (which may be a wholesaler's job quote, with `quoteRef`), otherwise a line with
`itemId` compares with the item's `costCents`. Bills never update `items.costCents` (the price book is
changed by people), so the comparison stays meaningful. Flagged when over by more than
`settings.costing.priceVariancePct` and more than $1.00 in total. The bill editor shows the flags;
"Checked" stores `varianceAck`. A Price variances report lists unacknowledged ones. The dashboard card
(R1-D) shows their count to money roles.

### 6.4 Burden (`burden.js`)

```js
burdenRate(employee, { rules, settings, year, on }) -> {
  wageCents, annualHours, vacationPct, holidayPct, cppPct, eiPct, wcbPct, levyPct, benefitsCentsPerHour,
  statutoryPct, nonProductivePct, costPerPaidHourCents, costPerProductiveHourCents, warnings: []
}
```

- Wage = `rateOn(employee.rateHistory, on)`, else `rateCents`.
- Expected annual earnings = wage × `annualHours` (employee, else `settings.costing.annualHours`) × (1 +
  vacation % + holiday %): CPP, EI and WCB also apply to vacation and holiday pay. Earnings of zero give
  zero burden and a warning, never a division by zero.
- CPP: `min(rate × max(0, earnings − basicExemption), rate × (ympe − basicExemption)) / earnings`, plus
  CPP2 on earnings between YMPE and YAMPE. EI: `min(earnings, mie) × eiRate × employerFactor / earnings`.
  WCB: `min(earnings, maxAssessable) × wcbPct / earnings`. Health levy: `payroll.company.healthLevyPct`
  when set. So a flat percentage never overstates cost for high earners late in the year.
- Vacation: employee override, else 6% from the hire-date anniversary in `vacationLongYears`, else 4%
  (rules). Holiday: employee override, else `payroll.MB.constructionHolidayPct` for MB construction.
- A rule that is `verify`, missing, or missing for `year` (`missingYear`): that part uses
  `settings.costing.statutoryPctFallback` and adds a warning ("CPP/EI 2027 rates not loaded; using your
  flat 12%"). Nothing silently becomes zero and last year's maximums are never reused silently.
- `costPerProductiveHourCents = costPerPaidHourCents / (1 − nonProductivePct/100)` (employee, else
  `settings.costing.nonProductivePctDefault`). Help text: non-productive time is shop, school, callbacks
  and unbilled travel; travel already charged to jobs is not included.

### 6.5 Break-even billing rate

`breakEven({ employees, equipment, rules, settings, year }) -> { rows: [{ employeeId, name,
costPerProductiveHourCents }], burdenedCostPerProductiveHourCents, overheadPerProductiveHourCents,
equipmentRecoveryPerProductiveHourCents, breakEvenRateCents, targetRateCents, labourOnly }`.
Only field roles (electrician, apprentice, foreman) count: their Σ cost per paid hour × annual hours +
annual overhead, divided by their Σ productive hours. Office wages belong in overhead. Help text for
`overheadAnnualCents`: "Leave out truck and equipment costs recovered through equipment rates." Equipment
recovery is shown beside it, not added. Without overhead the result is labelled "Labour cost only, not
break-even" (`labourOnly: true`). Target = break-even / (1 − target margin). Shown on Job costing → Rates
with the company labour rate beside it.

### 6.6 Screens and routes (R1-E)

- `#/reports` Job profit list; `#/reports/jobs/<id>` job detail by cost type and cost code with budget
  against actual, accrued and committed; `#/reports/wip`; `#/reports/rst`; `#/reports/variances`;
  `#/reports/rates` (burden per employee, break-even, equipment list with rate history, recovered vs
  actual per truck year to date from bill lines with `equipmentId`, costing settings).
- Employees (R1-E, `employees.js`): hire date, rate history ("New rate from <date>"; `rateCents` stays the
  current rate), bill rate, burden fields, default truck.
- Purchasing (R1-E): per-line tax use and cost code, `equipmentId` on lines (with a warning when a line has
  both a truck and a job), variance flags, committed cost per job, PO lines "Mark received", PO line
  `quoteRef`.
- **Field receiving** without prices: `GET /api/v1/receiving?jobId=|locationId=` lists open PO lines
  (item, description, ordered, received) and `POST /api/v1/receiving/:poId` `{ lines: [{ index, qty }],
  toLocationId?, jobId? }` records receipt (route file `server/src/routes/v1/receiving.js`, service
  `server/src/services/receiving.js`). Permission `inventory` or `jobs`; online only. It patches the PO
  line's `receivedQty`/`receivedAt` and creates receive moves (`use: 'receive'`, `poId`, `poLineIndex`,
  `unitCostCents` = the PO price) as the system actor `receiving`, updates `items.avgCostCents` (8.4), and
  returns no prices. The PWA "Receive" button is on Materials and Inventory (R1-E).
- Estimates and invoices carry `costCodeId` on lines; the line editor (R1-B, `doc-view.js`) shows the
  picker when the company has cost codes.

---

## 7. Item 5: Prompt-payment basics (R1-D; money from R1-B)

### 7.1 Job contract fields

Job → "Contract and payment" card: role (prime contract with the owner, or sub to a GC), our contract
signed on, the prime contract signed on (for subs; "unknown" allowed), owner name, GC (a client),
contract number, contract value (money roles), holdback %, payment terms, billing cutoff day, authorized
signers, substantial performance date and certificate date, holdback release date (typed by the office
while the release rule is VERIFY), last supplied on (suggested from the last time entry, receive move or
ticket on the job; editable; for the lawyer and a later lien countdown), proper invoices required, tax
exemption (3.2).

### 7.2 When the rules apply

`promptPaymentApplies(job, invoice, rules) -> { applies, role, why }`: province MB (invoice `taxProvince`,
else the company's), and the governing contract date (prime: `contract.signedOn`; sub:
`contract.primeSignedOn`) is on or after `pp.MB.inForceFrom`, and the invoice is a proper invoice
(`properInvoice` or the job's `properInvoiceRequired`), and every rule used is usable. While
`pp.MB.appliesTo` is unconfirmed, the screen adds "Check that the Act applies to this contract
(residential and value exclusions)". Unknown dates: no alarms, and the job card says which date to add.

### 7.3 Holdback on invoices and the release invoice (money in R1-B, screens in R1-D)

- Any invoice may carry `holdback { pct, cents, deferTaxIds }`; the job's `contract.holdbackPct` fills
  `pct` (`holdback.MB.pct` is shown for reference only). `deferTaxIds` is snapshotted when the holdback is
  set: `GST`/`HST` when `tax.CA.gstHoldbackAtRelease` holds, plus the provincial tax when its own policy
  holds (`tax.MB.rstHoldbackAtRelease`, `tax.SK.pstHoldbackAtRelease`, `tax.BC.pstHoldbackAtRelease`).
- `docTotals`: work subtotal = lines with no `lineType` (markup included). Holdback base = the work lines,
  less pass-through lines while `holdback.excludePassThrough` holds. `holdbackCents = cents ??
  pctOfCents(holdbackBase, pct)`. For each deferred tax, its base is reduced by `holdbackCents`.
  `netSubtotalCents = subtotalCents − holdbackCents`; `totalCents = netSubtotalCents + taxCents`.
  `holdbackProblem(doc)` refuses a holdback when a deferred tax does not apply to every line **in the
  holdback base** alike (QuickBooks can't express it; such jobs are split), or when it exceeds the base.
- The invoice prints "Holdback retained (10%)" as a deduction before tax.
- **Progress summary block** (R1-B, `progressSummary`, printed on `kind: 'progress'` invoices and any
  invoice with a holdback on a job with a contract value): contract plus approved change orders,
  previously billed (gross of holdback), this invoice, holdback retained to date, balance to finish.
- **Holdback the GC kept on its own**: on a sent invoice without a holdback, "Customer retained holdback"
  records `holdback.retainedByCustomerCents` (and who and when) without changing the invoice's tax or
  total. That amount leaves aging, reminders, interest and the past-due hold, shows in `holdbackLedger`
  and on statements, and stays owed on the original invoice; "Request holdback release" prints a letter
  listing the amounts retained per invoice. No release invoice is issued for it (the tax was charged on the
  original invoice).
- `holdbackLedger(invoices, { jobId }) -> { retainedCents, retainedByCustomerCents, releasedCents,
  outstandingCents, byInvoice }`.
- "Invoice holdback release" (job, from `holdbackReleaseOn`): an invoice `kind: 'holdback-release'`,
  `holdbackInvoiceIds`, one line `{ kind: 'other', lineType: 'holdback', unitCents: outstanding }` taxed
  by the deferred taxes only (the others were charged on the progress invoices: the line has `taxOff` for
  every non-deferred tax).
- Reports count holdback as revenue when the progress invoice is issued; release lines are not counted
  again (11).

### 7.4 Proper-invoice fields

An invoice with `properInvoice` shows and prints `periodFrom`, `periodTo`, `contractRef`, and the fields
in `properInvoice.MB.fields`. Missing ones are warnings only while that rule is `verify`. A proper invoice
with no `promptPayment.deliveredOn` asks "When and how was this delivered?" on the invoice and on the
ready-to-bill list (invoices sent from QuickBooks or uploaded to a GC portal).

### 7.5 Day-14 and day-28 alarms

- `promptPaymentDates(invoice, job, rules) -> { role, deliveredOn, noticeDueOn, paymentDueOn, gcDueOn,
  expectedLatestOn, mayMove }`. `deliveredOn` = `promptPayment.deliveredOn` (defaults to the day the
  invoice was emailed through Fishtape, editable). All counts are calendar days.
  - **Prime** (`contract.role: 'prime'`): notice due = delivered + `pp.MB.nonPaymentNoticeDays`; payment
    due = delivered + `pp.MB.paymentDays`.
  - **Sub** (`role: 'sub'`): no day-14 or day-28 dates (those run on the GC's own invoice to the owner).
    When the office records `gcPaidOn`, the GC's payment to us is due at `gcPaidOn` +
    `pp.MB.subPaymentDays`. Otherwise the screen shows an information line, "Expected latest about
    <delivered + paymentDays + subPaymentDays> if the GC billed the owner promptly", and no alarm.
  - While `pp.MB.dayRollover` is unconfirmed, a date that falls on a weekend or holiday shows as
    "Sat 2026-11-14 (may move to Mon)" (`mayMove: true`).
- `promptPaymentAlarms(invoices, jobs, payments, rules, asOf) -> [{ invoiceId, step: 'day14'|'day28'|'gc7',
  title }]`, run by the daily job (10.1):
  - `day14` (prime only), the day after notice due, when no notice of non-payment is recorded: "No notice of
    non-payment on INV-3010 by day 14: the full amount is due by 2026-11-18."
  - `day28` (prime only), the day after payment due, with an undisputed balance: "INV-3010 is past its
    prompt-payment date."
  - `gc7` (sub only), the day after the GC's 7 days, with a balance.
  Each goes to the `invoices` permission (kind `prompt_payment`, ref `pp:<invoiceId>:<step>`, so once).
- The invoice detail shows the dates, a "Record notice of non-payment" form (received on, disputed amount,
  reason), and "Based on published guidance, not legal advice. Confirm deadlines with your lawyer." while
  any rule used is `sourced` rather than `verified`.
- Contracts signed before 2025-04-01 or outside Manitoba: no alarms, no dates.

### 7.6 GST timing

GST on holdback at release (7.3). GST at substantial completion: when `substantialPerformanceOn` is set
and contract value is unbilled, the daily job notifies once (kind `gst_due`, ref `gst:<jobId>`) and the
closeout checklist warns.

---

## 8. Item 6: Period lock and month-end close

### 8.1 Books → Closing date (R1-A, `modules/books.js`)

`#/books` shows the books lock and payroll exported-through date, who set them and when, the QuickBooks
dates beside them when connected ("QuickBooks books closed through 2026-09-30, GST filed through
2026-09-30"; a warning when Fishtape's lock is earlier than QuickBooks'), late postings, refused writes,
and history. "Close through" defaults to the end of last month and shows the pre-close checklist (2.6)
first. Reopening asks for a reason and warns that payroll and filed returns may no longer match. Locked
records across the app show a lock icon and disable editing (`isLocked`); invoices offer "Issue credit
note", bills "Supplier credit", stock moves "Reverse", time entries "Add a correction" instead.

### 8.2 Payroll runs (R1-A, `modules/time.js` and `modules/books.js`)

After "Export payroll" builds the file (existing `timesheet.js`), the sheet lists late hours from earlier
periods and corrections not yet exported (ticked, included as prior-period adjustment rows with their
work date and a `late` column), and offers "Lock these timesheets" (on by default). If entries in the
period are open, unapproved or left out, the sheet lists them before export: "These 3 entries are not in
this run. They will wait in Late hours for the next run." Online only: it calls
`POST /api/v1/closing/payroll-runs` (with `leftOutAck` after the office confirms); offline the export still
downloads and the screen says the lock happens when back online (a queued call, retried from the Books
page). `#/books/payroll` lists runs, the Late hours queue, and has "Reopen" (owners and admins, reason
required).

### 8.3 Month-end cutoff export (R1-E, `modules/monthend.js`)

```
cutoff({ asOf, jobs, estimates, invoices, payments, timeEntries, payrollRuns, stockMoves, materialRequests,
bills, purchaseOrders, items, employees, equipment, locations, settings, rules, zone }) -> {
  accruedRevenue: { wipUnderBilledCents, wipOverBilledCents, tmUnbilledCents, rows },
  changeOrdersApprovedUnbilled: rows,                    // information only, never added
  accruedCost: { receivedNotBilledCents, rows },         // PO lines received and not billed, at PO price
  accruedPayroll: { wagesCents, burdenCents, vacationCents, holidayCents, rows },
  holdbackReceivableCents, depositsUnappliedCents, onAccountCreditCents, disputedCents,
  rstSelfAssessCents, badDebtCreditNotes: rows,
  inventory: [{ locationId, name, valueCents }],         // valuationByLocation(asOf)
  journal: [{ account, debitCents, creditCents, memo }], // suggestion, reversed on the 1st
  signedTicketsUnpriced: count
}
```

- Revenue accrual: fixed-price jobs from WIP as of `asOf` (under-billed and over-billed, 11); T&M jobs
  from unbilled T&M at sell. Approved change orders not billed are listed only (WIP's contract already
  includes them).
- Accrued payroll: hours worked on or before `asOf` that are in no exported payroll run, at the wage on the
  day plus burden; vacation and holiday pay only when the payroll modes are `accrue`.
- Journal (account names from the QuickBooks mappings when connected, else these labels), each reversed on
  the 1st:
  - Dr Costs and estimated earnings in excess of billings / Cr Contract revenue (under-billed).
  - Dr Contract revenue / Cr Billings in excess of costs and estimated earnings (over-billed).
  - Dr Accounts receivable, unbilled / Cr Contract revenue (T&M unbilled).
  - Dr Job cost / Cr Accrued liabilities (received not billed).
  - Dr Wages and burden / Cr Accrued payroll.
  - Dr Expense or job cost / Cr RST payable (self-assessed RST; "add it to your RST return").
- The screen shows each block with drill-down, prints, and exports CSV (`cutoffCsv`). Nothing is pushed to
  QuickBooks.

### 8.4 Inventory valuation and count sheets (R1-E, `modules/inventory.js`)

- **Cost method**: moving weighted average, `items.avgCostCents`, updated by the receiving route (6.6) on
  each receive move: `(on hand × avg + qty × unit cost) / (on hand + qty)` (`movingAverage`). Issue moves are
  stamped at the average by the server (2.6). Items never received through a PO fall back to `costCents`.
- `valuationByLocation({ items, stockMoves, locations, asOf })`: quantity per location as of `asOf` (today's
  stock with moves after `asOf` rolled back) × the average as of then. The month-end export uses it.
- Count sheets (`#/inventory?tab=counts`): new count for a location lists items with expected quantities
  (`countSheet`); people count on a phone (offline). Write rule (R1-A): users with the `inventory`
  permission and manager role, or the employee whose `defaultEquipmentId` truck has this `locationId`,
  may create and edit `draft` and `counted` counts for that location. "Post" (managers only) creates one
  adjustment stock move per difference through `countAdjustments` (`use: 'adjust'`, `countId`, dated the
  count date): counted minus the location's quantity at `countedAt` (stock now minus moves after
  `countedAt`), so van moves during counting do not skew it. Adjustments are not own use. The count
  becomes `posted` with `moveIds`. Posting a count whose date is in a closed period posts on the next open
  day (`postedOn`).

---

## 9. QuickBooks impact (R1-F)

All of this lands as section 17 "Release 1" of `docs/integrations/quickbooks.md`, with its tests.

### 9.1 Per-line tax keys

`lineTaxKey(doc, line)` replaces the per-kind key: the doc's taxes that apply to the line's kind minus its
`taxOff`. A pass-through line on a Manitoba invoice gets `'GST'`; a security-deposit line `NONE|OOS`. Pull:
lines of one kind whose key is the kind's key minus some ids set `taxOff` instead of sending the document
to `tax_shape` review. `qbo-export.js` (CSV) uses the same per-line keys.

### 9.2 Holdback, deposits, interest, credit notes, payments

| Fishtape | QuickBooks | rule |
| --- | --- | --- |
| `holdback` on an invoice | a negative line on the generic item `item.holdback` (new mapping key), amount −holdbackCents, tax code of the deferred taxes | VERIFY negative sales lines (already 11.4); the accountant points `item.holdback` at a Holdback receivable account |
| `holdback.retainedByCustomerCents` | nothing (the amount stays open on the invoice in QuickBooks too) | Fishtape-only |
| release invoice line (`lineType: 'holdback'`) | positive line on `item.holdback` | |
| deposit and application lines (`lineType: 'deposit'`) | `item.deposit`; security-deposit lines with `NONE|OOS` | deposit-kind pushes are held `blocked/mapping_missing` until `item.deposit` is mapped explicitly (its default, the `other` item, is an income account) |
| interest invoice (`lineType: 'interest'`) | generic item `item.interest` (new), `NONE|EXEMPT` | |
| credit note (`kind: 'credit'`, any `creditReason`) | `CreditMemo` with the same line rules, amounts made positive; `bad_debt` notes carry the memo "Bad debt write-off" | VERIFY with the accountant whether bad debt is booked this way |
| payment `method: 'credit-note'` | a `Payment` with `TotalAmt` 0 and two lines (the invoice and the CreditMemo), link role `apply` (migration 0162) | VERIFY in the sandbox; until confirmed it is held `needs_review/credit_apply` |
| pulled `CreditMemo` | linked to one invoice: a Fishtape credit note plus its `credit-note` application; otherwise it stays in the settlement payment (4.9) | `settlementCents` subtracts the cents of credit memos that have a Fishtape credit-note application (link role `apply`), so a memo is never counted twice |
| payment with `receiptId` | each allocation is its own QuickBooks `Payment` | VERIFY with the accountant that the bank deposit groups them |
| payment with `invoiceId: null` (on account), `appliedFromId`, or `method: 'refund'` | never pushed in R1: `needs_review/on_account` or `needs_review/refund` ("Record this in QuickBooks") | |
| payment with `reversesId` | never pushed: `needs_review/reversal` ("Record the returned payment in QuickBooks") | |
| bill with negative lines (supplier credit) | `VendorCredit`; RST on resale lines to `account.rstRecoverable` | VERIFY |
| `disputes`, `forfeitedOn`, `postedOn`, `late` | nothing | Fishtape-only |

Pulled invoices keep Fishtape-only fields (`kind`, `depositModel`, `forfeitedOn`, `holdback.deferTaxIds`,
`holdback.retainedByCustomerCents`, `promptPayment`, `termsText`, `interestDisclosed`, `properInvoice`,
`ticketIds`, `ticketReconciliation`, `disputes`, `creditReason`, `creditTaxSnapshot`) through merges;
pulled payments and bills keep `postedOn`, `late`, `receiptId`.

### 9.3 Purchase tax per line

`spreadPurchaseTax(lines, taxes, recoverableIds, { taxUse })`, with `taxUse` from `rst.js billLineTaxUse`
(imported, so the default lives in one place): PST/RST on own-use lines is spread into those lines (as
today); PST/RST on resale lines goes to one `AccountBasedExpenseLineDetail` line on
`account.rstRecoverable` (new mapping key) for its cents, never into cost, unless the line's resale credit
was written off (then it is spread into the line). Canonical bill form and pull do the reverse (a line on
`account.rstRecoverable` becomes RST on the bill with its resale lines), so a round trip is stable.
Question 16 for the accountant is reworded: "RST charged on materials we install is recoverable from the
supplier (we gave our RST number). Which account holds it until the credit comes?"

### 9.4 Migration 0162

`ALTER TABLE qbo_links DROP CONSTRAINT <role check>, ADD CHECK (role IN ('main', 'fee', 'deposit',
'settlement', 'apply'))`. Only if 9.2's application line ships.

### 9.5 Signatures, tickets, rules, cost codes

Not synced. A signed estimate is pushed as `Accepted` as today; a superseded estimate as `Closed`. Cost
codes are not QuickBooks classes in R1 (question 14).

### 9.6 Locks

- Creates in posted collections (bills, payments) are never refused by the lock: a pulled bill dated in a
  closed period is created with a later `postedOn` and `late: true`.
- A pull that would change or delete a locked Fishtape record, or create a sent invoice dated in the closed
  period after QuickBooks' own `bookCloseDate`, is refused by the records service (409 `period_locked`);
  the engine sets the link to `needs_review` reason `period_locked`: "Changed in QuickBooks in a period
  closed in Fishtape (through 2026-09-30)." QuickBooks is the book of record, so the resolutions are
  "Reopen the period and accept QuickBooks" (an owner reopens, then resolve `'quickbooks'`) or "Keep the
  difference noted" (`resolve: 'note'`, stores the note on the link and stops the review). Fishtape's copy
  is never pushed over a QuickBooks change made after the close.
- The setup wizard's creates of historical records dated on or before QuickBooks' `bookCloseDate` are
  allowed (2.6).
- The push writes `number` on invoices (`push.js`, DocNumber): `number` is a lock-safe field for the actor
  `system:qbo`, so a September invoice still waiting to sync is pushed after the lock.
- Payroll: the effective `timeLockedThrough` is the later of the mapping option and
  `settings.closing.payrollThrough`; entries in exported runs are payroll-locked for updates and deletes
  (existing `payroll_locked` review reason).
- The Books page reads `bookCloseDate`, `taxFiledThrough` and `timeLockedThrough` from the existing QBO
  status (R1-A reads them through `GET /api/v1/closing`).

### 9.7 Exemption

A pulled invoice in MB with RST off and the basis's evidence missing is created and its link goes to
`needs_review` reason `exemption_missing` ("Add the customer's RST number on the job"). Resolving it after
the evidence is added clears the review.

### 9.8 Mappings screen and wizard (`modules/quickbooks.js`, `lib/qbo-ui.js`)

New rows: `item.holdback`, `item.interest`, `account.rstRecoverable`; `item.deposit` now required before
deposit invoices push; feature notes for CreditMemo and VendorCredit; setup requires `item.holdback` only
when a company has invoices with holdback.

---

## 10. Background jobs and notifications

### 10.1 Worker jobs (the Lead adds the handler and schedule lines to `worker.js`)

| kind | owner | when | does |
| --- | --- | --- | --- |
| `receivables_daily` | R1-D (`server/src/services/receivables.js`, `createReceivablesHandlers`, `scheduleReceivablesDaily`) | once per company per local day at 07:00 in its zone (dedupe `receivables_daily:<tenant>:<day>`) | reminder outbox items, credit holds, prompt-payment alarms, the substantial-completion GST notice, billing-cutoff, closeout-due and holdback-due notices |
| `receivables_client` | R1-D | queued after a server-side payment (below) and by `POST /api/v1/receivables/recheck/:clientId` (the PWA calls it after an office user records a payment while online; offline payments are caught by the next daily run); dedupe `receivables_client:<tenant>:<clientId>` | recompute one client's hold |
| `tickets_sweep` | R1-D (`server/src/services/tickets.js`, `createTicketHandlers`, `scheduleTicketsSweep`) | every 15 minutes per company with the `tickets` module on | signed-ticket copies, written notices on refusal, service-call draft invoices, `ticket_signed` and `service_draft` notifications; each keyed by ticket id so it happens once |
| `hq_backup_alerts` | R1-C (`backup-alerts.js`) | hourly | emails HQ about backup problems |

Payment-triggered rechecks: the Stripe payment path and the QuickBooks payment pull already run in the
server; R1-D adds one `enqueue` call in `services/receivables.js` exported as `queueClientRecheck(tx,
clientId)`, and R1-F calls it from the QuickBooks payment pull. Stripe (`integrations/payments.js`, owner
R1-D for this one line) calls it after `recordStripePayment`.

### 10.2 Notification kinds (R1-A adds labels and icons to `lib/notify.js`)

| kind | to | from |
| --- | --- | --- |
| `period_lock` | owners, admins | moving or reopening a lock |
| `payroll_reopened` | owners, admins, office | reopening a payroll run |
| `late_posting` | owners, admins, office | records posted after a closed period (daily, counts only) |
| `signature_unverified` | `invoices` permission | a signature whose snapshot did not match |
| `prompt_payment` | `invoices` permission | day 14, day 28, GC 7 days |
| `gst_due` | `invoices` permission | substantial completion with unbilled value |
| `credit_hold` | `invoices` permission | a client goes on or off hold |
| `ticket_signed` | `invoices` permission | a field ticket signed or refused (no amounts) |
| `service_draft` | `invoices` permission | a service-call draft invoice is ready to price |
| `billing_cutoff` | `invoices` permission | a GC billing cutoff in N days |
| `closeout_due` | `invoices` permission | a job complete N days and not closed out |
| `holdback_due` | `invoices` permission | the holdback release date is reached |

---

## 11. Reports

**Revenue** (job profit, WIP billed to date, month-end) is defined once, `money.js revenueCents(inv)`:
Σ lines with `lineType == null` (markup and pass-through included), gross of holdback, on invoice kinds
`standard`, `progress` and `credit` (credit notes, back-charges included, are negative), not void. Never
counted: deposit lines (on deposit invoices and their applications), release lines, interest lines. A
forfeited prepayment deposit counts as revenue on its `forfeitedOn`. Unapplied deposits are a customer
deposit liability. Never `netSubtotalCents`.

| report | where | API | numbers |
| --- | --- | --- | --- |
| Job profit | `#/reports` (R1-E) | `GET /api/v1/reports/job-profit?from&to&jobId&format=csv` | revenue as above; cost by type and cost code (6.1) including accrued; gross profit, margin %, budget margin, committed |
| WIP | `#/reports/wip` (R1-E, Pro) | `GET /api/v1/reports/wip?asOf&format=csv` | per open fixed-price job (service jobs excluded): contract (`contractValue`), estimated cost (6.2), cost to date as of `asOf` (6.1, accrued included), pct = min(1, cost to date ÷ estimated cost) or the job's `pctCompleteOverride` (for stored, uninstalled materials), earned revenue = contract × pct; when projected gross profit (contract − estimated cost) is below zero, earned = cost to date + projected gross profit (the whole loss now, ASPE 3400); billed to date (revenue as above, to `asOf`), over billed, under billed. T&M jobs: earned = billed + unbilled T&M at sell. A second table lists contracts completed this fiscal year (contract, cost, gross profit) for the bonding company |
| RST self-assessment | `#/reports/rst` (R1-E) | `GET /api/v1/reports/rst?from&to&format=csv` | 3.5 |
| Price variances | `#/reports/variances` (R1-E) | none | 6.3 |
| Rates and break-even | `#/reports/rates` (R1-E) | `GET /api/v1/reports/break-even` | 6.5 |
| Ready to bill | `#/invoices/ready` (R1-D) | none | 4.7 |
| AR statements | `#/invoices/statements` (R1-D) | `GET /api/v1/statements/:clientId?from&to` (JSON) | 4.5 |
| Month-end cutoff | `#/monthend` (R1-E, Pro) | none | 8.3 |

Server routes compute with the same pure libraries over records loaded in one tenant transaction
(`server/src/services/reports.js`, R1-E). All need the `invoices` permission; WIP also `reports.wip`.

---

## 12. Tests and end-to-end scenarios

### 12.1 Tests that must exist

| stream | PWA (`node --test electrical-app/tests/*.test.mjs`) | server (`npm run test:embedded`) |
| --- | --- | --- |
| R1-A | `rules.test.mjs` (resolution newest-wins and tie to company, stale override, yearly missing year, statuses, deadline never on verify, policy applies on verify), `closing.test.mjs` (lock days per collection, `postingFor` moves late creates, drafts never locked, draft→sent refused in a closed period, safe fields, status rules without `overdue`, payroll lock by id only, late hours), `cost-codes.test.mjs` (default from `currentCostCodeId`), `exemption.test.mjs` (MB block, MB estimate warn, BC/SK warn, evidence per basis including First Nations registry number, interest/credit/security-deposit skipped, real-property and pass-through not counted), `signing.test.mjs` (canonical string stable across key order and NFC; a snapshot built from `SIGNED_KEYS` only equals the full one; v1 snapshot verifies after v2 ships), `timesheet.test.mjs` (corrections on `workDay`, late rows in the payroll file), `plans.test.mjs` and `modules.test.mjs` updates | `period-lock.test.js` (REST, sync and the QuickBooks system actor: late creates accepted with `postedOn` and flagged; edits and deletes of locked records refused; safe fields allowed; `number` safe only for `system:qbo`; creates on or before `bookCloseDate` allowed for `system:qbo`; change orders frozen by `approvedOn`; closing route permissions, MFA and reasons; preflight counts; advisory lock serialises a lock move against a write; refused writes recorded in `sync_rejections`; `settings.closing` and `postedOn` not writable by devices), `payroll-runs.test.js` (validation, `already_exported`, `unexported_entries` and `leftOutAck`, late entries, reopen), `rules.test.js` (route, company override wins on a tie, uniqueness, permissions), `r1-collections.test.js` (access rules of every new collection, crew own rows, van-owner counts, signature immutability, `unverified` on a digest mismatch, void needs `invoices` and a full session, server ticket numbers unique under two offline devices, ticket freeze, change-order merge keeps a signed CO, closeout rule, exemption send block, move cost stamped), `isolation.test.js` and `leaks.test.js` updates (every new collection; no money to an electrician from `clients.credit`, `jobs.contract`, `jobs.costing`, `settings.costing`, `equipment`, `employees.rateHistory`, `stockMoves`, `items.avgCostCents`, and any `*Cents` in a change-order or estimate signature snapshot) |
| R1-B | `tax.test.mjs` (hints, `newDocTax` with a job exemption and with client evidence only), new `money.test.mjs` (`taxOff`, pass-through out of the PST/RST and holdback bases, holdback with deferred GST only and GST+RST, `holdbackProblem` with a pass-through line, deposits prepayment and security, credit notes: tax snapshot not re-rated, negative holdback, `creditNoteBalance`, `revenueCents` per kind, `progressSummary`, rounding once per tax) | `exemption-send.test.js` (email and pay-link routes refuse in MB, allow with the evidence) |
| R1-C | none | `deploy-scripts.test.js` (offsite drill with stub `rclone`, `age`, `docker`, `node` on PATH: checksum mismatch fails, secrets check exit 5, dry run, exit codes, `host: off-box`; staging and production copies identical), `backup-alerts.test.js`, `hq-unit.test.js` (`readBackupStatus` offsite and restore drill), `hq-rules.test.js` (HQ only, validation against `RULE_DEFS`, `verified` needs who and when, audit) |
| R1-D | `receivables.test.mjs` (deposits available and tax-set check, holdback ledger with customer-retained holdback, statement balances and aging without holdback and disputes, interest only when disclosed and from end of grace and never on interest invoices, reminder plan skips, undisputed balance, receipt allocation and on-account credit, credit hold vs exposure, ready to bill, invoice lag, DSO), `prompt-payment.test.mjs` (applies only from 2025-04-01 and in MB, verify rules give no alarms, prime gets day14 and day28, sub gets none and gc7 only with `gcPaidOn`, weekend "may move"), `closeout.test.mjs` (warn-only at complete, blocks at invoiced, holdback block only after the release date), `tickets.test.mjs` (prefill includes the open entry, change-order pricing never visible to crew, refused on T&M jobs, batch snapshot) | `receivables.test.js` (daily job idempotent: reminders once by id, alarms once by ref, hold patch as system, holds visible without money, cutoff and closeout notices once), `statements.test.js`, `tickets-flow.test.js` (signature then ticket in one push; a mismatched snapshot is stored unverified and the ticket still lands; written notice queued once on refusal; service draft invoice created once) |
| R1-E | `tm.test.mjs` updates (old keys unchanged for old inputs; `buildTmInvoice` picks up tickets, reconciles hours, `billFrom: 'tickets'`), `costing.test.mjs` (dedupe of requests, bills and moves; returns netted; supplier credits by job; rate on the entry's day after a raise; overtime premium on the entries that crossed; truck union of intervals and day-rate split; ticket truck ignored; received not billed; committed; variances; contract value with a superseded revision; budget at burdened rate; WIP over and under, loss provision, pct capped at 1; T&M WIP), `burden.test.mjs` (CPP and EI maximums, earnings include vacation and holiday, vacation at 5 years, zero earnings, fallback and missing-year warnings), `rst.test.mjs`, `month-end.test.mjs` (accrued payroll, WIP accrual, named journal), `stock-counts.test.mjs` (valuation as of a past date, moving average, count posting at `countedAt`), `purchasing.test.mjs` updates | `reports.test.js` (permissions, plan gate on WIP, CSV, cross-tenant), `receiving.test.js` (crew receive without seeing prices, average cost updated, moves stamped) |
| R1-F | `qbo-ui.test.mjs` updates | `qbo-r1.test.js` against the fake QuickBooks: holdback line and release, deposit lines blocked until mapped, interest, credit memo and its apply payment, a pulled credit memo not counted twice with settlement, on-account and refund held in review, per-line tax keys both ways, resale RST to `account.rstRecoverable` round trip, pull into a locked period goes to review with the two resolutions, late pulled bill accepted with `postedOn`, push writes `number` after the lock, exemption review, payroll lock from payroll runs |

### 12.2 End-to-end scenarios

| file | owner | scenario |
| --- | --- | --- |
| `tests/e2e/rst.e2e.mjs` | R1-B | MB GC invoice with `gst-only` and no evidence: Send blocked with the hint; mark the exemption on the job with the number, new invoice prefills it, prints it, sends. The same client on another job defaults to RST. BC warns and sends. |
| `tests/e2e/period-lock.e2e.mjs` | R1-A | Owner sees the pre-close list and closes September; office edits a September invoice: disabled in the PWA; a stale offline edit syncs and is rejected and listed on Books; credit note dated today works. An apprentice's phone syncs a 30 Sep entry on 2 Oct: accepted, posted 1 Oct, in Late hours. Payroll export with one unapproved entry asks to acknowledge; the run locks only its entries; a foreman can't edit them; the unapproved one is approved and goes in the next run; a correction adds 1 h. A September draft invoice is re-dated and sent. |
| `tests/e2e/get-paid.e2e.mjs` | R1-D | Electrician offline creates a T&M ticket with photos on a fixed-price job, customer signs, back online syncs and gets a T-number; the electrician never sees a price. Office prices it into a change order, signs a change order on the iPad, bills it; the ticket shows billed. On a T&M job a signed ticket of 6.5 h against 8 h of time: the builder flags the day and asks for a reason. A refused ticket queues a written notice. A signed service ticket becomes a draft invoice. Estimate signed on device becomes accepted; its revision supersedes it. Deposit (prepayment) paid, final invoice applies it, totals right. Progress invoice with 10% holdback, release invoice. Job set complete shows warnings; set invoiced blocks until clear. |
| `tests/e2e/collections.e2e.mjs` | R1-D | One cheque pays three invoices less a $1,200 dispute and a $350 back-charge; the undisputed balance is reminded, the dispute is conceded into a credit note. A GC keeps 10% holdback on its own: recorded, out of aging. Overdue invoice: daily job queues reminder 1 once; the client goes on hold; scheduling that client's job asks "Dispatch anyway"; a payment clears the hold on recheck. Statement prints and emails. Ready to bill lists the oldest item. |
| `tests/e2e/prompt-payment.e2e.mjs` | R1-D | Prime contract signed 2025-05-01, proper invoice delivered: day-15 and day-29 alarms once each; a sub invoice gets none until `gcPaidOn` is recorded, then gc7; a contract signed 2025-03-01 has none; a company override of `pp.MB.paymentDays` to status `verify` stops the day-28 alarm. |
| `tests/e2e/costing.e2e.mjs` | R1-E | A job with time (burdened, one Saturday of overtime), a raise in November that leaves September's cost unchanged, a truck shared by two people, a bill (resale with RST charged: flagged, not cost), a receipt (own use), an open PO (committed), a field receipt (received not billed), a return to the van, a fulfilled request covered by the bill (not counted twice): job profit and WIP match the fixture; a bill above PO price is flagged and acknowledged. RST view lists the own-use stock move and the supplier credit. Month-end export totals and journal. Count sheet posts adjustments. |
| `tests/e2e/quickbooks.e2e.mjs` updates | R1-F | Holdback invoice and release, deposit, credit note, RST recoverable bill through the fake QuickBooks; a QuickBooks edit of a September invoice after the lock goes to review and is kept as a noted difference. |

---

## 13. Workstreams, file ownership and waves

Each stream works in its own git worktree and touches only its files. A file is owned by exactly one owner
for the whole release. "New" files are created by their owner. Anything not listed is frozen; if you
need it, say so in your merge report and the Lead decides.

### 13.1 Waves and merge order

| key | stream | wave | depends on | sections |
| --- | --- | --- | --- | --- |
| `R1-A-foundations` | Foundations | 1 | none | 2, 8.1, 8.2 |
| `R1-B-tax` | Tax, documents and clients | 1 | R1-A-foundations | 3.1 to 3.4, 3.6, 4.6, 7.3 (money), 2.6 credit-note lib |
| `R1-C-backups` | Backups and HQ | 1 | R1-A-foundations | 5, 2.7 (HQ Rules page) |
| `R1-E-costing` | Job costing, reports and month-end | 2 | R1-A-foundations, R1-B-tax | 3.5, 6, 8.3, 8.4, 11 |
| `R1-D-getpaid` | Get paid and prompt payment | 2 | R1-A-foundations, R1-B-tax, R1-E-costing | 4, 7, 10.1 |
| `R1-F-qbo` | QuickBooks | 2 | R1-A-foundations, R1-B-tax, R1-D-getpaid, R1-E-costing | 9 |

- **Wave 1 (start now, in parallel):** R1-A, R1-B, R1-C. Merge order A, then B and C. B and C code against
  this contract from day one and rebase onto A before their final test run (B imports `lib/exemption.js`;
  C imports `lib/rules.js`).
- **Wave 2 (after wave 1 is merged, in parallel):** R1-E, R1-D, R1-F. Merge order E, D, F. D imports E's
  `buildTmInvoice`, `unbilledTm`, `budgetFromEstimate` and `priceVariances` and codes against this
  contract until E merges; F's tests cover D's invoice and payment kinds and E's bill fields, and F
  rebases last.

### 13.2 Lead (the merge owner)

`server/src/app.js` (route registrations), `server/src/worker.js` (handlers and schedules),
`electrical-app/js/modules/index.js` (new modules), `docs/releases/r1-get-paid.md` (this contract),
`docs/README.md`, `docs/BUILD-PLAN.md`, `docs/BACKLOG.md`, `docs/architecture/api.md` (every R1 endpoint
from the merge reports), `tools/site/**` (feature list at release). Each stream's merge report gives the
exact lines to add.

### 13.3 R1-A-foundations (wave 1)

Registries and data:
- `server/src/collections.js`, `electrical-app/js/store.js` (`COLLECTIONS`, `DEFAULT_SETTINGS`),
  `electrical-app/js/schema/**` (every new collection and every field in 2.3, including `vendors`,
  `items`, `schedule` and the `payments.method` values; `index.json`), `server/scripts/gen-collections-sql.js`
  (`LATER`), new `server/migrations/0160_r1_platform.sql`, new `server/migrations/0161_r1_collections.sql`
- `server/src/services/entitlements.js` (`COLLECTION_FEATURES`), `electrical-app/js/lib/modules.js`,
  `electrical-app/js/plans.js`, `electrical-app/js/modules/billing.js` (`FEATURE_LABELS` only),
  `.dockerignore`, `electrical-app/js/seed.js` (demo cost codes, two trucks, a signed ticket, a deposit
  and a progress invoice with holdback, burden fields and rate history on demo employees)

Server rules and services:
- `server/src/auth/access.js` (new collections' write rules, `MONEY_FIELDS` including snapshot `*Cents`,
  server-written fields, signature and ticket rules, van-owner count rule, `mergeChangeOrders`, closeout
  rule, exemption send block), `server/src/services/records.js` (calls `runWriteGuards`, records
  rejections), `server/src/routes/v1/sync.js` (records rejections), new
  `server/src/services/write-guards.js`, new `server/src/services/period-lock.js`, new
  `server/src/routes/v1/closing.js`, new `server/src/routes/v1/rules.js`

Shared libraries:
- new `electrical-app/js/lib/rules.js`, `closing.js`, `cost-codes.js`, `exemption.js`, `signing.js`;
  `electrical-app/js/lib/notify.js` (new kinds)

PWA:
- new `electrical-app/js/modules/books.js` (`#/books` lock with preflight, late postings and refused
  writes, `#/books/payroll` with Late hours, `#/books/rules`, `#/books/cost-codes`), new
  `electrical-app/css/books.css`
- `electrical-app/js/modules/time.js`, `electrical-app/js/lib/clock.js`,
  `electrical-app/js/lib/shift-tracker.js`, `electrical-app/js/lib/timesheet.js`, `electrical-app/css/time.css`
  (cost code and truck set at clock-in without asking, recode in approval, payroll-run lock on export with
  late hours, locked entries shown read-only, correction entries)
- `electrical-app/js/modules/developer.js` and `electrical-app/js/modules/account.js` (collection labels only)

Tests: `electrical-app/tests/{rules,closing,cost-codes,exemption,signing}.test.mjs`,
`electrical-app/tests/{plans,modules,timesheet}.test.mjs` (updates), `electrical-app/tests/e2e/period-lock.e2e.mjs`,
`server/test/{period-lock,payroll-runs,rules,r1-collections}.test.js`,
`server/test/{isolation,leaks,unit}.test.js` (updates).

Docs: new `docs/office/period-lock.md`, `docs/office/rules-table.md`, `docs/office/cost-codes.md`.

### 13.4 R1-B-tax (wave 1)

- `electrical-app/js/lib/tax.js`, `electrical-app/js/lib/money.js` (holdback base, credit notes,
  `revenueCents`, `progressSummary`), `electrical-app/js/lib/doc-view.js` (exemption editor and printing,
  line editor: `taxOff` presets, cost code picker, read-only special lines, totals with holdback and
  deposits, progress summary block, credit-note print contents, `sendCheck`)
- `electrical-app/js/modules/clients.js` (tax exemption evidence card, credit card, credit application
  print), `electrical-app/css/crm.css`
- `electrical-app/js/modules/integrations.js` (email-document and pay-link run `sendCheck`),
  `server/src/routes/v1/integrations.js` (the same check on the server)
- `docs/code/tax.md`, `docs/code/verify.md`
- Tests: `electrical-app/tests/tax.test.mjs`, new `electrical-app/tests/money.test.mjs`, new
  `electrical-app/tests/e2e/rst.e2e.mjs`, new `server/test/exemption-send.test.js`

### 13.5 R1-C-backups (wave 1)

- `deploy/production/**`, `deploy/staging/**` (`backup.sh`, new `offsite-drill.sh`, `backup.conf.example`,
  READMEs), new `server/scripts/verify-restore.mjs`, `server/src/config.js` (`RESTORE_TESTS_FILE`),
  `server/.env.example`
- `server/src/services/hq-health.js`, new `server/src/services/backup-alerts.js`, new
  `server/src/routes/hq-rules.js`, `server/src/routes/hq.js` (the "Record a drill result" route only)
- `hq/**` (Rules page `hq/js/pages/rules.js` and its entry in `hq/js/app.js`; offsite and restore-drill
  lines and the drill upload on the health page)
- `docs/runbooks/restore-from-backup.md`, new `docs/runbooks/offsite-backups.md`, `docs/runbooks/README.md`,
  `docs/compliance/**` (backup retention, vendor management placeholder for the bucket, privacy: the
  location taken with a ticket signature), `docs/security/**` (threat model rows: TM-R1-01 period-lock
  bypass through sync or the QuickBooks pull, TM-R1-02 signature tampering, TM-R1-03 money leaking to
  field roles through new collections or signature snapshots, TM-R1-04 a stolen offsite key or age key;
  each with its control and test), `compliance/controls.yaml`
- Tests: `server/test/deploy-scripts.test.js`, `server/test/hq-unit.test.js`, new
  `server/test/backup-alerts.test.js`, new `server/test/hq-rules.test.js`

### 13.6 R1-E-costing (wave 2)

- `electrical-app/js/lib/tm.js` (`jobCosting`, `buildTmInvoice` with tickets, returns in `isJobUse`
  callers), `electrical-app/js/lib/purchasing.js`, new
  `electrical-app/js/lib/{costing,burden,rst,month-end,stock-counts}.js`
- New `electrical-app/js/modules/reports.js`, new `electrical-app/js/modules/monthend.js`, new
  `electrical-app/css/reports.css`, `electrical-app/js/modules/purchasing.js`,
  `electrical-app/css/purchasing.css`, `electrical-app/js/modules/employees.js`,
  `electrical-app/js/modules/inventory.js`, `electrical-app/js/modules/materials.js`
- New `server/src/routes/v1/reports.js`, new `server/src/services/reports.js`, new
  `server/src/routes/v1/receiving.js`, new `server/src/services/receiving.js`
- Tests: `electrical-app/tests/{tm,purchasing}.test.mjs` (updates),
  `electrical-app/tests/{costing,burden,rst,month-end,stock-counts}.test.mjs`,
  `electrical-app/tests/e2e/costing.e2e.mjs`, `server/test/reports.test.js`, new
  `server/test/receiving.test.js`
- Docs: new `docs/office/job-costing.md`, `docs/office/month-end.md`

### 13.7 R1-D-getpaid (wave 2)

- New `electrical-app/js/lib/{receivables,prompt-payment,closeout,tickets,esign}.js`
- New `electrical-app/js/modules/tickets.js`, new `electrical-app/css/tickets.css`
- `electrical-app/js/modules/estimates.js`, `electrical-app/js/modules/invoices.js` (receive payment,
  disputes, credit notes and their application, deposits, refunds, collections and ready-to-bill screens,
  statements), `electrical-app/js/modules/jobs.js` (contract and exemption card, T&M builder
  reconciliation, closeout), `electrical-app/js/modules/today.js`, `electrical-app/js/modules/schedule.js`,
  `electrical-app/js/modules/dashboard.js` (ready-to-bill and variance cards), `electrical-app/css/money.css`,
  `electrical-app/css/ops.css`
- New `server/src/services/receivables.js`, new `server/src/services/tickets.js`, new
  `server/src/routes/v1/receivables.js` (statements, recheck), new `server/src/routes/v1/tickets.js`
  (send a copy or a notice now), `server/src/integrations/payments.js` (one `queueClientRecheck` call)
- Tests: `electrical-app/tests/{receivables,prompt-payment,closeout,tickets}.test.mjs`,
  `electrical-app/tests/e2e/{get-paid,collections,prompt-payment}.e2e.mjs`,
  `server/test/{receivables,statements,tickets-flow}.test.js`
- Docs: new `docs/office/getting-paid.md`, `docs/office/prompt-payment.md`, `docs/field/tickets.md`

### 13.8 R1-F-qbo (wave 2)

- `server/src/qbo/**` (including `settlementCents` and the `note` resolution), `server/src/routes/v1/qbo*.js`,
  optional `server/migrations/0162_r1_qbo.sql`
- `electrical-app/js/lib/qbo-export.js`, `electrical-app/js/lib/qbo-ui.js`,
  `electrical-app/js/modules/quickbooks.js`, `electrical-app/js/modules/import.js` (CSV export per-line keys),
  `electrical-app/css/quickbooks.css`
- `docs/integrations/quickbooks.md` (section 17), `docs/runbooks/quickbooks-support.md`,
  `electrical-app/guides/quickbooks.md`
- Tests: `server/test/qbo-*.test.js` (updates), new `server/test/qbo-r1.test.js`,
  `electrical-app/tests/qbo-ui.test.mjs`, `electrical-app/tests/e2e/quickbooks.e2e.mjs`

### 13.9 Definition of done (every stream)

The build plan's, plus: every exported function in 2.12 you own has a test; `node --test
electrical-app/tests/*.test.mjs`, `cd server && npm run test:embedded`, `node
.github/scripts/check-csp.mjs` and `node scripts/gen-collections-sql.js --all` (no diff) pass; every VERIFY
you introduce is in your doc and your merge report; your merge report lists the Lead's lines for
`app.js`, `worker.js` and `modules/index.js`, every endpoint for `api.md`, and anything you needed from a
file you don't own.

---

## 14. Open questions for Kelvin and Travis

Each has the default the code uses until it is answered.

| # | question | for | default |
| --- | --- | --- | --- |
| 1 | How much of TG's work is GC progress billing, and do GCs hold back 7.5%? Any open contracts signed before 2025-04-01? | Travis | Holdback basics only; holdback % typed per job; no schedule of values |
| 2 | Manitoba holdback percentage, holdback release period (40 or 60 days) and TG's lien deadline | lawyer | Rules stay `verify`: no countdowns; the office types the release date |
| 3 | When is RST due on holdback: at the progress bill or at release? (If at billing, deferred RST is remitted late with interest.) | accountant | Deferred to release (`tax.MB.rstHoldbackAtRelease` true, shown "unconfirmed", one-click override) |
| 4 | Are TG's deposits prepayments or security deposits? Does RST follow GST's timing on security deposits? | accountant | Prepayment |
| 5 | Do TG's terms disclose interest on overdue accounts, and at what rate? Is interest invoiced exempt? | Travis, accountant | Interest off; interest invoices exempt when turned on |
| 6 | Reminder steps and when to hold work for past-due clients | Travis | Reminders off until set (presets: 3 days before, 1, 15, 30 after); hold after 60 days past due |
| 7 | Credit limits and terms for GCs | Travis | No limits; terms from the invoice |
| 8 | Vacation and holiday pay: each cheque or accrued? | Travis | Each cheque (no accrual in the month-end export) |
| 9 | TG's WCB rate; load the 2026 CPP, CPP2 and EI values (canada.ca) and the WCB maximum into HQ Rules before release, and each January after | Kelvin | Burden uses the company's flat statutory % with a warning until loaded |
| 10 | Non-productive % (shop, unbilled travel, school, callbacks), annual hours, yearly overhead (excluding truck costs recovered by rates), target margin | Travis | 10%, 2,000 hours, no overhead (labelled "labour cost only"), no target |
| 11 | Truck and equipment rates per hour or day | Travis | None until entered |
| 12 | Who may close the books and reopen payroll? | Kelvin | Owners and admins, full session with recent MFA (never a crew PIN) |
| 13 | Lock timesheets automatically on payroll export? | Travis | Yes, the box is ticked by default; late hours go to the next run |
| 14 | Cost codes: the standard nine? Map them to QuickBooks classes later? | Travis | The standard nine; no QuickBooks classes in R1 |
| 15 | Record GPS with a ticket signature; email the signer a copy | Kelvin | GPS on with a visible notice; copy emailed when an address is given |
| 16 | What must a Manitoba proper invoice contain? | lawyer | The seeded list, as warnings only |
| 17 | Offsite storage provider and region; keep monthly copies for 7 years? | Kelvin | AWS S3 `ca-central-1` with object lock; dailies 35 days, weeklies 400 days, no 7-year copies |
| 18 | May the AI assistant and MCP agents read tickets, signatures and reports? | Kelvin | No (not added to `ASSISTANT_COLLECTIONS`) |
| 19 | Will TG's GCs and customers accept an on-device signature for change orders and tickets? Who signs for each GC? | Travis | Yes, with the snapshot, digest, time and location kept; authorized signers empty (no warning) |
| 20 | Price variance tolerance | Travis | 2% and at least $1.00 |
| 21 | QuickBooks accounts for holdback receivable, customer deposits and RST recoverable; how to book a credit memo application and grouped receipts | accountant | The accountant maps them in setup; deposit invoices wait for `item.deposit`; the apply payment stays in review until the sandbox confirms it |
| 22 | Credit note numbering | Kelvin | `CR-1001` onward |
| 23 | Should GC T&M invoices bill the hours on signed tickets rather than time entries? | Travis | Time entries (`tickets.billFrom: 'time'`), with the day-by-day reconciliation |
| 24 | Should email (reminders, statements, notices) move to the Starter plan? | Kelvin | No change: Pro and Business; Starter prints them |
| 25 | Send a written notice automatically when a customer refuses a ticket? After how many days is an unsigned ticket stale? | Travis | Yes on refusal; 3 days; unsigned drafts are never sent on their own |
| 26 | Is a separately billed out-of-pocket disbursement (hotel, meals) outside RST, and outside the holdback base? | accountant, lawyer | Allowed and excluded, shown "unconfirmed" |
| 27 | Tax on a forfeited deposit; how to book a bad-debt write-off (GST s.231, MB RST refund) | accountant | Flagged for the accountant; no tax computed |
| 28 | Self-assess RST on warranty material when the warranty was in the original taxed price? Is shrinkage self-assessed? | accountant | Warranty material self-assessed (own use); shrinkage not |
| 29 | Inventory cost method for the books | accountant | Moving weighted average |
| 30 | Does a prompt-payment deadline on a weekend move to Monday? Which contracts are excluded (residential, value)? The GC's notice period to a sub | lawyer | Shown "may move"; alarms on every MB prime contract with "check it applies"; no sub notice alarm |
| 31 | Billing cutoff day per GC | Travis | None until entered; notice 3 days before |
| 32 | Is TG liable for the Manitoba health and education payroll levy? | accountant | No (not in burden) |

---

## 15. Kelvin's checklist outside the code

Backups (5):

1. Pick an S3-compatible bucket in a Canadian region. Recommended: AWS S3 `ca-central-1` (Montréal) or
   `ca-west-1` (Calgary); alternatives Wasabi `ca-central-1` (Toronto) or another provider with a
   Canadian region (check the current region list and price before choosing). Rough size: the database
   holds plan sets (about 140 MB each) and photos, so expect tens of GB with 35 dailies and 57 weeklies;
   check the provider's per-GB price before choosing.
2. Turn on versioning and object lock (compliance mode, 35 days) where the provider offers it.
3. Lifecycle: `daily/` kept 35 days, `weekly/` kept 400 days, `predeploy/` kept 30 days.
4. Create two access keys limited to that bucket: one for the server that can write and read but not
   delete, and one read-only key for the drill.
5. Keep the `age` private key in at least two places: the password manager and an offline copy (USB or
   paper in a safe). Not only on the PC. Keep `SECRETS_MASTER_KEY` in the password manager too.
6. On the server (Lead or Kelvin, with the runbook): `rclone config` for root, set `OFFSITE_RCLONE_REMOTE`
   and `HEARTBEAT_URL` in `backup.conf`, run one backup, check `last-backup.json` says `offsite: ok`.
7. Install Docker Desktop (or WSL with Docker) and rclone on the PC with the read-only key, and run
   `offsite-drill.sh --identity - --verify-secrets` from the repo checkout. Upload the JSON line on the HQ
   health page. Repeat quarterly (HQ alerts after 92 days).
8. Record the provider and region in `docs/compliance/vendor-management.md`.
9. Accept the recovery point: up to 24 hours of server data plus whatever phones have not synced.

Rules and payroll values:

10. Before release, load the 2026 CPP, CPP2, EI values and the Manitoba WCB maximum on HQ → Rules (and
    every January after).
11. Enter TG's WCB rate, non-productive %, annual hours, overhead and target margin with Travis (Books →
    Rules and Job costing → Rates), and each truck's rate.

Questions to take to others:

12. Travis: questions 1, 5 to 8, 10, 11, 13, 14, 19, 20, 23, 25 and 31 in section 14, and gap section D.
13. The accountant: questions 3, 4, 5, 21, 26 to 29 and 32, and Fishtape's own Manitoba RST registration
    on subscriptions (gap analysis).
14. A construction lawyer: questions 2, 16, 26 and 30.

Decisions only Kelvin makes:

15. Questions 9, 12, 15, 17, 18, 22 and 24 (including whether email moves to Starter).
16. Turn on MFA for every owner and admin account (closing the books and reopening payroll require it).
17. Tell TG's crews that a location is recorded with a ticket signature (the privacy notice).

---

## 16. Considered and rejected

Findings from the owner and controller reviews that were not taken, or were taken in a different form.

| finding | decision and reason |
| --- | --- |
| Owner Medium 14: give Starter email reminders through the platform email | Rejected. Company email never goes through Fishtape's own account (`platform-email.js`): it would send customer mail from Fishtape's domain without the company's SPF and DKIM, and a spam complaint against one company would hurt password resets and invites for every company. The pricing question is real, so it is question 24 (move `integrations.email` to Starter); until then Starter prints statements and notices. |
| Owner High 2: not-to-exceed and lump-sum amounts set by the office and shown to the signer on the crew's phone | Rejected for R1. Any price stored on a ticket reaches the crew's own readable copy, which breaks "field roles never see money", and the sheet works offline so it can't fetch the price. Taken: a pricing basis (contract rates with a rate-sheet reference, or quote to follow) in the signed text; priced extras are signed by the office on the iPad as change orders (4.2). |
| Owner High 5: the release invoice bills holdback the GC kept on its own, with tax off | Rejected. The amount is already on the original invoice with its tax; a release invoice would bill it twice. Taken: the retained amount moves out of aging, reminders and the hold, shows in the holdback ledger, and a "Request holdback release" letter lists it (7.3). |
| Owner High 3: send a written notice automatically when a ticket is still unsigned at the end of the day | Rejected as automatic. A draft may simply be unfinished, and an automatic "notice of extra work" to a GC is a claim TG may not want to make. Taken: automatic notice on refusal (setting), and a one-tap "Send as written notice" on stale drafts (4.1). |
| Owner High 14: a `serviceTechSeesPrices` setting now | Rejected as a setting with no behaviour. Recorded as an R3 idea (1.2). The service auto-draft invoice is taken. |
| Owner Low: a 90-day per-device sync window for ticket photos | Rejected for R1: it changes the sync protocol for one collection, and object storage (Release 2) removes photos from sync anyway. Taken: smaller caps (4 photos at 250 KB, 1.5 MB a ticket) and a stated budget (2.2). |
| Controller 8: stamp `costRateCents` on each time entry at approval | Rejected in favour of effective-dated `rateHistory` on employees and equipment (also owner High 6). One mechanism covers late entries, corrections and unapproved time; a money field on crew-owned rows would need redaction on every time-entry read path, and an approval that precedes a back-dated raise would freeze the wrong rate. |
| Controller 8: store a snapshot of cutoff and WIP totals when the books lock moves | Rejected for R1. The lock route (R1-A, wave 1) would have to import the costing libraries (R1-E, wave 2). With rate history, server-stamped move costs and posting dates, a closed month's numbers no longer move; the month-end CSV the accountant keeps is the record. |
| Controller 16: spread the overtime premium over the week's jobs by hours | Taken in the owner's form (High 8): the premium lands on the entries that crossed the threshold, in time order, using `timesheet.js allocateOvertime`, so job cost matches what payroll pays. |
| Controller 3: drop the payroll date lock, or keep a date per employee | Taken as "lock by entry id only"; `payrollThrough` stays as an informational "exported through" date for QuickBooks and the Late hours queue. A per-employee date was not needed. |
| Controller 30: handle Stripe refunds and chargebacks | No webhook work in R1 (Fishtape does not handle them today). The rule is set: when they are handled, the system writes a reversal payment dated today, which the lock always accepts (2.6). |
| Owner Medium 6 and controller 21: compute the tax on a forfeited security deposit | Rejected until the accountant confirms the treatment (Excise Tax Act s.182 is VERIFY). The forfeit is recorded and flagged (4.3). |
| Owner High 1: prefill ticket labour only from time entries, or bill only from tickets | Both kept as options: prefill includes the open entry, the builder reconciles per day, and `tickets.billFrom` chooses the source per company (question 23). |
| Owner Medium 14: SMS reminders must honour STOP | No change needed: the outbox already refuses numbers that replied STOP (`integrations/outbox.js`). Covered by the existing behaviour and named in 4.5. |
