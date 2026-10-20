// The QuickBooks sync engine against the fake QuickBooks and a real Postgres (docs/integrations/
// quickbooks.md section 5, 11.3 W3): the records hook in every connection state, push of each
// entity, pull, two-way edits, conflicts and their resolution, the stale-device field merge of 5.10,
// SyncToken echoes, 5010, 429 storms, the safety brake with allow-once, shadow mode, the origin rule,
// the sweep, pause and resume, deletes, unlink tombstones and relink.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { readConfig } from '../src/config.js';
import { createSealer } from '../src/lib/crypto.js';
import { setFetch } from '../src/integrations/http.js';
import { createTenantWithOwner } from '../src/services/tenants.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { permsForRole } from '../src/auth/permissions.js';
import { taxComponents } from '../../electrical-app/js/lib/tax.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { syncTenant, pushRecord } from '../src/qbo/engine.js';
import { resolveConflict, unlinkRecord, relinkRecord } from '../src/qbo/conflicts.js';
import { makeRun } from '../src/qbo/engine.js';
import { setPaused, loadConnection } from '../src/qbo/connection.js';
import { sweep } from '../src/qbo/sweep.js';
import { createQboHandlers, dispatch } from '../src/qbo/jobs.js';
import { claim, enqueue, runOnce } from '../src/services/queue.js';
import { resetUsageCache } from '../src/qbo/client.js';

const KEY = randomBytes(32).toString('base64');
const fake = createFakeQbo();
const config = readConfig({
  APP_ENV: 'test', SECRETS_MASTER_KEY: KEY, PUBLIC_ORIGIN: 'https://app.fishtape.test', QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'v1',
});
const sealer = createSealer(KEY);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });
let t, records, deps;
let realmN = 0;

const principal = (tenantId, userId, role = 'owner', extra = {}) => ({
  kind: 'session', tenantId, userId, sessionId: null, role, perms: permsForRole(role), isManager: ['owner', 'admin', 'office', 'foreman'].includes(role),
  employeeId: null, scopes: null, crew: false, actor: { type: 'user', id: userId, label: `${role} tester` }, ...extra,
});
const whoOf = (p) => ({ actor: p.actor, request: {} });
const MB_TAX = () => taxComponents({ province: 'MB', treatment: 'pst-all' });

/** A tenant connected to a fresh fake realm, with mappings, reference lists and (by default) active. */
async function setupTenant(name, { options = {}, active = true } = {}) {
  const realmId = `91303500${String(++realmN).padStart(8, '0')}`;
  fake.addCompany(realmId, { name: `${name} QBO` });
  const r = await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: `${name} Owner` } });
  const T = { tenantId: r.tenant.id, userId: r.userId, realmId, name };
  T.p = principal(T.tenantId, T.userId);
  const res = await connectViaFake(fake, { db: t.db, sealer, config, tenantId: T.tenantId, userId: T.userId, realmId });
  assert.equal(res.result, 'ok');
  await refreshReference(deps, T.tenantId, { force: true });
  const s = fake.seed(realmId);
  T.seed = s;
  const maps = {
    item: { material: s.items.materials.Id, labour: s.items.labour.Id, other: s.items.materials.Id },
    taxCode: { 'GST+RST|MB': s.taxCodes.gstPst.Id, GST: s.taxCodes.gst.Id, 'NONE|EXEMPT': s.taxCodes.exempt.Id, 'NONE|ZERO': s.taxCodes.zero.Id, 'NONE|OOS': s.taxCodes.oos.Id },
    purchaseTaxCode: { 'GST+RST|MB': s.taxCodes.gst.Id, GST: s.taxCodes.gst.Id, NONE: s.taxCodes.exempt.Id, stripeFee: s.taxCodes.exempt.Id },
    account: {
      'income.default': s.accounts.income.Id, 'expense.default': s.accounts.cogs.Id, 'jobCost.material': s.accounts.materials.Id,
      stripeClearing: s.accounts.stripe.Id, stripeFees: s.accounts.stripeFees.Id, stripePayoutBank: s.accounts.bank.Id,
    },
    paymentMethod: { cash: s.paymentMethods.Cash.Id, check: s.paymentMethods.Cheque.Id, card: s.paymentMethods['Credit Card'].Id, 'e-transfer': s.paymentMethods['E-Transfer'].Id },
    depositTo: { cash: s.accounts.undeposited.Id, check: s.accounts.undeposited.Id, card: s.accounts.undeposited.Id, 'e-transfer': s.accounts.undeposited.Id, transfer: s.accounts.undeposited.Id },
    option: { syncFrom: '2000-01-01', timeOwner: 'fishtape', ...options },
  };
  await setMappings(T, maps);
  await t.db.withTenant({ tenantId: T.tenantId }, (tx) => records.createRecord(tx, T.p, 'settings', { id: 'settings', company: { name, province: 'MB' }, nextNumbers: { invoice: 3001, estimate: 2001 } }, whoOf(T.p)), { write: true });
  if (active) await makeActive(T);
  fake.company(realmId).events.length = 0;
  return T;
}

async function setMappings(T, maps) {
  const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
  for (const [kind, kv] of Object.entries(maps)) {
    for (const [key, value] of Object.entries(kv)) {
      await t.superPool.query(
        `INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value`, [T.tenantId, rows[0].realm_hash, kind, key, JSON.stringify(value)]);
    }
  }
}
const makeActive = (T) => t.superPool.query(
  `UPDATE qbo_connections SET state = 'active', setup = '{"phase":"done"}'::jsonb, cdc_cursor = now() - interval '1 minute', time_cursor = now(), last_check_at = now() WHERE tenant_id = $1`, [T.tenantId]);

const write = (T, fn) => t.db.withTenant({ tenantId: T.tenantId }, fn, { write: true });
const create = (T, coll, body, p = T.p) => write(T, (tx) => records.createRecord(tx, p, coll, body, whoOf(p)));
const patch = (T, coll, id, body, p = T.p) => write(T, (tx) => records.patchRecord(tx, p, coll, id, body, {}, whoOf(p)));
const remove = (T, coll, id, p = T.p) => write(T, (tx) => records.deleteRecord(tx, p, coll, id, {}, whoOf(p)));
const push = (T, mutations, p = T.p) => write(T, (tx) => records.push(tx, p, mutations, whoOf(p)));
const due = (T) => t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second' WHERE tenant_id = $1", [T.tenantId]);

