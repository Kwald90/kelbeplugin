# SendGrid setup for Fishtape (for Kelvin)

What this gets you: Fishtape's own email (password resets, invites, support confirmations, HQ
Mail replies) sent from `fishtapehq.com` through SendGrid, delivery results (delivered,
bounced, dropped) shown in HQ Mail, and mail to `support@inbox.fishtapehq.com` and
`sales@inbox.fishtapehq.com` (plus anything you forward in) arriving in HQ Mail.

About an hour plus DNS waiting. You need: the SendGrid account (owner login, two-factor on), the
DNS control panel for `fishtapehq.com` (and for `tgelectrical.ca` for step 3), and SSH to the
server to edit `.env` (or ask the lead to do steps 8–9). Screen names were checked against
SendGrid's documentation on 2026-10-19; SendGrid moves things now and then, so if a name differs
slightly, look for the closest match.

Write every value you create (keys, tokens) straight into the password manager.

## 1. Authenticate fishtapehq.com (lets SendGrid send as @fishtapehq.com)

1. SendGrid > **Settings > Sender Authentication**.
2. Under **Domain Authentication** press **Get Started**.
3. **Which Domain Name Server (DNS) host do you use?** pick your DNS host (or **I'm not sure**).
4. **Would you also like to brand the links for this domain?** **Yes**. Press **Next**.
5. **Domain You Send From**: `fishtapehq.com` (no `www`, no `inbox.`).
6. Open **Advanced Settings**: leave **Use automated security** ticked; leave the others off.
   Press **Next**.
7. SendGrid shows **Install DNS Records** (Manual Setup tab). Add each record at your DNS host
   exactly as shown. They look like this (your numbers will differ):

   | Type | Host / Name | Value / Points to |
   | --- | --- | --- |
   | CNAME | `em1234.fishtapehq.com` | `u1234567.wl123.sendgrid.net` |
   | CNAME | `s1._domainkey.fishtapehq.com` | `s1.domainkey.u1234567.wl123.sendgrid.net` |
   | CNAME | `s2._domainkey.fishtapehq.com` | `s2.domainkey.u1234567.wl123.sendgrid.net` |
   | TXT | `_dmarc.fishtapehq.com` | `v=DMARC1; p=none;` (see step 4 before adding) |

   Many DNS panels add the domain themselves: enter `em1234`, not `em1234.fishtapehq.com`.
   Turn off any "proxy" (Cloudflare orange cloud) on these CNAMEs.
8. Back in SendGrid tick **I've added these records** and press **Verify**. Every row needs a
   green tick. DNS can take up to 48 hours; usually minutes.

## 2. Link branding

If you answered **Yes** in step 1.4, link branding is set up with the same records. Otherwise:
**Settings > Sender Authentication > Link Branding > Brand Your Links**, domain `fishtapehq.com`,
**Next**, add the two CNAMEs it shows (like `url1234.fishtapehq.com` and `1234567.fishtapehq.com`,
both pointing to `sendgrid.net`), tick **I've added these records**, **Verify**.

Fishtape turns click tracking off on every message (reset links must not be rewritten), so link
branding mostly matters for any marketing sends you do from SendGrid itself.

## 3. Add another domain: tgelectrical.ca

This lets HQ Mail send as `info@tgelectrical.ca` (from a "TG Electrical" mailbox, step 7).

> **Do not touch the MX records of tgelectrical.ca.** Its mailbox (`info@tgelectrical.ca`) lives
> in Outlook / Microsoft 365. Changing the root MX to SendGrid would stop that mail reaching
> Outlook. SendGrid only needs the CNAMEs below to *send* as tgelectrical.ca. To get its mail into
> HQ Mail, forward it (step 6), don't re-point it.

1. **Settings > Sender Authentication > Domain Authentication > Authenticate Your Domain** (or
   **Get Started**) again.
2. DNS host: wherever `tgelectrical.ca` is managed. Brand links: **No** (keep it simple).
3. **Domain You Send From**: `tgelectrical.ca`. **Advanced Settings**: **Use automated security** on.
4. Add the CNAMEs it shows (`em####`, `s1._domainkey`, `s2._domainkey` on tgelectrical.ca).
   They don't clash with Microsoft 365, which uses `selector1._domainkey` / `selector2._domainkey`.
5. **Do not add a second `_dmarc` record** if tgelectrical.ca already has one (check first: a
   domain may have only one). Keep the existing one.
6. Don't edit the root SPF record (`v=spf1 include:spf.protection.outlook.com -all`): with
   automated security SendGrid's SPF lives on the `em####` subdomain.
7. **Verify** until every row is green.

## 4. DMARC for fishtapehq.com

One TXT record at `_dmarc.fishtapehq.com` (if SendGrid's step 1 table already showed it, use this
value instead of `p=none;` alone). Start in monitoring mode:

    v=DMARC1; p=none; rua=mailto:dmarc@fishtapehq.com; adkim=r; aspf=r; pct=100

`rua` sends daily reports to that address (point it at a mailbox you read, or a free DMARC report
service). After 2–4 weeks of clean reports change `p=none` to `p=quarantine`, later `p=reject`.
If `fishtapehq.com` also sends from Google Workspace or Microsoft 365, set up DKIM there first.

## 5. A restricted API key (Mail Send only)

1. **Settings > API Keys > Create API Key**.
2. **API Key Name**: `Fishtape production` (make a separate `Fishtape staging` key for staging).
3. Choose **Custom Access** (older screens: **Restricted Access**). Set **Mail Send** to
   **Full Access**. Everything else **No Access**.
4. **Create & View**. Copy the key (starts with `SG.`); it is shown once. This is
   `SENDGRID_API_KEY`.

## 6. Signed Event Webhook (delivery results)

1. **Settings > Mail Settings**, then under **Webhook Settings** open **Event Webhooks**.
2. **Create new webhook** (or edit the existing one):
   - **Friendly name**: `Fishtape production`
   - **Post URL**: `https://app.fishtapehq.com/api/v1/webhooks/sendgrid/events`
     (staging: `https://tgelectrical.truecollarbuilt.com/api/v1/webhooks/sendgrid/events`)
   - **Actions to be posted**: Processed, Dropped, Deferred, Bounced, Delivered, Spam Reports.
     Opened only if you also set `SENDGRID_TRACK_OPENS=on`. Leave Clicked off.
   - **Security features**: turn on **Enable Signed Event Webhook**. Leave OAuth off.
3. **Save**. The key pair is made on save.
4. Open the webhook again (cog > **Edit**) and copy the **Verification Key** (a long base64
   string starting `MFkw…`). This is `SENDGRID_EVENT_PUBLIC_KEY`.
5. After step 9, press **Test Integration**: the server answers 200 (test events match no email,
   so nothing changes).

Staging and production can share one SendGrid account: give each its own webhook and key; each
server ignores the other's events (`ft_env`).

## 7. Inbound Parse for inbox.fishtapehq.com (receiving)

1. Make a token: on the server `openssl rand -hex 32` (`init-env.sh` already put one in new `.env`
   files as `SENDGRID_INBOUND_TOKEN`).
2. DNS for `fishtapehq.com`: add **one** MX record on the subdomain only:

   | Type | Host / Name | Priority | Value |
   | --- | --- | --- | --- |
   | MX | `inbox` (= `inbox.fishtapehq.com`) | `10` | `mx.sendgrid.net` |

   Don't change the MX of `fishtapehq.com` itself. Don't edit this record later; SendGrid says a
   changed record stops the host receiving.
3. SendGrid > **Settings > Inbound Parse > Add Host & URL**:
   - **Receiving Domain**: subdomain `inbox`, domain `fishtapehq.com` (the list shows authenticated
     domains, so step 1 must be done).
   - **Destination URL**: `https://app.fishtapehq.com/api/v1/webhooks/sendgrid/inbound/<token>`
     with the token from step 7.1 in place of `<token>` (staging:
     `https://tgelectrical.truecollarbuilt.com/api/v1/webhooks/sendgrid/inbound/<token>`).
   - Tick **Check incoming emails for spam** (gives the spam score HQ uses for Junk).
   - Tick **POST the raw, full MIME message**. Fishtape refuses the other format.
   - **Add**.
4. Optional, stronger: SendGrid can also sign inbound posts with a "security policy" (API:
   `POST /v3/user/webhooks/security/policies` with `{"name":"fishtape","signature":{"enabled":true}}`,
   then `PATCH /v3/user/webhooks/parse/settings/inbox.fishtapehq.com` with
   `{"security_policy":"<policy id>"}`). Put the returned `signature.public_key` in
   `SENDGRID_INBOUND_PUBLIC_KEY`; unsigned inbound posts are then refused too.

## 8. Forward info@tgelectrical.ca into HQ Mail (keeps the Outlook mailbox)

1. In HQ Mail > **Mail settings** > **Add a mailbox**: name `TG Electrical`, address
   `tg@inbox.fishtapehq.com`, alias `info@tgelectrical.ca`, sender name `TG Electrical`, sender
   address `info@tgelectrical.ca` (needs step 3), a signature. Save.
2. In Outlook (outlook.office.com, signed in as info@tgelectrical.ca): **Settings > Mail > Rules >
   Add new rule**: name `Copy to Fishtape HQ`, condition **Apply to all messages**, action
   **Forward to** `tg@inbox.fishtapehq.com`. Save. (Or **Settings > Mail > Forwarding**, with
   **Keep a copy of forwarded messages** ticked.)
3. Microsoft 365 blocks automatic forwarding to outside addresses by default. In the Microsoft
   Defender portal: **Email & collaboration > Policies & rules > Threat policies > Anti-spam >
   Anti-spam outbound policy**, set **Automatic forwarding rules** to **On - Forwarding is enabled**
   for this mailbox (best: a custom outbound policy that applies only to info@tgelectrical.ca).
4. Send a test to info@tgelectrical.ca from another account; it should appear in Outlook **and**
   in HQ Mail under TG Electrical within a minute.

The same works for any other address: forward it to `<anything>@inbox.fishtapehq.com` and add that
address as a mailbox (or as an alias of one). Mail to unknown `@inbox.fishtapehq.com` addresses
lands in the default mailbox (Support).

## 9. Server settings

Add to `deploy/production/.env` (and `deploy/staging/.env` with the staging values), then run the
normal update (it creates `/var/lib/fishtape-<env>/mail` owned by uid 1000, mode 700):

    EMAIL_PROVIDER=sendgrid
    SENDGRID_API_KEY=SG.…                    # step 5
    EMAIL_FROM=Fishtape <no-reply@fishtapehq.com>
    SENDGRID_EVENT_PUBLIC_KEY=MFkw…          # step 6.4
    SENDGRID_TRACK_OPENS=off
    SENDGRID_INBOUND_TOKEN=…                 # step 7.1
    SENDGRID_INBOUND_PUBLIC_KEY=             # optional, step 7.4
    MAIL_DOMAIN=fishtapehq.com
    # MAIL_DIR is set by docker-compose.yml (/var/lib/fishtape/mail)

`RESEND_API_KEY` can stay empty. The `.env` file stays `root:root`, `chmod 600`.

## 10. Check it works

1. HQ > **Mail**: the folder pane shows no orange warnings at the bottom.
2. Press **New**, send yourself a message from Support. It sits in **Outbox** for up to a minute,
   then moves to **Sent items**; open it: the card says **Delivered** with the events.
3. Reply to it from your own mail: the reply appears in the Support **Inbox**, in the same
   conversation.
4. Send to `nobody@fishtapehq.invalid`: it shows under **Not sent** with the bounce or drop reason.
5. In the app, a company user sends a support request (Help page): it lands in Support with the
   company and app version, and they get the "We got your message" email.

If a step fails: HQ > Developer health and the API logs (`docker compose logs api hq-api worker`)
show refused webhooks as `sendgrid event webhook refused` with a reason (`unsigned`, `stale`,
`bad_signature`, `not_configured`), never with message content.
