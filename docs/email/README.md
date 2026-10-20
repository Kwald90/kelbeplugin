# Email: SendGrid and HQ Mail

Fishtape sends its own email (password resets, invites, HQ alerts, support confirmations and
everything HQ staff write in HQ Mail) through Fishtape's SendGrid account, receives mail for
`support@`, `sales@` and forwarded addresses through SendGrid Inbound Parse, and shows it all
in **HQ Mail** (`/hq/#/mail`), an Outlook-style inbox for HQ staff. Companies send their own
email (sequences, invoices, estimates) with their own SendGrid or Resend key from Integrations.

Setting it up in SendGrid and DNS: [sendgrid-setup.md](sendgrid-setup.md).

## How mail flows

```
Platform email   lib/email.js -> email_outbox -> worker (services/platform-email.js) -> SendGrid Mail Send
                 (custom_args ft_outbox_id + ft_env on every message)
Delivery events  SendGrid Signed Event Webhook -> POST /api/v1/webhooks/sendgrid/events (api)
                 -> email_events + email_outbox.delivery_status (bounce/blocked/dropped => failed)
Inbound mail     MX inbox.fishtapehq.com -> SendGrid Inbound Parse (raw MIME)
                 -> POST /api/v1/webhooks/sendgrid/inbound/<token> (api) -> files in MAIL_DIR + mail_inbound
                 -> hq-api files it into mailboxes/threads/messages on the next HQ Mail request
HQ Mail send     /api/hq/mail/send (hq-api) -> mail_messages (Sent) + email_outbox -> worker -> SendGrid
Support request  POST /api/v1/support/requests (api) -> mail_inbound + confirmation email
Company email    outbox records -> integrations/outbox.js -> the company's SendGrid (or Resend) key
```

The tenant API, the worker and hq-api are separate processes in staging and production
(`deploy/*/docker-compose.yml`). Only hq-api holds the HQ database role, so the tenant API never
reads mail: it can only drop new inbound mail into `mail_inbound` and record delivery events
(INSERT only). hq-api moves the drop box into the inbox at the start of HQ Mail requests
(`src/email/inbox.js` `syncMail`, one at a time via an advisory lock), copies send and delivery
state onto HQ's sent messages, and runs retention once an hour.

## Environment

| Variable | What |
| --- | --- |
| `EMAIL_PROVIDER` | `sendgrid` or `resend`. Default: `sendgrid` when `SENDGRID_API_KEY` is set. |
| `SENDGRID_API_KEY` | Fishtape's SendGrid key, Mail Send permission only. |
| `RESEND_API_KEY` | Only with `EMAIL_PROVIDER=resend`. |
| `EMAIL_FROM` | Sender of system email, e.g. `Fishtape <no-reply@fishtapehq.com>`. |
| `SENDGRID_EVENT_PUBLIC_KEY` | Verification key of the Signed Event Webhook (base64 as SendGrid shows it, or PEM). Without it every event post is refused. |
| `SENDGRID_EVENT_MAX_AGE_S` | Oldest signed request accepted, default 300 s (either direction). |
| `SENDGRID_TRACK_OPENS` | `on` to ask SendGrid for open events. Click tracking is always off (it would rewrite reset links). |
| `SENDGRID_INBOUND_TOKEN` | Last path segment of the Inbound Parse URL. `init-env.sh` generates one. Without it inbound is off (404). |
| `SENDGRID_INBOUND_PUBLIC_KEY` | Optional: verification key of an Inbound Parse security policy; then unsigned inbound posts are refused too. |
| `MAIL_DIR` | Attachments and original `.eml` files. Docker: `/var/lib/fishtape/mail`, a volume from `/var/lib/fishtape-<env>/mail` (uid 1000, mode 700, created by `update.sh`). Refused inside the code checkout. Locally and in tests: the OS temp folder. |
| `MAIL_INBOUND_MAX_BYTES` | Largest inbound request, default 31 MiB (the message itself must be under 30 MiB). |
| `MAIL_DOMAIN` | Domain for Message-IDs Fishtape creates, default `fishtapehq.com`. |
| `MAIL_SUPPORT_ADDRESS` | Reply-To of support confirmations, default `support@inbox.<MAIL_DOMAIN>`. |
| `SUPPORT_RATE_LIMIT_PER_HOUR` / `_PER_DAY` | Support requests per user, default 5 / 20. |