async function pass(T, o = {}) {
  await due(T);
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  assert.ok(lease, 'lease');
  try {
    return await syncTenant({ ...deps, ...(o.deps || {}) }, T.tenantId, { epoch: lease.epoch, ...o });
  } finally {
    await releaseLease(t.db, T.tenantId, lease.epoch);
  }
}
async function withLeaseDo(T, fn) {
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  try { return await fn(lease.epoch); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
}
const link = async (T, coll, id, role = 'main') => (await t.superPool.query('SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = $4', [T.tenantId, coll, id, role])).rows[0];
const rec = async (T, table, id) => { const r = (await t.superPool.query(`SELECT data, version, deleted_at FROM ${table} WHERE tenant_id = $1 AND id = $2`, [T.tenantId, id])).rows[0]; return r ? { ...r.data, version: Number(r.version), deleted: Boolean(r.deleted_at) } : null; };
const outbox = async (T) => (await t.superPool.query('SELECT * FROM qbo_outbox WHERE tenant_id = $1 ORDER BY collection, record_id', [T.tenantId])).rows;
const conflicts = async (T, status = 'open') => (await t.superPool.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND status = $2 ORDER BY created_at', [T.tenantId, status])).rows;
const logs = async (T, where = 'true') => (await t.superPool.query(`SELECT * FROM qbo_sync_log WHERE tenant_id = $1 AND ${where} ORDER BY id`, [T.tenantId])).rows;
const writes = (realmId) => fake.calls.filter((c) => c.realmId === realmId && c.kind === 'core');
const conn = (T) => t.db.withTenant({ tenantId: T.tenantId }, loadConnection);

function invoice(o = {}) {
  return {
    number: 'INV-3001', issueDate: TODAY, dueDate: TODAY, status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all', taxes: MB_TAX(), taxPct: 12,
    lines: [{ description: 'Wire and boxes', qty: 2, unitCents: 5000, kind: 'material' }, { description: 'Labour', qty: 3, unitCents: 9500, kind: 'labour' }],
    ...o,
  };
}

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qbosync');
  records = createRecords({ validator: createValidator(), config });
  deps = { db: t.db, sealer, config, records };
});
after(async () => { setFetch(null); await t?.close(); });

describe('records hook', { skip }, () => {
  test('queues an outbox row in every connection state, never for the engine itself, and a pass only when active', async () => {
    const T = await setupTenant('Hook Electric', { active: false });
    await create(T, 'clients', { id: 'c-hook', name: 'Hook Client' });
    let rows = await outbox(T);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_type, 'user');
    assert.equal(rows[0].rank, 10);
    let jobs = (await t.superPool.query("SELECT 1 FROM jobs_queue WHERE tenant_id = $1 AND kind = 'qbo_sync' AND status = 'queued'", [T.tenantId])).rows;
    assert.equal(jobs.length, 0, 'setup: no pass');
    await makeActive(T);
    await patch(T, 'clients', 'c-hook', { phone: '204-555-0100' });
    jobs = (await t.superPool.query("SELECT run_at - now() AS wait FROM jobs_queue WHERE tenant_id = $1 AND kind = 'qbo_sync' AND status = 'queued'", [T.tenantId])).rows;
    assert.equal(jobs.length, 1, 'active: one debounced pass');
    rows = await outbox(T);
    assert.equal(rows.length, 1, 'one row per record');
    // The engine's own write is never queued (loop prevention, first layer).
    const qbo = { ...principal(T.tenantId, null), kind: 'system', actor: { type: 'system', id: 'qbo', label: 'QuickBooks sync' } };
    await t.superPool.query('DELETE FROM qbo_outbox WHERE tenant_id = $1', [T.tenantId]);
    await patch(T, 'clients', 'c-hook', { phone: '204-555-0101' }, qbo);
    assert.equal((await outbox(T)).length, 0);
    // Disconnected still queues (a same-company reconnect pushes them).
    await t.superPool.query("UPDATE qbo_connections SET state = 'disconnected' WHERE tenant_id = $1", [T.tenantId]);
    await patch(T, 'clients', 'c-hook', { phone: '204-555-0102' });
    assert.equal((await outbox(T)).length, 1);
    // Collections that do not sync are ignored; deletes queue op delete.
    await create(T, 'sops', { id: 'sop-1', title: 'Lockout' });
    await remove(T, 'clients', 'c-hook');
    rows = await outbox(T);
    assert.deepEqual(rows.map((r) => [r.collection, r.op]), [['clients', 'delete']]);
  });

  test('an api key or agent in a burst keeps the row held for review; field roles are field_user', async () => {
    const T = await setupTenant('Burst Electric', { active: false });
    const key = { kind: 'api_key', tenantId: T.tenantId, userId: null, role: null, perms: new Set(), scopes: ['*:write'], crew: false, actor: { type: 'api_key', id: 'k1', label: 'Zapier' } };
    await write(T, (tx) => tx.query("INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, actor_type, rank) VALUES ($1, 'invoices', 'inv-burst', 'upsert', 'api_key', 40)", [T.tenantId]));
    await create(T, 'invoices', invoice({ id: 'inv-burst', number: 'INV-9001' }));
    assert.equal((await outbox(T))[0].actor_type, 'api_key');
    const { actorTypeOf } = await import('../src/qbo/hooks.js');
    assert.equal(actorTypeOf({ actor: key.actor, kind: 'api_key' }), 'api_key');
    assert.equal(actorTypeOf({ actor: { type: 'agent', id: 'assistant:x' } }), 'agent');
    assert.equal(actorTypeOf({ actor: { type: 'system', id: 'stripe' } }), 'stripe');
    assert.equal(actorTypeOf({ actor: { type: 'user', id: 'u' }, role: 'foreman' }), 'field_user');
    assert.equal(actorTypeOf({ actor: { type: 'user', id: 'u' }, role: 'owner', crew: true }), 'field_user');
    assert.equal(actorTypeOf({ actor: { type: 'user', id: 'u' }, role: 'office' }), 'user');
  });
});

