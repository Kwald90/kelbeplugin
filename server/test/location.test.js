// Location while clocked in, on the server: raw points reach only the person they belong to
// (REST, sync and the database itself, managers included), API keys never reach them, consent is
// only ever given by the person, approved time is locked, retention empties old points and old
// clock-in coordinates, and the live crew map is off unless the company turns it on.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, apiKey, call, ownerTenant, startApp } from './support/app.js';
import { purgeLocationAll, LOCATION_HANDLERS } from '../src/services/location.js';

let t, app, A, B, foreman, w1, w2, keyA;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = async (token, mutations) => (await call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } })).body.results;
const pushOne = async (token, m) => (await push(token, [mut(m)]))[0];
const iso = (minsAgo = 0) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const DAY = 24 * 60;
const point = (emp, o = {}) => ({ employeeId: emp, timeEntryId: `te-${emp}`, at: iso(5), lat: 49.8951, lng: -97.1384, accuracyM: 12, source: 'clock-in', ...o });

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

/** Count location rows as the database sees them for one member (RLS only, no app filter). */
async function rlsCount(tenantId, userId, scope = '') {
  const c = await t.appPool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.location_scope', $3, true)", [tenantId, userId || '', scope]);
    const r = await c.query('SELECT employee_id FROM location_points WHERE deleted_at IS NULL ORDER BY employee_id');
    await c.query('ROLLBACK');
    return r.rows.map((x) => x.employee_id);
  } finally { c.release(); }
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('location');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Loc Co A');
  B = await ownerTenant(t, app, 'Loc Co B');
  for (const [id, name, role] of [['emp-f', 'Fran Foreman', 'foreman'], ['emp-1', 'Jackson Pike', 'electrician'], ['emp-2', 'Manny Ortiz', 'apprentice']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-f' });
  w1 = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-1' });
  w2 = await addMember(t, app, A.tenantId, { role: 'apprentice', employeeId: 'emp-2' });
  keyA = await apiKey(app, A.token, ['*:write']);
  for (const [tok, emp] of [[w1.token, 'emp-1'], [w2.token, 'emp-2'], [foreman.token, 'emp-f']]) {
    const r = await pushOne(tok, { collection: 'locationPoints', id: `p-${emp}`, op: 'upsert', data: point(emp) });
    assert.equal(r.status, 'ok', JSON.stringify(r));
  }
});
after(async () => { await app?.close(); await t?.close(); });