Mailbox addresses, sender addresses, signatures, retention and the spam threshold are set in
HQ Mail > Mail settings (HQ admins).

## Data (migrations 0070, 0071)

| Table | Holds | Access |
| --- | --- | --- |
| `email_outbox` (+ columns) | provider, `sending` state, HQ sender/recipients/headers/attachments, delivery state | app: as before; hq: SELECT, INSERT, UPDATE (status, attempts, last_error) |
| `email_events` | one row per `sg_event_id` (unique, so replays do nothing) | app: INSERT only, outside a company; hq: SELECT, DELETE |
| `mail_inbound` | drop box: parsed inbound mail and support requests | app: INSERT only, outside a company; hq: all |
| `mail_mailboxes`, `mail_threads`, `mail_messages`, `mail_attachments`, `mail_settings` | the HQ inbox | hq only; RLS enabled and forced; no grants to the app role |

`mail_messages.html_body` is the HTML as received; it is sanitized every time it is shown, so a
better sanitizer protects old mail too. Sent system email rows are still purged after 7 days
(`purge_expired`); failed ones stay, so "Not sent" keeps them.

## Security model

- **Inbound endpoint**: the token is compared in constant time (hashes) before the body is read;
  a wrong or missing token is 404. 31 MiB cap (413), raw MIME only (400 otherwise). SendGrid
  retries 5xx answers for up to 3 days, so a storage or database failure loses nothing. The token
  is redacted from API logs (`logger.js`); nginx access logs keep paths, so rotate the token if
  those logs leak. Add the optional security policy for signed inbound posts.
- **Event webhook**: ECDSA P-256 over `timestamp + raw body`, verified with Node's `crypto.verify`;
  unsigned, forged, altered, too old or too new requests get 403. Each event applies once.
- **MIME**: postal-mime 2.7.6 (pinned; no dependencies, by the Nodemailer author, nesting and
  header-size limits). File names are cleaned; at most 100 attachments; files get random names.
- **HTML**: parsed with parse5 8.0.1 (pinned, the WHATWG parser) and rebuilt from an allow-list:
  no scripts, frames, forms, SVG/MathML, event handlers or `javascript:` URLs; links get
  `target=_blank rel="noopener noreferrer nofollow"`; CSS only from an allow-list of properties
  with no `url()`, `expression`, `@import` or `position:fixed`. Tested against an XSS corpus
  (`test/mail-unit.test.js`).
- **Reading pane**: a `srcdoc` iframe with `sandbox="allow-same-origin allow-popups
  allow-popups-to-escape-sandbox"` (no `allow-scripts`) and its own CSP (`default-src 'none';
  img-src 'self' data:; ...`) on top of the HQ page CSP it inherits. Styles are applied through
  CSSOM (inline `style` attributes travel as `data-ft-style`; `<style>` blocks as a constructable
  stylesheet), so the site CSP stays unchanged. Remote images are removed until "Show images",
  then load through `/api/hq/mail/messages/:id/images/:n`, which fetches only URLs found in that
  message (never one from the browser), refuses private/loopback/link-local/reserved addresses at
  connect time (DNS rebinding safe), follows at most 3 redirects, caps 5 MB and accepts only real
  PNG/JPEG/GIF/WebP bytes. Tracking pixels are dropped unless images are allowed. `cid:` images
  are inlined as `data:` URLs.
- **Downloads**: always `Content-Disposition: attachment` (ASCII and UTF-8 names), `nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `no-store`, and the stored type only
  when it is inert (PDF, images, text, Office, zip); anything else is `application/octet-stream`.
- **Compose**: the editor pastes plain text only; the server sanitizes outgoing HTML (compose
  mode: no styles, `data:` images only) and builds the text part from it.
- **System email bodies are never shown** in HQ (they hold reset and invite links): HQ sees the
  recipient, subject, template, status, error and delivery events.
- **Logs**: no addresses, subjects, bodies or tokens (tested in `test/mail.test.js`).

## HQ Mail

Folders per mailbox: Inbox, Drafts, Sent items, Outbox (queued, sending or delayed), Not sent
(failed, bounced, blocked or dropped, with the reason), Archive, Junk email (SendGrid spam score
at or above the threshold, default 5) and Deleted items; plus System email (Outbox, Not sent,
Sent). Conversations group by thread (Message-ID / In-Reply-To / References, then the same subject
with a shared participant within 30 days). Command bar: New, Reply, Reply all, Forward, Archive,
Delete, Junk, Read/Unread, Flag, Assign; search with From, To, Subject, Has attachments, Unread
and All folders. Compose in the reading pane or a pop-out window (`#/mail/compose/<draftId>`),
with Bold, Italic, lists, links, per-mailbox signatures and attachments (20 MB per message).