describe('push and pull', { skip }, () => {
  test('a client goes to QuickBooks once, its echo writes nothing, and edits flow both ways', async () => {
    const T = await setupTenant('Twoway Electric');
    await create(T, 'clients', { id: 'c-1', name: 'Dana Smith', email: 'dana@example.ca', phone: '204-555-0101', address: '12 Elm St, Winnipeg, MB R3C 1A1', type: 'residential' });
    let r = await pass(T);
    assert.equal(r.errors, 0, JSON.stringify(r));
    let l = await link(T, 'clients', 'c-1');
    assert.equal(l.state, 'synced');
    assert.match(l.qbo_id, /^\d+$/);
    const cust = fake.get(T.realmId, 'Customer', l.qbo_id);
    assert.equal(cust.DisplayName, 'Dana Smith');
    assert.equal(cust.PrimaryEmailAddr.Address, 'dana@example.ca');
    assert.equal((await outbox(T)).length, 0, 'outbox row deleted with the outcome');
    // The echo (our own create in CDC) writes nothing on either side.
    const before = writes(T.realmId).length;
    const v = (await rec(T, 'clients', 'c-1')).version;
    await pass(T);
    assert.equal(writes(T.realmId).length, before, 'no write to QuickBooks');
    assert.equal((await rec(T, 'clients', 'c-1')).version, v, 'no write to Fishtape');
    // Fishtape edit: a sparse update.
    await patch(T, 'clients', 'c-1', { phone: '204-555-0199' });
    await pass(T);
    assert.equal(fake.get(T.realmId, 'Customer', l.qbo_id).PrimaryPhone.FreeFormNumber, '204-555-0199');
    // QuickBooks edit: pulled into Fishtape by the system actor.
    fake.edit(T.realmId, 'Customer', l.qbo_id, { PrimaryEmailAddr: { Address: 'dana.smith@example.ca' } });
    await pass(T);
    const c = await rec(T, 'clients', 'c-1');
    assert.equal(c.email, 'dana.smith@example.ca');
    const by = (await t.superPool.query('SELECT updated_by FROM clients WHERE tenant_id = $1 AND id = $2', [T.tenantId, 'c-1'])).rows[0].updated_by;
    assert.equal(by, 'system:qbo');
    l = await link(T, 'clients', 'c-1');
    assert.equal(l.sync_token, fake.get(T.realmId, 'Customer', l.qbo_id).SyncToken);
    // QBO Notes never come into Fishtape (4.2).
    fake.edit(T.realmId, 'Customer', l.qbo_id, { Notes: 'Credit hold: owes $900' });
    await pass(T);
    assert.ok(!JSON.stringify(await rec(T, 'clients', 'c-1')).includes('Credit hold'));
    fake.assertNoUnexpected();
  });

  test('an invoice is created with the marker, its client first, tax per rate, and QuickBooks edits come back', async () => {
    const T = await setupTenant('Invoice Electric');
    await create(T, 'clients', { id: 'c-inv', name: 'Invoice Client', email: 'ic@example.ca' });
    await create(T, 'invoices', invoice({ id: 'inv-1', clientId: 'c-inv' }));
    const r = await pass(T);
    assert.equal(r.errors, 0, JSON.stringify(r));
    const l = await link(T, 'invoices', 'inv-1');
    assert.equal(l.state, 'synced', JSON.stringify({ reason: l.reason, err: l.last_error }));
    assert.match(l.meta.marker, /^Fishtape ref [0-9a-f]{12}$/);
    const q = fake.get(T.realmId, 'Invoice', l.qbo_id);
    assert.ok(q.PrivateNote.startsWith(l.meta.marker));
    assert.equal(q.DocNumber, 'INV-3001');
    assert.equal(q.CustomerRef.value, (await link(T, 'clients', 'c-inv')).qbo_id);
    assert.equal(q.TotalAmt, 431.2); // (100 + 285) * 1.12
    assert.equal(q.TxnTaxDetail.TaxLine.length, 2);
    // A due date changed in QuickBooks comes back; the invoice's lines are untouched.
    fake.edit(T.realmId, 'Invoice', l.qbo_id, { DueDate: '2030-01-31' });
    await pass(T);
    const inv = await rec(T, 'invoices', 'inv-1');
    assert.equal(inv.dueDate, '2030-01-31');
    assert.equal(inv.lines.length, 2);
    assert.equal(inv.lines[1].kind, 'labour', 'Fishtape keeps its own line kind');
    // Notes edited in Fishtape go out as CustomerMemo.
    await patch(T, 'invoices', 'inv-1', { notes: 'Thanks for the work' });
    await pass(T);
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).CustomerMemo.value, 'Thanks for the work');
  });

  test('a document with a no-tax line and no reason waits; a mapped 8% code is refused before anything is sent', async () => {
    const T = await setupTenant('Hold Electric');
    await create(T, 'clients', { id: 'c-h', name: 'Hold Client' });
    await create(T, 'invoices', invoice({ id: 'inv-none', number: 'INV-3002', clientId: 'c-h', taxes: [], taxPct: 0, taxTreatment: 'none' }));
    await pass(T);
    let l = await link(T, 'invoices', 'inv-none');
    assert.equal(l.state, 'blocked');
    assert.equal(l.reason, 'tax_reason');
    // The legacy 8% code mapped for GST+RST|MB: blocked/mapping_missing, nothing reaches QuickBooks.
    await setMappings(T, { taxCode: { 'GST+RST|MB': T.seed.taxCodes.old8.Id } });
    const before = writes(T.realmId).filter((c) => c.path === 'invoice').length;
    await create(T, 'invoices', invoice({ id: 'inv-8', number: 'INV-3003', clientId: 'c-h' }));
    await pass(T);
    l = await link(T, 'invoices', 'inv-8');
    assert.equal(l.state, 'blocked');
    assert.equal(l.reason, 'mapping_missing');
    assert.match(l.last_error, /5% \+ 7%/);
    assert.equal(writes(T.realmId).filter((c) => c.path === 'invoice').length, before);
  });

  test('both sides change the lines: a conflict; per-field resolution writes the chosen side', async () => {
    const T = await setupTenant('Conflict Electric');
    await create(T, 'clients', { id: 'c-cf', name: 'Conflict Client' });
    await create(T, 'invoices', invoice({ id: 'inv-cf', number: 'INV-3010', clientId: 'c-cf' }));
    assert.equal((await conn(T)).last_push_at, null);
    await pass(T);
    const l = await link(T, 'invoices', 'inv-cf');
    const pushedAt = (await conn(T)).last_push_at;
    assert.ok(pushedAt, 'a pass that wrote to QuickBooks records when (Status lastPushAt)');
    const q = fake.get(T.realmId, 'Invoice', l.qbo_id);
    // QuickBooks: the bookkeeper changes the first line's amount.
    const lines = q.Line.filter((x) => x.DetailType === 'SalesItemLineDetail');
    lines[0].Amount = 120; lines[0].SalesItemLineDetail.UnitPrice = 60;
    fake.edit(T.realmId, 'Invoice', l.qbo_id, { Line: [...lines] });
    // Fishtape: the office changes the same invoice's lines too.
    await patch(T, 'invoices', 'inv-cf', { lines: [{ description: 'Wire and boxes', qty: 2, unitCents: 5000, kind: 'material' }, { description: 'Labour', qty: 4, unitCents: 9500, kind: 'labour' }] });
    await pass(T);
    const open = await conflicts(T);
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'fields');
    assert.deepEqual(open[0].fields.map((f) => f.field), ['lines']);
    assert.equal((await link(T, 'invoices', 'inv-cf')).state, 'conflict');
    // Nothing written while open.
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).TotalAmt, 453.6, "QuickBooks keeps the bookkeeper's lines");
    const res = await withLeaseDo(T, (epoch) => resolveConflict(deps, T.tenantId, open[0].id, { choice: 'fishtape' }, whoOf(T.p), { epoch }));
    assert.equal(res.status, 'resolved');
    assert.ok(new Date((await conn(T)).last_push_at) > new Date(pushedAt), 'resolving wrote to QuickBooks: lastPushAt moves');
    const after = fake.get(T.realmId, 'Invoice', l.qbo_id);
    assert.equal(after.TotalAmt, Math.round((100 + 380) * 1.12 * 100) / 100, 'Fishtape lines written to QuickBooks');
    assert.equal((await link(T, 'invoices', 'inv-cf')).state, 'synced');
    const audit = (await t.superPool.query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'qbo.conflict.resolve'", [T.tenantId])).rows;
    assert.equal(audit.length, 1);
  });

  test('a conflict closes by itself when the two sides agree again', async () => {
    const T = await setupTenant('Selfclose Electric');
    await create(T, 'items', { id: 'it-1', name: 'Breaker 15A', priceCents: 1500, costCents: 900 });
    await setMappings(T, { option: { items: 'all' } });
    await pass(T);
    const l = await link(T, 'items', 'it-1');
    assert.equal(l.state, 'synced', l.last_error);
    fake.edit(T.realmId, 'Item', l.qbo_id, { UnitPrice: 17 });
    await patch(T, 'items', 'it-1', { priceCents: 1800 });
    await pass(T);
    assert.equal((await conflicts(T)).length, 1);
    await patch(T, 'items', 'it-1', { priceCents: 1700 });
    await pass(T);
    assert.equal((await conflicts(T)).length, 0);
    assert.equal((await conflicts(T, 'resolved'))[0].resolved_by, 'system');
    assert.equal((await link(T, 'items', 'it-1')).state, 'synced');
  });
});

