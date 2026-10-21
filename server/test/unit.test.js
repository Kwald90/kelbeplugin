// Checks that need no database: the server's copies of the PWA contracts, the JSON
// Schemas against the PWA's own demo data, crypto, access rules, config and logging.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS, TABLE_COLLECTIONS, collectionDef } from '../src/collections.js';
import { PERMS, ROLES, permsForRole } from '../src/auth/permissions.js';
import { canRead, canWrite, checkWriteRules, mergeChangeOrders, mergeWrite, redactForReader, restoreHiddenFields, reviewMerge, rowFilter, rowVisible, sanitizeForStorage } from '../src/auth/access.js';
import { createValidator, schemaDir } from '../src/schemas.js';
import { createSealer, normaliseRecoveryCode, recoveryCode } from '../src/lib/crypto.js';
import { readConfig } from '../src/config.js';
import { redactUrl } from '../src/logger.js';
import { passwordProblem, pinProblem } from '../src/auth/passwords.js';
import { OUT, generate, outputs } from '../scripts/gen-collections-sql.js';
import { COLLECTION_FEATURES } from '../src/services/entitlements.js';
import { COLLECTIONS as PWA_COLLECTIONS } from '../../electrical-app/js/store.js';
import { PERMS as PWA_PERMS, ROLES as PWA_ROLES } from '../../electrical-app/js/auth.js';

const APP = fileURLToPath(new URL('../../electrical-app/', import.meta.url));
const validator = createValidator();

