# Automatic timesheets: location, travel, overtime and payroll

Travis (TG Electrical, Manitoba): "Every day I come home and sit at QuickBooks dead tired: Jackson
hours, Jackson travel, Manny travel, Manny hours. That should all be automatic through GPS when they
clock in." This is how Fishtape does it. Privacy rules: [privacy.md](../compliance/privacy.md#location-while-clocked-in).
Threats: [threat-model.md](../security/threat-model.md) (TM-LOC).

## How a day goes

1. **Job sites.** On a job's Overview, a manager taps **Find address** (NRCan Geolocator) or
   **Drop pin** on the map, and sets the radius (default 150 m, 30 to 2,000 m). Stored on the job as
   `site { lat, lng, radiusM, source, label }`.
2. **Clock in.** The first time, the worker sees the company's location notice and allows or declines
   (once per policy version). With consent, one fix is taken right after the shift opens: with no job
   picked, the site they are inside becomes the job; inside another job's site, they are offered a
   switch; clearly outside the job's site (beyond the radius, a margin and the fix's accuracy, with
   accuracy 250 m or better), the entry gets an off-site flag ("clocked in 4.2 km from the job site")
   for the foreman to review.
3. **Travel.** **Travel** (or **Start with travel** to the first site) closes the work part and opens
   a `kind: 'travel'` part; **Arrived** closes travel, attributes it to the job arrived at (travel is
   billed to the job travelled to) and opens work there. In the browser, while the app is open on a
   running shift, a fix every 3 minutes suggests **Start travel** after leaving a site and **Start work
   here** on arriving at another. In the iOS app, region monitoring notices the same with the app
   closed and offers one **Update my time** suggestion when it is opened (`buildTravelSegments`).
   Nothing is applied without a tap.
4. **Clock out.** One last fix, then the shift closes and all watching stops.
5. **Week.** Time clock > Timesheets: per person, work and travel per job and day, overtime by the
   province's rule, break reminders, flags; **Approve week** for one person or everyone (foreman and
   office, `time-approve`); **Export CSV** for payroll. Dashboard tile: hours this week by person
   (work / travel).

Every part is a plain time entry (`timeEntries`) with `kind: 'work' | 'travel'`, `jobId`,
`travelFromJobId` (travel), `clockInLoc`/`clockOutLoc` (lat, lng, accuracy), `siteCheck`, `flag`,
`approved`/`approvedAt`/`approvedBy`, so time-and-materials billing can price work and travel later.

Code: `js/lib/geo.js` (distances, sites, flags, segments), `js/lib/clock.js` (store writes),
`js/lib/shift-tracker.js` (when to take fixes), `js/lib/location.js` (browser and iOS fixes),
`js/lib/timesheet.js` (overtime, sheets, CSV), `js/lib/location-ui.js` and `modules/time.js` (screens).

## Overtime rules (checked 2026-10-19)

