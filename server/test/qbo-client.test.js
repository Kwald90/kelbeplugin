// The QuickBooks client against the fake QuickBooks and a real Postgres (docs/integrations/quickbooks.md
// 5.8, 5.11, 11.3 W1): calls, SyncToken 5010, queries and CDC, batch and upload, usage counting,
// QBO_WRITES, 429 and throttled_until, 5xx, a 401 with one forced refresh, timeouts and a lost
// answer, fault mapping, budgets and notices, and logs without realm ids or tokens.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { createFakeQbo, connectViaFake } from './support/fake-qbo.js';
import { readConfig } from '../src/config.js';
import { createSealer } from '../src/lib/crypto.js';
import { setFetch } from '../src/integrations/http.js';
import { createTenantWithOwner } from '../src/services/tenants.js';
import { QboError, createQboClient, resetUsageCache } from '../src/qbo/client.js';
import { resetTokenBreaker } from '../src/qbo/connection.js';

const REALM = '4620816365100001';
const PROD_REALM = '9341452000000002';
const KEY = randomBytes(32).toString('base64');
const fake = createFakeQbo();
const mkConfig = (env = {}) => readConfig({
  APP_ENV: 'test', SECRETS_MASTER_KEY: KEY, PUBLIC_ORIGIN: 'https://app.fishtape.test', QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret, QBO_WEBHOOK_VERIFIER: 'v1', ...env,
});
const sealer = createSealer(KEY);
let t, A, P, config;
const logs = [];
const log = (level, msg, extra) => logs.push(JSON.stringify({ level, msg, ...extra }));
const client = (o = {}) => createQboClient({ db: t.db, sealer, config: o.config || config, tenantId: o.tenantId || A.tenantId, purpose: o.purpose || 'sync', log });
const usage = async (tenantId, env = 'sandbox') => (await t.db.withTenant({ tenantId }, (tx) => tx.query(
  'SELECT core_calls, coreplus_calls, throttled, errors, alerted_pct FROM qbo_api_usage WHERE tenant_id = $1 AND environment = $2', [tenantId, env]))).rows[0];

before(async () => {
  if (skip) return;
  setFetch((u, i) => fake.fetch(u, i));
  t = await createTestDatabase('qboclient');
  config = mkConfig();
  const mk = async (name) => {
    const r = await createTenantWithOwner(t.db, { name, owner: { email: `${randomBytes(4).toString('hex')}@example.test`, password: 'pw-long-enough-123', displayName: `${name} Owner` } });
    return { tenantId: r.tenant.id, userId: r.userId };
  };
  A = await mk('Alpha Electric');
  P = await mk('Prairie Power');
  fake.addCompany(REALM);
  fake.addCompany(PROD_REALM);
  const r = await connectViaFake(fake, { db: t.db, sealer, config, tenantId: A.tenantId, userId: A.userId, realmId: REALM });
  assert.equal(r.result, 'ok');
});
after(async () => { setFetch(null); await t?.close(); });

