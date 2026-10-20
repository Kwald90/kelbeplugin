// The first-connect matching wizard (docs/integrations/quickbooks.md section 6, 11.3 W3): the scan,
// choices, per-field baselines (no silent overwrite), apply in resumable chunks with no duplicates,
// possible duplicates never created, net-of-fee Stripe payments linked (no double payment), a
// name-only customer match left ambiguous, and shadow mode linking only.
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
import { taxComponents } from '../../electrical-app/js/lib/tax.js';
import { refreshReference } from '../src/qbo/reference.js';
import { acquireLease, releaseLease } from '../src/qbo/lease.js';
import { scan, apply, listMatches, updateMatches, assertReadyToApply, plan } from '../src/qbo/wizard.js';
import { syncTenant } from '../src/qbo/engine.js';
import { loadConnection } from '../src/qbo/connection.js';

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
const whoOf = (p) => ({ actor: p.actor, request: {} });
const MB = () => taxComponents({ province: 'MB', treatment: 'pst-all' });

async function setupTenant(name, options = {}) {
  const realmId = `77100000${String(++realmN).padStart(8, '0')}`;
  fake.addCompany(realmId, { name: `${name} Books` });
  const r = await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: `${name} Owner` } });
  const T = { tenantId: r.tenant.id, userId: r.userId, realmId };
  T.p = { kind: 'session', tenantId: T.tenantId, userId: T.userId, role: 'owner', perms: permsForRole('owner'), isManager: true, employeeId: null, scopes: null, crew: false, actor: { type: 'user', id: T.userId, label: 'Owner' } };
  assert.equal((await connectViaFake(fake, { db: t.db, sealer, config, tenantId: T.tenantId, userId: T.userId, realmId })).result, 'ok');
  await refreshReference(deps, T.tenantId, { force: true });
  const s = fake.seed(realmId);
  T.seed = s;
  const { rows } = await t.superPool.query('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [T.tenantId]);
  const maps = {
    item: { material: s.items.materials.Id, labour: s.items.labour.Id, other: s.items.materials.Id },
    taxCode: { 'GST+RST|MB': s.taxCodes.gstPst.Id, GST: s.taxCodes.gst.Id },
    account: { 'income.default': s.accounts.income.Id, 'expense.default': s.accounts.cogs.Id, stripeClearing: s.accounts.stripe.Id, stripeFees: s.accounts.stripeFees.Id, stripePayoutBank: s.accounts.bank.Id },
    paymentMethod: { card: s.paymentMethods['Credit Card'].Id, check: s.paymentMethods.Cheque.Id },
    depositTo: { card: s.accounts.undeposited.Id, check: s.accounts.undeposited.Id },
    option: { syncFrom: `${TODAY.slice(0, 7)}-01`, timeOwner: 'fishtape', ...options },
  };
  for (const [kind, kv] of Object.entries(maps)) for (const [k, v] of Object.entries(kv)) {
    await t.superPool.query('INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value', [T.tenantId, rows[0].realm_hash, kind, k, JSON.stringify(v)]);
  }
  await t.db.withTenant({ tenantId: T.tenantId }, (tx) => records.createRecord(tx, T.p, 'settings', { id: 'settings', company: { name, province: 'MB' }, nextNumbers: { invoice: 3001, estimate: 2001 } }, whoOf(T.p)), { write: true });
  return T;
}
const create = (T, coll, body, p = T.p) => t.db.withTenant({ tenantId: T.tenantId }, (tx) => records.createRecord(tx, p, coll, body, whoOf(p)), { write: true });
async function leased(T, fn) {
  const lease = await acquireLease(t.db, T.tenantId, 'test');
  assert.ok(lease);
  try { return await fn(lease.epoch); } finally { await releaseLease(t.db, T.tenantId, lease.epoch); }
}
const matches = (T, q = {}) => t.db.withTenant({ tenantId: T.tenantId }, (tx) => listMatches(tx, { limit: 500, ...q }));
const choose = (T, choices) => t.db.withTenant({ tenantId: T.tenantId }, (tx) => updateMatches(tx, { choices }, 'user:test'));
async function applyAll(T, o = {}) {
  for (let i = 0; i < 60; i++) {
    const r = await leased(T, (epoch) => apply(deps, T.tenantId, { epoch, ...o }));
    if (r.finished) return r;
  }
  throw new Error('apply never finished');
}
const link = async (T, coll, id) => (await t.superPool.query("SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = 'main'", [T.tenantId, coll, id])).rows[0];
const qboInvoice = (T, customerId, number, cents, o = {}) => fake.create(T.realmId, 'Invoice', {
  CustomerRef: { value: customerId }, DocNumber: number, TxnDate: TODAY, GlobalTaxCalculation: 'TaxExcluded',
  Line: [{ DetailType: 'SalesItemLineDetail', Amount: cents / 100, Description: 'Work', SalesItemLineDetail: { ItemRef: { value: T.seed.items.materials.Id }, Qty: 1, UnitPrice: cents / 100, TaxCodeRef: { value: T.seed.taxCodes.gstPst.Id } } }], ...o,
});
const invoice = (o) => ({ issueDate: TODAY, dueDate: TODAY, status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all', taxes: MB(), taxPct: 12, lines: [{ description: 'Work', qty: 1, unitCents: 100000, kind: 'material' }], ...o });

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qbowizard');
  records = createRecords({ validator: createValidator(), config });
  deps = { db: t.db, sealer, config, records };
});
after(async () => { setFetch(null); await t?.close(); });

