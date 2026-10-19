# Recon map: Concepts (iPadOS / iOS, also Android and Windows)

Scope: the canvas experience (infinite canvas, vector pen tools, tool wheel,
layers, precision guides, object library, image/PDF import, gallery) rebuilt
as the **Plans & Drawings** workspace of an electrical-contractor CRM/ERP. The
rest of the ERP (CRM, jobs, estimating, invoicing, inventory, people, time
clock, SOPs, sequences, compliance, security audits, calculators) is not in
Concepts. Those modules get the same visual language: floating pill toolbars,
paper-like surfaces, a radial tool wheel.
For: Kelbe, an electrical contractor, as one place to run the business.
Date: 2026-10-18

Clean-room note: this map comes from public descriptions of how Concepts
behaves (the App Store listing, the public user manual, public walkthrough
videos). It contains no code, assets, icons or copy from Concepts. The clone is
rebranded **Kelbe Circuit**.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | user manual | https://concepts.app/en/manual/ | tools, wheel, layers, precision, gallery |
| 2 | App Store listing | https://apps.apple.com/app/concepts/id936834217 | key screens, pitch |
| 3 | marketing site | https://concepts.app | positioning: "infinite, flexible, vector sketching" |
| 4 | public walkthrough videos | YouTube, "Concepts app tutorial" | tool wheel and nudge/select flows |

## Core loop

Open a drawing from the gallery, sketch and mark up on an infinite vector
canvas with pressure-sensitive tools picked from a floating wheel, then
export or share it. In the clone the loop is: **open a job, open its plan,
mark it up with electrical symbols and wiring, and turn the takeoff into a
quote.**

## Screens

### From Concepts (canvas workspace)

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Gallery | app launch | grid of drawings grouped in projects | drawing card, project folder, new-drawing tile, search | empty, filled |
| S02 | Canvas | tap a drawing | draw on an infinite canvas | tool wheel, brush bar, color picker, layers panel, zoom readout, undo/redo | empty, filled, zoomed |
| S03 | Tool wheel | floating circle on S02 | pick tool, undo/redo, color, size, opacity | radial menu | collapsed, expanded |
| S04 | Layers panel | layers button on S02 | stack, hide, lock, opacity, reorder | layer row | one layer, many layers |
| S05 | Color picker | color swatch on S02 | pick a color: wheel, swatches, hex | swatch grid, HSL sliders | — |
| S06 | Precision / grid settings | precision button on S02 | paper type (none, dots, grid, isometric), snapping, measurement scale | segmented controls | — |
| S07 | Object library | objects button on S02 | drag ready-made objects onto the canvas | object tile, category tabs | — |
| S08 | Select / nudge | selection tool on S02 | move, scale, rotate, duplicate, delete strokes | selection box, handles, context bar | none selected, selected |
| S09 | Import | import button on S02 | bring in an image or PDF as an underlay | file picker | loading, error |
| S10 | Export / share | share button on S02 | PNG, SVG, PDF export | export sheet | — |

### Added for the ERP (not in Concepts, same visual system)

| ID | screen | purpose |
| --- | --- | --- |
| S11 | Dashboard | today's jobs, clocked-in crew, overdue invoices, pipeline value, expiring certs |
| S12 | Clients | client list and detail (sites, contacts, jobs, invoices) |
| S13 | Leads & funnels | kanban pipeline by stage, conversion per stage |
| S14 | Sequences | automated follow-up sequences (email/SMS/task steps) and enrolments |
| S15 | Jobs | job list, job detail (scope, crew, schedule, drawings, materials, change orders) |
| S16 | Schedule | week board of crew per day |
| S17 | Estimates | estimate builder from price book, assemblies, labour, markup, takeoff import |
| S18 | Invoices & payments | invoices from estimates/jobs, payments, ageing |
| S19 | Inventory | price book, stock per location (shop/van), stock moves, reorder points |
| S20 | Employees | staff, roles, licence numbers, rates |
| S21 | Time clock | clock in/out against a job, timesheets, approval |
| S22 | SOPs | step-by-step procedures, versioned, acknowledged by staff |
| S23 | Compliance | permits, inspections, certificates and licences with expiry, code checklists |
| S24 | Security audit | role/permission review, activity log, audit checklists |
| S25 | Calculators | load calc, voltage drop, conductor size, conduit fill, Ohm's law |
| S26 | Panel schedules | panel, breakers, circuits, phase balance |
| S27 | Settings | company, tax, numbering, units, theme, backup/restore |

## Flows

```
F01 Mark up a plan (core loop)
    S15 job -> S01 job drawings -> S09 import plan PDF/image -> S02 canvas
    -> S07 drop receptacles/switches/lights -> wire tool -> S04 layers per system
    happy path clicks: 8
    edge: huge image, no pencil (finger draws), zoomed far out, undo after layer delete

F02 Takeoff to quote
    S02 canvas -> "count symbols" -> S17 estimate prefilled with counts x price book
    -> send -> client accepts -> S15 job created
    happy path clicks: 5

F03 Lead to cash
    S13 new lead -> S14 enrol in sequence -> S17 estimate -> accept -> S15 job
    -> S16 schedule crew -> S21 crew clocks time -> S18 invoice -> payment

F04 Crew day
    S21 clock in on job -> S22 read SOP -> S02 mark up as-built -> S23 inspection result -> clock out

F05 Compliance check
    S11 expiring cert warning -> S23 renew -> S24 audit log shows the change
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Tool wheel | canvas tools, app navigation | collapsed, open, dragging | S02, all |
| Pill toolbar | floating top, floating side | default, active tool | S02, all |
| Brush slot | pen, pencil, marker, brush, highlighter, eraser | active, size/opacity preview | S02 |
| Card | drawing thumb, entity card, stat tile | hover, selected | S01, S11, lists |
| Sheet / modal | side sheet, centered dialog | open, closed | all |
| Table | sortable list | empty, filled | all lists |
| Kanban column | pipeline stage | empty, filled, drag-over | S13 |
| Form field | text, number, money, select, date, textarea | focus, error, disabled | all |
| Toast | info, success, error | — | all |
| Badge | status colors | — | all |

## Inferred data model

```
Drawing   id, name, project/job_id, layers[{id,name,visible,locked,opacity}],
          strokes[{id,layer,tool,color,size,opacity,points[[x,y,pressure]]}],
          objects[{id,layer,symbol,x,y,rotation,scale}], underlay(image dataURL),
          paper (none|dots|grid|iso), scale (px per ft), view {x,y,zoom}
          evidence: manual "layers", "precision", "import"; confidence: high
```

Rest of the ERP model: see `architecture.md`.

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Concepts' brush engine textures, its COPIC color license, its object
  library content and its Pro subscription / store: we draw our own
  electrical symbol set.
- Cloud sync across devices (needs a backend; architecture plans for it).
- Real email/SMS sending and card payments (need provider keys; stubbed
  behind an outbox and a "record payment" flow).

## Size

Screens 27, flows 5, entities 20. Hard parts: the vector canvas with
pressure, pan/zoom and hit-testing; offline storage of large plan images;
correct electrical calculations. Size: L. This build delivers the vertical
slice plus every module at working-but-first-version depth.
