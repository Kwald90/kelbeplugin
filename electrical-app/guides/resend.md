# Send email from your own address with Resend

With Resend connected, Fishtape sends your follow-up sequences, invoices and estimates by email, from your company address (for example `office@yourcompany.ca`). Replies come straight back to you. Without it, emails wait in the outbox for someone to send by hand.

About 20 minutes, plus waiting for DNS (usually minutes, sometimes a few hours). You need to be an owner or admin in Fishtape, on the Pro plan or higher, and able to change DNS records for your domain (where you bought it, for example GoDaddy, Namecheap, Cloudflare or your web host).

## What it costs

Resend pricing, checked 2026-10-19 (Resend lists its prices in US dollars):

| Plan | Price | Emails |
| --- | --- | --- |
| Free | $0 | 3,000 a month, at most 100 a day |
| Pro | $20 a month | 50,000 a month, then $0.90 per 1,000 |

Most contractors fit in the free plan. Check [resend.com/pricing](https://resend.com/pricing) for current prices.

## 1. Create a Resend account

1. Go to [resend.com](https://resend.com) and sign up.
2. Use an address you check: Resend sends account notices there.

## 2. Verify your domain

Email from your own domain needs a few DNS records so inboxes trust it and it doesn't land in spam.

1. In Resend, open **Domains > Add domain**. Enter your domain, for example `yourcompany.ca`. Resend may suggest a subdomain such as `send.yourcompany.ca`; either works.
2. Resend shows a list of DNS records (MX, TXT for SPF, TXT for DKIM, and an optional DMARC record).
3. In another tab, open your domain's DNS settings and add each record exactly as shown. Copy and paste the values; one wrong character stops it working.
4. Back in Resend, press **Verify DNS records**. Wait until the domain shows **Verified**.

## 3. Create an API key

1. In Resend, open **API Keys > Create API key**. Name it `Fishtape`.
2. Permission: **Sending access** is enough. Pick your domain if it asks.
3. Copy the key. It starts with `re_` and is shown once.

## 4. Connect it in Fishtape

1. Open **Integrations > Resend**.
2. Paste the key into **Resend API key**.
3. In **Resend sender address**, type the name and address your customers should see, using the verified domain:

   `TG Electrical <office@yourcompany.ca>`

4. Optional: **Reply-to address**. Leave it blank to use the email in **Settings > Company**.
5. Press **Save**. Fishtape tests the connection right away.

With a sending-only key the test says the key works but cannot check the domain. Send yourself an invoice to be sure.

## 5. Try it

1. Open an invoice, press **Print / PDF**, then **Email**. Send it to yourself.
2. It arrives within a minute. Check that it is not in spam and that **Reply** goes to your office address.

## Good to know

- Follow-up emails from sequences get a short footer with your company name and address and a line saying to reply "unsubscribe" to stop. Canada's anti-spam law (CASL) requires that in marketing email. If someone asks to unsubscribe, stop their sequence on the Leads board. Invoices and estimates don't get the footer.
- Each email shows its result on the outbox item: **sent**, or **failed** with the reason (for example "no valid email address"). Temporary problems are retried automatically.
- Fishtape's own emails (password resets, invitations) don't use your Resend account.

> **Ask us to set this up.** DNS is the fiddly part. We can add the records with you on a short call, verify the domain and send a test, for a flat fee quoted up front. Included with Enterprise. [Email us](mailto:setup@fishtapehq.com?subject=Please%20set%20up%20Resend%20email) or press **Ask us to set this up** on the card.
