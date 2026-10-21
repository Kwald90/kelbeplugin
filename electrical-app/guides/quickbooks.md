# Sync Fishtape with QuickBooks Online

Fishtape and QuickBooks Online keep each other up to date: clients, products and services, estimates, invoices and payments go both ways; jobs become sub-customers for job costing; approved time goes to QuickBooks as timesheets; supplier bills tagged to your jobs come back. You keep working in Fishtape on site and your bookkeeper keeps working in QuickBooks.

About 30 minutes the first time, most of it matching your records. An owner or admin connects; office users can do the rest. You need the Pro plan or higher, a Canadian QuickBooks Online company in Canadian dollars, and two-step sign-in turned on in Fishtape (anyone who changes QuickBooks data through Fishtape needs it).

## What it costs

Nothing on top of your Fishtape plan: QuickBooks sync is included in Pro and up. You keep paying Intuit for your own QuickBooks Online subscription as today (Essentials or Plus; prices on Intuit's site, checked 2026-10-20). Intuit charges nothing for the connection itself.

Rather not do it yourself? **Ask us to set this up**: we go through the settings, tax codes and matching with you and your bookkeeper (see Services).

## Before you start (in QuickBooks)

1. Check your QuickBooks plan. **Plus** is needed for purchase orders; **Essentials** covers everything else.
2. Turn on **Settings > Account and settings > Sales > Custom transaction numbers**, so Fishtape's invoice numbers (INV-3001) carry over. Use plain numbers for documents you make in QuickBooks, so the two never meet.
3. Check sales tax is set up. In Manitoba, use the **GST/PST MB** code at 5% + 7%. An old 8% PST rate may still be in the list; Fishtape refuses any code whose rates don't match what it charges.
4. Write down the last day of your last GST return filed, and the last pay period you ran.
5. Ask your bookkeeper which accounts new products and job costs go to, and create a bank account named **Stripe** if you take card payments through Stripe.

## 1. Connect

1. In Fishtape, open **QuickBooks** (or **Integrations > QuickBooks Online**).
2. Press **Connect to QuickBooks**. A page names your Fishtape company and you; press **Connect** there.
3. Sign in to QuickBooks and pick the company. Fishtape only connects Canadian companies in Canadian dollars.
4. You land back in Fishtape on the setup screen. Nothing syncs until setup is applied.

On the iPad app the QuickBooks pages open in Safari. Close Safari when it says you can go back; the app notices the connection on its own.

## 2. Settings

Answer the questions in plain words:

- **Start syncing from**: documents, payments, bills and time before this date stay only in QuickBooks. Open invoices and pending estimates come across whatever their date.
- **Which system holds payroll hours?** Fishtape (approved time goes to QuickBooks) or QuickBooks Time (Fishtape sends no hours). Never both.
- **Last pay period run**: hours on or before it are never changed from Fishtape.
- **Last GST return filed**: a change to a document in a filed period waits for you to confirm it. When QuickBooks has the date, Fishtape reads it.
- **Book Stripe from**: Stripe charges before this day stay with your bookkeeper.
- **Practice week first**: recommended. For the first week Fishtape works out every change but writes nothing; read the "would change" list with your bookkeeper, then go live.

## 3. Tax codes, products and accounts

Each Fishtape tax situation gets a QuickBooks tax code: "GST + Manitoba RST", "GST only" (a customer who quotes their RST number still pays GST), and the four no-tax reasons. Fishtape suggests codes by their rates and refuses a code whose rates differ from what Fishtape charges.

- **No-tax reasons.** A document with no tax needs a reason: **zero-rated**, **exempt**, **out of scope** or **Indian Act relief**. Each lands on a different line of the GST return, so each has its own code. Pick the reason under **Why no tax?** on the estimate or invoice. A no-tax document without a reason waits.
- **Purchase tax codes.** PST and RST you pay on things you use yourself (tools, supplies) are not recoverable: Fishtape adds them to the cost of the line and claims only GST (or HST/QST). RST a supplier charged on materials you resell to your customer goes to an **RST recoverable** account until the supplier credits it, never into job cost. Your accountant confirms both.
- **Products and services, accounts, payment methods**: what lines without a price-book item use, where income and job costs go, where each payment method is deposited.
- **Holdback, Deposits, Interest, RST recoverable.** Pick a QuickBooks product for **Holdback** (your accountant points it at a holdback receivable account), **Deposits** and **Overdue interest**, and an account for **RST recoverable**. An invoice with a holdback, a deposit invoice, an interest invoice or a bill with RST on resale materials waits until its product or account is picked.

## 4. Match your records

Fishtape reads your QuickBooks company and pairs records: clients by email, phone or name and postal code; products by SKU or name; invoices and estimates by number and totals. Each tab (Customers, Jobs, Products, Employees, Suppliers, Invoices, Estimates, Payments) shows Fishtape and QuickBooks side by side with a choice: link them, create on the other side, or leave alone.

- A match on name alone always waits for you: two "Dana Smith"s are common, and a wrong link posts invoices to the wrong customer.
- **Possible duplicates**: an invoice that looks like one keyed into QuickBooks by hand under another number. Link it, or create it anyway.

## 5. Review and apply

For each linked record where the two sides differ (a phone number, an address), pick which side is right; the other side is updated on the first sync. **Apply** stays off until every difference has a choice. Creates dated in a filed GST period need their own tick. Then press **Apply** and watch the progress.

## Every day

- Each invoice, estimate, client, payment and approved time entry shows a small QuickBooks badge: **In QuickBooks**, **Sending to QuickBooks**, **Needs a decision**, **Not in QuickBooks**, **Waiting: …** or **Check in QuickBooks**. Tap it for what happened, Retry, Renumber, Unlink or **Open in QuickBooks**.
- **Conflicts**: when someone changed the same money field on both sides, Fishtape writes nothing until you pick. Other fields: the later edit wins.
- **Approve and send**: invoices and payments made by an API key or the assistant wait for an office user before they reach your books.
- **Doesn't match**: a daily check compares what's owing in Fishtape and QuickBooks and lists any difference.
- **Look up in QuickBooks**: search QuickBooks customers, invoices and estimates from Fishtape and import one.
- Credit memos and journal entries applied in QuickBooks show on the invoice as **Credited or paid in QuickBooks**. Change those in QuickBooks. A credit memo applied to one invoice comes into Fishtape as a credit note and its application instead, so it is never counted twice.

## Holdback, deposits and credit notes

- **Holdback**: the amount held back shows as a negative "Holdback retained" line on the invoice in QuickBooks, so the invoice total matches Fishtape's. The release invoice adds it back. Holdback a general contractor kept on its own stays only in Fishtape (the amount stays open in QuickBooks too).
- **Credit notes** go to QuickBooks as credit memos (a bad-debt write-off carries "Bad debt write-off"). Applying a credit note to an invoice waits under **Conflicts** for you to **Approve and send** it.
- **Not sent**: money paid on account, refunds and returned cheques. They wait under **Conflicts** until you enter them in QuickBooks and press **I've recorded it in QuickBooks**.
- **Supplier credits** (a bill below zero) go to QuickBooks as vendor credits.

## After you close a month

When an owner closes the books in Fishtape (Books), a change made in QuickBooks to something in the closed month is not copied into Fishtape. It waits under **Conflicts**: **Reopen the period and accept QuickBooks** (reopen the month on Books first), or **Keep the difference noted** with a short note. Fishtape never writes its own copy over QuickBooks. Bills and payments that arrive late are kept and posted on the first open day. Hours exported to payroll are never changed in QuickBooks from Fishtape.

A Manitoba invoice made in QuickBooks without RST and without the customer's exemption also waits there: add the customer's RST number on the job, then press **I've added it: check again**.

## Good to know

- Edits made offline reach QuickBooks after the device syncs. Nothing from QuickBooks is stored on your devices except the Fishtape records themselves.
- Field crews never see QuickBooks.
- Fishtape's assistant can read your Fishtape records, including those that sync with QuickBooks. QuickBooks' own data (links, sync log, look-ups) is never given to the assistant.
- Disconnecting stops the sync at once and ends Fishtape's access. Records that came from QuickBooks stay in Fishtape. The links are kept 30 days unless you delete them right away.
- Stripe refunds aren't sent to QuickBooks yet: enter them there by hand.

QuickBooks and Intuit are trademarks of Intuit Inc., used with permission.
