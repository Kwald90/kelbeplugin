// Tenant isolation. Tenant A must never read, list, change, delete, pull or push
// tenant B's data: not with a session, not with an API key, not with B's ids, and not
// with hand-made cursors. Below the API, the fishtape_app role itself must see nothing
// without a tenant and must be unable to write rows for another tenant.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { apiKey, call, ownerTenant, startApp } from './support/app.js';
import { TABLE_COLLECTIONS, collectionDef } from '../src/collections.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { setFetch } from '../src/integrations/http.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { syncTenant } from '../src/qbo/engine.js';

let t, app, A, B, keyA, keyAReadJobs, bIds;
const SECRET = 'B-ONLY-SECRET';
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });

/** Every change A can pull, from the start. */
async function pullAll(token) {
  const out = [];
  let since = '0';
  for (let i = 0; i < 100; i++) {
    const r = await call(app, { url: `/api/v1/sync/pull?since=${since}&limit=1000`, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    out.push(...r.body.changes);
    since = r.body.cursor;
    if (!r.body.more) break;
  }
  return out;
}

const mentionsSecret = (x) => JSON.stringify(x).includes(SECRET);

before(async () => {
  if (skip) return;
  t = await createTestDatabase('isolation');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Electric');
  B = await ownerTenant(t, app, 'Bravo Electric');

  // B's data: one record in every collection, all carrying a marker string.
  bIds = {};
  // Location records can only be made by the person they belong to: link B's owner to an employee.
  await t.superPool.query("UPDATE memberships SET employee_id = 'b-owner-emp' WHERE tenant_id = $1 AND user_id = $2", [B.tenantId, B.userId]);
  for (const coll of TABLE_COLLECTIONS) {
    const id = coll === 'settings' ? 'settings' : `b-${coll}-1`;
    const data = coll === 'settings' ? { company: { name: SECRET } } : { name: SECRET, title: SECRET, note: SECRET };
    if (coll === 'locationPoints' || coll === 'locationConsents') Object.assign(data, { employeeId: 'b-owner-emp', at: new Date().toISOString(), lat: 49.9, lng: -97.1 });
    const r = await push(B.token, [mut({ collection: coll, id, op: 'upsert', data })]);
    assert.equal(r.body.results[0].status, 'ok', `${coll}: ${JSON.stringify(r.body.results[0])}`);
    bIds[coll] = id;
  }
  // A has a little data of its own.
  await push(A.token, [mut({ collection: 'jobs', id: 'a-job-1', op: 'upsert', data: { title: 'Alpha job' } })]);
  keyA = await apiKey(app, A.token, ['*:write']);
  keyAReadJobs = await apiKey(app, A.token, ['jobs:read']);
});
after(async () => { await app?.close(); await t?.close(); });

describe('API: tenant A cannot reach tenant B', { skip }, () => {
  test('GET by B\'s id is 404 in every collection (session and API key)', async () => {
    for (const coll of TABLE_COLLECTIONS) {
      for (const token of [A.token, keyA]) {
        const r = await call(app, { url: `/api/v1/${coll}/${bIds[coll]}`, token });
        // API keys never reach location records at all (403), in any company.
        assert.equal(r.status, token === keyA && collectionDef(coll).noApiKeys ? 403 : 404, `${coll} → ${r.status}`);
        assert.ok(!mentionsSecret(r.body));
      }
    }
  });

  test('lists never include B\'s rows, even with includeDeleted and filters', async () => {
    for (const coll of TABLE_COLLECTIONS) {
      for (const token of [A.token, keyA]) {
        const r = await call(app, { url: `/api/v1/${coll}?limit=500&includeDeleted=true`, token });
        assert.equal(r.status, token === keyA && collectionDef(coll).noApiKeys ? 403 : 200, `${coll} → ${r.status}`);
        assert.ok(!mentionsSecret(r.body), `${coll} leaked`);
      }
    }
    const f = await call(app, { url: `/api/v1/time_entries_does_not_exist`, token: A.token });
    assert.equal(f.status, 404);
  });

  test('crafted list cursors pointing at B\'s rows return only A\'s rows', async () => {
    const { rows } = await t.superPool.query(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c FROM jobs WHERE tenant_id = $1`, [B.tenantId]);
    for (const c of [
      { c: rows[0].c, i: rows[0].id },
      { c: '2999-01-01T00:00:00.000000Z', i: 'zzzz' },
      { c: '1970-01-01T00:00:00.000000Z', i: '' },
    ]) {
      const cursor = Buffer.from(JSON.stringify(c)).toString('base64url');
      const r = await call(app, { url: `/api/v1/jobs?cursor=${cursor}`, token: A.token });
      assert.equal(r.status, 200);
      assert.ok(!mentionsSecret(r.body));
      for (const j of r.body.data) assert.notEqual(j.id, bIds.jobs);
    }
    const sqlish = Buffer.from(JSON.stringify({ c: "2020-01-01' OR 1=1 --", i: 'x' })).toString('base64url');
    assert.equal((await call(app, { url: `/api/v1/jobs?cursor=${sqlish}`, token: A.token })).status, 400);
  });

  test('PATCH and DELETE on B\'s ids are 404 and B\'s rows do not change', async () => {
    for (const coll of ['jobs', 'clients', 'invoices', 'timeEntries', 'drawings', 'wireRuns']) {
      for (const token of [A.token, keyA]) {
        const p = await call(app, { method: 'PATCH', url: `/api/v1/${coll}/${bIds[coll]}`, token, body: { title: 'pwned' } });
        assert.equal(p.status, 404, `${coll} PATCH → ${p.status}`);
        const d = await call(app, { method: 'DELETE', url: `/api/v1/${coll}/${bIds[coll]}`, token });
        assert.equal(d.status, 404, `${coll} DELETE → ${d.status}`);
      }
      const b = await call(app, { url: `/api/v1/${coll}/${bIds[coll]}`, token: B.token });
      assert.equal(b.status, 200);
      assert.equal(b.body.title, SECRET);
      assert.equal(b.body.version, 1);
    }
  });

  test('POST with B\'s id creates A\'s own record; B\'s record is untouched', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/jobs', token: A.token, body: { id: bIds.jobs, title: 'Alpha copy' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.title, 'Alpha copy');
    const b = await call(app, { url: `/api/v1/jobs/${bIds.jobs}`, token: B.token });
    assert.equal(b.body.title, SECRET);
    const a = await call(app, { url: `/api/v1/jobs/${bIds.jobs}`, token: A.token });
    assert.equal(a.body.title, 'Alpha copy');
    const both = await t.superPool.query('SELECT tenant_id FROM jobs WHERE id = $1 ORDER BY tenant_id', [bIds.jobs]);
    assert.deepEqual(both.rows.map((x) => x.tenant_id).sort(), [A.tenantId, B.tenantId].sort());
  });

  test('sync pull returns only A\'s changes, whatever the cursor', async () => {
    for (const token of [A.token, keyA]) {
      const all = await pullAll(token);
      assert.ok(all.length > 0);
      assert.ok(!mentionsSecret(all), 'pull leaked B data');
    }
    const r = await call(app, { url: '/api/v1/sync/pull?since=999999999999', token: A.token });
    assert.deepEqual(r.body.changes, []);
    // B's own cursor values mean nothing to A.
    const { rows } = await t.superPool.query('SELECT min(change_seq) - 1 AS s FROM clients WHERE tenant_id = $1', [B.tenantId]);
    const r2 = await call(app, { url: `/api/v1/sync/pull?since=${rows[0].s}&limit=1000`, token: A.token });
    assert.ok(!mentionsSecret(r2.body));
  });

  test('sync push with B\'s ids only writes A\'s namespace', async () => {
    const r = await push(A.token, [
      mut({ collection: 'clients', id: bIds.clients, op: 'upsert', baseVersion: 1, data: { name: 'Alpha overwrite' } }),
      mut({ collection: 'invoices', id: bIds.invoices, op: 'delete', baseVersion: 1 }),
      mut({ collection: 'timeEntries', id: bIds.timeEntries, op: 'upsert', baseVersion: 1, data: { note: 'x' } }),
    ]);
    assert.equal(r.status, 200);
    assert.ok(!mentionsSecret(r.body), 'push results leaked B data');
    for (const coll of ['clients', 'invoices', 'timeEntries']) {
      const b = await call(app, { url: `/api/v1/${coll}/${bIds[coll]}`, token: B.token });
      assert.equal(b.status, 200, `${coll} still there for B`);
      assert.equal(b.body.version, 1, `${coll} unchanged for B`);
    }
  });

  test('a mutation id used by B does not block or replay into A', async () => {
    const mid = 'shared-mid-123';
    const rb = await push(B.token, [{ mid, collection: 'locations', id: 'loc-b', op: 'upsert', baseVersion: null, data: { name: SECRET } }]);
    assert.equal(rb.body.results[0].status, 'ok');
    const ra = await push(A.token, [{ mid, collection: 'locations', id: 'loc-a', op: 'upsert', baseVersion: null, data: { name: 'Alpha van' } }]);
    assert.equal(ra.body.results[0].status, 'ok');
    assert.ok(!mentionsSecret(ra.body));
    assert.equal((await call(app, { url: '/api/v1/locations/loc-a', token: A.token })).body.name, 'Alpha van');
  });

  test('audit log: A sees only its own events', async () => {
    const r = await call(app, { url: '/api/v1/auditLog?limit=500', token: A.token });
    assert.equal(r.status, 200);
    assert.ok(!mentionsSecret(r.body));
    const { rows } = await t.superPool.query('SELECT max(seq) AS s FROM audit_events WHERE tenant_id = $1', [B.tenantId]);
    assert.equal((await call(app, { url: `/api/v1/auditLog/${rows[0].s}`, token: A.token })).status, 404);
  });

  test('A cannot switch its session into B', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/switch-tenant', token: A.token, body: { tenantId: B.tenantId } });
    assert.equal(r.status, 403);
    const me = await call(app, { url: '/api/v1/me', token: A.token });
    assert.equal(me.body.tenant.id, A.tenantId);
  });

  test('A cannot manage B\'s members, keys, devices or secrets by id', async () => {
    const bMember = (await t.superPool.query('SELECT id FROM memberships WHERE tenant_id = $1', [B.tenantId])).rows[0].id;
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/members/${bMember}`, token: A.token, body: { role: 'apprentice' } })).status, 404);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/members/${bMember}`, token: A.token })).status, 404);
    const bKey = await apiKey(app, B.token, ['jobs:read']);
    const bKeyId = (await t.superPool.query('SELECT id FROM api_keys WHERE tenant_id = $1', [B.tenantId])).rows[0].id;
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/api-keys/${bKeyId}`, token: A.token })).status, 404);
    assert.equal((await call(app, { url: '/api/v1/jobs', token: bKey })).status, 200, 'B key still works');
    await call(app, { method: 'PUT', url: '/api/v1/secrets/stripe.secret_key', token: B.token, body: { value: SECRET } });
    const s = await call(app, { url: '/api/v1/secrets', token: A.token });
    assert.ok(!s.body.data.some((x) => x.name === 'stripe.secret_key'));
    assert.equal((await call(app, { method: 'DELETE', url: '/api/v1/secrets/stripe.secret_key', token: A.token })).status, 404);
  });
});

