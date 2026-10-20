// REST CRUD, sync push/pull semantics, health endpoints, OpenAPI and the job queue.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp } from './support/app.js';
import { enqueue, runOnce, scheduleRecurring } from '../src/services/queue.js';

let t, app, A;
before(async () => {
  if (skip) return;
  t = await createTestDatabase('records');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Records Co');
});
after(async () => { await app?.close(); await t?.close(); });

const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });

describe('REST', { skip }, () => {
  test('create, read, patch with If-Match, delete', async () => {
    const c = await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { name: 'Harbour Dental', type: 'commercial', tags: ['repeat'], custom: { anything: 1 } } });
    assert.equal(c.status, 201);
    assert.equal(c.body.version, 1);
    assert.equal(c.body.custom.anything, 1, 'extra fields are kept');
    assert.ok(c.body.createdAt && c.body.updatedAt);
    const id = c.body.id;

    const g = await call(app, { url: `/api/v1/clients/${id}`, token: A.token });
    assert.equal(g.status, 200);
    assert.equal(g.body.name, 'Harbour Dental');

    const p = await call(app, { method: 'PATCH', url: `/api/v1/clients/${id}`, token: A.token, body: { phone: '555' }, headers: { 'if-match': '1' } });
    assert.equal(p.status, 200);
    assert.equal(p.body.version, 2);
    assert.equal(p.body.name, 'Harbour Dental');
    assert.equal(p.body.phone, '555');

    const stale = await call(app, { method: 'PATCH', url: `/api/v1/clients/${id}`, token: A.token, body: { phone: '666' }, headers: { 'if-match': '1' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');

    const d = await call(app, { method: 'DELETE', url: `/api/v1/clients/${id}`, token: A.token });
    assert.equal(d.status, 200);
    assert.equal(d.body.deleted, true);
    assert.equal((await call(app, { url: `/api/v1/clients/${id}`, token: A.token })).status, 404);
    const withDeleted = await call(app, { url: '/api/v1/clients?includeDeleted=true', token: A.token });
    assert.ok(withDeleted.body.data.some((r) => r.id === id && r.deleted));
  });

  test('validation errors use the standard error format', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/jobs', token: A.token, body: { number: 5, startDate: 'tomorrow' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'validation_failed');
    assert.ok(r.body.error.requestId);
    assert.ok(r.body.error.details.errors.some((e) => e.path === '/number'));
    const dup = await call(app, { method: 'POST', url: '/api/v1/jobs', token: A.token, body: { id: 'job-dup', title: 'x' } });
    assert.equal(dup.status, 201);
    const again = await call(app, { method: 'POST', url: '/api/v1/jobs', token: A.token, body: { id: 'job-dup', title: 'y' } });
    assert.equal(again.status, 409);
    const badId = await call(app, { method: 'POST', url: '/api/v1/jobs', token: A.token, body: { id: '../etc', title: 'y' } });
    assert.equal(badId.status, 400);
  });

  test('list filters and cursor pagination', async () => {
    const client = await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { name: 'Filter Client' } });
    for (let i = 0; i < 5; i++) {
      const r = await call(app, { method: 'POST', url: '/api/v1/jobs', token: A.token, body: { title: `Job ${i}`, status: i % 2 ? 'scheduled' : 'complete', clientId: client.body.id, number: `J-${i}` } });
      assert.equal(r.status, 201);
    }
    const sched = await call(app, { url: `/api/v1/jobs?status=scheduled&clientId=${client.body.id}`, token: A.token });
    assert.equal(sched.status, 200);
    assert.equal(sched.body.data.length, 2);
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    do {
      const r = await call(app, { url: `/api/v1/jobs?clientId=${client.body.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, token: A.token });
      assert.equal(r.status, 200);
      r.body.data.forEach((j) => seen.add(j.id));
      cursor = r.body.cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(seen.size, 5);
    assert.equal(pages, 3);
    const unknown = await call(app, { url: '/api/v1/jobs?colour=red', token: A.token });
    assert.equal(unknown.status, 400);
    const badCursor = await call(app, { url: '/api/v1/jobs?cursor=not-a-cursor', token: A.token });
    assert.equal(badCursor.status, 400);
  });

  test('auditLog is readable and append-only over REST', async () => {
    const list = await call(app, { url: '/api/v1/auditLog?limit=5', token: A.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length > 0);
    assert.ok(list.body.data[0].action);
    const post = await call(app, { method: 'POST', url: '/api/v1/auditLog', token: A.token, body: { action: 'x' } });
    assert.equal(post.status, 405);
  });

  test('employees: the PIN is never stored', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { name: 'Tom', role: 'apprentice', pin: '1234', rateCents: 2400 } });
    assert.equal(r.status, 201);
    assert.equal(r.body.pin, undefined);
    const raw = await t.superPool.query('SELECT data FROM employees WHERE id = $1', [r.body.id]);
    assert.equal(raw.rows[0].data.pin, undefined);
  });
});

describe('sync', { skip }, () => {
  test('push is idempotent by mid', async () => {
    const m = mut({ collection: 'jobs', id: 'sync-job-1', op: 'upsert', data: { title: 'Panel change', updatedAt: new Date().toISOString() } });
    const r1 = await push(A.token, [m]);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.results[0].status, 'ok');
    assert.equal(r1.body.results[0].version, 1);
    const r2 = await push(A.token, [m]);
    assert.deepEqual(r2.body.results[0], r1.body.results[0]);
    const g = await call(app, { url: '/api/v1/jobs/sync-job-1', token: A.token });
    assert.equal(g.body.version, 1, 'replay did not write again');
  });

  test('fresh base version updates; stale and older loses; stale and newer wins; history kept', async () => {
    const id = 'sync-job-2';
    const t0 = Date.now();
    await push(A.token, [mut({ collection: 'jobs', id, op: 'upsert', data: { title: 'v1', updatedAt: new Date(t0 - 60000).toISOString() } })]);
    const ok = await push(A.token, [mut({ collection: 'jobs', id, op: 'upsert', baseVersion: 1, data: { title: 'v2', updatedAt: new Date(t0 - 50000).toISOString() } })]);
    assert.equal(ok.body.results[0].status, 'ok');
    assert.equal(ok.body.results[0].version, 2);

    const lose = await push(A.token, [mut({ collection: 'jobs', id, op: 'upsert', baseVersion: 1, data: { title: 'old edit', updatedAt: new Date(t0 - 55000).toISOString() } })]);
    assert.equal(lose.body.results[0].status, 'conflict');
    assert.equal(lose.body.results[0].server.data.title, 'v2');
    assert.equal(lose.body.results[0].server.version, 2);

    const win = await push(A.token, [mut({ collection: 'jobs', id, op: 'upsert', baseVersion: 1, data: { title: 'newer edit', updatedAt: new Date(t0 - 1000).toISOString() } })]);
    assert.equal(win.body.results[0].status, 'ok');
    assert.equal(win.body.results[0].version, 3);

    const h = await t.superPool.query('SELECT reason, data FROM record_history WHERE tenant_id = $1 AND record_id = $2 ORDER BY id', [A.tenantId, id]);
    assert.deepEqual(h.rows.map((r) => [r.reason, r.data.title]), [['rejected', 'old edit'], ['overwritten', 'v2']]);
  });

  test('a client clock far in the future cannot win forever', async () => {
    const id = 'sync-job-skew';
    await push(A.token, [mut({ collection: 'jobs', id, op: 'upsert', data: { title: 'future', updatedAt: '2099-01-01T00:00:00.000Z' } })]);
    const g = await call(app, { url: `/api/v1/jobs/${id}`, token: A.token });
    assert.ok(Date.parse(g.body.updatedAt) < Date.now() + 10 * 60000, 'stored updatedAt is clamped');
  });

  test('one bad mutation is rejected; the rest of the batch applies', async () => {
    const r = await push(A.token, [
      mut({ collection: 'jobs', id: 'batch-ok-1', op: 'upsert', data: { title: 'fine' } }),
      mut({ collection: 'jobs', id: 'batch-bad', op: 'upsert', data: { title: 12 } }),
      mut({ collection: 'nope', id: 'x', op: 'upsert', data: {} }),
      { collection: 'jobs' },
      mut({ collection: 'drawings', id: 'too-big', op: 'upsert', data: { name: 'x', strokes: [], big: 'x'.repeat(25 * 1024 * 1024) } }),
      mut({ collection: 'jobs', id: 'batch-ok-2', op: 'upsert', data: { title: 'also fine' } }),
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'rejected', 'rejected', 'rejected', 'rejected', 'ok']);
    assert.equal(r.body.results[1].error.code, 'validation_failed');
    assert.equal(r.body.results[2].error.code, 'bad_mutation');
    assert.equal(r.body.results[4].error.code, 'too_large');
  });

  test('delete makes a tombstone that pulls as deleted', async () => {
    await push(A.token, [mut({ collection: 'clients', id: 'gone-client', op: 'upsert', data: { name: 'Temp' } })]);
    const before = await call(app, { url: '/api/v1/sync/pull?since=0&limit=1000', token: A.token });
    const cursor = before.body.cursor;
    const del = await push(A.token, [mut({ collection: 'clients', id: 'gone-client', op: 'delete', baseVersion: 1 })]);
    assert.equal(del.body.results[0].status, 'ok');
    assert.equal(del.body.results[0].version, 2);
    const p = await call(app, { url: `/api/v1/sync/pull?since=${cursor}`, token: A.token });
    const c = p.body.changes.find((x) => x.id === 'gone-client');
    assert.deepEqual({ deleted: c.deleted, data: c.data, version: c.version }, { deleted: true, data: null, version: 2 });
    const again = await push(A.token, [mut({ collection: 'clients', id: 'gone-client', op: 'delete', baseVersion: 1 })]);
    assert.equal(again.body.results[0].status, 'ok', 'deleting twice is fine');
  });

  test('pull pages in change order with an advancing cursor', async () => {
    for (let i = 0; i < 7; i++) await push(A.token, [mut({ collection: 'items', id: `item-${i}`, op: 'upsert', data: { name: `Item ${i}` } })]);
    let since = '0';
    const ids = [];
    let more = true;
    let pages = 0;
    while (more && pages < 100) {
      const r = await call(app, { url: `/api/v1/sync/pull?since=${since}&limit=3`, token: A.token });
      assert.equal(r.status, 200);
      assert.ok(Number(r.body.cursor) >= Number(since));
      ids.push(...r.body.changes.map((c) => `${c.collection}/${c.id}`));
      since = r.body.cursor;
      more = r.body.more;
      pages++;
    }
    for (let i = 0; i < 7; i++) assert.ok(ids.includes(`items/item-${i}`));
    assert.equal(new Set(ids).size, ids.length, 'each record once');
    const empty = await call(app, { url: `/api/v1/sync/pull?since=${since}`, token: A.token });
    assert.deepEqual(empty.body, { changes: [], cursor: since, more: false });
    const bad = await call(app, { url: '/api/v1/sync/pull?since=-1', token: A.token });
    assert.equal(bad.status, 400);
  });

  test('auditLog pushes are appended as client events and cannot be deleted', async () => {
    const r = await push(A.token, [
      mut({ collection: 'auditLog', id: 'a1', op: 'upsert', data: { at: new Date().toISOString(), action: 'export', summary: 'Backup exported' } }),
      mut({ collection: 'auditLog', id: 'a1', op: 'delete' }),
    ]);
    assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'rejected']);
    const log = await call(app, { url: '/api/v1/auditLog?action=client.export', token: A.token });
    assert.equal(log.body.data.length, 1);
  });
});

describe('health, status, openapi', { skip }, () => {
  test('healthz, readyz and status', async () => {
    assert.deepEqual((await call(app, { url: '/api/healthz' })).body, { status: 'ok' });
    const ready = await call(app, { url: '/api/readyz' });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.migrations.ok, true);
    const s = await call(app, { url: '/api/v1/status' });
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(s.body).sort(), ['environment', 'gitSha', 'status', 'time', 'version']);
    assert.equal(s.body.environment, 'test');
  });

  test('readyz is 503 when the queue is far behind', async () => {
    const { app: strict } = await startApp(t, { env: { READY_MAX_QUEUE_LAG_S: '60' } });
    const id = await enqueue(t.db, { kind: 'never_runs' });
    await t.superPool.query("UPDATE jobs_queue SET run_at = now() - interval '2 hours' WHERE id = $1", [id]);
    const r = await call(strict, { url: '/api/readyz' });
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.queue.ok, false);
    await t.superPool.query('DELETE FROM jobs_queue WHERE id = $1', [id]);
    await strict.close();
  });

  test('a QuickBooks backlog never marks the API unready (its pool is separate); it shows on its own', async () => {
    const { app: strict } = await startApp(t, { env: { READY_MAX_QUEUE_LAG_S: '60' } });
    const id = await enqueue(t.db, { kind: 'qbo_check' });
    await t.superPool.query("UPDATE jobs_queue SET run_at = now() - interval '2 hours' WHERE id = $1", [id]);
    try {
      const r = await call(strict, { url: '/api/readyz' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.checks.queue.ok, true);
    } finally {
      await t.superPool.query('DELETE FROM jobs_queue WHERE id = $1', [id]);
      await strict.close();
    }
  });

  test('OpenAPI lists collections and sync', async () => {
    const r = await call(app, { url: '/api/v1/openapi.json' });
    assert.equal(r.status, 200);
    assert.ok(r.body.paths['/api/v1/jobs']);
    assert.ok(r.body.paths['/api/v1/wireRuns/{id}']);
    assert.ok(r.body.paths['/api/v1/sync/push']);
    assert.ok(r.body.components.schemas['record.bends']);
  });

  test('request ids are echoed', async () => {
    const r = await call(app, { url: '/api/nope', headers: { 'x-request-id': 'req-12345678' } });
    assert.equal(r.status, 404);
    assert.equal(r.headers['x-request-id'], 'req-12345678');
    assert.deepEqual(r.body, { error: { code: 'not_found', message: 'No such endpoint.', requestId: 'req-12345678' } });
  });
});

describe('job queue', { skip }, () => {
  test('runs a job, retries a failing one, then marks it failed', async () => {
    await t.superPool.query('DELETE FROM jobs_queue');
    let calls = 0;
    const handlers = { ok_job: async () => 'fine', flaky: async () => { calls++; throw new Error('boom'); } };
    await enqueue(t.db, { kind: 'ok_job' });
    const r1 = await runOnce(t.db, { handlers });
    assert.equal(r1.outcome, 'done');
    const id = await enqueue(t.db, { kind: 'flaky', maxAttempts: 2 });
    assert.equal((await runOnce(t.db, { handlers })).outcome, 'retry');
    assert.equal(await runOnce(t.db, { handlers }), null, 'backoff: not due yet');
    await t.superPool.query('UPDATE jobs_queue SET run_at = now() WHERE id = $1', [id]);
    assert.equal((await runOnce(t.db, { handlers })).outcome, 'failed');
    assert.equal(calls, 2);
    const row = await t.superPool.query('SELECT status, attempts, last_error FROM jobs_queue WHERE id = $1', [id]);
    assert.deepEqual(row.rows[0], { status: 'failed', attempts: 2, last_error: 'boom' });
  });

  test('two workers never claim the same job (SKIP LOCKED)', async () => {
    await t.superPool.query('DELETE FROM jobs_queue');
    for (let i = 0; i < 6; i++) await enqueue(t.db, { kind: 'ok_job' });
    const handlers = { ok_job: async () => new Promise((r) => setTimeout(r, 20)) };
    const runs = await Promise.all(Array.from({ length: 8 }, () => runOnce(t.db, { handlers })));
    const ids = runs.filter(Boolean).map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('purge_expired removes dead sessions; recurring jobs are deduplicated', async () => {
    await t.superPool.query('DELETE FROM jobs_queue');
    await t.superPool.query("UPDATE sessions SET expires_at = now() - interval '2 days' WHERE user_id = $1 AND id <> (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)", [A.userId]);
    await scheduleRecurring(t.db);
    await scheduleRecurring(t.db);
    const q = await t.superPool.query("SELECT count(*)::int AS n FROM jobs_queue WHERE kind = 'purge_expired'");
    assert.equal(q.rows[0].n, 1);
    let r;
    do { r = await runOnce(t.db); } while (r && r.kind !== 'purge_expired');
    assert.equal(r.outcome, 'done');
    const left = await t.superPool.query("SELECT count(*)::int AS n FROM sessions WHERE expires_at < now() - interval '1 day'");
    assert.equal(left.rows[0].n, 0);
  });
});
