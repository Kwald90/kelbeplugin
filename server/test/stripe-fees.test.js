// The Stripe side of the books (docs/integrations/quickbooks.md 4.9 and 12.7): the fee of each
// Stripe payment, payout webhooks and their itemisation from balance transactions, queuing a
// payout for QuickBooks, the hourly catch-up of reads that failed, and the amount due (pay link
// and invoice status) with an adjuster. Stripe is read for the books only for a company on
// QuickBooks. Stripe is faked through setFetch(); a call to anything not faked fails the test.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp } from './support/app.js';
import { ProviderError, setFetch } from '../src/integrations/http.js';
import { fetchPayout, fetchPayoutTransactions, fetchStripeFee, stripeTestHeader } from '../src/integrations/stripe.js';
import { amountDueCents, invoiceBalance, recordStripePayout, refreshInvoiceStatus, registerAmountDueAdjuster } from '../src/integrations/payments.js';
import { createIntegrationHandlers } from '../src/integrations/jobs.js';
import { systemPrincipal, systemWho } from '../src/integrations/state.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';

const hex = (n) => randomBytes(n).toString('hex');
const KEY = `rk_test_${hex(12)}`;
const WHSEC = `whsec_${hex(16)}`;
const PII = 'Pat Customer';

/** Fake Stripe: handlers by method + URL; anything else is recorded as unexpected. */
const net = {
  calls: [], unexpected: [], routes: [],
  on(method, re, reply) { this.routes.unshift({ method, re, reply }); },
  reset() { this.calls.length = 0; this.routes.length = 0; },
  async fetch(url, init = {}) {
    const u = String(url);
    const method = init.method || 'GET';
    const c = { url: u, method, headers: init.headers || {}, body: init.body };
    net.calls.push(c);
    const r = net.routes.find((x) => x.method === method && x.re.test(u));
    if (!r) { net.unexpected.push(`${method} ${u}`); throw new Error('no network in tests'); }
    const { status = 200, json = {} } = await r.reply(c);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  },
};
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * Migration 0150 belongs to W1. Until it is merged, build its tables from the contract's own
 * DDL (docs/integrations/quickbooks.md 3.2), so these tests run against what W1 ships.
 * Does nothing once 0150 exists.
 */
