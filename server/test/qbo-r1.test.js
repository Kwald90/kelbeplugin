// Release 1 QuickBooks against the fake QuickBooks and a real Postgres (docs/releases/r1-get-paid.md 9 and
// 12.1 R1-F; docs/integrations/quickbooks.md 17): the holdback line and its release, deposit lines held
// until item.deposit is mapped, interest, a credit memo and its $0 apply payment, a pulled credit memo
// counted once against the settlement, on-account, refund and reversal payments held in review, per-line
// tax keys both ways, resale RST to account.rstRecoverable and back, a pull into a locked period with its
// two resolutions, a late pulled bill posted on the first open day, QuickBooks numbering after the lock,
// the exemption review and the payroll lock from payroll runs.
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
import { docTotals, creditNoteFrom, holdbackReleaseLine, depositInvoiceFields, depositInvoiceLine } from '../../electrical-app/js/lib/money.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { syncTenant, pushRecord, pulledInvoiceProblem } from '../src/qbo/engine.js';
import { neverPushed } from '../src/qbo/push.js';
import { resolveConflict } from '../src/qbo/conflicts.js';
import { createQboClient } from '../src/qbo/client.js';
import { fishtapeToCanon, qboToCanon, canonEqual } from '../src/qbo/map/canon.js';
import { canonToQbo, entityFor, purchaseSign } from '../src/qbo/map/to-qbo.js';
import { canonToFishtape, settlementCents } from '../src/qbo/map/to-fishtape.js';
import { lineTaxKey, holdbackTaxKey, docTaxLines, needsTaxReason, expectedTax, spreadPurchaseTax, fallbackBillLineTaxUse } from '../src/qbo/map/tax.js';

const KEY = randomBytes(32).toString('base64');
const fake = createFakeQbo();
const config = readConfig({
  APP_ENV: 'test', SECRETS_MASTER_KEY: KEY, PUBLIC_ORIGIN: 'https://app.fishtape.test', QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'v1',
});
const sealer = createSealer(KEY);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });
const daysBefore = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
/** A day in the closed period, and the closing date (the books are closed through CLOSED). */
const OLD = daysBefore(TODAY, 30);
const CLOSED = daysBefore(TODAY, 10);
let t, records, deps;
let realmN = 0;

const principal = (tenantId, userId, role = 'owner') => ({
  kind: 'session', tenantId, userId, sessionId: null, role, perms: permsForRole(role), isManager: true, employeeId: null, scopes: null, crew: false,
  actor: { type: 'user', id: userId, label: `${role} tester` },
});
const whoOf = (p) => ({ actor: p.actor, request: {} });
const MB_TAX = () => taxComponents({ province: 'MB', treatment: 'pst-all' });

async function setupTenant(name, { options = {} } = {}) {
  const realmId = `46201977${String(++realmN).padStart(8, '0')}`;
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
    taxCode: { 'GST+RST|MB': s.taxCodes.gstPst.Id, GST: s.taxCodes.gst.Id, 'NONE|EXEMPT': s.taxCodes.exempt.Id, 'NONE|ZERO': s.taxCodes.zero.Id, 'NONE|OOS': s.taxCodes.oos.Id },
    purchaseTaxCode: { 'GST+RST|MB': s.taxCodes.gst.Id, GST: s.taxCodes.gst.Id, NONE: s.taxCodes.exempt.Id, stripeFee: s.taxCodes.exempt.Id },
    account: { 'income.default': s.accounts.income.Id, 'expense.default': s.accounts.cogs.Id, 'jobCost.material': s.accounts.materials.Id },
    paymentMethod: { cash: s.paymentMethods.Cash.Id, check: s.paymentMethods.Cheque.Id },
    depositTo: { cash: s.accounts.undeposited.Id, check: s.accounts.undeposited.Id, transfer: s.accounts.undeposited.Id },
    option: { syncFrom: '2000-01-01', timeOwner: 'fishtape', ...options },
  });
  await write(T, (tx) => records.createRecord(tx, T.p, 'settings', { id: 'settings', company: { name, province: 'MB' }, nextNumbers: { invoice: 3001, estimate: 2001, credit: 1001 } }, whoOf(T.p)));
  await t.superPool.query(
    `UPDATE qbo_connections SET state = 'active', setup = '{"phase":"done"}'::jsonb, cdc_cursor = now() - interval '1 minute', time_cursor = now(), last_check_at = now() WHERE tenant_id = $1`, [T.tenantId]);
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

