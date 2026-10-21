# What Fishtape still needs to run an electrical company (as of 2026-10-20)

## A. Is PST a business write-off? Partly. Here is what it means for TG and for Fishtape

**In Manitoba it's called RST (retail sales tax). It's 7%, and TG never gets it back.** A "write-off" only means it counts as a business expense for income tax. At TG's likely 9% combined small-business rate, $100 of RST saves about $9 of income tax. The tax that does come back dollar for dollar is **GST**: TG claims back the 5% it pays on business purchases as input tax credits. Manitoba has no business-to-business RST exemption.

**Electricians are a special case** (Manitoba Bulletin 031, rev. 2019; Bulletin 030, rev. July 2026). Electrical systems stay "goods" even once they're wired into a building. So:

- **TG's invoices:** TG charges 7% RST on the whole bill: materials, labour, service calls, travel time and permits. That applies to homeowners and businesses alike. A general contractor (GC) or a landlord pays it and can't get it back. TG collects it and sends it to Manitoba Finance.
- **Job materials:** TG gives the wholesaler its 7-digit RST number and pays **no RST** on the wire and gear it installs. If a supplier charged RST anyway, TG should **ask the supplier for a credit first**. If that fails, getting tax paid in error refunded may need a separate refund application rather than a line on the RST return. The time limit is not confirmed (VERIFY). The accountant should check TG's 2024-2026 bills for this.
- **Tools, trucks, meters, safety gear, rentals, insurance and the office:** TG pays RST, and it is a cost. That includes software subscriptions such as QuickBooks and Fishtape.
- **Material TG uses itself owes RST, even if it was bought tax-free.** Three cases:
  - warranty and callback material, where nothing is billed;
  - material taken from stock for the shop or the trucks;
  - tools bought from out-of-province or online sellers who charged no RST.

  TG has to self-assess RST on these. Auditors find this more often than anything else.

Two of the four research reports had the electrician rule backwards. They applied the general rule for building contractors ("pay RST on materials, don't charge it"), which doesn't apply to electrical trades. The RST report read Bulletin 031 itself, so I went with it. That also means my last message was wrong to ask the accountant to confirm that "RST on supplier bills is a cost". That is only true for tools and overhead.

**Fishtape's Manitoba default is right.** It charges RST on the whole contract (`pst-all`), and it works out RST and GST each on the pre-tax price. These are the exact changes needed:

1. **`electrical-app/js/lib/tax.js`, `TREATMENTS['gst-only']`: add `hints.MB`.** Today's hint ("for example a contractor buying for resale") will lead the office to drop RST on GC jobs, and then TG owes it. Replacement text:

   *"Manitoba: only when the customer is another electrical or mechanical contractor subcontracting this work to you, a reseller, or a general contractor passing on an exempt customer's exemption (federal government RST number, Status Indian or band on reserve, farm-use certificate). A general contractor on an ordinary building job pays RST (Bulletins 031, 005). Record their 7-digit RST number on the invoice (Bulletin 004)."*

   Add a matching `hints.SK` for Saskatchewan.
2. **Add an exemption record to clients and documents.**
   - Fields: `taxExemptNumber` and `taxExemptBasis`. The basis is one of: resale, electrical or mechanical subtrade, federal, First Nations (name, registration and band details), or farm.
   - Print it on the invoice.
   - In Manitoba, block sending when RST is off and no number is recorded. In BC and Saskatchewan, show a warning only.
   - Today the only related field is `taxNoneReason`, and it is used only for "No tax".
3. **`docs/code/tax.md`, Manitoba row:** federal government, farm and pass-through exemptions should be `gst-only`, not `none`. Today `none` also drops the 5% GST, which the federal government does pay. Keep `none` for First Nations relief only. Fix the Saskatchewan row the same way.
4. **`server/src/qbo/map/tax.js` `spreadPurchaseTax` and section 4.8 of the QuickBooks contract:** add a resale or own-use flag to each bill line.
   - Default: material and electrical or mechanical subcontract lines count as resale. Tools, equipment, rentals and overhead count as own use.
   - RST on an own-use line stays in cost, as it does today.
   - RST on a resale line goes to an "RST recoverable" account, with a flag: *"Supplier charged RST on resale materials. Ask them for a credit."*
   - Without this, time-and-materials invoices mark up a cost that already includes RST, then add 7% RST on top.
   - Reword question 16 for the accountant to match.