async function ensureQboTables(t) {
  if ((await t.superPool.query("SELECT to_regclass('public.qbo_connections') IS NOT NULL AS ok")).rows[0].ok) return;
  const doc = readFileSync(fileURLToPath(new URL('../../docs/integrations/quickbooks.md', import.meta.url)), 'utf8');
  const ddl = /```sql\r?\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('### 3.2')))[1];
  const policies = ['qbo_links', 'qbo_outbox', 'qbo_inbox', 'qbo_conflicts', 'qbo_sync_log', 'qbo_mappings', 'qbo_reference', 'qbo_candidates', 'stripe_payouts']
    .map((tb) => `ALTER TABLE ${tb} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${tb} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${tb}_tenant ON ${tb} USING (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL)
        WITH CHECK (tenant_id = app_tenant_id() AND app_portal_client_id() IS NULL);`).join('\n');
  const c = await t.ownerPool.connect();
  try { await c.query(`${ddl}\n${policies}`); } finally { c.release(); }
}

describe('Stripe reads for the books (fake Stripe, no database)', () => {
  test('fetchStripeFee reads the charge\'s balance transaction', async () => {
    net.reset();
    net.on('GET', /api\.stripe\.com\/v1\/payment_intents\/pi_feetest01\?expand\[\]=latest_charge\.balance_transaction$/, () => ({
      json: { id: 'pi_feetest01', object: 'payment_intent', latest_charge: { id: 'ch_feetest01', created: unix('2026-10-20T15:00:00Z'), currency: 'cad', billing_details: { name: PII },
        balance_transaction: { id: 'txn_feetest01', fee: 3075, net: 101925, currency: 'cad' } } },
    }));
    const fee = await fetchStripeFee(KEY, 'pi_feetest01');
    assert.deepEqual(fee, { chargeId: 'ch_feetest01', balanceTransactionId: 'txn_feetest01', feeCents: 3075, netCents: 101925, currency: 'cad', created: '2026-10-20T15:00:00.000Z' });
    assert.equal(net.calls[0].headers.authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(fee).includes(PII), 'no customer details come back');
  });

  test('a fee Stripe has not settled yet is a retryable error; a missing permission says which', async () => {
    net.reset();
    net.on('GET', /payment_intents\/pi_feetest02/, () => ({ json: { id: 'pi_feetest02', latest_charge: { id: 'ch_2', balance_transaction: null } } }));
    await assert.rejects(fetchStripeFee(KEY, 'pi_feetest02'), (e) => e instanceof ProviderError && e.retry === true && /not settled/.test(e.message));
    net.on('GET', /payment_intents\/pi_feetest03/, () => ({ status: 403, json: { error: { type: 'invalid_request_error', message: `The provided key ${KEY} does not have the required permissions` } } }));
    await assert.rejects(fetchStripeFee(KEY, 'pi_feetest03'), (e) => e.kind === 'auth' && /PaymentIntents, Charges, Balance transactions and Payouts/.test(e.message) && !e.message.includes(KEY));
    const before = net.calls.length;
    await assert.rejects(fetchStripeFee(KEY, 'pi_x/../../v1/customers'), (e) => e.kind === 'invalid');
    assert.equal(net.calls.length, before, 'a malformed id never reaches Stripe');
  });

  test('fetchPayout maps the payout; in_transit is pending', async () => {
    net.reset();
    net.on('GET', /\/v1\/payouts\/po_payouttest01\?expand\[\]=balance_transaction$/, () => ({
      json: { id: 'po_payouttest01', object: 'payout', amount: 98000, currency: 'CAD', arrival_date: unix('2026-10-22T00:00:00Z'), status: 'in_transit', automatic: true, livemode: true, balance_transaction: { id: 'txn_po', fee: 0 } },
    }));
    assert.deepEqual(await fetchPayout(KEY, 'po_payouttest01'), { amountCents: 98000, currency: 'cad', arrivalDate: '2026-10-22', status: 'pending', automatic: true, livemode: true, feeCents: 0 });
  });

  test('fetchPayoutTransactions pages through and keeps money, types and ids only', async () => {
    net.reset();
    net.on('GET', /\/v1\/balance_transactions\?payout=po_payouttest01&limit=100&expand\[\]=data\.source$/, () => ({
      json: { has_more: true, data: [
        { id: 'txn_c1', type: 'charge', amount: 105000, fee: 3075, created: unix('2026-10-19T12:00:00Z'), description: `Invoice for ${PII}`,
          source: { id: 'ch_c1', object: 'charge', payment_intent: 'pi_payouttest1', billing_details: { name: PII } } },
      ] },
    }));
    net.on('GET', /\/v1\/balance_transactions\?payout=po_payouttest01&limit=100&expand\[\]=data\.source&starting_after=txn_c1$/, () => ({
      json: { has_more: false, data: [
        { id: 'txn_f1', type: 'stripe_fee', amount: -200, fee: 0, created: unix('2026-10-20T00:00:00Z'), description: 'Radar', source: null },
        { id: 'txn_p1', type: 'payout', amount: -101725, fee: 0, created: unix('2026-10-21T00:00:00Z'), source: 'po_payouttest01' },
      ] },
    }));
    const list = await fetchPayoutTransactions(KEY, 'po_payouttest01');
    assert.deepEqual(list, [
      { id: 'txn_c1', type: 'charge', amountCents: 105000, feeCents: 3075, paymentIntentId: 'pi_payouttest1', created: '2026-10-19T12:00:00.000Z' },
      { id: 'txn_f1', type: 'stripe_fee', amountCents: -200, feeCents: 0, paymentIntentId: null, created: '2026-10-20T00:00:00.000Z' },
      { id: 'txn_p1', type: 'payout', amountCents: -101725, feeCents: 0, paymentIntentId: null, created: '2026-10-21T00:00:00.000Z' },
    ]);
    assert.ok(!JSON.stringify(list).includes(PII));
    assert.deepEqual(net.unexpected, []);
  });
});

let t, app, A, B, handlers, records;
const QBO_ENV = process.env.QBO_ENVIRONMENT;
const p = (tenantId) => systemPrincipal(tenantId, 'stripe', 'Stripe');

before(async () => {
  setFetch((u, i) => net.fetch(u, i));
  if (skip) return;
  t = await createTestDatabase('stripefees');
  await ensureQboTables(t);
  ({ app } = await startApp(t));
  process.env.QBO_ENVIRONMENT = 'sandbox'; // QuickBooks is on for this server (read when each call runs)
  A = await ownerTenant(t, app, 'Alpha Electric');
  B = await ownerTenant(t, app, 'Bravo Electric');
  for (const who of [A, B]) {
    const r = await call(app, { method: 'PUT', url: '/api/v1/integrations/stripe', token: who.token, body: { secrets: { 'stripe.secret_key': KEY, 'stripe.webhook_secret': WHSEC } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  records = createRecords({ validator: createValidator() });
  handlers = createIntegrationHandlers({ sealer: app.sealer, records });
  // A is connected to QuickBooks (sandbox, active); B is not.
  await t.superPool.query("INSERT INTO qbo_connections (tenant_id, environment, realm_hash, state) VALUES ($1, 'sandbox', $2, 'active')", [A.tenantId, randomBytes(32)]);
});
after(async () => {
  if (QBO_ENV === undefined) delete process.env.QBO_ENVIRONMENT; else process.env.QBO_ENVIRONMENT = QBO_ENV;
  setFetch(null); await app?.close(); await t?.close();
});

async function makeInvoice(who, id, unitCents = 100000) {
  await call(app, { method: 'POST', url: '/api/v1/clients', token: who.token, body: { id: `client-${id}`, name: PII, email: 'pat@example.com' } });
  const r = await call(app, { method: 'POST', url: '/api/v1/invoices', token: who.token, body: {
    id, number: `INV-${id}`, clientId: `client-${id}`, status: 'sent', issueDate: '2026-10-19', dueDate: '2026-11-02',
    lines: [{ description: 'Panel upgrade', qty: 1, unitCents, kind: 'labour' }],
    taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }], taxPct: 5,
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const postStripe = (tenantId, obj, type, id = `evt_${hex(8)}`) => {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object: obj } });
  return call(app, { method: 'POST', url: `/api/v1/webhooks/stripe/${tenantId}`, csrf: false, body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': stripeTestHeader(payload, WHSEC) } });
};
const jobs = async (kind, tenantId) => (await t.superPool.query('SELECT * FROM jobs_queue WHERE kind = $1 AND tenant_id = $2 ORDER BY id', [kind, tenantId])).rows;
const payoutRow = async (tenantId, id) => (await t.superPool.query('SELECT *, arrival_date::text AS arrival FROM stripe_payouts WHERE tenant_id = $1 AND payout_id = $2', [tenantId, id])).rows[0];
const outboxRow = async (tenantId, id) => (await t.superPool.query("SELECT * FROM qbo_outbox WHERE tenant_id = $1 AND collection = 'stripePayouts' AND record_id = $2", [tenantId, id])).rows[0];
const getPayment = async (id) => (await call(app, { url: `/api/v1/payments/${id}`, token: A.token })).body;

describe('Stripe fees on payments', { skip }, () => {
  let paymentId;
  let intent;

  test('a Stripe payment queues a fee read; the worker fills in the fee, net and charge', async () => {
    await makeInvoice(A, 'inv-f1');
    intent = `pi_${hex(8)}`;
    const session = { id: `cs_test_${hex(8)}`, object: 'checkout.session', payment_status: 'paid', amount_total: 105000, currency: 'cad', payment_intent: intent,
      created: Math.floor(Date.now() / 1000), livemode: false, metadata: { fishtape_tenant: A.tenantId, fishtape_invoice: 'inv-f1' } };
    assert.equal((await postStripe(A.tenantId, session, 'checkout.session.completed')).status, 200);
    paymentId = `stripe-${intent}`;
    const queued = await jobs('stripe_fee_fetch', A.tenantId);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].payload, { paymentId });
    assert.ok(new Date(queued[0].run_at).getTime() > Date.now() + 60_000, 'waits for Stripe to settle the fee');

    net.reset();
    net.on('GET', new RegExp(`payment_intents/${intent}\\?expand`), () => ({
      json: { id: intent, latest_charge: { id: 'ch_fee1', created: session.created, balance_transaction: { id: 'txn_fee1', fee: 3075, net: 101925, currency: 'cad' } } },
    }));
    const before = await getPayment(paymentId);
    const out = await handlers.stripe_fee_fetch({ db: t.db, job: queued[0] });
    assert.deepEqual(out, { feeCents: 3075 });
    const pay = await getPayment(paymentId);
    assert.deepEqual(pay.stripe, { ...before.stripe, chargeId: 'ch_fee1', balanceTransactionId: 'txn_fee1', feeCents: 3075, netCents: 101925, feeCurrency: 'CAD' });
    assert.equal(pay.amountCents, 105000, 'the payment stays gross');
    assert.equal(pay.version, before.version + 1);
    const audit = (await t.superPool.query("SELECT actor_type, actor_id FROM audit_events WHERE tenant_id = $1 AND record_id = $2 AND action = 'record.update'", [A.tenantId, paymentId])).rows;
    assert.deepEqual(audit, [{ actor_type: 'system', actor_id: 'stripe' }], 'written by the Stripe system actor');

    const calls = net.calls.length;
    assert.deepEqual(await handlers.stripe_fee_fetch({ db: t.db, job: queued[0] }), { skipped: 'fee known' });
    assert.equal(net.calls.length, calls, 'a known fee is not read again');
  });

  test('a fee not settled yet makes the job retry; a refused key stops it and marks the Stripe card (a company on QuickBooks)', async () => {
    await makeInvoice(A, 'inv-f2');
    const pi = `pi_${hex(8)}`;
    const session = { id: `cs_test_${hex(8)}`, object: 'checkout.session', payment_status: 'paid', amount_total: 105000, currency: 'cad', payment_intent: pi,
      created: Math.floor(Date.now() / 1000), livemode: false, metadata: { fishtape_tenant: A.tenantId, fishtape_invoice: 'inv-f2' } };
    assert.equal((await postStripe(A.tenantId, session, 'checkout.session.completed')).status, 200);
    const job = { tenant_id: A.tenantId, payload: { paymentId: `stripe-${pi}` } };
    net.reset();
    net.on('GET', new RegExp(`payment_intents/${pi}`), () => ({ json: { id: pi, latest_charge: { id: 'ch_x', balance_transaction: null } } }));
    await assert.rejects(handlers.stripe_fee_fetch({ db: t.db, job }), /not settled the fee/);
    net.on('GET', new RegExp(`payment_intents/${pi}`), () => ({ status: 401, json: { error: { type: 'authentication_error', message: 'Invalid API Key provided' } } }));
    assert.deepEqual(await handlers.stripe_fee_fetch({ db: t.db, job }), { failed: true });
    assert.equal((await getPayment(`stripe-${pi}`)).stripe.feeCents, undefined);
    const card = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((c) => c.provider === 'stripe');
    assert.equal(card.status, 'error');
  });

  test('a payment that is not from Stripe, or is gone, is skipped; a malformed reference is not retried', async () => {
    assert.deepEqual(await handlers.stripe_fee_fetch({ db: t.db, job: { tenant_id: A.tenantId, payload: { paymentId: 'nope' } } }), { skipped: 'not a Stripe payment' });
    assert.deepEqual(await handlers.stripe_fee_fetch({ db: t.db, job: { tenant_id: A.tenantId, payload: {} } }), { skipped: true });
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => records.createRecord(tx, p(A.tenantId), 'payments', {
      id: 'pay-badpi', amountCents: 100, date: '2026-10-20', method: 'card', source: 'stripe', stripe: { paymentIntentId: 'pi_x/../../v1/customers' },
    }, systemWho(p(A.tenantId))), { write: true });
    net.reset();
    assert.deepEqual(await handlers.stripe_fee_fetch({ db: t.db, job: { tenant_id: A.tenantId, payload: { paymentId: 'pay-badpi' } } }), { skipped: 'not a Stripe payment reference' });
    assert.equal(net.calls.length, 0);
  });
});

describe('Stripe payouts', { skip }, () => {
  const payout = (extra = {}) => ({ id: `po_${hex(10)}`, object: 'payout', amount: 101725, currency: 'cad', arrival_date: unix('2026-10-22T00:00:00Z'),
    status: 'paid', automatic: true, livemode: true, ...extra });
  const fakePayout = (po, txns) => {
    net.on('GET', new RegExp(`/v1/payouts/${po.id}\\?expand`), () => ({ json: { ...po, balance_transaction: { id: `txn_${po.id}`, fee: 0 } } }));
    net.on('GET', new RegExp(`/v1/balance_transactions\\?payout=${po.id}&`), () => ({ json: { has_more: false, data: txns } }));
  };
  let itemised;

  test('payout.paid stores the payout; the worker itemises it and it waits for QuickBooks', async () => {
    const po = payout();
    itemised = po.id;
    const r = await postStripe(A.tenantId, po, 'payout.paid');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let row = await payoutRow(A.tenantId, po.id);
    assert.equal(row.status, 'paid');
    assert.equal(row.paid_seen, true);
    assert.equal(row.livemode, true);
    assert.equal(row.arrival, '2026-10-22');
    assert.equal(await outboxRow(A.tenantId, po.id), undefined, 'not booked before it is itemised');
    const fetchJobs = await jobs('stripe_payout_fetch', A.tenantId);
    assert.equal(fetchJobs.length, 1);
    assert.deepEqual(fetchJobs[0].payload, { payoutId: po.id });

    net.reset();
    const pi = `pi_${hex(8)}`;
    fakePayout(po, [
      { id: 'txn_c1', type: 'charge', amount: 105000, fee: 3075, created: unix('2026-10-19T12:00:00Z'), description: `Invoice for ${PII}`, source: { id: 'ch_1', payment_intent: pi, billing_details: { name: PII } } },
      { id: 'txn_c0', type: 'payment', amount: 200, fee: 0, created: unix('2026-10-18T09:30:00Z'), source: { id: 'py_1', payment_intent: `pi_${hex(8)}` } },
      { id: 'txn_f1', type: 'stripe_fee', amount: -400, fee: 0, created: unix('2026-10-20T00:00:00Z'), source: null },
      { id: 'txn_p1', type: 'payout', amount: -101725, fee: 0, created: unix('2026-10-21T00:00:00Z'), source: po.id },
    ]);
    const out = await handlers.stripe_payout_fetch({ db: t.db, job: fetchJobs[0] });
    assert.equal(out.queued, true);
    row = await payoutRow(A.tenantId, po.id);
    assert.equal(row.balance_txns.length, 4);
    assert.deepEqual(row.balance_txns[0], { id: 'txn_c1', type: 'charge', amountCents: 105000, feeCents: 3075, paymentIntentId: pi, created: '2026-10-19T12:00:00.000Z' });
    assert.equal(row.payment_intent_ids.length, 2);
    assert.ok(row.payment_intent_ids.includes(pi));
    assert.equal(row.earliest_charge_at.toISOString(), '2026-10-18T09:30:00.000Z', 'the earliest charge decides the cutover');
    assert.equal(Number(row.fee_cents), 0);
    assert.ok(!JSON.stringify(row).includes(PII), 'no customer details are stored');

    const ob = await outboxRow(A.tenantId, po.id);
    assert.equal(ob.rank, 70);
    assert.equal(ob.actor_type, 'stripe');
    assert.equal(ob.op, 'upsert');
    const sync = await jobs('qbo_sync', A.tenantId);
    assert.equal(sync.length, 1);
    assert.equal(sync[0].dedupe_key, `qbo_sync:${A.tenantId}`);
    assert.deepEqual(net.unexpected, []);
  });

  test('a replayed event is acknowledged once; a later in_transit never takes a paid payout back', async () => {
    const po = payout({ status: 'in_transit' });
    const evt = `evt_${hex(8)}`;
    assert.equal((await postStripe(A.tenantId, po, 'payout.updated', evt)).status, 200);
    assert.equal((await payoutRow(A.tenantId, po.id)).status, 'pending');
    assert.equal((await postStripe(A.tenantId, po, 'payout.updated', evt)).body.duplicate, true);
    await postStripe(A.tenantId, { ...po, status: 'paid' }, 'payout.paid');
    await postStripe(A.tenantId, po, 'payout.updated');
    assert.equal((await payoutRow(A.tenantId, po.id)).status, 'paid');
  });

  test('a payout that fails after it was paid is queued again so its Transfer comes out', async () => {
    await t.superPool.query("DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = 'stripePayouts'", [A.tenantId]); // as if booked
    await postStripe(A.tenantId, payout({ id: itemised, status: 'failed' }), 'payout.failed');
    const row = await payoutRow(A.tenantId, itemised);
    assert.equal(row.status, 'failed');
    assert.equal(row.paid_seen, true);
    assert.equal(row.balance_txns.length, 4, 'the itemisation is kept');
    assert.ok(await outboxRow(A.tenantId, itemised));
    await postStripe(A.tenantId, payout({ id: itemised, status: 'paid' }), 'payout.paid');
    assert.equal((await payoutRow(A.tenantId, itemised)).status, 'failed', 'failed is final');
  });

  test('canceled, test-mode, non-CAD and manual payouts', async () => {
    const pending = payout({ status: 'pending' });
    await postStripe(A.tenantId, pending, 'payout.updated');
    await postStripe(A.tenantId, { ...pending, status: 'canceled' }, 'payout.canceled');
    assert.equal((await payoutRow(A.tenantId, pending.id)).status, 'canceled');
    assert.equal((await payoutRow(A.tenantId, pending.id)).paid_seen, false);
    assert.equal(await outboxRow(A.tenantId, pending.id), undefined, 'a canceled payout is never booked');

    const testMode = payout({ livemode: false });
    await postStripe(A.tenantId, testMode, 'payout.paid');
    assert.equal((await payoutRow(A.tenantId, testMode.id)).livemode, false, 'kept so the sync can skip it');
    const usd = payout({ currency: 'usd' });
    await postStripe(A.tenantId, usd, 'payout.paid');
    assert.equal((await payoutRow(A.tenantId, usd.id)).currency, 'usd');

    // A manual payout cannot be listed by balance transactions: it goes to QuickBooks as it is (the sync sends it to review).
    const manual = payout({ automatic: false });
    await postStripe(A.tenantId, manual, 'payout.paid');
    assert.equal((await payoutRow(A.tenantId, manual.id)).automatic, false);
    assert.ok(await outboxRow(A.tenantId, manual.id));
    assert.equal((await jobs('stripe_payout_fetch', A.tenantId)).filter((j) => j.payload.payoutId === manual.id).length, 0);
    net.reset();
    fakePayout({ ...manual, status: 'paid' }, []);
    const out = await handlers.stripe_payout_fetch({ db: t.db, job: { tenant_id: A.tenantId, payload: { payoutId: manual.id } } });
    assert.equal(out.queued, true);
    assert.ok(!net.calls.some((c) => c.url.includes('balance_transactions')), 'manual payouts are not itemised');
  });

  test('without a QuickBooks connection a payout is stored but not queued; bad payouts are ignored', async () => {
    const po = payout();
    const out = await t.db.withTenant({ tenantId: B.tenantId }, (tx) => recordStripePayout(tx, {
      id: po.id, amountCents: 5000, currency: 'cad', arrivalDate: '2026-10-22', status: 'paid', automatic: false, livemode: true,
    }), { write: true });
    assert.deepEqual(out, { inserted: true, status: 'paid', queued: false, itemise: false });
    assert.ok(await payoutRow(B.tenantId, po.id));
    assert.equal((await jobs('qbo_sync', B.tenantId)).length, 0);
    const bad = await t.db.withTenant({ tenantId: B.tenantId }, (tx) => recordStripePayout(tx, { id: 'po_x', amountCents: 1, currency: 'cad', arrivalDate: '2026-10-22', status: 'paid', livemode: true }), { write: true });
    assert.equal(bad.reason, 'bad id');
    // A's payouts are invisible to B (RLS).
    const leak = await t.db.withTenant({ tenantId: B.tenantId }, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM stripe_payouts')).rows[0].n);
    assert.equal(leak, 1);
  });
});

describe('Only for a company on QuickBooks, and caught up when a read failed', { skip }, () => {
  const checkout = (who, invoiceId, pi) => postStripe(who.tenantId, {
    id: `cs_test_${hex(8)}`, object: 'checkout.session', payment_status: 'paid', amount_total: 105000, currency: 'cad', payment_intent: pi,
    created: Math.floor(Date.now() / 1000), livemode: false, metadata: { fishtape_tenant: who.tenantId, fishtape_invoice: invoiceId },
  }, 'checkout.session.completed');
  const stripeCard = async (who) => (await call(app, { url: '/api/v1/integrations', token: who.token })).body.data.find((c) => c.provider === 'stripe');
  const byKey = async (key) => (await t.superPool.query('SELECT * FROM jobs_queue WHERE dedupe_key = $1 ORDER BY id', [key])).rows;
  /** Run the waiting job for this dedupe key the way the worker would, and mark it done. */
  const runQueued = async (kind, key) => {
    const [job] = (await byKey(key)).filter((j) => j.status === 'queued');
    assert.ok(job, `a ${kind} job is waiting`);
    const out = await handlers[kind]({ db: t.db, job });
    await t.superPool.query("UPDATE jobs_queue SET status = 'done', finished_at = now() WHERE id = $1", [job.id]);
    return out;
  };

  test('a company without QuickBooks, or a server with QuickBooks off, never reads Stripe for the books', async () => {
    // Bravo takes card payments through Stripe but never connected QuickBooks.
    await makeInvoice(B, 'inv-b1');
    const pi = `pi_${hex(8)}`;
    assert.equal((await checkout(B, 'inv-b1', pi)).status, 200);
    assert.equal((await call(app, { url: `/api/v1/payments/stripe-${pi}`, token: B.token })).status, 200, 'the payment is recorded as before');
    assert.equal((await jobs('stripe_fee_fetch', B.tenantId)).length, 0, 'no fee read');
    const po = { id: `po_${hex(10)}`, object: 'payout', amount: 5000, currency: 'cad', arrival_date: Math.floor(Date.now() / 1000), status: 'paid', automatic: true, livemode: true };
    assert.equal((await postStripe(B.tenantId, po, 'payout.paid')).status, 200);
    assert.equal((await payoutRow(B.tenantId, po.id)).status, 'paid', 'the payout is stored all the same');
    assert.equal((await jobs('stripe_payout_fetch', B.tenantId)).length, 0, 'not itemised');
    assert.equal(await outboxRow(B.tenantId, po.id), undefined);
    // A job queued anyway (QuickBooks disconnected since) asks Stripe nothing and leaves the card alone.
    net.reset();
    assert.deepEqual(await handlers.stripe_fee_fetch({ db: t.db, job: { tenant_id: B.tenantId, payload: { paymentId: `stripe-${pi}` } } }), { skipped: 'QuickBooks not connected' });
    assert.deepEqual(await handlers.stripe_payout_fetch({ db: t.db, job: { tenant_id: B.tenantId, payload: { payoutId: po.id } } }), { skipped: 'QuickBooks not connected' });
    await handlers.integrations_housekeeping({ db: t.db });
    assert.equal((await jobs('stripe_fee_fetch', B.tenantId)).length, 0, 'nor does the catch-up');
    assert.equal(net.calls.length, 0);
    assert.notEqual((await stripeCard(B)).status, 'error');

    // QuickBooks off on the server (QBO_ENVIRONMENT unset): Alpha's payment queues nothing either.
    await makeInvoice(A, 'inv-off');
    process.env.QBO_ENVIRONMENT = '';
    try {
      const before = (await jobs('stripe_fee_fetch', A.tenantId)).length;
      assert.equal((await checkout(A, 'inv-off', `pi_${hex(8)}`)).status, 200);
      assert.equal((await jobs('stripe_fee_fetch', A.tenantId)).length, before);
      assert.equal((await handlers.integrations_housekeeping({ db: t.db })).fees, undefined, 'and no catch-up');
    } finally {
      process.env.QBO_ENVIRONMENT = 'sandbox';
    }
  });

  test('reads refused by a key without the read permissions are asked again once the key is fixed', async () => {
    await makeInvoice(A, 'inv-late');
    const pi = `pi_${hex(8)}`;
    assert.equal((await checkout(A, 'inv-late', pi)).status, 200);
    const paymentId = `stripe-${pi}`;
    const po = { id: `po_${hex(10)}`, object: 'payout', amount: 101725, currency: 'cad', arrival_date: Math.floor(Date.now() / 1000), status: 'paid', automatic: true, livemode: true };
    assert.equal((await postStripe(A.tenantId, po, 'payout.paid')).status, 200);
    const feeKey = `stripe_fee_fetch:${A.tenantId}:${paymentId}`;
    const poKey = `stripe_payout_fetch:${A.tenantId}:${po.id}`;

    // The restricted key has Checkout Sessions: Write only (the old guide): Stripe refuses both reads.
    net.reset();
    const refuse = () => ({ status: 403, json: { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' } } });
    net.on('GET', new RegExp(`/v1/payment_intents/${pi}\\?`), refuse);
    net.on('GET', new RegExp(`/v1/payouts/${po.id}\\?`), refuse);
    assert.deepEqual(await runQueued('stripe_fee_fetch', feeKey), { failed: true });
    assert.deepEqual(await runQueued('stripe_payout_fetch', poKey), { failed: true });
    assert.deepEqual((await payoutRow(A.tenantId, po.id)).balance_txns, []);
    assert.equal(await outboxRow(A.tenantId, po.id), undefined);

    // The next hourly run leaves them alone: Stripe was asked less than 6 hours ago.
    await handlers.integrations_housekeeping({ db: t.db });
    assert.equal((await byKey(feeKey)).length, 1);
    assert.equal((await byKey(poKey)).length, 1);

    // The company adds the read permissions. Six hours on, the catch-up queues both reads again, once.
    await t.superPool.query("UPDATE jobs_queue SET finished_at = now() - interval '7 hours' WHERE dedupe_key = ANY($1)", [[feeKey, poKey]]);
    const hk = await handlers.integrations_housekeeping({ db: t.db });
    assert.ok(hk.fees >= 1 && hk.payouts >= 1, JSON.stringify(hk));
    await handlers.integrations_housekeeping({ db: t.db });
    assert.equal((await byKey(feeKey)).filter((j) => j.status === 'queued').length, 1);
    assert.equal((await byKey(poKey)).filter((j) => j.status === 'queued').length, 1);
    assert.equal((await byKey(feeKey))[1].run_at <= new Date(), true, 'due now, not in two minutes');

    net.reset();
    net.on('GET', new RegExp(`/v1/payment_intents/${pi}\\?`), () => ({
      json: { id: pi, latest_charge: { id: 'ch_late', created: unix('2026-10-19T12:00:00Z'), balance_transaction: { id: 'txn_late', fee: 3075, net: 101925, currency: 'cad' } } },
    }));
    net.on('GET', new RegExp(`/v1/payouts/${po.id}\\?expand`), () => ({ json: { ...po, balance_transaction: { id: `txn_${po.id}`, fee: 0 } } }));
    net.on('GET', new RegExp(`/v1/balance_transactions\\?payout=${po.id}&`), () => ({ json: { has_more: false, data: [
      { id: 'txn_late_c', type: 'charge', amount: 105000, fee: 3075, created: unix('2026-10-19T12:00:00Z'), source: { id: 'ch_late', payment_intent: pi } },
      { id: 'txn_late_p', type: 'payout', amount: -101725, fee: 0, created: unix('2026-10-20T00:00:00Z'), source: po.id },
    ] } }));
    assert.deepEqual(await runQueued('stripe_fee_fetch', feeKey), { feeCents: 3075 });
    assert.equal((await getPayment(paymentId)).stripe.feeCents, 3075);
    assert.equal((await runQueued('stripe_payout_fetch', poKey)).queued, true);
    const row = await payoutRow(A.tenantId, po.id);
    assert.equal(row.balance_txns.length, 2);
    assert.deepEqual(row.payment_intent_ids, [pi]);
    assert.ok(await outboxRow(A.tenantId, po.id), 'queued for QuickBooks');

    // Done: nothing is asked again for these two.
    await t.superPool.query("UPDATE jobs_queue SET finished_at = now() - interval '7 hours' WHERE dedupe_key = ANY($1)", [[feeKey, poKey]]);
    await handlers.integrations_housekeeping({ db: t.db });
    assert.equal((await byKey(feeKey)).filter((j) => j.status === 'queued').length, 0);
    assert.equal((await byKey(poKey)).filter((j) => j.status === 'queued').length, 0);
    assert.deepEqual(net.unexpected, []);
  });

  test('two events for a new payout at once: a failure is never overwritten by a late "paid"', async () => {
    const base = { id: `po_${hex(10)}`, amountCents: 7000, currency: 'cad', arrivalDate: '2026-10-22', automatic: false, livemode: true };
    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const inFirst = new Promise((r) => { entered = r; });
    // payout.failed arrives first and its transaction is still open when payout.paid arrives. Today's
    // callers also hold the company's write lock ({ write: true }), which serialises them anyway; the
    // row lock keeps it right without that (so these two do not take it).
    const first = t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      const r = await recordStripePayout(tx, { ...base, status: 'failed' });
      entered();
      await gate;
      return r;
    });
    await inFirst;
    const second = t.db.withTenant({ tenantId: A.tenantId }, (tx) => recordStripePayout(tx, { ...base, status: 'paid' }));
    await new Promise((r) => { setTimeout(r, 300); }); // the second now waits on the first's row
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'failed');
    assert.equal(b.status, 'failed', 'the second saw the first');
    assert.equal(b.inserted, false);
    assert.equal((await payoutRow(A.tenantId, base.id)).status, 'failed');
    assert.equal(await outboxRow(A.tenantId, base.id), undefined, 'no Transfer for a payout that failed before it was ever paid');
  });
});

describe('Amount due', { skip }, () => {
  test('amountDueCents is total − payments, plus a registered adjustment', async () => {
    await makeInvoice(A, 'inv-due', 106668); // $1,066.68 + 5% GST = $1,120.01
    const due = (fn) => t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      const inv = (await tx.query("SELECT id, data FROM invoices WHERE tenant_id = $1 AND id = 'inv-due'", [tx.tenantId])).rows[0];
      return fn(tx, { ...inv.data, id: inv.id });
    });
    assert.equal(await due(amountDueCents), 112001);
    const off = registerAmountDueAdjuster(async (tx, invoiceId) => (invoiceId === 'inv-due' ? -1 : 0));
    try {
      assert.equal(await due(amountDueCents), 112000, 'QuickBooks total');
      const bal = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => invoiceBalance(tx, 'inv-due'));
      assert.deepEqual([bal.totalCents, bal.paidCents, bal.adjustmentCents, bal.balanceCents], [112001, 0, -1, 112000]);

      // The pay link charges the amount due.
      net.reset();
      let sent;
      net.on('POST', /api\.stripe\.com\/v1\/checkout\/sessions$/, (c) => { sent = new URLSearchParams(c.body); return { json: { id: 'cs_test_due', url: 'https://checkout.stripe.com/c/pay/cs_test_due' } }; });
      const link = await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: A.token, body: { invoiceId: 'inv-due' } });
      assert.equal(link.status, 201, JSON.stringify(link.body));
      assert.equal(link.body.amountCents, 112000);
      assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '112000');

      // A QuickBooks payment of the QuickBooks total marks the Fishtape invoice paid.
      const who = systemWho(p(A.tenantId));
      const status = await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
        await records.createRecord(tx, p(A.tenantId), 'payments', { id: 'pay-due', invoiceId: 'inv-due', amountCents: 112000, date: '2026-10-20', method: 'check' }, who);
        return (await refreshInvoiceStatus(tx, records, p(A.tenantId), who, 'inv-due')).status;
      }, { write: true });
      assert.equal(status, 'paid');
    } finally {
      off();
    }
    assert.equal(await due(amountDueCents), 1, 'without the adjuster a cent is owing again');
  });

  test('a credit settlement payment from QuickBooks counts like any payment', async () => {
    await makeInvoice(A, 'inv-credit');
    const who = systemWho(p(A.tenantId));
    const b = await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
      await records.createRecord(tx, p(A.tenantId), 'payments', { id: 'pay-part', invoiceId: 'inv-credit', amountCents: 5000, date: '2026-10-20', method: 'cash' }, who);
      await records.createRecord(tx, p(A.tenantId), 'payments', {
        id: 'pay-credit', invoiceId: 'inv-credit', amountCents: 100000, date: '2026-10-20', method: 'credit', source: 'quickbooks', reference: 'Credited or paid in QuickBooks',
      }, who);
      return refreshInvoiceStatus(tx, records, p(A.tenantId), who, 'inv-credit');
    }, { write: true });
    assert.equal(b.balanceCents, 0);
    assert.equal(b.status, 'paid');
    const page = await call(app, { url: `/api/v1/invoices/inv-credit`, token: A.token });
    assert.equal(page.body.status, 'paid');
  });

  test('nothing left the fake network', () => {
    assert.deepEqual(net.unexpected, []);
  });
});
