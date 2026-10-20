# Architecture: Kelbe Circuit (an electrical CRM/ERP with a canvas rebuilt from Concepts' core features)

## Stack

| layer | choice | why |
| --- | --- | --- |
| web | Vanilla ES modules, no build step, in `electrical-app/` | runs from any static host (or the WordPress plugin) with nothing to compile; easy to open on an iPad |
| app shell | Installable PWA (manifest + service worker) | "Add to Home Screen" on iPad/iPhone, works offline on site |
| canvas | HTML `<canvas>` 2D with Pointer Events (pressure, pen vs touch) | Apple Pencil pressure works in Safari; no dependency |
| database | IndexedDB, through `js/store.js` | large plan images do not fit in localStorage; offline first |
| auth | local user switcher + role permissions (`js/auth.js`) | one device per crew member now; real auth comes with a backend |
| payments / email / SMS | an outbox collection: sends are queued, not delivered | needs provider keys; swap in Stripe / Postmark / Twilio later |
| hosting | static (GitHub Pages, Netlify, or served by the WP plugin) | — |

Upgrade path: `store.js` has the same function signatures a Supabase data
layer would have (`list/get/add/update/remove/on`). Swapping it for a remote
one changes no screen code.

## Data contract (every module must follow this)

All records: `{ id: string, createdAt: ISO string, updatedAt: ISO string, ...fields }`.
Money is **integer cents**. Dates are ISO strings (`YYYY-MM-DD` for days,
full ISO for timestamps). IDs come from `store.add`.

| collection | fields |
| --- | --- |
| `clients` | name, type (residential/commercial/industrial), email, phone, address, notes, tags[] |
| `leads` | title, clientId?, contactName, email, phone, source, stage (new/contacted/site-visit/quoted/won/lost), valueCents, notes, nextActionAt |
| `sequences` | name, active, steps[{ dayOffset, channel (email/sms/task), subject, body }] |
| `enrolments` | sequenceId, leadId, startedAt, stepIndex, status (active/done/stopped) |
| `outbox` | channel, to, subject, body, relatedId, status (queued/sent), dueAt |
| `jobs` | number, title, clientId, address, status (lead/scheduled/in-progress/on-hold/complete/invoiced), startDate, endDate, crewIds[], estimateId?, description, changeOrders[{ id, title, amountCents, status (pending/approved/rejected), date }] |
| `schedule` | jobId, employeeId, date, hours, note |
| `estimates` | number, clientId, jobId?, title, status (draft/sent/accepted/declined), lines[{ itemId?, description, qty, unitCents, labourHours, kind (material/labour/other) }], labourRateCents, markupPct, taxPct, notes, validUntil |
| `invoices` | number, clientId, jobId?, estimateId?, status (draft/sent/partial/paid/void), lines (same shape as estimates), taxPct, issueDate, dueDate, notes |
| `payments` | invoiceId, amountCents, date, method (cash/check/card/transfer), reference |
| `items` | sku, name, category, unit, costCents, priceCents, labourHours, reorderPoint, stock{ [locationId]: qty }, symbol? (canvas symbol id for takeoff) |
| `locations` | name, kind (shop/van/site) |
| `stockMoves` | itemId, fromLocationId?, toLocationId?, qty, jobId?, date, note |
| `employees` | name, role (owner/admin/office/foreman/electrician/apprentice), email, phone, licenceNo, licenceExpiry, rateCents, color, active, pin |
| `timeEntries` | employeeId, jobId?, clockIn (ISO), clockOut (ISO or null), breakMins, note, approved |
| `drawings` | name, jobId?, paper (none/dots/grid/iso), scale (px per foot), layers[], strokes[], objects[], texts[], underlay (dataURL or null), view{ x, y, zoom }, thumb (dataURL) |
| `sops` | title, category, version, steps[{ text }], requiredRoles[], acks[{ employeeId, version, at }] |
| `permits` | jobId, number, authority, type, status (applied/issued/closed), appliedDate, issuedDate, expiryDate |
| `inspections` | jobId, permitId?, type (rough-in/service/final/other), date, result (scheduled/passed/failed/partial), inspector, notes |
| `certifications` | employeeId?, name, issuer, number, expiry (company-wide if no employeeId) |
| `checklists` | kind (code/security), title, jobId?, items[{ text, ref, status (open/pass/fail/na), note }], completedAt |
| `panels` | jobId?, name, voltage (120/240 1ph, 208/120 3ph, 480/277 3ph), mainAmps, busAmps, circuits[{ slot, description, amps, poles, loadVA, phase }] |
| `workPlans` | jobId, name, startDate, endDate, skipWeekends, holidays[], dayHours, crewIds[], phases[{ id, name, order }], published{ [day]: { at, by } }, status (active/paused/complete/archived) |
| `workTasks` | one worker, one day: planId?, jobId?, phaseId, phaseName, groupId, title, description, taskType, date, employeeId, estHours, qty, unit, priority, requiresPhoto, minPhotos, dependsOn[], link?, status (draft/todo/in-progress/blocked/done), publishedAt, ackAt, startedAt, completedAt, actualHours, qtyDone, note, blocks[], photos[], reopens[], evidenceWaived?, progressAt (full list in docs/BUILD-PLAN.md) |
| `taskTemplates` | name, title, description, taskType, unit, qty, estHours, ratePerHour, requiresPhoto, minPhotos, priority |
| `huddles` | date, planIds[], jobIds[], startedAt, endedAt, ledBy, attendees[{ employeeId, ackAt, by }] |
| `auditLog` | at, userId, action, collection, recordId, summary (written by `store` automatically) |
| `settings` | single record id `settings`: company{ name, phone, email, address, licenceNo }, taxPct, labourRateCents, markupPct, units, currency, nextNumbers{ job, estimate, invoice } |

