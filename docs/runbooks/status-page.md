# Public status page

Use it when: something is down or slow and customers should know, you are planning maintenance,
the status page shows something odd, or you want to turn on email updates.

The public status page (https://status.fishtapehq.com, `site/status.html`) is for customers. It is
not the place for internal incident records: those go in HQ -> Compliance & security -> incidents
and in [incident-response.md](incident-response.md).

## What it shows

`GET /api/v1/public/status` (no sign-in, cached 30 seconds) feeds the page:

- **Components** and their status now: `app` (Web app), `api` (API and sync), `hq` (HQ console),
  `signin` (Sign-in), `email` (Email), `payments` (Payments). Each is `operational`, `degraded`,
  `outage` or `unknown`. A component that has not been checked for 20 minutes shows `unknown`:
  stale data never shows green.
- **Overall**: outage if a component is down or an active published incident has impact major;
  degraded if a component is degraded or an active incident is minor; maintenance while a
  maintenance window is under way; operational when every known component is fine; unknown when
  nothing is known.
- **90-day uptime** per component and day: (checks - outages) / checks, floored to two decimals
  (degraded counts as up). Days without checks have no figure.
- **Notices** HQ admins publish: active, upcoming maintenance, and the ones closed in the last 30 days.

## How components are measured

The worker runs the `status_probe` job every 5 minutes (each run queues the next; the hourly
housekeeping restarts the chain if it ever stops). Each run:

| component | check | result |
| --- | --- | --- |
| app | GET `PUBLIC_ORIGIN/` | 2xx operational, 503/429 degraded, else (or no answer in 5 s) outage |
| api | GET `PUBLIC_ORIGIN/api/readyz` | 200 operational, 503 (not ready) degraded, else outage |
| hq | GET `<HQ_PUBLIC_URL origin>/api/healthz` (staging: `PUBLIC_ORIGIN/api/healthz`) | as app |
| signin | GET `PUBLIC_ORIGIN/api/v1/auth/providers` | as app |
| email | Fishtape's own mail in `email_outbox` (company mail is not counted), last hour | unknown if no provider key + `EMAIL_FROM`; outage if 3+ failures and failures >= sends; degraded if 10%+ failed or mail has waited over 15 minutes; else operational (also with no traffic) |
| payments | one read-only call to Fishtape's own Stripe account (`STRIPE_SECRET_KEY`) | operational, outage on an error or timeout, unknown without a key |

The host's own view is folded in: `deploy/<env>/host-status.sh` (every 15 minutes, systemd timer)
writes `probes` into `host-status.json` (the HTTP code of each public URL from the host, 0 = no
answer). While that file is under 20 minutes old, a failing host probe makes that component worse
for the run (never better). Production probes app.fishtapehq.com, its `/api/readyz`,
hq.fishtapehq.com/api/healthz, fishtapehq.com and status.fishtapehq.com; staging probes
tgelectrical.truecollarbuilt.com, its `/api/readyz` and `/site/index.html`.

Each run adds one check per component with a known status to `status_daily` (per UTC day) and
updates `status_latest` (`changed_at` moves only when the status changes). Rows older than
**120 days** are deleted, and so are subscriptions nobody confirmed within 7 days.

### Settings (environment)

| variable | default | what |
| --- | --- | --- |
| `STATUS_PROBES` | the URLs above | `off` turns the network probes off (local, tests); or `app=https://…,api=https://…/api/readyz` replaces some URLs |
| `HOST_STATUS_FILE` | `/run/fishtape/status/host-status.json` when it exists | the host-status file (set in both docker-compose files); `off` ignores it |
| `STATUS_PUBLIC_URL` | `PUBLIC_ORIGIN/site/status.html` | the public page, for links in emails (production: `https://status.fishtapehq.com/`) |

If the worker container cannot reach the public URLs (for example hairpin NAT on the host), the
web components show outage while customers are fine. Check with
`dc exec worker node -e "fetch(process.env.PUBLIC_ORIGIN + '/api/readyz').then(r => console.log(r.status))"`;
if that fails but the site works from outside, set `STATUS_PROBES=off` (the host-status probes
still report) or point `STATUS_PROBES` at URLs the container can reach, and restart the worker.

## Post a notice (HQ admins)

1. HQ -> **Status notices** -> **New notice**.
2. Incident or planned maintenance; a short public title; impact (major shows the whole page as an
   outage, minor as degraded); the affected components; for maintenance the window.
3. A first update in plain text (what people notice, what to do, when you will update next). No
   internal detail, customer names or blame: it is public.
4. Tick **Publish now**, or save a draft and publish from the notice later. Drafts are never public.
5. As things move: open the notice -> **Post update** (identified, monitoring, resolved; for
   maintenance in progress, completed). Resolved / completed closes it; it stays under "recent"
   for 30 days.
6. Delete only mistakes. Every change is in the audit log (`hq.status_*`), without the text.

Other HQ staff see the page read-only.

## Email subscriptions (off by default)

HQ -> Status notices -> **Email subscriptions** -> Turn on. The page then offers "Get updates by
email": double opt-in (an email with a link, `#confirm=<token>` in the fragment, valid 7 days;
nothing else is sent until it is confirmed), rate-limited per IP, honeypot field, the same answer
whether or not an address is known.

Notices go out only when you tick **Email subscribers** on a publish or an update, to confirmed
subscribers (up to 5,000 per notice), through the platform outbox. Each email says who sent it,
why the person gets it, and has a one-click unsubscribe link (`#unsubscribe=<token>`).

CASL: these are service messages people asked for, but treat them like commercial email anyway:
never add addresses yourself, keep the sender identification and unsubscribe, and honour
unsubscribes at once (they delete the row). VERIFY with counsel whether the footer also needs
Fishtape's mailing address; the support email from HQ -> Settings is shown today.

## Checks

- `curl -si https://fishtapehq.com/api/v1/public/status | head -c 600` (staging:
  `https://tgelectrical.truecollarbuilt.com/api/v1/public/status`): 200, `cache-control: public, max-age=30`.
- HQ -> Status notices shows each component's last check; anything over 20 minutes old means the
  worker or its `status_probe` chain stopped: `dc logs --since 30m worker | grep status_probe`.
- `cat /var/lib/fishtape-<env>/status/host-status.json` shows the host probes.
