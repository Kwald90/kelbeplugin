# Backlog

Open items raised while building. Newest decisions live in [BUILD-PLAN.md](BUILD-PLAN.md).
Tag: **K** needs Kelvin, **legal** needs a lawyer or accountant, **dev** is code.

## Needs Kelvin

- **K** App Store Connect: create the app record for bundle ID `com.fishtapehq.app` (registered 2026-10-19, team 9C68LPL6JA) in the web UI (Apple has no API for that), then TestFlight. Steps: `docs/mobile/README.md`.
- **K** Production VPS at dotmoose: host, SSH access, OS, data-centre country, disk encryption.
- **K** Domain: confirm the spelling registered (fishtapehq.com vs fishtapewq.com) and point DNS (`app.`, `hq.`, `status.`).
- **K** Real tier prices (placeholders in `electrical-app/js/plans.js`), the failed-payment grace period (7 days now), the trial length (14 days now, `TRIAL_DAYS`) and the deleted-company grace (30 days now).
- **K** Self-serve sign-up: is the $1 deposit refunded when someone cancels during the trial (today it stays as a credit on their Stripe customer)? Keep an abandoned sign-up's email for follow-up, or wipe it at expiry (today: wiped)? GST/HST on the deposit? Run `node scripts/stripe-setup.js` to create `fishtape_signup_deposit_cad`, and add the `checkout.session.expired`/`async_payment_*` events to the platform webhook.
- **K** App Store guideline 3.1: selling Fishtape plans through Stripe inside the iOS app risks rejection. Recommended: in the app, Billing shows the plan and says "manage your plan at fishtapehq.com" with no buy buttons; purchases happen on the web. Options in `docs/mobile/README.md`.
- **K** When a subscription is cancelled or unpaid past grace: free Starter (current behaviour) or suspend the company?
- **K** Charge GST/HST on Fishtape subscriptions through Stripe Tax, or another way? Needs a GST/HST registration for Fishtape itself.
- **K** TG Electrical's province, GST/HST number and ECRA/ESA numbers.
- **K** Which benders the crew uses (make, sizes, hydraulic shoes) and the box-offset rule used in the field.
- **K** Buy CSA C22.1:24 to clear the `VERIFY` items (`docs/code/verify.md`, `docs/field/*.md`).
- **K** "Ask us to set this up": real address (placeholder `setup@fishtapehq.com`) and price.
- **K** "FB Muse": Facebook Lead Ads (built) or Meta's Muse AI model?
- **K** AI defaults: a US$50/month cap per company, the model (Opus 5.5 now, about US$0.10–0.15 per drafted estimate, unmeasured; `AI_MODEL` can switch to a cheaper one), whether MCP agents may create and update records or only read and draft, and keeping chats (with photos) 180 days.
- **K** GitHub: make `claude/electrical-concept-app-h4qz12` the default branch, turn on Dependabot alerts, branch protection ("CI passed"), private vulnerability reporting, and the `staging`/`production` environments with secrets (`docs/runbooks/deploy-staging.md`).
- **K** Offsite backup target in Canada, an uptime monitor, a backup heartbeat URL.
- **K** Move the backup private key (`C:\Users\Kelvin\.fishtape-keys\fishtape-staging-backup.key`) into the password manager and onto a USB stick.
- **K** Change the build Mac's password and turn on "Prevent automatic sleeping when the display is off".

## Running Fishtape as a business (Kelvin)

