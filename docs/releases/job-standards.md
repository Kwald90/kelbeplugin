# Job standards (region-specific work-type playbooks)

Status: built (branch claude/electrical-concept-app-h4qz12). Extends SOPs; existing safety SOPs are untouched.

## 0. Idea

Kelvin: "SOPs, supplies used and job standards should be region specific. An RTM hookup needs an
underground service disconnect, these breakers, these connections, this type of wire; so when
another job comes up you know what to expect. Hot tubs, kitchens, panel changes, lighting - small
jobs to huge condos. Look up your job, have your material list, good to go. Manitoba may have
requirements other regions don't."

A **job standard is an SOP with the new fields filled in.** No separate collection. It bundles:
materials/BOM, breakers & panel, wire/connection specs, SOP steps + a task list, and region tags.
**Applying** a standard to a job seeds work tasks, a material request/BOM, the SOP link, optionally
a panel, and a priced **draft** estimate. Offline-first: applying writes records via
`store.add/update` so everything syncs per company. Crew never see money.

## 1. sops.json additions

All OPTIONAL and additive (`additionalProperties` is already `true`). An SOP with none of these set
behaves exactly as today. A standard is any SOP where `isStandard === true` **or** `jobType` is a
non-empty string. Keep `steps`, `acks`, `requiredRoles`, `revision`, `category`, `title` unchanged.

| field | type | notes |
|---|---|---|
| `isStandard` | boolean \| null | marks this SOP as a job standard |
| `jobType` | string \| null, maxLength 120 | the lookup label, e.g. `"RTM hookup"`, `"Hot tub"`, `"Kitchen"`, `"200A panel change"`, `"Lighting"` |
| `scale` | string \| null, maxLength 40 | size tag; suggested enum shown in picker but free text allowed: `small`, `service`, `residential`, `light-commercial`, `commercial`, `condo` |
| `region` | object \| null | `{ provinces: string[], authority: string }` |
| `region.provinces` | string[], maxItems 14, each 2-letter (`"MB"`,`"SK"`,...) | empty/absent = applies anywhere |
| `region.authority` | string, maxLength 80 | `""` \| `"Manitoba Hydro"` \| `"City of Winnipeg"` \| ... |
| `regionRequirements` | array \| null, maxItems 50 | each `{ province?: string(2), authority?: string, text: string(maxLength 2000) }`; empty `province` = shown everywhere. Manitoba-only rules go here with `province:"MB"`. |
| `materials` | array \| null, maxItems 500 | each `{ itemId?: string(128), name?: string(300), qty: number>=0, unit?: string(30), note?: string(300) }`. `itemId` links the price book; `name` is the fallback when there is no price-book item. |
| `breakers` | array \| null, maxItems 200 | each `{ templateId?: string, poles: integer, amps: number\|null, breakerType: enum, qty: integer>=1, note?: string(300), loadVA?: number\|null }`. `breakerType` is a key of `BREAKER_TYPES` in `lib/panel-templates.js` (`standard\|gfci\|afci\|dual\|hacr\|tandem\|lock-on`). `templateId` optionally references a `BUILT_IN_BREAKERS` id. |
| `panelTemplateId` | string \| null, maxLength 128 | optional `BUILT_IN_PANELS` / saved panel preset id (e.g. `res-200`) |
| `specs` | array \| null, maxItems 100 | each `{ label: string(120), value: string(500) }` for wire/service/connection, e.g. `{label:"Service", value:"100A underground"}`, `{label:"Conductor", value:"2/0 Al teck"}`, `{label:"Disconnect", value:"MB Hydro approved"}` |
| `tasks` | array \| null, maxItems 300 | taskTemplate-shaped: each `{ title: string, phaseName?: string, taskType?: string, estHours?: number, qty?: number, unit?: string, requiresPhoto?: boolean, minPhotos?: integer, priority?: low\|normal\|high }` |

**Migration: none.** SOPs is a jsonb collection (`0003_collections` / `0161_r1_collections`); the new
fields live in the `data` blob and sync as-is. Library lookup and region filtering are client-side
over one company's SOP list (small N), so no generated column is needed. A generated `job_type`
column (next free number would be `0163`, after `0162_r1_qbo`) is only warranted if the server ever
has to query standards by type across tenants - out of scope. **Default: client-side filter, no migration.**

