// Plans on the server (writes outside the plan refused on REST and sync, reads open) and
// billing on Fishtape's own Stripe account: Checkout, portal, seats, and the signed
// webhook that sets plan and status, with a grace period on failed payments.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, apiKey, call, ownerTenant } from './support/app.js';
import { WEBHOOK_SECRET, hqUser, startHqApp } from './support/hq.js';
import { ensureStripeCatalog } from '../src/services/billing.js';

let t, app, stripe, A, B, admin, logs;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('billing');
  ({ app, stripe, logs } = await startHqApp(t));
  await ensureStripeCatalog(stripe);
  A = await ownerTenant(t, app, 'Amp Electric');
  B = await ownerTenant(t, app, 'Bolt Electric');
  admin = await hqUser(t, app, 'hq_admin');
});
after(async () => { await app?.close(); await t?.close(); });

const setPlan = (tenantId, body) => call(app, { method: 'PATCH', url: `/api/hq/tenants/${tenantId}/plan`, token: admin.token, body });
const tenant = async (id) => (await t.superPool.query('SELECT * FROM tenants WHERE id = $1', [id])).rows[0];

function signed(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}
let evn = 0;
async function deliver(type, object, { secret, header } = {}) {
  const event = { id: `evt_test_${++evn}_${Date.now()}`, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } };
  const s = signed(event, secret);
  const res = await app.inject({
    method: 'POST', url: '/api/v1/webhooks/platform-stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': header ?? s.header },
    payload: s.payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body || 'null'), event, payload: s.payload, header: s.header };
}

describe('plan entitlements on the API', { skip }, () => {
  test('a trial company has Business features', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { id: 'd-1', name: 'Ground floor' } });
    assert.equal(r.status, 201);
  });

  test('on Starter, writes to Pro modules are refused but reads stay open', async () => {
    await setPlan(A.tenantId, { plan: 'starter' });
    const w = await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { id: 'd-2', name: 'Basement' } });
    assert.equal(w.status, 403);
    assert.equal(w.body.error.code, 'feature_not_in_plan');
    assert.deepEqual(w.body.error.details, { feature: 'drawings', plan: 'pro' });
    assert.equal((await call(app, { method: 'PATCH', url: '/api/v1/drawings/d-1', token: A.token, body: { name: 'x' } })).body.error.code, 'feature_not_in_plan');
    assert.equal((await call(app, { method: 'DELETE', url: '/api/v1/drawings/d-1', token: A.token })).body.error.code, 'feature_not_in_plan');
    const list = await call(app, { url: '/api/v1/drawings', token: A.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((d) => d.id), ['d-1'], 'existing data is still readable');
    assert.equal((await call(app, { url: '/api/v1/drawings/d-1', token: A.token })).status, 200);
    // Starter modules and settings keep working.
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/clients', token: A.token, body: { name: 'Starter client' } })).status, 201);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/settings', token: A.token, body: { id: 'settings', currency: 'CAD' } })).status, 201);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/items', token: A.token, body: { name: 'Box' } })).body.error.code, 'feature_not_in_plan');
  });

  test('sync push refuses each out-of-plan mutation on its own; pull still returns everything', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/sync/push', token: A.token, body: { mutations: [
      { mid: 'm-1', collection: 'drawings', id: 'd-3', op: 'upsert', baseVersion: null, data: { name: 'Attic' } },
      { mid: 'm-2', collection: 'clients', id: 'c-9', op: 'upsert', baseVersion: null, data: { name: 'Synced client' } },
      { mid: 'm-3', collection: 'panels', id: 'p-1', op: 'upsert', baseVersion: null, data: { name: 'Panel A' } },
      { mid: 'm-4', collection: 'drawings', id: 'd-1', op: 'delete', baseVersion: 1, data: {} },
    ] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x) => x.status), ['rejected', 'ok', 'rejected', 'rejected']);
    assert.equal(r.body.results[0].error.code, 'feature_not_in_plan');
    assert.equal(r.body.results[2].error.details.feature, 'panels');
    const pull = await call(app, { url: '/api/v1/sync/pull?since=0', token: A.token });
    assert.ok(pull.body.changes.some((c) => c.collection === 'drawings' && c.id === 'd-1'));
  });

  test('HQ overrides win over the plan, both ways', async () => {
    await setPlan(A.tenantId, { overrides: { drawings: true } });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { id: 'd-4', name: 'Garage' } })).status, 201);
    await setPlan(A.tenantId, { plan: 'business', overrides: { panels: false } });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/panels', token: A.token, body: { name: 'Panel B' } })).body.error.code, 'feature_not_in_plan');
    await setPlan(A.tenantId, { plan: 'trial', overrides: {} });
  });

  test('API keys need the api feature to write', async () => {
    const key = await apiKey(app, A.token, ['clients:write']);
    await setPlan(A.tenantId, { plan: 'pro' });
    const w = await call(app, { method: 'POST', url: '/api/v1/clients', token: key, body: { name: 'Via API' } });
    assert.equal(w.body.error.details.feature, 'api');
    assert.equal((await call(app, { url: '/api/v1/clients', token: key })).status, 200, 'reads stay open');
    await setPlan(A.tenantId, { plan: 'business' });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/clients', token: key, body: { name: 'Via API' } })).status, 201);
    await setPlan(A.tenantId, { plan: 'trial' });
  });

  test('an expired trial drops to Starter', async () => {
    await setPlan(B.tenantId, { trialEndsAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/drawings', token: B.token, body: { name: 'x' } })).body.error.code, 'feature_not_in_plan');
    await setPlan(B.tenantId, { trialEndsAt: null });
  });
});