describe('contracts shared with the PWA', () => {
  test('collections match electrical-app/js/store.js', () => {
    assert.deepEqual(COLLECTIONS, PWA_COLLECTIONS);
  });

  test('roles and permission keys match electrical-app/js/auth.js', () => {
    assert.deepEqual(PERMS, PWA_PERMS);
    assert.deepEqual(Object.keys(ROLES), Object.keys(PWA_ROLES));
    for (const r of Object.keys(ROLES)) assert.deepEqual([...ROLES[r].perms].sort(), [...PWA_ROLES[r].perms].sort(), r);
  });

  test('every collection has a JSON Schema, listed in index.json', () => {
    const files = readdirSync(schemaDir()).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)).sort();
    assert.deepEqual(files, [...COLLECTIONS].sort());
    const index = JSON.parse(readFileSync(`${schemaDir()}index.json`, 'utf8'));
    assert.deepEqual(Object.keys(index.collections).sort(), [...COLLECTIONS].sort());
    for (const c of COLLECTIONS) {
      const s = validator.schemas[c];
      assert.equal(s.additionalProperties, true, `${c} allows extra fields`);
      assert.deepEqual(s.required, ['id']);
    }
  });

  test('the committed collections migrations match their generator', () => {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    assert.equal(norm(readFileSync(OUT, 'utf8')), norm(generate()));
    const all = outputs();
    assert.ok(all.length >= 2, 'later collections get their own migration');
    for (const o of all) assert.equal(norm(readFileSync(o.file, 'utf8')), norm(o.sql), o.name);
    const tables = all.flatMap((o) => [...o.sql.matchAll(/^CREATE TABLE (\w+) \(/gm)].map((m) => m[1]));
    for (const c of TABLE_COLLECTIONS) assert.equal(tables.filter((x) => x === collectionDef(c).table).length, 1, `${c} created exactly once`);
  });

  test('work tasks as the planner and My day store them', () => {
    const task = {
      id: 't1', planId: 'p1', jobId: 'j1', phaseId: 'ph1', phaseName: 'Rough-in', groupId: 'g1', title: 'Mount boxes', description: '', taskType: 'Boxes',
      date: '2026-10-20', baselineDate: '2026-10-20', employeeId: 'e1', order: 0, estHours: 1.25, qty: 10, unit: 'boxes', priority: 'normal',
      requiresPhoto: true, minPhotos: 1, dependsOn: [], link: { kind: 'drawing', id: 'd1', label: 'L2 power', url: '' },
      status: 'done', publishedAt: '2026-10-19T21:00:00.000Z', publishedBy: 'f1', lateAdd: false, seenAt: null, ackAt: '2026-10-20T13:00:00.000Z', ackVia: 'meeting',
      startedAt: '2026-10-20T14:00:00.000Z', completedAt: '2026-10-20T20:00:00.000Z', actualHours: 1.5, qtyDone: 10, note: '',
      blocks: [{ reason: 'Waiting on material', note: '', at: '2026-10-20T15:00:00.000Z', resolvedAt: '2026-10-20T16:00:00.000Z', by: 'e1' }],
      photos: [{ id: 'p', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(400_000), takenAt: '2026-10-20T20:00:00.000Z', width: 1280, height: 960 }],
      reopens: [], evidenceWaived: null, progressAt: '2026-10-20T20:00:00.000Z', progressBy: 'e1',
    };
    assert.equal(validator.validate('workTasks', task), null);
    const six = { ...task, photos: Array.from({ length: 6 }, () => task.photos[0]) };
    assert.equal(validator.validate('workTasks', six), null);
    assert.ok(Buffer.byteLength(JSON.stringify(six)) < collectionDef('workTasks').maxBytes);
    assert.notEqual(validator.validate('workTasks', { ...task, photos: Array.from({ length: 7 }, () => task.photos[0]) }), null, 'six photos at most');
    assert.notEqual(validator.validate('workTasks', { ...task, status: 'finished' }), null);
    assert.notEqual(validator.validate('workTasks', { ...task, link: { kind: 'url', url: 'javascript:alert(1)' } }), null);
    assert.notEqual(validator.validate('workTasks', { ...task, photos: [{ id: 'p', dataUrl: 'https://example.com/x.jpg' }] }), null);
    assert.equal(validator.validate('workPlans', {
      id: 'p1', jobId: 'j1', name: 'Main', startDate: '2026-10-19', endDate: '2026-12-04', skipWeekends: true, holidays: ['2026-11-11'], dayHours: 8, crewIds: ['e1'],
      phases: [{ id: 'ph1', name: 'Rough-in', order: 0 }], published: { '2026-10-19': { at: '2026-10-18T21:00:00.000Z', by: 'f1' } }, status: 'active', notes: '',
    }), null);
    assert.equal(validator.validate('huddles', { id: 'h1', date: '2026-10-20', planIds: ['p1'], startedAt: '2026-10-20T13:00:00.000Z', ledBy: 'f1', attendees: [{ employeeId: 'e1', ackAt: '2026-10-20T13:05:00.000Z' }] }), null);
    assert.equal(validator.validate('taskTemplates', { id: 'tt1', name: 'Mount boxes', unit: 'boxes', ratePerHour: 8, requiresPhoto: true, minPhotos: 1 }), null);
  });

  test('every record of the PWA demo seed passes its schema', async () => {
    // seed.js takes today() from ui.js, which needs a DOM: swap that import for a stand-in.
    // Its other imports are DOM-free libs; point them at absolute file URLs, since a
    // data: module can't resolve './' specifiers.
    const base = new URL('../../electrical-app/js/', import.meta.url);
    const src = readFileSync(`${APP}js/seed.js`, 'utf8')
      .replace(/import \{ today \} from '\.\/ui\.js';/,
        "const today = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };")
      .replace(/from '(\.\/[^']+)'/g, (_, p) => `from '${new URL(p, base).href}'`);
    assert.ok(!/ui\.js'/.test(src), 'seed.js imports more from ui.js; update this test');
    const { seedIfEmpty } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
    const data = new Map();
    const bucket = (c) => { if (!data.has(c)) data.set(c, new Map()); return data.get(c); };
    const now = () => new Date().toISOString();
    const store = {
      isEmpty: () => true,
      add(c, f) { const r = { ...structuredClone(f), id: f.id || randomUUID(), createdAt: now(), updatedAt: now() }; bucket(c).set(r.id, r); return structuredClone(r); },
      update(c, id, p) { const r = { ...bucket(c).get(id), ...structuredClone(p), id, updatedAt: now() }; bucket(c).set(id, r); return structuredClone(r); },
      settings() { return structuredClone(bucket('settings').get('settings') || { id: 'settings', nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 } }); },
      saveSettings(p) { if (!bucket('settings').has('settings')) bucket('settings').set('settings', { id: 'settings', createdAt: now(), nextNumbers: { job: 1001, estimate: 2001, invoice: 3001 } }); return this.update('settings', 'settings', p); },
      nextNumber(kind) { const s = this.settings(); const n = s.nextNumbers[kind]; this.update('settings', 'settings', { nextNumbers: { ...s.nextNumbers, [kind]: n + 1 } }); return `${kind[0].toUpperCase()}-${n}`; },
      log() {},
    };
    assert.equal(seedIfEmpty(store), true);
    let checked = 0;
    for (const [c, rows] of data) {
      for (const r of rows.values()) {
        const errors = validator.validate(c, r);
        assert.equal(errors, null, `${c}/${r.id}: ${JSON.stringify(errors)}`);
        checked++;
      }
    }
    assert.ok(checked > 50, `checked ${checked} records`);
  });

  test('wire runs as the wire-runs screen stores them', () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(4_800_000);
    const run = {
      id: 'r1', name: 'Kitchen home run', jobId: null, drawingId: null, location: '', wiringMethod: 'cable', conduit: null,
      segments: [{ id: 's1', label: 'Panel to J-box', lengthM: 7.4, source: 'ar', note: '', points: [{ x: 0, y: 0, z: 0 }, { x: 7.4, y: 0, z: 0 }] }],
      allowances: { drops: [{ label: 'Wall drop', count: 3, lengthM: 2.4 }], boxCount: 4, boxMakeupM: 0.3, panelMakeupM: 1, wastePct: 10 },
      conductors: [{ id: 'c1', description: 'NMD90 14/2', size: '14/2', material: 'cu', type: 'NMD90', count: 1, itemId: null }],
      photos: [{ id: 'p1', dataUrl: big, caption: '', takenAt: new Date().toISOString(), width: 1600, height: 1200 }],
      notes: '', totalM: 17.6,
    };
    assert.equal(validator.validate('wireRuns', run), null);
    assert.equal(validator.validate('wireRuns', { ...run, wiringMethod: 'conduit', conduit: { type: 'EMT', tradeSize: '21' } }), null);
    assert.ok(Buffer.byteLength(JSON.stringify(run)) < collectionDef('wireRuns').maxBytes);
    assert.notEqual(validator.validate('wireRuns', { ...run, wiringMethod: 'tube' }), null);
  });

  test('new collections follow the BUILD-PLAN enums', () => {
    assert.equal(validator.validate('bends', { id: 'b', kind: 'saddle3', conduit: { type: 'PVC', tradeSize: '27' }, result: { marks: [{ label: 'A', atM: 0.3 }], shrinkM: 0.01, developedLengthM: 1, warnings: [] } }), null);
    assert.notEqual(validator.validate('bends', { id: 'b', conduit: { type: 'EMT', tradeSize: '3/4' } }), null);
    assert.equal(validator.validate('benderProfiles', { id: 'p', conduitType: 'EMT', tradeSize: '21', takeUpM: 0.15, isDefault: true }), null);
    // What the bending screen stores: inputs carry form, units and chart; sizes may arrive as numbers.
    assert.equal(validator.validate('bends', {
      id: 'b2', name: 'Offset', jobId: null, kind: 'offset', conduit: { type: 'EMT', tradeSize: 21 }, benderProfileId: null,
      inputs: { riseM: 0.15, angleDeg: 30, units: 'imperial', form: { measure: 'obstacle', riseM: '6' }, chart: true, futureKey: [1] },
      result: { marks: [{ label: 'Mark 1 · 30°', atM: 0.9 }], shrinkM: 0.04, developedLengthM: null, warnings: ['Check the run.'] }, notes: '',
    }), null);
  });

  test('drawings with rooms, code options, placement and placed boxes', () => {
    const d = {
      id: 'd1', name: 'Main floor', jobId: null, paper: 'grid', scale: 24, layers: [{ id: 'L1', name: 'Plan', visible: true }],
      strokes: [{ id: 's', layer: 'L1', tool: 'pen', points: [[0, 0, 0.5]] }], texts: [],
      objects: [
        { id: 'o1', layer: 'L1', symbol: 'receptacle-gfci', x: 10, y: 20, rotation: 0, scale: 1, roomId: 'r1', auto: true,
          flags: { gfci: true, afci: false, tr: true, wp: false }, mountM: 0.4, rules: ['Counter spacing'], ruleRefs: ['counter'] },
      ],
      rooms: [{ id: 'r1', type: 'kitchen', points: [[0, 0], [100, 0], [100, 80]] }],
      codeOptions: { codeBook: 'CEC-2024', province: 'AB' }, placement: { receptacleHeightM: 0.4 },
      underlay: null, view: { x: 0, y: 0, zoom: 1 }, thumb: null,
    };
    assert.equal(validator.validate('drawings', d), null);
    assert.equal(validator.validate('drawings', { ...d, codeOptions: null, placement: null, rooms: null }), null);
    assert.notEqual(validator.validate('drawings', { ...d, objects: [{ id: 'o', flags: { gfci: 'yes' } }] }), null);
  });
});

