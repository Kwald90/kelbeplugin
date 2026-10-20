// The QuickBooks data-integrity matrix (docs/integrations/quickbooks.md 11.3, W3): timeouts and crashes
// never duplicate, a payment's foreign lines and unapplied amount survive Fishtape edits and deletes,
// tax deltas and settlements show the right amount due, voids and deletes are never silent, Stripe
// payouts follow the cutover and review rules, a lost webhook is caught by the next CDC, filed GST
// periods and paid pay periods go to review, and an overlapping worker is fenced.
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
import { systemPrincipal } from '../src/integrations/state.js';
import { amountDueCents, registerAmountDueAdjuster } from '../src/integrations/payments.js';
import { taxComponents } from '../../electrical-app/js/lib/tax.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { syncTenant, makeRun, amountDueAdjustment } from '../src/qbo/engine.js';
import { processRecord } from '../src/qbo/push.js';
import { ingestWebhook, parseWebhook } from '../src/qbo/webhook.js';
import { resolveConflict } from '../src/qbo/conflicts.js';
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
  t = await createTestDatabase('qbointegrity');
  records = createRecords({ validator: createValidator(), config });
  deps = { db: t.db, sealer, config, records };
  unregister = registerAmountDueAdjuster(amountDueAdjustment);
});
after(async () => { unregister?.(); setFetch(null); await t?.close(); });

describe('retries never duplicate', { skip }, () => {
  test('a time entry whose create timed out, then edited, then retried: one TimeActivity', async () => {
    const T = await setupTenant('Time Retry');
    await create(T, 'clients', { id: 'c-t', name: 'Time Client' });
    await create(T, 'jobs', { id: 'j-t', number: 'J-1', title: 'Panel', clientId: 'c-t' });
    const emp = fake.create(T.realmId, 'Employee', { GivenName: 'Pat', FamilyName: 'Volt', DisplayName: 'Pat Volt' });
    await create(T, 'employees', { id: 'e-1', name: 'Pat Volt' });
    const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
    await t.superPool.query("INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state, owner) VALUES ($1, $2, 'employees', 'e-1', 'Employee', $3, 'synced', 'quickbooks')", [T.tenantId, rows[0].realm_hash, emp.Id]);
    await create(T, 'timeEntries', { id: 'te-1', employeeId: 'e-1', jobId: 'j-t', clockIn: `${TODAY}T14:00:00Z`, clockOut: `${TODAY}T18:00:00Z`, approved: true, note: 'Rough-in' });
    fake.failNext({ drop: true, match: (c) => c.method === 'POST' && c.path === 'timeactivity' && c.realmId === T.realmId });
    await pass(T);
    await patch(T, 'timeEntries', 'te-1', { note: 'Rough-in and boxes' });
    await pass(T);
    await pass(T);
    const acts = fake.list(T.realmId, 'TimeActivity');
    assert.equal(acts.length, 1, 'exactly one TimeActivity');
    assert.equal((await link(T, 'timeEntries', 'te-1')).state, 'synced');
    assert.match(acts[0].Description, /Rough-in and boxes/);
    assert.equal(acts[0].Hours * 60 + acts[0].Minutes, 240);
    assert.equal(acts[0].BillableStatus, 'NotBillable');
  });

  test('two overlapping workers: the one paused past its lease is fenced and writes nothing', async () => {
    const T = await setupTenant('Overlap');
    await create(T, 'clients', { id: 'c-o', name: 'Overlap Client' });
    const a = await acquireLease(t.db, T.tenantId, 'worker-a');
    const runA = await makeRun(deps, T.tenantId, { epoch: a.epoch });
    // Worker A stalls past its lease; worker B takes over.
    await t.superPool.query("UPDATE qbo_connections SET lease_until = now() - interval '1 second' WHERE tenant_id = $1", [T.tenantId]);
    const b = await acquireLease(t.db, T.tenantId, 'worker-b');
    assert.ok(b && b.epoch !== a.epoch);
    await assert.rejects(processRecord(runA, 'clients', 'c-o', { actorType: 'user' }), (e) => e.name === 'FencedError');
    assert.equal(fake.list(T.realmId, 'Customer').filter((c) => c.DisplayName === 'Overlap Client').length, 0, 'A sent nothing');
    await releaseLease(t.db, T.tenantId, b.epoch);
    await pass(T);
    assert.equal(fake.list(T.realmId, 'Customer').filter((c) => c.DisplayName === 'Overlap Client').length, 1);
  });
});

