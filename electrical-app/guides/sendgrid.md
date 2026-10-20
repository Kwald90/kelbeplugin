# Send email from your own address with SendGrid

SendGrid is the other way (besides Resend) to have Fishtape send your follow-up sequences, invoices and estimates by email, from your company address (for example `office@yourcompany.ca`). Replies come straight back to you. Connect SendGrid **or** Resend; if both are connected, Fishtape uses SendGrid.

About 30 minutes, plus waiting for DNS (usually minutes, sometimes a few hours). You need to be an owner or admin in Fishtape, on the Pro plan or higher, and able to change DNS records for your domain (where you bought it, for example GoDaddy, Namecheap, Cloudflare or your web host).

## What it costs

SendGrid no longer has a free plan for new accounts: you get a 60-day trial (at most 100 emails a day), then a paid plan. The Essentials plan starts at about US$20 a month. These figures come from pricing summaries checked 2026-10-19; check [sendgrid.com/pricing](https://sendgrid.com/pricing) for the current prices. If you send fewer than 3,000 emails a month, Resend's free plan may suit you better.

## 1. Create a SendGrid account

1. Go to [sendgrid.com](https://sendgrid.com) and sign up. Use an address you check: SendGrid sends account notices there.
2. SendGrid asks a few questions about your business and may review the account before it can send. Answer plainly: "Transactional email (invoices, estimates) and follow-ups to my own customers."
3. Turn on two-factor authentication when SendGrid asks. It is required.

## 2. Authenticate your domain

Email from your own domain needs a few DNS records so inboxes trust it and it doesn't land in spam.

1. In SendGrid, open **Settings > Sender Authentication**.
2. Under **Domain Authentication**, press **Get Started**.
3. **Which Domain Name Server (DNS) host do you use?** Pick yours, or **I'm not sure**.
4. **Would you also like to brand the links for this domain?** Choose **Yes**. Press **Next**.
5. **Domain You Send From**: type your domain only, for example `yourcompany.ca` (no `www`, no `office@`). Leave **Advanced Settings > Use automated security** on. Press **Next**.
6. SendGrid shows the DNS records: three or four CNAME records (names like `em1234`, `s1._domainkey`, `s2._domainkey`, `url1234`) and a TXT record for `_dmarc`.
7. In another tab, open your domain's DNS settings and add each record exactly as shown. Copy and paste the values; one wrong character stops it working.
8. Back in SendGrid, tick **I've added these records** and press **Verify**. Wait until every row shows a green tick. It can take up to 48 hours, usually much less.

> **Your email lives in Outlook, Microsoft 365 or Google?** These records don't change where your mail is delivered. Don't change your domain's MX records for SendGrid.

## 3. Create an API key

1. In SendGrid, open **Settings > API Keys > Create API Key**.
2. **API Key Name**: `Fishtape`.
3. **API Key Permissions**: choose **Custom Access** (older screens call it **Restricted Access**), find **Mail Send** and give it **Full Access**. Leave everything else at **No Access**.
4. Press **Create & View** and copy the key. It starts with `SG.` and is shown once.

Optional: also give **Sender Authentication** read access, and the connection test will check that your domain is authenticated.

## 4. Connect it in Fishtape

1. Open **Integrations > SendGrid**.
2. Paste the key into **SendGrid API key**.
3. In **SendGrid sender address**, type the name and address your customers should see, using the authenticated domain:

   `TG Electrical <office@yourcompany.ca>`

4. Optional: **Reply-to address**. Leave it blank to use the email in **Settings > Company**.
5. Press **Save**, then **Test connection**.

With a Mail Send-only key the test says the key works but cannot check the domain. Send yourself an invoice to be sure.

## Troubleshooting

- **"SendGrid will not send from this address"**: the domain in your sender address is not authenticated yet. Finish step 2, or fix the sender address so it uses that domain.
- **"This SendGrid API key may not send mail"**: the key has no Mail Send permission. Create a new key (step 3).
- **"SendGrid refused the API key"**: the key was deleted or mistyped. Paste it again.
- **Emails land in spam**: check that every record in step 2 shows a green tick, and add the `_dmarc` TXT record if you skipped it.

Need a hand? Press **Ask us to set this up** on the card and we'll do it with you.
