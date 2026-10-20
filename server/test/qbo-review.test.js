// Findings of the QuickBooks release review (docs/integrations/quickbooks.md 4.7 to 4.11, 5.4, 5.8):
// each test here fails without its fix. Payments Fishtape pushed are counted once and never zeroed
// by a pull; a QuickBooks Deposit stays in step; a void or delete in a filed GST period waits for a
// person; Stripe fees and payouts are booked only for payments Fishtape put into the clearing account;
// a payment's own excess is part of its amount; dates are local days; and more.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { skip, createTestDatabase } from './support/db.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { readConfig } from '../src/config.js';
import { createSealer } from '../src/lib/crypto.js';
import { setFetch } from '../src/integrations/http.js';
import { createTenantWithOwner } from '../src/services/tenants.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { permsForRole } from '../src/auth/permissions.js';
import { systemPrincipal } from '../src/integrations/state.js';
import { amountDueCents, registerAmountDueAdjuster } from '../src/integrations/payments.js';
import { taxComponents } from '../../electrical-app/js/lib/tax.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { syncTenant, makeRun, amountDueAdjustment, pushRecord, requeueStuck, markShutdown, timeUp } from '../src/qbo/engine.js';
import { createQboHandlers, dispatch } from '../src/qbo/jobs.js';
import { sweep } from '../src/qbo/sweep.js';
import { runCheck } from '../src/qbo/check.js';
import { buildStatus } from '../src/routes/v1/qbo-connect.js';
import { scan, apply } from '../src/qbo/wizard.js';
import { renumber } from '../src/qbo/lookup.js';
import { processRecord } from '../src/qbo/push.js';
import { ingestWebhook, parseWebhook } from '../src/qbo/webhook.js';
import { resolveConflict, conflictView, relinkRecord } from '../src/qbo/conflicts.js';
import { QboError, createQboClient } from '../src/qbo/client.js';

const KEY = randomBytes(32).toString('base64');
const fake = createFakeQbo();
const config = readConfig({
  APP_ENV: 'test', SECRETS_MASTER_KEY: KEY, PUBLIC_ORIGIN: 'https://app.fishtape.test', QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'v1',
});
const sealer = createSealer(KEY);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });
let t, records, deps, unregister;
let realmN = 0;

const principal = (tenantId, userId, role = 'owner') => ({
  kind: 'session', tenantId, userId, sessionId: null, role, perms: permsForRole(role), isManager: true, employeeId: null, scopes: null, crew: false,
  actor: { type: 'user', id: userId, label: `${role} tester` },
});
const whoOf = (p) => ({ actor: p.actor, request: {} });

async function setupTenant(name, options = {}) {
  const realmId = `46201900${String(++realmN).padStart(8, '0')}`;
  fake.addCompany(realmId, { name: `${name} QBO` });
  const r = await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: `${name} Owner` } });
  const T = { tenantId: r.tenant.id, userId: r.userId, realmId };
  T.p = principal(T.tenantId, T.userId);
  assert.equal((await connectViaFake(fake, { db: t.db, sealer, config, tenantId: T.tenantId, userId: T.userId, realmId })).result, 'ok');
  await refreshReference(deps, T.tenantId, { force: true });
  const s = fake.seed(realmId);
  T.seed = s;
  await setMappings(T, {
    item: { material: s.items.materials.Id, labour: s.items.labour.Id, other: s.items.materials.Id },
    taxCode: { 'GST+RST|MB': s.taxCodes.gstPst.Id, GST: s.taxCodes.gst.Id, 'NONE|EXEMPT': s.taxCodes.exempt.Id },
    purchaseTaxCode: { 'GST+RST|MB': s.taxCodes.gst.Id, GST: s.taxCodes.gst.Id, NONE: s.taxCodes.exempt.Id, stripeFee: s.taxCodes.exempt.Id },
    account: {
      'income.default': s.accounts.income.Id, 'expense.default': s.accounts.cogs.Id, 'jobCost.material': s.accounts.materials.Id,
      stripeClearing: s.accounts.stripe.Id, stripeFees: s.accounts.stripeFees.Id, stripePayoutBank: s.accounts.bank.Id,
    },
    paymentMethod: { cash: s.paymentMethods.Cash.Id, check: s.paymentMethods.Cheque.Id, card: s.paymentMethods['Credit Card'].Id },
    depositTo: { cash: s.accounts.undeposited.Id, check: s.accounts.undeposited.Id, card: s.accounts.undeposited.Id },
    paidFrom: { card: s.accounts.bank.Id, cash: s.accounts.bank.Id },
    option: { syncFrom: '2000-01-01', timeOwner: 'fishtape', stripeCutover: '2000-01-01', ...options },
  });
  await t.db.withTenant({ tenantId: T.tenantId }, (tx) => records.createRecord(tx, T.p, 'settings', { id: 'settings', company: { name, province: 'MB' } }, whoOf(T.p)), { write: true });
  await t.superPool.query(`UPDATE qbo_connections SET state = 'active', setup = '{"phase":"done"}'::jsonb, cdc_cursor = now() - interval '1 minute', time_cursor = now() WHERE tenant_id = $1`, [T.tenantId]);
  fake.company(realmId).events.length = 0;
  return T;
}
async function setMappings(T, maps) {
  const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
  for (const [kind, kv] of Object.entries(maps)) {
    for (const [key, value] of Object.entries(kv)) {
      await t.superPool.query(`INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value`, [T.tenantId, rows[0].realm_hash, kind, key, JSON.stringify(value)]);
    }
  }
}
const write = (T, fn) => t.db.withTenant({ tenantId: T.tenantId }, fn, { write: true });
const create = (T, coll, body, p = T.p) => write(T, (tx) => records.createRecord(tx, p, coll, body, whoOf(p)));
const patch = (T, coll, id, body, p = T.p) => write(T, (tx) => records.patchRecord(tx, p, coll, id, body, {}, whoOf(p)));
const remove = (T, coll, id, p = T.p) => write(T, (tx) => records.deleteRecord(tx, p, coll, id, {}, whoOf(p)));
async function pass(T, o = {}) {
  await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second', claimed_until = NULL WHERE tenant_id = $1", [T.tenantId]);
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  assert.ok(lease);
  try { return await syncTenant({ ...deps, ...(o.deps || {}) }, T.tenantId, { epoch: lease.epoch, ...o }); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
}
const link = async (T, coll, id, role = 'main') => (await t.superPool.query('SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = $4', [T.tenantId, coll, id, role])).rows[0];
const rec = async (T, table, id) => { const r = (await t.superPool.query(`SELECT data, version, deleted_at FROM ${table} WHERE tenant_id = $1 AND id = $2`, [T.tenantId, id])).rows[0]; return r ? { ...r.data, version: Number(r.version), deleted: Boolean(r.deleted_at) } : null; };
const openConflicts = async (T) => (await t.superPool.query("SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND status = 'open'", [T.tenantId])).rows;
const invoice = (o = {}) => ({
  number: 'INV-1', issueDate: TODAY, dueDate: TODAY, status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all', taxes: taxComponents({ province: 'MB', treatment: 'pst-all' }), taxPct: 12,
  lines: [{ description: 'Panel upgrade', qty: 1, unitCents: 100000, kind: 'material' }], ...o,
});

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qboreview');
  records = createRecords({ validator: createValidator(), config });
  deps = { db: t.db, sealer, config, records };
  unregister = registerAmountDueAdjuster(amountDueAdjustment);
});
after(async () => { unregister?.(); setFetch(null); await t?.close(); });