describe('API keys: scope limits', { skip }, () => {
  test('a jobs:read key reads jobs only and cannot write', async () => {
    assert.equal((await call(app, { url: '/api/v1/jobs', token: keyAReadJobs })).status, 200);
    assert.equal((await call(app, { url: '/api/v1/clients', token: keyAReadJobs })).status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/jobs', token: keyAReadJobs, body: { title: 'x' } })).status, 403);
    const p = await push(keyAReadJobs, [mut({ collection: 'jobs', id: 'k1', op: 'upsert', data: { title: 'x' } })]);
    assert.equal(p.body.results[0].status, 'rejected');
    const pulled = await pullAll(keyAReadJobs);
    assert.ok(pulled.every((c) => c.collection === 'jobs'));
    assert.ok(pulled.length > 0);
  });

  test('a test key is refused when the server runs as production', async () => {
    const { app: prod } = await startApp(t, { env: { APP_ENV: 'production', DATABASE_URL: 'postgres://unused', SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') } });
    const r = await call(prod, { url: '/api/v1/jobs', token: keyA });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'invalid_api_key');
    await prod.close();
  });
});

describe('database: fishtape_app without a tenant sees nothing and cannot cross tenants', { skip }, () => {
  test('no tenant set: every tenant table reads as empty', async () => {
    for (const coll of TABLE_COLLECTIONS) {
      const table = collectionDef(coll).table;
      const all = await t.superPool.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.ok(all.rows[0].n > 0, `${table} has data`);
      const r = await t.appPool.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(r.rows[0].n, 0, `${table} visible without tenant`);
    }
    for (const table of ['audit_events', 'sync_mutations', 'record_history', 'tenant_secrets']) {
      const r = await t.appPool.query(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(r.rows[0].n, 0, `${table} visible without tenant`);
    }
  });

  test('the tenant setting does not leak to the next use of a pooled connection', async () => {
    const client = await t.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenantId]);
      assert.ok((await client.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n > 0);
      await client.query('COMMIT');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 0);
      // A session-level SET would persist; the app never does it, and an empty value still means no tenant.
      await client.query("SELECT set_config('app.tenant_id', '', false)");
      assert.equal((await client.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 0);
    } finally {
      client.release();
    }
  });

  test('inside tenant A: B\'s rows are invisible, and writing them is refused', async () => {
    await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      const seen = await tx.query('SELECT DISTINCT tenant_id FROM jobs');
      assert.deepEqual(seen.rows.map((r) => r.tenant_id), [A.tenantId]);
      const upd = await tx.query("UPDATE jobs SET data = '{\"title\":\"pwned\"}' WHERE tenant_id = $1", [B.tenantId]);
      assert.equal(upd.rowCount, 0);
    });
    await assert.rejects(
      t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("INSERT INTO jobs (tenant_id, id, data) VALUES ($1, 'evil', '{}')", [B.tenantId])),
      /row-level security/);
    await assert.rejects(
      t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("UPDATE jobs SET tenant_id = $1 WHERE tenant_id = $2 AND id = 'a-job-1'", [B.tenantId, A.tenantId])),
      /immutable|row-level security/);
    await assert.rejects(
      t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("INSERT INTO audit_events (tenant_id, actor_type, action) VALUES ($1, 'user', 'forged')", [B.tenantId])),
      /row-level security/);
    await assert.rejects(t.appPool.query("INSERT INTO jobs (tenant_id, id, data) VALUES ($1, 'evil2', '{}')", [B.tenantId]), /row-level security/);
    const still = await t.superPool.query("SELECT count(*)::int AS n FROM jobs WHERE id IN ('evil', 'evil2')");
    assert.equal(still.rows[0].n, 0);
  });

  test('the app role cannot delete tenant rows, edit the audit log, or read chain heads', async () => {
    await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      await assert.rejects(tx.savepoint(() => tx.query("DELETE FROM jobs WHERE id = 'a-job-1'")), /permission denied/);
      await assert.rejects(tx.savepoint(() => tx.query("UPDATE audit_events SET summary = 'x'")), /permission denied/);
      await assert.rejects(tx.savepoint(() => tx.query('DELETE FROM audit_events')), /permission denied/);
      await assert.rejects(tx.savepoint(() => tx.query('SELECT * FROM audit_chain_heads')), /permission denied/);
    });
  });

  test('withTenant refuses a missing or malformed tenant id', async () => {
    await assert.rejects(t.db.withTenant({ tenantId: null }, async () => {}), /tenant id/);
    await assert.rejects(t.db.withTenant({ tenantId: "x' OR '1'='1" }, async () => {}), /tenant id/);
  });

  test('client-portal context: one client\'s rows, read-only', async () => {
    const c = await push(B.token, [
      mut({ collection: 'clients', id: 'portal-c1', op: 'upsert', data: { name: 'Portal client' } }),
      mut({ collection: 'jobs', id: 'portal-j1', op: 'upsert', data: { title: 'Their job', clientId: 'portal-c1' } }),
    ]);
    assert.ok(c.body.results.every((r) => r.status === 'ok'));
    await t.db.withTenant({ tenantId: B.tenantId, portalClientId: 'portal-c1' }, async (tx) => {
      assert.deepEqual((await tx.query('SELECT id FROM jobs')).rows.map((r) => r.id), ['portal-j1']);
      assert.deepEqual((await tx.query('SELECT id FROM clients')).rows.map((r) => r.id), ['portal-c1']);
      assert.equal((await tx.query('SELECT count(*)::int AS n FROM employees')).rows[0].n, 0);
      await assert.rejects(tx.savepoint(() => tx.query("UPDATE jobs SET data = '{}' WHERE id = 'portal-j1'")), /row-level security/);
    });
  });
});

