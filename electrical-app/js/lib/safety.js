// Safety: the pure parts (no DOM, no store). Used by modules/safety*.js, by the work-plan
// module (hasFlhaToday) and by tests/safety.test.mjs. Background and sources:
// docs/safety/README.md.
//
// Records (schemas in js/schema/): flhas, toolboxTalks, incidents, correctiveActions,
// safetyInspections, siteOrientations, jobSafety. Dates are local days (YYYY-MM-DD),
// timestamps full ISO.

/**
 * The FLHA hazard checklist. `controls` are suggestions the worker can tick or edit;
 * `ppe` is what the hazard usually calls for. Wording is ours, not copied from any form.
 */
export const HAZARDS = [
  { id: 'electrical', label: 'Electrical / arc flash', controls: ['De-energize, lock out and tag out', 'Test before touch with a proven tester', 'Arc-rated PPE to the equipment label (CSA Z462)', 'Mark the arc flash and approach boundaries'], ppe: ['arc-rated', 'voltage-gloves', 'face-shield', 'safety-glasses'] },
  { id: 'energized', label: 'Energized work', controls: ['Energized work permit signed by a manager', 'Justify why it cannot be de-energized', 'Insulated tools and a second worker present', 'Barricade the restricted approach boundary'], ppe: ['arc-rated', 'voltage-gloves', 'face-shield'] },
  { id: 'heights', label: 'Working at heights', controls: ['Guardrails or covers on openings', 'Harness tied off to a rated anchor', 'Rescue plan in place', 'Working at Heights training current (ON)'], ppe: ['harness', 'hard-hat'] },
  { id: 'ladders', label: 'Ladders / lifts', controls: ['Ladder inspected before use (CSA Z11)', 'Three points of contact, secured top and bottom', 'Lift pre-use inspection done (CSA B354)', 'Operator trained on this lift'], ppe: ['hard-hat', 'harness'] },
  { id: 'confined', label: 'Confined space', controls: ['Entry permit and air test before entry', 'Attendant outside the space', 'Rescue plan and equipment ready', 'Ventilation running'], ppe: ['gas-monitor', 'harness'] },
  { id: 'excavation', label: 'Excavation / trenching', controls: ['Locates done and marked', 'Hand dig near buried services', 'Shoring or sloping over 1.2 m deep', 'Keep spoil and equipment back from the edge'], ppe: ['hi-vis', 'hard-hat'] },
  { id: 'overhead', label: 'Overhead power lines', controls: ['Keep the limit of approach distance', 'Signaller for equipment near lines', 'Utility contacted to cover or de-energize', 'Non-conductive ladders and tools'], ppe: ['hard-hat'] },
  { id: 'silica', label: 'Silica / dust', controls: ['Wet cutting or a shroud with HEPA vacuum', 'No dry sweeping', 'Keep others out of the dust area'], ppe: ['respirator', 'safety-glasses'] },
  { id: 'weather', label: 'Weather / cold or heat stress', controls: ['Warm-up or cool-down breaks scheduled', 'Water and shade or a heated shelter', 'Buddy checks for frostbite or heat illness', 'Watch the forecast; stop for lightning'], ppe: ['winter-gear'] },
  { id: 'traffic', label: 'Traffic / mobile equipment', controls: ['Traffic control and signage in place', 'Spotter for backing vehicles', 'Stay out of blind spots'], ppe: ['hi-vis', 'hard-hat'] },
  { id: 'manual', label: 'Manual handling', controls: ['Two-person lift or a cart for heavy reels and panels', 'Clear path, lift with the legs', 'Rotate repetitive tasks'], ppe: ['gloves'] },
];