const payRows = async (T, invId) => (await t.superPool.query("SELECT id, data FROM payments WHERE tenant_id = $1 AND data->>'invoiceId' = $2 AND deleted_at IS NULL ORDER BY id", [T.tenantId, invId])).rows
  .map((r) => `${r.id}:${r.data.amountCents}`);
const amountDue = async (T, invId) => write(T, async (tx) => amountDueCents(tx, { ...(await rec(T, 'invoices', invId)), id: invId }));
async function leased(T, fn) {
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  assert.ok(lease);
  try { return await fn(lease.epoch); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
}
const resolve = (T, conflictId, body) => leased(T, (epoch) => resolveConflict(deps, T.tenantId, conflictId, body, whoOf(T.p), { epoch }));
const stripeP = (T) => systemPrincipal(T.tenantId, 'stripe', 'Stripe');
async function payout(T, id, o) {
  await t.superPool.query(
    `INSERT INTO stripe_payouts (tenant_id, payout_id, amount_cents, currency, arrival_date, status, paid_seen, automatic, livemode, balance_txns, earliest_charge_at)
     VALUES ($1, $2, $3, 'cad', $4, 'paid', true, true, true, $5, $6)`,
    [T.tenantId, id, o.amount, TODAY, JSON.stringify(o.txns || []), o.earliest || new Date().toISOString()]);
  await t.superPool.query(
    `INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, actor_type, rank) VALUES ($1, 'stripePayouts', $2, 'upsert', 'stripe', 70)
     ON CONFLICT (tenant_id, collection, record_id) DO UPDATE SET not_before = now(), claimed_until = NULL`, [T.tenantId, id]);
}
const qboInvoice = (T, cust, o = {}) => fake.create(T.realmId, 'Invoice', {
  CustomerRef: { value: cust }, TxnDate: TODAY, GlobalTaxCalculation: 'NotApplicable',
  Line: [{ DetailType: 'SalesItemLineDetail', Amount: 1000, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 1000 } }], ...o,
});
const linkedRecord = async (T, coll, entity, qboId) => (await t.superPool.query(
  "SELECT record_id FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND role = 'main' AND qbo_entity = $3 AND qbo_id = $4", [T.tenantId, coll, entity, String(qboId)])).rows[0]?.record_id;