describe('offline device edits (5.10)', { skip }, () => {
  test('example 1: different fields both survive; example 2: a stale money edit is held for a conflict', async () => {
    const T = await setupTenant('Offline Electric');
    await create(T, 'clients', { id: 'c-off', name: 'Offline Client' });
    await create(T, 'invoices', invoice({ id: 'inv-off', number: 'INV-3020', clientId: 'c-off', notes: 'Original' }));
    await pass(T);
    const l = await link(T, 'invoices', 'inv-off');
    const base = await rec(T, 'invoices', 'inv-off');
    const deviceCopy = { ...base };
    delete deviceCopy.version; delete deviceCopy.deleted;
    // Example 1: QuickBooks changes the due date; an offline iPad changes the notes.
    fake.edit(T.realmId, 'Invoice', l.qbo_id, { DueDate: '2031-02-28' });
    await pass(T);
    assert.equal((await rec(T, 'invoices', 'inv-off')).dueDate, '2031-02-28');
    const res1 = await push(T, [{ mid: 'm-off-1', collection: 'invoices', id: 'inv-off', op: 'upsert', baseVersion: base.version, fields: ['notes'], data: { ...deviceCopy, notes: 'From the iPad', updatedAt: new Date().toISOString() } }]);
    assert.equal(res1[0].status, 'conflict', 'the device takes the merged copy');
    let now = await rec(T, 'invoices', 'inv-off');
    assert.equal(now.notes, 'From the iPad');
    assert.equal(now.dueDate, '2031-02-28', 'the QuickBooks change survives');
    await pass(T);
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).CustomerMemo.value, 'From the iPad');
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).DueDate, '2031-02-28');

    // Example 2: the bookkeeper changes the lines in QuickBooks; an offline foreman edited lines too.
    const base2 = await rec(T, 'invoices', 'inv-off');
    const q = fake.get(T.realmId, 'Invoice', l.qbo_id);
    const qLines = q.Line.filter((x) => x.DetailType === 'SalesItemLineDetail');
    qLines[0].Amount = 150; qLines[0].SalesItemLineDetail.UnitPrice = 75;
    fake.edit(T.realmId, 'Invoice', l.qbo_id, { Line: qLines });
    await pass(T);
    const pulled = await rec(T, 'invoices', 'inv-off');
    assert.equal(pulled.lines[0].unitCents, 7500, 'the pull patched the lines');
    const device2 = { ...base2 };
    delete device2.version; delete device2.deleted;
    const res2 = await push(T, [{ mid: 'm-off-2', collection: 'invoices', id: 'inv-off', op: 'upsert', baseVersion: base2.version, fields: ['lines'], data: { ...device2, lines: [{ description: 'Wire and boxes', qty: 2, unitCents: 5000, kind: 'material' }, { description: 'Labour', qty: 5, unitCents: 9500, kind: 'labour' }], updatedAt: new Date().toISOString() } }]);
    assert.equal(res2[0].status, 'conflict');
    now = await rec(T, 'invoices', 'inv-off');
    assert.equal(now.lines[0].unitCents, 7500, "the server keeps QuickBooks' lines");
    const ob = await outbox(T);
    assert.ok(ob[0].held.lines, 'the device lines are held in the outbox');
    assert.equal(ob[0].stale, true);
    await pass(T);
    const open = await conflicts(T);
    assert.equal(open.length, 1);
    assert.equal(open[0].fields[0].field, 'lines');
    assert.match(open[0].fields[0].fishtape, /^2 lines, \$575\.00$/);
    assert.match(open[0].fields[0].quickbooks, /^2 lines, \$435\.00$/);
    // Nothing was overwritten in QuickBooks.
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).Line.find((x) => x.DetailType === 'SalesItemLineDetail').Amount, 150);
    // While it is open, an edit on each side re-runs the merge: the held lines keep it open and
    // nothing is written either way (5.6).
    await patch(T, 'invoices', 'inv-off', { notes: 'Office note' });
    fake.edit(T.realmId, 'Invoice', l.qbo_id, { DueDate: '2031-03-31' });
    await pass(T);
    assert.equal((await conflicts(T)).length, 1, 'still open');
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).CustomerMemo.value, 'From the iPad', 'the office note waits');
    assert.equal((await rec(T, 'invoices', 'inv-off')).dueDate, '2031-02-28', 'the QuickBooks due date waits');
    assert.ok((await link(T, 'invoices', 'inv-off')).meta.held.lines, 'the device lines are still held');
    // Choosing the device's lines writes them to both sides, with the other two changes.
    await withLeaseDo(T, (epoch) => resolveConflict(deps, T.tenantId, open[0].id, { choice: 'fishtape' }, whoOf(T.p), { epoch }));
    assert.equal((await rec(T, 'invoices', 'inv-off')).lines[1].qty, 5);
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).TotalAmt, Math.round(575 * 1.12 * 100) / 100);
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).CustomerMemo.value, 'Office note');
    assert.equal((await rec(T, 'invoices', 'inv-off')).dueDate, '2031-03-31');
    assert.equal((await link(T, 'invoices', 'inv-off')).meta.held, undefined);
  });
});