5. **Own-use tag on stock moves and material requests** (no charge, warranty, shop or truck). Tagged items feed a small RST view showing self-assessed RST and resale credits. This view is the only part QuickBooks lacks: QuickBooks Online Canada already files GST and produces the Manitoba RST report. It replaces the separate "GST/RST worksheet" from the last list.
6. **Smaller items:**
   - a pass-through travel and per-diem line with RST off (Bulletin 031 §3);
   - RST on each progress bill net of holdback, then on the holdback release (when Manitoba RST falls due on holdback is unconfirmed; VERIFY);
   - later, a "TG as general contractor" treatment where RST is built into the price and self-assessed.
7. **Fishtape's own subscription:** Manitoba has taxed prewritten software for years. Out-of-province digital sellers have had to register since 2021-12-01. Kelvin's company may already be overdue for its own Manitoba RST registration, not just newly required. Check what Bulletin 033 changed in 2026 before relying on a date (VERIFY). This one is for his accountant.

**Sources**
- [Manitoba RST Bulletin 031: electrical and mechanical contractors](https://www.gov.mb.ca/finance/taxation/pubs/bulletins/031.pdf)
- [Manitoba RST Bulletin 005: contractors](https://www.gov.mb.ca/finance/taxation/pubs/bulletins/005.pdf)
- Bulletins 004, 030 and 033 and RST Guide 700 are cited by number. Pull their current copies from gov.mb.ca/finance before the hint text ships.

## B. Ranked gap list

Effort: S = days, M = 1-2 weeks, L = 3-5 weeks, XL = 2 months or more.

Already in Fishtape, so left out: CEC calculators, bending, AR wire runs, drawings, safety forms with signatures, time and GPS, QuickBooks sync, offline, the licence and certificate register with expiry reminders, the AR aging and overdue view, Stripe pay links, and lead follow-up sequences.

Any legal number marked VERIFY goes into a rules table that the office can update. It is never hard-coded, and no countdown ships until a source confirms it.

### 1) Must-have to run TG properly in the next 1-2 months (cash and legal first)

1. **RST fixes from section A** (changes 1-6).
   - **Why:** if TG drops RST on a GC job, TG owes the 7% itself (Bulletin 004).
   - **Legal:** yes.
   - **Today:** the default is right. The exemption hint is wrong, there's no exemption number on file, resale RST on bills is buried in cost, and nothing tracks own-use RST.
   - **Effort:** S-M. **Depends on:** none.
2. **Get paid on residential, service and light commercial work.** This is how a shop TG's size actually gets paid.
   - **Signed extras and time-and-materials tickets on the phone:** the homeowner or the GC's site supervisor signs, with timestamp, photos and GPS. The ticket links to a change order. This is the biggest leak on commercial work, and it is the evidence an adjudication or lien claim needs.
   - **On-device signature on estimates and change orders:** reuse the safety module's signature capture (`lib/safety-capture.js`). It doesn't need the portal.
   - **Deposit invoices:** pick one model per deposit. A prepayment is GST-taxable when received. A security deposit is taxable only when applied (Excise Tax Act s.168(9)).
   - **Collections:**
     - customer statements;
     - interest on overdue invoices, which can only be charged if the terms on the contract disclose it;
     - reminder steps built on the existing sequences outbox;
     - a "past due: hold work" flag at dispatch;
     - an overdue invoice linked to its lien deadline.
   - **GC accounts:** a credit application and a credit limit.
   - **Final-billing checklist at job close:** every approved change order billed, the holdback release invoiced, all time billed.
   - **Legal:** partly. **Today:** "accepted" is a status someone sets by hand. Change orders have no signature. Deposits exist only as QuickBooks deposits.
   - **Effort:** S-M. **Depends on:** none.
3. **Offsite backups and record retention.** CRA requires 6 years of records, and a dead VPS today loses everything.
   - **What to build:** encrypted offsite copies with a tested restore, a retention period per record type, and legal hold.
   - **Legal:** yes. **Today:** production backups exist only on the server.
   - **Effort:** S-M. **Depends on:** none.
4. **Job costing that tells the truth, with job-profit and WIP reports.** Every margin TG sees today is too high.
   - **Why:** `jobCosting()` in `lib/tm.js` reads time, stock moves and fulfilled requests, but never bills, receipts or purchase orders. Labour is costed at bare wage.
   - **What to build:**
     - Read bills and receipts, and show committed cost from open purchase orders.
     - Flag a bill price above the PO or quote. Wholesaler pricing errors are routine.
     - Cost codes shared by estimates, time, bills and POs (rough-in, service, trim, change order). This shows which phase lost money, and future estimates can learn from actuals.
     - Burden per employee, built as statutory % plus non-productive %:
       - Statutory items: CPP 5.95%, EI about 2.3%, WCB about 1.5-2.5%, 4% holiday pay and 4-6% vacation. Together that is about 18-20%, so a $40 wage costs about $47-48 before anything else.
       - CPP and EI stop at their yearly maximums, so a flat % overstates cost late in the year.
       - The non-productive % covers shop time, travel, school blocks and callbacks.
     - A truck and equipment rate per hour or day, charged to the job.
     - Together these give the break-even billing rate.
   - **Reports:** profit by job and a WIP report (over and under billing). Banks and bonding companies ask for WIP, and the controller needs it monthly. These were item 14 before; now they ship with job costing.
   - **Legal:** no. **Today:** contract versus actual, for labour and materials only.
   - **Effort:** M-L. **Depends on:** none.
5. **Prompt-payment basics.**
   - **Rules, all in the rules table:**
     - Prompt payment has been in force since 2025-04-01, but only for prime contracts signed on or after that date.
     - The owner pays a proper invoice in 28 days, or sends a notice of non-payment by day 14.
     - A sub's share is due within 7 days of TG being paid.
     - An adjudication decision must be paid within 10 days.
     - MHCA says holdback is now 60 days for all contracts. Older guidance said 40 days, counted from the substantial-performance certificate. VERIFY with a lawyer.
     - TG's own lien deadline under the amended Act is not confirmed (VERIFY).
   - **What to build:**
     - a contract-signed date and a substantial-performance date on each job;
     - a holdback field on invoices and a holdback release invoice;
     - the fields a proper invoice requires;
     - day-14 and day-28 alarms, which switch on only for contracts signed from 2025-04-01;
     - a lien alarm, once the date is confirmed.
   - **GST timing:** GST on holdback is due only when the holdback is paid or becomes due (ETA s.168(7)). On construction services, GST is due at substantial completion even if no invoice has gone out (s.168(3)(c)).
   - **Legal:** yes. **Today:** none.
   - **Effort:** S. **Depends on:** items 1 and 2.
   - The full schedule of values is item 14, after Travis answers D1.
6. **Period lock and month-end close.**
   - **Why:** QuickBooks' closing date doesn't stop Fishtape from changing its own records. Payroll exports and filed returns stop matching.
   - **What to build:**
     - A closing date in Fishtape. Time, invoices, bills and stock moves before it are read-only, and changes are made only by reversal.
     - Timesheets locked once payroll is exported.
     - A month-end cutoff export for the QuickBooks journal entry: unbilled T&M and unbilled change orders as accrued revenue, received-but-not-billed material as accrued cost, and vacation and holiday pay owed as a liability.
     - Inventory valuation by location (shop and each van) with count sheets. Van stock is usually TG's largest unrecorded asset.
   - **Legal:** supports filings. **Today:** no period-lock code anywhere.
   - **Effort:** M. **Depends on:** item 4.
7. **Object storage and a job file library.**
   - **Why:** plan sets already take about 140 MB each as data URLs. That bloats sync, device storage and the new offsite backups. Contracts, specs, permit PDFs, clearance letters and insurance certificates have nowhere to live. This is a problem now, not a selling feature.
   - **Today:** photos and drawings are stored inline.
   - **Effort:** L. **Depends on:** none. It unblocks items 9, 16, 24 and 25.
8. **Payroll handoff with Manitoba construction rules.**
   - **Rules:**
     - 4% general-holiday pay on regular earnings including vacation pay, never on overtime. It is paid on each cheque or as a lump sum at year end.
     - 1.5x for every hour worked on a general holiday.
     - Vacation goes from 4% to 6% at year 5.
     - ROE within 5 days of a layoff, final pay within 10 working days.
     - PD7A remittance by the 15th, T4 and T4A by the end of February.
     - Directors are personally liable for unremitted source deductions, and for GST.
   - **Sector tables, loaded from the official schedules, not constants:** heavy construction uses weekly standard hours (Winnipeg: 50 from April to October, 48 from November to March). The ICI figures from the last list ($44.61/h, 10-hour day) had no source and are dropped until verified.
   - **Also:** a termination checklist, and a check that payroll stays under the Health and Post-Secondary Education levy threshold (likely not triggered).
   - **Legal:** yes. **Today:** overtime by province and exports to Wagepoint and QuickBooks Payroll, with no construction rules.
   - **Effort:** M. **Depends on:** item 6 (payroll lock) and Travis's answer on payroll.
9. **WCB, insurance and the compliance calendar, for TG and for its subs.**
   - **TG itself:**
     - the WCB annual assessable-earnings report, due Feb 28, with the per-worker maximum applied;
     - the rate class on file;
     - TG's own clearance letter and its liability and auto insurance certificates as PDFs, with one tap to send the packet to a GC. GCs hold payment without a current clearance letter.
   - **Subs:**
     - a clearance letter and liability certificate on each sub, with a hold before final payment. WCB can bill TG for an uncovered sub's workers.
     - an encrypted business number field;
     - a service-or-goods tag per bill line;
     - T5018 slips. They are required as soon as TG pays any sub $500 in the year, because electrical income is construction income. The real risk is the late-filing penalty (up to $7,500), and the return is due 6 months after the period ends.
   - **Compliance calendar:** GST and RST filings, PD7A, WCB, T4 and T5018, licence and insurance renewals, and the City contractor licence.
   - **Legal:** yes. **Today:** the certificate register with expiry reminders, but no PDFs, no send, no subs and no T5018.
   - **Effort:** M. **Depends on:** item 7.
10. **Permits, inspections and Manitoba Hydro.**
    - **What to build:**
      - the authority chosen from the job address: City of Winnipeg inside the city, Manitoba Hydro outside it;
      - "does this job need a permit?" when a job is created;
      - rough-in, service and final stages;
      - Hydro service requests (new service, disconnect and reconnect, meter set) tracked as steps that hold up energizing;
      - the City contractor licence renewal.
    - **Deadlines:** inspection countdowns wait until the deadlines are sourced. "M.R. 31/2026" and the 2 and 10 business-day figures are VERIFY.
    - **Legal:** partly. **Today:** basic permit and inspection records. The authority is chosen by province only, and the Winnipeg/Hydro split exists only as a note.
    - **Effort:** M. **Depends on:** none.
11. **Apprentice hours and ratio.**
    - **What to build:** a level and hours log from approved timesheets, a ratio warning at dispatch, school-block dates, and the 15-day notice when an apprentice leaves.
    - **VERIFY:** the 1:1 ratio for agreements registered since 2024-10-30 and the 6-month AccessManitoba posting interval.
    - **Legal:** yes. **Today:** an apprentice role only.
    - **Effort:** M. **Depends on:** time tracking (done).

### 2) Needed to grow TG and to sell to the next contractor

12. **Flat-rate price book with assemblies.** This is how residential service is sold and one of TG's main revenue tools.
    - **What to build:** kits (for example "15A receptacle installed" = box, device, plate, wire and labour), good/better/best options and member pricing.
    - **Today:** single items with labour hours and no component list.
    - **Effort:** M. **Depends on:** item 4 (cost codes).
13. **Service dispatch.**
    - **What to build:** appointment windows, a map board with drag between techs, "on my way" texts with an ETA, a two-way SMS inbox per client, and the past-due hold from item 2.
    - **Today:** a week board, GPS points and outbound SMS.
    - **Effort:** M-L. **Depends on:** Twilio (done).
14. **Schedule of values and full progress billing.**
    - **What to build:** % complete per line, a holdback receivable, and CCDC 2-style pay applications.
    - **When:** only if Travis's answer shows real GC volume.
    - **Effort:** L. **Depends on:** item 5 and question D1.
15. **Supplier control and stock.**
    - **What to build:**
      - Reconcile against the monthly wholesaler statement. Missing bills ruin job costing.
      - Track material returned from jobs, pending supplier credits and restocking fees.
      - Receive a PO into stock, with backorders.
      - Import account price files, and export POs in Guillevin quick-order and EECOL Excel formats.
      - Barcodes and cycle counts last.
    - **Today:** POs and stock, with no receiving or feeds.
    - **Effort:** M. **Depends on:** item 4.
16. **Customer portal.**
    - **What to build:**
      - Customers view, sign and pay estimates, change orders and invoices online.
      - A residential contract template covering scope, deposit, warranty, insurance and WCB statements, and Consumer Protection Act cancellation rights for contracts signed at the customer's home (period: VERIFY).
      - Review requests after the job.
    - **Today:** RLS scaffolding only.
    - **Effort:** L. **Depends on:** items 2 and 7.
17. **Service agreements, equipment register and warranty callbacks.**
    - **What to build:**
      - Recurring work: generators, infrared scans, EV chargers.
      - Panels linked to a site as equipment with serial numbers.
      - Callbacks linked to the original job so they aren't billed. Their material feeds RST self-assessment (section A, change 5).
    - **Today:** none.
    - **Effort:** L. **Depends on:** item 16 for auto-billing.
18. **iOS push notifications.** Crews miss work plans and approvals without them.
    - **Today:** the workplan `notify()` is only a hook.
    - **Effort:** S-M. **Depends on:** the App Store record.
19. **Fleet, rentals and tools.**
    - **Vehicles:** registration, insurance and MPI dates. National Safety Code rules for trucks over 4,500 kg registered weight (annual and trip inspections, driver files). Driver abstracts for the insurer. A CRA logbook from timesheets and GPS.
    - **Rented equipment** (lifts, trenchers, generators): tracked by job, with off-rent reminders and the cost charged to the job.
    - **Tools:** QR check-out by person and job.
    - **Test due dates:** rubber glove retests, meter calibration and CAT rating, ladder and harness inspections.
    - **Today:** none (tool tracking is in BACKLOG).
    - **Effort:** M. **Depends on:** none.
20. **Daily site log** for commercial jobs: crew on site, weather, delays, who is waiting on whom. It is the evidence for delay claims and adjudication.
    - **Effort:** S. **Depends on:** none.
21. **HR basics:** time-off requests, onboarding documents and per-employee bill rates (`billRateCents`).
    - **Effort:** S-M. **Depends on:** none.
22. **Consumer financing and Tap to Pay:** a Financeit link for panel upgrades, EV chargers and generators, and in-person card taps.
    - **Effort:** S (Financeit link) to M (Tap to Pay). **Depends on:** item 16.

### 3) Differentiators (nobody in Canada does these well)

23. **Full prompt-payment kit.**
    - notices of non-payment (Forms 1-5);
    - the sub-payment clock;
    - an adjudication evidence pack (Form 6) built from the signed tickets, daily log and change orders;
    - CCDC 9A and 9B statutory declarations with each pay application;
    - interest on late payment.
    - **Effort:** M. **Depends on:** items 5, 14 and 20.
24. **COR audit binder:** lockout and energized-work permits, an SDS (safety data sheet) library, and headcount warnings at 5 and 20 workers. The WCB rebate figure and the government-work requirement are VERIFY.
    - **Effort:** M. **Depends on:** item 7.
25. **Light commercial project management:** punch lists pinned on the existing drawings, RFIs and submittals, and a closeout package (as-builts, printed panel directories, O&M manuals, final permit).
    - **Effort:** M-L. **Depends on:** item 7.
26. **AI receptionist and after-hours booking,** built on the existing assistant. Competitors charge $29-99 a month for this.
    - **Effort:** M. **Depends on:** items 13 and 16.
27. **Commercial bidding:** a labour-unit database with difficulty factors, auto-count takeoff on PDFs, and bid-day alternates.
    - **Effort:** L-XL. **Depends on:** item 12.
28. **Canadian wholesaler EDI and PunchOut, starting with Gescan.** No surveyed competitor has it.
    - **Effort:** L. **Depends on:** item 15.
29. **Missing code tools:** EV load management (CEC Rule 8-106), fault current, transformer and generator sizing, grounding electrode sizing, and CEC Table 14.
    - **Effort:** M. **Depends on:** the CSA C22.1:24 book.
30. **Native books** (general ledger, bank reconciliation, AP aging). Last, because QuickBooks covers it.
    - **Effort:** XL. **Depends on:** items 4 and 6.

**Sources for B**
- [MHCA: understanding prompt payment rules now in effect](https://mhca.mb.ca/mhca-news/understanding-prompt-payment-rules-now-in-effect/)
- [MHCA: prompt payment in effect as of April 1](https://mhca.mb.ca/mhca-news/prompt-payment-in-effect-as-of-april-1/)
- [MLT Aikins: Manitoba's prompt payment law is in effect](https://www.mltaikins.com/?p=20087)
- [Manitoba proclamation 2023 c30, in force 2025-04-01](https://web2.gov.mb.ca/laws/statutes/proclamations/2023c30(2025-04-01).php?lang=en)
- [TDS Law: Builders' Liens Act rights and responsibilities](https://www.tdslaw.com/resource/rights-responsibilities-builders-liens-act/)
- [Manitoba Association of Architects TB-08 (holdback release)](https://mbarchitects.org/docs/TB-08_rev1.pdf)
- [Manitoba Employment Standards construction fact sheet](https://uatpayment.manitoba.ca/labour/standards/doc,construction,factsheet.pdf)
- [Manitoba heavy construction wage and hours fact sheet](https://www.gov.mb.ca/labour/standards/doc,heavy-construction,factsheet.pdf)

## C. Suggested build order for the next 3 releases

These estimates assume two work streams running in parallel. The effort is listed so the totals add up.

**Release 1, "Get paid and know the margin" (about 6 weeks, about 12 weeks of work).**
- **Stream A:**
  - Week 1: RST fixes and exemption numbers (1) and offsite backups (3).
  - Weeks 2-4: signed tickets, e-sign, deposits and collections (2).
  - Week 5: prompt-payment basics (5), with day counts in the rules table once a lawyer confirms them.
- **Stream B:**
  - Weeks 1-4: job costing with cost codes, burden and truck rate, plus the job-profit and WIP reports (4).
  - Weeks 5-6: period lock and month-end close (6).

**Release 2, "Run the crew and the paperwork" (about 8-9 weeks).**
- **Stream A:** object storage and file library (7, weeks 1-4), then the WCB, insurance and compliance calendar (9), then permits and Hydro (10).
- **Stream B:** payroll rules and lock (8), apprentices (11), the flat-rate price book (12), then service dispatch (13).
- Object storage starts first in Release 2. If the week-1 backups prove too large because of plan sets, move it into Release 1.

**Release 3, "Sellable to the next contractor" (about 8 weeks).**
- the portal and residential contract (16);
- service agreements, equipment and callbacks (17);
- push notifications (18);
- supplier control and stock (15);
- fleet, rentals and tools (19);
- the daily site log (20);
- the schedule of values (14), if D1 shows GC volume.

After that: HR (21), financing (22), then the differentiators.

## D. Questions only Kelvin or Travis can answer

1. **Revenue mix:**
   - How much of TG's revenue is progress-billed GC or commercial work, and how much is service and residential?
   - Do GCs send CCDC 2 contracts and hold back 7.5%?
   - Were any open contracts signed before 2025-04-01?
   - Does TG do any heavy construction?
2. **Subs and special customers:**
   - Does TG pay subcontractors, and which ones? T5018 applies from $500.
   - Does TG ever act as general contractor on full renos?
   - Does it work for federal, First Nations or farm customers, or outside Manitoba?
3. **Tax and the accountant:**
   - Has TG given its RST number to every wholesaler, or are there 2024-2026 bills with RST on materials?
   - Can the accountant confirm three things: the refund route for RST charged in error, when RST is due on holdback, and whether TG's deposits are prepayments or security deposits?
4. **Payroll and apprentices:**
   - Which payroll does TG use?
   - Is holiday pay paid on each cheque or at year end?
   - How many apprentices does TG have, and when were their agreements registered?
5. **Service, trucks and equipment:**
   - Does TG sell, or want to sell, maintenance plans?
   - Are service calls flat rate or time and materials?
   - Are any trucks over 4,500 kg registered weight?
   - Does TG rent lifts or other equipment often?
6. **Fishtape's own exposure:**
   - Has Kelvin's company registered for Manitoba RST on Fishtape subscriptions? It may be overdue.
   - Which lawyer can confirm the Builders' Liens day counts (holdback release and lien deadline) before the alarms ship?