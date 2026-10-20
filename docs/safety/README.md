# Safety module

Field level hazard assessments (FLHAs), toolbox talks, incidents and near misses, corrective actions,
equipment and site inspections, training and site orientation, emergency info per job, and a manager
dashboard. It is in every plan (`safety: 'starter'` in `electrical-app/js/plans.js`).

Facts below were checked on 2026-10-19. Each one is marked **V** (read on the official page),
**V\*** (seen in an official-site excerpt, page not opened in full) or **VERIFY** (secondary source
or not confirmed). The app flags VERIFY items with "check with the regulator". This is a prompt for a
manager, not legal advice. We cite numbers and section references only, never regulation text.

## Where things live

| piece | file |
| --- | --- |
| Screen | `electrical-app/js/modules/safety.js` (tabs: Today, FLHAs, Toolbox talks, Incidents, Actions, Inspections, Training, Dashboard) |
| Sub-views | `electrical-app/js/modules/safety/{flha,talks,incidents,actions,inspections,training,dashboard,jobinfo,common}.js` |
| Pure logic | `js/lib/safety.js` (FLHA gate, dashboard maths, CSV), `safety-reporting.js` (rules by province), `safety-inspections.js` (templates, due dates), `safety-topics.js` (20 talks), `safety-pdf.js` (talk record) |
| Browser helpers | `js/lib/safety-capture.js` (signature pad, photo downscale), `js/lib/safety-emergency.js` (the emergency card) |
| Styles | `electrical-app/css/safety.css` |
| Schemas | `electrical-app/js/schema/{flhas,toolboxTalks,incidents,correctiveActions,safetyInspections,siteOrientations,jobSafety}.json` |
| Server | registry in `server/src/collections.js` (`migration: '0110'`), tables in `server/migrations/0110_safety.sql` (generated: `node scripts/gen-collections-sql.js --migration 0110`), rules in `server/src/auth/access.js` |
| Tests | `electrical-app/tests/safety.test.mjs`, `server/test/safety.test.js`, click-through `electrical-app/tests/e2e/safety.e2e.mjs` |

Certifications use the existing `certifications` collection, shared with Compliance and Employees.

## Records

All follow the store contract (`id`, `createdAt`, `updatedAt`). Days are local `YYYY-MM-DD`.

- `flhas`: `employeeId, jobId, date, task, location, hazards[{ id, label?, present, controls }], ppe[], stopWork, stopWorkReason, notes, signature, review { by, name, at, note, signature }, copiedFrom, recheckedAt`
- `toolboxTalks`: `topicId, title, points[], questions[], jobId, date, time, location, status (scheduled|held|cancelled), leaderId, heldAt, notes, attendees[{ employeeId?, name, company, signature, at }]`
- `incidents`: `kind (near-miss|incident), category, title, description, occurredAt, jobId, location, province, reportedBy, reportedAt, people[], witnesses[], immediateActions, photos[], status (reported|investigating|actions|closed), flags { critical, hospital, fatality, electricalContact, structuralFailure, fire, dangerousOccurrence }, investigation { by, startedAt, whys[5], rootCause, findings, completedAt }, reporting { regulatorNotifiedAt, wcbReportedAt, ... }, medical { injured, injuryType, bodyParts[], treatment, daysAway, modifiedWork, hospital, claimNumber, notes }, closedAt`
- `correctiveActions`: `title, description, sourceType (incident|inspection|flha|talk|other), sourceId, sourceItemId, jobId, ownerId, dueDate, priority, status (open|done|verified), doneAt, doneBy, doneNote, evidence[photos], verifiedAt, verifiedBy, createdBy`
- `safetyInspections`: `templateId, title, jobId, assetTag, date, inspectorId, items[{ id, text, ref, result (open|pass|fail|na), note, photos[] }], result (in-progress|pass|fail), frequencyDays, nextDue, completedAt, signature, notes`
- `siteOrientations`: `employeeId?, workerName, company, jobId, date, by, topics[{ id, done }], signature, notes`
- `jobSafety` (id `safety-<jobId>`, one per job): `jobId, hospital { name, address, phone }, musterPoint, firstAidKit, aed, extinguisher, firstAiders[employeeIds], emergencyContacts[{ name, role, phone }], siteHazards[], flhaRequired`