describe('faults', { skip }, () => {
  test('a stale SyncToken (5010) re-merges against the fresh copy and retries', async () => {
    const T = await setupTenant('Stale Electric');
    await create(T, 'clients', { id: 'c-st', name: 'Stale Client' });
    await pass(T);
    const l = await link(T, 'clients', 'c-st');
    await patch(T, 'clients', 'c-st', { phone: '204-555-0123' });
    fake.failNext({ status: 400, code: '5010', message: 'Stale Object Error', match: (c) => c.method === 'POST' && c.path === 'customer' });
    const r = await pass(T);
    assert.equal(r.errors, 0);
    assert.equal(fake.get(T.realmId, 'Customer', l.qbo_id).PrimaryPhone.FreeFormNumber, '204-555-0123');
  });

  test('a 429 storm stops the pass, sets throttled_until and nothing is duplicated after', async () => {
    const T = await setupTenant('Storm Electric');
    for (let i = 0; i < 3; i++) await create(T, 'clients', { id: `c-storm-${i}`, name: `Storm Client ${i}` });
    fake.failNext({ status: 429, count: 5, match: (c) => c.realmId === T.realmId });
    const r = await pass(T);
    assert.equal(r.stopped, 'throttled');
    const c = await conn(T);
    assert.ok(c.throttled_until && new Date(c.throttled_until) > new Date());
    fake.state.faults.length = 0;
    await t.superPool.query('UPDATE qbo_connections SET throttled_until = NULL WHERE tenant_id = $1', [T.tenantId]);
    const r2 = await pass(T);
    assert.equal(r2.errors, 0, JSON.stringify(r2));
    const names = fake.list(T.realmId, 'Customer').map((x) => x.DisplayName).filter((n) => n.startsWith('Storm'));
    assert.deepEqual(names.sort(), ['Storm Client 0', 'Storm Client 1', 'Storm Client 2']);
  });

  test('a create whose answer is lost is found by its marker, and a crash before the link commit leaves one object', async () => {
    const T = await setupTenant('Retry Electric');
    await create(T, 'clients', { id: 'c-rt', name: 'Retry Client' });
    await pass(T);
    // 1. The answer of the invoice create is lost after QuickBooks made it.
    await create(T, 'invoices', invoice({ id: 'inv-lost', number: 'INV-3030', clientId: 'c-rt' }));
    fake.failNext({ drop: true, match: (c) => c.method === 'POST' && c.path === 'invoice' && c.realmId === T.realmId });
    await pass(T);
    const l1 = await link(T, 'invoices', 'inv-lost');
    assert.equal(l1.state, 'synced', `${l1.state} ${l1.reason} ${l1.last_error} ${JSON.stringify(l1.meta.dependsOn)}`);
    assert.equal(fake.list(T.realmId, 'Invoice').filter((x) => x.DocNumber === 'INV-3030').length, 1);
    // 2. A worker crash between QuickBooks' answer and the commit (here: right after create returns).
    await create(T, 'invoices', invoice({ id: 'inv-crash', number: 'INV-3031', clientId: 'c-rt' }));
    const run = await withLeaseDo(T, (epoch) => makeRun(deps, T.tenantId, { epoch }));
    const crashing = { ...run.client, async create(...a) { await run.client.create(...a); throw new Error('worker crashed'); } };
    await pass(T, { deps: { client: crashing } });
    const mid = await link(T, 'invoices', 'inv-crash');
    assert.equal(mid.state, 'pending');
    assert.equal(mid.qbo_id, null);
    assert.ok(mid.meta.createRequestId && mid.meta.sent);
    await t.superPool.query("UPDATE qbo_outbox SET claimed_until = NULL WHERE tenant_id = $1", [T.tenantId]);
    await pass(T);
    const l2 = await link(T, 'invoices', 'inv-crash');
    assert.equal(l2.state, 'synced');
    assert.equal(fake.list(T.realmId, 'Invoice').filter((x) => x.DocNumber === 'INV-3031').length, 1, 'exactly one QuickBooks invoice');
    // 3. A customer whose create timed out after landing.
    await create(T, 'clients', { id: 'c-to', name: 'Timeout Client' });
    fake.failNext({ drop: true, match: (c) => c.method === 'POST' && c.path === 'customer' && c.realmId === T.realmId });
    await pass(T);
    assert.equal(fake.list(T.realmId, 'Customer').filter((x) => x.DisplayName === 'Timeout Client').length, 1);
    assert.equal((await link(T, 'clients', 'c-to')).state, 'synced');
  });

  test('a permanent error is poison until the record changes; 5030 turns the feature off', async () => {
    const T = await setupTenant('Poison Electric');
    await create(T, 'vendors', { id: 'v-1', name: 'Westburne' });
    await pass(T);
    fake.disableEntity(T.realmId, 'Bill');
    await create(T, 'bills', { id: 'b-1', kind: 'bill', vendorId: 'v-1', number: 'W-100', date: TODAY, status: 'open', lines: [{ description: 'Wire', qty: 1, unitCents: 10000, amountCents: 10000 }], taxes: [{ id: 'GST', label: 'GST', cents: 500 }], taxProvince: 'MB', totalCents: 10500 });
    await pass(T);
    const l = await link(T, 'bills', 'b-1');
    assert.equal(l.state, 'blocked');
    assert.equal(l.reason, 'feature_missing');
    assert.equal((await conn(T)).features.bills, false);
  });
});