describe('audit hash chain', { skip }, () => {
  test('each tenant chain verifies, and tampering is detected', async () => {
    const verify = (tenantId) => t.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM audit_verify_chain($1)', [tenantId])).rows[0]);
    const a = await verify(A.tenantId);
    assert.equal(a.ok, true);
    assert.ok(a.checked > 5);
    // A cannot verify (read) B's chain: it sees no rows, so the head does not match.
    const cross = await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => (await tx.query('SELECT * FROM audit_verify_chain($1)', [B.tenantId])).rows[0]);
    assert.equal(cross.checked, 0);

    const c = await t.superPool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query("UPDATE audit_events SET summary = 'rewritten' WHERE seq = (SELECT min(seq) + 2 FROM audit_events WHERE tenant_id = $1)", [B.tenantId]);
      await c.query('SET session_replication_role = DEFAULT');
    } finally { c.release(); }
    const b = await verify(B.tenantId);
    assert.equal(b.ok, false);
    assert.ok(b.first_bad_seq);
  });

  test('deleting the newest events is detected too', async () => {
    const c = await t.superPool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query('DELETE FROM audit_events WHERE seq = (SELECT max(seq) FROM audit_events WHERE tenant_id = $1)', [A.tenantId]);
      await c.query('SET session_replication_role = DEFAULT');
    } finally { c.release(); }
    const a = await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => (await tx.query('SELECT * FROM audit_verify_chain($1)', [A.tenantId])).rows[0]);
    assert.equal(a.ok, false);
  });
});