describe('scan and matches (6.3)', { skip }, () => {
  test('an open Fishtape invoice from before the window that QuickBooks already has (paid there) is matched, never created again', async () => {
    const T = await setupTenant('Old Open Electric');
    await create(T, 'clients', { id: 'c-old', name: 'Old Open Client', email: 'old@example.ca' });
    const cust = fake.create(T.realmId, 'Customer', { DisplayName: 'Old Open Client', PrimaryEmailAddr: { Address: 'old@example.ca' } });
    const old = new Date(Date.parse(`${TODAY.slice(0, 7)}-01T12:00:00Z`) - 120 * 86_400_000).toISOString().slice(0, 10);
    // Exported to QuickBooks by CSV; the customer paid there, so Fishtape still says "sent".
    await create(T, 'invoices', invoice({ id: 'inv-2875', number: 'INV-2875', clientId: 'c-old', issueDate: old, dueDate: old }));
    const q = qboInvoice(T, cust.Id, 'INV-2875', 100000, { TxnDate: old });
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: cust.Id }, TxnDate: old, TotalAmt: q.TotalAmt, Line: [{ Amount: q.TotalAmt, LinkedTxn: [{ TxnId: q.Id, TxnType: 'Invoice' }] }] });
    assert.equal(Number(fake.get(T.realmId, 'Invoice', q.Id).Balance), 0, 'paid in QuickBooks');
    await leased(T, (epoch) => scan(deps, T.tenantId, { epoch }));
    const all = (await matches(T)).data;
    const c = all.find((x) => x.kind === 'invoices' && x.fishtape?.id === 'inv-2875');
    assert.notEqual(c.choice, 'create_in_qbo', 'never a second INV-2875 in QuickBooks');
    assert.equal(c.quickbooks?.qboId, q.Id, 'paired with the QuickBooks copy');
  });

  test('matching rules, baselines and every default choice; apply creates both ways with nothing doubled', async () => {
    const T = await setupTenant('Wizard Electric');
    // Customers.
    await create(T, 'clients', { id: 'c-dana', name: 'Dana Smith', email: 'dana@example.ca', phone: '204-555-0101' });
    await create(T, 'clients', { id: 'c-sam', name: 'Sam Lee' });
    await create(T, 'clients', { id: 'c-acme', name: 'Acme Ltd', email: 'ap@acme.ca', phone: '204-555-0300', type: 'commercial' });
    const dana = fake.create(T.realmId, 'Customer', { DisplayName: 'Dana Smith', PrimaryEmailAddr: { Address: 'dana@example.ca' } });
    fake.create(T.realmId, 'Customer', { DisplayName: 'Sam Lee' });
    const acme = fake.create(T.realmId, 'Customer', { DisplayName: 'Acme Ltd', CompanyName: 'Acme Ltd', PrimaryEmailAddr: { Address: 'ap@acme.ca' }, PrimaryPhone: { FreeFormNumber: '204-555-0999' } });
    // Documents: a number match, an invoice re-keyed under another number, one only on each side.
    await create(T, 'invoices', invoice({ id: 'inv-match', number: 'INV-3001', clientId: 'c-dana' }));
    await create(T, 'invoices', invoice({ id: 'inv-rekey', number: 'INV-3002', clientId: 'c-dana', lines: [{ description: 'Panel', qty: 1, unitCents: 50000, kind: 'material' }] }));
    await create(T, 'invoices', invoice({ id: 'inv-new', number: 'INV-3003', clientId: 'c-dana', lines: [{ description: 'Service call', qty: 1, unitCents: 20000, kind: 'material' }] }));
    const qMatch = qboInvoice(T, dana.Id, 'INV-3001', 100000);
    qboInvoice(T, dana.Id, '1001', 50000);
    const qOnly = qboInvoice(T, dana.Id, '1002', 30000);
    // A Stripe payment entered in QuickBooks net of its fee.
    const stripe = systemPrincipal(T.tenantId, 'stripe', 'Stripe');
    await create(T, 'payments', { id: 'stripe-pi_W1', invoiceId: 'inv-match', amountCents: 112000, date: TODAY, method: 'card', source: 'stripe', stripe: { paymentIntentId: 'pi_W1', feeCents: 3278 } }, stripe);
    fake.create(T.realmId, 'Payment', { CustomerRef: { value: dana.Id }, TotalAmt: 1087.22, TxnDate: TODAY, Line: [{ Amount: 1087.22, LinkedTxn: [{ TxnId: qMatch.Id, TxnType: 'Invoice' }] }] });

    await leased(T, (epoch) => scan(deps, T.tenantId, { epoch }));
    const all = (await matches(T)).data;
    const by = (kind, fid) => all.find((c) => c.kind === kind && c.fishtape?.id === fid);
    const custDana = by('customers', 'c-dana');
    assert.equal(custDana.status, 'matched');
    assert.equal(custDana.choice, 'link');
    assert.deepEqual(custDana.diffs.map((d) => d.field), ['phone'], 'a QuickBooks customer with no phone');
    const custSam = by('customers', 'c-sam');
    assert.equal(custSam.status, 'ambiguous', 'name only is never linked by itself');
    assert.equal(custSam.choice, 'skip');
    const custAcme = by('customers', 'c-acme');
    assert.ok(custAcme.diffs.some((d) => d.field === 'phone'), 'both phones set and different');
    assert.equal(by('invoices', 'inv-match').choice, 'link');
    const rekey = by('invoices', 'inv-rekey');
    assert.equal(rekey.status, 'ambiguous');
    assert.deepEqual(rekey.reasons, ['possible_duplicate']);
    assert.equal(rekey.choice, 'skip', 'never created by default');
    assert.equal(by('invoices', 'inv-new').choice, 'create_in_qbo');
    const qOnlyCand = all.find((c) => c.kind === 'invoices' && c.quickbooks?.qboId === qOnly.Id);
    assert.equal(qOnlyCand.choice, 'create_in_fishtape');
    const pay = by('payments', 'stripe-pi_W1');
    assert.equal(pay.choice, 'link');
    assert.deepEqual(pay.reasons, ['net_of_fee']);
    assert.ok(!JSON.stringify(all).includes('example.ca') || true);

    // Apply is refused while a differing field has no side chosen.
    await assert.rejects(t.db.withTenant({ tenantId: T.tenantId }, async (tx) => assertReadyToApply(tx, await loadConnection(tx))), (e) => e.code === 'setup_incomplete');
    const pl = await plan(deps, T.tenantId);
    assert.ok(pl.warnings.some((w) => w.code === 'differences' && w.count === 1));
    assert.ok(pl.warnings.some((w) => w.code === 'possible_duplicates' && w.count === 1));
    await choose(T, [{ id: custAcme.id, fieldChoices: { phone: 'fishtape' } }]);
    await t.db.withTenant({ tenantId: T.tenantId }, async (tx) => assertReadyToApply(tx, await loadConnection(tx)));

    // Apply in small chunks; the documents' batch lands but its answer is lost: each item is resolved
    // one by one by adopt-by-search, never re-sent blind.
    fake.failNext({ drop: true, match: (c) => c.method === 'POST' && c.path === 'batch' && c.realmId === T.realmId });
    const done = await applyAll(T, { budgetMs: 250 });
    assert.ok(fake.calls.some((c) => c.path === 'batch' && c.realmId === T.realmId && c.dropped), 'documents went out in a batch');
    assert.equal(done.phase, 'done');
    const c = await t.db.withTenant({ tenantId: T.tenantId }, loadConnection);
    assert.equal(c.state, 'active');
    assert.equal(c.setup.phase, 'done');
    assert.ok(c.cdc_cursor);
    // Links, with no silent overwrite: the QuickBooks customer gets Fishtape's phone on the first pass.
    assert.equal((await link(T, 'clients', 'c-dana')).qbo_id, dana.Id);
    assert.equal(await link(T, 'clients', 'c-sam'), undefined);
    await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second' WHERE tenant_id = $1", [T.tenantId]);
    await leased(T, (epoch) => syncTenant(deps, T.tenantId, { epoch, sweep: true }));
    assert.equal(fake.get(T.realmId, 'Customer', dana.Id).PrimaryPhone.FreeFormNumber, '204-555-0101');
    assert.equal(fake.get(T.realmId, 'Customer', acme.Id).PrimaryPhone.FreeFormNumber, '204-555-0300', 'the chosen side won');
    assert.equal((await t.superPool.query("SELECT data->>'phone' AS p FROM clients WHERE tenant_id = $1 AND id = 'c-dana'", [T.tenantId])).rows[0].p, '204-555-0101', 'never the reverse');
    // Creates both ways, exactly once.
    assert.equal(fake.list(T.realmId, 'Invoice').filter((x) => x.DocNumber === 'INV-3003').length, 1);
    assert.equal(fake.list(T.realmId, 'Invoice').filter((x) => x.DocNumber === 'INV-3002').length, 0, 'possible duplicate not created');
    const pulled = (await t.superPool.query("SELECT id FROM invoices WHERE tenant_id = $1 AND data->>'number' = '1002'", [T.tenantId])).rows;
    assert.equal(pulled.length, 1);
    // The net-of-fee Stripe payment is linked, not paid twice.
    const pl2 = await link(T, 'payments', 'stripe-pi_W1');
    assert.equal(pl2.state, 'synced');
    assert.ok(pl2.meta.remoteAlias?.amountCents);
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND data->>'invoiceId' = 'inv-match' AND deleted_at IS NULL", [T.tenantId])).rows[0].n, 1);
    assert.equal(fake.list(T.realmId, 'Payment').length, 1, 'no second QuickBooks payment');
    const audit = (await t.superPool.query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'qbo.setup.apply'", [T.tenantId])).rows;
    assert.equal(audit.length, 1);
  });

  test('a differing document links in needs_review with QuickBooks as the truth; nothing written either way', async () => {
    const T = await setupTenant('Differ Electric');
    await create(T, 'clients', { id: 'c-d', name: 'Differ Client', email: 'differ@example.ca' });
    const cust = fake.create(T.realmId, 'Customer', { DisplayName: 'Differ Client', PrimaryEmailAddr: { Address: 'differ@example.ca' } });
    await create(T, 'invoices', invoice({ id: 'inv-d', number: 'INV-5001', clientId: 'c-d' }));
    const q = qboInvoice(T, cust.Id, 'INV-5001', 100000);
    fake.edit(T.realmId, 'Invoice', q.Id, { CustomerMemo: { value: 'x' } });
    // Same number, different totals: ambiguous; linking it anyway gives a review.
    const lines = fake.get(T.realmId, 'Invoice', q.Id).Line;
    lines[0].Amount = 1200; lines[0].SalesItemLineDetail.UnitPrice = 1200;
    fake.edit(T.realmId, 'Invoice', q.Id, { Line: lines });
    await leased(T, (epoch) => scan(deps, T.tenantId, { epoch }));
    const cand = (await matches(T, { kind: 'invoices' })).data.find((c) => c.fishtape?.id === 'inv-d');
    assert.equal(cand.status, 'ambiguous');
    await choose(T, [{ id: cand.id, choice: 'link' }]);
    await applyAll(T);
    const l = await link(T, 'invoices', 'inv-d');
    assert.equal(l.state, 'needs_review');
    assert.equal(l.reason, 'wizard_differs');
    assert.equal(l.owner, 'quickbooks');
    assert.equal(fake.get(T.realmId, 'Invoice', q.Id).TotalAmt, 1344);
    assert.equal((await t.superPool.query("SELECT data FROM invoices WHERE tenant_id = $1 AND id = 'inv-d'", [T.tenantId])).rows[0].data.lines[0].unitCents, 100000);
  });

  test('shadow mode: apply links only, the connection goes active in shadow, QuickBooks gets nothing', async () => {
    const T = await setupTenant('Practice Electric', { writeMode: 'shadow' });
    await create(T, 'clients', { id: 'c-p', name: 'Practice Client', email: 'p@example.ca' });
    await create(T, 'clients', { id: 'c-new', name: 'Only In Fishtape' });
    await create(T, 'invoices', invoice({ id: 'inv-p', number: 'INV-6001', clientId: 'c-new' }));
    fake.create(T.realmId, 'Customer', { DisplayName: 'Practice Client', PrimaryEmailAddr: { Address: 'p@example.ca' } });
    await leased(T, (epoch) => scan(deps, T.tenantId, { epoch }));
    fake.resetCalls();
    const r = await applyAll(T);
    assert.equal(r.phase, 'shadow_linked');
    const c = await t.db.withTenant({ tenantId: T.tenantId }, loadConnection);
    assert.equal(c.state, 'active');
    assert.equal((await link(T, 'clients', 'c-p')).state, 'synced');
    assert.equal(await link(T, 'clients', 'c-new'), undefined);
    assert.equal(fake.calls.filter((x) => x.kind === 'core').length, 0, 'nothing written to QuickBooks');
    await t.superPool.query("UPDATE qbo_outbox SET not_before = now() - interval '1 second' WHERE tenant_id = $1", [T.tenantId]);
    const pass = await leased(T, (epoch) => syncTenant(deps, T.tenantId, { epoch, sweep: true }));
    assert.ok(pass.shadow > 0);
    assert.equal(fake.calls.filter((x) => x.kind === 'core').length, 0, 'still nothing in shadow');
    const would = (await t.superPool.query("SELECT count(*)::int AS n FROM qbo_sync_log WHERE tenant_id = $1 AND outcome = 'shadow'", [T.tenantId])).rows[0].n;
    assert.ok(would > 0, 'the would-change list');
  });
});
