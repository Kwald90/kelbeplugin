// Safety: FLHA gate, "same as yesterday", reportable rules by province, inspection due
// dates, dashboard math, CSV and the toolbox talk PDF.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HAZARDS, newFlha, hasFlhaToday, flhaFor, lastFlha, copyFlha, flhaRequired, uncontrolledHazards, addDays, daysBetween,
  openActions, actionState, incidentTrend, flhaCompletion, expiringTraining, trainingMatrix, trainingKind, dashboardStats, dashboardCsv, toCsv,
  hasEmergencyInfo, jobSafetyId,
} from '../js/lib/safety.js';
import { reportableFor, incidentFacts, addReportDays, PROVINCES, COVERED } from '../js/lib/safety-reporting.js';
import { TEMPLATES, newInspection, inspectionResult, nextDueDate, inspectionSchedule, failedItems } from '../js/lib/safety-inspections.js';
import { TOPICS } from '../js/lib/safety-topics.js';
import { talkPdf } from '../js/lib/safety-pdf.js';

const SIG = { dataUrl: 'data:image/jpeg;base64,AAAA', name: 'Sam', at: '2026-10-19T12:00:00Z' };
const flha = (o) => ({ id: o.id || 'f' + Math.random(), employeeId: 'e1', jobId: 'j1', date: '2026-10-19', signature: SIG, stopWork: false, ...o });

describe('FLHA gate: hasFlhaToday', () => {
  test('needs a signed FLHA for that worker, job and day', () => {
    const list = [flha({})];
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19', list), true);
    assert.equal(hasFlhaToday('e2', 'j1', '2026-10-19', list), false, 'another worker');
    assert.equal(hasFlhaToday('e1', 'j2', '2026-10-19', list), false, 'another job');
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-20', list), false, 'another day');
    assert.equal(hasFlhaToday('e1', null, '2026-10-19', list), true, 'no job: any job that day');
  });
  test('drafts and stop-work FLHAs keep the gate shut', () => {
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19', [flha({ signature: null })]), false);
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19', [flha({ stopWork: true })]), false);
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19', [flha({ stopWork: true }), flha({})]), true, 'a later safe FLHA opens it');
  });
  test('accepts the store (anything with list) and bad input', () => {
    const store = { list: (c) => (c === 'flhas' ? [flha({})] : []) };
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19', store), true);
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19'), false);
    assert.equal(hasFlhaToday(null, 'j1', '2026-10-19', [flha({})]), false);
  });
  test('required per job, else the company default', () => {
    assert.equal(flhaRequired({ flhaRequired: true }, {}), true);
    assert.equal(flhaRequired({ flhaRequired: false }, { safety: { flhaRequired: true } }), false);
    assert.equal(flhaRequired(null, { safety: { flhaRequired: true } }), true);
    assert.equal(flhaRequired(null, {}), false);
  });
});

describe('FLHA records', () => {
  test('a new FLHA lists every hazard, unticked', () => {
    const f = newFlha({ employeeId: 'e1', jobId: 'j1', date: '2026-10-19' });
    assert.equal(f.hazards.length, HAZARDS.length);
    assert.ok(f.hazards.every((h) => h.present === false));
    assert.equal(HAZARDS.length, 11);
    for (const id of ['electrical', 'heights', 'confined', 'energized', 'excavation', 'silica', 'weather', 'traffic', 'overhead', 'ladders', 'manual']) assert.ok(HAZARDS.some((h) => h.id === id), id);
  });
  test('same as yesterday copies hazards and PPE but never the signature or review', () => {
    const prev = flha({ id: 'p1', date: '2026-10-18', hazards: [{ id: 'heights', present: true, controls: 'Tie off' }], ppe: ['harness'], review: { by: 'm1', at: 'x' } });
    const list = [prev, flha({ id: 'old', date: '2026-10-10' })];
    assert.equal(lastFlha('e1', 'j1', '2026-10-19', list).id, 'p1');
    const c = copyFlha(prev, '2026-10-19', '2026-10-19T07:00:00Z');
    assert.equal(c.date, '2026-10-19');
    assert.equal(c.signature, null);
    assert.equal(c.review, null);
    assert.equal(c.copiedFrom, 'p1');
    assert.equal(c.recheckedAt, '2026-10-19T07:00:00Z');
    assert.deepEqual(c.hazards, prev.hazards);
    c.hazards[0].controls = 'changed';
    assert.equal(prev.hazards[0].controls, 'Tie off', 'deep copy');
    assert.equal(hasFlhaToday('e1', 'j1', '2026-10-19', [prev, c]), false, 'a copy is not signed');
  });
  test('flhaFor prefers the signed one; uncontrolled hazards are found', () => {
    const list = [flha({ id: 'd', signature: null, updatedAt: '2026-10-19T09:00:00Z' }), flha({ id: 's', updatedAt: '2026-10-19T08:00:00Z' })];
    assert.equal(flhaFor('e1', 'j1', '2026-10-19', list).id, 's');
    assert.equal(uncontrolledHazards({ hazards: [{ id: 'a', present: true, controls: ' ' }, { id: 'b', present: true, controls: 'x' }, { id: 'c', present: false }] }).length, 1);
  });
});