describe('safety brake, shadow mode, origin', { skip }, () => {
  test('the brake pauses before writing past the hourly limit; allow-once lets the pass finish', async () => {
    const T = await setupTenant('Brake Electric');
    for (let i = 0; i < 6; i++) await create(T, 'clients', { id: `c-br-${i}`, name: `Brake Client ${i}` });
    const r = await pass(T, { deps: { brakeLimit: 3 } });
    assert.equal(r.stopped, 'brake');
    const c = await conn(T);
    assert.equal(c.state, 'paused');
    assert.equal(c.pause_reason, 'brake');
    assert.ok(c.brake_allow_count >= 4);
    assert.equal(fake.list(T.realmId, 'Customer').filter((x) => x.DisplayName.startsWith('Brake')).length, 3);
    assert.equal((await logs(T, "action = 'safety_brake'")).length, 1);
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM qbo_platform_events WHERE kind = 'safety_brake' AND tenant_id = $1", [T.tenantId])).rows[0].n, 1);
    await assert.rejects(setPaused(t.db, T.tenantId, false, 'user', { allowCount: 1 }), (e) => e.code === 'qbo_brake_count');
    await setPaused(t.db, T.tenantId, false, 'user', { allowCount: c.brake_allow_count });
    assert.equal((await conn(T)).state, 'active');
    const r2 = await pass(T, { deps: { brakeLimit: 3 } });
    assert.notEqual(r2.stopped, 'brake');
    assert.equal(fake.list(T.realmId, 'Customer').filter((x) => x.DisplayName.startsWith('Brake')).length, 6);
  });

  test('shadow mode logs what would change and writes nothing on either side; going live sends it', async () => {
    const T = await setupTenant('Shadow Electric', { options: { writeMode: 'shadow' } });
    await create(T, 'clients', { id: 'c-sh', name: 'Shadow Client' });
    const before = writes(T.realmId).length;
    const r = await pass(T);
    assert.ok(r.shadow >= 1);
    assert.equal(writes(T.realmId).length, before, 'no QuickBooks write');
    assert.equal(await link(T, 'clients', 'c-sh'), undefined, 'no link');
    assert.equal((await outbox(T)).length, 1, 'the outbox row stays');
    // Paced like a live week: the row looked at waits an hour, the pull is recorded (the cursor stays),
    // so the every-minute dispatcher queues neither a pass nor a CDC for this tenant.
    const cursorBefore = (await conn(T)).cdc_cursor;
    await t.superPool.query("UPDATE qbo_connections SET dirty_at = now() - interval '1 minute', last_pull_at = NULL WHERE tenant_id = $1", [T.tenantId]);
    await pass(T);
    const row = (await outbox(T))[0];
    assert.ok(new Date(row.not_before) > new Date(Date.now() + 50 * 60_000), `not_before ${row.not_before}`);
    const c = await conn(T);
    assert.ok(c.last_pull_at, 'the pull is recorded');
    assert.equal(c.last_push_at, null, 'practice mode wrote nothing');
    assert.equal(c.dirty_at, null, "the webhook's dirty mark is cleared");
    assert.equal(String(c.cdc_cursor), String(cursorBefore), 'the cursor does not move in shadow');
    await t.superPool.query("DELETE FROM jobs_queue WHERE tenant_id = $1 AND kind IN ('qbo_sync', 'qbo_cdc') AND status = 'queued'", [T.tenantId]);
    await t.superPool.query("UPDATE qbo_connections SET last_check_at = now(), ref_refreshed_at = now() WHERE tenant_id = $1", [T.tenantId]);
    await dispatch(t.db);
    const queuedJobs = (await t.superPool.query("SELECT kind FROM jobs_queue WHERE tenant_id = $1 AND kind IN ('qbo_sync', 'qbo_cdc') AND status = 'queued'", [T.tenantId])).rows;
    assert.deepEqual(queuedJobs, [], 'no pass every minute in practice mode');
    const shadow = await logs(T, "outcome = 'shadow'");
    assert.ok(shadow.some((x) => x.action === 'create' && x.collection === 'clients'));
    // A QuickBooks-side customer edit is not pulled in shadow either.
    const cust = fake.create(T.realmId, 'Customer', { DisplayName: 'Shadow QBO Only' });
    await setMappings(T, { option: { importCustomers: 'all' } });
    await pass(T);
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1 AND data->>'name' = 'Shadow QBO Only'", [T.tenantId])).rows[0].n, 0);
    // Live: the waiting row goes.
    await setMappings(T, { option: { writeMode: 'live' } });
    await pass(T);
    assert.equal((await link(T, 'clients', 'c-sh')).state, 'synced');
    assert.ok(cust.Id);
  });

  test('origin: an API-key invoice and an assistant payment wait for approval; an office user goes straight out', async () => {
    const T = await setupTenant('Origin Electric');
    await create(T, 'clients', { id: 'c-or', name: 'Origin Client' });
    const key = { kind: 'api_key', tenantId: T.tenantId, userId: null, role: null, perms: new Set(), isManager: false, scopes: ['*:write'], crew: false, actor: { type: 'api_key', id: 'key-1', label: 'Zapier' } };
    await create(T, 'invoices', invoice({ id: 'inv-api', number: 'INV-3040', clientId: 'c-or' }), key);
    await create(T, 'invoices', invoice({ id: 'inv-office', number: 'INV-3041', clientId: 'c-or' }));
    await pass(T);
    const la = await link(T, 'invoices', 'inv-api');
    assert.equal(la.state, 'needs_review');
    assert.equal(la.reason, 'origin');
    assert.equal(la.qbo_id, null);
    assert.equal((await link(T, 'invoices', 'inv-office')).state, 'synced');
    const agent = { ...T.p, kind: 'session', actor: { type: 'agent', id: 'assistant:x', label: 'via assistant' } };
    await create(T, 'payments', { id: 'pay-agent', invoiceId: 'inv-office', amountCents: 10000, date: TODAY, method: 'cheque' }, agent);
    await pass(T);
    assert.equal((await link(T, 'payments', 'pay-agent')).reason, 'origin');
    // Approving sends it.
    const review = (await conflicts(T)).find((c) => c.record_id === 'inv-api');
    assert.equal(review.kind, 'review');
    await withLeaseDo(T, (epoch) => resolveConflict(deps, T.tenantId, review.id, { choice: 'fishtape' }, whoOf(T.p), { epoch }));
    const after = await link(T, 'invoices', 'inv-api');
    assert.equal(after.state, 'synced', after.last_error);
    assert.ok(fake.list(T.realmId, 'Invoice').some((x) => x.DocNumber === 'INV-3040'));
    const logRow = (await logs(T, "collection = 'invoices' AND record_id = 'inv-office' AND action = 'create'"))[0];
    assert.equal(logRow.actor_type, 'user');
  });
});