describe('payments Fishtape pushed', { skip }, () => {
  test('a pushed payment owns its invoice line: the invoice pulled next is not settled a second time', async () => {
    const T = await setupTenant('Pushed Pay');
    await create(T, 'clients', { id: 'c-1', name: 'Pushed Pay Client' });
    await create(T, 'invoices', invoice({ id: 'inv-1', number: 'INV-101', clientId: 'c-1' }));
    await pass(T);
    await create(T, 'payments', { id: 'p-1', invoiceId: 'inv-1', amountCents: 50000, date: TODAY, method: 'cash' });
    await pass(T);
    await pass(T);
    const inv = await link(T, 'invoices', 'inv-1');
    const l = await link(T, 'payments', 'p-1');
    assert.equal(l.state, 'synced');
    assert.equal(l.qbo_line, inv.qbo_id, 'the payment link names its invoice line');
    // A QuickBooks-side edit of the invoice: pulled, settled, still one payment.
    fake.edit(T.realmId, 'Invoice', inv.qbo_id, { PrivateNote: 'checked' });
    await pass(T);
    assert.deepEqual(await payRows(T, 'inv-1'), ['p-1:50000'], 'no settlement payment for money Fishtape recorded');
    assert.equal(await amountDue(T, 'inv-1'), Math.round(fake.get(T.realmId, 'Invoice', inv.qbo_id).Balance * 100));
    // A link written before its line was recorded (qbo_line ''): settlement still counts it.
    await t.superPool.query("UPDATE qbo_links SET qbo_line = '' WHERE id = $1", [l.id]);
    fake.edit(T.realmId, 'Invoice', inv.qbo_id, { PrivateNote: 'checked again' });
    await pass(T);
    assert.deepEqual(await payRows(T, 'inv-1'), ['p-1:50000']);
  });

  test('QuickBooks voids the invoice of a pushed payment: the payment opens a conflict and is never zeroed', async () => {
    const T = await setupTenant('Void Pay');
    await create(T, 'clients', { id: 'c-11', name: 'Void Pay Client' });
    await create(T, 'invoices', invoice({ id: 'inv-11', number: 'INV-1101', clientId: 'c-11' }));
    await pass(T);
    await create(T, 'payments', { id: 'p-11', invoiceId: 'inv-11', amountCents: 50000, date: TODAY, method: 'cash' });
    await pass(T);
    fake.void(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-11')).qbo_id);
    await pass(T);
    const r = await rec(T, 'payments', 'p-11');
    assert.equal(r.invoiceId, 'inv-11');
    assert.equal(r.amountCents, 50000);
    assert.equal(r.deleted, false);
    const c = (await openConflicts(T)).find((x) => x.record_id === 'p-11');
    assert.ok(c, 'a person decides (4.9: a payment created in Fishtape is never deleted by a pull)');
    assert.equal(c.kind, 'deleted');
  });

  test('a payment over the QuickBooks balance keeps its full amount through QuickBooks-side edits', async () => {
    const T = await setupTenant('Overpay');
    await create(T, 'clients', { id: 'c-4', name: 'Overpay Client' });
    await create(T, 'invoices', invoice({ id: 'inv-4', number: 'INV-401', clientId: 'c-4' }));
    await pass(T);
    await create(T, 'payments', { id: 'p-4', invoiceId: 'inv-4', amountCents: 120000, date: TODAY, method: 'cash', reference: 'CHQ1' });
    await pass(T);
    let l = await link(T, 'payments', 'p-4');
    assert.equal(l.meta.ownExcessCents, 8000);
    assert.equal(l.snapshot.amountCents, 120000, 'the snapshot holds the whole payment');
    const q = fake.get(T.realmId, 'Payment', l.qbo_id);
    assert.equal(q.TotalAmt, 1200);
    for (const note of ['checked', 'checked twice']) {
      fake.edit(T.realmId, 'Payment', l.qbo_id, { PrivateNote: `${q.PrivateNote} · ${note}` });
      await pass(T);
    }
    l = await link(T, 'payments', 'p-4');
    assert.equal(l.state, 'synced');
    assert.equal((await rec(T, 'payments', 'p-4')).amountCents, 120000);
    assert.equal(fake.get(T.realmId, 'Payment', l.qbo_id).TotalAmt, 1200);
    assert.deepEqual(await openConflicts(T), []);
  });

  test('deleting a payment that left its own excess as credit voids the QuickBooks payment', async () => {
    const T = await setupTenant('Excess Delete');
    await create(T, 'clients', { id: 'c-9', name: 'Excess Client' });
    await create(T, 'invoices', invoice({ id: 'inv-9', number: 'INV-901', clientId: 'c-9' }));
    await pass(T);
    await create(T, 'payments', { id: 'p-9', invoiceId: 'inv-9', amountCents: 112001, date: TODAY, method: 'cash' });
    await pass(T);
    const l = await link(T, 'payments', 'p-9');
    assert.equal(l.meta.ownExcessCents, 1);
    await remove(T, 'payments', 'p-9');
    await pass(T);
    const q = fake.get(T.realmId, 'Payment', l.qbo_id);
    assert.equal(Number(q.TotalAmt), 0, 'voided, not left as a $1,120.01 credit');
    assert.ok((q.Line || []).every((x) => !Number(x.Amount)));
    assert.equal((await link(T, 'payments', 'p-9')).state, 'deleted_local');
  });

  test('one QuickBooks cheque for two invoices, one line removed there: that payment is deleted, not moved', async () => {
    const T = await setupTenant('Two Lines');
    await create(T, 'clients', { id: 'c-10', name: 'Two Lines Client' });
    await create(T, 'invoices', invoice({ id: 'inv-a', number: 'INV-1001', clientId: 'c-10' }));
    await create(T, 'invoices', invoice({ id: 'inv-b', number: 'INV-1002', clientId: 'c-10' }));
    await pass(T);
    const a = (await link(T, 'invoices', 'inv-a')).qbo_id;
    const b = (await link(T, 'invoices', 'inv-b')).qbo_id;
    const p = fake.create(T.realmId, 'Payment', { CustomerRef: { value: (await link(T, 'clients', 'c-10')).qbo_id }, TotalAmt: 700,
      Line: [{ Amount: 300, LinkedTxn: [{ TxnId: a, TxnType: 'Invoice' }] }, { Amount: 400, LinkedTxn: [{ TxnId: b, TxnType: 'Invoice' }] }] });
    await pass(T);
    assert.equal((await payRows(T, 'inv-a')).length, 1);
    assert.equal((await payRows(T, 'inv-b')).length, 1);
    fake.edit(T.realmId, 'Payment', p.Id, { TotalAmt: 400, Line: [{ Amount: 400, LinkedTxn: [{ TxnId: b, TxnType: 'Invoice' }] }] });
    await pass(T);
    assert.deepEqual(await openConflicts(T), [], 'no payment_moved conflict');
    assert.deepEqual(await payRows(T, 'inv-a'), [], 'the pulled payment whose line went is deleted');
    assert.equal((await payRows(T, 'inv-b'))[0].split(':')[1], '40000');
  });
});

describe('deposits and settlements from QuickBooks', { skip }, () => {
  test('a QuickBooks Deposit changed, removed and added again is kept in step', async () => {
    const T = await setupTenant('Deposit Step');
    await create(T, 'clients', { id: 'c-2', name: 'Deposit Client' });
    await pass(T);
    const q = qboInvoice(T, (await link(T, 'clients', 'c-2')).qbo_id, { DocNumber: 'Q-1', Deposit: 100 });
    await pass(T);
    const invId = await linkedRecord(T, 'invoices', 'Invoice', q.Id);
    assert.deepEqual(await payRows(T, invId), [`deposit-${invId}:10000`]);
    fake.edit(T.realmId, 'Invoice', q.Id, { Deposit: 300 });
    await pass(T);
    assert.deepEqual(await payRows(T, invId), [`deposit-${invId}:30000`]);
    assert.equal(await amountDue(T, invId), 70000, 'what QuickBooks says is owed');
    fake.edit(T.realmId, 'Invoice', q.Id, { Deposit: 0 });
    await pass(T);
    assert.deepEqual(await payRows(T, invId), []);
    assert.equal(await amountDue(T, invId), 100000);
    fake.edit(T.realmId, 'Invoice', q.Id, { Deposit: 50 });
    await pass(T);
    assert.deepEqual(await payRows(T, invId), [`deposit-${invId}:5000`]);
  });

  test('an office edit of a deposit payment pulled from QuickBooks is never sent as a new QuickBooks payment', async () => {
    const T = await setupTenant('Deposit Edit');
    await create(T, 'clients', { id: 'c-6', name: 'Deposit Edit Client' });
    await pass(T);
    const q = qboInvoice(T, (await link(T, 'clients', 'c-6')).qbo_id, { DocNumber: 'Q-6', Deposit: 100 });
    await pass(T);
    const invId = await linkedRecord(T, 'invoices', 'Invoice', q.Id);
    await patch(T, 'payments', `deposit-${invId}`, { reference: 'Deposit cheque 1044' });
    await pass(T);
    assert.equal(fake.list(T.realmId, 'Payment').length, 0);
    assert.equal(fake.get(T.realmId, 'Invoice', q.Id).Balance, 900);
  });
});

describe('filed GST periods', { skip }, () => {
  test('a void, an invoice delete and a bill delete in a filed period wait for a person; approve sends, keep QuickBooks restores', async () => {
    const T = await setupTenant('Filed Void');
    await create(T, 'clients', { id: 'c-3', name: 'Filed Client' });
    await create(T, 'vendors', { id: 'v-3', name: 'Filed Supply' });
    await create(T, 'invoices', invoice({ id: 'inv-3', number: 'INV-301', clientId: 'c-3' }));
    await create(T, 'invoices', invoice({ id: 'inv-3b', number: 'INV-302', clientId: 'c-3' }));
    await create(T, 'bills', { id: 'b-3', kind: 'bill', vendorId: 'v-3', date: TODAY, status: 'open', taxProvince: 'MB', number: 'S-1',
      lines: [{ description: 'Wire', qty: 1, unitCents: 10000, amountCents: 10000, costType: 'material' }], taxes: [{ id: 'GST', label: 'GST', cents: 500 }], totalCents: 10500 });
    await pass(T);
    const li = await link(T, 'invoices', 'inv-3');
    const li2 = await link(T, 'invoices', 'inv-3b');
    const lb = await link(T, 'bills', 'b-3');
    assert.equal(lb.state, 'synced', lb.last_error);
    await setMappings(T, { option: { taxFiledThrough: TODAY } });
    await patch(T, 'invoices', 'inv-3', { status: 'void' });
    await remove(T, 'invoices', 'inv-3b');
    await remove(T, 'bills', 'b-3');
    await pass(T);
    for (const [coll, id] of [['invoices', 'inv-3'], ['invoices', 'inv-3b'], ['bills', 'b-3']]) {
      const l = await link(T, coll, id);
      assert.equal(`${l.state}/${l.reason}`, 'needs_review/filed_period', `${id} waits`);
    }
    assert.equal(fake.get(T.realmId, 'Invoice', li.qbo_id).TotalAmt, 1120, 'not voided in QuickBooks');
    assert.equal(fake.get(T.realmId, 'Invoice', li2.qbo_id).TotalAmt, 1120);
    assert.ok(fake.get(T.realmId, 'Bill', lb.qbo_id), 'the bill is still in QuickBooks');
    const byRecord = async (id) => (await openConflicts(T)).find((c) => c.record_id === id);
    await resolve(T, (await byRecord('inv-3')).id, { choice: 'fishtape' });
    assert.equal(fake.get(T.realmId, 'Invoice', li.qbo_id).TotalAmt, 0, 'approved: voided');
    await resolve(T, (await byRecord('b-3')).id, { choice: 'fishtape' });
    assert.equal(fake.list(T.realmId, 'Bill').filter((x) => x.Id === lb.qbo_id).length, 0, 'approved: deleted');
    assert.equal((await link(T, 'bills', 'b-3')).state, 'deleted_local');
    await resolve(T, (await byRecord('inv-3b')).id, { choice: 'quickbooks' });
    assert.equal((await rec(T, 'invoices', 'inv-3b')).deleted, false, 'kept: the invoice is back in Fishtape');
    assert.equal(fake.get(T.realmId, 'Invoice', li2.qbo_id).TotalAmt, 1120);
    assert.equal((await link(T, 'invoices', 'inv-3b')).state, 'synced');
  });
});

describe('Stripe fees and payouts', { skip }, () => {
  test('a card payment the bookkeeper entered herself gets no fee Purchase, and its payout goes to review', async () => {
    const T = await setupTenant('Own Stripe');
    await create(T, 'clients', { id: 'c-12', name: 'Own Stripe Client' });
    await create(T, 'invoices', invoice({ id: 'inv-12', number: 'INV-1201', clientId: 'c-12' }));
    await pass(T);
    const inv = (await link(T, 'invoices', 'inv-12')).qbo_id;
    const qp = fake.create(T.realmId, 'Payment', { CustomerRef: { value: (await link(T, 'clients', 'c-12')).qbo_id }, TxnDate: TODAY, TotalAmt: 1087.22,
      DepositToAccountRef: { value: String(T.seed.accounts.undeposited.Id) }, Line: [{ Amount: 1087.22, LinkedTxn: [{ TxnId: inv, TxnType: 'Invoice' }] }] });
    await pass(T);
    const pid = await linkedRecord(T, 'payments', 'Payment', qp.Id);
    assert.ok(pid);
    await patch(T, 'payments', pid, { source: 'stripe', stripe: { paymentIntentId: 'pi_OWN12', chargeId: 'ch_OWN12', feeCents: 3278 } }, stripeP(T));
    await pass(T);
    assert.equal(await link(T, 'payments', pid, 'fee'), undefined, 'no fee Purchase');
    assert.equal(fake.list(T.realmId, 'Purchase').length, 0);
    await payout(T, 'po_OWN000001', { amount: 108722, txns: [{ id: 'txn_o1', type: 'charge', amountCents: 112000, feeCents: 3278, paymentIntentId: 'pi_OWN12', created: new Date().toISOString() }] });
    await pass(T);
    const po = await link(T, 'stripePayouts', 'po_OWN000001');
    assert.equal(`${po?.state}/${po?.reason}`, 'needs_review/payout_items');
    assert.equal(fake.list(T.realmId, 'Transfer').length, 0, 'no Transfer out of clearing');
  });

  test('a payout whose charge was skipped as before the cutover (in local time) is skipped too', async () => {
    const T = await setupTenant('Cutover Day', { stripeCutover: TODAY });
    await create(T, 'clients', { id: 'c-13', name: 'Cutover Client' });
    await create(T, 'invoices', invoice({ id: 'inv-13', number: 'INV-1301', clientId: 'c-13' }));
    await pass(T);
    const yesterday = new Date(Date.parse(`${TODAY}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    // 22:00 in Winnipeg on the day before the cutover is already the cutover day in UTC.
    const charged = `${TODAY}T03:00:00.000Z`;
    await create(T, 'payments', { id: 'stripe-pi_CUT13', invoiceId: 'inv-13', amountCents: 112000, date: yesterday, method: 'card', source: 'stripe', stripe: { paymentIntentId: 'pi_CUT13', chargeId: 'ch_CUT13', feeCents: 3278 } }, stripeP(T));
    await pass(T);
    assert.equal(await link(T, 'payments', 'stripe-pi_CUT13'), undefined, 'the payment is already in the books');
    await payout(T, 'po_CUT000013', { amount: 108722, earliest: charged, txns: [{ id: 'txn_c1', type: 'charge', amountCents: 112000, feeCents: 3278, paymentIntentId: 'pi_CUT13', created: charged }] });
    await pass(T);
    assert.equal(await link(T, 'stripePayouts', 'po_CUT000013'), undefined, 'skipped, never blocked waiting for a payment that is never sent');
  });

  test('a Stripe payment deleted in QuickBooks and deleted here takes its fee Purchase with it', async () => {
    const T = await setupTenant('Fee Orphan');
    await create(T, 'clients', { id: 'c-8', name: 'Fee Client' });
    await create(T, 'invoices', invoice({ id: 'inv-8', number: 'INV-801', clientId: 'c-8' }));
    await pass(T);
    await create(T, 'payments', { id: 'stripe-pi_8', invoiceId: 'inv-8', amountCents: 112000, date: TODAY, method: 'card', source: 'stripe', stripe: { paymentIntentId: 'pi_8', chargeId: 'ch_8', feeCents: 3278 } }, stripeP(T));
    await pass(T);
    const pl = await link(T, 'payments', 'stripe-pi_8');
    const fl = await link(T, 'payments', 'stripe-pi_8', 'fee');
    assert.equal(fl?.state, 'synced');
    fake.destroy(T.realmId, 'Payment', pl.qbo_id);
    await pass(T);
    const c = (await openConflicts(T)).find((x) => x.record_id === 'stripe-pi_8');
    await resolve(T, c.id, { choice: 'delete' });
    assert.equal((await rec(T, 'payments', 'stripe-pi_8')).deleted, true);
    assert.equal(fake.list(T.realmId, 'Purchase').filter((x) => x.Id === fl.qbo_id).length, 0, 'the fee Purchase is gone');
    assert.equal((await link(T, 'payments', 'stripe-pi_8', 'fee')).state, 'deleted_local');
  });
});

describe('purchases and time', { skip }, () => {
  test('a supplier refund (negative receipt) gets a positive tax override on its Credit purchase', async () => {
    const T = await setupTenant('Refund');
    await create(T, 'vendors', { id: 'v-7', name: 'Refund Supply' });
    await create(T, 'bills', { id: 'b-7', kind: 'receipt', vendorId: 'v-7', date: TODAY, status: 'paid', paidWith: 'card', taxProvince: 'MB', number: 'RF-1',
      lines: [{ description: 'Returned breakers', qty: 1, unitCents: -10000, amountCents: -10000, costType: 'material' }],
      taxes: [{ id: 'GST', label: 'GST', cents: -500 }, { id: 'RST', label: 'RST', cents: -700 }], totalCents: -11200 });
    await pass(T);
    const l = await link(T, 'bills', 'b-7');
    assert.equal(l.state, 'synced', l.last_error);
    const p = fake.get(T.realmId, 'Purchase', l.qbo_id);
    assert.equal(p.Credit, true);
    assert.equal(p.TxnTaxDetail.TotalTax, 5);
    assert.ok(p.TxnTaxDetail.TaxLine.every((x) => x.Amount > 0));
    assert.equal(p.TotalAmt, 112);
    fake.resetCalls();
    await pass(T);
    assert.equal(fake.calls.filter((c) => c.method === 'POST' && /purchase/i.test(c.path || '')).length, 0, 'no further override');
  });

  test('a time entry clocked in on the evening of the last paid day is held (its local date is in the paid period)', async () => {
    const T = await setupTenant('Evening', { timeLockedThrough: TODAY });
    await create(T, 'clients', { id: 'c-5', name: 'Evening Client' });
    await create(T, 'jobs', { id: 'j-5', number: 'J-5', title: 'Panel', clientId: 'c-5' });
    const emp = fake.create(T.realmId, 'Employee', { GivenName: 'Lou', FamilyName: 'Amp', DisplayName: 'Lou Amp' });
    await create(T, 'employees', { id: 'e-5', name: 'Lou Amp' });
    const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
    await t.superPool.query("INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state, owner) VALUES ($1, $2, 'employees', 'e-5', 'Employee', $3, 'synced', 'quickbooks')", [T.tenantId, rows[0].realm_hash, emp.Id]);
    const next = new Date(Date.parse(`${TODAY}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await create(T, 'timeEntries', { id: 'te-5', employeeId: 'e-5', jobId: 'j-5', clockIn: `${next}T00:30:00.000Z`, clockOut: `${next}T03:30:00.000Z`, approved: true, note: 'Evening call-out' });
    await pass(T);
    const l = await link(T, 'timeEntries', 'te-5');
    assert.equal(`${l?.state}/${l?.reason}`, 'needs_review/payroll_locked');
    assert.equal(fake.list(T.realmId, 'TimeActivity').length, 0);
  });
});

// ---- operations: cursors, chains, back-off, the worker ------------------------------------------

const connRow = async (T) => (await t.superPool.query('SELECT * FROM qbo_connections WHERE tenant_id = $1', [T.tenantId])).rows[0];
const handlersFor = (o = {}) => createQboHandlers({ sealer, config, records, workerId: 'test-worker', ...o });
const jobsOf = async (T, kind) => (await t.superPool.query("SELECT kind, dedupe_key, status, payload FROM jobs_queue WHERE tenant_id = $1 AND kind = $2 ORDER BY id", [T.tenantId, kind])).rows;

describe('pulls that stop part way', { skip }, () => {
  test('a pass out of time part way through a CDC page keeps the cursor, so the next pass applies the change', async () => {
    const T = await setupTenant('Cursor Stay');
    await create(T, 'clients', { id: 'c-cur', name: 'Cursor Client', email: 'dana@example.ca' });
    await pass(T);
    const l = await link(T, 'clients', 'c-cur');
    fake.advance(-10 * 60_000);
    fake.edit(T.realmId, 'Customer', l.qbo_id, { PrimaryEmailAddr: { Address: 'changed@example.ca' } });
    fake.advance(10 * 60_000);
    await t.superPool.query("UPDATE qbo_connections SET cdc_cursor = now() - interval '20 minutes' WHERE tenant_id = $1", [T.tenantId]);
    const before = (await connRow(T)).cdc_cursor;
    await pass(T, { budgetMs: 1, direction: 'pull' });
    assert.equal(new Date((await connRow(T)).cdc_cursor).getTime(), new Date(before).getTime(), 'the cursor stays');
    await pass(T, { direction: 'pull' });
    assert.equal((await rec(T, 'clients', 'c-cur')).email, 'changed@example.ca');
  });

  test('a TimeActivity read QuickBooks refuses never stops the pass: the push still goes and the edition is noted', async () => {
    const T = await setupTenant('No Time');
    await t.superPool.query("UPDATE qbo_connections SET time_cursor = now() - interval '7 hours' WHERE tenant_id = $1", [T.tenantId]);
    fake.disableEntity(T.realmId, 'TimeActivity');
    await create(T, 'clients', { id: 'c-nt', name: 'No Time Client' });
    const r = await pass(T);
    assert.equal(r.stopped, undefined);
    assert.equal((await link(T, 'clients', 'c-nt')).state, 'synced', 'the push ran');
    const c = await connRow(T);
    assert.equal(c.features.timeTracking, false);
    assert.ok(c.last_pull_at, 'the pull finished');
  });

  test('a full reconcile too big for one pass carries on from where it stopped, and the status says it is catching up', async () => {
    const T = await setupTenant('Big Reconcile');
    for (let i = 0; i < 55; i++) await create(T, 'clients', { id: `c-big-${i}`, name: `Big Client ${i}` });
    await pass(T);
    assert.equal((await link(T, 'clients', 'c-big-54')).state, 'synced');
    await t.superPool.query("UPDATE qbo_connections SET cdc_cursor = now() - interval '35 days', last_pull_at = '2020-01-01T00:00:00Z' WHERE tenant_id = $1", [T.tenantId]);
    // The pass "runs out of time" after its tenth query: phase 1 (9 entities) and the first 50 ids of phase 2.
    const queries = [];
    const client = createQboClient({ db: t.db, sealer, config, tenantId: T.tenantId, purpose: 'sync' });
    const query = client.query.bind(client);
    let stopAfter = 10;
    client.query = async (text, o) => { const r = await query(text, o); queries.push(String(text)); if (queries.length === stopAfter) markShutdown(true); return r; };
    try { await pass(T, { deps: { client } }); } finally { markShutdown(false); }
    let c = await connRow(T);
    assert.equal(c.reconcile?.phase, 'byId', JSON.stringify(c.reconcile));
    assert.equal(c.reconcile?.entity, 'Customer');
    assert.equal(new Date(c.last_pull_at).toISOString(), '2020-01-01T00:00:00.000Z', 'not marked as pulled while catching up');
    const st = await buildStatus(t.db, config, T.p);
    assert.equal(st.catchingUp, true);
    queries.length = 0;
    stopAfter = Infinity;
    await pass(T, { deps: { client } });
    assert.ok(queries.length > 0);
    assert.ok(!/LastUpdatedTime/.test(queries[0]), `carried on by id, not from the start: ${queries[0]}`);
    c = await connRow(T);
    assert.equal(c.reconcile, null, 'finished');
    assert.ok(Date.now() - new Date(c.cdc_cursor).getTime() < 86_400_000, 'the cursor moved');
    assert.notEqual(new Date(c.last_pull_at).toISOString(), '2020-01-01T00:00:00.000Z');
  });
});

describe('the sweep and the outbox', { skip }, () => {
  test('a sweep that reaches its limit stops the cursor at the last record it read; the next sweep queues the rest', async () => {
    const T = await setupTenant('Sweep Limit');
    for (let i = 0; i < 5; i++) await create(T, 'clients', { id: `c-sw-${i}`, name: `Sweep Client ${i}` });
    // The hooks' rows were lost (QuickBooks off on the server, a failed hook): only the sweep finds them.
    await t.superPool.query('DELETE FROM qbo_outbox WHERE tenant_id = $1', [T.tenantId]);
    await t.superPool.query('UPDATE qbo_connections SET fishtape_cursor = 0 WHERE tenant_id = $1', [T.tenantId]);
    const top = Number((await t.superPool.query('SELECT max(change_seq) AS m FROM clients WHERE tenant_id = $1', [T.tenantId])).rows[0].m);
    const first = await sweep({ db: t.db }, T.tenantId, { limit: 3 });
    assert.deepEqual([first.queued, first.more], [3, true]);
    assert.ok(Number((await connRow(T)).fishtape_cursor) < top, 'the cursor stops before the records not read');
    const second = await sweep({ db: t.db }, T.tenantId, { limit: 3 });
    assert.equal(second.queued, 2);
    const queued = (await t.superPool.query("SELECT count(*)::int AS n FROM qbo_outbox WHERE tenant_id = $1 AND collection = 'clients'", [T.tenantId])).rows[0].n;
    assert.equal(queued, 5, 'every lost record is queued');
  });

  test('a record failing before its link exists still stops after the last backoff step, with an error the office sees', async () => {
    const T = await setupTenant('No Link Yet');
    await create(T, 'clients', { id: 'c-nl', name: 'No Link Client' });
    await create(T, 'invoices', invoice({ id: 'inv-nl', number: 'INV-NL1', clientId: 'c-nl' }));
    let failing = true;
    fake.failNext({ status: 503, count: 10_000, match: (c) => failing && c.realmId === T.realmId && ((c.method === 'POST' && c.path === 'customer') || c.path === 'query') });
    try {
      for (let i = 0; i < 9; i++) await pass(T);
      const l = await link(T, 'invoices', 'inv-nl');
      assert.ok(l, 'the invoice got a link');
      assert.equal(l.state, 'error');
      const row = (await t.superPool.query("SELECT 1 FROM qbo_outbox WHERE tenant_id = $1 AND collection = 'invoices' AND record_id = 'inv-nl'", [T.tenantId])).rows;
      assert.equal(row.length, 0, 'no more retries every minute');
    } finally { failing = false; }
  });

  test("an API key's bill held because the plan lacks bills still goes to review when the feature comes back", async () => {
    const T = await setupTenant('Feature Back');
    await create(T, 'vendors', { id: 'v-fb', name: 'Feature Supply' });
    await pass(T);
    await t.superPool.query(`UPDATE qbo_connections SET features = features || '{"bills": false}'::jsonb WHERE tenant_id = $1`, [T.tenantId]);
    const key = { kind: 'api_key', tenantId: T.tenantId, userId: null, role: null, perms: new Set(), isManager: false, scopes: ['*:write'], crew: false, actor: { type: 'api_key', id: 'key-fb', label: 'Zapier' } };
    await create(T, 'bills', { id: 'b-fb', kind: 'bill', vendorId: 'v-fb', date: TODAY, status: 'open', taxProvince: 'MB', number: 'FB-1',
      lines: [{ description: 'Wire', qty: 1, unitCents: 10000, amountCents: 10000, costType: 'material' }], taxes: [{ id: 'GST', label: 'GST', cents: 500 }], totalCents: 10500 }, key);
    await pass(T);
    assert.equal(`${(await link(T, 'bills', 'b-fb')).state}/${(await link(T, 'bills', 'b-fb')).reason}`, 'blocked/feature_missing');
    // The edition changed (the reference refresh): what waited for the feature is queued again, as the system.
    await t.superPool.query(`UPDATE qbo_connections SET features = features || '{"bills": true}'::jsonb WHERE tenant_id = $1`, [T.tenantId]);
    await write(T, (tx) => requeueStuck(tx, { reasons: ['feature_missing'] }));
    await pass(T);
    const l = await link(T, 'bills', 'b-fb');
    assert.equal(`${l.state}/${l.reason}`, 'needs_review/origin', 'an API key\'s money write waits for the office (5.2)');
    assert.equal(fake.list(T.realmId, 'Bill').length, 0);
  });
});

describe('jobs: chains, plans, back-off and the worker', { skip }, () => {
  test('a practice-mode go-live apply carries on when the lease is busy, with its own next key; an active apply is not skipped', async () => {
    const T = await setupTenant('Go Live Chain');
    await t.superPool.query(`UPDATE qbo_connections SET setup = '{"phase":"applying","fromShadow":true,"applyPhase":8}'::jsonb WHERE tenant_id = $1`, [T.tenantId]);
    const h = handlersFor();
    const other = await acquireLease(t.db, T.tenantId, 'someone-else');
    try {
      const r = await h.qbo_setup_apply({ db: t.db, job: { id: -1, tenant_id: T.tenantId, dedupe_key: `qbo_setup_apply:${T.tenantId}:cont`, payload: {} } });
      assert.equal(r.busy, true);
    } finally { await releaseLease(t.db, T.tenantId, other.epoch); }
    assert.deepEqual((await jobsOf(T, 'qbo_setup_apply')).map((j) => j.dedupe_key), [`qbo_setup_apply:${T.tenantId}:cont2`], 'the chain goes on under the other key');
    // The chunk itself runs on an active connection that came from practice mode, and finishes.
    const out = await leased(T, (epoch) => apply(deps, T.tenantId, { epoch }));
    assert.equal(out.phase, 'done', JSON.stringify(out));
    assert.equal((await connRow(T)).setup.phase, 'done');
  });

  test('the dispatcher restarts a lost apply chain, reclaims a killed job, and queues no pass for waiting rows while writes are off', async () => {
    const T = await setupTenant('Dispatch Net');
    await t.superPool.query(`UPDATE qbo_connections SET setup = '{"phase":"applying","fromShadow":true,"applyPhase":8}'::jsonb, last_pull_at = now(), last_check_at = now(), ref_refreshed_at = now() WHERE tenant_id = $1`, [T.tenantId]);
    await t.superPool.query('DELETE FROM jobs_queue WHERE tenant_id = $1', [T.tenantId]);
    await dispatch(t.db, new Date());
    assert.equal((await jobsOf(T, 'qbo_setup_apply')).length, 1, 'a chunk is queued again');
    await t.superPool.query(`UPDATE qbo_connections SET setup = '{"phase":"done"}'::jsonb WHERE tenant_id = $1`, [T.tenantId]);
    await t.superPool.query('DELETE FROM jobs_queue WHERE tenant_id = $1', [T.tenantId]);
    // A pass killed by a deploy: still "running", no heartbeat for 5 minutes.
    await t.superPool.query("INSERT INTO jobs_queue (kind, tenant_id, payload, status, locked_at, locked_by, dedupe_key) VALUES ('qbo_sync', $1, '{}', 'running', now() - interval '5 minutes', 'gone', $2)", [T.tenantId, `qbo_sync:${T.tenantId}`]);
    await dispatch(t.db, new Date());
    assert.equal((await jobsOf(T, 'qbo_sync'))[0].status, 'queued', 'put back');
    await t.superPool.query('DELETE FROM jobs_queue WHERE tenant_id = $1', [T.tenantId]);
    // Writes off on the server: a waiting outbox row queues no pass (it could only pull, every minute).
    await create(T, 'clients', { id: 'c-wo', name: 'Writes Off Client' });
    await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 minute' WHERE tenant_id = $1", [T.tenantId]);
    await t.superPool.query('DELETE FROM jobs_queue WHERE tenant_id = $1', [T.tenantId]);
    await dispatch(t.db, new Date(), { writesEnabled: false });
    assert.equal((await jobsOf(T, 'qbo_sync')).length, 0);
    await dispatch(t.db, new Date(), { writesEnabled: true });
    assert.equal((await jobsOf(T, 'qbo_sync')).length, 1);
  });

  test('a periodic job that keeps failing is backed off; a lapsed plan reads nothing from Intuit', async () => {
    const T = await setupTenant('Back Off');
    await t.superPool.query("UPDATE qbo_connections SET ref_refreshed_at = now() - interval '2 days', last_pull_at = now(), last_check_at = now() WHERE tenant_id = $1", [T.tenantId]);
    const h = handlersFor();
    let failing = true;
    fake.failNext({ status: 500, count: 100, match: (c) => failing && c.realmId === T.realmId && c.path === 'query' });
    try {
      await assert.rejects(h.qbo_reference_refresh({ db: t.db, job: { id: -2, tenant_id: T.tenantId, payload: {} } }));
    } finally { failing = false; }
    const b = (await connRow(T)).backoff.qbo_reference_refresh;
    assert.equal(b?.failures, 1);
    assert.ok(Date.parse(b.until) > Date.now() + 4 * 60_000);
    await t.superPool.query('DELETE FROM jobs_queue WHERE tenant_id = $1', [T.tenantId]);
    await dispatch(t.db, new Date());
    assert.equal((await jobsOf(T, 'qbo_reference_refresh')).length, 0, 'not queued again on the next minute');
    // The plan lost QuickBooks: no Intuit read, the connection pauses (an upgrade resumes it).
    await t.superPool.query("UPDATE tenants SET plan = 'starter', trial_ends_at = now() - interval '1 day' WHERE id = $1", [T.tenantId]);
    fake.resetCalls();
    const r = await h.qbo_reference_refresh({ db: t.db, job: { id: -3, tenant_id: T.tenantId, payload: {} } });
    assert.equal(r.skipped, 'plan');
    assert.equal(fake.calls.filter((c) => c.realmId === T.realmId).length, 0);
    assert.equal((await connRow(T)).pause_reason, 'plan');
    const a = await h.qbo_setup_apply({ db: t.db, job: { id: -4, tenant_id: T.tenantId, payload: {} } });
    assert.equal(a.skipped, 'plan');
  });

  test('a stopping worker ends a pass at its next step; the worker gets time to stop on a deploy', async () => {
    const T = await setupTenant('Shutdown');
    const lease = await acquireLease(t.db, T.tenantId, 'test');
    try {
      const run = await makeRun(deps, T.tenantId, { epoch: lease.epoch });
      assert.equal(timeUp(run), false);
      markShutdown(true);
      assert.equal(timeUp(run), true);
    } finally { markShutdown(false); await releaseLease(t.db, T.tenantId, lease.epoch); }
    for (const env of ['staging', 'production']) {
      const yml = readFileSync(new URL(`../../deploy/${env}/docker-compose.yml`, import.meta.url), 'utf8');
      const worker = yml.slice(yml.indexOf('\n  worker:'), yml.indexOf('\n  migrate:'));
      assert.match(worker, /stop_grace_period: 5m/, `${env}: the worker is not killed after 10 seconds`);
    }
  });
});

describe('employees hired after setup', { skip }, () => {
  test('linking an employee after setup sends the time that waited for it', async () => {
    const T = await setupTenant('New Hire');
    await create(T, 'clients', { id: 'c-nh', name: 'New Hire Client' });
    await create(T, 'jobs', { id: 'j-nh', number: 'J-9', title: 'Panel', clientId: 'c-nh' });
    await create(T, 'employees', { id: 'e-nina', name: 'Nina Newhire', email: 'nina@example.test' });
    await create(T, 'timeEntries', { id: 'te-nh', employeeId: 'e-nina', jobId: 'j-nh', clockIn: `${TODAY}T14:00:00Z`, clockOut: `${TODAY}T18:00:00Z`, approved: true, note: 'Day one' });
    await pass(T);
    assert.equal(`${(await link(T, 'timeEntries', 'te-nh')).state}/${(await link(T, 'timeEntries', 'te-nh')).reason}`, 'blocked/employee_not_linked');
    const emp = fake.create(T.realmId, 'Employee', { GivenName: 'Nina', FamilyName: 'Newhire', DisplayName: 'Nina Newhire', PrimaryEmailAddr: { Address: 'nina@example.test' } });
    const l = await leased(T, async (epoch) => relinkRecord(await makeRun(deps, T.tenantId, { epoch, purpose: 'lookup' }), 'employees', 'e-nina', emp.Id, whoOf(T.p)));
    assert.equal(l.state, 'synced');
    assert.equal(l.qbo_entity, 'Employee');
    await pass(T);
    assert.equal((await link(T, 'timeEntries', 'te-nh')).state, 'synced');
    assert.equal(fake.list(T.realmId, 'TimeActivity').length, 1);
  });
});

describe('passing Intuit faults', { skip }, () => {
  test('a record that ran out of retries during an Intuit outage gets a fresh set from the daily check', async () => {
    const T = await setupTenant('Outage');
    await create(T, 'clients', { id: 'c-out', name: 'Outage Client' });
    await pass(T);
    const l = await link(T, 'clients', 'c-out');
    // Eight 5xx answers in a row: the link is error/unavailable and its outbox row is gone (5.8).
    await t.superPool.query("UPDATE qbo_links SET state = 'error', reason = 'unavailable', attempts = 8, last_error = 'QuickBooks is not answering.' WHERE id = $1", [l.id]);
    await t.superPool.query('DELETE FROM qbo_outbox WHERE tenant_id = $1', [T.tenantId]);
    await leased(T, (epoch) => runCheck(deps, T.tenantId, { epoch }));
    const row = (await t.superPool.query("SELECT 1 FROM qbo_outbox WHERE tenant_id = $1 AND collection = 'clients' AND record_id = 'c-out'", [T.tenantId])).rows;
    assert.equal(row.length, 1, 'queued again');
    assert.equal((await link(T, 'clients', 'c-out')).attempts, 0, 'with all its tries');
    await pass(T);
    assert.equal((await link(T, 'clients', 'c-out')).state, 'synced');
  });
});