describe('access rules', () => {
  const p = (role, extra = {}) => ({ kind: 'session', role, perms: permsForRole(role), isManager: ['owner', 'admin', 'office', 'foreman'].includes(role), employeeId: 'e1', scopes: null, ...extra });

  test('read and write per role', () => {
    assert.ok(canRead(p('apprentice'), 'jobs'));
    assert.ok(!canWrite(p('apprentice'), 'jobs'), 'jobs are manager-written');
    assert.ok(canWrite(p('foreman'), 'jobs'));
    assert.ok(!canRead(p('electrician'), 'invoices'));
    assert.ok(!canRead(p('apprentice'), 'leads'));
    assert.ok(canRead(p('apprentice'), 'settings'));
    assert.ok(!canRead(p('office'), 'auditLog'), 'audit log needs security');
    assert.ok(canRead(p('admin'), 'auditLog'));
    assert.ok(!canWrite(p('owner'), 'auditLog'));
    assert.ok(canWrite(p('electrician'), 'timeEntries'));
    for (const c of TABLE_COLLECTIONS) assert.ok(canRead(p('owner'), c) && canWrite(p('owner'), c), `owner ${c}`);
  });

  test('API key scopes', () => {
    const k = (scopes) => ({ kind: 'api_key', perms: new Set(), scopes });
    assert.ok(canRead(k(['jobs:write']), 'jobs'));
    assert.ok(!canWrite(k(['jobs:read']), 'jobs'));
    assert.ok(canWrite(k(['*:write']), 'invoices'));
    assert.ok(!canRead(k(['jobs:read']), 'clients'));
    assert.equal(rowFilter(k(['*:read']), 'timeEntries'), null);
  });

  test('own rows, approvals, SOP acknowledgements, settings numbers', () => {
    const el = p('electrician');
    assert.deepEqual(rowFilter(el, 'timeEntries'), { column: 'employee_id', value: 'e1' });
    assert.equal(rowFilter(p('foreman'), 'timeEntries'), null);
    assert.equal(checkWriteRules(el, 'timeEntries', null, { employeeId: 'e1' }), null);
    assert.ok(checkWriteRules(el, 'timeEntries', null, { employeeId: 'e2' }));
    assert.ok(checkWriteRules(el, 'timeEntries', { employeeId: 'e1', approved: false }, { employeeId: 'e1', approved: true }));
    assert.ok(checkWriteRules(p('electrician', { employeeId: null }), 'timeEntries', null, { employeeId: null }));
    const sop = { title: 'LOTO', version: 1, acks: [] };
    assert.equal(checkWriteRules(el, 'sops', sop, { ...sop, acks: [{ employeeId: 'e1', version: 1 }] }), null);
    assert.ok(checkWriteRules(el, 'sops', sop, { ...sop, title: 'x' }));
    assert.ok(checkWriteRules(el, 'sops', null, sop));
    const s = { taxPct: 5, nextNumbers: { job: 1 } };
    assert.equal(checkWriteRules(p('office'), 'settings', s, { ...s, nextNumbers: { job: 2 } }), null);
    assert.ok(checkWriteRules(p('office'), 'settings', s, { ...s, taxPct: 0 }));
    assert.equal(checkWriteRules(p('admin'), 'settings', s, { ...s, taxPct: 0 }), null);
  });

  test('work tasks: own published rows for workers; progress only; evidence for everyone', () => {
    const el = p('electrician');
    const f = rowFilter(el, 'workTasks');
    assert.deepEqual(f, { column: 'employee_id', value: 'e1', exclude: { column: 'status', field: 'status', values: ['draft'] } });
    assert.equal(rowFilter(p('foreman'), 'workTasks'), null);
    const def = collectionDef('workTasks');
    assert.ok(rowVisible(f, { employeeId: 'e1', status: 'todo' }, def));
    assert.ok(!rowVisible(f, { employeeId: 'e1', status: 'draft' }, def));
    assert.ok(!rowVisible(f, { employeeId: 'e2', status: 'todo' }, def));
    assert.ok(canRead(el, 'workTasks') && canWrite(el, 'workTasks'));
    assert.ok(!canRead(el, 'workPlans') && !canWrite(el, 'workPlans') && !canWrite(p('apprentice'), 'taskTemplates'));
    assert.ok(canWrite(p('foreman'), 'workPlans') && canWrite(p('office'), 'huddles'));
    const stored = { employeeId: 'e1', status: 'todo', title: 'Boxes', requiresPhoto: true };
    assert.equal(checkWriteRules(el, 'workTasks', stored, { ...stored, status: 'in-progress' }), null);
    assert.ok(checkWriteRules(el, 'workTasks', stored, { ...stored, title: 'x' }));
    assert.ok(checkWriteRules(el, 'workTasks', null, stored));
    assert.ok(checkWriteRules(el, 'workTasks', stored, { ...stored, status: 'done' }));
    assert.ok(checkWriteRules(p('foreman'), 'workTasks', stored, { ...stored, status: 'done' }));
    assert.ok(checkWriteRules({ kind: 'api_key', perms: new Set(), scopes: ['*:write'] }, 'workTasks', stored, { ...stored, status: 'done' }));
    const merged = mergeWrite(el, 'workTasks', stored, { ...stored, title: 'x', status: 'in-progress', progressAt: 'z' });
    assert.equal(merged.title, 'Boxes');
    assert.equal(merged.status, 'in-progress');
    assert.equal(mergeWrite(el, 'timeEntries', stored, stored), null);
  });

  test('a stale review or approval of a time entry takes only its own fields', () => {
    const flag = { kind: 'off-site', text: '4.2 km from the job site', distanceM: 4200 };
    // The foreman's copy is from before the clock-out; the stored entry has it.
    const stale = { employeeId: 'e1', clockIn: '2026-10-19T13:00:00.000Z', clockOut: null, breakMins: 0, approved: false, flag, updatedAt: '2026-10-19T21:05:00.000Z' };
    const stored = { ...stale, clockOut: '2026-10-19T21:00:00.000Z', breakMins: 30, note: 'done', updatedAt: '2026-10-19T21:00:00.000Z' };
    const review = { ...stale, flag: { ...flag, reviewedAt: '2026-10-19T21:05:00.000Z', reviewedBy: 'emp-f', reviewNote: 'ok' } };
    const out = reviewMerge('timeEntries', stored, review, ['flag']);
    assert.equal(out.clockOut, stored.clockOut, 'the clock-out is kept');
    assert.equal(out.breakMins, 30);
    assert.equal(out.note, 'done');
    assert.deepEqual(out.flag, review.flag);
    assert.equal(out.updatedAt, review.updatedAt);
    const approve = reviewMerge('timeEntries', { ...stored, clockIn: '2026-10-19T13:30:00.000Z' }, { ...stale, clockOut: stored.clockOut, approved: true, approvedAt: 'a', approvedBy: 'emp-f' }, ['approved', 'approvedAt', 'approvedBy']);
    assert.deepEqual([approve.approved, approve.approvedBy, approve.clockIn], [true, 'emp-f', '2026-10-19T13:30:00.000Z'], "the worker's later correction survives the approval");
    assert.equal(reviewMerge('timeEntries', stored, review, ['flag', 'clockOut']), null, 'an edit of the times is a normal write');
    assert.equal(reviewMerge('timeEntries', stored, review, null), null, 'a whole-record write is a normal write');
    assert.equal(reviewMerge('jobs', stored, review, ['flag']), null);
  });

  test('pay rates hidden, PINs never stored', () => {
    assert.equal(redactForReader(p('electrician'), 'employees', { name: 'a', rateCents: 1 }).rateCents, undefined);
    assert.equal(redactForReader(p('office'), 'employees', { name: 'a', rateCents: 1 }).rateCents, 1);
    assert.equal(sanitizeForStorage('employees', { name: 'a', pin: '1234' }).pin, undefined);
  });
});

