# Fishtape

An all-in-one CRM/ERP for electrical contractors, built for the Canadian
Electrical Code, around a Concepts-style infinite canvas for plans, drawings and
markups. Fishtape was first built as "Kelbe Circuit"; the name lives in
`js/brand.js`.

This folder is the installable web app (PWA). The API that adds accounts,
companies, sync and integrations is in [`../server/`](../server/). The overall
plan, decisions and contracts are in [`../docs/BUILD-PLAN.md`](../docs/BUILD-PLAN.md).

## What's in it

| area | screens |
| --- | --- |
| Home | Dashboard: pipeline, jobs, money owed, who's on the clock, alerts, today's crew |
| Sales | Clients · Leads & funnels (kanban + conversion funnel) · Sequences (automated follow-ups + outbox) |
| Work | Jobs (change orders, costing) · Schedule (crew week board) · Plans & drawings (canvas, symbols, takeoff, rooms with box auto-placement and CEC checks) · Wire runs (AR tape, trace on a plan, PDF) |
| Money | Estimates (price book, takeoff from drawings) · Invoices & payments (ageing, GST/HST/PST by province) · Inventory (price book, stock by van/shop, moves) |
| People | Employees (roles, licences, PINs) · Time clock (clock in/out, breaks, timesheets, approval, CSV) |
| Field | SOPs (versioned, acknowledged) · Compliance (permits, inspections, licences/certs, CEC checklists with provincial amendments) · Calculators (CEC 2024, NEC 2023 optional) · Pipe bending · Panel schedules (incl. 347/600 V) |
| Admin | Security audit (access review, activity log, audits) · Settings (company, province, code book, units, tax, placement defaults, backup/restore) |

The round **＋** button (bottom right) opens the quick wheel: clock in, draw,
new lead, quote, job, invoice, calculators, SOPs.

Each person picks metric or imperial on first launch. Lengths are stored in
metres and shown in their units (`js/lib/units.js`).

## Run it

No build step. Serve the folder with any static server:

```bash
cd electrical-app
python -m http.server 8080        # or: npx http-server -p 8080 -c-1
```

Open http://localhost:8080. Demo data loads on first launch. Remove it under
Settings → Data. The service worker caches files: after a change, hard-reload
(Ctrl+Shift+R).

**On iPad or iPhone:** open the HTTPS site in Safari, then Share → **Add to Home
Screen**. It runs full-screen and offline, and works with Apple Pencil pressure.
A native iOS app (needed for AR measuring on Apple devices) is being built in
[`../mobile/`](../mobile/).

## How data is stored

Today everything lives on the device in IndexedDB (`js/store.js`), so each
device has its own data; export a backup from Settings → Data. Sign-in and sync
with the API are being connected: `store.js` keeps the same synchronous
functions and a sync queue sends changes to the server, so screens don't
change.

## Tests

```bash
node --test electrical-app/tests/*.test.mjs
```

## Safety note

The calculators follow the CEC (CSA C22.1:24) by default, with NEC 2023 as an
option. Values that couldn't be confirmed against the 2024 code book are marked
`VERIFY` and listed in [`../docs/code/verify.md`](../docs/code/verify.md). They
are estimating aids: check every design against the code your inspector
enforces, including provincial amendments.