/** The Release 1 products and account in the fake QuickBooks, mapped (r1-get-paid.md 9.8). */
async function mapR1(T, keys = ['holdback', 'deposit', 'interest', 'rstRecoverable']) {
  const income = { value: T.seed.accounts.income.Id };
  const made = {};
  const item = (Name) => fake.create(T.realmId, 'Item', { Name, Type: 'Service', Active: true, IncomeAccountRef: income }).Id;
  if (keys.includes('holdback')) made.holdback = item('Holdback');
  if (keys.includes('deposit')) made.deposit = item('Customer deposits');
  if (keys.includes('interest')) made.interest = item('Overdue interest');
  const maps = { item: Object.fromEntries(Object.entries(made)) };
  if (keys.includes('rstRecoverable')) {
    made.rstRecoverable = fake.create(T.realmId, 'Account', { Name: 'RST recoverable', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets', Active: true, CurrentBalance: 0 }).Id;
    maps.account = { rstRecoverable: made.rstRecoverable };
  }
  await setMappings(T, maps);
  return made;
}

const write = (T, fn) => t.db.withTenant({ tenantId: T.tenantId }, fn, { write: true });
const create = (T, coll, body, p = T.p) => write(T, (tx) => records.createRecord(tx, p, coll, body, whoOf(p)));
const patch = (T, coll, id, body, p = T.p) => write(T, (tx) => records.patchRecord(tx, p, coll, id, body, {}, whoOf(p)));
const due = (T) => t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second' WHERE tenant_id = $1", [T.tenantId]);
async function withLeaseDo(T, fn) {
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  assert.ok(lease, 'lease');
  try { return await fn(lease.epoch); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
}
async function pass(T, o = {}) {
  await due(T);
  return withLeaseDo(T, (epoch) => syncTenant({ ...deps, ...(o.deps || {}) }, T.tenantId, { epoch, ...o }));
}
const sendNow = (T, coll, id, o = {}) => withLeaseDo(T, (epoch) => pushRecord(deps, T.tenantId, coll, id, { epoch, ...o }));
const resolve = (T, conflictId, body) => withLeaseDo(T, (epoch) => resolveConflict(deps, T.tenantId, conflictId, body, whoOf(T.p), { epoch }));
const link = async (T, coll, id, role = 'main') => (await t.superPool.query('SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = $4', [T.tenantId, coll, id, role])).rows[0];
const rec = async (T, table, id) => { const r = (await t.superPool.query(`SELECT data, version, deleted_at FROM ${table} WHERE tenant_id = $1 AND id = $2`, [T.tenantId, id])).rows[0]; return r ? { ...r.data, version: Number(r.version), deleted: Boolean(r.deleted_at) } : null; };
const openReviews = async (T) => (await t.superPool.query("SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND status = 'open' ORDER BY created_at", [T.tenantId])).rows;
const reviewOf = async (T, recordId) => (await openReviews(T)).find((c) => c.record_id === recordId);
const closeBooks = (T, through) => t.superPool.query("INSERT INTO period_locks (tenant_id, kind, through, actor) VALUES ($1, 'books', $2, 'test')", [T.tenantId, through]);
const cents = (d) => Math.round(Number(d) * 100);

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
  t = await createTestDatabase('qbor1');
  // With db, refused writes (the QuickBooks pull's included) are listed in sync_rejections (2.6).
  records = createRecords({ validator: createValidator(), config, db: t.db });
  deps = { db: t.db, sealer, config, records };
});
after(async () => { setFetch(null); await t?.close(); });

describe('holdback, deposits and interest (9.2)', { skip }, () => {
  test('the holdback is a negative line on item.holdback; the release a positive one; deposit and interest wait for their products', async () => {
    const T = await setupTenant('Holdback Electric');
    await create(T, 'clients', { id: 'c-gc', name: 'Prairie Builders' });
    await create(T, 'invoices', invoice({
      id: 'inv-hb', number: 'INV-3101', clientId: 'c-gc', kind: 'progress', lines: [{ description: 'Rough-in, floor 2', qty: 1, unitCents: 100000, kind: 'labour' }],
      holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: true },
    }));
    await create(T, 'invoices', invoice({ id: 'inv-dep', number: 'INV-3102', clientId: 'c-gc', ...depositInvoiceFields('prepayment'), lines: [depositInvoiceLine({ cents: 50000, model: 'prepayment', ref: 'J-1' })] }));
    await create(T, 'invoices', invoice({
      id: 'inv-sec', number: 'INV-3103', clientId: 'c-gc', ...depositInvoiceFields('security'), taxTreatment: 'none', taxes: [], taxPct: 0,
      lines: [depositInvoiceLine({ cents: 20000, model: 'security' })],
    }));
    await create(T, 'invoices', invoice({
      id: 'inv-int', number: 'INV-3104', clientId: 'c-gc', kind: 'interest', taxTreatment: 'none', taxNoneReason: 'exempt', taxes: [], taxPct: 0,
      lines: [{ description: 'Interest on INV-2990', qty: 1, unitCents: 1250, kind: 'other', lineType: 'interest' }],
    }));
    await pass(T);
    for (const [id, word] of [['inv-hb', 'Holdback'], ['inv-dep', 'Deposits'], ['inv-sec', 'Deposits'], ['inv-int', 'Interest']]) {
      const l = await link(T, 'invoices', id);
      assert.equal(`${l.state}/${l.reason}`, 'blocked/mapping_missing', id);
      assert.match(l.last_error, new RegExp(word), id);
    }
    assert.equal(fake.list(T.realmId, 'Invoice').length, 0, 'nothing sent: the deposit item is never the `other` income fallback');

    const items = await mapR1(T, ['holdback', 'deposit', 'interest']);
    for (const id of ['inv-hb', 'inv-dep', 'inv-sec', 'inv-int']) assert.equal(await sendNow(T, 'invoices', id), 'synced', id);

    // Progress invoice: $1,000 of work, $100 holdback with GST and RST deferred to the release.
    const hb = fake.get(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-hb')).qbo_id);
    const hbLine = hb.Line.find((x) => x.SalesItemLineDetail?.ItemRef?.value === String(items.holdback));
    assert.equal(hbLine.Amount, -100);
    assert.equal(hbLine.SalesItemLineDetail.TaxCodeRef.value, String(T.seed.taxCodes.gstPst.Id), 'the code of the deferred taxes');
    assert.equal(cents(hb.TotalAmt), docTotals(await rec(T, 'invoices', 'inv-hb')).totalCents, 'QuickBooks total = Fishtape total net of holdback');
    assert.equal(cents(hb.TotalAmt), 100800);

    // Holdback the customer kept on its own is Fishtape-only: nothing goes to QuickBooks.
    const before = fake.get(T.realmId, 'Invoice', hb.Id).SyncToken;
    await patch(T, 'invoices', 'inv-hb', { holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: true, retainedByCustomerCents: 5000, retainedRecordedAt: new Date().toISOString() } });
    await pass(T);
    assert.equal(fake.get(T.realmId, 'Invoice', hb.Id).SyncToken, before);

    // Deposits on item.deposit: a prepayment taxed like the work, a security deposit out of scope.
    const dep = fake.get(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-dep')).qbo_id);
    assert.equal(dep.Line[0].SalesItemLineDetail.ItemRef.value, String(items.deposit));
    assert.equal(dep.Line[0].SalesItemLineDetail.TaxCodeRef.value, String(T.seed.taxCodes.gstPst.Id));
    const sec = fake.get(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-sec')).qbo_id);
    assert.equal(sec.Line[0].SalesItemLineDetail.TaxCodeRef.value, String(T.seed.taxCodes.oos.Id));
    assert.equal(cents(sec.TotalAmt), 20000);
    // Interest on item.interest, an exempt supply.
    const int = fake.get(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-int')).qbo_id);
    assert.equal(int.Line[0].SalesItemLineDetail.ItemRef.value, String(items.interest));
    assert.equal(int.Line[0].SalesItemLineDetail.TaxCodeRef.value, String(T.seed.taxCodes.exempt.Id));

    // The release invoice: a positive line on item.holdback, taxed with the deferred taxes.
    await create(T, 'invoices', invoice({ id: 'inv-rel', number: 'INV-3105', clientId: 'c-gc', kind: 'holdback-release', holdbackInvoiceIds: ['inv-hb'], lines: [holdbackReleaseLine(10000, { taxes: MB_TAX(), deferTaxIds: ['GST', 'RST'] })] }));
    await pass(T);
    const rel = fake.get(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-rel')).qbo_id);
    assert.equal(rel.Line[0].Amount, 100);
    assert.equal(rel.Line[0].SalesItemLineDetail.ItemRef.value, String(items.holdback));
    assert.equal(cents(rel.TotalAmt), 11200);

    // QuickBooks halves the holdback: Fishtape's amount follows; its pct, deferral and the customer's part stay.
    const q = fake.get(T.realmId, 'Invoice', hb.Id);
    const lines = q.Line.map((x) => (x.SalesItemLineDetail?.ItemRef?.value === String(items.holdback) ? { ...x, Amount: -50, SalesItemLineDetail: { ...x.SalesItemLineDetail, UnitPrice: -50 } } : x));
    fake.edit(T.realmId, 'Invoice', hb.Id, { Line: lines });
    await pass(T);
    const after = await rec(T, 'invoices', 'inv-hb');
    assert.equal(after.holdback.cents, 5000);
    assert.equal(after.holdback.pct, 10);
    assert.deepEqual(after.holdback.deferTaxIds, ['GST', 'RST']);
    assert.equal(after.holdback.retainedByCustomerCents, 5000, 'Fishtape-only, kept through the merge');
    assert.equal(after.kind, 'progress');
    assert.equal(after.lines.length, 1, 'the holdback is not a Fishtape line');
    assert.equal(docTotals(after).totalCents, cents(fake.get(T.realmId, 'Invoice', hb.Id).TotalAmt));
    assert.equal((await link(T, 'invoices', 'inv-hb')).state, 'synced');
  });
});

describe('credit notes and payments (9.2)', { skip }, () => {
  test('a bad-debt credit note is a CreditMemo; applying it is a $0 payment held for review until approved; the settlement does not count it again', async () => {
    const T = await setupTenant('Credit Electric');
    await create(T, 'clients', { id: 'c-cr', name: 'Slow Payer Ltd' });
    await create(T, 'invoices', invoice({ id: 'inv-cr', number: 'INV-3201', clientId: 'c-cr' }));
    await pass(T);
    const inv = await rec(T, 'invoices', 'inv-cr');
    const note = creditNoteFrom(inv, { reason: 'bad_debt', today: TODAY, number: 'CR-1001' });
    await create(T, 'invoices', { ...note, id: 'cn-1', status: 'sent' });
    await pass(T);
    const nl = await link(T, 'invoices', 'cn-1');
    assert.equal(nl.state, 'synced', nl.last_error);
    assert.equal(nl.qbo_entity, 'CreditMemo');
    const memo = fake.get(T.realmId, 'CreditMemo', nl.qbo_id);
    assert.ok(memo.Line.every((x) => x.Amount > 0), 'amounts made positive');
    assert.equal(cents(memo.TotalAmt), 43120);
    assert.match(memo.PrivateNote, /Bad debt write-off$/);
    assert.equal(memo.DocNumber, 'CR-1001');

    // Applying the credit note: held in review (VERIFY in the sandbox) until the office approves.
    await create(T, 'payments', { id: 'pay-cn', invoiceId: 'inv-cr', creditNoteId: 'cn-1', method: 'credit-note', amountCents: 43120, date: TODAY, clientId: 'c-cr' });
    await pass(T);
    let al = await link(T, 'payments', 'pay-cn', 'apply');
    assert.equal(`${al.state}/${al.reason}`, 'needs_review/credit_apply');
    assert.equal(fake.list(T.realmId, 'Payment').length, 0);
    await resolve(T, (await reviewOf(T, 'pay-cn')).id, { choice: 'fishtape' });
    al = await link(T, 'payments', 'pay-cn', 'apply');
    assert.equal(al.state, 'synced', al.last_error);
    const p = fake.get(T.realmId, 'Payment', al.qbo_id);
    assert.equal(cents(p.TotalAmt), 0);
    assert.deepEqual(p.Line.map((x) => [x.LinkedTxn[0].TxnType, cents(x.Amount)]).sort(), [['CreditMemo', 43120], ['Invoice', 43120]]);
    assert.equal(cents(fake.get(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-cr')).qbo_id).Balance), 0);
    // The next pulls see the invoice settled by the memo, which Fishtape already holds: no settlement payment.
    fake.edit(T.realmId, 'Invoice', (await link(T, 'invoices', 'inv-cr')).qbo_id, { DueDate: TODAY });
    await pass(T);
    const s = await rec(T, 'payments', 'credit-inv-cr');
    assert.ok(!s || s.deleted, 'a memo is never counted twice');
    const onInvoice = (await t.superPool.query("SELECT data FROM payments WHERE tenant_id = $1 AND data->>'invoiceId' = 'inv-cr' AND deleted_at IS NULL", [T.tenantId])).rows;
    assert.deepEqual(onInvoice.map((r) => [r.data.method, r.data.amountCents]), [['credit-note', 43120]]);
  });

  test('money on account, a refund and a reversal are never sent: they wait in review until recorded in QuickBooks', async () => {
    const T = await setupTenant('Receipts Electric');
    await create(T, 'clients', { id: 'c-ra', name: 'Cheque Writer Inc' });
    await create(T, 'invoices', invoice({ id: 'inv-ra', number: 'INV-3301', clientId: 'c-ra' }));
    await create(T, 'payments', { id: 'pay-ra', invoiceId: 'inv-ra', amountCents: 10000, date: TODAY, method: 'cheque', clientId: 'c-ra', receiptId: 'rcpt-1' });
    await create(T, 'payments', { id: 'pay-acct', invoiceId: null, clientId: 'c-ra', amountCents: 5000, date: TODAY, method: 'cheque', receiptId: 'rcpt-1' });
    await create(T, 'payments', { id: 'pay-ref', invoiceId: 'inv-ra', clientId: 'c-ra', amountCents: -2000, date: TODAY, method: 'refund' });
    await create(T, 'payments', { id: 'pay-rev', invoiceId: 'inv-ra', clientId: 'c-ra', amountCents: -10000, date: TODAY, method: 'cheque', reversesId: 'pay-ra' });
    await pass(T);
    assert.equal((await link(T, 'payments', 'pay-ra')).state, 'synced', 'a receipt allocation is its own QuickBooks payment');
    for (const [id, reason] of [['pay-acct', 'on_account'], ['pay-ref', 'refund'], ['pay-rev', 'reversal']]) {
      const l = await link(T, 'payments', id);
      assert.equal(`${l.state}/${l.reason}`, `needs_review/${reason}`, id);
    }
    assert.equal(fake.list(T.realmId, 'Payment').length, 1);
    const review = await reviewOf(T, 'pay-acct');
    await assert.rejects(resolve(T, review.id, { choice: 'fishtape' }), (e) => e.code === 'qbo_not_sent');
    await resolve(T, review.id, { choice: 'quickbooks' });
    assert.equal((await link(T, 'payments', 'pay-acct')).state, 'unlinked', 'recorded in QuickBooks: never sent');
    await patch(T, 'payments', 'pay-acct', { reference: 'CHQ 1001' });
    await pass(T);
    assert.equal(fake.list(T.realmId, 'Payment').length, 1);
  });
});

describe('tax keys per line and purchase tax (9.1, 9.3)', { skip }, () => {
  test('a pass-through line goes out with GST only; QuickBooks edits come back with taxOff and the line fields kept', async () => {
    const T = await setupTenant('Line Tax Electric');
    await create(T, 'clients', { id: 'c-lt', name: 'Hotel Client' });
    await create(T, 'invoices', invoice({
      id: 'inv-lt', number: 'INV-3401', clientId: 'c-lt', lines: [
        { description: 'Service call', qty: 2, unitCents: 9500, kind: 'labour', costCodeId: 'cc-service' },
        { description: 'Hotel, 1 night', qty: 1, unitCents: 15000, kind: 'other', passThrough: true, taxOff: ['RST'], costCodeId: 'cc-general' },
      ],
    }));
    await pass(T);
    const l = await link(T, 'invoices', 'inv-lt');
    assert.equal(l.state, 'synced', l.last_error);
    const q = fake.get(T.realmId, 'Invoice', l.qbo_id);
    assert.deepEqual(q.Line.filter((x) => x.SalesItemLineDetail).map((x) => x.SalesItemLineDetail.TaxCodeRef.value), [String(T.seed.taxCodes.gstPst.Id), String(T.seed.taxCodes.gst.Id)]);
    assert.equal(cents(q.TotalAmt), docTotals(await rec(T, 'invoices', 'inv-lt')).totalCents);
    // QuickBooks changes the hotel amount: Fishtape keeps the pass-through, its taxOff and cost code.
    const lines = q.Line.map((x, i) => (i === 1 ? { ...x, Amount: 160, SalesItemLineDetail: { ...x.SalesItemLineDetail, UnitPrice: 160 } } : x));
    fake.edit(T.realmId, 'Invoice', l.qbo_id, { Line: lines });
    await pass(T);
    const after = await rec(T, 'invoices', 'inv-lt');
    assert.equal(after.lines[1].unitCents, 16000);
    assert.equal(after.lines[1].passThrough, true);
    assert.deepEqual(after.lines[1].taxOff, ['RST']);
    assert.equal(after.lines[1].costCodeId, 'cc-general');
    assert.equal(after.taxTreatment, 'pst-all', 'the treatment is kept: the line says what is off');
    assert.equal((await link(T, 'invoices', 'inv-lt')).state, 'synced');

    // A QuickBooks invoice whose labour line is GST-only among taxed labour: taxOff on a work line
    // (not a pass-through) goes to review instead of tax_shape.
    const cust = (await link(T, 'clients', 'c-lt')).qbo_id;
    const sale = (amount, code) => ({ DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: code } } });
    fake.create(T.realmId, 'Invoice', { CustomerRef: { value: cust }, DocNumber: 'Q-3402', TxnDate: TODAY, Line: [sale(400, T.seed.taxCodes.gstPst.Id), sale(100, T.seed.taxCodes.gst.Id)] });
    await pass(T);
    const pulled = (await t.superPool.query("SELECT id, data FROM invoices WHERE tenant_id = $1 AND data->>'number' = 'Q-3402'", [T.tenantId])).rows[0];
    assert.ok(pulled);
    assert.deepEqual(pulled.data.lines.map((x) => x.taxOff || null), [null, ['RST']]);
    const pl = await link(T, 'invoices', pulled.id);
    assert.equal(`${pl.state}/${pl.reason}`, 'needs_review/tax_off_invalid');
  });

  test('RST on resale lines goes to account.rstRecoverable and comes back as RST on the bill; own-use RST is cost', async () => {
    const T = await setupTenant('Resale Electric');
    await create(T, 'vendors', { id: 'v-w', name: 'Westburne' });
    await create(T, 'bills', {
      id: 'b-r', kind: 'bill', vendorId: 'v-w', number: 'W-2001', date: TODAY, status: 'open', taxProvince: 'MB',
      lines: [
        { description: 'Panel and breakers', qty: 1, unitCents: 100000, amountCents: 100000, costType: 'material' },
        { description: 'Drill bits', qty: 1, unitCents: 10000, amountCents: 10000, costType: 'other' },
      ],
      taxes: [{ id: 'GST', label: 'GST', cents: 5500 }, { id: 'RST', label: 'RST', cents: 7700 }], totalCents: 123200,
    });
    await pass(T);
    let l = await link(T, 'bills', 'b-r');
    assert.equal(`${l.state}/${l.reason}`, 'blocked/mapping_missing', 'resale RST needs its account');
    assert.match(l.last_error, /RST recoverable/);
    const { rstRecoverable } = await mapR1(T, ['rstRecoverable']);
    assert.equal(await sendNow(T, 'bills', 'b-r'), 'synced');
    l = await link(T, 'bills', 'b-r');
    const b = fake.get(T.realmId, 'Bill', l.qbo_id);
    const amounts = b.Line.map((x) => [x.AccountBasedExpenseLineDetail.AccountRef.value, cents(x.Amount)]);
    // RST $77.00 shared $70.00 / $7.00: the resale share to the recoverable account, the own-use share into the bits.
    assert.deepEqual(amounts, [[String(T.seed.accounts.materials.Id), 100000], [String(T.seed.accounts.materials.Id), 10700], [String(rstRecoverable), 7000]]);
    assert.equal(cents(b.TxnTaxDetail.TotalTax), 5500, 'the printed GST');
    assert.equal(cents(b.TotalAmt), 123200);
    // Round trip: nothing more to send, and a QuickBooks edit comes back as RST on the bill.
    fake.resetCalls();
    await pass(T);
    assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path === 'bill').length, 0, 'stable');
    const lines = b.Line.map((x, i) => (i === 0 ? { ...x, Description: 'Panel, breakers and cover' } : x));
    fake.edit(T.realmId, 'Bill', l.qbo_id, { Line: lines });
    await pass(T);
    const after = await rec(T, 'bills', 'b-r');
    assert.equal(after.lines.length, 2, 'the recoverable line is not a cost line');
    assert.equal(after.lines[0].description, 'Panel, breakers and cover');
    // The fake recomputes GST on an edit (no override kept); the resale RST comes back whole.
    const edited = fake.get(T.realmId, 'Bill', l.qbo_id);
    assert.deepEqual(after.taxes.map((x) => [x.id, x.cents]).sort(), [['GST', cents(edited.TxnTaxDetail.TotalTax)], ['RST', 7000]]);
    assert.equal(after.totalCents, cents(edited.TotalAmt));
  });
});

describe('locks (9.6)', { skip }, () => {
  test('a QuickBooks edit in a closed period goes to review: noted, or accepted after reopening; refused writes are listed', async () => {
    const T = await setupTenant('Lock Electric');
    await create(T, 'clients', { id: 'c-lk', name: 'September Client' });
    await create(T, 'invoices', invoice({ id: 'inv-n', number: 'INV-3501', clientId: 'c-lk', issueDate: OLD, dueDate: OLD }));
    await create(T, 'invoices', invoice({ id: 'inv-q', number: 'INV-3502', clientId: 'c-lk', issueDate: OLD, dueDate: OLD }));
    await pass(T);
    await closeBooks(T, CLOSED);
    const edit = (id, amount) => {
      const q = fake.get(T.realmId, 'Invoice', id);
      fake.edit(T.realmId, 'Invoice', id, { Line: q.Line.map((x, i) => (i === 1 ? { ...x, Amount: amount, SalesItemLineDetail: { ...x.SalesItemLineDetail, Qty: 1, UnitPrice: amount } } : x)) });
    };
    const qn = (await link(T, 'invoices', 'inv-n')).qbo_id;
    const qq = (await link(T, 'invoices', 'inv-q')).qbo_id;
    edit(qn, 300);
    edit(qq, 300);
    await pass(T);
    for (const id of ['inv-n', 'inv-q']) {
      const l = await link(T, 'invoices', id);
      assert.equal(`${l.state}/${l.reason}`, 'needs_review/period_locked', id);
      assert.equal((await rec(T, 'invoices', id)).lines[1].unitCents, 9500, 'Fishtape keeps its locked copy');
    }
    const review = await reviewOf(T, 'inv-n');
    assert.match(review.fields[0].fishtape, new RegExp(`closed in Fishtape \\(through ${CLOSED}\\)`));
    const rej = (await t.superPool.query("SELECT * FROM sync_rejections WHERE tenant_id = $1 AND code = 'period_locked' AND actor LIKE 'system:qbo%'", [T.tenantId])).rows;
    assert.ok(rej.length >= 2, 'the refused pull writes are listed on Books');
    // Fishtape's copy is never pushed over QuickBooks' change.
    await assert.rejects(resolve(T, review.id, { choice: 'fishtape' }), (e) => e.code === 'qbo_locked');

    // Keep the difference noted: nothing is written either way afterwards.
    await resolve(T, review.id, { choice: 'note', note: 'Bookkeeper changed it after the close; agreed.' });
    let l = await link(T, 'invoices', 'inv-n');
    assert.equal(l.state, 'synced');
    assert.equal(l.meta.noted.note, 'Bookkeeper changed it after the close; agreed.');
    fake.resetCalls();
    await pass(T);
    assert.equal((await link(T, 'invoices', 'inv-n')).state, 'synced');
    assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path === 'invoice').length, 0, 'not pushed over QuickBooks');
    assert.equal(cents(fake.get(T.realmId, 'Invoice', qn).Line[1].Amount), 30000);

    // Reopen the period and accept QuickBooks: refused while still closed, written once reopened.
    const rq = await reviewOf(T, 'inv-q');
    await assert.rejects(resolve(T, rq.id, { choice: 'quickbooks' }), (e) => e.code === 'period_locked');
    await closeBooks(T, null);
    await resolve(T, rq.id, { choice: 'quickbooks' });
    l = await link(T, 'invoices', 'inv-q');
    assert.equal(l.state, 'synced');
    assert.equal((await rec(T, 'invoices', 'inv-q')).lines[1].unitCents, 30000);
  });

  test('a bill and a payment pulled late are posted on the first open day; a sent invoice in the closed period waits in review', async () => {
    const T = await setupTenant('Late Electric');
    await create(T, 'clients', { id: 'c-lt2', name: 'Late Client' });
    await create(T, 'invoices', invoice({ id: 'inv-l', number: 'INV-3601', clientId: 'c-lt2' }));
    await pass(T);
    await closeBooks(T, CLOSED);
    const cust = (await link(T, 'clients', 'c-lt2')).qbo_id;
    const vendor = fake.create(T.realmId, 'Vendor', { DisplayName: 'Late Supply' });
    fake.create(T.realmId, 'Bill', {
      VendorRef: { value: vendor.Id }, TxnDate: OLD, DocNumber: 'LS-1',
      Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 50, AccountBasedExpenseLineDetail: { AccountRef: { value: T.seed.accounts.materials.Id }, TaxCodeRef: { value: T.seed.taxCodes.gst.Id }, CustomerRef: { value: cust } } }],
    });
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: cust }, TxnDate: OLD, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: (await link(T, 'invoices', 'inv-l')).qbo_id, TxnType: 'Invoice' }] }] });
    const sale = { DetailType: 'SalesItemLineDetail', Amount: 200, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 200, TaxCodeRef: { value: T.seed.taxCodes.gstPst.Id } } };
    const late = fake.create(T.realmId, 'Invoice', { CustomerRef: { value: cust }, DocNumber: 'Q-3602', TxnDate: OLD, Line: [sale] });
    // History QuickBooks itself closed (its BookCloseDate) is imported whatever Fishtape's close (2.6).
    const qboClosed = daysBefore(TODAY, 45);
    await t.superPool.query("UPDATE qbo_connections SET features = features || jsonb_build_object('bookCloseDate', $2::text) WHERE tenant_id = $1", [T.tenantId, qboClosed]);
    fake.create(T.realmId, 'Invoice', { CustomerRef: { value: cust }, DocNumber: 'Q-3603', TxnDate: daysBefore(TODAY, 50), Line: [sale] });
    await pass(T);
    const history = (await t.superPool.query("SELECT id FROM invoices WHERE tenant_id = $1 AND data->>'number' = 'Q-3603'", [T.tenantId])).rows[0];
    assert.ok(history, 'dated on or before QuickBooks\' own close: created');
    assert.equal((await link(T, 'invoices', history.id)).state, 'synced');
    const bill = (await t.superPool.query("SELECT data FROM bills WHERE tenant_id = $1 AND data->>'number' = 'LS-1'", [T.tenantId])).rows[0]?.data;
    assert.ok(bill, 'the late bill is accepted');
    assert.equal(bill.date, OLD, 'the supplier date is kept');
    assert.equal(bill.late, true);
    assert.ok(bill.postedOn > CLOSED, 'posted on the first open day');
    const pay = (await t.superPool.query("SELECT data FROM payments WHERE tenant_id = $1 AND data->>'invoiceId' = 'inv-l' AND coalesce(data->>'method', '') <> 'credit'", [T.tenantId])).rows[0]?.data;
    assert.equal(pay?.late, true);
    // A sent invoice dated in the closed period (after QuickBooks' own close date) is not created yet.
    const ll = (await t.superPool.query("SELECT * FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = 'Invoice' AND qbo_id = $2", [T.tenantId, String(late.Id)])).rows[0];
    assert.equal(`${ll.state}/${ll.reason}`, 'needs_review/period_locked');
    assert.equal(await rec(T, 'invoices', ll.record_id), null);
    const review = await reviewOf(T, ll.record_id);
    await closeBooks(T, null);
    await resolve(T, review.id, { choice: 'quickbooks' });
    const made = await rec(T, 'invoices', ll.record_id);
    assert.equal(made?.number, 'Q-3602', 'created once the period is reopened');
    assert.equal((await link(T, 'invoices', ll.record_id)).state, 'synced');
  });

  test('QuickBooks numbering: an invoice from before the close is pushed after it and takes QuickBooks\' number', async () => {
    const T = await setupTenant('Number Electric', { options: { numbering: 'quickbooks' } });
    await create(T, 'clients', { id: 'c-nb', name: 'Numbered Client' });
    await pass(T);
    await create(T, 'invoices', invoice({ id: 'inv-nb', number: 'INV-3701', clientId: 'c-nb', issueDate: OLD, dueDate: OLD }));
    await t.superPool.query('DELETE FROM qbo_outbox WHERE tenant_id = $1', [T.tenantId]);
    await closeBooks(T, CLOSED);
    // QuickBooks numbers the document itself (the fake keeps what it is sent, so number it here).
    const client = createQboClient({ db: t.db, sealer, config, tenantId: T.tenantId, purpose: 'sync' });
    const createReal = client.create.bind(client);
    client.create = async (entity, body, o) => {
      const made = await createReal(entity, body, o);
      return entity === 'Invoice' ? fake.edit(T.realmId, 'Invoice', made.Id, { DocNumber: '1077' }) : made;
    };
    const state = await withLeaseDo(T, (epoch) => pushRecord({ ...deps, client }, T.tenantId, 'invoices', 'inv-nb', { epoch }));
    assert.equal(state, 'synced');
    assert.equal((await rec(T, 'invoices', 'inv-nb')).number, '1077', 'number is lock-safe for the QuickBooks push');
  });

  test('payroll: hours on or before the payroll export are held, and an entry in an exported run is locked', async () => {
    const T = await setupTenant('Payroll Electric');
    await create(T, 'clients', { id: 'c-pr', name: 'Payroll Client' });
    await create(T, 'jobs', { id: 'j-pr', number: 'J-9', title: 'Shop', clientId: 'c-pr' });
    const emp = fake.create(T.realmId, 'Employee', { GivenName: 'Pat', FamilyName: 'Volt', DisplayName: 'Pat Volt' });
    await create(T, 'employees', { id: 'e-pr', name: 'Pat Volt' });
    const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
    await t.superPool.query("INSERT INTO qbo_links (tenant_id, realm_hash, collection, record_id, qbo_entity, qbo_id, state, owner) VALUES ($1, $2, 'employees', 'e-pr', 'Employee', $3, 'synced', 'quickbooks')", [T.tenantId, rows[0].realm_hash, emp.Id]);
    const day = daysBefore(TODAY, 3);
    await create(T, 'timeEntries', { id: 'te-1', employeeId: 'e-pr', jobId: 'j-pr', clockIn: `${day}T15:00:00.000Z`, clockOut: `${day}T20:00:00.000Z`, approved: true, note: 'Shop' });
    await pass(T);
    assert.equal((await link(T, 'timeEntries', 'te-1')).state, 'synced');
    // A payroll run took te-1 and exported through `day` (settings.closing, written by Books).
    await t.superPool.query(`INSERT INTO payroll_runs (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'run-1', $2, 'test', 'test')`,
      [T.tenantId, { from: daysBefore(day, 6), to: day, format: 'generic', employeeIds: ['e-pr'], entryIds: ['te-1'], lateEntryIds: [], status: 'exported', exportedAt: new Date().toISOString() }]);
    await t.superPool.query("UPDATE settings SET data = jsonb_set(data, '{closing}', $2::jsonb) WHERE tenant_id = $1 AND id = 'settings'", [T.tenantId, JSON.stringify({ payrollThrough: day })]);
    // Late hours on that day (in no run): held for QuickBooks payroll, whatever the mapping option says.
    await create(T, 'timeEntries', { id: 'te-2', employeeId: 'e-pr', jobId: 'j-pr', clockIn: `${day}T21:00:00.000Z`, clockOut: `${day}T22:00:00.000Z`, approved: true, note: 'Late' });
    await pass(T);
    assert.equal(`${(await link(T, 'timeEntries', 'te-2')).state}/${(await link(T, 'timeEntries', 'te-2')).reason}`, 'needs_review/payroll_locked');
    // An entry in an exported run changed underneath (a correction made directly): never pushed.
    await t.superPool.query("UPDATE time_entries SET data = jsonb_set(data, '{note}', '\"Shop and stores\"') WHERE tenant_id = $1 AND id = 'te-1'", [T.tenantId]);
    await sendNow(T, 'timeEntries', 'te-1');
    assert.equal(`${(await link(T, 'timeEntries', 'te-1')).state}/${(await link(T, 'timeEntries', 'te-1')).reason}`, 'needs_review/payroll_locked');
  });
});