describe('Release 1 access rules (docs/releases/r1-get-paid.md 2.5-2.10, 4.1, 4.8)', () => {
  const p = (role, extra = {}) => ({ kind: 'session', role, perms: permsForRole(role), isManager: ['owner', 'admin', 'office', 'foreman'].includes(role), employeeId: 'e1', scopes: null, crew: false, actor: { type: 'user', id: 'u1' }, ...extra });
  const sys = (id) => ({ kind: 'system', role: 'owner', perms: permsForRole('owner'), isManager: true, employeeId: null, actor: { type: 'system', id } });
  const msg = (x) => (typeof x === 'object' && x ? x.message : x);

  test('the eight collections: plans, reads and writes', () => {
    assert.ok(canRead(p('electrician'), 'costCodes') && !canWrite(p('electrician'), 'costCodes'));
    assert.ok(canRead(p('apprentice'), 'signatures') && canWrite(p('apprentice'), 'signatures'));
    assert.ok(!canRead(p('electrician'), 'payrollRuns') && canRead(p('foreman'), 'payrollRuns'));
    assert.ok(!canWrite(p('foreman'), 'payrollRuns'), 'payroll runs need the employees permission');
    assert.ok(canWrite(p('electrician'), 'fieldTickets') && canWrite(p('electrician'), 'equipmentUse') && !canWrite(p('electrician'), 'equipment'));
    assert.deepEqual(rowFilter(p('electrician'), 'fieldTickets'), { column: 'employee_id', value: 'e1' });
    assert.equal(rowFilter(p('foreman'), 'fieldTickets'), null);
  });

  test('payroll runs only from the closing route; company rules typed and sourced', () => {
    assert.ok(checkWriteRules(p('owner'), 'payrollRuns', null, { status: 'exported' }));
    assert.ok(checkWriteRules({ kind: 'api_key', perms: new Set(), scopes: ['*:write'] }, 'payrollRuns', null, {}));
    assert.equal(checkWriteRules(sys('closing'), 'payrollRuns', null, { status: 'exported' }), null);
    assert.equal(checkWriteRules(p('office'), 'rules', null, { key: 'pp.MB.paymentDays', province: 'MB', value: 28, status: 'sourced', source: 'MHCA' }), null);
    const bad = checkWriteRules(p('office'), 'rules', null, { key: 'pp.MB.paymentDays', value: 28, status: 'sourced' });
    assert.equal(bad.status, 422);
    assert.match(bad.message, /source/);
  });

  test('signatures: append-only; void by the office in a full session with a reason', () => {
    const sig = { docType: 'fieldTicket', docId: 't1', status: 'valid', signerName: 'A' };
    assert.equal(checkWriteRules(p('electrician'), 'signatures', null, sig), null);
    assert.ok(checkWriteRules(p('electrician'), 'signatures', null, { ...sig, docType: 'estimate' }), 'crews do not sign estimates');
    assert.ok(checkWriteRules(p('office'), 'signatures', sig, { ...sig, signerName: 'B' }));
    assert.ok(checkWriteRules(p('office'), 'signatures', sig, null));
    assert.ok(checkWriteRules(p('foreman'), 'signatures', sig, { ...sig, status: 'void', voidReason: 'wrong job' }));
    assert.match(msg(checkWriteRules(p('office', { crew: true }), 'signatures', sig, { ...sig, status: 'void', voidReason: 'wrong job' })), /full sign-in/);
    assert.equal(checkWriteRules(p('office'), 'signatures', sig, { ...sig, status: 'void', voidReason: 'wrong job' }), null);
    assert.ok(checkWriteRules(p('office'), 'signatures', { ...sig, status: 'void' }, { ...sig, status: 'valid' }));
    assert.equal(checkWriteRules(p('office'), 'signatures', sig, { ...sig }), null, 'an identical copy is no change');
  });

  test('field tickets: crews draft and sign; the office prices, bills and voids; signed content is frozen', () => {
    const t = { employeeId: 'e1', title: 'Move pots', status: 'draft' };
    const el = p('electrician');
    assert.equal(checkWriteRules(el, 'fieldTickets', null, t), null);
    assert.ok(checkWriteRules(el, 'fieldTickets', t, { ...t, status: 'signed' }), 'a signed ticket needs its signature');
    const signed = { ...t, status: 'signed', signatureId: 's1' };
    assert.equal(checkWriteRules(el, 'fieldTickets', t, signed), null);
    assert.match(msg(checkWriteRules(el, 'fieldTickets', signed, { ...signed, title: 'x' })), /cannot change/);
    assert.match(msg(checkWriteRules(p('office'), 'fieldTickets', signed, { ...signed, title: 'x' })), /cannot change/);
    assert.ok(checkWriteRules(el, 'fieldTickets', signed, { ...signed, status: 'priced' }));
    assert.equal(checkWriteRules(p('office'), 'fieldTickets', signed, { ...signed, status: 'priced', changeOrderId: 'co1' }), null);
    assert.match(msg(checkWriteRules(p('office', { crew: true }), 'fieldTickets', signed, { ...signed, status: 'void' })), /full sign-in/);
    assert.ok(checkWriteRules(p('office'), 'fieldTickets', signed, null));
    assert.equal(checkWriteRules(el, 'fieldTickets', t, null), null, 'a draft can be deleted');
  });

  test('plan features of the new collections (contract 2.11): shared ones in every plan', () => {
    for (const c of ['costCodes', 'rules', 'signatures', 'equipment', 'equipmentUse']) assert.equal(COLLECTION_FEATURES[c], null, c);
    assert.deepEqual(COLLECTION_FEATURES.payrollRuns, ['time']);
    assert.deepEqual(COLLECTION_FEATURES.fieldTickets, ['tickets']);
    assert.deepEqual(COLLECTION_FEATURES.stockCounts, ['inventory']);
  });

  test('a void ticket that was signed or refused is kept; a negative payment from an API key must reverse or refund', () => {
    const voided = { employeeId: 'e1', title: 'Move pots', status: 'void', signatureId: 's1' };
    assert.match(msg(checkWriteRules(p('office'), 'fieldTickets', voided, null)), /kept/);
    assert.ok(checkWriteRules(p('office'), 'fieldTickets', { ...voided, signatureId: null, refusal: { by: 'GC', at: 'x' } }, null), 'refused, then voided');
    assert.equal(checkWriteRules(p('office'), 'fieldTickets', { employeeId: 'e1', title: 'Never signed', status: 'void' }, null), null, 'a draft voided by the office can go');
    const key = { kind: 'api_key', perms: new Set(), scopes: ['*:write'] };
    assert.match(msg(checkWriteRules(key, 'payments', null, { invoiceId: 'i1', amountCents: -500, method: 'cheque' })), /reverse an earlier payment/);
    assert.equal(checkWriteRules(key, 'payments', null, { invoiceId: 'i1', amountCents: -500, method: 'cheque', reversesId: 'p1' }), null);
    assert.equal(checkWriteRules(key, 'payments', null, { invoiceId: 'i1', amountCents: -500, method: 'refund' }), null);
    assert.equal(checkWriteRules(sys('qbo'), 'payments', null, { invoiceId: 'i1', amountCents: -500, method: 'cheque' }), null, 'system actors are not held to it');
  });

  test('a job set invoiced needs its checklist; a Manitoba invoice needs its exemption evidence', () => {
    const job = { title: 'J', status: 'complete' };
    assert.equal(checkWriteRules(p('office'), 'jobs', job, { ...job, status: 'invoiced' }).code, 'closeout_required');
    assert.equal(checkWriteRules(p('office'), 'jobs', job, { ...job, status: 'invoiced', closeout: { checkedAt: 'x', open: [] } }), null);
    assert.equal(checkWriteRules(p('office'), 'jobs', job, { ...job, status: 'invoiced', closeout: { checkedAt: 'x', open: ['co_unbilled'], override: { reason: 'too short' } } }).code, 'closeout_required');
    const inv = { status: 'draft', taxProvince: 'MB', taxTreatment: 'gst-only', taxes: [{ id: 'RST', pct: 7, applies: { material: false, labour: false, other: false } }], lines: [{ kind: 'labour', qty: 1, unitCents: 1 }] };
    assert.equal(checkWriteRules(p('office'), 'invoices', inv, { ...inv, status: 'sent' }).code, 'exemption_required');
    assert.equal(checkWriteRules(p('office'), 'invoices', inv, { ...inv, status: 'void' }), null);
    assert.equal(checkWriteRules(sys('qbo'), 'invoices', null, { ...inv, status: 'sent' }), null, 'the QuickBooks pull goes to review instead (9.7)');
    assert.equal(checkWriteRules(p('office'), 'invoices', inv, { ...inv, status: 'sent', taxExemptBasis: 'resale', taxExemptNumber: '1234567' }), null);
  });

  test('an already-sent invoice that drops RST is re-validated, not only on draft→sent', () => {
    const all = { material: true, labour: true, other: true };
    const off = { material: false, labour: false, other: false };
    // Sent, charging GST+RST on the whole contract (the exemption block passed on draft→sent).
    const sent = { status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all',
      taxes: [{ id: 'GST', pct: 5, applies: all }, { id: 'RST', pct: 7, applies: all }], lines: [{ kind: 'labour', qty: 1, unitCents: 1 }] };
    assert.equal(checkWriteRules(p('office'), 'invoices', sent, { ...sent }), null, 'a no-op resave of a sent invoice is fine');
    // Switching the sent invoice to gst-only (RST off) with no evidence must still block.
    const dropped = { ...sent, taxTreatment: 'gst-only', taxes: [{ id: 'GST', pct: 5, applies: all }, { id: 'RST', pct: 7, applies: off }] };
    assert.equal(checkWriteRules(p('office'), 'invoices', sent, dropped).code, 'exemption_required');
    // With the evidence it is accepted.
    assert.equal(checkWriteRules(p('office'), 'invoices', sent, { ...dropped, taxExemptBasis: 'resale', taxExemptNumber: '1234567' }), null);
    // Voiding keeps the treatment editable without the check.
    assert.equal(checkWriteRules(p('office'), 'invoices', sent, { ...dropped, status: 'void' }), null);
  });

  test('server-written fields keep their stored values for devices', () => {
    const s = { closing: { booksThrough: '2026-09-30' }, company: {} };
    assert.deepEqual(restoreHiddenFields(p('owner'), 'settings', s, { ...s, closing: { booksThrough: '2000-01-01' } }).closing, s.closing);
    assert.deepEqual(restoreHiddenFields(sys('closing'), 'settings', s, { ...s, closing: { booksThrough: '2026-10-31' } }).closing, { booksThrough: '2026-10-31' });
    const pay = { amountCents: 1, postedOn: '2026-10-01', late: true };
    assert.equal(restoreHiddenFields(p('office'), 'payments', pay, { ...pay, postedOn: '2026-09-01', late: false }).postedOn, '2026-10-01');
    assert.equal('postedOn' in restoreHiddenFields(p('office'), 'payments', null, { ...pay }), false, 'stamped by the guards on create');
    assert.equal(restoreHiddenFields(p('electrician'), 'fieldTickets', { number: 'T-1001' }, { number: 'T-9' }).number, 'T-1001');
    const client = { name: 'GC', credit: { hold: { on: true }, termsDays: 30 } };
    assert.deepEqual(restoreHiddenFields(p('office'), 'clients', client, { ...client, credit: { termsDays: 45 } }).credit, { termsDays: 45, hold: { on: true } });
    assert.deepEqual(restoreHiddenFields(sys('receivables'), 'clients', client, { ...client, credit: { termsDays: 30, hold: { on: false } } }).credit.hold, { on: false });
    assert.equal(restoreHiddenFields(p('owner'), 'items', { avgCostCents: 5, costCents: 4 }, { avgCostCents: 9, costCents: 4 }).avgCostCents, 5);
    assert.equal(restoreHiddenFields(sys('receiving'), 'items', { avgCostCents: 5 }, { avgCostCents: 9 }).avgCostCents, 9);
  });

  test('a writer without money cannot introduce prices on a brand-new record, not only on edits', () => {
    const fore = p('foreman', { seesMoney: false });
    // A new price-book item: the price and cost the field user sent are dropped.
    const item = restoreHiddenFields(fore, 'items', null, { sku: 'x', priceCents: 1, costCents: 999999 });
    assert.equal('priceCents' in item, false, 'a new item keeps no price from a non-money writer');
    assert.equal('costCents' in item, false);
    assert.equal(item.sku, 'x');
    // A new job's contract value and costing block are dropped.
    const job = restoreHiddenFields(fore, 'jobs', null, { title: 'J', contract: { role: 'prime', valueCents: 5 }, costing: { estCostOverrideCents: 1 } });
    assert.deepEqual(job.contract, { role: 'prime' });
    assert.equal('costing' in job, false);
    // An office writer (who sees money) keeps what they set.
    assert.equal(restoreHiddenFields(p('office'), 'items', null, { sku: 'x', priceCents: 1 }).priceCents, 1);
  });

  test('money: signature snapshots, wages and burden stay with the office', () => {
    const sig = { docType: 'changeOrder', digest: 'a'.repeat(64), snapshot: { v: 1, amountCents: 45000, lines: [{ description: 'x', qty: 1 }], nested: { totalCents: 3 } } };
    const seen = redactForReader(p('electrician'), 'signatures', sig);
    assert.deepEqual(seen.snapshot, { v: 1, lines: [{ description: 'x', qty: 1 }], nested: {} });
    assert.equal(seen.digest, undefined, 'the money-bearing digest is not handed to a field role (it would brute-force the stripped amount)');
    assert.equal(redactForReader(p('office'), 'signatures', sig).digest, 'a'.repeat(64), 'the office keeps the digest');
    assert.equal(redactForReader(p('office'), 'signatures', sig).snapshot.amountCents, 45000);
    const emp = { name: 'a', rateCents: 1, rateHistory: [{ from: 'x', rateCents: 2 }], burden: { vacationPct: 4 } };
    const fore = redactForReader(p('foreman', { seesMoney: true }), 'employees', emp);
    assert.equal(fore.rateHistory, undefined);
    assert.equal(fore.burden, undefined);
    assert.equal(redactForReader(p('office'), 'employees', emp).burden.vacationPct, 4);
    const job = redactForReader(p('electrician'), 'jobs', { contract: { role: 'prime', valueCents: 5 }, costing: { estCostOverrideCents: 1 }, changeOrders: [{ id: 'c', amountCents: 1, estCostCents: 2, title: 't' }] });
    assert.deepEqual(job.contract, { role: 'prime' });
    assert.equal(job.costing, undefined);
    assert.deepEqual(job.changeOrders, [{ id: 'c', title: 't' }]);
  });

  test('change orders merge by id; a signed one is never dropped', () => {
    const a = { id: 'a', title: 'A', updatedAt: '2026-10-20T10:00:00Z' };
    const b = { id: 'b', title: 'B', signatureId: 's' };
    assert.deepEqual(mergeChangeOrders([a, b], [a], {}).map((c) => c.id), ['a', 'b'], 'signed b is kept');
    assert.deepEqual(mergeChangeOrders([a, { id: 'c' }], [a], {}).map((c) => c.id), ['a'], 'a fresh write may drop an unsigned one');
    assert.deepEqual(mergeChangeOrders([a, { id: 'c' }], [a], { stale: true }).map((c) => c.id), ['a', 'c'], 'a stale write keeps what it did not know');
    const newer = { ...a, title: 'A2', updatedAt: '2026-10-20T12:00:00Z' };
    assert.equal(mergeChangeOrders([newer], [a], { stale: true })[0].title, 'A2');
    const job = { title: 'J', updatedAt: '2026-10-20T12:00:00Z', changeOrders: [{ id: 'co4' }] };
    const merged = mergeWrite(p('office'), 'jobs', job, { title: 'old', updatedAt: '2026-10-20T09:00:00Z', changeOrders: [{ id: 'co3', signatureId: 's3' }] }, { stale: true });
    assert.equal(merged.title, 'J');
    assert.deepEqual(merged.changeOrders.map((c) => c.id), ['co3', 'co4']);
    assert.equal(mergeWrite(p('office'), 'jobs', job, { ...job, title: 'x' }, { stale: false }), null);
  });

  test('the office edits the Release 1 settings on its own screens, nothing else', () => {
    const s = { taxPct: 5, costing: { annualHours: 2000 }, collections: { holdAfterDays: 60 } };
    assert.equal(checkWriteRules(p('office'), 'settings', s, { ...s, collections: { holdAfterDays: 90 } }), null);
    assert.equal(checkWriteRules(p('office'), 'settings', s, { ...s, costing: { annualHours: 1800 } }), null);
    assert.ok(checkWriteRules(p('office'), 'settings', s, { ...s, taxPct: 7 }));
    assert.ok(checkWriteRules(p('foreman'), 'settings', s, { ...s, costing: { annualHours: 1 } }));
  });
});