describe('payments', { skip }, () => {
  test('a multi-line QuickBooks payment: Fishtape edits and deletes touch only their own lines', async () => {
    const T = await setupTenant('Multi Pay');
    await create(T, 'clients', { id: 'c-m', name: 'Multi Client' });
    await create(T, 'invoices', invoice({ id: 'inv-a', number: 'INV-10', clientId: 'c-m' }));
    await create(T, 'invoices', invoice({ id: 'inv-b', number: 'INV-11', clientId: 'c-m' }));
    await pass(T);
    const cust = (await link(T, 'clients', 'c-m')).qbo_id;
    const qa = (await link(T, 'invoices', 'inv-a')).qbo_id;
    const qb = (await link(T, 'invoices', 'inv-b')).qbo_id;
    const old = fake.create(T.realmId, 'Invoice', { CustomerRef: { value: cust }, DocNumber: '2025-77', TxnDate: '2025-03-01', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 70, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 70 } }], GlobalTaxCalculation: 'NotApplicable' });
    const memo = fake.create(T.realmId, 'CreditMemo', { CustomerRef: { value: cust }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 50, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 50 } }], GlobalTaxCalculation: 'NotApplicable' });
    const pay = fake.create(T.realmId, 'Payment', {
      CustomerRef: { value: cust }, TotalAmt: 820, TxnDate: TODAY, PaymentRefNum: 'CHQ-1',
      Line: [
        { Amount: 100, LinkedTxn: [{ TxnId: qa, TxnType: 'Invoice' }] },
        { Amount: 200, LinkedTxn: [{ TxnId: qb, TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: memo.Id, TxnType: 'CreditMemo' }] },
        { Amount: 70, LinkedTxn: [{ TxnId: old.Id, TxnType: 'Invoice' }] },
      ],
    });
    assert.equal(fake.get(T.realmId, 'Payment', pay.Id).UnappliedAmt, 500);
    await pass(T);
    const payA = (await t.superPool.query("SELECT record_id FROM qbo_links WHERE tenant_id = $1 AND collection = 'payments' AND qbo_line = $2", [T.tenantId, qa])).rows[0].record_id;
    const payB = (await t.superPool.query("SELECT record_id FROM qbo_links WHERE tenant_id = $1 AND collection = 'payments' AND qbo_line = $2", [T.tenantId, qb])).rows[0].record_id;
    assert.equal((await rec(T, 'payments', payA)).amountCents, 10000);
    assert.equal((await rec(T, 'payments', payB)).amountCents, 20000);
    const foreignBefore = fake.get(T.realmId, 'Payment', pay.Id).Line.filter((l) => !l.LinkedTxn.some((x) => [qa, qb].includes(x.TxnId)));
    // A reference edit: header only.
    await patch(T, 'payments', payA, { reference: 'CHQ-1A' });
    await pass(T);
    let p = fake.get(T.realmId, 'Payment', pay.Id);
    assert.equal(p.PaymentRefNum, 'CHQ-1A');
    assert.equal(p.TotalAmt, 820);
    assert.equal(p.UnappliedAmt, 500);
    assert.equal(p.Line.length, 4);
    // Deleting one part removes only that line; its amount becomes unapplied credit.
    await remove(T, 'payments', payB);
    await pass(T);
    p = fake.get(T.realmId, 'Payment', pay.Id);
    assert.equal(p.TotalAmt, 820, 'TotalAmt unchanged');
    assert.equal(p.Line.length, 3);
    assert.deepEqual(p.Line.filter((l) => !l.LinkedTxn.some((x) => [qa, qb].includes(x.TxnId))).map((l) => [l.Amount, l.LinkedTxn[0].TxnId]), foreignBefore.map((l) => [l.Amount, l.LinkedTxn[0].TxnId]), 'foreign lines exactly as they were');
    assert.equal(p.UnappliedAmt, 700, 'the old $500 plus the removed $200');
    assert.ok(p.Line.some((l) => l.LinkedTxn[0].TxnId === qa && l.Amount === 100));
    assert.equal((await link(T, 'payments', payB)).state, 'deleted_local');
  });

  test('a one-cent tax delta QuickBooks refuses to override: the amount due is the QuickBooks total', async () => {
    const T = await setupTenant('Cent Delta');
    await create(T, 'clients', { id: 'c-c', name: 'Cent Client' });
    // QuickBooks rounds its PST a cent higher than Fishtape, and the rate is read-only, so the
    // override is refused (fault 6000 / -37100).
    const real = createQboClient({ db: t.db, sealer, config, tenantId: T.tenantId });
    const client = {
      ...real,
      async create(entity, body, o) {
        const obj = await real.create(entity, body, o);
        if (entity !== 'Invoice') return obj;
        const pstLine = obj.TxnTaxDetail.TaxLine.find((x) => String(x.TaxLineDetail.TaxRateRef.value) === String(T.seed.taxRates.pst.Id));
        pstLine.Amount = Math.round((pstLine.Amount + 0.01) * 100) / 100;
        obj.TxnTaxDetail.TotalTax = Math.round((obj.TxnTaxDetail.TotalTax + 0.01) * 100) / 100;
        obj.TotalAmt = Math.round((obj.TotalAmt + 0.01) * 100) / 100;
        return obj;
      },
      async update(entity, body, o) {
        if (body.TxnTaxDetail) throw new QboError('validation', { variant: 'tax_override', faultCode: '6000', status: 400 });
        return real.update(entity, body, o);
      },
    };
    await create(T, 'invoices', invoice({ id: 'inv-c', number: 'INV-20', clientId: 'c-c' }));
    await pass(T, { deps: { client } });
    const l = await link(T, 'invoices', 'inv-c');
    assert.equal(l.state, 'synced', l.last_error);
    assert.equal(l.meta.taxDeltaCents, 1);
    const due = await write(T, async (tx) => amountDueCents(tx, { ...(await rec(T, 'invoices', 'inv-c')), id: 'inv-c' }));
    assert.equal(due, 112001, 'the pay link charges the QuickBooks total');
    // A QuickBooks payment of that total marks the Fishtape invoice paid.
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: (await link(T, 'clients', 'c-c')).qbo_id }, TotalAmt: 1120.01, Line: [{ Amount: 1120.01, LinkedTxn: [{ TxnId: l.qbo_id, TxnType: 'Invoice' }] }] });
    await pass(T);
    assert.equal((await rec(T, 'invoices', 'inv-c')).status, 'paid');
  });

  test('more than 2 cents after a create: the QuickBooks copy is deleted again', async () => {
    const T = await setupTenant('Tax Mismatch');
    await create(T, 'clients', { id: 'c-x', name: 'Mismatch Client' });
    fake.company(T.realmId).objects.TaxRate.get(String(T.seed.taxRates.pst.Id)).RateValue = 8;
    await create(T, 'invoices', invoice({ id: 'inv-x', number: 'INV-21', clientId: 'c-x' }));
    await pass(T);
    const l = await link(T, 'invoices', 'inv-x');
    assert.equal(l.state, 'error');
    assert.equal(l.reason, 'tax_mismatch');
    assert.equal(l.qbo_id, null);
    assert.equal(fake.list(T.realmId, 'Invoice').filter((x) => x.DocNumber === 'INV-21').length, 0, 'nothing wrong stays in AR');
    fake.company(T.realmId).objects.TaxRate.get(String(T.seed.taxRates.pst.Id)).RateValue = 7;
  });

  test('an invoice settled in QuickBooks by a credit memo shows paid through the settlement payment', async () => {
    const T = await setupTenant('Settle');
    await create(T, 'clients', { id: 'c-s', name: 'Settle Client' });
    await create(T, 'invoices', invoice({ id: 'inv-s', number: 'INV-30', clientId: 'c-s' }));
    await pass(T);
    const l = await link(T, 'invoices', 'inv-s');
    const cust = (await link(T, 'clients', 'c-s')).qbo_id;
    const memo = fake.create(T.realmId, 'CreditMemo', { CustomerRef: { value: cust }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 1120, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 1120 } }], GlobalTaxCalculation: 'NotApplicable' });
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: cust }, TotalAmt: 0, Line: [{ Amount: 1120, LinkedTxn: [{ TxnId: l.qbo_id, TxnType: 'Invoice' }] }, { Amount: 1120, LinkedTxn: [{ TxnId: memo.Id, TxnType: 'CreditMemo' }] }] });
    await pass(T);
    const s = await rec(T, 'payments', 'qbo-settle-inv-s');
    assert.ok(s && !s.deleted, 'settlement payment');
    assert.equal(s.method, 'credit');
    assert.equal(s.source, 'quickbooks');
    assert.equal(s.amountCents, 112000);
    assert.equal((await rec(T, 'invoices', 'inv-s')).status, 'paid');
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND data->>'invoiceId' = 'inv-s' AND deleted_at IS NULL", [T.tenantId])).rows[0].n, 1, 'no cash payment for the credit application');
  });

  test('a QuickBooks delete of a Stripe payment opens a conflict and never reopens the invoice', async () => {
    const T = await setupTenant('Stripe Delete');
    await create(T, 'clients', { id: 'c-sd', name: 'Stripe Client' });
    await create(T, 'invoices', invoice({ id: 'inv-sd', number: 'INV-40', clientId: 'c-sd' }));
    await pass(T);
    const stripe = systemPrincipal(T.tenantId, 'stripe', 'Stripe');
    await create(T, 'payments', { id: 'stripe-pi_123', invoiceId: 'inv-sd', amountCents: 112000, date: TODAY, method: 'card', source: 'stripe', stripe: { paymentIntentId: 'pi_123' } }, stripe);
    await patch(T, 'invoices', 'inv-sd', { status: 'paid' });
    await pass(T);
    const pl = await link(T, 'payments', 'stripe-pi_123');
    assert.equal(pl.state, 'synced', pl.last_error);
    const q = fake.get(T.realmId, 'Payment', pl.qbo_id);
    assert.equal(q.DepositToAccountRef.value, String(T.seed.accounts.stripe.Id), 'into the Stripe clearing account');
    fake.destroy(T.realmId, 'Payment', pl.qbo_id);
    await pass(T);
    const c = (await openConflicts(T)).find((x) => x.record_id === 'stripe-pi_123');
    assert.equal(c?.kind, 'deleted');
    assert.equal((await rec(T, 'payments', 'stripe-pi_123')).deleted, false);
    assert.equal((await rec(T, 'invoices', 'inv-sd')).status, 'paid');
  });
});