describe('estimates (9.5)', { skip }, () => {
  test('a signed estimate goes Accepted; once a revision supersedes it, Closed', async () => {
    const T = await setupTenant('Estimate Electric');
    await create(T, 'clients', { id: 'c-es', name: 'Estimate Client' });
    const est = { number: 'E-2001', clientId: 'c-es', status: 'accepted', issueDate: TODAY, validUntil: TODAY, taxProvince: 'MB', taxTreatment: 'pst-all', taxes: MB_TAX(), taxPct: 12, lines: [{ description: 'Service upgrade', qty: 1, unitCents: 250000, kind: 'labour' }] };
    await create(T, 'estimates', { ...est, id: 'est-1' });
    await pass(T);
    const l = await link(T, 'estimates', 'est-1');
    assert.equal(l.state, 'synced', l.last_error);
    assert.equal(fake.get(T.realmId, 'Estimate', l.qbo_id).TxnStatus, 'Accepted');
    await patch(T, 'estimates', 'est-1', { status: 'superseded' });
    await pass(T);
    assert.equal(fake.get(T.realmId, 'Estimate', l.qbo_id).TxnStatus, 'Closed');
    assert.equal((await rec(T, 'estimates', 'est-1')).status, 'superseded', 'a pull of Closed keeps superseded');
    fake.edit(T.realmId, 'Estimate', l.qbo_id, { CustomerMemo: { value: 'Replaced by E-2002' } });
    await pass(T);
    assert.equal((await rec(T, 'estimates', 'est-1')).status, 'superseded');
  });
});