Fishtape reports overtime **hours**; the payroll provider applies the rate. A shift belongs to the day
it started. Rules live in `OT_RULES` (`js/lib/timesheet.js`); Time clock > Settings picks the rule
(the company's province by default) and the payroll week start.

| rule | overtime | rate basis | meal break reminder | source |
| --- | --- | --- | --- | --- |
| MB | over 8 h/day or 40 h/week, each hour once | 1.5x regular | 30 min after 5 h | gov.mb.ca/labour/standards/doc,overtime,factsheet.html (page 2022-09-29) |
| MB-ICI | ICI construction: over 10 h/day or 40 h/week | 1.5x regular | 30 min after 5 h | gov.mb.ca/labour/standards/doc,ici-wage,factsheet.pdf (2025-09-03) |
| SK | greater of over 8 h/day or 40 h/week | 1.5x regular | 30 min in every 5 h | saskatchewan.ca, Saskatchewan Employment Act ss. 2-14, 2-18 |
| BC | 1.5x over 8 h/day, 2x over 12 h/day, 1.5x over 40 h/week (first 8 h of a day count) | regular | 30 min after 5 h | gov.bc.ca overtime-pay (2024-01-31), ESA s. 40 |
| AB | greater of over 8 h/day or 44 h/week | 1.5x regular | 30 min per shift over 5 h | alberta.ca/overtime-hours-overtime-pay |
| ON | over 44 h/week, no daily | 1.5x regular | 30 min, never 5 h in a row | ontario.ca ESA guide, overtime (2026-02-05), s. 22 |
| NS | over 48 h/week | 1.5x **regular** | 30 min, never 5 h in a row | novascotia.ca Labour Standards Code guide (rev. 10/25) |
| NB | over 44 h/week | 1.5x **minimum wage** | VERIFY | gnb.ca employment standards, wage-pay |
| PE | over 44 h/week (Bill 76, in force 2026-06-30; was 48) | 1.5x regular | 30 min per 5 h (VERIFY under the new Act) | princeedwardisland.ca, changes to the ESA |
| NL | over 40 h/week | 1.5x **minimum wage** | 60 min after 5 h | gov.nl.ca Your Rights At Work (2025-07-04) |

Not applied automatically (VERIFY, flagged in the UI notes): SK weeks with a public holiday (32 h)
and 10-hour-day schedules; NS construction (110 h per two weeks) and its apprentice exclusion; Ontario
averaging agreements; MB residential/heavy construction variants; collective agreements. Quebec is
not a launch province.

## Payroll exports (checked 2026-10-19)

| format | what it is | columns |
| --- | --- | --- |
| Wagepoint | Wagepoint's **Import hours (CSV)** (Hours and incomes > Hours > Import hours). One row per employee per job, decimal hours, no dates. Source: wagepoint2help.zendesk.com/hc/en-us/articles/40676249022359 (updated 2026-06-10). | `Employee ID, Employee Name, Job ID, Job Name, Regular Hours, Overtime Hours, Double Time Hours` |
| Wagepoint template | Wagepoint generates the template per pay group with one column per hourly **income code**, whose header text is the company's own and not published (VERIFY with a real template). **Fill my Wagepoint template** reads the downloaded template, matches rows by Employee ID (our employee's **Payroll ID**) and Job ID (our job number), finds the regular/overtime/double columns by their header words, and fills only those cells. Rows with no time stay blank, which Wagepoint treats as "leave unchanged". | the template's own |
| QuickBooks Online Payroll | **QuickBooks Online Payroll (Canada) has no hours import.** The Canadian "Import data" list has no time activities (quickbooks.intuit.com/learn-support/en-ca, common questions about importing data); the supported routes are QuickBooks Time, QBO timesheets, or typing hours in Run payroll. This export is an entry sheet in that order. Pushing time through the QBO API (TimeActivity) in Canada: VERIFY (backlog). | `Employee, Employee ID, Date, Customer, Job, Type, Regular hours, Overtime hours, Double time hours` |
| Generic | One row per person, day, job and type; works in a spreadsheet or any import that maps columns (ADP Workforce Now Canada's paydata import is header-based: `Co Code, Batch ID, File #, Reg Hours, O/T Hours`, mappable from this). | `employee_id, employee_name, period_start, period_end, work_date, job_code, job_name, customer, type, regular_hours, overtime_hours, double_time_hours, total_hours, break_minutes, approved` |

Only closed entries are exported. Open shifts, unapproved entries and people without a payroll ID come
back as warnings before the file is used.

## Maps and address lookup (checked 2026-10-19)

- **Tiles:** Natural Resources Canada, Canada Base Map – Transportation in Web Mercator:
  `maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps/CBMT_CBCT_GEOM_3857/MapServer/tile/{z}/{y}/{x}`
  plus the `CBMT_TXT_3857` label layer. Zoom 0 to 15 (closer zooms scale the z15 tiles), Canada only,
  no key, Open Government Licence – Canada (commercial use allowed; attribution shown on the map).
  Whether the raster also needs OpenStreetMap credit: VERIFY. OSM's own tiles were not used: the OSMF
  tile policy offers no SLA and may withdraw access for commercial services.
- **Address lookup:** NRCan Geolocator `https://geolocator.api.geo.ca/?q=…&lang=en&keys=locate`
  (replaces the geogratis service, which shuts down 2027-03-31). Free, no key, CORS open. Its page says
  "free for typical public, government, and research use" and asks high-volume users to write to
  geo@nrcan-rncan.gc.ca; commercial SaaS use is not spelled out: **VERIFY with NRCan before launch**.
  The pin drop works without it. One lookup per job, only on a manager's tap.
- CSP: both hosts are allowed in both security-headers files (`img-src` and `connect-src`).

## Limits and follow-ups

- The PWA only gets location in the foreground; background arrival/departure needs the iOS app.
- iOS region monitoring has a 20-region limit; the nearest 18 job sites are watched.
- Accuracy of real devices on real sites, and background relaunch after force-quit or reboot: test
  on an iPhone (VERIFY).
- A shift that crosses midnight counts on the day it started.
