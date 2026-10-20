// Intuit webhook ingest against the fake QuickBooks and a real Postgres (docs/integrations/quickbooks.md
// 5.9, 10.2, 11.3 W1): signatures (current and previous verifier), routing by realm hash, the dirty
// flag, the bounded inbox (TimeActivity and merges, newest event wins), unknown realms and
// disconnected connections dropped, sync and reference refresh queued, legacy bodies.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { readConfig } from '../src/config.js';
import { createSealer } from '../src/lib/crypto.js';
import { setFetch } from '../src/integrations/http.js';
import { createTenantWithOwner } from '../src/services/tenants.js';
import { disconnect, setPaused } from '../src/qbo/connection.js';
import { ingestWebhook, parseWebhook, receiveWebhook } from '../src/qbo/webhook.js';

const KEY = randomBytes(32).toString('base64');
const fake = createFakeQbo();
const VERIFIER = `verifier-${randomBytes(8).toString('hex')}`;
const OLD_VERIFIER = `verifier-${randomBytes(8).toString('hex')}`;
const mkConfig = (env = {}) => readConfig({
  APP_ENV: 'test', SECRETS_MASTER_KEY: KEY, PUBLIC_ORIGIN: 'https://app.fishtape.test', QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: VERIFIER, ...env,
});
const config = mkConfig();
const sealer = createSealer(KEY);
const RA = '9130350000000101';
const RB = '9130350000000202';
let t, A, B;

const conn = (tenantId) => t.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT state, dirty_at, last_webhook_at FROM qbo_connections')).rows[0]);
const inbox = (tenantId) => t.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT entity, qbo_id, op, deleted_id, event_time, processed_at, attempts FROM qbo_inbox ORDER BY entity, qbo_id')).rows);
const jobs = async (tenantId) => (await t.superPool.query("SELECT kind, dedupe_key FROM jobs_queue WHERE tenant_id = $1 AND status = 'queued' ORDER BY kind", [tenantId])).rows;
const post = (raw, sig, cfg = config) => receiveWebhook(t.db, sealer, cfg, raw, sig);
const ce = (realmId, type, id, extra = {}) => ({ id: randomBytes(4).toString('hex'), type, time: new Date().toISOString(), intuitentityid: String(id), intuitaccountid: realmId, data: {}, ...extra });
const signed = (events, v = VERIFIER) => { const raw = Buffer.from(JSON.stringify(events)); return { raw, sig: fake.sign(raw, v) }; };

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qbowebhook');
  const mk = async (name) => {
    const r = await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: name } });
    return { tenantId: r.tenant.id, userId: r.userId };
  };
  A = await mk('Alpha Electric');
  B = await mk('Bravo Electric');
  fake.addCompany(RA);
  fake.addCompany(RB);
  for (const [who, realmId] of [[A, RA], [B, RB]]) {
    const r = await connectViaFake(fake, { db: t.db, sealer, config, tenantId: who.tenantId, userId: who.userId, realmId });
    assert.equal(r.result, 'ok');
    await t.db.withTenant({ tenantId: who.tenantId }, (tx) => tx.query("UPDATE qbo_connections SET state = 'active'"));
  }
  await t.superPool.query("DELETE FROM jobs_queue WHERE kind LIKE 'qbo_%'");
});
after(async () => { setFetch(null); await t?.close(); });

describe('signatures', { skip }, () => {
  test('bad or missing signature: 401, nothing stored, the failure counted', async () => {
    const { raw } = signed([ce(RA, 'qbo.customer.updated.v1', 1)]);
    for (const sig of [undefined, '', fake.sign(raw, 'wrong'), fake.sign(Buffer.from('other'), VERIFIER)]) {
      const r = await post(raw, sig);
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'invalid_signature');
    }
    assert.equal((await conn(A.tenantId)).dirty_at, null);
    const { rows } = await t.superPool.query("SELECT count(*)::int AS n FROM qbo_platform_events WHERE kind = 'webhook_signature'");
    assert.equal(rows[0].n, 4);
  });

  test('during a rotation a body signed with the previous verifier is accepted, and refused once it is removed', async () => {
    const rotating = mkConfig({ QBO_WEBHOOK_VERIFIER: VERIFIER, QBO_WEBHOOK_VERIFIER_PREVIOUS: OLD_VERIFIER });
    const { raw, sig } = signed([ce(RA, 'qbo.customer.updated.v1', 1)], OLD_VERIFIER);
    assert.equal((await post(raw, sig, rotating)).status, 200);
    assert.equal((await post(raw, sig)).status, 401);
  });

  test('QuickBooks off on the server: 503', async () => {
    const { raw, sig } = signed([]);
    assert.equal((await post(raw, sig, mkConfig({ QBO_ENVIRONMENT: '' }))).status, 503);
  });
});

