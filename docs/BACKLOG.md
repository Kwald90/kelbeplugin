# Backlog

Open items raised while building. Newest decisions live in [BUILD-PLAN.md](BUILD-PLAN.md).
Tag: **K** needs Kelvin, **legal** needs a lawyer or accountant, **dev** is code.

## Needs Kelvin

- **K** App Store Connect: create the app record for bundle ID `com.fishtapehq.app` (registered 2026-10-19, team 9C68LPL6JA) in the web UI (Apple has no API for that), then TestFlight. Steps: `docs/mobile/README.md`.
- **K** Production VPS at dotmoose: host, SSH access, OS, data-centre country, disk encryption.
- **K** Domain: confirm the spelling registered (fishtapehq.com vs fishtapewq.com) and point DNS (`app.`, `hq.`, `status.`).
- **K** Real tier prices (placeholders in `electrical-app/js/plans.js`), the failed-payment grace period (7 days now), the trial length (30 days now, `TRIAL_DAYS`) and the deleted-company grace (30 days now).
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
- **legal** Privacy policy and terms (PIPEDA, provincial laws), and the export-compliance answer for the App Store.

## Code

- **dev** Server-side sequence runner: steps after day 0 are only queued when someone opens Sequences.
- **dev** Sequences screen still says providers aren't connected and hides failed outbox items unless "Show sent" is on.
- **dev** Facebook leads after a downgrade get a 403 and are lost once Meta stops retrying: store them and show them as locked instead.
- **dev** Stripe refunds don't sync back; emailed invoices carry a summary and pay link but no PDF attachment.
- **dev** Settings → Data: when signed in, "Wipe" means "download again" and restoring a backup is refused; reword the card.
- **dev** Security screen shows only this device's log when signed in; read `/api/v1/auditLog`.
- **dev** A dev script that serves the PWA with an `/api/` proxy to a local API (the E2E driver has one).
- **dev** Photos and drawing underlays as data URLs: move to object storage. A dense 20-sheet plan set is about 140 MB held in memory and synced as whole records (each sheet up to ~7 MB).
- **dev** Plan sets: the wire-runs plan picker still copies full drawings; job and client tabs list sheets one by one instead of grouped; read sheet numbers from the title block when a PDF has no page labels.
- **dev** Server hardening from the platform review: HQ-only mode for `hq-api`, `__Host-` session cookie, decrypt-only previous master key for rotation, a CSP report endpoint, a full resync after a database restore.
- **dev** `docs/architecture/api.md`: add the integrations, webhooks, `/me` and pay-link endpoints.
- **dev** Drop `blob:` from `worker-src` after a test pass with the self-hosted pdf.js.
- **dev** BC jobs with mixed tax treatment need tax per line, not per document.
- **dev** CEC Table 14 (other occupancies) not built: no reliable source found.
- **dev** Client portal (homeowners/GCs view, sign and pay) once integrations are live.
- **dev** Production nginx: serve `site/` (pricing, Enterprise form) on the marketing domain once it's confirmed, and the status page on `status.` (today it returns the status JSON).
- **dev** Google/Microsoft sign-in in the iOS app (hidden there today): native OIDC through `ASWebAuthenticationSession` with PKCE, and a server endpoint that returns a bearer session instead of a cookie.
- **dev** A Settings screen for company API keys (create, scope, revoke). Today it's `POST /api/v1/api-keys` only, and the MCP guide points there.

## Process

- Cloud agents push straight to the deploy branch. Agents should work on their own branches and open pull requests; the deploy branch should only move by merge.