describe('sweep, pause and lifecycle', { skip }, () => {
  test('edits made while paused, during reconnect_needed, and by direct SQL are all pushed after resume', async () => {
    const T = await setupTenant('Sweep Electric');
    await create(T, 'clients', { id: 'c-sw', name: 'Sweep Client' });
    await pass(T);
    await setPaused(t.db, T.tenantId, true, 'user');
    await patch(T, 'clients', 'c-sw', { phone: '204-555-0144' });
    const r = await pass(T);
    assert.equal(r.skipped, 'paused');
    // A write that bypassed records.js: picked up by the sweep.
    await t.superPool.query(`INSERT INTO clients (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'c-sql', '{"name":"SQL Client"}', 'user:x', 'user:x')`, [T.tenantId]);
    await setPaused(t.db, T.tenantId, false, 'user');
    const job = (await t.superPool.query("SELECT payload FROM jobs_queue WHERE tenant_id = $1 AND kind = 'qbo_sync' AND dedupe_key LIKE '%:sweep'", [T.tenantId])).rows[0];
    assert.deepEqual(job.payload, { sweep: true });
    await pass(T, { sweep: true });
    assert.equal(fake.get(T.realmId, 'Customer', (await link(T, 'clients', 'c-sw')).qbo_id).PrimaryPhone.FreeFormNumber, '204-555-0144');
    assert.equal((await link(T, 'clients', 'c-sql')).state, 'synced');
  });

  test('a plan drop pauses with reason plan; an upgrade resumes; suspended tenants are never synced', async () => {
    const T = await setupTenant('Plan Electric');
    const handlers = createQboHandlers({ sealer, config, records });
    await t.superPool.query("UPDATE tenants SET plan = 'starter', trial_ends_at = now() - interval '1 day' WHERE id = $1", [T.tenantId]);
    const job = { id: 0, kind: 'qbo_sync', tenant_id: T.tenantId, payload: {} };
    await handlers.qbo_sync({ db: t.db, job });
    let c = await conn(T);
    assert.equal(c.state, 'paused');
    assert.equal(c.pause_reason, 'plan');
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [T.tenantId]);
    await handlers.qbo_sync({ db: t.db, job: { ...job, id: job.id } });
    c = await conn(T);
    assert.equal(c.state, 'active');
    await t.superPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [T.tenantId]);
    const out = await handlers.qbo_sync({ db: t.db, job });
    assert.equal(out.skipped, 'tenant not active');
    const d = await dispatch(t.db);
    assert.ok(d.tenants >= 0);
    const queued = (await t.superPool.query("SELECT count(*)::int AS n FROM jobs_queue WHERE tenant_id = $1 AND kind IN ('qbo_cdc', 'qbo_check') AND status = 'queued'", [T.tenantId])).rows[0].n;
    assert.equal(queued, 0, 'the dispatcher skips suspended tenants');
    await t.superPool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [T.tenantId]);
  });

  test('the worker pools: the general loop never claims qbo_* jobs, the QuickBooks loop takes only them', async () => {
    await enqueue(t.db, { kind: 'qbo_dispatch', payload: { once: true }, dedupeKey: `pool-test-${Date.now()}` });
    await enqueue(t.db, { kind: 'purge_expired', dedupeKey: `pool-test-general-${Date.now()}` });
    const general = await claim(t.db, 'g', { excludeKinds: ['qbo\\_%'] });
    assert.ok(general && !general.kind.startsWith('qbo_'));
    const q = await claim(t.db, 'q', { kinds: ['qbo\\_%'] });
    assert.ok(q && q.kind.startsWith('qbo_'));
    await t.superPool.query("UPDATE jobs_queue SET status = 'done' WHERE id = ANY($1)", [[general.id, q.id]]);
    // A long job heartbeats, so reclaimStuck leaves it running.
    const { heartbeat, reclaimStuck } = await import('../src/services/queue.js');
    await enqueue(t.db, { kind: 'qbo_setup_apply', dedupeKey: `hb-${Date.now()}` });
    const j = await claim(t.db, 'q', { kinds: ['qbo\\_%'] });
    await t.superPool.query("UPDATE jobs_queue SET locked_at = now() - interval '20 minutes' WHERE id = $1", [j.id]);
    await heartbeat(t.db, j.id);
    await reclaimStuck(t.db);
    assert.equal((await t.superPool.query('SELECT status FROM jobs_queue WHERE id = $1', [j.id])).rows[0].status, 'running');
    await t.superPool.query("UPDATE jobs_queue SET status = 'done' WHERE id = $1", [j.id]);
    void runOnce;
  });
});