describe('voids and deletes', { skip }, () => {
  test('a QuickBooks void zeroes no Fishtape lines; a Fishtape void with QuickBooks payments opens a conflict', async () => {
    const T = await setupTenant('Void');
    await create(T, 'clients', { id: 'c-v', name: 'Void Client' });
    await create(T, 'invoices', invoice({ id: 'inv-v', number: 'INV-50', clientId: 'c-v' }));
    await create(T, 'invoices', invoice({ id: 'inv-w', number: 'INV-51', clientId: 'c-v' }));
    await pass(T);
    const lv = await link(T, 'invoices', 'inv-v');
    fake.void(T.realmId, 'Invoice', lv.qbo_id);
    await pass(T);
    const v = await rec(T, 'invoices', 'inv-v');
    assert.equal(v.status, 'void');
    assert.equal(v.lines[0].unitCents, 100000, 'lines untouched');
    const lw = await link(T, 'invoices', 'inv-w');
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: (await link(T, 'clients', 'c-v')).qbo_id }, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: lw.qbo_id, TxnType: 'Invoice' }] }] });
    await pass(T);
    await patch(T, 'invoices', 'inv-w', { status: 'void' });
    await pass(T);
    assert.notEqual(fake.get(T.realmId, 'Invoice', lw.qbo_id).TotalAmt, 0, 'not voided in QuickBooks');
    assert.equal((await openConflicts(T)).find((x) => x.record_id === 'inv-w')?.kind, 'deleted');
  });

  test('restoring an invoice whose QuickBooks copy was voided opens a conflict instead of re-creating it', async () => {
    const T = await setupTenant('Restore');
    await create(T, 'clients', { id: 'c-r', name: 'Restore Client' });
    await create(T, 'invoices', invoice({ id: 'inv-r', number: 'INV-60', clientId: 'c-r' }));
    await pass(T);
    await remove(T, 'invoices', 'inv-r');
    await pass(T);
    assert.equal((await link(T, 'invoices', 'inv-r')).state, 'deleted_local');
    await write(T, (tx) => records.restoreRecord(tx, T.p, 'invoices', 'inv-r', whoOf(T.p)));
    const count = fake.list(T.realmId, 'Invoice').length;
    await pass(T);
    assert.equal(fake.list(T.realmId, 'Invoice').length, count, 'not re-created');
    const c = (await openConflicts(T)).find((x) => x.record_id === 'inv-r');
    assert.equal(c.kind, 'deleted');
    // 'restore' renumbers and creates a new QuickBooks invoice.
    const lease = await acquireLease(t.db, T.tenantId, 'api');
    try { await resolveConflict(deps, T.tenantId, c.id, { choice: 'restore' }, whoOf(T.p), { epoch: lease.epoch }); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
    const l = await link(T, 'invoices', 'inv-r');
    assert.equal(l.state, 'synced', l.last_error);
    assert.notEqual((await rec(T, 'invoices', 'inv-r')).number, 'INV-60');
  });
});