Keyboard (Outlook): Ctrl+Shift+M or N new, Ctrl+R reply, Ctrl+Shift+R reply all, Ctrl+F forward,
Delete, Ctrl+Alt+J junk, Ctrl+Q read, Ctrl+U unread, Insert flag, Ctrl+E or F3 search, arrows,
Ctrl+Enter send, Esc close. (Ctrl+N can't be used: browsers reserve it.)

Retention (HQ admin): mail older than `retention_days` (default 730) is deleted except flagged
mail; Junk and Deleted items after `cleanup_days` (default 30); delivery events after 180 days;
orphaned files after a day.

### HQ endpoints (`/api/hq/mail`, HQ staff with MFA; * = HQ admin)

| | |
| --- | --- |
| `GET /overview` | mailboxes with counts, system email counts, staff, settings, setup state |
| `POST /list` | `{ mailboxId \| 'system', folder, q?, from?, to?, subject?, hasAttachment?, unread?, flagged?, group?, cursor?, limit? }` |
| `GET /messages/:id[?images=1]` | sanitized render, attachments, conversation, delivery events |
| `GET /messages/:id/images/:n` | remote image n of that message, through the proxy |
| `GET /messages/:id/raw`, `GET /attachments/:id` | downloads |
| `PATCH /messages` | `{ ids, read?, flagged?, folder?: inbox\|archive\|junk\|trash\|restore, assignedTo?, thread? }` |
| `DELETE /messages` | `{ ids }`, only Deleted items and drafts |
| `POST /drafts`, `POST /send` | `{ mailboxId, draftId?, to[], cc[], bcc[], subject, html, replyToId?, forwardOfId?, attachmentIds[] }` |
| `POST /messages/:id/to-drafts` | stop a queued message, or take a failed one back to Drafts |
| `POST /uploads` | `{ filename, contentType, data (base64) }` |
| `POST /messages/:id/forward-attachments` | copies of a message's attachments for a forward |
| `GET /system/:id` | a system email (never the body) |
| `POST /mailboxes`*, `PUT /mailboxes/:id`*, `DELETE /mailboxes/:id`*, `PUT /settings`* | |

## Support requests from the app (contract for the Help page)

`POST /api/v1/support/requests` — any signed-in company user (session cookie with `X-Fishtape: 1`,
or a bearer session from the iOS app). API keys are refused. 5 per user per hour and 20 per day,
plus 10 per minute per client; 8 MB body.

```jsonc
{
  "subject": "Invoice PDF is blank",          // required, 1-200
  "message": "When I print invoice 1042 ...",  // required, 1-10000
  "category": "problem",                       // optional: question | problem | billing | idea | other
  "appVersion": "1.4.2",                       // optional, [A-Za-z0-9._+-], max 40
  "page": "#/invoices",                        // optional, max 200: the screen they were on
  "screenshot": "data:image/png;base64,..."    // optional: PNG, JPEG or WebP, under 5 MB
}
```

`201 { "reference": "FT-7K2M9Q", "received": true, "confirmationEmailed": true }`.
Errors: `400 validation_failed | bad_screenshot`, `401`, `403`, `429 rate_limited`,
`503 mail_storage_unavailable` (screenshot only; send without it).

The server adds the company (name, id, plan), the person (name, email, role) and the browser, and
files it in the Support mailbox with subject `[FT-XXXXXX] subject`. The user gets an email
"We got your message [FT-XXXXXX]" from `EMAIL_FROM` with Reply-To the support address; replying to
it threads into the same conversation. HQ answers from the Support mailbox like any mail; the
answer goes to the user's email address. Users without an email (crew PIN only) are filed but get
no confirmation (`confirmationEmailed: false`).

## Company email through SendGrid

Integrations has a SendGrid card next to Resend (`sendgrid.api_key` `SG.…`, `sendgrid.from`,
optional Reply-to). If both are connected, SendGrid sends. Connection test: `GET /v3/scopes`
(must include `mail.send`); the domain is checked too when the key may read Sender Authentication.
SendGrid has no idempotency key, so a company email interrupted mid-send is marked failed with
"Check SendGrid > Activity" instead of being re-sent. Guide: `electrical-app/guides/sendgrid.md`.

## SendGrid facts this is built on (checked 2026-10-19)

| Fact | Source (page modified) |
| --- | --- |
| `POST https://api.sendgrid.com/v3/mail/send`, `Authorization: Bearer`, 202 Accepted; errors `{ errors: [{ message, field, help }] }` with 400/401/403/404/405/413/500 | Mail Send reference (2025-09-25) |
| `personalizations[].custom_args` object ≤ 10,000 bytes; categories ≤ 10, ≤ 255 chars each; headers may not set x-sg-id, x-sg-eid, received, dkim-signature, Content-Type, Content-Transfer-Encoding, To, From, Subject, Reply-To, CC, BCC | Mail Send reference (2025-09-25) |
| Message < 30 MB with attachments; ≤ 1,000 recipients; reply_to and reply_to_list exclusive | Mail Send limitations (2026-08-14) |
| Rate limits: 429 with X-RateLimit-Limit/Remaining/Reset; no fixed number given for mail/send | Rate limits (2026-07-02) |
| 403 "The from address does not match a verified Sender Identity" | Twilio error 60222 |
| X-Message-Id response header on 202 (first part of `sg_message_id`) | general SendGrid behaviour, not on the reference page: VERIFY |
| Signed Event Webhook: headers `X-Twilio-Email-Event-Webhook-Signature` / `-Timestamp`, ECDSA over SHA-256(timestamp + raw body), base64 signature; Settings > Mail Settings > Event Webhooks > Security features > Enable Signed Event Webhook, key shown after Save; each webhook has its own key | Event Webhook security features (2026-07-23); sendgrid-nodejs eventwebhook helper |
| Events: processed, dropped, delivered, deferred, bounce (`type` bounce or blocked), open, click, spamreport, unsubscribe, group_*; `sg_event_id` unique; custom args are top-level keys; body is a JSON array | Event Webhook reference (2026-07-09) |
| Event Webhook retries non-2xx for 24 hours | general SendGrid behaviour: VERIFY |
| Inbound Parse raw mode posts multipart/form-data with `email` (full MIME), `envelope`, `spam_score`, `spam_report`, `SPF`, `dkim`, `charsets`...; spam check for mail ≤ 2.5 MB; MX `10 mx.sendgrid.net` on a dedicated host; Settings > Inbound Parse > Add Host & URL | Setting up Inbound Parse (2026-10-08) |
| Inbound Parse can be secured with a security policy (ECDSA signature, OAuth or both): `POST /v3/user/webhooks/security/policies`, then `PATCH /v3/user/webhooks/parse/settings/{hostname}` with `security_policy` | Securing Inbound Parse (2026-10-07) |
| Inbound Parse retries 5xx for up to 3 days, then drops; sources disagree on 4xx | Inbound Parse docs and support article "Inbound Parse Webhook Retry Logic" |
| API keys: Settings > API Keys > Create API Key > Custom Access > Mail Send; shown once | API keys (2026-08-14) |
| Domain authentication: Settings > Sender Authentication > Get Started; automated security gives CNAMEs `em####`, `s1._domainkey`, `s2._domainkey` and a TXT `_dmarc` (`v=DMARC1; p=none;`); up to 3,000 domains | Domain authentication (2026-08-28) |
| Link branding must match the From domain; 2 CNAMEs (`url####`, `####`) | Link branding (2026-08-28) |
| No free plan for new accounts (60-day trial, 100/day); Essentials about US$20/month | third-party pricing summaries: VERIFY on sendgrid.com/pricing |

## Open items

- Confirm SendGrid keeps our `Message-ID` header (threading falls back to subject + participant if not).
- The Inbound Parse security policy is optional; turn it on once SendGrid's UI shows it for the account.
- `hq-api` should eventually serve only `/api/hq/*` (backlog: HQ-only mode); today every process
  has these routes and the tenant API answers HQ routes with 503.
- The in-app Help page (another workstream) calls the support endpoint.