Signatures are small JPEG data URLs (white background, 480x160, capped at 60 KB) so the PDF writer can
embed them. Photos are downscaled on the device to about 400 KB each (8 per incident, 4 evidence photos
per action, 3 per inspection item). Both move to object storage with the rest of the app's photos.

## Who can do what

Every role has the `safety` permission. Managers are owner, admin, office and foreman (`isManager`).
The server enforces this in `checkWriteRules` (`server/src/auth/access.js`), on REST and sync alike.

| | worker (electrician, apprentice) | manager |
| --- | --- | --- |
| FLHA | create and edit their own; cannot sign the review or delete | review sign-off, anything |
| Toolbox talk | append their own signature only | schedule, add attendees (shared iPad), mark held |
| Incident / near miss | file as themselves; edit their own while `reported`; no status, investigation or reporting fields; no delete | investigate, close, report, delete |
| Medical details | can enter them when filing; never read them back | read and edit |
| Corrective action | raise one unassigned (from their own report or inspection); close one assigned to them with evidence (`open` to `done`) | assign, set due dates, verify, delete |
| Inspection | file and edit their own | anything |
| Orientation, emergency info | read | write |

**Medical privacy.** `redactForReader` removes `medical` from incidents for anyone who is not a
manager on a session (API keys included) and sets `medicalHidden: true`. `restoreHiddenFields`
puts the stored medical details back on any write by such a reader, so a worker editing their own
report never wipes them and cannot change them later. Pull, list, get and conflict copies are all
redacted. Tests: `server/test/safety.test.js`.

## FLHA gate (for the work-plan module)

```js
import { hasFlhaToday, flhaRequired } from '../lib/safety.js';
import { jobSafetyOf } from '../lib/safety-emergency.js';

const required = flhaRequired(jobSafetyOf(store, job.id), store.settings());
const unlocked = !required || hasFlhaToday(me.id, job.id, ui.today(), store.list('flhas'));
```

`hasFlhaToday(employeeId, jobId, date, flhas)` is pure. It returns true when the worker has a
**signed** FLHA for that job on that local day and it does not say "stop work". `jobId` null accepts
any job that day. The last argument is the `flhas` records, or anything with `list('flhas')` (the
store). `flhaRequired(jobSafety, settings)` reads the job's `flhaRequired` switch (on by default
when emergency info is saved), else `settings.safety.flhaRequired`.

"Same as yesterday, re-checked" (`copyFlha`) copies hazards, controls, PPE and task to today with
`copiedFrom` and `recheckedAt`. The signature and the review never carry over: the worker re-checks and signs again.

## Emergency info

`emergencyCard({ store, ui }, jobId)` returns the card or null. It is shown at the top of the job
page (`modules/jobs.js`, with an "Add emergency info" link for managers) and on Safety > Today for each job the
worker is on today. My Day should prepend it the same way.

## Reportable rules by province (`js/lib/safety-reporting.js`)

`reportableFor(incident, province)` returns the regulator calls with deadlines, the workers'
compensation report with its due date (business days skip weekends, not holidays) and a `verify` flag.

