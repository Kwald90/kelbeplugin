// "Is this reportable?" by province: who to call, by when, and the workers' compensation
// report. Facts checked 2026-10-19; sources and the VERIFY list are in docs/safety/README.md
// (R-numbers below). `verify: true` marks anything not confirmed on an official page:
// the app shows "check with the regulator" next to it. This is a prompt for a manager,
// not legal advice: when in doubt, call the regulator.
//
// Facts an incident carries (js/schema/incidents.json):
//   medical.treatment: none | first-aid | medical-aid | lost-time | hospital | fatality
//   medical.daysAway, medical.modifiedWork, flags.{ critical, hospital, fatality,
//   dangerousOccurrence, electricalContact, structuralFailure, fire }

/** Facts that drive the rules, from an incident record (managers see medical). */
export function incidentFacts(inc = {}) {
  const m = inc.medical || {};
  const f = inc.flags || {};
  const t = m.treatment || 'none';
  const fatality = Boolean(f.fatality) || t === 'fatality';
  const hospital = Boolean(f.hospital) || t === 'hospital' || fatality;
  const lostTime = t === 'lost-time' || Number(m.daysAway) > 0;
  return {
    fatality,
    critical: Boolean(f.critical) || fatality,
    hospital,
    lostTime,
    modifiedWork: Boolean(m.modifiedWork),
    // Health care beyond first aid: what most boards mean by "medical aid".
    medicalAid: ['medical-aid', 'lost-time', 'hospital', 'fatality'].includes(t) || lostTime || hospital,
    electricalContact: Boolean(f.electricalContact) || inc.category === 'shock' || inc.category === 'arc-flash',
    structuralFailure: Boolean(f.structuralFailure),
    fire: Boolean(f.fire) || inc.category === 'fire',
    dangerousOccurrence: Boolean(f.dangerousOccurrence) || Boolean(f.structuralFailure),
    nearMiss: inc.kind === 'near-miss',
  };
}

const any = (...keys) => (x) => keys.some((k) => x[k]);

/**
 * PROVINCES[code] = {
 *   regulator: { name, phone, url },
 *   notify: [{ id, when(facts), what, timeline, hours (deadline from the occurrence, 0 = immediately), ref, verify? }],
 *   wcb: { name, form, when(facts), what, deadline, businessDays?, days, url, ref, verify? },
 * }
 */