describe('purchases and tax', { skip }, () => {
  test('a Manitoba bill with GST and RST: GST-only code, RST in the line cost, the printed GST kept', async () => {
    const T = await setupTenant('Bill Tax');
    await create(T, 'vendors', { id: 'v-1', name: 'Westburne' });
    await create(T, 'bills', {
      id: 'b-1', kind: 'bill', vendorId: 'v-1', number: 'W-1001', date: TODAY, status: 'open', taxProvince: 'MB',
      lines: [{ description: 'Wire', qty: 1, unitCents: 10000, amountCents: 10000, costType: 'material' }],
      taxes: [{ id: 'GST', label: 'GST', cents: 500 }, { id: 'RST', label: 'RST', cents: 700 }], totalCents: 11200,
    });
    await pass(T);
    const l = await link(T, 'bills', 'b-1');
    assert.equal(l.state, 'synced', l.last_error);
    const b = fake.get(T.realmId, 'Bill', l.qbo_id);
    assert.equal(b.Line[0].Amount, 107, 'RST spread into the cost');
    assert.equal(b.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, String(T.seed.taxCodes.gst.Id));
    assert.equal(b.TxnTaxDetail.TotalTax, 5, 'the printed GST, not 5% of 107');
    assert.equal(b.TotalAmt, 112);
    assert.equal(b.Line[0].AccountBasedExpenseLineDetail.BillableStatus, 'NotBillable');
  });

  test('a tax-inclusive QuickBooks expense is pulled as a net receipt; a tax-inclusive invoice goes to review', async () => {
    const T = await setupTenant('Inclusive');
    await create(T, 'clients', { id: 'c-i', name: 'Inclusive Client' });
    await pass(T);
    const cust = (await link(T, 'clients', 'c-i')).qbo_id;
    fake.create(T.realmId, 'Purchase', {
      PaymentType: 'CreditCard', AccountRef: { value: T.seed.accounts.bank.Id }, TxnDate: TODAY, GlobalTaxCalculation: 'TaxInclusive',
      Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 105, AccountBasedExpenseLineDetail: { AccountRef: { value: T.seed.accounts.materials.Id }, TaxCodeRef: { value: T.seed.taxCodes.gst.Id }, CustomerRef: { value: cust } } }],
    });
    fake.create(T.realmId, 'Invoice', {
      CustomerRef: { value: cust }, DocNumber: 'Q-500', TxnDate: TODAY, GlobalTaxCalculation: 'TaxInclusive',
      Line: [{ DetailType: 'SalesItemLineDetail', Amount: 112, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 112, TaxCodeRef: { value: T.seed.taxCodes.gstPst.Id } } }],
    });
    await pass(T);
    const bill = (await t.superPool.query("SELECT id, data FROM bills WHERE tenant_id = $1", [T.tenantId])).rows[0];
    assert.ok(bill, 'pulled as a bill');
    assert.equal(bill.data.kind, 'receipt');
    assert.equal(bill.data.lines[0].amountCents, 10000, 'net of the GST');
    assert.deepEqual(bill.data.taxes.map((x) => [x.id, x.cents]), [['GST', 500]]);
    assert.equal((await link(T, 'bills', bill.id)).owner, 'quickbooks');
    const inv = (await t.superPool.query("SELECT id FROM invoices WHERE tenant_id = $1 AND data->>'number' = 'Q-500'", [T.tenantId])).rows[0];
    const li = await link(T, 'invoices', inv.id);
    assert.equal(li.state, 'needs_review');
    assert.equal(li.reason, 'tax_inclusive');
    assert.equal(li.owner, 'quickbooks');
  });

  test('a filed GST period and a paid pay period send edits to review', async () => {
    const T = await setupTenant('Filed');
    await create(T, 'clients', { id: 'c-f', name: 'Filed Client' });
    await create(T, 'invoices', invoice({ id: 'inv-f', number: 'INV-70', clientId: 'c-f' }));
    await pass(T);
    await setMappings(T, { option: { taxFiledThrough: TODAY } });
    await patch(T, 'invoices', 'inv-f', { lines: [{ description: 'Panel upgrade', qty: 1, unitCents: 120000, kind: 'material' }] });
    await pass(T);
    let l = await link(T, 'invoices', 'inv-f');
    assert.equal(l.state, 'needs_review');
    assert.equal(l.reason, 'filed_period');
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).TotalAmt, 1120, 'nothing sent');
    const review = (await openConflicts(T)).find((c) => c.record_id === 'inv-f');
    const lease = await acquireLease(t.db, T.tenantId, 'api');
    try { await resolveConflict(deps, T.tenantId, review.id, { choice: 'fishtape' }, whoOf(T.p), { epoch: lease.epoch }); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
    l = await link(T, 'invoices', 'inv-f');
    assert.equal(fake.get(T.realmId, 'Invoice', l.qbo_id).TotalAmt, 1344, 'confirmed: sent');
    // Time on or before the pay-period lock.
    const emp = fake.create(T.realmId, 'Employee', { GivenName: 'Sam', FamilyName: 'Amp', DisplayName: 'Sam Amp' });
    await create(T, 'employees', { id: 'e-f', name: 'Sam Amp' });
    const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
    await t.superPool.query("INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state, owner) VALUES ($1, $2, 'employees', 'e-f', 'Employee', $3, 'synced', 'quickbooks')", [T.tenantId, rows[0].realm_hash, emp.Id]);
    await setMappings(T, { option: { timeLockedThrough: TODAY } });
    await create(T, 'timeEntries', { id: 'te-f', employeeId: 'e-f', clockIn: `${TODAY}T15:00:00Z`, clockOut: `${TODAY}T16:00:00Z`, approved: true });
    await pass(T);
    const lt = await link(T, 'timeEntries', 'te-f');
    assert.equal(lt.state, 'needs_review');
    assert.equal(lt.reason, 'payroll_locked');
    assert.equal(fake.list(T.realmId, 'TimeActivity').length, 0);
  });
});