## 2. SOPs module UX (`modules/sops.js`)

- **Library split:** a top toggle/tabs "Procedures | Job standards". Standards = SOPs where
  `isStandard || jobType`; plain SOPs keep today's grouped-by-category view. The existing search box
  stays; for standards it also matches `jobType`, `scale`, `specs` values and `materials` names
  ("look up your job"). Standard cards show the `jobType` as the title with `scale` and a region
  badge (province list / authority), plus counts (N materials, N breakers, N tasks).
- **Region filter** on the standards tab defaults to `store.settings().company.province`; options:
  the company province, "All regions", and any province appearing in a standard. A standard matches
  when `region.provinces` is empty or includes the selected province.
- **Reader** shows, for a standard, the steps (as now) plus sections: Region requirements (a
  prominent callout at the top, filtered to the selected/company province + authority, province-
  agnostic ones always shown), Specs, Breakers & panel, Materials, Tasks. Keep the ack flow.
- **Editor** (managers only, as now) gains, behind the "This is a job standard" checkbox: jobType,
  scale picker, region (provinces multi-select + authority select seeded from
  `City of Winnipeg`/`Manitoba Hydro`/custom), region-requirement rows, a materials picker
  (`store.list('items')`, qty/unit; shows cost only when `auth.seesMoney()`), breaker rows reusing
  `listBreakerTemplates(settings)` + `BREAKER_TYPES`, panel preset select from
  `listPanelTemplates(settings)`, spec label/value rows, and task rows. Reuse existing `ui.field`,
  `ui.formGrid`, the step-editor row pattern and `h()`.
- **Money:** material **cost** columns and any total are rendered only under `auth.seesMoney()`; the
  material **list, names, qty, breakers, specs, steps and tasks are always visible** to crew.

## 3. jobs.js integration - "Apply a standard"

New action in the job detail (overview or materials tab): "Apply a standard". It opens a sheet that
lists standards matching the job's region (section 4), lets office pick one, shows a preview of what
will be seeded, and has opt-in checkboxes for "Create panel" and (office-only) "Build draft estimate".
On confirm it calls pure builders in a new `lib/job-standards.js` and writes records:

- **(a) Work tasks** - for each `tasks[i]`: `store.add('workTasks', newTask({ jobId: job.id, title,
  phaseName, taskType, estHours, qty, unit, requiresPhoto, minPhotos, priority, status:'draft',
  link:{ sopId }, stdRef }))` (`newTask` from `lib/workplan.js`). Draft (unassigned) so the foreman
  schedules them.
- **(b) Materials / BOM** - for each `materials[i]`: `store.add('materialRequests', { jobId: job.id,
  itemId, description: name || item?.name, qty, unit, status:'requested', stdRef, costCents })`.
  `costCents` is set only when `auth.seesMoney()` (= `item.costCents * qty`); omitted otherwise, and
  the server strips it for crew anyway.
- **(c) SOP link** - append to a new optional `job.appliedStandards: [{ sopId, revision, appliedAt,
  appliedBy }]` (dedupe by `sopId`) via `store.update('jobs', ...)`. The SOP keeps its own ack flow;
  crew acknowledge it in the SOPs screen as today.
- **(d) Panel (opt-in)** - when checked and `breakers` present: `store.add('panels', { jobId,
  stdRef, ... })` with the main from `panelTemplateId` (via `listPanelTemplates`) and one circuit per
  breaker row expanded by `qty`, each seeded with `applyBreakerTemplate(tpl, {...})`.
- **(e) Draft estimate (opt-in, office-only)** - guarded by `auth.seesMoney()`:
  `store.add('estimates', { jobId, clientId: job.clientId, title: `${jobType} - from standard`,
  status:'draft', lines, labourRateCents: s.labourRateCents ?? 9500, markupPct: 0, stdRef,
  ...newDocTax(s, ui.today(), { job, client }) })`. Lines: one `{kind:'material', description,
  qty, unitCents: item.priceCents}` per priced material (unpriced materials get a $0 line flagged
  "set price"), plus one `{kind:'labour', description:'Labour', qty: sum(estHours), unitCents:
  labourRateCents}`. Never touches accepted estimates.