describe('calls', { skip }, () => {
  test('create, read, sparse and full update with SyncToken; 5010 when stale', async () => {
    const c = client();
    const cu = await c.create('Customer', { DisplayName: 'Dana Smith', PrimaryEmailAddr: { Address: 'dana@example.test' } }, { requestId: 'r1' });
    assert.equal(cu.SyncToken, '0');
    const read = await c.read('Customer', cu.Id);
    assert.equal(read.DisplayName, 'Dana Smith');
    const up = await c.update('Customer', { Id: cu.Id, SyncToken: cu.SyncToken, PrimaryPhone: { FreeFormNumber: '204-555-0101' } }, { sparse: true, requestId: 'r2' });
    assert.equal(up.SyncToken, '1');
    assert.equal(up.PrimaryEmailAddr.Address, 'dana@example.test', 'sparse keeps the other fields');
    await assert.rejects(c.update('Customer', { Id: cu.Id, SyncToken: '0', Notes: 'x' }, { sparse: true }), (e) => e instanceof QboError && e.kind === 'stale' && e.retry && e.faultCode === '5010');
    const full = await c.update('Customer', { Id: cu.Id, SyncToken: up.SyncToken, DisplayName: 'Dana Smith', Notes: 'full' });
    assert.equal(full.PrimaryEmailAddr, undefined, 'a full update replaces the object');
    assert.ok(fake.calls.filter((x) => x.realmId === REALM).every((x) => x.minorversion === '75'));
    assert.ok(fake.calls.some((x) => x.requestId === 'r1'));
    await assert.rejects(c.read('Customer', '99999'), (e) => e.kind === 'not_found');
    await assert.rejects(c.read('Customer', "1' or '1"), /bad id/);
    await assert.rejects(c.create('Spaceship', {}), /unknown entity/);
  });

  test('queries page through, count, and CDC returns changes with deleted stubs', async () => {
    const c = client();
    const since = new Date(fake.now() - 1000);
    for (let i = 0; i < 1003; i++) fake.create(REALM, 'Item', { Name: `Wire ${i}`, Type: 'NonInventory' });
    const all = await c.query("select * from Item where Type = 'NonInventory'", { all: true });
    assert.ok(all.length >= 1003);
    assert.equal((await c.query("select * from Item where Name like 'Wire 1%'")).length, 100, 'default page');
    assert.equal(await c.query("select count(*) from Item where Name like 'Wire 100%'"), 4);
    const one = fake.create(REALM, 'Customer', { DisplayName: 'Gone Soon' });
    fake.destroy(REALM, 'Customer', one.Id);
    const cdc = await c.cdc(['Customer', 'Item'], since);
    assert.equal(cdc.count, 1000, 'capped at 1,000 objects');
    const narrow = await c.cdc(['Customer'], since);
    assert.ok(narrow.entities.Customer.some((x) => x.Id === one.Id && x.status === 'Deleted'));
    assert.ok(narrow.time);
    await assert.rejects(c.cdc(['Customer'], new Date(Date.now() - 31 * 86400_000)), (e) => e.kind === 'validation');
  });

  test('company info, preferences, batch, upload, void and delete', async () => {
    const c = client();
    assert.equal((await c.companyInfo()).Country, 'CA');
    assert.equal((await c.preferences()).CurrencyPrefs.HomeCurrency.value, 'CAD');
    const res = await c.batch([
      { bId: 'b1', operation: 'create', Vendor: { DisplayName: 'Westburne' } },
      { bId: 'b2', Query: "select * from Vendor where DisplayName = 'Westburne'" },
      { bId: 'b3', operation: 'create', Vendor: { DisplayName: 'Westburne' } },
    ]);
    assert.equal(res[0].Vendor.DisplayName, 'Westburne');
    assert.equal(res[1].QueryResponse.Vendor.length, 1);
    assert.equal(res[2].Fault.Error[0].code, '6240');
    fake.setBatchMax(10);
    await assert.rejects(c.batch(Array.from({ length: 11 }, (_, i) => ({ bId: `x${i}`, Query: 'select * from Vendor' }))), (e) => e.kind === 'validation');
    fake.setBatchMax(30);
    const seed = fake.seed(REALM);
    const cust = await c.create('Customer', { DisplayName: 'Receipt Co' });
    const bill = await c.create('Purchase', { PaymentType: 'Cash', AccountRef: { value: seed.accounts.bank.Id }, EntityRef: { value: cust.Id }, Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 10, AccountBasedExpenseLineDetail: { AccountRef: { value: seed.accounts.materials.Id }, TaxCodeRef: { value: seed.taxCodes.gst.Id } } }] });
    assert.equal(bill.TotalAmt, 10.5);
    const att = await c.upload({ entity: 'Purchase', id: bill.Id }, { fileName: 'r "1".jpg', contentType: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) });
    assert.deepEqual([...fake.attachment(REALM, att.Id)], [1, 2, 3]);
    assert.equal(att.AttachableRef[0].EntityRef.value, bill.Id);
    const inv = await c.create('Invoice', { CustomerRef: { value: cust.Id }, Line: [{ DetailType: 'SalesItemLineDetail', Amount: 20, SalesItemLineDetail: { ItemRef: { value: seed.items.labour.Id }, Qty: 1, UnitPrice: 20, TaxCodeRef: { value: seed.taxCodes.gstPst.Id } } }] });
    assert.equal(inv.TotalAmt, 22.4);
    const pay = await c.create('Payment', { CustomerRef: { value: cust.Id }, TotalAmt: 22.4, Line: [{ Amount: 22.4, LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }] }] });
    const voided = await c.voidTxn('Payment', pay);
    assert.equal(voided.TotalAmt, 0);
    assert.ok(fake.calls.some((x) => x.entity === 'Payment' && x.path === 'payment'));
    const v = await c.voidTxn('Invoice', await c.read('Invoice', inv.Id));
    assert.match(v.PrivateNote, /^Voided/);
    const est = await c.create('Estimate', { CustomerRef: { value: cust.Id }, Line: [] });
    assert.equal((await c.remove('Estimate', est)).status, 'Deleted');
  });

  test('usage is counted per call: writes as Core, reads as CorePlus, failures too', async () => {
    const before = await usage(A.tenantId);
    const c = client();
    await c.read('Item', fake.seed(REALM).items.labour.Id);
    await c.create('Class', { Name: `Class ${randomBytes(3).toString('hex')}` });
    await assert.rejects(c.read('Item', '99999'));
    const after = await usage(A.tenantId);
    assert.equal(after.coreplus_calls - before.coreplus_calls, 2);
    assert.equal(after.core_calls - before.core_calls, 1);
    assert.equal(after.errors - before.errors, 1);
  });

  test('logs carry method, entity, status, fault code and intuit_tid only: never the realm id, a token or query text', async () => {
    logs.length = 0;
    const c = client();
    await c.query("select * from Customer where DisplayName = 'Dana Smith'");
    await assert.rejects(c.read('Customer', '99999'));
    const text = logs.join('\n');
    assert.ok(logs.length >= 2);
    assert.ok(!text.includes(REALM), 'no realm id');
    assert.ok(!text.includes('Dana'), 'no query text');
    assert.ok(!/fake\.access|fakerefresh/.test(text), 'no token');
    assert.match(text, /"faultCode":"610"/);
    assert.match(text, /"intuitTid":"tid-/);
  });
});