describe('deletes, unlink and relink', { skip }, () => {
  test('a Fishtape invoice delete voids it in QuickBooks; with a QuickBooks payment the record comes back with a conflict', async () => {
    const T = await setupTenant('Delete Electric');
    await create(T, 'clients', { id: 'c-del', name: 'Delete Client' });
    await create(T, 'invoices', invoice({ id: 'inv-del', number: 'INV-3050', clientId: 'c-del' }));
    await create(T, 'invoices', invoice({ id: 'inv-paid', number: 'INV-3051', clientId: 'c-del' }));
    await pass(T);
    const l = await link(T, 'invoices', 'inv-del');
    await remove(T, 'invoices', 'inv-del');
    await pass(T);
    assert.equal((await link(T, 'invoices', 'inv-del')).state, 'deleted_local');
    const voided = fake.get(T.realmId, 'Invoice', l.qbo_id);
    assert.match(voided.PrivateNote, /^Voided/);
    // A QuickBooks payment on the other: refused, restored, conflict.
    const lp = await link(T, 'invoices', 'inv-paid');
    const custId = (await link(T, 'clients', 'c-del')).qbo_id;
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: custId }, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: lp.qbo_id, TxnType: 'Invoice' }] }] });
    await pass(T);
    await remove(T, 'invoices', 'inv-paid');
    await pass(T);
    const back = await rec(T, 'invoices', 'inv-paid');
    assert.equal(back.deleted, false, 'restored in Fishtape');
    assert.equal((await conflicts(T)).find((c) => c.record_id === 'inv-paid')?.kind, 'deleted');
  });

  test('unlink leaves a tombstone: later edits create nothing; send as new creates; relink starts with no base', async () => {
    const T = await setupTenant('Unlink Electric');
    await create(T, 'clients', { id: 'c-un', name: 'Unlink Client', email: 'un@example.ca' });
    await pass(T);
    const first = await link(T, 'clients', 'c-un');
    const run = await withLeaseDo(T, (epoch) => makeRun(deps, T.tenantId, { epoch }));
    await withLeaseDo(T, async (epoch) => unlinkRecord({ ...run, epoch }, 'clients', 'c-un', whoOf(T.p)));
    assert.equal((await link(T, 'clients', 'c-un')).state, 'unlinked');
    const count = fake.list(T.realmId, 'Customer').length;
    await patch(T, 'clients', 'c-un', { phone: '204-555-0177' });
    await pass(T);
    assert.equal(fake.list(T.realmId, 'Customer').length, count, 'nothing created');
    // Relink to the same QuickBooks customer: B = null, every difference is a conflict.
    fake.edit(T.realmId, 'Customer', first.qbo_id, { PrimaryEmailAddr: { Address: 'other@example.ca' } });
    await withLeaseDo(T, async (epoch) => relinkRecord(await makeRun(deps, T.tenantId, { epoch }), 'clients', 'c-un', first.qbo_id, whoOf(T.p)));
    const open = await conflicts(T);
    assert.ok(open.some((c) => c.record_id === 'c-un' && c.fields.some((f) => f.field === 'email')));
    assert.equal(fake.get(T.realmId, 'Customer', first.qbo_id).PrimaryEmailAddr.Address, 'other@example.ca', 'nothing overwritten');
    // Send as new from a tombstone.
    await withLeaseDo(T, async (epoch) => unlinkRecord(await makeRun(deps, T.tenantId, { epoch }), 'clients', 'c-un', whoOf(T.p)));
    fake.edit(T.realmId, 'Customer', first.qbo_id, { DisplayName: 'Unlink Client (old)' });
    await withLeaseDo(T, (epoch) => pushRecord(deps, T.tenantId, 'clients', 'c-un', { asNew: true, epoch }));
    const l = await link(T, 'clients', 'c-un');
    assert.equal(l.state, 'synced');
    assert.notEqual(l.qbo_id, first.qbo_id);
  });
});

describe('sweep only', { skip }, () => {
  test('the sweep queues changed linked records, new records and deletes, and moves its cursor', async () => {
    const T = await setupTenant('Sweeponly Electric');
    await create(T, 'clients', { id: 'c-s1', name: 'S1' });
    await pass(T);
    await t.superPool.query("UPDATE clients SET data = data || '{\"phone\":\"1\"}' WHERE tenant_id = $1 AND id = 'c-s1'", [T.tenantId]);
    await t.superPool.query(`INSERT INTO clients (tenant_id, id, data, updated_by) VALUES ($1, 'c-s2', '{"name":"S2"}', 'api_key:k')`, [T.tenantId]);
    await t.superPool.query('DELETE FROM qbo_outbox WHERE tenant_id = $1', [T.tenantId]);
    const r = await sweep(deps, T.tenantId);
    assert.equal(r.queued, 2);
    const rows = await outbox(T);
    assert.deepEqual(rows.map((x) => [x.record_id, x.actor_type]), [['c-s1', 'sweep'], ['c-s2', 'api_key']]);
    const again = await sweep(deps, T.tenantId);
    assert.equal(again.queued, 0, 'the cursor moved; rows already queued are not doubled');
    resetUsageCache();
  });
});