describe('exemption (9.7)', { skip }, () => {
  test('a pulled Manitoba invoice with RST off and no evidence waits in review; adding it on the job clears it', async () => {
    const T = await setupTenant('Exempt Electric');
    await create(T, 'clients', { id: 'c-ex', name: 'Subtrade GC' });
    await create(T, 'jobs', { id: 'j-ex', number: 'J-77', title: 'Clinic fit-out', clientId: 'c-ex' });
    await create(T, 'invoices', invoice({ id: 'inv-ex0', number: 'INV-3801', clientId: 'c-ex', jobId: 'j-ex' }));
    await pass(T);
    const sub = (await link(T, 'jobs', 'j-ex'))?.qbo_id;
    assert.ok(sub, 'the job is a sub-customer');
    const sale = { DetailType: 'SalesItemLineDetail', Amount: 500, SalesItemLineDetail: { ItemRef: { value: T.seed.items.labour.Id }, Qty: 1, UnitPrice: 500, TaxCodeRef: { value: T.seed.taxCodes.gst.Id } } };
    fake.create(T.realmId, 'Invoice', { CustomerRef: { value: sub }, DocNumber: 'Q-3802', TxnDate: TODAY, Line: [sale] });
    await pass(T);
    const pulled = (await t.superPool.query("SELECT id, data FROM invoices WHERE tenant_id = $1 AND data->>'number' = 'Q-3802'", [T.tenantId])).rows[0];
    assert.equal(pulled.data.jobId, 'j-ex');
    assert.equal(pulled.data.taxTreatment, 'gst-only');
    const l = await link(T, 'invoices', pulled.id);
    assert.equal(`${l.state}/${l.reason}`, 'needs_review/exemption_missing');
    const review = await reviewOf(T, pulled.id);
    assert.match(review.fields[0].fishtape, /RST number on the job/);
    await assert.rejects(resolve(T, review.id, { choice: 'fishtape' }), (e) => e.code === 'exemption_required');
    await patch(T, 'jobs', 'j-ex', { taxExempt: { basis: 'subtrade', number: '1234567', confirmedBy: 'Owner', confirmedAt: new Date().toISOString() } });
    await resolve(T, review.id, { choice: 'fishtape' });
    assert.equal((await link(T, 'invoices', pulled.id)).state, 'synced');
    const inv = await rec(T, 'invoices', pulled.id);
    assert.equal(inv.taxExemptBasis, 'subtrade');
    assert.equal(inv.taxExemptNumber, '1234567');
  });
});