**Seeding stamp & de-dup:** every seeded record carries `stdRef = { sopId, rev }`. Apply is
idempotent per job+sop: before creating, the builder lists the job's existing records with a matching
`stdRef` and skips those already present (tasks by `stdRef` + title/index, materials by
`stdRef` + itemId/description, panel/estimate by `stdRef` existing at all). The sheet reports
"added N, skipped M already applied". Re-applying after a standard's `revision` bumps adds only the
new/changed items.

## 4. Region logic

- A standard is tagged via `region.provinces[]` and `region.authority`. Jobs have no province field;
  the effective job region = `settings.company.province` (TG Electrical = `MB`), with an optional
  override dropdown in the Apply sheet (and the job's permit `authority` used as a soft hint when
  present). **Default: company province, no new job column.**
- Matching/ranking: `provinces` empty => applies anywhere; otherwise must include the job province.
  A standard whose `authority` equals the job's authority sorts first (soft boost, not a filter).
- Region requirements shown for a job/standard = those with empty `province` plus those whose
  `province` matches the job province (and `authority` matches when set). So MB standards surface MB
  (and City of Winnipeg vs Manitoba Hydro) requirements; a BC job would not see MB-only rules.

## 5. Tests & precache

`electrical-app/tests/job-standards.test.mjs` (node --test, pure builders from `lib/job-standards.js`):
- buildWorkTasks: N tasks -> N draft workTasks with jobId/estHours/stdRef.
- buildMaterialRequests: priced from items, `costCents` present with money / absent without; name fallback.
- buildDraftEstimate: material lines + one labour line (`qty === sum(estHours)`, `unitCents === labourRateCents`); `docTotals` from `lib/money.js` adds markup + tax correctly.
- regionMatch/filter: empty provinces matches all; `MB` matches `MB` not `SK`; requirements filtered by province + authority.
- idempotency: applying twice over the same job+sop seeds nothing the second time (stdRef skip).
- money gate: estimate/cost builders return nothing (or no cost fields) when `seesMoney` is false.

**Precache:** `lib/job-standards.js` is a new file -> regenerate `electrical-app/precache-manifest.json`
(`node tools/gen-precache.mjs`); `electrical-app/tests/precache.test.mjs` enforces it. Run
`node .github/scripts/check-csp.mjs` (no inline/new deps). No change to `sw.js` CORE.

## 6. Owned files (single builder)

1. `electrical-app/js/schema/sops.json` - add the optional typed fields (section 1).
2. `electrical-app/js/lib/job-standards.js` - NEW. Pure helpers: `isStandard`, `regionMatch`,
   `filterStandards`, `visibleRequirements`, `buildWorkTasks`, `buildMaterialRequests`,
   `buildBreakerCircuits`, `buildDraftEstimate`, `applyStandard(ctx, job, sop, opts)` with stdRef dedupe.
3. `electrical-app/js/modules/sops.js` - standards tab/filter, searchable editor for the new fields,
   region display, money gating.
4. `electrical-app/js/modules/jobs.js` - "Apply a standard" action + preview sheet wiring to #2.
5. `electrical-app/js/schema/jobs.json` - add optional `appliedStandards` array.
6. `electrical-app/tests/job-standards.test.mjs` - NEW unit tests (section 5).
7. `electrical-app/precache-manifest.json` - regen after adding #2.
8. `docs/releases/job-standards.md` (this doc) + one line in `docs/README.md`.

## 7. Open questions (with defaults)

- **Job province:** jobs carry no province/authority field. **Default: use `settings.company.province`
  for matching, with an override in the Apply sheet; do not add a job column.** (Alt: add optional
  `job.province`.)
- **Panel auto-build shape** is the fuzziest piece (exact `panels` circuit/tap schema). **Default:
  keep panel creation an opt-in checkbox that seeds one circuit per breaker (qty-expanded) via
  `applyBreakerTemplate`, main from `panelTemplateId`; if the schema needs more, keep it minimal and
  let the office arrange in the panel editor.**
- **Estimate markup:** no company default markup field found. **Default: `markupPct: 0`, office edits
  on the draft.**
