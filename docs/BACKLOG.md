# Backlog

Open items raised while building. Newest decisions live in [BUILD-PLAN.md](BUILD-PLAN.md).
Tag: **K** needs Kelvin, **legal** needs a lawyer or accountant, **dev** is code.

## Needs Kelvin

- **K** App Store Connect Issuer ID and Apple Team ID (bundle ID `com.fishtapehq.app`, signing, TestFlight). Steps: `docs/mobile/README.md`.
- **K** Production VPS at dotmoose: host, SSH access, OS, data-centre country, disk encryption.
- **K** Domain: confirm the spelling registered (fishtapehq.com vs fishtapewq.com) and point DNS (`app.`, `hq.`, `status.`).
- **K** Real tier prices (placeholders in `electrical-app/js/plans.js`) and the failed-payment grace period.
- **K** TG Electrical's province, GST/HST number and ECRA/ESA numbers.
- **K** Which benders the crew uses (make, sizes, hydraulic shoes) and the box-offset rule used in the field.
- **K** Buy CSA C22.1:24 to clear the `VERIFY` items (`docs/code/verify.md`, `docs/field/*.md`).
- **K** "Ask us to set this up": real address (placeholder `setup@fishtapehq.com`) and price.
- **K** "FB Muse": Facebook Lead Ads (built) or Meta's Muse AI model?
- **K** GitHub: make `claude/electrical-concept-app-h4qz12` the default branch, turn on Dependabot alerts, branch protection ("CI passed"), private vulnerability reporting, and the `staging`/`production` environments with secrets (`docs/runbooks/deploy-staging.md`).
- **K** Offsite backup target in Canada, an uptime monitor, a backup heartbeat URL.
- **K** Move the backup private key (`C:\Users\Kelvin\.fishtape-keys\fishtape-staging-backup.key`) into the password manager and onto a USB stick.
- **K** Change the build Mac's password and turn on "Prevent automatic sleeping when the display is off".

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
- **dev** Photos and drawing underlays as data URLs: move to object storage.
- **dev** Server hardening from the platform review: HQ-only mode for `hq-api`, `__Host-` session cookie, decrypt-only previous master key for rotation, a CSP report endpoint, a full resync after a database restore.
- **dev** `docs/architecture/api.md`: add the integrations, webhooks, `/me` and pay-link endpoints.
- **dev** Drop `blob:` from `worker-src` after a test pass with the self-hosted pdf.js.
- **dev** BC jobs with mixed tax treatment need tax per line, not per document.
- **dev** CEC Table 14 (other occupancies) not built: no reliable source found.
- **dev** Client portal (homeowners/GCs view, sign and pay) once integrations are live.

## Process

- Cloud agents push straight to the deploy branch. Agents should work on their own branches and open pull requests; the deploy branch should only move by merge.