export const PROVINCES = {
  ON: {
    regulator: { name: 'Ministry of Labour, Immigration, Training and Skills Development (MLITSD)', phone: '1-877-202-0008', url: 'https://www.ontario.ca/page/reporting-workplace-incidents-and-illnesses' },
    notify: [
      { id: 'on-51', when: any('fatality', 'critical'), what: 'Death or critical injury: phone the ministry right away, then a written report to the ministry, JHSC/health and safety rep and union. Do not disturb the scene.', timeline: 'Immediately; written report within 48 hours', hours: 0, ref: 'OHSA s.51 (R1)' },
      { id: 'on-53', when: any('dangerousOccurrence', 'structuralFailure', 'fire'), what: 'Prescribed construction occurrences, even with no injury (for example a fall of 3 m or more, loss of control of a crane or load, structural failure).', timeline: 'Written notice within 2 days', hours: 48, ref: 'OHSA s.53; O. Reg. 420/21 (R1)' },
      { id: 'on-52', when: any('medicalAid', 'lostTime'), what: 'Injury needing medical attention or causing lost work: written notice to the JHSC/rep and union.', timeline: 'Within 4 days', hours: 96, ref: 'OHSA s.52(1) (R1)' },
    ],
    wcb: { name: 'WSIB', form: 'Form 7', when: any('medicalAid', 'lostTime', 'modifiedWork'), what: 'Health care beyond first aid, time off, lost earnings, or modified work at less than regular pay.', deadline: '3 business days after you learn of it', days: 3, businessDays: true, url: 'https://www.wsib.ca/en/businesses/claims/report-injury-or-illness', ref: 'R2' },
  },
  BC: {
    regulator: { name: 'WorkSafeBC Prevention Information Line', phone: '1-888-621-7233', url: 'https://www.worksafebc.com/en/health-safety/create-manage/incident-investigations/reporting-incidents-worksafebc' },
    notify: [
      { id: 'bc-68', when: any('fatality', 'critical', 'hospital', 'structuralFailure', 'fire', 'dangerousOccurrence'), what: 'Serious injury or death, major structural failure or collapse (building, crane, hoist, temporary support, excavation), major release of a hazardous substance, dangerous fire or explosion.', timeline: 'Immediately', hours: 0, ref: 'Workers Compensation Act s.68 (R3)' },
      { id: 'bc-inv', when: (x) => true, what: 'Investigate incidents, including near misses that could have caused serious injury: preliminary report, then a full report.', timeline: 'Preliminary within 48 hours; full report within 30 days', hours: 48, ref: 'Workers Compensation Act Part 2, Div. 10 (R3)', verify: true },
    ],
    wcb: { name: 'WorkSafeBC', form: 'Form 7 (Employer\'s Report of Injury)', when: any('medicalAid', 'lostTime'), what: 'Injury needing medical treatment or causing time off, even if you dispute the claim.', deadline: 'Within 3 days of learning of it', days: 3, url: 'https://www.worksafebc.com/en/health-safety/create-manage/incident-investigations/reporting-incidents-worksafebc', ref: 'R3' },
  },
  AB: {
    regulator: { name: 'Alberta OHS Contact Centre', phone: '1-866-415-8690', url: 'https://www.alberta.ca/report-serious-injuries-incident' },
    notify: [
      { id: 'ab-33', when: any('fatality', 'hospital', 'fire', 'structuralFailure', 'dangerousOccurrence'), what: 'Death, admission to hospital (an ER visit alone does not count), unplanned explosion, fire or flood, crane, derrick or hoist collapse or upset, structural collapse or failure. The prime contractor reports.', timeline: 'As soon as possible', hours: 0, ref: 'OHS Act s.33 (R4)' },
      { id: 'ab-psi', when: (x) => x.nearMiss || x.dangerousOccurrence, what: 'Potentially serious incident (could reasonably have caused serious injury): report online and investigate.', timeline: 'As soon as possible', hours: 24, ref: 'OHS Act s.33 (R4)', verify: true },
    ],
    wcb: { name: 'WCB-Alberta', form: 'Employer Report of Injury (C040)', when: any('medicalAid', 'lostTime', 'modifiedWork'), what: 'Treatment beyond first aid, time lost after the day of injury, or modified work.', deadline: 'Within 72 hours of learning of it', days: 3, url: 'https://www.wcb.ab.ca', ref: 'R4', verify: true },
  },
  SK: {
    regulator: { name: 'Saskatchewan OHS Division', phone: '1-800-567-7233', url: 'https://www.saskatchewan.ca/business/safety-in-the-workplace' },
    notify: [
      { id: 'sk-2-2', when: any('fatality', 'hospital'), what: 'Death, or an injury needing hospital admission (the summary says 72 hours or more).', timeline: 'As soon as reasonably possible', hours: 0, ref: 'OHS Regulations, 2020 s.2-2 (R5)', verify: true },
      { id: 'sk-2-3', when: any('dangerousOccurrence', 'structuralFailure', 'fire'), what: 'Dangerous occurrence, with a written report after.', timeline: 'As soon as reasonably possible', hours: 0, ref: 'OHS Regulations, 2020 s.2-3 (R5)', verify: true },
    ],
    wcb: { name: 'WCB Saskatchewan', form: 'Employer\'s Initial Report (E1)', when: any('medicalAid', 'lostTime'), what: 'Injury needing medical attention.', deadline: 'Within 5 days of learning of it', days: 5, url: 'https://www.wcbsask.com/how-report-work-injury', ref: 'R5', verify: true },
  },
  MB: {
    regulator: { name: 'Manitoba Workplace Safety and Health', phone: '1-855-957-7233', url: 'https://www.gov.mb.ca/labour/safety/' },
    notify: [
      { id: 'mb-2-7', when: any('fatality', 'critical', 'hospital', 'electricalContact', 'structuralFailure', 'fire', 'dangerousOccurrence'), what: 'Serious incident: death, injury from electrical contact, unconsciousness, major fractures, amputation, third-degree burns, loss of sight, and other prescribed events. Preserve the scene.', timeline: 'Immediately, by the fastest means', hours: 0, ref: 'WSH Regulation 217/2006 ss.2.6-2.7 (R6)', verify: true },
    ],
    wcb: { name: 'WCB Manitoba', form: 'Employer Incident Report', when: any('medicalAid', 'lostTime'), what: 'Time lost or medical care.', deadline: 'Within 5 business days', days: 5, businessDays: true, url: 'https://www.wcb.mb.ca/report-an-injury', ref: 'R6' },
  },
  NB: {
    regulator: { name: 'WorkSafeNB', phone: '1-800-999-9775', url: 'https://www.worksafenb.ca/employers/health-safety/report-an-injury-or-illness/' },
    notify: [
      { id: 'nb-43', when: any('fatality', 'critical', 'hospital', 'fire', 'dangerousOccurrence', 'structuralFailure'), what: 'Unconsciousness, fracture (not fingers or toes), burn needing medical care, loss of vision, deep cut, amputation, hospital admission, death, explosion or catastrophic event.', timeline: 'Immediately', hours: 0, ref: 'OHS Act s.43 (R7)', verify: true },
    ],
    wcb: { name: 'WorkSafeNB', form: 'Form 67 (e-form E67)', when: any('medicalAid', 'lostTime'), what: 'Lost time or health care beyond first aid.', deadline: 'Within 3 days', days: 3, url: 'https://www.worksafenb.ca/employers/health-safety/report-an-injury-or-illness/', ref: 'R7', verify: true },
  },
  NS: {
    regulator: { name: 'Nova Scotia OHS Division', phone: '1-800-952-2687', url: 'https://novascotia.ca/lae/healthandsafety/' },
    notify: [
      { id: 'ns-fatal', when: any('fatality'), what: 'Fatality.', timeline: 'Immediately', hours: 0, ref: 'OHS Act s.63 (R8)' },
      { id: 'ns-serious', when: any('critical', 'hospital', 'structuralFailure', 'fire', 'dangerousOccurrence'), what: 'Serious injury (unconsciousness, fractures, amputation, third-degree burns, hospital admission) or serious incident (explosion, major structural failure, hazardous release, fall from a height needing fall protection).', timeline: 'Within 24 hours', hours: 24, ref: 'OHS Act s.63 (R8)' },
    ],
    wcb: { name: 'WCB Nova Scotia', form: 'Injury Report (MyAccount)', when: any('medicalAid', 'lostTime'), what: 'Lost time or medical treatment. The WCB must receive it in time.', deadline: 'Received within 2 business days', days: 2, businessDays: true, url: 'https://www.wcb.ns.ca/employers/claims-process/if-injury-happens', ref: 'R8' },
  },
  PE: {
    regulator: { name: 'WCB PEI OHS Division (24/7 emergency line)', phone: '902-628-7513', url: 'https://www.wcb.pe.ca' },
    notify: [
      { id: 'pe-serious', when: any('fatality', 'critical', 'hospital', 'fire'), what: 'Serious injury (unconsciousness, fracture, amputation, heavy bleeding, major burn, loss of sight), fatality or explosion.', timeline: 'Immediately', hours: 0, ref: 'OHS Act and General Regulations (R9)', verify: true },
    ],
    wcb: { name: 'WCB PEI', form: 'Form 7 (Employer\'s Report)', when: any('medicalAid', 'lostTime'), what: 'Lost time or health care beyond first aid.', deadline: 'Within 3 days of being notified', days: 3, url: 'https://www.wcb.pe.ca/employers/ReportingAnInjury', ref: 'R9', verify: true },
  },
  NL: {
    regulator: { name: 'NL OHS Division (24-hour line)', phone: '1-800-563-5471', url: 'https://www.gov.nl.ca/dgsnl/occupational-health-and-safety/' },
    notify: [
      { id: 'nl-serious', when: any('fatality', 'critical', 'hospital'), what: 'Serious injury or death: phone right away and tell the committee or rep; then a written report.', timeline: 'Immediately; written report within 3 days (5 for a death)', hours: 0, ref: 'OHS Act and Regulations, NLR 5/12 (R10)', verify: true },
    ],
    wcb: { name: 'WorkplaceNL', form: 'Form 7 (via Connect)', when: any('medicalAid', 'lostTime'), what: 'Lost time or health care beyond first aid.', deadline: 'Within 3 days (72 hours)', days: 3, url: 'https://workplacenl.ca/employers/report-a-workplace-injury/', ref: 'R10', verify: true },
  },
};