// ---- the mapping, without a database (9.1 to 9.3, 9.7) ---------------------------------------------

describe('Release 1 mapping, pure', () => {
  const LINKS = { clients: { 'c-1': '58' }, invoices: { 'inv-1': '201', 'cn-1': '301' }, vendors: { 'v-1': '701' } };
  const ITEMS = { material: '1', labour: '2', other: '1', holdback: '5', deposit: '6', interest: '7' };
  const CODES = { 'GST+RST|MB': '10', GST: '11', 'NONE|EXEMPT': '12', 'NONE|OOS': '13' };
  const pureCtx = (collection, { link = {}, mappings = {}, vendor = null } = {}) => ({
    collection, features: { salesTax: true, customTxnNumbers: true }, company: { province: 'MB', zone: 'America/Winnipeg' }, now: '2026-10-20T15:00:00Z',
    mappings: {
      item: ITEMS, taxCode: CODES, purchaseTaxCode: { 'GST+RST|MB': '11', GST: '11', NONE: '12' },
      account: { 'jobCost.material': '71', 'jobCost.other': '72', rstRecoverable: '90' }, paymentMethod: {}, option: {}, ...mappings,
    },
    refs: {
      qboIdFor: (c, id) => LINKS[c]?.[id] ?? null,
      fishtapeIdFor: (c, q) => Object.entries(LINKS[c] || {}).find(([, v]) => v === String(q))?.[0] ?? null,
      vendor: () => vendor,
    },
    link: { role: 'main', ...link, meta: { ...(link.meta || {}) } },
  });
  const doc = (o = {}) => ({ id: 'inv-1', number: 'INV-1', clientId: 'c-1', issueDate: '2026-10-15', status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all', taxes: MB_TAX(), lines: [], ...o });

  test('per-line tax keys: taxOff, special lines and the holdback line', () => {
    const d = doc({ lines: [
      { description: 'Labour', qty: 1, unitCents: 100000, kind: 'labour' },
      { description: 'Hotel', qty: 1, unitCents: 15000, kind: 'other', passThrough: true, taxOff: ['RST'] },
      { description: 'Less security deposit', qty: 1, unitCents: -20000, kind: 'other', lineType: 'deposit', taxOff: ['*'] },
    ], holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: true } });
    assert.equal(lineTaxKey(d, d.lines[0]), 'GST+RST|MB');
    assert.equal(lineTaxKey(d, d.lines[1]), 'GST', 'a pass-through line on a Manitoba invoice');
    assert.equal(lineTaxKey(d, d.lines[2]), 'NONE|OOS', 'a security-deposit line');
    assert.equal(lineTaxKey(d, 'labour'), 'GST+RST|MB', 'the per-kind key still answers');
    assert.equal(lineTaxKey(doc({ taxes: [], taxTreatment: 'none' }), { kind: 'other', lineType: 'interest' }), 'NONE|EXEMPT');
    assert.equal(holdbackTaxKey(d), 'GST+RST|MB');
    assert.equal(holdbackTaxKey({ ...d, holdback: { pct: 10, deferTaxIds: ['GST'] } }), 'GST');
    assert.deepEqual(docTaxLines(d).map((x) => [x.key, x.cents]), [['GST+RST|MB', 100000], ['GST', 15000], ['NONE|OOS', -20000], ['GST+RST|MB', -10000]]);
    assert.equal(needsTaxReason(d), false);
    assert.equal(needsTaxReason(doc({ taxes: [], taxTreatment: 'none', lines: [{ qty: 1, unitCents: 100, kind: 'labour' }] })), true);
    // The pre-push check sums each rate over the lines whose code carries it.
    const ref = {
      codes: [{ Id: '10', Name: 'GST/PST MB', SalesTaxRateList: ['1', '2'] }, { Id: '11', Name: 'GST', SalesTaxRateList: ['1'] }, { Id: '13', Name: 'OOS', SalesTaxRateList: [] }],
      rates: [{ Id: '1', Name: 'GST', RateValue: 5 }, { Id: '2', Name: 'PST (MB)', RateValue: 7 }],
    };
    const e = expectedTax(d, CODES, ref, '2026-10-15');
    assert.equal(e.ok, true, JSON.stringify(e.mismatch));
    assert.deepEqual(e.perRate.map((r) => [r.rateId, r.baseCents]), [['1', 105000], ['2', 90000]]);
  });

  test('a document goes out with special items and per-line codes, and a holdback line', () => {
    const d = doc({ kind: 'progress', lines: [{ description: 'Rough-in', qty: 1, unitCents: 100000, kind: 'labour' }], holdback: { pct: 10, deferTaxIds: ['GST', 'RST'] } });
    const L = fishtapeToCanon('invoices', d, pureCtx('invoices'));
    assert.deepEqual(L.lines.map((l) => [l.itemRef, l.amountCents, l.taxCodeId, Boolean(l.holdback)]), [['2', 100000, '10', false], ['5', -10000, '10', true]]);
    const body = canonToQbo('invoices', L, pureCtx('invoices', { link: { meta: { marker: 'Fishtape ref 0123456789ab' } } })).body;
    assert.deepEqual(body.Line.map((l) => [l.Amount, l.SalesItemLineDetail.ItemRef.value]), [[1000, '2'], [-100, '5']]);
    const dep = fishtapeToCanon('invoices', doc({ kind: 'deposit', lines: [{ description: 'Deposit', qty: 1, unitCents: 50000, kind: 'other', lineType: 'deposit' }] }), pureCtx('invoices', { mappings: { item: { ...ITEMS, deposit: undefined } } }));
    assert.equal(dep.lines[0].itemRef, null, 'no deposit item: never the `other` income item');
  });

  test('a credit note is a CreditMemo with positive amounts and the bad-debt memo; read back it compares equal', () => {
    const note = creditNoteFrom(doc({ lines: [{ description: 'Labour', qty: 2, unitCents: 9500, kind: 'labour' }] }), { reason: 'bad_debt', today: '2026-10-20', number: 'CR-1001' });
    const n = { ...note, id: 'cn-1', status: 'sent' };
    const c = pureCtx('invoices', { link: { meta: { marker: 'Fishtape ref 0123456789ab' } } });
    const L = fishtapeToCanon('invoices', n, c);
    assert.equal(entityFor('invoices', L), 'CreditMemo');
    assert.equal(L.dueDate, null);
    const out = canonToQbo('invoices', L, c);
    assert.equal(out.entity, 'CreditMemo');
    assert.ok(out.body.Line.every((l) => l.Amount > 0));
    assert.equal(out.body.DueDate, undefined);
    assert.equal(out.body.PrivateNote, `Fishtape ref 0123456789ab · ${n.title} · Bad debt write-off`);
    const created = { ...out.body, Id: '301', SyncToken: '0', TotalAmt: 212.8, Line: out.body.Line.map((l, i) => ({ ...l, Id: String(i + 1) })) };
    const R = qboToCanon('CreditMemo', created, c);
    assert.equal(R.extra.kind, 'credit');
    assert.equal(R.extra.badDebt, true);
    for (const f of ['number', 'clientRef', 'date', 'lines', 'status', 'dueDate', 'title']) assert.ok(canonEqual('invoices', f, L[f], R[f]), f);
    assert.equal(R.extra.totalCents, -21280);
  });

  test('a supplier credit is a VendorCredit; resale RST goes to the recoverable account; a pull reads it back as RST', () => {
    // spreadPurchaseTax: resale shares out, own-use shares in, written-off resale back in.
    const s = spreadPurchaseTax([{ amountCents: 9000, use: 'r' }, { amountCents: 1000, use: 'o' }, { amountCents: 10000, use: 'r', resaleCreditWrittenOff: { by: 'x', at: 'y' } }],
      [{ id: 'GST', cents: 1000 }, { id: 'RST', cents: 1400 }], undefined, { taxUse: (l) => (l.use === 'r' ? 'resale' : 'own-use') });
    assert.deepEqual(s.lines.map((l) => l.amountCents), [9000, 1070, 10700]);
    assert.equal(s.resaleCents, 630);
    assert.deepEqual(s.taxes, [{ id: 'GST', cents: 1000 }]);
    assert.equal(fallbackBillLineTaxUse({ costType: 'material' }), 'resale');
    assert.equal(fallbackBillLineTaxUse({ costType: 'subcontract' }, { vendor: { meSubtrade: true } }), 'resale');
    assert.equal(fallbackBillLineTaxUse({ costType: 'subcontract' }), 'own-use');
    assert.equal(fallbackBillLineTaxUse({ costType: 'material', taxUse: 'own-use' }), 'own-use');
    // A supplier credit (negative lines, RST charged on resale material).
    const credit = { id: 'b-c', kind: 'bill', vendorId: 'v-1', number: 'CR-77', date: '2026-10-15', dueDate: '2026-11-15', taxProvince: 'MB',
      lines: [{ description: 'Returned wire', qty: 1, unitCents: -10000, amountCents: -10000, costType: 'material' }],
      taxes: [{ id: 'GST', cents: -500 }, { id: 'RST', cents: -700 }], totalCents: -11200 };
    const c = pureCtx('bills', { link: { meta: { marker: 'Fishtape ref 0123456789ab' } } });
    const L = fishtapeToCanon('bills', credit, c);
    assert.equal(entityFor('bills', L), 'VendorCredit');
    assert.equal(entityFor('bills', credit), 'VendorCredit');
    assert.equal(purchaseSign(L), -1);
    assert.equal(L.dueDate, null);
    assert.deepEqual(L.lines.map((l) => [l.accountRef, l.amountCents]), [['71', -10000], ['90', -700]]);
    const out = canonToQbo('bills', L, c);
    assert.equal(out.entity, 'VendorCredit');
    assert.deepEqual(out.body.Line.map((l) => l.Amount), [100, 7]);
    assert.equal(out.body.DueDate, undefined);
    const back = { ...out.body, Id: '901', SyncToken: '0', TotalAmt: 112, TxnTaxDetail: { TotalTax: 5, TaxLine: [{ Amount: 5, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '1' }, TaxPercent: 5 } }] }, Line: out.body.Line.map((l, i) => ({ ...l, Id: String(i + 1) })) };
    const R = qboToCanon('VendorCredit', back, { ...c, rates: { codes: [], rates: [{ Id: '1', Name: 'GST', RateValue: 5 }] } });
    assert.ok(canonEqual('bills', 'lines', L.lines, R.lines));
    assert.ok(canonEqual('bills', 'taxes', L.taxes, R.taxes));
    const p = canonToFishtape('bills', R, c, { existing: null });
    assert.deepEqual(p.lines.map((l) => l.amountCents), [-10000]);
    assert.deepEqual(p.taxes.map((x) => [x.id, x.cents]).sort(), [['GST', -500], ['RST', -700]]);
    assert.equal(p.totalCents, -11200);
  });

  test('a pulled line with fewer taxes than its kind gets taxOff; the holdback line becomes the holdback', () => {
    const c = pureCtx('invoices');
    const head = { number: 'Q-1', clientRef: '58', jobRef: null, date: '2026-10-15', status: 'open', notes: null, title: null, dueDate: null, estimateRef: null, extra: {} };
    const R = {
      ...head,
      lines: [
        { itemRef: '2', kind: 'labour', description: 'Work', amountCents: 100000, taxCodeId: '10', qty: 1, unitCents: 100000, lineId: '1' },
        { itemRef: '1', kind: 'other', description: 'Permit', amountCents: 5000, taxCodeId: '10', qty: 1, unitCents: 5000, lineId: '2' },
        { itemRef: '1', kind: 'other', description: 'Hotel', amountCents: 15000, taxCodeId: '11', qty: 1, unitCents: 15000, lineId: '3' },
      ],
    };
    const report = {};
    const p = canonToFishtape('invoices', R, c, { existing: null, report });
    assert.equal(report.taxShape, false);
    assert.deepEqual(p.lines.map((l) => l.taxOff || null), [null, null, ['RST']]);
    assert.equal(p.taxTreatment, 'pst-all', 'the kind keeps the widest key; the line says what is off');
    assert.equal(docTotals({ ...p, taxProvince: 'MB' }).totalCents, 120000 + 6000 + 7350);
    // The holdback line: the invoice's holdback, deferred from the taxes of its code.
    const H = {
      ...head,
      lines: [
        { itemRef: '2', kind: 'labour', description: 'Work', amountCents: 100000, taxCodeId: '10', qty: 1, unitCents: 100000, lineId: '1' },
        { itemRef: '5', kind: 'other', description: 'Holdback retained', amountCents: -10000, taxCodeId: '10', qty: 1, unitCents: -10000, lineId: '3', holdback: true },
      ],
    };
    const h = canonToFishtape('invoices', H, c, { existing: null, report: {} });
    assert.deepEqual(h.lines.length, 1);
    assert.deepEqual(h.holdback, { pct: null, excludePassThrough: true, cents: 10000, deferTaxIds: ['GST', 'RST'] });
    assert.equal(docTotals({ ...h, taxProvince: 'MB' }).totalCents, 90000 + 4500 + 6300);
    // A material line can't turn a tax off: that shape still goes to review.
    const bad = { ...R, lines: [{ ...R.lines[0], kind: 'material', itemRef: '1' }, { ...R.lines[0], kind: 'material', itemRef: '1', taxCodeId: '11', lineId: '4' }] };
    const r2 = {};
    canonToFishtape('invoices', bad, c, { existing: null, report: r2 });
    assert.equal(r2.taxShape, true);
  });

  test('settlement leaves out applied memos; the 9.7 review; payments never sent', () => {
    assert.equal(settlementCents({ TotalAmt: 1120, Balance: 0 }, [], [112000]), 0);
    assert.equal(settlementCents({ TotalAmt: 1120, Balance: 0 }, [50000], [30000]), 32000);
    assert.equal(settlementCents({ TotalAmt: 1120, Balance: 0 }, [50000]), 62000, 'the old two-argument form');
    const gstOnly = doc({ taxTreatment: 'gst-only', taxes: taxComponents({ province: 'MB', treatment: 'gst-only' }), lines: [{ qty: 1, unitCents: 50000, kind: 'labour' }] });
    assert.equal(pulledInvoiceProblem(gstOnly)?.reason, 'exemption_missing');
    assert.equal(pulledInvoiceProblem(gstOnly, { job: { taxExempt: { basis: 'subtrade', number: '1234567' } } }), null, "the job's exemption counts");
    assert.equal(pulledInvoiceProblem({ ...gstOnly, status: 'draft' }), null);
    assert.equal(pulledInvoiceProblem(doc({ lines: [{ qty: 1, unitCents: 100, kind: 'labour', taxOff: ['RST'] }, { qty: 1, unitCents: 100, kind: 'labour' }] }))?.reason, 'tax_off_invalid');
    assert.equal(pulledInvoiceProblem(doc({ kind: 'deposit', lines: [{ qty: 1, unitCents: 100, kind: 'other', lineType: 'deposit' }], holdback: { pct: 10 } }))?.reason, 'holdback_invalid');
    assert.equal(neverPushed({ invoiceId: null, clientId: 'c' }).reason, 'on_account');
    assert.equal(neverPushed({ invoiceId: 'i', appliedFromId: 'p' }).reason, 'on_account');
    assert.equal(neverPushed({ invoiceId: 'i', method: 'refund', amountCents: -1 }).reason, 'refund');
    assert.equal(neverPushed({ invoiceId: 'i', reversesId: 'p', amountCents: -1 }).reason, 'reversal');
    assert.equal(neverPushed({ invoiceId: 'i', amountCents: 100, receiptId: 'r' }), null, 'a receipt allocation is sent as its own payment');
  });
});