// ---- QuickBooks (docs/integrations/quickbooks.md 10.2) ------------------------------------------

describe('QuickBooks: tenant A never reaches tenant B', { skip }, () => {
  const fake = createFakeQbo();
  const QBO_ENV = { QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'iso-verifier' };
  const realmA = '7700100000000001';
  const realmB = '7700100000000002';
  let qapp, qconfig, deps, conflictB;

  const setUp = async (T, realmId) => {
    fake.addCompany(realmId);
    assert.equal((await connectViaFake(fake, { db: t.db, sealer: qapp.sealer, config: qconfig, tenantId: T.tenantId, userId: T.userId, realmId })).result, 'ok');
    await refreshReference(deps, T.tenantId, { force: true });
    await t.superPool.query(`UPDATE qbo_connections SET state = 'active', setup = '{"phase":"done"}'::jsonb, cdc_cursor = now() - interval '1 minute', time_cursor = now() WHERE tenant_id = $1`, [T.tenantId]);
    await t.superPool.query('DELETE FROM qbo_outbox WHERE tenant_id = $1', [T.tenantId]);
  };
  const passFor = async (T) => {
    await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second' WHERE tenant_id = $1", [T.tenantId]);
    const lease = await acquireLease(t.db, T.tenantId, 'iso');
    try { return await syncTenant(deps, T.tenantId, { epoch: lease.epoch }); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
  };

  before(async () => {
    if (skip) return;
    setFetch((u, i) => fake.fetch(u, i));
    ({ app: qapp, config: qconfig } = await startApp(t, { env: QBO_ENV }));
    deps = { db: t.db, sealer: qapp.sealer, config: qconfig, records: createRecords({ validator: createValidator(), config: qconfig }) };
    await setUp(A, realmA);
    await setUp(B, realmB);
    // B: one client in QuickBooks, a log, a candidate and an open conflict, all carrying B's marker.
    await call(qapp, { method: 'POST', url: '/api/v1/clients', token: B.token, body: { id: 'b-qbo-client', name: `${SECRET} QBO` } });
    await passFor(B);
    const link = (await t.superPool.query("SELECT * FROM qbo_links WHERE tenant_id = $1 AND record_id = 'b-qbo-client'", [B.tenantId])).rows[0];
    assert.equal(link?.state, 'synced');
    const { rows } = await t.superPool.query(
      "INSERT INTO qbo_conflicts (tenant_id, link_id, kind, collection, record_id, label, fields) VALUES ($1, $2, 'fields', 'clients', 'b-qbo-client', $3, '[]') RETURNING id",
      [B.tenantId, link.id, SECRET]);
    conflictB = rows[0].id;
    await t.superPool.query("INSERT INTO qbo_candidates (tenant_id, realm_hash, kind, fishtape_id, status, choice, qbo_summary) VALUES ($1, $2, 'customers', 'b-qbo-client', 'fishtape_only', 'skip', $3)",
      [B.tenantId, link.realm_hash, JSON.stringify({ name: SECRET })]);
  });
  after(async () => { setFetch(null); await qapp?.close(); });

  test("A's QuickBooks routes never show B's links, log, conflicts, candidates or status", async () => {
    const urls = ['/api/v1/qbo/status', '/api/v1/qbo/log', '/api/v1/qbo/conflicts?status=open', '/api/v1/qbo/setup/matches', '/api/v1/qbo/records/status?collection=clients',
      '/api/v1/qbo/records/clients/b-qbo-client', '/api/v1/qbo/checks', '/api/v1/qbo/mappings'];
    for (const url of urls) {
      const r = await call(qapp, { url, token: A.token });
      assert.ok(r.status < 500, `${url}: ${r.status}`);
      assert.ok(!mentionsSecret(r.body), `${url} shows B's data`);
    }
    const view = await call(qapp, { url: '/api/v1/qbo/records/clients/b-qbo-client', token: A.token });
    assert.equal(view.body.state, null);
    assert.equal((await call(qapp, { url: `/api/v1/qbo/conflicts/${conflictB}`, token: A.token })).status, 404);
  });

  test("A cannot resolve B's conflict, unlink B's record or link to B's QuickBooks objects", async () => {
    const res = await call(qapp, { method: 'POST', url: `/api/v1/qbo/conflicts/${conflictB}/resolve`, token: A.token, body: { choice: 'quickbooks' } });
    assert.equal(res.status, 404);
    const un = await call(qapp, { method: 'DELETE', url: '/api/v1/qbo/records/clients/b-qbo-client/link', token: A.token });
    assert.equal(un.status, 404);
    const bLink = (await t.superPool.query("SELECT qbo_id, state FROM qbo_links WHERE tenant_id = $1 AND record_id = 'b-qbo-client'", [B.tenantId])).rows[0];
    assert.equal(bLink.state, 'synced');
    assert.equal((await t.superPool.query('SELECT status FROM qbo_conflicts WHERE id = $1', [conflictB])).rows[0].status, 'open');
    // B's QuickBooks object is not in A's company: relinking A's record to its id reads A's own realm and finds nothing.
    await call(qapp, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { id: 'a-qbo-client', name: 'Alpha QBO' } });
    const re = await call(qapp, { method: 'PUT', url: '/api/v1/qbo/records/clients/a-qbo-client/link', token: A.token, body: { qboId: String(Number(bLink.qbo_id) + 1000) } });
    assert.equal(re.status, 404);
  });

  test("a webhook for B's realm never touches A's rows", async () => {
    await t.superPool.query('UPDATE qbo_connections SET dirty_at = NULL WHERE tenant_id = ANY($1)', [[A.tenantId, B.tenantId]]);
    fake.company(realmB).events.length = 0;
    fake.create(realmB, 'TimeActivity', { NameOf: 'Employee', Hours: 1, Minutes: 0 });
    const h = fake.signedWebhook(realmB, QBO_ENV.QBO_WEBHOOK_VERIFIER);
    const r = await qapp.inject({ method: 'POST', url: '/api/v1/webhooks/qbo', headers: { 'content-type': 'application/json', 'intuit-signature': h.signature }, payload: h.raw });
    assert.equal(r.statusCode, 200);
    const conns = (await t.superPool.query('SELECT tenant_id, dirty_at FROM qbo_connections WHERE tenant_id = ANY($1)', [[A.tenantId, B.tenantId]])).rows;
    assert.ok(conns.find((c) => c.tenant_id === B.tenantId).dirty_at);
    assert.equal(conns.find((c) => c.tenant_id === A.tenantId).dirty_at, null);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM qbo_inbox WHERE tenant_id = $1', [A.tenantId])).rows[0].n, 0);
  });

  test("the app role, in A's transaction, can neither read nor write B's QuickBooks rows", async () => {
    await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      for (const table of ['qbo_links', 'qbo_conflicts', 'qbo_candidates', 'qbo_sync_log', 'qbo_mappings', 'qbo_outbox', 'qbo_connections']) {
        const { rows } = await tx.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [B.tenantId]);
        assert.equal(rows[0].n, 0, table);
      }
      const upd = await tx.query("UPDATE qbo_links SET state = 'unlinked' WHERE tenant_id = $1", [B.tenantId]);
      assert.equal(upd.rowCount, 0);
    });
    await assert.rejects(t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query(
      "INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, rank) VALUES ($1, 'clients', 'x', 'upsert', 10)", [B.tenantId])), /row-level security/);
  });
});