describe('webhooks and CDC', { skip }, () => {
  test('a CDC pass triggered by an Invoice webhook still pulls a Bill whose webhook was lost', async () => {
    const T = await setupTenant('Lost Hook');
    await create(T, 'clients', { id: 'c-lh', name: 'Hook Client' });
    await create(T, 'vendors', { id: 'v-lh', name: 'Nedco' });
    await pass(T);
    const cust = (await link(T, 'clients', 'c-lh')).qbo_id;
    const vend = (await link(T, 'vendors', 'v-lh')).qbo_id;
    fake.company(T.realmId).events.length = 0;
    fake.dropWebhooks('Bill');
    fake.create(T.realmId, 'Bill', { VendorRef: { value: vend }, TxnDate: TODAY, DocNumber: 'N-77', Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 40, AccountBasedExpenseLineDetail: { AccountRef: { value: T.seed.accounts.materials.Id }, CustomerRef: { value: cust } } }] });
    fake.create(T.realmId, 'Invoice', { CustomerRef: { value: cust }, DocNumber: 'Q-1', TxnDate: TODAY, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 10, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 10, TaxCodeRef: { value: T.seed.taxCodes.gstPst.Id } } }] });
    const hook = fake.signedWebhook(T.realmId, 'v1');
    fake.keepWebhooks();
    assert.ok(!hook.events.some((e) => e.type.includes('bill')), 'the Bill event was lost');
    const r = await ingestWebhook(t.db, sealer, config, parseWebhook(hook.raw));
    assert.equal(r.accepted, hook.events.length);
    await pass(T);
    const bills = (await t.superPool.query("SELECT data FROM bills WHERE tenant_id = $1 AND data->>'number' = 'N-77'", [T.tenantId])).rows;
    assert.equal(bills.length, 1, 'pulled by CDC anyway');
    assert.equal(bills[0].data.vendorId, 'v-lh');
  });
});

