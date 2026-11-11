# T6 — HQ-only API mode (hq-api must not mount tenant routes)

**Closes toward green:** ACC-06 (`partial`).
**Lane:** B — **security-sensitive routing change; review carefully before merge.**

## Why it isn't green

ACC-06 (database role separation) is done in the compose files — only `hq-api` gets
`HQ_DATABASE_URL`, and nginx sends it only sign-in/HQ/health routes. The remaining gap the control
names: **"an HQ-only mode in the API (no tenant routes in hq-api)"** — i.e. the HQ API process should
not even register tenant data routes, so a routing mistake can't expose them on the HQ host.

## Deliverable

1. Read how the API process boots and registers routes (`server/src/app.js` and the route
   registration it calls). Find how it decides HQ vs tenant surface today (env flag? separate entry?).
2. Add an explicit **role/mode** for the process (e.g. `FISHTAPE_API_MODE=hq|app|both`, default
   preserving current behaviour) so that in `hq` mode the tenant/REST/sync routes are **not
   registered at all** — not merely 404'd by nginx. HQ, auth/sign-in, and health routes stay.
3. Add a server test asserting that in `hq` mode a representative tenant route (e.g. a collection GET)
   is **not registered** (404 from the app itself, nginx out of the picture), and in `app` mode it is.
   Put it alongside `server/test/hq.test.js` or a new `server/test/api-mode.test.js`.
4. Wire the compose files so `hq-api` runs in `hq` mode (defence in depth with the existing nginx
   routing — keep both).

## Acceptance

- `cd server && node scripts/with-embedded-pg.js node --test test/api-mode.test.js` (and the existing
  hq/isolation suites) pass.
- Default behaviour unchanged when the mode is unset, so nothing else breaks.
- Update ACC-06 `notes:`/`status:` to reflect the HQ-only mode now exists; `implemented` once the test
  proves tenant routes are absent in `hq` mode **and** the production host item is separately tracked
  (host build is Lane C).

## Do not

- Do not weaken the existing nginx 404 routing — this is an *additional* layer, not a replacement.
- Flag for Kelvin's review before merge: this changes how the process mounts routes.