describe('crypto, config, logging, input rules', () => {
  test('sealing round-trips and detects tampering', () => {
    const s = createSealer(randomBytes(32).toString('base64'));
    const sealed = s.seal('mfa', 'JBSWY3DPEHPK3PXP', 'user-1');
    assert.equal(s.open('mfa', sealed, 'user-1'), 'JBSWY3DPEHPK3PXP');
    assert.equal(s.open('mfa', sealed, 'user-2'), null, 'bound to its context');
    assert.equal(s.open('oidc', sealed, 'user-1'), null, 'bound to its purpose');
    const parts = sealed.split('.');
    parts[2] = Buffer.from('x'.repeat(16)).toString('base64url');
    assert.equal(s.open('mfa', parts.join('.'), 'user-1'), null);
    const env = s.envelopeSeal('sk_live_123', 't1:stripe');
    assert.ok(!env.includes('sk_live_123'));
    assert.equal(s.envelopeOpen(env, 't1:stripe'), 'sk_live_123');
    assert.throws(() => s.envelopeOpen(env, 't2:stripe'));
    const other = createSealer(randomBytes(32).toString('base64'));
    assert.throws(() => other.envelopeOpen(env, 't1:stripe'));
  });

  test('recovery codes normalise', () => {
    const c = recoveryCode();
    assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(normaliseRecoveryCode(c.toLowerCase().replace(/-/g, ' ')), c.replace(/-/g, ''));
  });

  test('config: capacitor origin always allowed; deployed environments need a real master key', () => {
    const c = readConfig({ APP_ENV: 'local' });
    assert.ok(c.corsOrigins.includes('capacitor://localhost'));
    assert.equal(c.port, 3410);
    assert.throws(() => readConfig({ APP_ENV: 'staging', DATABASE_URL: 'postgres://x' }), /SECRETS_MASTER_KEY/);
    assert.throws(() => readConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://x', SECRETS_MASTER_KEY: 'c2hvcnQ=' }), /32 bytes/);
    const prod = readConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://x', SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), PUBLIC_ORIGIN: 'https://app.fishtapehq.com' });
    assert.equal(prod.secureCookies, true);
    assert.throws(() => readConfig({ APP_ENV: 'qa' }), /APP_ENV/);
  });

  test('config: the status page origin (STATUS_PUBLIC_URL) may call the API, odd values add nothing', () => {
    const base = { APP_ENV: 'local', PUBLIC_ORIGIN: 'https://app.fishtapehq.com', CORS_ORIGINS: 'https://fishtapehq.com' };
    assert.ok(readConfig({ ...base, STATUS_PUBLIC_URL: 'https://status.fishtapehq.com/' }).corsOrigins.includes('https://status.fishtapehq.com'));
    assert.ok(readConfig({ ...base, STATUS_PUBLIC_URL: 'https://status.fishtapehq.com/#x' }).corsOrigins.includes('https://status.fishtapehq.com'));
    const plain = readConfig(base).corsOrigins;
    for (const v of ['', 'http://evil.test/', 'javascript:alert(1)', 'not a url']) {
      assert.deepEqual(readConfig({ ...base, STATUS_PUBLIC_URL: v }).corsOrigins, plain, v);
    }
  });

  test('secret query values are stripped from logged URLs', () => {
    assert.equal(redactUrl('/api/v1/auth/oidc/google/callback?code=abc&state=def&x=1'), '/api/v1/auth/oidc/google/callback?code=[REDACTED]&state=[REDACTED]&x=1');
  });

  test('password and PIN rules', () => {
    assert.ok(passwordProblem('short'));
    assert.ok(passwordProblem('aaaaaaaaaaaaaaaa'));
    assert.ok(passwordProblem('me@example.test', 'me@example.test'));
    assert.equal(passwordProblem('correct horse battery'), null);
    assert.ok(pinProblem('12'));
    assert.ok(pinProblem('0000'));
    assert.ok(pinProblem('12a4'));
    assert.equal(pinProblem('4826'), null);
  });
});
