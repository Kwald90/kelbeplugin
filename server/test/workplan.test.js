// Work plans and daily tasks on the server: who sees which tasks (own, published only),
// what a worker may change (progress only, photo evidence to finish), offline merges, the
// KPI route, plan entitlements and tenant isolation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';

let t, app, A, B, foreman, w1, w2;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const pushOne = async (token, m) => (await push(token, [mut(m)])).body.results[0];
const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
const today = new Date().toISOString().slice(0, 10);
const iso = (minsAgo = 0) => new Date(Date.now() - minsAgo * 60_000).toISOString();

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
const taskBody = (o) => ({ planId: 'plan-1', jobId: 'job-1', title: 'Mount boxes', date: today, estHours: 4, qty: 40, unit: 'boxes', status: 'todo', publishedAt: iso(), updatedAt: iso(), ...o });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('workplan');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Plan Co A');
  B = await ownerTenant(t, app, 'Plan Co B');
  for (const [id, name, role] of [['emp-f', 'Fran Foreman', 'foreman'], ['emp-1', 'Wes One', 'electrician'], ['emp-2', 'Ana Two', 'apprentice']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-f' });
  w1 = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-1' });
  w2 = await addMember(t, app, A.tenantId, { role: 'apprentice', employeeId: 'emp-2' });

  const plan = { id: 'plan-1', jobId: 'job-1', name: 'Main build', startDate: today, endDate: today, skipWeekends: false, crewIds: ['emp-1', 'emp-2'], phases: [{ id: 'ph1', name: 'Rough-in' }], published: { [today]: { at: iso(), by: 'emp-f' } }, status: 'active' };
  const r = await push(foreman.token, [
    mut({ collection: 'workPlans', id: 'plan-1', op: 'upsert', data: plan }),
    mut({ collection: 'workTasks', id: 't-draft', op: 'upsert', data: taskBody({ employeeId: 'emp-1', status: 'draft', publishedAt: null, title: 'Draft for tomorrow' }) }),
    mut({ collection: 'workTasks', id: 't-pub', op: 'upsert', data: taskBody({ employeeId: 'emp-1', requiresPhoto: true, minPhotos: 1, phaseId: 'ph1' }) }),
    mut({ collection: 'workTasks', id: 't-pub2', op: 'upsert', data: taskBody({ employeeId: 'emp-1', title: 'Pull home runs', qty: 6, unit: 'runs', taskType: 'Home runs' }) }),
    mut({ collection: 'workTasks', id: 't-other', op: 'upsert', data: taskBody({ employeeId: 'emp-2', title: 'Ana only' }) }),
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('a worker sees only their own published tasks', { skip }, () => {
  test('pull, list and get', async () => {
    const pulled = (await pullAll(w1.token)).filter((c) => c.collection === 'workTasks').map((c) => c.id).sort();
    assert.deepEqual(pulled, ['t-pub', 't-pub2']);
    assert.ok(!(await pullAll(w1.token)).some((c) => c.collection === 'workPlans' || c.collection === 'huddles'), 'plans stay with the planners');
    const list = await call(app, { url: '/api/v1/workTasks?limit=100', token: w1.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((x) => x.id).sort(), ['t-pub', 't-pub2']);
    for (const id of ['t-other', 't-draft']) {
      const g = await call(app, { url: `/api/v1/workTasks/${id}`, token: w1.token });
      assert.equal(g.status, 404, id);
      assert.ok(!JSON.stringify(g.body).includes('Ana only') && !JSON.stringify(g.body).includes('Draft for tomorrow'));
    }
    const f = await call(app, { url: '/api/v1/workTasks?limit=100', token: foreman.token });
    assert.equal(f.body.data.length, 4, 'the foreman sees everything, drafts included');
  });

  test('a published draft reaches the worker on the next pull', async () => {
    assert.ok(!(await pullAll(w1.token)).some((c) => c.id === 't-late'));
    assert.equal(await pushOne(foreman.token, { collection: 'workTasks', id: 't-late', op: 'upsert', data: taskBody({ employeeId: 'emp-1', title: 'Added after the meeting', lateAdd: true }) }).then((x) => x.status), 'ok');
    const after = await pullAll(w1.token);
    assert.ok(after.some((c) => c.id === 't-late' && c.data.lateAdd === true));
  });
});

describe('a worker can only record progress on their own tasks', { skip }, () => {
  test("someone else's task: refused on sync, 404 over REST, nothing changes", async () => {
    const r = await pushOne(w1.token, { collection: 'workTasks', id: 't-other', op: 'upsert', data: taskBody({ employeeId: 'emp-2', title: 'Ana only', status: 'done', completedAt: iso(), progressAt: iso() }) });
    assert.equal(r.status, 'rejected');
    assert.equal(r.error.code, 'forbidden');
    assert.ok(!JSON.stringify(r).includes('Ana only'), 'the refusal does not echo the stored task');
    const p = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-other', token: w1.token, body: { status: 'done' } });
    assert.equal(p.status, 404);
    const raw = await t.superPool.query("SELECT data->>'status' AS s FROM work_tasks WHERE id = 't-other'");
    assert.equal(raw.rows[0].s, 'todo');
  });

  test('cannot see or complete a draft, add, delete or take over a task', async () => {
    const d = await pushOne(w1.token, { collection: 'workTasks', id: 't-draft', op: 'upsert', data: taskBody({ employeeId: 'emp-1', status: 'done' }) });
    assert.equal(d.status, 'rejected');
    const add = await pushOne(w1.token, { collection: 'workTasks', id: 't-mine', op: 'upsert', data: taskBody({ employeeId: 'emp-1' }) });
    assert.equal(add.status, 'rejected');
    assert.match(add.error.message, /foreman/);
    const del = await pushOne(w1.token, { collection: 'workTasks', id: 't-pub2', op: 'delete' });
    assert.equal(del.status, 'rejected');
    const steal = await pushOne(w2.token, { collection: 'workTasks', id: 't-pub2', op: 'upsert', data: taskBody({ employeeId: 'emp-2', title: 'Pull home runs' }) });
    assert.equal(steal.status, 'rejected');
    const plan = await pushOne(w1.token, { collection: 'workPlans', id: 'plan-x', op: 'upsert', data: { name: 'Mine' } });
    assert.equal(plan.status, 'rejected');
    const rest = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-pub2', token: w1.token, body: { title: 'Easier' } });
    assert.equal(rest.status, 403);
  });

  test('a photo-required task cannot be checked off without the photo', async () => {
    const no = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-pub', token: w1.token, body: { status: 'done', completedAt: iso(), progressAt: iso() } });
    assert.equal(no.status, 403);
    assert.match(no.body.error.message, /photo/);
    const viaSync = await pushOne(w1.token, { collection: 'workTasks', id: 't-pub', op: 'upsert', baseVersion: 1, data: taskBody({ employeeId: 'emp-1', requiresPhoto: true, minPhotos: 1, phaseId: 'ph1', status: 'done', completedAt: iso(), progressAt: iso() }) });
    assert.equal(viaSync.status, 'rejected');
    const foremanToo = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-pub', token: foreman.token, body: { status: 'done' } });
    assert.equal(foremanToo.status, 403, 'evidence applies to everyone unless waived');
    const yes = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-pub', token: w1.token, body: { status: 'done', completedAt: iso(), progressAt: iso(), actualHours: 3.5, qtyDone: 40, photos: [{ id: 'p1', dataUrl: PHOTO, takenAt: iso() }] } });
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.equal(yes.body.status, 'done');
  });

  test('offline completion merges with a foreman edit made meanwhile', async () => {
    const v1 = (await call(app, { url: '/api/v1/workTasks/t-pub2', token: foreman.token })).body;
    // The foreman renames the task (newer row time).
    const edit = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-pub2', token: foreman.token, body: { title: 'Pull home runs, level 2', description: 'Use the red tape' } });
    assert.equal(edit.status, 200);
    // The worker finished earlier, offline, on the old copy (older updatedAt, stale baseVersion).
    const done = { ...v1, title: 'Pull home runs', status: 'done', completedAt: iso(30), progressAt: iso(30), actualHours: 5, qtyDone: 6, updatedAt: iso(30) };
    delete done.version;
    const r = await pushOne(w1.token, { collection: 'workTasks', id: 't-pub2', op: 'upsert', baseVersion: v1.version, data: done });
    assert.equal(r.status, 'conflict', 'answered as a conflict so the phone takes the merged copy');
    assert.equal(r.server.data.status, 'done', 'the completion is kept');
    assert.equal(r.server.data.title, 'Pull home runs, level 2', "the foreman's edit is kept");
    const stored = (await call(app, { url: '/api/v1/workTasks/t-pub2', token: foreman.token })).body;
    assert.equal(stored.status, 'done');
    assert.equal(stored.description, 'Use the red tape');
    assert.equal(stored.actualHours, 5);
    // A stale foreman copy from before the completion does not undo it.
    const stale = { ...v1, title: 'Pull home runs (L2)', updatedAt: iso() };
    delete stale.version;
    const s = await pushOne(foreman.token, { collection: 'workTasks', id: 't-pub2', op: 'upsert', baseVersion: v1.version, data: stale });
    assert.equal(s.status, 'conflict');
    assert.equal(s.server.data.status, 'done');
    assert.equal(s.server.data.title, 'Pull home runs (L2)');
  });

  test('a published task never goes back to draft', async () => {
    const r = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-other', token: foreman.token, body: { status: 'draft' } });
    assert.equal(r.status, 403);
  });
});

describe('KPIs', { skip }, () => {
  test('managers get crew KPIs and plan progress; workers do not', async () => {
    const r = await call(app, { url: `/api/v1/kpis?from=${today}&to=${today}&planId=plan-1`, token: foreman.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const wes = r.body.workers.find((w) => w.employeeId === 'emp-1');
    assert.equal(wes.name, 'Wes One');
    assert.equal(wes.completed, 2);
    assert.equal(wes.evidenceRequired, 1);
    assert.equal(wes.evidencePct, 100);
    assert.ok(wes.byType.some((x) => x.type === 'Home runs' && x.perHour === 1.2));
    assert.ok(r.body.job.phases.length >= 1);
    assert.ok(r.body.job.pct > 0);
    assert.match(r.body.note, /context/);
    const no = await call(app, { url: `/api/v1/kpis?from=${today}&to=${today}`, token: w1.token });
    assert.equal(no.status, 403);
    const bad = await call(app, { url: `/api/v1/kpis?from=${today}&to=2001-01-01`, token: foreman.token });
    assert.equal(bad.status, 400);
  });
});

describe('plans and tenants', { skip }, () => {
  test("another company can't read, list, change or measure these tasks", async () => {
    for (const id of ['t-pub', 't-other', 't-draft']) {
      assert.equal((await call(app, { url: `/api/v1/workTasks/${id}`, token: B.token })).status, 404);
    }
    const list = await call(app, { url: '/api/v1/workTasks?limit=500&includeDeleted=true', token: B.token });
    assert.equal(list.body.data.length, 0);
    assert.ok(!(await pullAll(B.token)).some((c) => c.collection === 'workTasks' || c.collection === 'workPlans'));
    const patch = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-pub', token: B.token, body: { status: 'todo' } });
    assert.equal(patch.status, 404);
    // Same id pushed by B: B gets its own row; A's is untouched.
    const own = await pushOne(B.token, { collection: 'workTasks', id: 't-pub', op: 'upsert', data: taskBody({ employeeId: 'emp-x', title: 'Bravo task' }) });
    assert.equal(own.status, 'ok');
    const a = await call(app, { url: '/api/v1/workTasks/t-pub', token: foreman.token });
    assert.equal(a.body.title, 'Mount boxes');
    const k = await call(app, { url: `/api/v1/kpis?from=${today}&to=${today}&planId=plan-1`, token: B.token });
    assert.equal(k.status, 404);
    const rows = await t.superPool.query("SELECT tenant_id FROM work_tasks WHERE id = 't-pub' ORDER BY tenant_id");
    assert.equal(rows.rows.length, 2);
  });

  test('on Starter, workers still record progress; planning and KPIs need Pro', async () => {
    await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [A.tenantId]);
    try {
      const plan = await pushOne(foreman.token, { collection: 'workPlans', id: 'plan-2', op: 'upsert', data: { name: 'Second' } });
      assert.equal(plan.status, 'rejected');
      assert.equal(plan.error.code, 'feature_not_in_plan');
      const k = await call(app, { url: `/api/v1/kpis?from=${today}&to=${today}`, token: foreman.token });
      assert.equal(k.status, 403);
      assert.equal(k.body.error.code, 'feature_not_in_plan');
      const start = await call(app, { method: 'PATCH', url: '/api/v1/workTasks/t-late', token: w1.token, body: { status: 'in-progress', startedAt: iso(), progressAt: iso() } });
      assert.equal(start.status, 200, JSON.stringify(start.body));
    } finally {
      await t.superPool.query("UPDATE tenants SET plan = 'trial' WHERE id = $1", [A.tenantId]);
    }
  });
});