describe('reportable to the regulator and the board', () => {
  const at = '2026-10-19T14:00:00.000Z'; // a Monday
  const inc = (o) => ({ kind: 'incident', occurredAt: at, reportedAt: at, ...o });

  test('every launch province is covered', () => {
    for (const p of ['ON', 'BC', 'AB', 'SK', 'MB', 'NB', 'NS', 'PE', 'NL']) assert.ok(COVERED.includes(p), p);
    for (const p of COVERED) { assert.ok(PROVINCES[p].regulator.phone, p); assert.match(PROVINCES[p].wcb.url, /^https:\/\//, p); }
  });
  test('first aid only: nothing to report anywhere (except BC investigation duty)', () => {
    for (const p of COVERED) {
      const r = reportableFor(inc({ medical: { treatment: 'first-aid' } }), p);
      assert.equal(r.any, false, p);
      assert.equal(r.wcb, null, p);
    }
  });
  test('Ontario: critical injury is immediate (s.51) and WSIB Form 7 in 3 business days', () => {
    const r = reportableFor(inc({ medical: { treatment: 'hospital' }, flags: { critical: true } }), 'ON');
    assert.equal(r.any, true);
    assert.ok(r.notify.some((n) => n.id === 'on-51' && n.hours === 0 && n.dueAt === at));
    assert.equal(r.wcb.form, 'Form 7');
    assert.equal(r.wcb.dueAt.slice(0, 10), '2026-10-22', 'Mon + 3 business days = Thu');
    const fri = reportableFor(inc({ occurredAt: '2026-10-23T14:00:00.000Z', reportedAt: '2026-10-23T14:00:00.000Z', medical: { treatment: 'medical-aid' } }), 'ON');
    assert.equal(fri.wcb.dueAt.slice(0, 10), '2026-10-28', 'Fri + 3 business days = Wed');
    assert.ok(fri.notify.some((n) => n.id === 'on-52'));
    assert.ok(!fri.notify.some((n) => n.id === 'on-51'));
  });
  test('Ontario s.53: a dangerous occurrence with no injury is still reportable', () => {
    const r = reportableFor({ kind: 'near-miss', occurredAt: at, flags: { dangerousOccurrence: true } }, 'ON');
    assert.ok(r.notify.some((n) => n.id === 'on-53' && n.hours === 48));
    assert.equal(r.wcb, null);
  });
  test('BC: serious injury immediately; Form 7 within 3 days', () => {
    const r = reportableFor(inc({ medical: { treatment: 'hospital' } }), 'BC');
    assert.ok(r.notify.some((n) => n.id === 'bc-68'));
    assert.equal(r.wcb.dueAt.slice(0, 10), '2026-10-22');
  });
  test('Alberta: hospital admission is reportable, an ER visit with medical aid only goes to WCB', () => {
    assert.ok(reportableFor(inc({ medical: { treatment: 'hospital' } }), 'AB').notify.some((n) => n.id === 'ab-33'));
    const er = reportableFor(inc({ medical: { treatment: 'medical-aid' } }), 'AB');
    assert.ok(!er.notify.some((n) => n.id === 'ab-33'));
    assert.ok(er.wcb);
  });
  test('Manitoba: electrical contact is a serious incident; Nova Scotia WCB in 2 business days', () => {
    assert.ok(reportableFor(inc({ category: 'shock' }), 'MB').notify.some((n) => n.id === 'mb-2-7'));
    const ns = reportableFor(inc({ medical: { treatment: 'lost-time', daysAway: 2 } }), 'NS');
    assert.equal(ns.wcb.dueAt.slice(0, 10), '2026-10-21');
  });
  test('unverified rules are flagged; unknown provinces say so', () => {
    assert.equal(reportableFor(inc({ flags: { fatality: true } }), 'SK').verify, true);
    const qc = reportableFor(inc({ flags: { fatality: true } }), 'QC');
    assert.equal(qc.covered, false);
  });
  test('facts: fatality implies critical and hospital; lost time implies medical aid', () => {
    const x = incidentFacts({ flags: { fatality: true } });
    assert.ok(x.critical && x.hospital);
    assert.ok(incidentFacts({ medical: { daysAway: 1 } }).medicalAid);
    assert.equal(addReportDays('2026-10-17T12:00:00Z', 1, true).slice(0, 10), '2026-10-19', 'Saturday + 1 business day = Monday');
  });
});

describe('inspections', () => {
  test('templates cover the required equipment', () => {
    for (const id of ['ladder', 'scaffold', 'scissor-lift', 'cords', 'temp-power', 'ppe', 'first-aid', 'extinguisher', 'site']) assert.ok(TEMPLATES.some((t) => t.id === id), id);
  });
  test('result and failed items', () => {
    const i = newInspection(TEMPLATES[0], { date: '2026-10-19', inspectorId: 'e1' });
    assert.equal(inspectionResult(i.items), 'in-progress');
    i.items.forEach((x) => { x.result = 'pass'; });
    i.items[1].result = 'na';
    assert.equal(inspectionResult(i.items), 'pass');
    i.items[2].result = 'fail';
    assert.equal(inspectionResult(i.items), 'fail');
    assert.equal(failedItems(i).length, 1);
  });
  test('due dates and the recurring schedule', () => {
    assert.equal(nextDueDate({ date: '2026-10-01', frequencyDays: 30 }), '2026-10-31');
    assert.equal(nextDueDate({ date: '2026-10-01', frequencyDays: 0 }), null);
    const rows = [
      { templateId: 'extinguisher', assetTag: 'FE-1', date: '2026-09-01', frequencyDays: 30, result: 'pass' },
      { templateId: 'extinguisher', assetTag: 'fe-1 ', date: '2026-09-25', frequencyDays: 30, result: 'pass' },
      { templateId: 'ladder', assetTag: 'L-3', date: '2026-10-17', frequencyDays: 1, result: 'fail' },
      { templateId: 'first-aid', assetTag: 'Van 2', date: '2026-10-01', frequencyDays: 90, result: 'pass' },
      { templateId: 'site', assetTag: '', date: '2026-10-19', frequencyDays: 7, result: 'in-progress' },
    ];
    const s = inspectionSchedule(rows, '2026-10-19');
    assert.equal(s.length, 3, 'same asset collapses; in-progress ignored');
    const ext = s.find((x) => x.templateId === 'extinguisher');
    assert.equal(ext.lastDate, '2026-09-25');
    assert.equal(ext.nextDue, '2026-10-25');
    assert.equal(ext.state, 'ok');
    assert.equal(s.find((x) => x.templateId === 'ladder').state, 'overdue');
    assert.equal(s[0].templateId, 'ladder', 'soonest first');
    assert.equal(inspectionSchedule(rows, '2026-10-23').find((x) => x.templateId === 'extinguisher').state, 'due');
  });
});

describe('dashboard math', () => {
  const today = '2026-10-19';
  test('FLHA completion over scheduled and clocked-in worker-days', () => {
    const schedule = [{ employeeId: 'e1', jobId: 'j1', date: today }, { employeeId: 'e2', jobId: 'j1', date: today }, { employeeId: 'e1', jobId: 'j1', date: '2026-09-01' }];
    const timeEntries = [{ employeeId: 'e3', jobId: 'j2', clockIn: new Date(2026, 9, 19, 7, 0).toISOString() }, { employeeId: 'e1', jobId: 'j1', clockIn: new Date(2026, 9, 19, 7, 5).toISOString() }];
    const flhas = [flha({ employeeId: 'e1', jobId: 'j1', date: today }), flha({ employeeId: 'e3', jobId: 'j2', date: today, signature: null })];
    const r = flhaCompletion({ flhas, schedule, timeEntries, from: addDays(today, -6), to: today });
    assert.equal(r.expected, 3);
    assert.equal(r.done, 1);
    assert.equal(r.pct, 33);
    assert.deepEqual(r.missing.map((m) => m.employeeId).sort(), ['e2', 'e3']);
    assert.equal(flhaCompletion({ from: today, to: today }).pct, null);
  });
  test('incident trend and near-miss ratio', () => {
    const incidents = [
      { kind: 'near-miss', occurredAt: '2026-10-02T12:00:00Z' }, { kind: 'near-miss', occurredAt: '2026-10-03T12:00:00Z' },
      { kind: 'near-miss', occurredAt: '2026-09-03T12:00:00Z' }, { kind: 'incident', occurredAt: '2026-08-15T12:00:00Z' },
      { kind: 'incident', occurredAt: '2025-01-01T12:00:00Z' },
    ];
    const t = incidentTrend(incidents, today, 6);
    assert.deepEqual(t.series.map((s) => s.month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    assert.equal(t.series[5].nearMiss, 2);
    assert.equal(t.nearMiss, 3);
    assert.equal(t.incident, 1);
    assert.equal(t.ratio, 3);
    assert.equal(incidentTrend([], '2026-01-15', 3).series[0].month, '2025-11');
  });
  test('actions, training and the full stats object', () => {
    const actions = [{ status: 'open', dueDate: '2026-10-01' }, { status: 'open', dueDate: '2026-11-01' }, { status: 'done' }, { status: 'verified' }];
    assert.deepEqual({ ...openActions(actions, today), list: undefined }, { open: 2, overdue: 1, list: undefined });
    assert.equal(actionState(actions[0], today), 'overdue');
    assert.equal(actionState(actions[2], today), 'done');
    const certs = [{ employeeId: 'e1', name: 'WHMIS 2015', expiry: '2026-10-10' }, { employeeId: 'e1', name: 'Working at Heights', expiry: '2026-11-01' }, { employeeId: 'e2', name: 'First aid / CPR', expiry: '2028-01-01' }, { employeeId: 'e2', name: 'Licence' }];
    const exp = expiringTraining(certs, today, 30);
    assert.deepEqual(exp.map((c) => c.daysLeft), [-9, 13]);
    assert.equal(trainingKind('CSA Z462 arc flash'), 'arc-flash');
    assert.equal(trainingKind('Elevating work platform'), 'ewp');
    const m = trainingMatrix([{ id: 'e1', name: 'A' }, { id: 'e2', name: 'B', active: false }], certs, today, 'ON');
    assert.equal(m.length, 1);
    assert.equal(m[0].cells.whmis.state, 'expired');
    assert.equal(m[0].cells.wah.state, 'expiring');
    assert.equal(m[0].cells.loto.state, 'missing');
    assert.ok(!trainingMatrix([{ id: 'e1', name: 'A' }], certs, today, 'BC')[0].cells.wah, 'Working at Heights is Ontario only');
    const s = dashboardStats({ today, flhas: [], schedule: [], timeEntries: [], incidents: [{ kind: 'near-miss', occurredAt: '2026-10-05T12:00:00Z' }, { kind: 'incident', occurredAt: '2026-08-01T12:00:00Z' }], actions, inspectionStatus: [{ state: 'overdue' }, { state: 'ok' }], certs });
    assert.equal(s.nearMisses, 1);
    assert.equal(s.incidents, 0, 'August is outside 30 days');
    assert.equal(s.openActions, 2);
    assert.equal(s.overdueInspections, 1);
    assert.equal(s.expiringTraining, 1);
    assert.equal(s.expiredTraining, 1);
    assert.equal(s.from, '2026-09-20');
    const csv = dashboardCsv(s, 'Acme, "Electric"');
    assert.match(csv, /^Safety dashboard,"Acme, ""Electric"""\r\n/);
    assert.match(csv, /Open corrective actions,2\r\n/);
  });
  test('CSV neutralises formulas; dates helpers', () => {
    assert.equal(toCsv([['=1+1', '-3', 'ok']]), "'=1+1,'-3,ok\r\n");
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(daysBetween('2026-10-19', '2026-11-01'), 13);
  });
});

describe('library, emergency info, PDF', () => {
  test('20 toolbox topics with points and questions', () => {
    assert.equal(TOPICS.length, 20);
    assert.equal(new Set(TOPICS.map((t) => t.id)).size, 20);
    for (const t of TOPICS) { assert.ok(t.points.length >= 4, t.id); assert.ok(t.questions.length >= 1, t.id); }
  });
  test('emergency info', () => {
    assert.equal(hasEmergencyInfo(null), false);
    assert.equal(hasEmergencyInfo({ siteHazards: [], firstAiders: [] }), false);
    assert.equal(hasEmergencyInfo({ musterPoint: 'Gate 2' }), true);
    assert.equal(jobSafetyId('abc'), 'safety-abc');
  });
  test('toolbox talk PDF with signatures', () => {
    // A 1x1 JPEG (smallest valid baseline JPEG header for the embedder).
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const bytes = talkPdf({ title: 'Lockout / tagout', date: '2026-10-19', points: ['One lock, one person'], questions: ['Back-feed?'], status: 'held',
      attendees: [1, 2, 3].map((n) => ({ employeeId: `e${n}`, name: `Worker ${n}`, at: '2026-10-19T12:00:00Z', signature: { dataUrl: jpeg } })) }, { company: { name: 'Acme' } });
    const text = Buffer.from(bytes).toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'));
    assert.match(text, /Worker 3/);
    assert.match(text, /\/Subtype \/Image/);
  });
});