- **K** Decide which company sells Fishtape (True Collar Built's Stripe account takes the payments today), its GST/HST registration (required once taxable sales pass $30,000 in four quarters; voluntary earlier lets you claim input tax credits) and bookkeeping for SaaS revenue.
- **K** File a CIPO trademark application for "Fishtape" (software, class 9 and 42) before spending on marketing.
- **K** Insurance: technology errors & omissions and cyber liability before taking paying customers.
- **K** Support: hours, response times, refund and cancellation policy (shown on pricing and in the terms).
- **K** An external uptime monitor (the status page on the same box goes down with it).
- **K** Hero videos (prompts in `docs/marketing/hero-video-prompts.md`) and product screenshots for the landing page.

## Needs a professional

- **legal** CASL: is "reply unsubscribe" enough in follow-up emails and SMS, or do we need a one-click unsubscribe link and consent records?
- **legal** PST on Saskatchewan and Manitoba contracts (labour taxed) and BC mixed real-property/goods jobs: confirm defaults with an accountant.
- **legal** Privacy policy and terms (PIPEDA, provincial laws), and the export-compliance answer for the App Store. `site/terms.html` and `site/privacy.html` are DRAFT placeholders linked from the sign-up form; bump `TERMS_VERSION` in `server/src/services/signup.js` when they change.

## Code

- **dev** Server-side sequence runner: steps after day 0 are only queued when someone opens Sequences.
- **dev** Sequences screen still says providers aren't connected and hides failed outbox items unless "Show sent" is on.
- **dev** Facebook leads after a downgrade get a 403 and are lost once Meta stops retrying: store them and show them as locked instead.
- **dev** Stripe refunds don't sync back; emailed invoices carry a summary and pay link but no PDF attachment.
- **dev** A dev script that serves the PWA with an `/api/` proxy to a local API (the E2E driver has one).
- **dev** Photos and drawing underlays as data URLs: move to object storage. A dense 20-sheet plan set is about 140 MB held in memory and synced as whole records (each sheet up to ~7 MB).
- **dev** Plan sets: the wire-runs plan picker still copies full drawings; job and client tabs list sheets one by one instead of grouped; read sheet numbers from the title block when a PDF has no page labels.
- **dev** Server hardening from the platform review: HQ-only mode for `hq-api`, `__Host-` session cookie, decrypt-only previous master key for rotation, a CSP report endpoint, a full resync after a database restore.
- **dev** `docs/architecture/api.md`: add the integrations, webhooks, `/me` and pay-link endpoints.
- **dev** Drop `blob:` from `worker-src` after a test pass with the self-hosted pdf.js.
- **dev** BC jobs with mixed tax treatment need tax per line, not per document.
- **dev** CEC Table 14 (other occupancies) not built: no reliable source found.
- **dev** Client portal (homeowners/GCs view, sign and pay) once integrations are live.
- **dev** QuickBooks Online two-way sync: being built from [the contract](integrations/quickbooks.md) (see "QuickBooks Online" below). The CSV export at `#/import/export` stays for Starter (formats in `docs/code/imports.md`).
- **dev** Print the company logo (`settings.company.logo`, set in Settings and onboarding) on estimates and invoices (`js/lib/doc-view.js`).
- **dev** Imports: undo only on the device that ran it (batches in local meta); a server-side import job for files over 20,000 rows; VERIFY QuickBooks export headers and CA tax code names with a real QuickBooks file.
- **dev** Notifications: jobs assigned, time to approve and expiring items are worked out on each device; move them server-side (notify() on job/time writes) so the daily email includes them.
- **dev** Production nginx: serve `site/` (pricing, Enterprise form) on the marketing domain once it's confirmed, and the status page on `status.` (today it returns the status JSON).
- **dev** Production nginx: serve `site/` (pricing, Enterprise form, sign-up, terms, privacy) on the marketing domain once it's confirmed, with `location = /signup { return 302 /site/signup.html$is_args$args; }` (or a rewrite), and set `SIGNUP_PAGE_URL`; and the status page on `status.` (today it returns the status JSON).
- **dev** Sign-up: the new company's Settings start with the app defaults (province ON), not the province chosen at sign-up; seed `settings.company` (name, province) when the company is created. The welcome link is web-only (`session.js` does not ask for a bearer token on it in the iOS app).
- **dev** Google/Microsoft sign-in in the iOS app (hidden there today): native OIDC through `ASWebAuthenticationSession` with PKCE, and a server endpoint that returns a bearer session instead of a cookie.

## Requested next (Kelvin and Travis, 2026-10-20)

- **dev** Permits on new jobs: "Does this job need a permit?" when a job is created; create the permit (authority by province, e.g. Manitoba Hydro), list the inspections it needs (rough-in, service, final), remind when each is due, and open the authority's online portal in one tap. No public booking API is known for Manitoba Hydro, so booking stays a person's click: VERIFY.
- **dev** Trailer and van layout maps: draw shelves and bins; each price-book item lives in a bin; "where is it?" search; counts per bin feed inventory.
- **dev** Tool tracking: QR/NFC tags first (Web NFC on Android, CoreNFC in the iOS app), check-out/check-in by person and job, overdue returns. Fixed RFID gate readers on trailers need hardware choice and an integration: research.
- **K + dev** Accounting to replace QuickBooks (Kelvin and Travis want Sage-level): phase it. 1) job costing and supplier bills (AP) with receipt capture, 2) bank feeds and reconciliation, general ledger and financial statements, 3) payroll through a Canadian payroll provider integration (Wagepoint/Payworks) rather than computing CRA source deductions ourselves, with a CPA advising on the ledger design.
- **dev** Canvas tool polish (precision, selection, eraser, lasso, undo) after the pen-dropout fix.

