// Checks that need no database: the server's copies of the PWA contracts, the JSON
// Schemas against the PWA's own demo data, crypto, access rules, config and logging.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS, TABLE_COLLECTIONS, collectionDef } from '../src/collections.js';
import { PERMS, ROLES, permsForRole } from '../src/auth/permissions.js';
import { canRead, canWrite, checkWriteRules, redactForReader, rowFilter, sanitizeForStorage } from '../src/auth/access.js';
import { createValidator, schemaDir } from '../src/schemas.js';
import { createSealer, normaliseRecoveryCode, recoveryCode } from '../src/lib/crypto.js';
import { readConfig } from '../src/config.js';
import { redactUrl } from '../src/logger.js';
import { passwordProblem, pinProblem } from '../src/auth/passwords.js';
import { OUT, generate } from '../scripts/gen-collections-sql.js';
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

  test('the committed collections migration matches its generator', () => {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    assert.equal(norm(readFileSync(OUT, 'utf8')), norm(generate()));
  });

  test('every record of the PWA demo seed passes its schema', async () => {
    // seed.js imports only today() from ui.js (which needs a DOM); swap that one import.
    const src = readFileSync(`${APP}js/seed.js`, 'utf8').replace(
      /import \{ today \} from '\.\/ui\.js';/,
      "const today = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };");
    assert.ok(!/^import /m.test(src), 'seed.js gained another import; update this test');
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

  test('pay rates hidden, PINs never stored', () => {
    assert.equal(redactForReader(p('electrician'), 'employees', { name: 'a', rateCents: 1 }).rateCents, undefined);
    assert.equal(redactForReader(p('office'), 'employees', { name: 'a', rateCents: 1 }).rateCents, 1);
    assert.equal(sanitizeForStorage('employees', { name: 'a', pin: '1234' }).pin, undefined);
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