| | regulator notification | workers' compensation | ref |
| --- | --- | --- | --- |
| ON | MLITSD 1-877-202-0008 (24/7). Death or critical injury: immediately, written report in 48 h, preserve the scene (OHSA s.51, V). Medical attention or lost work: written notice to JHSC/union in 4 days (s.52(1), V). Prescribed construction occurrences even with no injury, e.g. a fall of 3 m or more: 2 days (s.53, O. Reg. 420/21, V\*). | WSIB Form 7, **3 business days** after learning of health care beyond first aid, time off, lost earnings or modified work below regular pay (V). Late penalties exist (V\*). | R1, R2 |
| BC | WorkSafeBC 1-888-621-7233. Serious injury or death, major structural failure or collapse, major hazardous release, dangerous fire or explosion: immediately (WCA s.68, V). Investigation: preliminary in 48 h, full in 30 days (V\*; section numbers VERIFY). | Form 7 within 3 days (V\*). | R3 |
| AB | OHS Contact Centre 1-866-415-8690. Death, hospital admission, unplanned explosion/fire/flood, crane or hoist collapse, structural failure: as soon as possible (OHS Act s.33, V\*). Potentially serious incidents online (V\*, **VERIFY** timing). | WCB-Alberta report within 72 h (V\*, **VERIFY**). | R4 |
| SK | OHS Division 1-800-567-7233. Death or hospital admission (summary says 72 h or more, **VERIFY**), dangerous occurrences: as soon as reasonably possible (OHS Regulations, 2020 ss.2-2, 2-3, V\*). | WCB Saskatchewan E1 within 5 days (V\*, **VERIFY**). | R5 |
| MB | Workplace Safety and Health 1-855-957-7233. Serious incidents (incl. electrical contact injury, unconsciousness, major fractures): immediately, preserve the scene (MR 217/2006 ss.2.6-2.7, V\*, **VERIFY**). | WCB Manitoba within **5 business days** (V). | R6 |
| NB | WorkSafeNB 1-800-999-9775 (after-hours coverage **VERIFY**). Serious injuries, death, explosions: immediately (OHS Act s.43, **VERIFY**). | Form 67 within 3 days (V\*, **VERIFY**). | R7 |
| NS | OHS Division 1-800-952-2687. Fatality immediately; serious injury or serious incident within 24 h (OHS Act s.63, V; section **VERIFY**). | WCB Nova Scotia must **receive** the report within **2 business days** (V). | R8 |
| PE | 24/7 OHS emergency line 902-628-7513 (V\*). Serious injury, fatality, explosion: immediately (**VERIFY** section). | WCB PEI Form 7 within 3 days (V\*, **VERIFY**). | R9 |
| NL | 709-729-4444 / 1-800-563-5471 (V\*). Serious injury or death: immediately, written report in 3 days (5 for a death) (**VERIFY** section). | WorkplaceNL Form 7 within 3 days (V\*, **VERIFY**). | R10 |

Quebec, Yukon, NWT and Nunavut are not covered yet; the app says so and points to the regulator.

Sources:
- R1 https://www.ontario.ca/page/reporting-workplace-incidents-and-illnesses ; online form https://forms.mgcs.gov.on.ca/en/dataset/on00276 ; O. Reg. 213/91 https://www.ontario.ca/laws/regulation/910213
- R2 https://www.wsib.ca/en/businesses/claims/report-injury-or-illness
- R3 https://www.worksafebc.com/en/health-safety/create-manage/incident-investigations/reporting-incidents-worksafebc
- R4 https://www.alberta.ca/report-serious-injuries-incident ; https://oirportal.labour.alberta.ca ; https://www.wcb.ab.ca
- R5 https://www.wcbsask.com/how-report-work-injury
- R6 https://www.wcb.mb.ca/report-an-injury
- R7 https://www.worksafenb.ca/employers/health-safety/report-an-injury-or-illness/
- R8 https://www.wcb.ns.ca/employers/claims-process/if-injury-happens
- R9 https://www.wcb.pe.ca/employers/ReportingAnInjury
- R10 https://workplacenl.ca/employers/report-a-workplace-injury/

## Standards and training references

- **CSA Z462:24** (6th edition, workplace electrical safety, harmonised with the 2024 CE Code): arc flash
  boundary, limited and restricted approach boundaries, incident energy labels (V\*).
  https://www.csagroup.org/store/product/CSA_Z462:24/
- **CSA Z460:20** (lockout), reaffirmed 2025 (V\*).
- **Ontario Working at Heights**, O. Reg. 297/13: CPO-approved program and provider, valid 3 years from
  completion, refresher renews it (V\*). https://www.ontario.ca/page/training-working-heights. The training
  matrix shows it for Ontario companies only.
- **WHMIS 2015**: Hazardous Products Act and Hazardous Products Regulations (SOR/2015-17, citation VERIFY);
  the 2022 amendments' supplier transition ended 2025-12-14 (V\*). Worker education is provincial.
  https://www.canada.ca/en/health-canada/services/environmental-workplace-health/occupational-health-safety/workplace-hazardous-materials-information-system/amendments-hazardous-products-regulations.html