describe('raw points belong to one person', { skip }, () => {
  test('each person pulls and lists only their own points; managers and owners too', async () => {
    const own = async (tok) => (await pullAll(tok)).filter((c) => c.collection === 'locationPoints').map((c) => c.id).sort();
    assert.deepEqual(await own(w1.token), ['p-emp-1']);
    assert.deepEqual(await own(w2.token), ['p-emp-2']);
    assert.deepEqual(await own(foreman.token), ['p-emp-f'], 'a foreman sees entries, not crew points');
    assert.deepEqual(await own(A.token), [], 'the owner has no employee record here: no points at all');
    const l = await call(app, { url: '/api/v1/locationPoints?limit=100', token: foreman.token });
    assert.deepEqual(l.body.data.map((x) => x.id), ['p-emp-f']);
    assert.equal((await call(app, { url: '/api/v1/locationPoints/p-emp-1', token: foreman.token })).status, 404);
    assert.equal((await call(app, { url: '/api/v1/locationPoints/p-emp-1', token: A.token })).status, 404);
    assert.equal((await call(app, { url: '/api/v1/locationPoints/p-emp-1', token: w1.token })).status, 200);
  });

  test('row-level security enforces it in the database itself', async () => {
    assert.deepEqual(await rlsCount(A.tenantId, w1.userId), ['emp-1']);
    assert.deepEqual(await rlsCount(A.tenantId, foreman.userId), ['emp-f']);
    assert.deepEqual(await rlsCount(A.tenantId, A.userId), [], 'owner without an employee link');
    assert.deepEqual(await rlsCount(A.tenantId, ''), [], 'no user (an API key or a forgotten context): nothing');
    assert.deepEqual(await rlsCount(B.tenantId, w1.userId), [], 'another company: nothing');
    assert.deepEqual(await rlsCount(A.tenantId, '', 'crew'), ['emp-1', 'emp-2', 'emp-f'], 'the live-map scope reads all of this company');
    // The read-only 'crew' scope cannot write.
    const c = await t.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.location_scope', 'crew', true)", [A.tenantId, foreman.userId]);
      await assert.rejects(c.query("UPDATE location_points SET data = data || '{\"lat\": 0}' WHERE id = 'p-emp-1'"), /row-level security/);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });

  test('nobody records points for someone else, and points never change', async () => {
    const forged = await pushOne(foreman.token, { collection: 'locationPoints', id: 'p-forged', op: 'upsert', data: point('emp-1') });
    assert.equal(forged.status, 'rejected');
    assert.match(forged.error.message, /only ever made by the person/);
    const edit = await pushOne(w1.token, { collection: 'locationPoints', id: 'p-emp-1', op: 'upsert', baseVersion: 1, data: point('emp-1', { lat: 50 }) });
    assert.equal(edit.status, 'rejected');
    const del = await pushOne(w1.token, { collection: 'locationPoints', id: 'p-emp-1', op: 'delete', baseVersion: 1 });
    assert.equal(del.status, 'rejected');
    assert.equal((await pushOne(w1.token, { collection: 'locationPoints', id: 'p-bad', op: 'upsert', data: point('emp-1', { lat: 123 }) })).status, 'rejected', 'schema: latitude range');
  });

  test('API keys never reach location records, whatever their scopes', async () => {
    assert.equal((await call(app, { url: '/api/v1/locationPoints', token: keyA })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/locationConsents', token: keyA })).status, 403);
    assert.ok(!(await pullAll(keyA)).some((c) => c.collection === 'locationPoints' || c.collection === 'locationConsents'));
    assert.equal((await pushOne(keyA, { collection: 'locationPoints', id: 'p-key', op: 'upsert', data: point('emp-1') })).status, 'rejected');
  });

  test('API keys and AI tools get time entries without clock-in coordinates', async () => {
    const entry = { employeeId: 'emp-1', jobId: 'j1', kind: 'work', clockIn: iso(60), clockOut: iso(1), breakMins: 0, approved: false,
      clockInLoc: { lat: 49.9, lng: -97.1, accuracyM: 9, at: iso(60) }, siteCheck: { jobId: 'j1', distanceM: 4200, inside: false }, flag: { kind: 'off-site', distanceM: 4200, text: '4.2 km from the job site' } };
    assert.equal((await pushOne(w1.token, { collection: 'timeEntries', id: 'te-coords', op: 'upsert', data: entry })).status, 'ok');
    const viaKey = await call(app, { url: '/api/v1/timeEntries/te-coords', token: keyA });
    assert.equal(viaKey.status, 200);
    assert.equal(viaKey.body.clockInLoc, undefined);
    assert.equal(viaKey.body.flag.text, '4.2 km from the job site');
    // A key's write keeps the stored coordinates it never saw.
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/timeEntries/te-coords', token: keyA, body: { note: 'checked' } })).status, 200);
    assert.equal((await call(app, { url: '/api/v1/timeEntries/te-coords', token: foreman.token })).body.clockInLoc.lat, 49.9);
  });
});

describe('consent and approvals', { skip }, () => {
  test('only the worker records their consent; managers can read it', async () => {
    const c = { employeeId: 'emp-1', policyVersion: 1, choice: 'granted', at: iso(), via: 'web' };
    assert.equal((await pushOne(w1.token, { collection: 'locationConsents', id: 'lc-emp-1-v1', op: 'upsert', data: c })).status, 'ok');
    const forged = await pushOne(foreman.token, { collection: 'locationConsents', id: 'lc-emp-2-v1', op: 'upsert', data: { ...c, employeeId: 'emp-2' } });
    assert.equal(forged.status, 'rejected');
    assert.equal((await pushOne(foreman.token, { collection: 'locationConsents', id: 'lc-emp-1-v1', op: 'upsert', baseVersion: 1, data: { ...c, choice: 'declined' } })).status, 'rejected');
    const seen = await call(app, { url: '/api/v1/locationConsents', token: foreman.token });
    assert.deepEqual(seen.body.data.map((x) => x.id), ['lc-emp-1-v1']);
    assert.equal((await call(app, { url: '/api/v1/locationConsents', token: w2.token })).body.data.length, 0, 'workers see only their own');
    assert.equal((await pushOne(w1.token, { collection: 'locationConsents', id: 'lc-emp-1-v1', op: 'delete', baseVersion: 1 })).status, 'rejected', 'answers are kept');
  });

  test('approved time is locked for the worker; only a manager reviews a flag', async () => {
    const base = { employeeId: 'emp-1', jobId: 'j1', kind: 'travel', clockIn: iso(300), clockOut: iso(240), breakMins: 0, approved: false };
    assert.equal((await pushOne(w1.token, { collection: 'timeEntries', id: 'te-lock', op: 'upsert', data: base })).status, 'ok');
    const appr = await pushOne(foreman.token, { collection: 'timeEntries', id: 'te-lock', op: 'upsert', baseVersion: 1, data: { ...base, approved: true, approvedAt: iso(), approvedBy: 'emp-f', updatedAt: iso() } });
    assert.equal(appr.status, 'ok');
    const edit = await pushOne(w1.token, { collection: 'timeEntries', id: 'te-lock', op: 'upsert', baseVersion: 2, data: { ...base, approved: true, clockOut: iso(200), updatedAt: iso() } });
    assert.equal(edit.status, 'rejected');
    assert.match(edit.error.message, /approved/);
    const flagged = { ...base, approved: false, flag: { kind: 'off-site', text: '4.2 km from the job site', distanceM: 4200 } };
    assert.equal((await pushOne(w1.token, { collection: 'timeEntries', id: 'te-flag', op: 'upsert', data: flagged })).status, 'ok');
    const self = await pushOne(w1.token, { collection: 'timeEntries', id: 'te-flag', op: 'upsert', baseVersion: 1, data: { ...flagged, flag: { ...flagged.flag, reviewedAt: iso() }, updatedAt: iso() } });
    assert.equal(self.status, 'rejected');
  });
});

describe('retention', { skip }, () => {
  test('old points are emptied and deleted, old entries lose coordinates, the rest stays', async () => {
    assert.equal((await pushOne(w1.token, { collection: 'locationPoints', id: 'p-old', op: 'upsert', data: point('emp-1', { at: iso(100 * DAY) }) })).status, 'ok');
    assert.equal((await pushOne(w2.token, { collection: 'locationPoints', id: 'p-40d', op: 'upsert', data: point('emp-2', { at: iso(40 * DAY) }) })).status, 'ok');
    const oldEntry = { employeeId: 'emp-1', jobId: 'j1', kind: 'work', clockIn: iso(100 * DAY), clockOut: iso(100 * DAY - 480), breakMins: 30, approved: true,
      clockInLoc: { lat: 49.9, lng: -97.1, accuracyM: 9 }, clockOutLoc: { lat: 49.9, lng: -97.1, accuracyM: 9 }, siteCheck: { jobId: 'j1', distanceM: 40, inside: true } };
    assert.equal((await pushOne(foreman.token, { collection: 'timeEntries', id: 'te-old', op: 'upsert', data: oldEntry })).status, 'ok');

    const r = await purgeLocationAll(t.db);
    assert.ok(r.tenants >= 2);
    assert.equal(r.points, 1, 'only the 100-day-old point at the default 90 days');
    assert.equal(r.entries, 1);
    const rows = (await t.superPool.query("SELECT id, data, deleted_at FROM location_points WHERE tenant_id = $1 ORDER BY id", [A.tenantId])).rows;
    const old = rows.find((x) => x.id === 'p-old');
    assert.ok(old.deleted_at);
    assert.deepEqual(Object.keys(old.data).sort(), ['employeeId', 'purgedAt'], 'no coordinates, time or job left in the tombstone');
    assert.ok(!rows.find((x) => x.id === 'p-emp-1').deleted_at);
    const te = (await t.superPool.query("SELECT data FROM time_entries WHERE tenant_id = $1 AND id = 'te-old'", [A.tenantId])).rows[0].data;
    assert.equal(te.clockInLoc, undefined);
    assert.equal(te.clockOutLoc, undefined);
    assert.equal(te.siteCheck.inside, true, 'the result stays');
    assert.equal(te.breakMins, 30);
    assert.ok(te.locScrubbedAt);
    const audit = await t.superPool.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'location.retention'", [A.tenantId]);
    assert.match(audit.rows[0].summary, /Removed 1 location point/);
    // The worker's device drops it on the next pull.
    assert.ok((await pullAll(w1.token)).some((c) => c.id === 'p-old' && c.deleted));
    // A second run finds nothing more.
    assert.deepEqual((await purgeLocationAll(t.db)).points, 0);
  });

  test('a company can shorten retention; the job runs from the queue', async () => {
    const s = await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { location: { retentionDays: 30, policyVersion: 2 } } });
    if (s.status === 404) assert.equal((await call(app, { method: 'POST', url: '/api/v1/settings', token: A.token, body: { id: 'settings', location: { retentionDays: 30, policyVersion: 2 } } })).status, 201);
    else assert.equal(s.status, 200, JSON.stringify(s.body));
    const r = await LOCATION_HANDLERS.location_retention({ db: t.db });
    assert.equal(r.points, 1, 'the 40-day-old point goes at 30 days');
    assert.ok((await t.superPool.query("SELECT deleted_at FROM location_points WHERE id = 'p-40d'")).rows[0].deleted_at);
  });

  test('history never keeps raw points or entry coordinates', async () => {
    const h = await t.superPool.query("SELECT collection, data FROM record_history WHERE tenant_id = $1 AND collection IN ('locationPoints', 'timeEntries')", [A.tenantId]);
    for (const row of h.rows) {
      assert.notEqual(row.collection, 'locationPoints');
      assert.equal(row.data?.clockInLoc, undefined);
    }
  });
});