describe('failures', { skip }, () => {
  test('QBO_WRITES=off refuses every write before sending; reads continue', async () => {
    const off = mkConfig({ QBO_WRITES: 'off' });
    const c = client({ config: off });
    const n = fake.calls.length;
    await assert.rejects(c.create('Customer', { DisplayName: 'Nope' }), (e) => e.kind === 'unavailable' && e.retry && e.message === 'Sending to QuickBooks is paused by Fishtape.');
    assert.equal(fake.calls.length, n, 'nothing sent');
    assert.ok(await c.companyInfo());
  });

  test('429: throttled_until for 60 s, and every caller waits without calling', async () => {
    const c = client();
    fake.failNext({ status: 429 });
    await assert.rejects(c.read('Item', fake.seed(REALM).items.labour.Id), (e) => e.kind === 'throttled' && e.retryAfterS === 60 && e.code === 'qbo_throttled');
    const n = fake.calls.length;
    await assert.rejects(client({ purpose: 'lookup' }).read('Item', '1'), (e) => e.kind === 'throttled' && e.retryAfterS > 0);
    assert.equal(fake.calls.length, n);
    assert.equal((await usage(A.tenantId)).throttled >= 1, true);
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('UPDATE qbo_connections SET throttled_until = NULL WHERE tenant_id = $1', [A.tenantId]));
  });

  test('a call that waited in the limiter while another got a 429 is not sent', async () => {
    const id = fake.seed(REALM).items.labour.Id;
    let entered;
    const inLimiter = new Promise((r) => { entered = r; });
    let open;
    const opened = new Promise((r) => { open = r; });
    const queued = createQboClient({
      db: t.db, sealer, config, tenantId: A.tenantId, purpose: 'sync', log,
      limiter: { acquire: async () => { entered(); await opened; return () => {}; } },
    });
    const second = queued.read('Item', id);
    await inLimiter; // past its throttle check, waiting for its turn
    fake.failNext({ status: 429 });
    await assert.rejects(client().read('Item', id), (e) => e.kind === 'throttled');
    const n = fake.calls.length;
    open();
    await assert.rejects(second, (e) => e.kind === 'throttled' && e.retryAfterS > 0);
    assert.equal(fake.calls.length, n, 'not sent into the throttle');
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('UPDATE qbo_connections SET throttled_until = NULL WHERE tenant_id = $1', [A.tenantId]));
  });

  test('upload refuses a content type that could add headers or parts', async () => {
    const c = client();
    const n = fake.calls.length;
    for (const contentType of ['image/jpeg\r\nX-Injected: 1', 'image/jpeg; charset=x', 'text', '']) {
      await assert.rejects(c.upload({ entity: 'Purchase', id: '1' }, { fileName: 'r.jpg', contentType, bytes: Buffer.from([1]) }), /bad content type/);
    }
    assert.equal(fake.calls.length, n);
  });

  test('5xx: retryable, a write is outcome-unknown, and the platform event is recorded', async () => {
    const c = client();
    fake.failNext({ status: 503 });
    await assert.rejects(c.create('Customer', { DisplayName: 'Five Oh Three' }), (e) => e.kind === 'unavailable' && e.retry && e.outcomeUnknown && e.status === 503);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM qbo_platform_events WHERE kind = 'intuit_5xx' AND tenant_id = $1", [A.tenantId]);
    assert.ok(rows[0].n >= 1);
    fake.failNext({ status: 500 });
    await assert.rejects(c.read('Item', '1'), (e) => e.kind === 'unavailable' && !e.outcomeUnknown);
  });

  test('a 401 with a token that should be valid: one forced refresh and one retry', async () => {
    const c = client();
    const refreshes = fake.state.tokenCalls.length;
    fake.failNext({ status: 401, match: (call) => call.entity === 'Item' });
    const item = await c.read('Item', fake.seed(REALM).items.labour.Id);
    assert.equal(item.Name, 'Labour');
    assert.equal(fake.state.tokenCalls.length - refreshes, 1);
  });

  test('a timeout past the limit, and an answer lost after the write landed', async () => {
    const quick = mkConfig();
    quick.qbo.requestTimeoutMs = 150;
    const c = client({ config: quick });
    fake.failNext({ latencyMs: 2000 });
    await assert.rejects(c.read('Item', '1'), (e) => e.kind === 'unavailable' && e.variant === 'timeout' && e.retry);
    const name = `Lost Answer ${randomBytes(3).toString('hex')}`;
    fake.failNext({ drop: true, match: (call) => call.entity === 'Customer' && call.method === 'POST' });
    await assert.rejects(client().create('Customer', { DisplayName: name }, { requestId: 'lost1' }), (e) => e.kind === 'unavailable' && e.outcomeUnknown);
    assert.ok(fake.list(REALM, 'Customer').some((x) => x.DisplayName === name), 'the create landed in QuickBooks');
  });

  test('requestid replay only inside the configured window (off by default)', async () => {
    const c = client();
    const n1 = `Replay ${randomBytes(3).toString('hex')}`;
    await c.create('Customer', { DisplayName: n1 }, { requestId: 'same-id' });
    await assert.rejects(c.create('Customer', { DisplayName: n1 }, { requestId: 'same-id' }), (e) => e.kind === 'duplicate_name');
    fake.setRequestIdWindow(60_000);
    const n2 = `Replay ${randomBytes(3).toString('hex')}`;
    const first = await c.create('Customer', { DisplayName: n2 }, { requestId: 'same-id-2' });
    const again = await c.create('Customer', { DisplayName: n2 }, { requestId: 'same-id-2' });
    assert.equal(again.Id, first.Id);
    fake.setRequestIdWindow(0);
  });

  test('fault mapping: duplicate number and name, feature, closed books, amount rule, open balance', async () => {
    const c = client();
    const seed = fake.seed(REALM);
    const cust = await c.create('Customer', { DisplayName: `Faulty ${randomBytes(3).toString('hex')}` });
    const line = (amount, qty = 1) => ({ DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: { ItemRef: { value: seed.items.labour.Id }, Qty: qty, UnitPrice: 95, TaxCodeRef: { value: seed.taxCodes.gst.Id } } });
    await c.create('Invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'INV-9001', Line: [line(95)] });
    await assert.rejects(c.create('Invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'INV-9001', Line: [line(95)] }), (e) => e.kind === 'duplicate_number' && !e.retry);
    await assert.rejects(c.create('Customer', { DisplayName: cust.DisplayName }), (e) => e.kind === 'duplicate_name' && !e.message.includes('Faulty') && !String(e.detail).includes('Faulty'));
    await assert.rejects(c.create('Invoice', { CustomerRef: { value: cust.Id }, Line: [line(253.33, 2.6667)] }), (e) => e.kind === 'validation' && e.variant === 'amount');
    await assert.rejects(c.update('Customer', { Id: cust.Id, SyncToken: (await c.read('Customer', cust.Id)).SyncToken, Active: false }, { sparse: true }), (e) => e.kind === 'open_balance');
    fake.setBookCloseDate(REALM, '2025-12-31');
    await assert.rejects(c.create('Invoice', { CustomerRef: { value: cust.Id }, TxnDate: '2025-06-01', Line: [line(95)] }), (e) => e.kind === 'closed_books');
    fake.setBookCloseDate(REALM, null);
    fake.disableEntity(REALM, 'PurchaseOrder');
    await assert.rejects(c.create('PurchaseOrder', { VendorRef: { value: '1' }, Line: [] }), (e) => e.kind === 'feature' && e.faultCode === '5030');
  });
});

describe('budgets (production)', { skip }, () => {
  let prod;
  before(async () => {
    resetUsageCache();
    resetTokenBreaker();
    // P is on its free trial, so the trial budget (10 here) applies.
    prod = mkConfig({ QBO_ENVIRONMENT: 'production', QBO_TRIAL_READ_BUDGET: '10', QBO_TENANT_READ_BUDGET: '1000', QBO_READ_BUDGET: '100000' });
    const r = await connectViaFake(fake, { db: t.db, sealer, config: prod, tenantId: P.tenantId, userId: P.userId, realmId: PROD_REALM });
    assert.equal(r.result, 'ok');
  });

  test('notices at 50%, look-ups stop at 80%, checks at 100%, the tenant pauses at 150%; sync goes on until then', async () => {
    const c = (purpose) => client({ config: prod, tenantId: P.tenantId, purpose });
    const item = fake.seed(PROD_REALM).items.labour.Id;
    // The connect read CompanyInfo and Preferences (2 reads, purpose connect: counted, never refused).
    for (let i = 0; i < 3; i++) await c('sync').read('Item', item);
    const notes = async () => (await t.superPool.query("SELECT ref FROM notifications WHERE tenant_id = $1 AND kind = 'quickbooks' AND ref LIKE 'qbo:budget:%'", [P.tenantId])).rows.map((r) => r.ref);
    assert.ok((await notes()).some((r) => r.endsWith(':50')), 'the 50% notice');
    await c('lookup').read('Item', item);
    await c('lookup').read('Item', item);
    await c('sync').read('Item', item);
    const n = fake.calls.length;
    await assert.rejects(c('lookup').read('Item', item), (e) => e.kind === 'budget' && e.code === 'lookup_budget');
    assert.equal(fake.calls.length, n, 'refused before any call');
    await c('check').read('Item', item);
    await c('sync').read('Item', item);
    await assert.rejects(c('check').read('Item', item), (e) => e.kind === 'budget');
    await c('sync').create('Class', { Name: 'Writes are not reads' });
    for (let i = 0; i < 5; i++) await c('sync').read('Item', item);
    await assert.rejects(c('sync').read('Item', item), (e) => e.kind === 'budget');
    const conn = (await t.db.withTenant({ tenantId: P.tenantId }, (tx) => tx.query('SELECT state, pause_reason FROM qbo_connections'))).rows[0];
    assert.deepEqual(conn, { state: 'paused', pause_reason: 'tenant_budget' });
    assert.ok((await notes()).some((r) => r.endsWith(':100')));
    const u = await usage(P.tenantId, 'production');
    assert.equal(u.alerted_pct, 100);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM qbo_platform_events WHERE kind = 'budget_threshold' AND tenant_id = $1", [P.tenantId]);
    assert.equal(rows[0].n, 3);
  });

  test('sandbox calls never count toward a budget', async () => {
    const tiny = mkConfig({ QBO_TENANT_READ_BUDGET: '1', QBO_TRIAL_READ_BUDGET: '1' });
    const c = client({ config: tiny, purpose: 'lookup' });
    for (let i = 0; i < 3; i++) await c.read('Item', fake.seed(REALM).items.labour.Id);
  });
});

test('nothing outside the fake was called', { skip }, () => fake.assertNoUnexpected());
