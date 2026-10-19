# Kelbe Circuit

An all-in-one CRM/ERP for an electrical contracting business, built around a
Concepts-style infinite canvas for plans, drawings and markups.

Built with the [replica skill](https://github.com/Jakeschincariol/replica-skill)
workflow (installed in `.claude/skills/`). The recon map, feature matrix,
architecture and design tokens are in [`../replica/`](../replica/). The canvas
rebuilds how Concepts *works* (infinite paper, pressure-sensitive vector pens,
a floating tool wheel, layers, precision paper, an object library, image and PDF
underlays). It is written from scratch and copies none of Concepts' code, icons,
copy or brand.

## What's in it

| area | screens |
| --- | --- |
| Home | Dashboard: pipeline, jobs, money owed, who's on the clock, alerts, today's crew |
| Sales | Clients · Leads & funnels (kanban + conversion funnel) · Sequences (automated follow-ups + outbox) |
| Work | Jobs (change orders, costing) · Schedule (crew week board) · Plans & drawings (canvas, symbols, takeoff) |
| Money | Estimates (price book, takeoff from drawings) · Invoices & payments (ageing) · Inventory (price book, stock by van/shop, moves) |
| People | Employees (roles, licences, PINs) · Time clock (clock in/out, breaks, timesheets, approval, CSV) |
| Field | SOPs (versioned, acknowledged) · Compliance (permits, inspections, licences/certs, NEC checklists) · Calculators · Panel schedules |
| Admin | Security audit (access review, activity log, audits) · Settings (company, defaults, backup/restore) |

The round **＋** button (bottom right) opens the quick wheel: clock in, draw,
new lead, quote, job, invoice, calculators, SOPs.

## Run it

No build step. Serve the folder with any static server:

```bash
cd electrical-app
npx http-server -p 8080 -c-1     # or: python3 -m http.server 8080
```

Open http://localhost:8080. Demo data loads on first launch. Remove it under
Settings → Data.

**On iPad or iPhone:** host the folder over HTTPS (GitHub Pages, Netlify, or your
own site). Open it in Safari, then Share → **Add to Home Screen**. It runs
full-screen and offline, and works with Apple Pencil pressure.

## How data is stored

Everything lives on the device in IndexedDB (`js/store.js`). That makes it
offline-first and private, but **each device has its own data**. Export a backup
from Settings → Data regularly. Safari can clear site data from installed web
apps that go unused for a long time.

`store.js` has the same function signatures as a hosted database layer. The
plan for cloud sync, real logins, and email/SMS/payments is in
`../replica/architecture.md`. Moving to it changes no screen code.

## Tests

```bash
node --test electrical-app/tests/
```

## Safety note

The calculators follow NEC 2023 tables. They are estimating aids. Check every
design against the code your inspector enforces, including local amendments.
