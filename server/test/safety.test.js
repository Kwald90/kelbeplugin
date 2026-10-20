// Safety collections: the generated migration, who may write what, medical details hidden
// from non-managers (and kept on their writes), and tenant isolation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';
import { collectionDef } from '../src/collections.js';
import { permsForRole } from '../src/auth/permissions.js';
import { canRead, canWrite, checkWriteRules, redactForReader, restoreHiddenFields } from '../src/auth/access.js';
import { generateLater, laterFile } from '../scripts/gen-collections-sql.js';
import { COLLECTION_FEATURES } from '../src/services/entitlements.js';
import { hasFeature } from '../../electrical-app/js/plans.js';

const SAFETY = ['flhas', 'toolboxTalks', 'incidents', 'correctiveActions', 'safetyInspections', 'siteOrientations', 'jobSafety'];
const p = (role, extra = {}) => ({ kind: 'session', role, perms: permsForRole(role), isManager: ['owner', 'admin', 'office', 'foreman'].includes(role), employeeId: 'e1', scopes: null, ...extra });
const MED = { injured: true, injuryType: 'Burn (thermal)', bodyParts: ['Hand'], treatment: 'medical-aid' };

describe('safety contracts (no database)', () => {
  test('migration 0110 matches the generator and adds every safety table', () => {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const sql = norm(readFileSync(laterFile('0110'), 'utf8'));
    assert.equal(sql, norm(generateLater('0110')));
    for (const c of SAFETY) {
      const t = collectionDef(c).table;
      assert.match(sql, new RegExp(`CREATE TABLE ${t} \\(`), t);
      assert.match(sql, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`), t);
      assert.equal(collectionDef(c).migration, '0110');
    }
  });

  test('every role can read and file safety records; safety is in every plan', () => {
    for (const role of ['owner', 'admin', 'office', 'foreman', 'electrician', 'apprentice']) {
      assert.ok(permsForRole(role).has('safety'), role);
      for (const c of ['flhas', 'toolboxTalks', 'incidents', 'correctiveActions', 'safetyInspections', 'jobSafety']) assert.ok(canRead(p(role), c), `${role} reads ${c}`);
      assert.ok(canWrite(p(role), 'incidents'), `${role} files incidents`);
    }
    assert.ok(!canWrite(p('apprentice'), 'jobSafety'), 'emergency info is manager-written');
    assert.ok(!canWrite(p('electrician'), 'siteOrientations'));
    for (const c of SAFETY) assert.deepEqual(COLLECTION_FEATURES[c], ['safety']);
    assert.ok(hasFeature('starter', 'safety'));
  });

  test('non-managers: own FLHA, own signature, own report, own action', () => {
    const el = p('electrician');
    assert.equal(checkWriteRules(el, 'flhas', null, { employeeId: 'e1' }), null);
    assert.ok(checkWriteRules(el, 'flhas', null, { employeeId: 'e2' }));
    assert.ok(checkWriteRules(el, 'flhas', { employeeId: 'e1' }, { employeeId: 'e1', review: { by: 'e1' } }), 'cannot review');
    assert.equal(checkWriteRules(p('foreman'), 'flhas', { employeeId: 'e2' }, { employeeId: 'e2', review: { by: 'e1' } }), null);
    assert.ok(checkWriteRules(el, 'flhas', { employeeId: 'e1' }, null), 'cannot delete');

    const talk = { title: 'LOTO', attendees: [{ employeeId: 'e2', name: 'B' }] };
    assert.equal(checkWriteRules(el, 'toolboxTalks', talk, { ...talk, attendees: [...talk.attendees, { employeeId: 'e1', name: 'A' }] }), null);
    assert.ok(checkWriteRules(el, 'toolboxTalks', talk, { ...talk, attendees: [...talk.attendees, { employeeId: 'e3' }] }), 'only for yourself');
    assert.ok(checkWriteRules(el, 'toolboxTalks', talk, { ...talk, attendees: [] }), 'cannot remove signatures');
    assert.ok(checkWriteRules(el, 'toolboxTalks', talk, { ...talk, title: 'x' }));
    assert.ok(checkWriteRules(el, 'toolboxTalks', null, talk), 'cannot schedule');

    const inc = { kind: 'incident', reportedBy: 'e1', status: 'reported' };
    assert.equal(checkWriteRules(el, 'incidents', null, inc), null);
    assert.ok(checkWriteRules(el, 'incidents', null, { ...inc, reportedBy: 'e2' }));
    assert.equal(checkWriteRules(el, 'incidents', inc, { ...inc, photos: [{ id: 'p' }] }), null);
    assert.ok(checkWriteRules(el, 'incidents', inc, { ...inc, status: 'closed' }));
    assert.ok(checkWriteRules(el, 'incidents', inc, { ...inc, investigation: { whys: ['a'] } }));
    assert.ok(checkWriteRules(el, 'incidents', { ...inc, reportedBy: 'e2' }, { ...inc, reportedBy: 'e2', photos: [] }));
    assert.ok(checkWriteRules(el, 'incidents', { ...inc, status: 'investigating' }, { ...inc, status: 'investigating', description: 'x' }));

    const act = { title: 'Fix ladder', ownerId: 'e1', status: 'open' };
    assert.equal(checkWriteRules(el, 'correctiveActions', act, { ...act, status: 'done', doneAt: 'x', doneBy: 'e1', evidence: [{ id: 'p' }] }), null);
    assert.ok(checkWriteRules(el, 'correctiveActions', act, { ...act, status: 'verified' }));
    assert.ok(checkWriteRules(el, 'correctiveActions', act, { ...act, ownerId: 'e2' }));
    assert.ok(checkWriteRules(el, 'correctiveActions', { ...act, ownerId: 'e2' }, { ...act, ownerId: 'e2', status: 'done' }));
    assert.equal(checkWriteRules(el, 'correctiveActions', null, { title: 'x', createdBy: 'e1', status: 'open', ownerId: null }), null, 'raise from an inspection');
    assert.ok(checkWriteRules(el, 'correctiveActions', null, { title: 'x', createdBy: 'e1', status: 'open', ownerId: 'e2' }), 'cannot assign');

    assert.equal(checkWriteRules(el, 'safetyInspections', null, { inspectorId: 'e1' }), null);
    assert.ok(checkWriteRules(el, 'safetyInspections', { inspectorId: 'e2' }, { inspectorId: 'e2' }));
    assert.ok(checkWriteRules(p('electrician', { employeeId: null }), 'incidents', null, { reportedBy: null }), 'needs an employee link');
  });

  test('medical details: hidden from non-managers and API keys, kept on their writes', () => {
    const rec = { id: 'i1', kind: 'incident', reportedBy: 'e1', medical: MED };
    assert.equal(redactForReader(p('electrician'), 'incidents', rec).medical, undefined);
    assert.equal(redactForReader(p('electrician'), 'incidents', rec).medicalHidden, true);
    assert.equal(redactForReader(p('apprentice'), 'incidents', rec).medical, undefined);
    assert.equal(redactForReader({ kind: 'api_key', perms: new Set(), scopes: ['*:read'] }, 'incidents', rec).medical, undefined);
    assert.deepEqual(redactForReader(p('foreman'), 'incidents', rec).medical, MED);
    assert.deepEqual(redactForReader(p('office'), 'incidents', rec).medical, MED);
    const kept = restoreHiddenFields(p('electrician'), 'incidents', rec, { kind: 'incident', reportedBy: 'e1', medicalHidden: true, photos: [] });
    assert.deepEqual(kept.medical, MED);
    assert.equal('medicalHidden' in kept, false);
    assert.deepEqual(restoreHiddenFields(p('electrician'), 'incidents', null, { medical: MED }).medical, MED, 'the reporter enters it once');
    assert.equal(restoreHiddenFields(p('electrician'), 'incidents', { kind: 'x' }, { medical: { treatment: 'none' } }).medical, undefined, 'cannot add it later');
    assert.equal(restoreHiddenFields(p('owner'), 'incidents', rec, { medical: null }).medical, null, 'managers may change it');
  });
});

let t, app, A, B, el, ap, fm;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
async function pullAll(token) {
  const out = [];
  let since = '0';
  for (let i = 0; i < 50; i++) {
    const r = await call(app, { url: `/api/v1/sync/pull?since=${since}&limit=1000`, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    out.push(...r.body.changes);
    since = r.body.cursor;
    if (!r.body.more) break;
  }
  return out;
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('safety');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Safety Alpha');
  B = await ownerTenant(t, app, 'Safety Bravo');
  el = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-el' });
  ap = await addMember(t, app, A.tenantId, { role: 'apprentice', employeeId: 'emp-ap' });
  fm = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fm' });
});
after(async () => { await app?.close(); await t?.close(); });

describe('safety over the API', { skip }, () => {
  test('a worker files an incident with medical details; only managers read them back', async () => {
    const r = await push(el.token, [mut({ collection: 'incidents', id: 'inc-1', op: 'upsert', data: { kind: 'incident', reportedBy: 'emp-el', status: 'reported', description: 'Burn from a hot splice', medical: MED, updatedAt: new Date().toISOString() } })]);
    assert.equal(r.body.results[0].status, 'ok', JSON.stringify(r.body));

    const mine = await call(app, { url: '/api/v1/incidents/inc-1', token: el.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.medical, undefined, 'the reporter no longer sees it');
    assert.equal(mine.body.medicalHidden, true);
    const other = await call(app, { url: '/api/v1/incidents/inc-1', token: ap.token });
    assert.equal(other.body.medical, undefined);
    assert.ok(!JSON.stringify(await pullAll(el.token)).includes('Burn (thermal)'), 'pull is redacted');
    const list = await call(app, { url: '/api/v1/incidents', token: ap.token });
    assert.ok(!JSON.stringify(list.body).includes('Burn (thermal)'), 'list is redacted');

    for (const token of [A.token, fm.token]) {
      const m = await call(app, { url: '/api/v1/incidents/inc-1', token });
      assert.deepEqual(m.body.medical, MED);
    }
  });

  test('the reporter edits their own report without wiping medical details, but cannot investigate', async () => {
    const cur = await call(app, { url: '/api/v1/incidents/inc-1', token: el.token });
    const next = { ...cur.body, photos: [{ id: 'ph1', dataUrl: 'data:image/jpeg;base64,AAAA' }], updatedAt: new Date().toISOString() };
    delete next.version;
    const r = await push(el.token, [mut({ collection: 'incidents', id: 'inc-1', op: 'upsert', baseVersion: cur.body.version, data: next })]);
    assert.equal(r.body.results[0].status, 'ok', JSON.stringify(r.body));
    const m = await call(app, { url: '/api/v1/incidents/inc-1', token: A.token });
    assert.deepEqual(m.body.medical, MED, 'medical kept');
    assert.equal(m.body.medicalHidden, undefined, 'read marker not stored');
    assert.equal(m.body.photos.length, 1);

    const close = await call(app, { method: 'PATCH', url: '/api/v1/incidents/inc-1', token: el.token, body: { status: 'closed' } });
    assert.equal(close.status, 403);
    const del = await call(app, { method: 'DELETE', url: '/api/v1/incidents/inc-1', token: el.token });
    assert.equal(del.status, 403);
    const inv = await call(app, { method: 'PATCH', url: '/api/v1/incidents/inc-1', token: fm.token, body: { status: 'investigating', investigation: { whys: ['Splice not covered'] } } });
    assert.equal(inv.status, 200);
    assert.deepEqual(inv.body.medical, MED);
  });

  test('FLHAs, signatures and corrective actions follow the worker rules', async () => {
    const day = '2026-10-19';
    const ok = await push(el.token, [mut({ collection: 'flhas', id: 'f-1', op: 'upsert', data: { employeeId: 'emp-el', jobId: 'j1', date: day, signature: { dataUrl: 'data:image/jpeg;base64,AA', name: 'El' } } })]);
    assert.equal(ok.body.results[0].status, 'ok');
    const forOther = await push(el.token, [mut({ collection: 'flhas', id: 'f-2', op: 'upsert', data: { employeeId: 'emp-ap', date: day } })]);
    assert.equal(forOther.body.results[0].status, 'rejected');
    const rev = await call(app, { method: 'PATCH', url: '/api/v1/flhas/f-1', token: fm.token, body: { review: { by: 'emp-fm', at: new Date().toISOString() } } });
    assert.equal(rev.status, 200);
    const filtered = await call(app, { url: `/api/v1/flhas?employeeId=emp-el&date=${day}`, token: ap.token });
    assert.equal(filtered.body.data.length, 1, 'gen columns filter');

    const talk = await call(app, { method: 'POST', url: '/api/v1/toolboxTalks', token: fm.token, body: { id: 'tt-1', title: 'LOTO', status: 'scheduled', attendees: [] } });
    assert.equal(talk.status, 201);
    const sign = await call(app, { method: 'PATCH', url: '/api/v1/toolboxTalks/tt-1', token: ap.token, body: { attendees: [{ employeeId: 'emp-ap', name: 'Ap', at: new Date().toISOString() }] } });
    assert.equal(sign.status, 200);
    const forge = await call(app, { method: 'PATCH', url: '/api/v1/toolboxTalks/tt-1', token: el.token, body: { attendees: [{ employeeId: 'emp-ap', name: 'Ap' }, { employeeId: 'emp-fm', name: 'Fm' }] } });
    assert.equal(forge.status, 403);
    const sched = await call(app, { method: 'POST', url: '/api/v1/toolboxTalks', token: el.token, body: { title: 'x' } });
    assert.equal(sched.status, 403);

    const act = await call(app, { method: 'POST', url: '/api/v1/correctiveActions', token: fm.token, body: { id: 'ca-1', title: 'Cover splices', ownerId: 'emp-el', status: 'open', dueDate: day } });
    assert.equal(act.status, 201);
    const notMine = await call(app, { method: 'PATCH', url: '/api/v1/correctiveActions/ca-1', token: ap.token, body: { status: 'done' } });
    assert.equal(notMine.status, 403);
    const done = await call(app, { method: 'PATCH', url: '/api/v1/correctiveActions/ca-1', token: el.token, body: { status: 'done', doneBy: 'emp-el', doneAt: new Date().toISOString(), evidence: [{ id: 'e', dataUrl: 'data:image/jpeg;base64,AA' }] } });
    assert.equal(done.status, 200);
    const verify = await call(app, { method: 'PATCH', url: '/api/v1/correctiveActions/ca-1', token: el.token, body: { status: 'verified' } });
    assert.equal(verify.status, 403);
    const js = await call(app, { method: 'POST', url: '/api/v1/jobSafety', token: el.token, body: { id: 'safety-j1', jobId: 'j1', musterPoint: 'Gate' } });
    assert.equal(js.status, 403, 'emergency info is for managers');
  });

  test('another company cannot read or overwrite these records', async () => {
    for (const [coll, id] of [['incidents', 'inc-1'], ['flhas', 'f-1'], ['toolboxTalks', 'tt-1'], ['correctiveActions', 'ca-1']]) {
      const g = await call(app, { url: `/api/v1/${coll}/${id}`, token: B.token });
      assert.equal(g.status, 404, coll);
    }
    const bList = await call(app, { url: '/api/v1/incidents?includeDeleted=true', token: B.token });
    assert.ok(!JSON.stringify(bList.body).includes('hot splice'));
    // B writing the same id makes B's own row; A's stays untouched.
    const w = await push(B.token, [mut({ collection: 'incidents', id: 'inc-1', op: 'upsert', data: { kind: 'near-miss', description: 'B only' } })]);
    assert.equal(w.body.results[0].status, 'ok');
    const a = await call(app, { url: '/api/v1/incidents/inc-1', token: A.token });
    assert.match(a.body.description, /hot splice/);
    assert.deepEqual(a.body.medical, MED);
    assert.ok(!JSON.stringify(await pullAll(B.token)).includes('hot splice'));
  });
});