export const PPE = [
  { id: 'hard-hat', label: 'Hard hat' }, { id: 'safety-glasses', label: 'Safety glasses' }, { id: 'boots', label: 'Safety boots' },
  { id: 'hi-vis', label: 'Hi-vis vest' }, { id: 'gloves', label: 'Work gloves' }, { id: 'voltage-gloves', label: 'Rubber insulating gloves' },
  { id: 'arc-rated', label: 'Arc-rated clothing' }, { id: 'face-shield', label: 'Arc-rated face shield / hood' }, { id: 'hearing', label: 'Hearing protection' },
  { id: 'respirator', label: 'Respirator' }, { id: 'harness', label: 'Harness and lanyard' }, { id: 'gas-monitor', label: 'Gas monitor' },
  { id: 'winter-gear', label: 'Cold or heat gear' },
];

export const hazardLabel = (id, custom) => HAZARDS.find((x) => x.id === id)?.label || custom || id;
export const ppeLabel = (id) => PPE.find((x) => x.id === id)?.label || id;

// ---------- dates ----------

/** 'YYYY-MM-DD' + n days (calendar days, no time zone drift). */
export function addDays(day, n) {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + Number(n || 0)));
  return t.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  const p = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

/** Local calendar day of a Date or ISO timestamp. */
export function localDay(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const rows = (src, coll) => (Array.isArray(src) ? src : src && typeof src.list === 'function' ? src.list(coll) : []);

// ---------- FLHA ----------

/** A blank FLHA for a worker on a job and day. */
export function newFlha({ employeeId, jobId = null, date, task = '', location = '' }) {
  return {
    employeeId, jobId, date, task, location,
    hazards: HAZARDS.map((h) => ({ id: h.id, present: false, controls: '' })),
    ppe: ['hard-hat', 'safety-glasses', 'boots'],
    stopWork: false, stopWorkReason: '', notes: '', signature: null, review: null, copiedFrom: null, recheckedAt: null,
  };
}

/** Signed by the worker? */
export const isSigned = (f) => Boolean(f?.signature?.dataUrl);

/**
 * The worker's FLHA for a job and day: the latest signed one, else the latest draft, else null.
 * `jobId` null or '' matches any job that day.
 */
export function flhaFor(employeeId, jobId, date, flhas) {
  const mine = rows(flhas, 'flhas').filter((f) => f && f.employeeId === employeeId && f.date === date && (!jobId || f.jobId === jobId));
  if (!mine.length) return null;
  const by = (a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  return mine.filter(isSigned).sort(by)[0] || mine.sort(by)[0];
}

/**
 * hasFlhaToday(employeeId, jobId, date, flhas) -> boolean
 *
 * True when the worker has a SIGNED field level hazard assessment for that job on that day
 * and it does not say "stop work". This is the gate the work-plan module uses before a
 * worker's task list unlocks (docs/safety/README.md, "FLHA gate"):
 *
 *   import { hasFlhaToday, flhaRequired } from '../lib/safety.js';
 *   if (flhaRequired(jobSafety) && !hasFlhaToday(me.id, job.id, today, store.list('flhas'))) lock();
 *
 * Pure: pass the flhas records (an array) or anything with list('flhas') (the store).
 * `jobId` null or '' accepts an FLHA on any job that day. `date` is a local day 'YYYY-MM-DD'.
 */
export function hasFlhaToday(employeeId, jobId, date, flhas) {
  if (!employeeId || !date) return false;
  return rows(flhas, 'flhas').some((f) => f && f.employeeId === employeeId && f.date === date
    && (!jobId || f.jobId === jobId) && isSigned(f) && !f.stopWork);
}

/** Does the job ask for an FLHA before work starts? (jobSafety.flhaRequired, else the company default.) */
export function flhaRequired(jobSafety, settings) {
  if (jobSafety && typeof jobSafety.flhaRequired === 'boolean') return jobSafety.flhaRequired;
  return Boolean(settings?.safety?.flhaRequired);
}

/** The worker's most recent signed FLHA on this job before `date` (for "same as yesterday"). */
export function lastFlha(employeeId, jobId, date, flhas) {
  return rows(flhas, 'flhas')
    .filter((f) => f.employeeId === employeeId && (!jobId || f.jobId === jobId) && f.date < date && isSigned(f))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

/**
 * "Same as yesterday, re-checked": copy the hazards, controls, PPE and task to a new day.
 * The signature and the foreman's review never carry over: the worker signs again.
 */
export function copyFlha(prev, date, now = new Date().toISOString()) {
  return {
    employeeId: prev.employeeId, jobId: prev.jobId ?? null, date,
    task: prev.task || '', location: prev.location || '',
    hazards: (prev.hazards || []).map((h) => ({ ...h })), ppe: [...(prev.ppe || [])],
    stopWork: false, stopWorkReason: '', notes: prev.notes || '',
    signature: null, review: null, copiedFrom: prev.id || null, recheckedAt: now,
  };
}

/** Hazards ticked present that have no control written. A signed FLHA should have none. */
export function uncontrolledHazards(f) {
  return (f?.hazards || []).filter((h) => h.present && !String(h.controls || '').trim());
}

// ---------- corrective actions ----------

export function actionState(a, today) {
  if (!a) return 'open';
  if (a.status === 'verified') return 'verified';
  if (a.status === 'done') return 'done';
  return a.dueDate && a.dueDate < today ? 'overdue' : 'open';
}

/** Open (not done) actions and how many of them are past due. */
export function openActions(actions, today) {
  const open = (actions || []).filter((a) => a && a.status !== 'done' && a.status !== 'verified');
  return { open: open.length, overdue: open.filter((a) => a.dueDate && a.dueDate < today).length, list: open };
}

// ---------- incidents ----------

export const INCIDENT_STATUSES = ['reported', 'investigating', 'actions', 'closed'];
export const INJURY_TYPES = ['Cut / laceration', 'Burn (thermal)', 'Electrical shock', 'Arc flash burn', 'Sprain / strain', 'Fracture', 'Bruise / contusion', 'Eye injury', 'Puncture', 'Crush', 'Hearing', 'Inhalation', 'Heat illness', 'Cold injury', 'Other'];
export const BODY_PARTS = ['Head', 'Eyes', 'Face', 'Neck', 'Shoulder', 'Arm', 'Elbow', 'Wrist', 'Hand', 'Fingers', 'Chest', 'Back (upper)', 'Back (lower)', 'Abdomen', 'Hip', 'Leg', 'Knee', 'Ankle', 'Foot', 'Toes', 'Multiple', 'Internal'];
export const CATEGORIES = [
  ['injury', 'Injury or illness'], ['shock', 'Electrical shock'], ['arc-flash', 'Arc flash'], ['fall', 'Fall or near fall'],
  ['struck-by', 'Struck by / caught between'], ['vehicle', 'Vehicle'], ['fire', 'Fire or explosion'], ['property', 'Property or equipment damage'],
  ['environmental', 'Spill or release'], ['other', 'Other'],
];

/** Month key 'YYYY-MM' of a record's occurrence. */
const monthOf = (r) => String(r.occurredAt ? localDay(r.occurredAt) : r.createdAt || '').slice(0, 7);

/** The last `months` month keys ending at `today`'s month, oldest first. */
export function lastMonths(today, months = 6) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** Near misses and incidents per month for the trend chart, plus totals over the window. */
export function incidentTrend(incidents, today, months = 6) {
  const keys = lastMonths(today, months);
  const series = keys.map((month) => ({ month, nearMiss: 0, incident: 0 }));
  const at = new Map(series.map((s) => [s.month, s]));
  for (const r of incidents || []) {
    const s = at.get(monthOf(r));
    if (!s) continue;
    if (r.kind === 'near-miss') s.nearMiss++; else s.incident++;
  }
  const total = series.reduce((t, s) => ({ nearMiss: t.nearMiss + s.nearMiss, incident: t.incident + s.incident }), { nearMiss: 0, incident: 0 });
  // A healthy reporting culture logs several near misses per incident (docs/safety/README.md).
  return { series, ...total, ratio: total.incident ? Math.round((total.nearMiss / total.incident) * 10) / 10 : null };
}

// ---------- dashboard ----------

/**
 * FLHA completion over [from, to]: every worker-job-day that someone was scheduled or
 * clocked in for, and how many of them have a signed FLHA (hasFlhaToday).
 * @returns {{ expected: number, done: number, pct: number|null, missing: { employeeId, jobId, date }[] }}
 */
export function flhaCompletion({ flhas = [], schedule = [], timeEntries = [], from, to }) {
  const want = new Map();
  const add = (employeeId, jobId, date) => {
    if (!employeeId || !jobId || !date || date < from || date > to) return;
    want.set(`${employeeId}|${jobId}|${date}`, { employeeId, jobId, date });
  };
  for (const s of schedule) add(s.employeeId, s.jobId, s.date);
  for (const t of timeEntries) if (t.clockIn) add(t.employeeId, t.jobId, localDay(t.clockIn));
  const missing = [];
  let done = 0;
  for (const w of want.values()) {
    if (hasFlhaToday(w.employeeId, w.jobId, w.date, flhas)) done++; else missing.push(w);
  }
  const expected = want.size;
  return { expected, done, pct: expected ? Math.round((done / expected) * 100) : null, missing };
}

/** Required safety training for electrical crews (matched by name, case-insensitive). */
export const TRAINING = [
  { id: 'whmis', label: 'WHMIS 2015', match: /whmis/i },
  { id: 'wah', label: 'Working at Heights', match: /working at heights|\bwah\b/i, provinces: ['ON'] },
  { id: 'fall', label: 'Fall protection', match: /fall (protection|arrest)/i },
  { id: 'first-aid', label: 'First aid / CPR', match: /first aid|cpr/i },
  { id: 'arc-flash', label: 'Arc flash (CSA Z462)', match: /arc.?flash|z462/i },
  { id: 'confined', label: 'Confined space', match: /confined space/i },
  { id: 'ewp', label: 'Elevating work platform', match: /elevat(ed|ing) work platform|\bewp\b|aerial|scissor/i },
  { id: 'loto', label: 'Lockout / tagout', match: /lockout|\bloto\b|z460/i },
];

export function trainingKind(name) {
  return TRAINING.find((t) => t.match.test(String(name || '')))?.id || null;
}

/** Certifications expired or expiring within `days`, soonest first. */
export function expiringTraining(certs, today, days = 30) {
  return (certs || [])
    .filter((c) => c && c.expiry)
    .map((c) => ({ ...c, daysLeft: daysBetween(today, c.expiry) }))
    .filter((c) => c.daysLeft <= days)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Per worker: which required training they hold, and whether it is valid today. */
export function trainingMatrix(employees, certs, today, province) {
  const kinds = TRAINING.filter((t) => !t.provinces || !province || t.provinces.includes(province));
  return (employees || []).filter((e) => e.active !== false).map((e) => {
    const mine = (certs || []).filter((c) => c.employeeId === e.id);
    const cells = Object.fromEntries(kinds.map((k) => {
      const held = mine.filter((c) => trainingKind(c.name) === k.id).sort((a, b) => String(b.expiry || '9999').localeCompare(String(a.expiry || '9999')))[0];
      let state = 'missing';
      if (held) state = !held.expiry ? 'valid' : held.expiry < today ? 'expired' : daysBetween(today, held.expiry) <= 30 ? 'expiring' : 'valid';
      return [k.id, { state, cert: held || null }];
    }));
    return { employee: e, cells };
  }).map((r) => ({ ...r, kinds }));
}

/**
 * The manager dashboard numbers, all pure.
 * @param {{ flhas, schedule, timeEntries, incidents, actions, inspectionStatus, certs, today, days? }} d
 */
export function dashboardStats(d) {
  const today = d.today;
  const from = addDays(today, -((d.days || 30) - 1));
  const flha = flhaCompletion({ flhas: d.flhas, schedule: d.schedule, timeEntries: d.timeEntries, from, to: today });
  const inRange = (d.incidents || []).filter((r) => { const day = r.occurredAt ? localDay(r.occurredAt) : String(r.createdAt || '').slice(0, 10); return day >= from && day <= today; });
  const actions = openActions(d.actions, today);
  const overdueInspections = (d.inspectionStatus || []).filter((s) => s.state === 'overdue');
  const expiring = expiringTraining(d.certs, today, 30);
  return {
    from, to: today,
    flhaPct: flha.pct, flhaDone: flha.done, flhaExpected: flha.expected,
    nearMisses: inRange.filter((r) => r.kind === 'near-miss').length,
    incidents: inRange.filter((r) => r.kind !== 'near-miss').length,
    openActions: actions.open, overdueActions: actions.overdue,
    overdueInspections: overdueInspections.length,
    expiringTraining: expiring.filter((c) => c.daysLeft >= 0).length,
    expiredTraining: expiring.filter((c) => c.daysLeft < 0).length,
    trend: incidentTrend(d.incidents, today, 6),
  };
}

/** RFC 4180 CSV (CRLF, quotes doubled). Formula-looking cells get a leading quote (CSV injection). */
export function toCsv(rowsIn) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rowsIn.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** The dashboard export: one row per metric, then the monthly trend. */
export function dashboardCsv(stats, companyName = '') {
  const out = [
    ['Safety dashboard', companyName], ['From', stats.from], ['To', stats.to], [],
    ['Metric', 'Value'],
    ['FLHA completion %', stats.flhaPct ?? ''], ['FLHAs signed', stats.flhaDone], ['Worker-days expected', stats.flhaExpected],
    ['Near misses', stats.nearMisses], ['Incidents', stats.incidents],
    ['Open corrective actions', stats.openActions], ['Overdue corrective actions', stats.overdueActions],
    ['Overdue inspections', stats.overdueInspections],
    ['Training expiring in 30 days', stats.expiringTraining], ['Training expired', stats.expiredTraining],
    [], ['Month', 'Near misses', 'Incidents'],
    ...stats.trend.series.map((s) => [s.month, s.nearMiss, s.incident]),
  ];
  return toCsv(out);
}

// ---------- site orientation and emergency info ----------

export const ORIENTATION_TOPICS = [
  ['emergency', 'Emergency plan, muster point and nearest hospital'], ['first-aid', 'First aiders, first-aid kit, AED, eyewash'],
  ['hazards', 'Site hazards and restricted areas'], ['ppe', 'PPE rules for this site'], ['flha', 'FLHA every day before work'],
  ['loto', 'Lockout procedure and who holds locks'], ['reporting', 'How to report injuries, near misses and hazards'],
  ['right-to-refuse', 'Right to know, participate and refuse unsafe work'], ['whmis', 'WHMIS: labels, SDS location'],
  ['facilities', 'Washrooms, lunch area, parking, housekeeping'], ['contacts', 'Site supervisor and safety contacts'],
];

/** Is there anything worth showing in the emergency card? */
export function hasEmergencyInfo(js) {
  if (!js) return false;
  return Boolean(js.hospital?.name || js.hospital?.address || js.musterPoint || (js.firstAiders || []).length
    || (js.emergencyContacts || []).length || (js.siteHazards || []).length || js.firstAidKit || js.extinguisher || js.aed);
}

/** Record id of a job's emergency info: one per job, so two devices can't make two. */
export const jobSafetyId = (jobId) => `safety-${jobId}`;

// ---------- photos and signatures ----------

/** Approximate decoded size in bytes of a base64 data URL. */
export const dataUrlBytes = (u) => (typeof u === 'string' && u.includes(',') ? Math.floor(((u.length - u.indexOf(',') - 1) * 3) / 4) : 0);

export const PHOTO_MAX_BYTES = 400 * 1024;
export const SIGNATURE_MAX_BYTES = 60 * 1024;