export const COVERED = Object.keys(PROVINCES);

/** Add `n` days to an ISO timestamp, skipping Saturdays and Sundays when `business` (holidays not counted). */
export function addReportDays(iso, n, business = false) {
  const d = new Date(iso);
  if (!business) { d.setDate(d.getDate() + n); return d.toISOString(); }
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString();
}

/**
 * What to report for an incident in a province.
 * @returns {{ province, covered: boolean, regulator, notify: object[], wcb: object|null, any: boolean, verify: boolean }}
 *   notify[i].dueAt: ISO deadline (occurredAt + hours; "immediately" = occurredAt).
 *   wcb.dueAt: from when the employer learned of it (reportedAt, else occurredAt).
 */
export function reportableFor(incident, province) {
  const p = PROVINCES[province];
  if (!p) return { province, covered: false, regulator: null, notify: [], wcb: null, any: false, verify: true };
  const x = incidentFacts(incident);
  const occurred = incident?.occurredAt || incident?.reportedAt || new Date().toISOString();
  const learned = incident?.reportedAt || occurred;
  const notify = p.notify.filter((r) => r.when(x)).map(({ when, ...r }) => ({ ...r, dueAt: new Date(new Date(occurred).getTime() + r.hours * 3_600_000).toISOString() }));
  const wcb = p.wcb.when(x) ? (({ when, ...w }) => ({ ...w, dueAt: addReportDays(learned, w.days, w.businessDays) }))(p.wcb) : null;
  // BC's "investigate every incident" rule alone doesn't make an incident reportable.
  const urgent = notify.filter((r) => r.id !== 'bc-inv');
  return {
    province, covered: true, regulator: p.regulator, notify, wcb,
    any: urgent.length > 0 || Boolean(wcb),
    verify: notify.some((r) => r.verify) || Boolean(wcb?.verify),
  };
}