describe('live crew map (opt-in)', { skip }, () => {
  test('off by default', async () => {
    const r = await call(app, { url: '/api/v1/location/live', token: foreman.token });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'live_map_off');
  });

  test('when on: managers see the latest point of people clocked in now, nobody else', async () => {
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/settings/settings', token: A.token, body: { location: { liveCrewMap: true, retentionDays: 30, policyVersion: 3 } } })).status, 200);
    // emp-1 is on the clock with a recent point; emp-2 clocked out.
    assert.equal((await pushOne(w1.token, { collection: 'timeEntries', id: 'te-open', op: 'upsert', data: { employeeId: 'emp-1', jobId: 'j1', kind: 'work', clockIn: iso(30), clockOut: null, breakMins: 0, approved: false } })).status, 'ok');
    assert.equal((await pushOne(w1.token, { collection: 'locationPoints', id: 'p-now', op: 'upsert', data: point('emp-1', { at: iso(2), timeEntryId: 'te-open', lat: 49.91 }) })).status, 'ok');
    assert.equal((await pushOne(w2.token, { collection: 'timeEntries', id: 'te-done', op: 'upsert', data: { employeeId: 'emp-2', clockIn: iso(30), clockOut: iso(10), breakMins: 0 } })).status, 'ok');
    const r = await call(app, { url: '/api/v1/location/live', token: foreman.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body.crew.map((c) => [c.employeeId, c.lat, c.jobId]), [['emp-1', 49.91, 'j1']]);
    assert.equal((await call(app, { url: '/api/v1/location/live', token: w1.token })).status, 403, 'workers do not get the map');
    assert.equal((await call(app, { url: '/api/v1/location/live', token: keyA })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/location/live', token: B.token })).status, 403, 'company B never turned it on');
    const audit = await t.superPool.query("SELECT actor_id FROM audit_events WHERE tenant_id = $1 AND action = 'location.live.view'", [A.tenantId]);
    assert.equal(audit.rows.length, 1);
    // The map did not widen the foreman's own reads afterwards.
    assert.deepEqual((await call(app, { url: '/api/v1/locationPoints?limit=100', token: foreman.token })).body.data.map((x) => x.id), ['p-emp-f']);
  });
});