describe('ingest', { skip }, () => {
  test('routing by realm: A marked dirty, TimeActivity and merges in the inbox, a sync queued; B untouched', async () => {
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('UPDATE qbo_connections SET dirty_at = NULL'));
    const r = await post(...Object.values(signed([
      ce(RA, 'qbo.customer.created.v1', 58),
      ce(RA, 'qbo.invoice.updated.v1', 130),
      ce(RA, 'qbo.timeactivity.created.v1', 7),
      ce(RA, 'qbo.customer.merged.v1', 58, { data: { deletedid: '61' } }),
    ])));
    assert.deepEqual(r, { status: 200, body: { received: 4 } });
    const c = await conn(A.tenantId);
    assert.ok(c.dirty_at && c.last_webhook_at);
    const ib = await inbox(A.tenantId);
    assert.deepEqual(ib.map((x) => [x.entity, x.qbo_id, x.op, x.deleted_id]), [['Customer', '58', 'merged', '61'], ['TimeActivity', '7', 'created', null]]);
    assert.deepEqual((await jobs(A.tenantId)).map((j) => j.dedupe_key), [`qbo_sync:${A.tenantId}`]);
    assert.equal((await conn(B.tenantId)).dirty_at, null);
    assert.deepEqual(await inbox(B.tenantId), []);
    assert.deepEqual(await jobs(B.tenantId), []);
  });

  test('one inbox row per object however many events arrive while paused; the newest wins and is processed again', async () => {
    await setPaused(t.db, A.tenantId, true, 'user');
    await t.superPool.query("DELETE FROM jobs_queue WHERE tenant_id = $1", [A.tenantId]);
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query("UPDATE qbo_inbox SET processed_at = now(), attempts = 3 WHERE entity = 'TimeActivity'"));
    const base = Date.now();
    const evs = Array.from({ length: 25 }, (_, i) => ce(RA, i === 24 ? 'qbo.timeactivity.deleted.v1' : 'qbo.timeactivity.updated.v1', 7, { time: new Date(base + i * 1000).toISOString() }));
    assert.equal((await post(...Object.values(signed(evs)))).status, 200);
    const older = ce(RA, 'qbo.timeactivity.updated.v1', 7, { time: new Date(base - 60_000).toISOString() });
    assert.equal((await post(...Object.values(signed([older])))).status, 200);
    const row = (await inbox(A.tenantId)).filter((x) => x.entity === 'TimeActivity');
    assert.equal(row.length, 1);
    assert.equal(row[0].op, 'deleted', 'the newest event, not the late older one');
    assert.equal(row[0].processed_at, null);
    assert.equal(row[0].attempts, 0);
    assert.ok((await conn(A.tenantId)).dirty_at, 'paused tenants are still marked dirty');
    assert.deepEqual(await jobs(A.tenantId), [], 'no sync while paused');
    await setPaused(t.db, A.tenantId, false, 'user');
  });

  test('reference lists and preferences queue a reference refresh', async () => {
    await t.superPool.query("DELETE FROM jobs_queue WHERE tenant_id = $1", [A.tenantId]);
    await post(...Object.values(signed([ce(RA, 'qbo.account.updated.v1', 3), ce(RA, 'qbo.preferences.updated.v1', 1)])));
    const kinds = (await jobs(A.tenantId)).map((j) => j.kind);
    assert.ok(kinds.includes('qbo_reference_refresh'));
    assert.ok(kinds.includes('qbo_sync'));
  });

  test('the fake emitter: signed CloudEvents for its own changes, and the legacy shape, both ingested', async () => {
    fake.create(RB, 'Customer', { DisplayName: 'Webhook Person' });
    fake.create(RB, 'TimeActivity', { NameOf: 'Employee', Hours: 2, Minutes: 0, TxnDate: '2026-10-20' });
    const one = fake.signedWebhook(RB, VERIFIER);
    assert.deepEqual(await post(one.raw, one.signature), { status: 200, body: { received: 2 } });
    assert.equal((await inbox(B.tenantId)).length, 1);
    fake.create(RB, 'Vendor', { DisplayName: 'Legacy Supply' });
    const legacy = fake.signedWebhook(RB, VERIFIER, { legacy: true });
    assert.equal(parseWebhook(legacy.raw)[0].entity, 'Vendor');
    assert.equal((await post(legacy.raw, legacy.signature)).status, 200);
  });

  test('unknown realms and disconnected connections drop everything', async () => {
    const r = await ingestWebhook(t.db, sealer, config, parseWebhook(Buffer.from(JSON.stringify([ce('5550000000000001', 'qbo.timeactivity.created.v1', 9)]))));
    assert.deepEqual(r, { accepted: 0, dropped: 1 });
    await disconnect(t.db, sealer, config, B.tenantId, { purge: false });
    await t.db.withTenant({ tenantId: B.tenantId }, (tx) => tx.query('UPDATE qbo_connections SET dirty_at = NULL'));
    const r2 = await ingestWebhook(t.db, sealer, config, parseWebhook(Buffer.from(JSON.stringify([ce(RB, 'qbo.timeactivity.created.v1', 9)]))));
    assert.deepEqual(r2, { accepted: 0, dropped: 1 }, 'the realm row went with the disconnect');
    assert.equal((await conn(B.tenantId)).dirty_at, null);
    // Even with a stale realm row, a disconnected connection ignores webhooks.
    const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [B.tenantId]);
    await t.superPool.query("INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, 'sandbox')", [rows[0].realm_hash, B.tenantId]);
    const r3 = await ingestWebhook(t.db, sealer, config, parseWebhook(Buffer.from(JSON.stringify([ce(RB, 'qbo.timeactivity.created.v1', 9)]))));
    assert.deepEqual(r3, { accepted: 0, dropped: 1 });
    assert.ok(!(await inbox(B.tenantId)).some((x) => x.qbo_id === '9'));
  });
});