## Module contract

Each screen is a module in `electrical-app/js/modules/<id>.js`:

```js
export default {
  id: 'jobs',            // route: #/jobs, #/jobs/<sub...>
  title: 'Jobs',
  icon: 'briefcase',     // name in js/icons.js
  group: 'work',         // nav group: home | sales | work | money | people | field | admin
  perm: 'jobs',          // permission key checked with auth.can(perm)
  render(root, ctx) {}   // ctx = { params: [...path parts after id], query, store, ui, auth, nav(path) }
                         // may return a cleanup function
};
```

Modules only talk to data through `store` and to each other through routes
(`ctx.nav('#/estimates/new?jobId=…')`). The registry is `js/modules/index.js`.

## Permissions

Roles to permission keys (`js/auth.js`): owner and admin have everything;
office has everything except `security` and `settings`; foreman has jobs,
schedule, drawings, time, sops, compliance, inventory, calcs, workplan, kpis; electrician and
apprentice have drawings, time (own), sops, calcs, jobs (read), today (own published
tasks, progress only). Every write goes to `auditLog` with the current user.

## The parts that bite

- canvas performance: strokes rendered from vector data; the committed
  layer is cached to an offscreen bitmap and only the live stroke redraws.
- big underlays: images are downscaled to ≤ 4096 px before storing; PDFs are
  rasterised page by page with pdf.js loaded from a CDN only when needed.
- time zones: the time clock stores full ISO timestamps; days are local.
- money rounding: all sums in integer cents, tax rounded once per document.
- calculations: tables follow NEC 2023 (310.16 ampacity, Chapter 9 Table 4/5
  conduit fill, Table 8 conductor resistance). They are for estimating;
  a licensed electrician must check the design.
- storage loss: Safari can evict site data, so Settings has backup/restore
  to a JSON file and asks for persistent storage.

## Build order

1. Vertical slice: shell + store + gallery + canvas (S01–S08) + jobs (S15).
2. Must-haves by area: CRM, estimates/invoices, inventory, people/time,
   SOPs, compliance, security, calculators.
3. Should-haves: sequences, change orders, panel schedules, SVG export.