- **Overhead lines (ON)**: O. Reg. 213/91 s.188: 3 m for 750 V to 150 kV, 4.5 m to 250 kV, 6 m above (V\*; full e-Laws text VERIFY).
- **First-aid kits (ON)**: Reg. 1101 s.6, inspect at least quarterly and sign the card (V\*). Default frequency 90 days.
- **Fire extinguishers**: monthly visual, annual maintenance (NFPA 10 as referenced by the National Fire
  Code; **VERIFY**). Default frequency 30 days.
- **Ladders**: CSA Z11, inspect before use. **Elevating work platforms**: CSA B354 series, pre-use daily
  inspection and annual inspection (**VERIFY** part numbers). **Temporary power and GFCI on construction
  sites**: CEC Section 76 (rule numbers VERIFY). Defaults: ladders, lifts, scaffolds and cords daily;
  temporary power and site weekly; PPE monthly.
- Cold and heat stress talks point to the ACGIH TLVs that provinces reference (VERIFY per province).

## Toolbox talk library

20 talks written for Fishtape (`js/lib/safety-topics.js`): lockout/tagout, arc flash boundaries, GFCI,
ladders, cold stress, heat stress, PPE, housekeeping, extension cords, temporary power, overhead lines,
hand tools, silica, confined space awareness, first aid and the emergency plan, WHMIS labels, fall
protection, vehicles, mental health (988 helpline), near-miss reporting. Each has 5 points and 2
questions. Managers schedule a talk, crew sign on their own device or on a shared iPad, and the record
prints or downloads as a PDF with each signature.

## What COR auditors look for

COR is run by each province's construction safety association: IHSA (ON), BCCSA (BC), ACSA (AB),
SCSA (SK), CSAM / SAFE Work Certified (MB), NBCSA, NSCSA, Construction Safety Association of PEI, NLCSA
(all VERIFY). WorkSafeBC pays COR holders an incentive of 10% of base assessment (V\*); Alberta ties
COR to the WCB Partnerships in Injury Reduction refund (VERIFY). Audits are typically a full external
audit every 3 years with maintenance audits in between (VERIFY per program). What an auditor will ask
to see, and where it is in Fishtape:

- [ ] A written safety policy and program signed by the owner (outside Fishtape: SOPs can hold it).
- [ ] **Hazard assessments**: daily FLHAs for every worker on every job, reviewed and signed by the foreman
  (FLHAs tab, dashboard completion %).
- [ ] **Inspections** on a schedule, with defects fixed (Inspections tab, recurring due dates, failed items
  become corrective actions with evidence).
- [ ] **Toolbox talks / crew meetings** with dated, signed attendance (talk PDF).
- [ ] **Incident and near-miss reports**, investigated to a root cause, with corrective actions closed
  and verified (Incidents tab, 5 whys, actions).
- [ ] **Regulator and WCB reports** made on time (reportable prompt, "mark notified" timestamps).
- [ ] **Training records** current for every worker: WHMIS, fall protection / Working at Heights, first aid,
  arc flash, confined space, EWP, LOTO (Training matrix, expiry alerts).
- [ ] **Orientation** of every new worker to each site (Site orientations).
- [ ] **Emergency preparedness**: hospital, muster point, first aiders, contacts posted per site (job emergency card).
- [ ] Interviews: auditors ask workers whether they know the hazards, the muster point and how to report.
  Toolbox talks and the Today screen are where that shows.

Export the dashboard CSV and the talk PDFs as evidence.

## Notifications

There is no server `notify()` helper yet. `notifySafety()` in `modules/safety/common.js` is the hook: it writes an
audit entry and the screens show a toast. When the server gets notify(), send: stop-work FLHAs to the
foreman, new incidents to managers, reportable incidents with their deadline, and overdue corrective actions to the owner.

## VERIFY list (confirm before production)

1. Act and regulation citations marked VERIFY above (BC investigation sections, NB s.43, NS s.63, PE and NL sections, HPR citation).
2. SK hospitalization threshold (72 h or any admission).
3. AB potentially-serious-incident timing; WCB-AB 72 h wording.
4. NB incident line after-hours coverage.
5. SK, NB, PE, NL WCB deadlines (V\* only).
6. Full O. Reg. 213/91 s.188 text; NFPA 10 / NFC references; CSA B354 part numbers; CEC Section 76 GFCI rule.
7. COR bodies, audit cycle and incentive figures per province.
8. Provincial first-aid kit inspection rules outside Ontario.