describe('Stripe payouts', { skip }, () => {
  async function stripePayment(T, pi, cents, fee) {
    const stripe = systemPrincipal(T.tenantId, 'stripe', 'Stripe');
    await create(T, 'payments', { id: `stripe-${pi}`, invoiceId: 'inv-p', amountCents: cents, date: TODAY, method: 'card', source: 'stripe', stripe: { paymentIntentId: pi, feeCents: fee, chargeId: `ch_${pi}` } }, stripe);
  }
  async function payout(T, id, o) {
    await t.superPool.query(
      `INSERT INTO stripe_payouts (tenant_id, payout_id, amount_cents, currency, arrival_date, status, paid_seen, automatic, livemode, balance_txns, earliest_charge_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, payout_id) DO UPDATE SET status = EXCLUDED.status, paid_seen = EXCLUDED.paid_seen, balance_txns = EXCLUDED.balance_txns, received_at = now()`,
      [T.tenantId, id, o.amount, o.currency || 'cad', TODAY, o.status || 'paid', o.paidSeen ?? true, o.automatic ?? true, o.livemode ?? true, JSON.stringify(o.txns || []), o.earliest || new Date().toISOString()]);
    await t.superPool.query(
      `INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, actor_type, rank) VALUES ($1, 'stripePayouts', $2, 'upsert', 'stripe', 70)
       ON CONFLICT (tenant_id, collection, record_id) DO UPDATE SET not_before = now(), claimed_until = NULL`, [T.tenantId, id]);
  }

  test('fees and payouts: booked once everything is in; test mode and pre-cutover skipped; refunds to review; failed after paid deleted', async () => {
    const T = await setupTenant('Payouts');
    await create(T, 'clients', { id: 'c-p', name: 'Payout Client' });
    await create(T, 'invoices', invoice({ id: 'inv-p', number: 'INV-80', clientId: 'c-p' }));
    await pass(T);
    await stripePayment(T, 'pi_AAAA1111', 50000, 1480);
    await pass(T);
    const main = await link(T, 'payments', 'stripe-pi_AAAA1111');
    const fee = await link(T, 'payments', 'stripe-pi_AAAA1111', 'fee');
    assert.equal(main.state, 'synced', main.last_error);
    assert.equal(fee?.state, 'synced', fee?.last_error);
    const purchase = fake.get(T.realmId, 'Purchase', fee.qbo_id);
    assert.equal(purchase.Line[0].Amount, 14.8);
    assert.equal(purchase.AccountRef.value, String(T.seed.accounts.stripe.Id));
    // A payout with that charge and a dispute fee: one Transfer and one fee Purchase.
    await payout(T, 'po_GOOD00001', { amount: 48370, txns: [
      { id: 'txn_1', type: 'charge', amountCents: 50000, feeCents: 1480, paymentIntentId: 'pi_AAAA1111', created: new Date().toISOString() },
      { id: 'txn_2', type: 'adjustment', amountCents: 0, feeCents: 150, paymentIntentId: null, created: new Date().toISOString() },
    ] });
    await pass(T);
    const tr = await link(T, 'stripePayouts', 'po_GOOD00001');
    assert.equal(tr?.state, 'synced', tr?.last_error);
    const transfer = fake.get(T.realmId, 'Transfer', tr.qbo_id);
    assert.equal(transfer.Amount, 483.7);
    assert.equal(transfer.FromAccountRef.value, String(T.seed.accounts.stripe.Id));
    const pf = await link(T, 'stripePayouts', 'po_GOOD00001', 'fee');
    assert.equal(fake.get(T.realmId, 'Purchase', pf.qbo_id).Line[0].Amount, 1.5);
    // Test mode and a charge before the cutover: skipped.
    await payout(T, 'po_TEST00001', { amount: 100, livemode: false });
    await setMappings(T, { option: { stripeCutover: '2099-01-01' } });
    await payout(T, 'po_OLD000001', { amount: 100, txns: [{ id: 'txn_3', type: 'charge', amountCents: 100, feeCents: 0, paymentIntentId: 'pi_X', created: '2020-01-01T00:00:00Z' }], earliest: '2020-01-01T00:00:00Z' });
    await pass(T);
    assert.equal(await link(T, 'stripePayouts', 'po_TEST00001'), undefined);
    assert.equal(await link(T, 'stripePayouts', 'po_OLD000001'), undefined);
    await setMappings(T, { option: { stripeCutover: '2000-01-01' } });
    // A refund in the payout: review.
    await payout(T, 'po_REFUND001', { amount: 900, txns: [{ id: 'txn_4', type: 'refund', amountCents: -100, feeCents: 0, paymentIntentId: 'pi_AAAA1111', created: new Date().toISOString() }] });
    await pass(T);
    const rf = await link(T, 'stripePayouts', 'po_REFUND001');
    assert.equal(rf.state, 'needs_review');
    assert.equal(rf.reason, 'payout_items');
    // Failed after paid: the Transfer and its fees come out of QuickBooks.
    await payout(T, 'po_GOOD00001', { amount: 48370, status: 'failed', paidSeen: true, txns: [] });
    await pass(T);
    assert.equal((await link(T, 'stripePayouts', 'po_GOOD00001')).state, 'deleted_local');
    assert.equal(fake.list(T.realmId, 'Transfer').filter((x) => x.Id === tr.qbo_id).length, 0);
  });
});
