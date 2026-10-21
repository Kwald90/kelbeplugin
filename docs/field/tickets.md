# Field tickets: extra work and T&M, signed on site

Release 1 ([build contract](../releases/r1-get-paid.md) 4.1). When the customer asks for something that isn't
in the job, write a ticket and get it signed before you leave. Tickets work with no signal. They save on the
phone and sync when you're back online.

A ticket never shows a price. The office prices it afterwards.

## Write a ticket

1. Tap **My day → New ticket**. It opens on the job you're clocked into. You can also start one from the job's
   **Tickets** tab, or from **Field tickets → New ticket**.
2. Pick **T&M** or **Extra work** (a T&M job starts as T&M). Say what the work was, the details, and who asked
   for it.
3. **Labour** is filled in from today's time on the job, including the hours you're on the clock right now. A
   foreman sees the crew's hours. Change the hours if needed.
4. **Material**:
   - **From the van**: pick an item from your van. If you can move stock, it comes off the van onto the job.
     Otherwise the office moves it.
   - **From requests**: material asked for on this job.
   - Or type it in.
5. **Equipment**: pick from the list. A truck already on today's clock-in is charged by the clock, not again.
6. Up to **4 photos**. Each is shrunk on the phone to 250 KB or less.
7. **Pricing**: **Our contract rates** adds "Billed at the rates in contract 24-117." when you give the rate
   sheet. **Quote to follow** adds "Price to follow by quote; this confirms the work only."

The number shows as **T-pending a3f9** until the ticket syncs. Then it gets its number from the server
(T-1001 and up), so two phones never use the same one.

## Get it signed

Tap **Get it signed**. The super sees the work, the hours and quantities, and what they are agreeing to. They
never see a price. They type their name and title and sign with a finger.

- If the job has a list of people who may sign for the GC and this person isn't on it, you'll see "Not on the
  GC's list of signers". You can still take the signature.
- When the company records it, the phone takes a location fix with the signature. The signer is told before
  they sign: their name, signature, the time and the location are kept with the ticket, and they can ask for a
  copy.
- If they give an email, they get a copy once the ticket syncs.
- **Customer won't sign**: records who refused and why. The office sends the general contractor a written
  notice of the extra work.
- **Super isn't here**: leave the ticket as a draft. A foreman or the office can have several tickets signed
  at once later (**Sign several tickets** on the job, up to 30).

Once signed or refused, a ticket can't be changed. If something was wrong, write a new ticket. Only the office
can void a ticket, and a signed ticket is never deleted.

## What happens next (office)

- On a fixed-price job the office prices the ticket into a change order and gets that signed.
- On a T&M job it's billed with the time, and the hours are compared day by day.
- On a service call a draft invoice is ready for the office within 15 minutes.

See [getting paid](../office/getting-paid.md).

## Settings (office: Field tickets → Settings)

| setting | default |
| --- | --- |
| What the customer agrees to | "I confirm the work listed above was requested and done." |
| Record the location with each signature | on |
| Send written notice when a customer refuses to sign | on |
| Unsigned tickets are stale after | 3 days |
| T&M invoices bill hours from | time entries (with the day-by-day comparison) |