- **dev** Module switches / T&M / material requests follow-ups: email the material list through the company's own email integration (today the platform outbox); pick up a changed send time immediately (the worker re-reads it hourly); a "turned off" note in Help search results; seed `settings` (modules, province) server-side when a company is created; per-employee bill rates in Employees (`billRateCents` is read but has no field yet); T&M progress invoices for change orders.
- **K** Material requests: who in the office gets the bell (owner, admin, office today), and whether foremen should too.

## GPS time tracking (2026-10-20)

- **K** Email NRCan (geo@nrcan-rncan.gc.ca) for a written OK to use the Geolocator in a commercial SaaS; until then "Find address" is VERIFY (the pin drop needs nothing).
- **K** App Privacy answers in App Store Connect: precise location, linked to the user, app functionality, before the next TestFlight build.
- **legal** Counsel to confirm the consent model by province (may an employer require location on the clock?) and the notice wording.
- **dev** Try the geofence plugin on an iPhone: permission prompts, background relaunch, force-quit, reboot, battery over a day.
- **dev** Wagepoint: check "Fill my Wagepoint template" against a real downloaded template (income-code header names).
- **dev** QuickBooks Online (Canada) has no hours import: approved time goes through the API as TimeActivity with the QuickBooks sync (contract 4.11); VERIFY that Canadian payroll reads it (contract 11.4 item 7).
- **dev** Overtime cases not automated: SK holiday weeks (32 h) and 10-hour-day schedules, NS construction (110 h per 2 weeks) and apprentices, Ontario averaging.
- **dev** A shift past midnight counts on the day it started; split it if a province or agreement needs that.
- **dev** Flag implausible fixes (accuracy exactly 0 m, impossible speed) as possible spoofing (TM-LOC-04).

## QuickBooks Online (2026-10-20)

Contract: [docs/integrations/quickbooks.md](integrations/quickbooks.md). Support: [runbooks/quickbooks-support.md](runbooks/quickbooks-support.md).

- **K** The checklist in contract section 1.3: Intuit developer account and the **Fishtape** app (accounting scope only), a Canadian sandbox company (Plus), development redirect URI and webhook on staging, the four `QBO_*` values on staging with `set-env.sh` (after W1 merges), TG Electrical's QuickBooks settings (custom transaction numbers on, the GST/PST MB code at 5% + 7%, Projects, Payroll, Time), and later the production app details and the App Assessment Questionnaire.
- **K** The open questions in contract section 13. The code uses the stated defaults until they are answered (for example: two-step sign-in for every QuickBooks change, sub-customers for jobs, Stripe through a "Stripe" clearing account, a practice week in shadow mode, the assistant may read synced records with disclosure).
- **K** Hosting region of staging (DreamHost, probably US) and of production before production Intuit keys go anywhere; record it in [vendor-management.md](compliance/vendor-management.md#intuit-quickbooks-online).
- **K** Intuit's annual security review and a vulnerability scan within 2 weeks when Intuit asks: add both to the compliance calendar once the app is approved.
- **K** Whether to buy Intuit's Silver tier when HQ warns at 70% of the 500,000 monthly reads (free Builder tier until then; about CA$425 a month, VERIFY).
- **legal** TG's accountant: Manitoba RST on supplier bills not recoverable (default), the tax code for Stripe fees (default none), the QuickBooks codes for each "no tax" reason, the Stripe clearing account and the Stripe cutover date, payroll hours from Fishtape or QuickBooks Time, the pay-period lock.
- **legal** Terms and privacy policy (`site/terms.html`, `site/privacy.html`): name Intuit QuickBooks as a service the customer connects, disclose that Fishtape's assistant reads records that sync with QuickBooks, carry "QuickBooks and Intuit are trademarks of Intuit Inc.", and be on a public URL (Intuit needs both URLs).
- **dev** Run the sandbox VERIFY list (contract 11.4) and record the answers in the contract before go-live.
- **dev** Client portal rule (contract 1.2, TM-QBO-07): before any portal route serves records, it must hide documents in `needs_review` and documents created by the QuickBooks pull until an office user releases them.
- **dev** Companies already connected to Stripe must add the read permissions (PaymentIntents, Charges, Balance, Payouts) to their restricted key and the `payout.*` events to their webhook (`electrical-app/guides/stripe.md`), or fees and payouts never reach QuickBooks. Show a warning on the Stripe card when a fee read is refused (today the card goes to "error").
- **dev** Stripe refunds and disputes are not booked: a payout that holds one goes to review and the bookkeeper enters it by hand (contract 4.9).
- **dev** `stripe_payouts` has no purge before the tenant is deleted (kept 7 years like payments); add one when payments get a retention rule.

## Process

- Cloud agents push straight to the deploy branch. Agents should work on their own branches and open pull requests; the deploy branch should only move by merge.