describe('billing for owners and admins', { skip }, () => {
  test('only owners and admins see billing', async () => {
    const office = await addMember(t, app, A.tenantId, { role: 'office' });
    assert.equal((await call(app, { url: '/api/v1/billing', token: office.token })).status, 403);
    const key = await apiKey(app, A.token, ['*:read']);
    assert.equal((await call(app, { url: '/api/v1/billing', token: key })).status, 403);
    const r = await call(app, { url: '/api/v1/billing', token: A.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan, 'business');
    assert.equal(r.body.onTrial, true);
    assert.equal(r.body.seats.used, 2);
    assert.equal(r.body.stripeConfigured, true);
    assert.ok(!JSON.stringify(r.body).includes('cus_'), 'no Stripe ids in the browser');
  });

  test('checkout creates one customer and a session with extra users beyond the plan', async () => {
    for (let i = 0; i < 2; i++) await addMember(t, app, A.tenantId, { role: 'electrician', signIn: false });
    // 4 members on Starter (2 included) -> 2 extra users
    const r = await call(app, { method: 'POST', url: '/api/v1/billing/checkout', token: A.token, body: { plan: 'starter' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\//);
    const s = stripe.state.checkoutSessions.at(-1);
    assert.equal(s.mode, 'subscription');
    assert.equal(s.client_reference_id, A.tenantId);
    assert.equal(s.line_items.length, 2);
    assert.equal(s.line_items[1].quantity, 2);
    assert.match(s.success_url, /#\/billing\?checkout=done$/);
    await call(app, { method: 'POST', url: '/api/v1/billing/checkout', token: A.token, body: { plan: 'pro' } });
    assert.equal(stripe.state.customers.size, 1, 'the customer is created once');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/billing/checkout', token: A.token, body: { plan: 'enterprise' } })).status, 400);
    const ev = await t.superPool.query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'billing.checkout_started'", [A.tenantId]);
    assert.equal(ev.rows.length, 2);
  });

  test('the portal needs a customer', async () => {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/billing/portal', token: B.token })).body.error.code, 'no_subscription');
    const r = await call(app, { method: 'POST', url: '/api/v1/billing/portal', token: A.token });
    assert.match(r.body.url, /^https:\/\/billing\.stripe\.test\//);
  });
});

describe('platform Stripe webhook', { skip }, () => {
  let sub;

  test('a forged, missing or stale signature is refused and changes nothing', async () => {
    const forged = await deliver('customer.subscription.updated', { id: 'sub_x', customer: 'cus_x', status: 'active' }, { secret: 'whsec_wrong' });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, 'invalid_signature');
    const missing = await app.inject({ method: 'POST', url: '/api/v1/webhooks/platform-stripe', headers: { 'content-type': 'application/json' }, payload: '{"id":"evt_1","type":"invoice.paid"}' });
    assert.equal(missing.statusCode, 400);
    // A valid signature for one body does not cover another.
    const ok = signed({ id: 'evt_a', type: 'invoice.paid', data: { object: {} } });
    const swapped = await app.inject({ method: 'POST', url: '/api/v1/webhooks/platform-stripe', headers: { 'content-type': 'application/json', 'stripe-signature': ok.header }, payload: ok.payload.replace('invoice.paid', 'invoice.payment_failed') });
    assert.equal(swapped.statusCode, 400);
    const old = Stripe.webhooks.generateTestHeaderString({ payload: ok.payload, secret: WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const stale = await app.inject({ method: 'POST', url: '/api/v1/webhooks/platform-stripe', headers: { 'content-type': 'application/json', 'stripe-signature': old }, payload: ok.payload });
    assert.equal(stale.statusCode, 400);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM billing_events')).rows[0].n, 0);
  });

  test('checkout.session.completed sets the plan from the subscription (no CSRF header needed)', async () => {
    const cust = (await tenant(A.tenantId)).stripe_customer_id;
    sub = stripe.addSubscription({ customer: cust, tenantId: A.tenantId, plan: 'pro', extra: 0 });
    const r = await deliver('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', customer: cust, client_reference_id: A.tenantId, subscription: sub.id, amount_total: 12900, currency: 'cad' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await tenant(A.tenantId);
    assert.equal(row.plan, 'pro');
    assert.equal(row.billing_status, 'active');
    assert.equal(row.billing_plan, 'pro');
    assert.equal(row.stripe_subscription_id, sub.id);
    const ev = await t.superPool.query("SELECT summary, actor_type FROM audit_events WHERE tenant_id = $1 AND action = 'billing.subscription'", [A.tenantId]);
    assert.match(ev.rows[0].summary, /trial -> pro/);
    // The same event again is a no-op.
    const again = await app.inject({ method: 'POST', url: '/api/v1/webhooks/platform-stripe', headers: { 'content-type': 'application/json', 'stripe-signature': r.header }, payload: r.payload });
    assert.equal(JSON.parse(again.body).outcome, 'duplicate');
  });

  test('changing plan on a live subscription updates it in place', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/billing/checkout', token: A.token, body: { plan: 'business' } });
    assert.deepEqual(r.body, { changed: true, plan: 'business' });
    assert.equal((await tenant(A.tenantId)).plan, 'business');
    const live = stripe.state.subscriptions.get(sub.id);
    assert.equal(live.items.data[0].price.lookup_key, 'fishtape_business_monthly_cad');
  });

  test('seats: extra users beyond the plan are billed', async () => {
    // Business includes 25; move to Starter (2 included) with 4 members -> 2 extra.
    await call(app, { method: 'POST', url: '/api/v1/billing/checkout', token: A.token, body: { plan: 'starter' } });
    const live = stripe.state.subscriptions.get(sub.id);
    const extra = live.items.data.find((i) => i.price.lookup_key === 'fishtape_extra_user_monthly_cad');
    assert.equal(extra.quantity, 2);
    await addMember(t, app, A.tenantId, { role: 'apprentice', signIn: false });
    const s = await call(app, { method: 'POST', url: '/api/v1/billing/seats/sync', token: A.token });
    assert.deepEqual({ seats: s.body.seats, extra: s.body.extra, changed: s.body.changed }, { seats: 5, extra: 3, changed: true });
    const info = await call(app, { url: '/api/v1/billing', token: A.token });
    assert.deepEqual(info.body.seats, { used: 5, included: 2, extra: 3, billed: 5 });
    assert.equal(info.body.monthlyCents, 4900 + 3 * 1500);
  });

  test('a failed payment starts the grace period; after it the company falls back; a payment restores it', async () => {
    await call(app, { method: 'POST', url: '/api/v1/billing/checkout', token: A.token, body: { plan: 'pro' } });
    const cust = (await tenant(A.tenantId)).stripe_customer_id;
    const f = await deliver('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: cust, amount_due: 12900, currency: 'cad', attempt_count: 1 });
    assert.equal(f.status, 200);
    let row = await tenant(A.tenantId);
    assert.equal(row.billing_status, 'past_due');
    const days = (new Date(row.grace_ends_at) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1, `grace ${days} days`);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { name: 'During grace' } })).status, 201, 'features stay on during grace');

    await t.superPool.query("UPDATE tenants SET grace_ends_at = now() - interval '1 minute' WHERE id = $1", [A.tenantId]);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { name: 'After grace' } })).body.error.code, 'feature_not_in_plan');
    assert.equal((await call(app, { url: '/api/v1/billing', token: A.token })).body.plan, 'starter');

    await deliver('invoice.paid', { id: 'in_1', object: 'invoice', customer: cust, amount_paid: 12900, currency: 'cad' });
    row = await tenant(A.tenantId);
    assert.equal(row.billing_status, 'active');
    assert.equal(row.grace_ends_at, null);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/drawings', token: A.token, body: { name: 'Paid again' } })).status, 201);
    const log = await call(app, { url: '/api/v1/auditLog?action=billing.payment_failed', token: A.token });
    assert.equal(log.body.data.length, 1, 'the owner sees it in their log');
  });

  test('a cancelled subscription falls back to Starter; an unknown customer is recorded and ignored', async () => {
    const live = structuredClone(stripe.state.subscriptions.get(sub.id));
    const r = await deliver('customer.subscription.deleted', { ...live, status: 'canceled' });
    assert.equal(r.status, 200);
    const row = await tenant(A.tenantId);
    assert.equal(row.plan, 'starter');
    assert.equal(row.billing_status, 'canceled');
    assert.equal(row.stripe_subscription_id, null);
    const u = await deliver('invoice.payment_failed', { id: 'in_2', customer: 'cus_unknown', amount_due: 100, currency: 'cad' });
    assert.equal(u.body.outcome, 'unknown_customer');
    // Metadata cannot point another company's customer at this one.
    const sneaky = await deliver('customer.subscription.updated', { id: 'sub_sneaky', customer: 'cus_other', status: 'active', metadata: { tenant_id: A.tenantId }, items: { data: [] } });
    assert.equal(sneaky.body.outcome, 'unknown_customer');
    assert.equal((await tenant(A.tenantId)).stripe_customer_id !== 'cus_other', true);
  });

  test('HQ billing shows subscriptions, plan mix and failed payments', async () => {
    const r = await call(app, { url: '/api/hq/billing', token: admin.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.stripeConfigured, true);
    assert.equal(r.body.failedPayments.length, 2);
    assert.ok(r.body.subscriptions.some((s) => s.tenantId === A.tenantId));
    assert.ok(r.body.planMix.starter >= 1);
    assert.ok(!JSON.stringify(r.body).includes('cus_test'), 'no Stripe customer ids');
  });

  test('webhook logs carry the event type, not its contents', () => {
    const text = logs.text();
    assert.ok(text.includes('invoice.payment_failed'));
    assert.ok(!text.includes('cus_unknown'));
  });
});

describe('Stripe catalogue set-up', { skip }, () => {
  test('is idempotent by lookup key and replaces a changed price', async () => {
    const again = await ensureStripeCatalog(stripe);
    assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    const pro = stripe.state.prices.find((p) => p.lookup_key === 'fishtape_pro_monthly_cad');
    pro.unit_amount = 9999; // someone edited it in the dashboard
    const fixed = await ensureStripeCatalog(stripe);
    assert.equal(fixed.find((x) => x.key === 'pro').action, 'replaced');
    assert.equal(pro.active, false);
    assert.equal(stripe.state.prices.filter((p) => p.lookup_key === 'fishtape_pro_monthly_cad').length, 1);
    assert.equal(stripe.state.products.size, 4);
  });
});
