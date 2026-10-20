// Integrations against a real Postgres: connecting keys (never returned), connection tests,
// entitlement refusals, Stripe pay links and signed webhooks (forged, cross-tenant, replayed),
// the outbox sender for Resend and Twilio (STOP handling), Facebook Lead Ads, and logs.
// Every provider is faked through setFetch(); a call to anything not faked fails the test.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { ORIGIN, addMember, call as rawCall, ownerTenant, startApp } from './support/app.js';
import { setFetch } from '../src/integrations/http.js';
import { stripeTestHeader } from '../src/integrations/stripe.js';
import { twilioSignature } from '../src/integrations/twilio.js';
import { createIntegrationHandlers } from '../src/integrations/jobs.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import { HANDLERS, runOnce } from '../src/services/queue.js';

const hex = (n) => randomBytes(n).toString('hex');
const KEYS = {
  A: {
    stripe: `sk_test_${hex(12)}`, whsec: `whsec_${hex(16)}`, resend: `re_${hex(12)}`, sid: `AC${hex(16)}`, token: hex(16),
    page: `EAA${hex(20)}`, app: hex(16), verify: `verify-${hex(10)}`, anthropic: `sk-ant-api03-${hex(16)}`,
  },
  B: {
    stripe: `sk_test_${hex(12)}`, whsec: `whsec_${hex(16)}`, resend: `re_${hex(12)}`, sid: `AC${hex(16)}`, token: hex(16),
    page: `EAA${hex(20)}`, app: hex(16), verify: `verify-${hex(10)}`, anthropic: `sk-ant-api03-${hex(16)}`,
  },
};
// The Twilio Account SID is an identifier (like a username), shown in full so people can see
// which account is connected (SECRETS marks it plain). Everything else is a secret.
const secretValues = (k) => Object.entries(k).filter(([n]) => n !== 'sid').map(([, v]) => v);
const SECRET_VALUES = [...secretValues(KEYS.A), ...secretValues(KEYS.B)];
const PII = { email: 'pat.customer@example.com', phone: '403-555-0199', name: 'Pat Customer' };

/** Fake provider network: register handlers by host+path; anything else is recorded as unexpected. */
const net = {
  calls: [], unexpected: [], routes: [],
  on(method, re, reply) { this.routes.unshift({ method, re, reply }); },
  reset() { this.calls.length = 0; this.routes.length = 0; },
  async fetch(url, init = {}) {
    const u = String(url);
    const method = init.method || 'GET';
    const call = { url: u, method, headers: init.headers || {}, body: init.body };
    net.calls.push(call);
    const r = net.routes.find((x) => x.method === method && x.re.test(u));
    if (!r) { net.unexpected.push(`${method} ${u}`); throw new Error('no network in tests'); }
    const { status = 200, json = {} } = await r.reply(call);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  },
};

let t, app, logs, A, B, office, handlers;
const bodies = [];
async function call(a, o) {
  const r = await rawCall(a, o);
  bodies.push(r.raw.body);
  return r;
}
const run = (job) => handlers.integrations_dispatch({ db: t.db, job: { payload: { once: true }, ...job } });

before(async () => {
  if (skip) return;
  setFetch((u, i) => net.fetch(u, i));
  t = await createTestDatabase('integrations');
  ({ app, logs } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Electric');
  B = await ownerTenant(t, app, 'Bravo Electric');
  office = await addMember(t, app, A.tenantId, { role: 'office' });
  handlers = createIntegrationHandlers({ sealer: app.sealer, records: createRecords({ validator: createValidator() }) });
  for (const [who, name] of [[A, 'Alpha Electric'], [B, 'Bravo Electric']]) {
    const s = await call(app, { method: 'POST', url: '/api/v1/settings', token: who.token, body: { id: 'settings', currency: 'CAD', company: { name, province: 'AB', phone: '403-555-0100', email: `office@${name.split(' ')[0].toLowerCase()}.test`, address: '1 Main St, Calgary' } } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
  }
});
after(async () => { setFetch(null); await app?.close(); await t?.close(); });

const put = (who, provider, body) => call(app, { method: 'PUT', url: `/api/v1/integrations/${provider}`, token: who.token, body });
const connect = {
  stripe: (who, k) => put(who, 'stripe', { secrets: { 'stripe.secret_key': k.stripe, 'stripe.webhook_secret': k.whsec } }),
  resend: (who, k) => put(who, 'resend', { secrets: { 'resend.api_key': k.resend, 'resend.from': 'Alpha Electric <office@alpha.test>' } }),
  twilio: (who, k) => put(who, 'twilio', { secrets: { 'twilio.account_sid': k.sid, 'twilio.auth_token': k.token, 'twilio.from': '(403) 555-0100' } }),
  facebook: (who, k, config = {}) => put(who, 'facebook', { secrets: { 'facebook.page_token': k.page, 'facebook.app_secret': k.app, 'facebook.verify_token': k.verify }, config }),
};

async function makeInvoice(who, id, { status = 'sent' } = {}) {
  await call(app, { method: 'POST', url: '/api/v1/clients', token: who.token, body: { id: `client-${id}`, name: PII.name, email: PII.email, phone: PII.phone } });
  const r = await call(app, { method: 'POST', url: '/api/v1/invoices', token: who.token, body: {
    id, number: `INV-${id}`, clientId: `client-${id}`, status, issueDate: '2026-10-19', dueDate: '2026-11-02',
    lines: [{ description: 'Panel upgrade', qty: 1, unitCents: 100000, kind: 'labour' }],
    taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }], taxPct: 5,
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

describe('connecting keys', { skip }, () => {
  test('the screen lists every provider, not connected, with webhook URLs and guides', async () => {
    const r = await call(app, { url: '/api/v1/integrations', token: A.token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.map((c) => c.provider), ['stripe', 'resend', 'sendgrid', 'twilio', 'facebook', 'anthropic']);
    for (const c of r.body.data) { assert.equal(c.status, 'not_connected'); assert.equal(c.entitled, true); assert.equal(c.guide, `guides/${c.provider}.md`); }
    assert.equal(r.body.data[0].webhookUrl, `${ORIGIN}/api/v1/webhooks/stripe/${A.tenantId}`);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('keys are saved once and only hints come back', async () => {
    const r = await connect.stripe(A, KEYS.A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'connected');
    const key = r.body.fields.find((f) => f.name === 'stripe.secret_key');
    assert.equal(key.hint, `…${KEYS.A.stripe.slice(-4)}`);
    assert.ok(!JSON.stringify(r.body).includes(KEYS.A.stripe));
    for (const p of ['resend', 'twilio']) assert.equal((await connect[p](A, KEYS.A)).status, 200);
    const fb = await connect.facebook(A, KEYS.A);
    assert.equal(fb.status, 200, JSON.stringify(fb.body));
    const tw = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((c) => c.provider === 'twilio');
    assert.equal(tw.fields.find((f) => f.name === 'twilio.from').hint, '+14035550100', 'numbers are stored as E.164');
  });

  test('bad keys are refused without echoing them; unknown fields are refused', async () => {
    const bad = await put(A, 'stripe', { secrets: { 'stripe.secret_key': 'pk_live_publishable-not-secret' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'validation_failed');
    assert.ok(!JSON.stringify(bad.body).includes('publishable-not-secret'));
    const other = await put(A, 'stripe', { secrets: { 'resend.api_key': KEYS.A.resend } });
    assert.equal(other.status, 400);
    const cfg = await put(A, 'stripe', { config: { anything: 'x' } });
    assert.equal(cfg.status, 400);
  });

  test('only owners and admins manage integrations', async () => {
    assert.equal((await call(app, { url: '/api/v1/integrations', token: office.token })).status, 403);
    assert.equal((await put(office, 'stripe', { secrets: { 'stripe.secret_key': KEYS.A.stripe } })).status, 403);
    assert.equal((await call(app, { method: 'DELETE', url: '/api/v1/integrations/stripe', token: office.token })).status, 403);
    const avail = await call(app, { url: '/api/v1/integrations/available', token: office.token });
    assert.equal(avail.status, 200);
    assert.deepEqual(avail.body, { payments: true, email: true, sms: true });
  });

  test('connection tests use a cheap read-only call per provider', async () => {
    net.reset();
    net.on('GET', /api\.stripe\.com\/v1\/checkout\/sessions\?limit=1$/, () => ({ json: { data: [] } }));
    net.on('GET', /api\.resend\.com\/domains$/, () => ({ json: { data: [{ name: 'alpha.test', status: 'verified' }] } }));
    net.on('GET', /api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-f]+\.json$/, () => ({ json: { status: 'active', type: 'Full' } }));
    net.on('GET', /IncomingPhoneNumbers\.json/, () => ({ json: { incoming_phone_numbers: [{ phone_number: '+14035550100' }] } }));
    net.on('GET', /graph\.facebook\.com\/v\d+\.0\/me\?/, () => ({ json: { id: '1234567890', name: 'Alpha Electric' } }));
    net.on('GET', /graph\.facebook\.com\/v\d+\.0\/1234567890\/subscribed_apps/, () => ({ json: { data: [{ subscribed_fields: ['leadgen'] }] } }));
    net.on('GET', /api\.anthropic\.com\/v1\/models\?limit=1$/, () => ({ json: { data: [{ id: 'claude-opus-5-5' }] } }));
    assert.equal((await put(A, 'anthropic', { secrets: { 'anthropic.api_key': KEYS.A.anthropic } })).status, 200);
    for (const p of ['stripe', 'resend', 'twilio', 'facebook', 'anthropic']) {
      const r = await call(app, { method: 'POST', url: `/api/v1/integrations/${p}/test`, token: A.token });
      assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'ok', `${p}: ${r.body.message}`);
    }
    assert.ok(net.calls.every((c) => c.method === 'GET'), 'tests never change anything');
    const anth = net.calls.find((c) => c.url.includes('anthropic'));
    assert.equal(anth.headers['x-api-key'], KEYS.A.anthropic);
    assert.equal(anth.headers['anthropic-version'], '2023-06-01');
    assert.ok(net.calls.filter((c) => c.url.includes('facebook')).every((c) => !c.url.includes(KEYS.A.page)), 'the Page token never goes in a URL');
    const fb = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((c) => c.provider === 'facebook');
    assert.equal(fb.config.pageId, '1234567890', 'the test fills in the Page ID');

    net.on('GET', /api\.stripe\.com\/v1\/checkout\/sessions\?limit=1$/, () => ({ status: 401, json: { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${KEYS.A.stripe}` } } }));
    const bad = await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/test', token: A.token });
    assert.equal(bad.body.status, 'error');
    assert.ok(!JSON.stringify(bad.body).includes(KEYS.A.stripe), 'provider error text is not passed through with the key');
    const card = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((c) => c.provider === 'stripe');
    assert.equal(card.status, 'error');
    net.on('GET', /api\.stripe\.com\/v1\/checkout\/sessions\?limit=1$/, () => ({ json: { data: [] } }));
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/test', token: A.token })).body.status, 'ok');
  });

  test('plans: Starter cannot connect Pro/Business integrations, but can always disconnect', async () => {
    await t.superPool.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [B.tenantId]);
    const list = (await call(app, { url: '/api/v1/integrations', token: B.token })).body.data;
    assert.ok(list.every((c) => c.entitled === false));
    assert.equal(list.find((c) => c.provider === 'stripe').planName, 'Pro');
    assert.equal(list.find((c) => c.provider === 'twilio').plan, 'business');
    for (const p of ['stripe', 'resend', 'twilio', 'facebook', 'anthropic']) {
      const r = await put(B, p, { secrets: {} });
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error.code, 'feature_not_in_plan');
      assert.equal((await call(app, { method: 'POST', url: `/api/v1/integrations/${p}/test`, token: B.token })).status, 403);
    }
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: B.token, body: { invoiceId: 'x' } })).status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/email/document', token: B.token, body: { collection: 'invoices', id: 'x' } })).status, 403);
    assert.equal((await call(app, { method: 'DELETE', url: '/api/v1/integrations/stripe', token: B.token })).status, 204);
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [B.tenantId]);
    assert.equal((await connect.stripe(B, KEYS.B)).status, 200, 'Pro includes online payments');
    assert.equal((await connect.twilio(B, KEYS.B)).status, 403, 'SMS is Business');
  });
});

describe('Stripe payments', { skip }, () => {
  let payUrl;
  const sessionFor = (tenantId, invoiceId, amount, extra = {}) => ({
    id: `cs_test_${hex(8)}`, object: 'checkout.session', payment_status: 'paid', amount_total: amount, currency: 'cad',
    payment_intent: `pi_${hex(8)}`, created: Math.floor(Date.now() / 1000), livemode: false,
    metadata: { fishtape_tenant: tenantId, fishtape_invoice: invoiceId }, ...extra,
  });
  const event = (session, type = 'checkout.session.completed', id = `evt_${hex(8)}`) => JSON.stringify({ id, object: 'event', type, data: { object: session } });
  const postStripe = (tenantId, payload, secret, headers = {}) => call(app, {
    method: 'POST', url: `/api/v1/webhooks/stripe/${tenantId}`, csrf: false, body: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': stripeTestHeader(payload, secret), ...headers },
  });

  test('"Pay online" makes a lasting pay link and a Checkout Session for the balance', async () => {
    await makeInvoice(A, 'inv-a1');
    net.reset();
    let sent;
    net.on('POST', /api\.stripe\.com\/v1\/checkout\/sessions$/, (c) => { sent = new URLSearchParams(c.body); return { json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: 1900000000 } }; });
    const r = await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: office.token, body: { invoiceId: 'inv-a1' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.amountCents, 105000, 'labour 1000.00 + GST 5%');
    assert.equal(r.body.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.match(r.body.payUrl, new RegExp(`^${ORIGIN}/api/v1/pay/${A.tenantId}/[A-Za-z0-9_-]{43}$`));
    payUrl = r.body.payUrl;
    assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '105000');
    assert.equal(sent.get('line_items[0][price_data][currency]'), 'cad');
    assert.equal(sent.get('metadata[fishtape_tenant]'), A.tenantId);
    assert.equal(sent.get('metadata[fishtape_invoice]'), 'inv-a1');
    assert.equal(net.calls[0].headers.authorization, `Bearer ${KEYS.A.stripe}`);
    const inv = await call(app, { url: '/api/v1/invoices/inv-a1', token: A.token });
    assert.equal(inv.body.payLink.url, payUrl, 'the link is on the invoice, so it syncs and prints');
    const again = await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: A.token, body: { invoiceId: 'inv-a1' } });
    assert.equal(again.body.payUrl, payUrl, 'asking again keeps the printed link working');
  });

  test('the public pay link opens Checkout; wrong tokens and other companies get nothing', async () => {
    const path = payUrl.slice(ORIGIN.length);
    const r = await call(app, { url: path });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, 'https://checkout.stripe.com/c/pay/cs_test_1');
    const token = path.split('/').pop();
    assert.equal((await call(app, { url: `/api/v1/pay/${A.tenantId}/${'x'.repeat(43)}` })).status, 404);
    assert.equal((await call(app, { url: `/api/v1/pay/${B.tenantId}/${token}` })).status, 404, "A's token does not work under B");
    assert.equal((await call(app, { url: `/api/v1/pay/not-a-uuid/${token}` })).status, 404);
    const page = await call(app, { url: `/api/v1/pay/${A.tenantId}/nope` });
    assert.match(page.raw.body, /not valid/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  });

  test('a signed webhook records the payment and marks the invoice paid, once', async () => {
    const s = sessionFor(A.tenantId, 'inv-a1', 105000);
    const payload = event(s);
    const r = await postStripe(A.tenantId, payload, KEYS.A.whsec);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pays = await call(app, { url: '/api/v1/payments?invoiceId=inv-a1', token: A.token });
    assert.equal(pays.body.data.length, 1);
    assert.equal(pays.body.data[0].amountCents, 105000);
    assert.equal(pays.body.data[0].method, 'card');
    assert.equal(pays.body.data[0].id, `stripe-${s.payment_intent}`);
    assert.equal((await call(app, { url: '/api/v1/invoices/inv-a1', token: A.token })).body.status, 'paid');

    const replay = await postStripe(A.tenantId, payload, KEYS.A.whsec);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    const second = await postStripe(A.tenantId, event(s, 'checkout.session.async_payment_succeeded'), KEYS.A.whsec);
    assert.equal(second.status, 200);
    assert.equal((await call(app, { url: '/api/v1/payments?invoiceId=inv-a1', token: A.token })).body.data.length, 1, 'same PaymentIntent, one payment');

    const sync = await call(app, { url: '/api/v1/sync/pull?since=0&limit=1000', token: A.token });
    assert.ok(sync.body.changes.some((c) => c.collection === 'payments' && c.id === `stripe-${s.payment_intent}`), 'the payment reaches devices through sync');
    const audit = await call(app, { url: `/api/v1/auditLog?recordId=stripe-${s.payment_intent}`, token: A.token });
    assert.equal(audit.body.data[0].actorType, 'system');

    const paid = await call(app, { url: payUrl.slice(ORIGIN.length) });
    assert.equal(paid.status, 200);
    assert.match(paid.raw.body, /Paid in full/);
  });

  test('forged, tampered, stale and cross-tenant webhooks are refused', async () => {
    await makeInvoice(A, 'inv-a2');
    const payload = event(sessionFor(A.tenantId, 'inv-a2', 105000));
    const forged = await postStripe(A.tenantId, payload, `whsec_${hex(16)}`);
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, 'invalid_signature');
    const header = stripeTestHeader(payload, KEYS.A.whsec);
    const tampered = await call(app, { method: 'POST', url: `/api/v1/webhooks/stripe/${A.tenantId}`, csrf: false, body: payload.replace('105000', '1'), headers: { 'content-type': 'application/json', 'stripe-signature': header } });
    assert.equal(tampered.status, 400);
    const stale = await call(app, { method: 'POST', url: `/api/v1/webhooks/stripe/${A.tenantId}`, csrf: false, body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': stripeTestHeader(payload, KEYS.A.whsec, Math.floor(Date.now() / 1000) - 3600) } });
    assert.equal(stale.status, 400, 'older than five minutes');
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/webhooks/stripe/${A.tenantId}`, csrf: false, body: payload, headers: { 'content-type': 'application/json' } })).status, 400);

    // A's secret cannot post into B.
    const intoB = await postStripe(B.tenantId, event(sessionFor(B.tenantId, 'inv-a2', 105000)), KEYS.A.whsec);
    assert.equal(intoB.status, 400);
    // B's own valid webhook naming A's tenant and invoice changes nothing anywhere.
    const crossMeta = await postStripe(B.tenantId, payload, KEYS.B.whsec);
    assert.equal(crossMeta.status, 200);
    assert.equal((await call(app, { url: '/api/v1/payments?invoiceId=inv-a2', token: A.token })).body.data.length, 0);
    assert.equal((await call(app, { url: '/api/v1/payments', token: B.token })).body.data.length, 0);
    // Unknown company: same answer as a bad signature.
    const ghost = await postStripe('00000000-0000-4000-8000-000000000000', payload, KEYS.A.whsec);
    assert.equal(ghost.status, 400);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/webhooks/stripe/nope', csrf: false, body: payload, headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await call(app, { url: '/api/v1/invoices/inv-a2', token: A.token })).body.status, 'sent');
  });

  test('void and paid invoices cannot get a pay link; other companies\' invoices are not found', async () => {
    await makeInvoice(A, 'inv-void', { status: 'void' });
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: A.token, body: { invoiceId: 'inv-void' } })).body.error.code, 'invoice_void');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: A.token, body: { invoiceId: 'inv-a1' } })).body.error.code, 'invoice_paid');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: B.token, body: { invoiceId: 'inv-a2' } })).status, 404);
  });
});

describe('outbox: email and SMS', { skip }, () => {
  const queue = (who, body) => call(app, { method: 'POST', url: '/api/v1/outbox', token: who.token, body: { status: 'queued', relatedId: 'lead-1', ...body } });

  test('due emails go out through the company\'s Resend account and are marked sent', async () => {
    net.reset();
    const sent = [];
    net.on('POST', /api\.resend\.com\/emails$/, (c) => { sent.push(c); return { json: { id: `email_${sent.length}` } }; });
    const due = await queue(A, { channel: 'email', to: PII.email, subject: 'Thanks for getting in touch', body: 'Hi Pat, thanks!', dueAt: new Date(Date.now() - 60000).toISOString() });
    const later = await queue(A, { channel: 'email', to: PII.email, subject: 'Later', body: 'Later', dueAt: new Date(Date.now() + 86400000).toISOString() });
    const task = await queue(A, { channel: 'task', subject: 'Call Pat', body: 'x' });
    const r = await run();
    assert.equal(r.sent, 1, JSON.stringify(r));
    const m = JSON.parse(sent[0].body);
    assert.equal(sent[0].headers.authorization, `Bearer ${KEYS.A.resend}`);
    assert.equal(sent[0].headers['idempotency-key'], `fishtape-outbox-${due.body.id}`);
    assert.equal(m.from, 'Alpha Electric <office@alpha.test>');
    assert.deepEqual(m.to, [PII.email]);
    assert.equal(m.reply_to, 'office@alpha.test');
    assert.match(m.text, /To stop these emails, reply with "unsubscribe"/, 'CASL: sender and unsubscribe in follow-ups');
    assert.match(m.text, /Alpha Electric · 1 Main St, Calgary/);
    const after1 = (await call(app, { url: `/api/v1/outbox/${due.body.id}`, token: A.token })).body;
    assert.equal(after1.status, 'sent');
    assert.equal(after1.providerMessageId, 'email_1');
    assert.equal((await call(app, { url: `/api/v1/outbox/${later.body.id}`, token: A.token })).body.status, 'queued', 'not due yet');
    assert.equal((await call(app, { url: `/api/v1/outbox/${task.body.id}`, token: A.token })).body.status, 'queued', 'tasks stay for people');
    assert.equal((await run()).sent, 0, 'nothing is sent twice');
  });

  test('provider errors land on the outbox item: permanent ones fail, temporary ones retry', async () => {
    net.reset();
    net.on('POST', /api\.resend\.com\/emails$/, () => ({ status: 422, json: { name: 'invalid_parameter', message: `Invalid to: ${PII.email}` } }));
    const bad = await queue(A, { channel: 'email', to: PII.email, subject: 'x', body: 'x' });
    await run();
    const b = (await call(app, { url: `/api/v1/outbox/${bad.body.id}`, token: A.token })).body;
    assert.equal(b.status, 'failed');
    assert.match(b.error, /Resend rejected the request/);
    assert.ok(!b.error.includes(PII.email), 'addresses in provider messages are scrubbed');

    net.on('POST', /api\.resend\.com\/emails$/, () => ({ status: 503, json: { name: 'service_unavailable', message: 'down' } }));
    const flaky = await queue(A, { channel: 'email', to: PII.email, subject: 'x', body: 'x' });
    await run();
    const f = (await call(app, { url: `/api/v1/outbox/${flaky.body.id}`, token: A.token })).body;
    assert.equal(f.status, 'queued');
    assert.ok(Date.parse(f.retryAt) > Date.now());
    assert.equal(f.attempts, 1);

    const noAddr = await queue(A, { channel: 'email', to: '', subject: 'x', body: 'x' });
    net.on('POST', /api\.resend\.com\/emails$/, () => ({ status: 401, json: { name: 'validation_error', message: 'API key is invalid' } }));
    const authFail = await queue(A, { channel: 'email', to: PII.email, subject: 'x', body: 'x' });
    await run();
    assert.match((await call(app, { url: `/api/v1/outbox/${noAddr.body.id}`, token: A.token })).body.error, /no valid email address/);
    assert.equal((await call(app, { url: `/api/v1/outbox/${authFail.body.id}`, token: A.token })).body.status, 'failed');
    const card = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((c) => c.provider === 'resend');
    assert.equal(card.status, 'error', 'a refused key shows on the Integrations card');
    await call(app, { method: 'DELETE', url: `/api/v1/outbox/${flaky.body.id}`, token: A.token });
  });

  test('texts go out as E.164 with an opt-out line; STOP replies and Twilio opt-outs block later texts', async () => {
    net.reset();
    const texts = [];
    net.on('POST', /api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-f]+\/Messages\.json$/, (c) => {
      const p = new URLSearchParams(c.body);
      texts.push({ to: p.get('To'), from: p.get('From'), body: p.get('Body'), auth: c.headers.authorization });
      if (p.get('To') === '+14035550188') return { status: 400, json: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } };
      return { status: 201, json: { sid: `SM${hex(16)}`, status: 'queued' } };
    });
    const ok = await queue(A, { channel: 'sms', to: PII.phone, body: 'Hi Pat, it is Alpha Electric.' });
    const bad = await queue(A, { channel: 'sms', to: '12345', body: 'x' });
    const blocked = await queue(A, { channel: 'sms', to: '403 555 0188', body: 'x' });
    await run();
    assert.equal(texts[0].to, '+14035550199');
    assert.equal(texts[0].from, '+14035550100');
    assert.equal(texts[0].body, 'Hi Pat, it is Alpha Electric.\nReply STOP to opt out.');
    assert.equal(texts[0].auth, `Basic ${Buffer.from(`${KEYS.A.sid}:${KEYS.A.token}`).toString('base64')}`);
    assert.equal((await call(app, { url: `/api/v1/outbox/${ok.body.id}`, token: A.token })).body.status, 'sent');
    assert.match((await call(app, { url: `/api/v1/outbox/${bad.body.id}`, token: A.token })).body.error, /not a valid Canadian or US number/);
    const bl = (await call(app, { url: `/api/v1/outbox/${blocked.body.id}`, token: A.token })).body;
    assert.equal(bl.status, 'failed');
    assert.match(bl.error, /replied STOP/);

    // Twilio's opt-out was remembered: the next text to that number is not even attempted.
    texts.length = 0;
    const again = await queue(A, { channel: 'sms', to: '+1 403 555 0188', body: 'x' });
    await run();
    assert.equal(texts.length, 0);
    assert.equal((await call(app, { url: `/api/v1/outbox/${again.body.id}`, token: A.token })).body.status, 'failed');
  });

  test('inbound STOP / START from Twilio, signed with the company\'s token', async () => {
    const url = (tid) => `/api/v1/webhooks/twilio/${tid}`;
    const post = (tid, params, token) => call(app, {
      method: 'POST', url: url(tid), csrf: false, body: new URLSearchParams(params).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(token, `${ORIGIN}${url(tid)}`, params) },
    });
    const stop = { MessageSid: `SM${hex(16)}`, From: '+14035550177', To: '+14035550100', Body: ' stop ' };
    const r = await post(A.tenantId, stop, KEYS.A.token);
    assert.equal(r.status, 200);
    assert.match(r.raw.body, /<Response><\/Response>/);
    assert.equal((await post(A.tenantId, { ...stop, Body: 'STOP' }, `${hex(16)}`)).status, 400, 'forged signature');
    assert.equal((await post(B.tenantId, { ...stop, MessageSid: `SM${hex(16)}` }, KEYS.A.token)).status, 400, "A's token cannot post into B");
    const net0 = net.calls.length;
    const q = await queue(A, { channel: 'sms', to: '403-555-0177', body: 'x' });
    await run();
    assert.equal(net.calls.length, net0, 'opted-out numbers are not texted');
    assert.equal((await call(app, { url: `/api/v1/outbox/${q.body.id}`, token: A.token })).body.status, 'failed');
    await post(A.tenantId, { MessageSid: `SM${hex(16)}`, From: '+14035550177', To: '+14035550100', Body: 'START' }, KEYS.A.token);
    const q2 = await queue(A, { channel: 'sms', to: '403-555-0177', body: 'Back again' });
    await run();
    assert.equal((await call(app, { url: `/api/v1/outbox/${q2.body.id}`, token: A.token })).body.status, 'sent');
    const audit = await call(app, { url: '/api/v1/auditLog?action=integration.sms_opt_out', token: A.token });
    assert.equal(audit.body.data.length, 1);
    assert.ok(!JSON.stringify(audit.body).includes('5550177'), 'the audit summary does not hold the number');
  });

  test('companies without the plan or the keys are left alone', async () => {
    net.reset();
    const q = await queue(B, { channel: 'email', to: PII.email, subject: 'x', body: 'x' });
    const r = await run();
    assert.equal(net.calls.length, 0);
    assert.equal((await call(app, { url: `/api/v1/outbox/${q.body.id}`, token: B.token })).body.status, 'queued');
    assert.ok(r.tenants >= 1);
  });

  test('emailing an invoice queues it and the worker sends it right away, with the pay link', async () => {
    await makeInvoice(A, 'inv-mail');
    net.reset();
    net.on('POST', /api\.stripe\.com\/v1\/checkout\/sessions$/, () => ({ json: { id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' } }));
    const link = (await call(app, { method: 'POST', url: '/api/v1/integrations/stripe/pay-link', token: A.token, body: { invoiceId: 'inv-mail' } })).body.payUrl;
    const sent = [];
    net.on('POST', /api\.resend\.com\/emails$/, (c) => { sent.push(JSON.parse(c.body)); return { json: { id: 'email_inv' } }; });
    const r = await call(app, { method: 'POST', url: '/api/v1/integrations/email/document', token: office.token, body: { collection: 'invoices', id: 'inv-mail' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.outbox.kind, 'invoice');
    assert.equal(r.body.outbox.to, PII.email, 'defaults to the client\'s email');
    const job = await runOnce(t.db, { handlers: { ...HANDLERS, ...handlers } });
    assert.equal(job.kind, 'integrations_send');
    assert.equal(job.outcome, 'done');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Invoice INV-inv-mail from Alpha Electric');
    assert.ok(sent[0].text.includes(`Pay online: ${link}`));
    assert.match(sent[0].text, /Amount due: \$1,050\.00/);
    assert.ok(!/unsubscribe/.test(sent[0].text), 'transactional email has no marketing footer');
    assert.match(sent[0].html, new RegExp(`<a href="${link}">`));
    const est = await call(app, { method: 'POST', url: '/api/v1/estimates', token: A.token, body: { id: 'est-1', number: 'E-2001', clientId: 'client-inv-mail', status: 'draft', lines: [{ description: 'x', qty: 2, unitCents: 5000, kind: 'material' }], taxPct: 5 } });
    assert.equal(est.status, 201);
    const e = await call(app, { method: 'POST', url: '/api/v1/integrations/email/document', token: A.token, body: { collection: 'estimates', id: 'est-1', to: 'someone.else@example.com', message: 'As discussed.' } });
    assert.equal(e.status, 201);
    assert.match(e.body.outbox.body, /As discussed\.\n\nTotal: \$105\.00/);
    assert.equal((await call(app, { url: '/api/v1/estimates/est-1', token: A.token })).body.status, 'sent', 'emailing a draft marks it sent');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/email/document', token: A.token, body: { collection: 'estimates', id: 'est-1', to: 'not-an-email' } })).status, 400);
    const noResend = await call(app, { method: 'POST', url: '/api/v1/integrations/email/document', token: B.token, body: { collection: 'invoices', id: 'inv-mail' } });
    assert.equal(noResend.status, 409, 'Pro includes email, but B has not connected Resend');
    assert.equal(noResend.body.error.code, 'integration_not_connected');
  });
});

describe('Facebook Lead Ads', { skip }, () => {
  const sign = (body, secret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const leadEvent = (leadgenId, pageId = '1234567890') => JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId, form_id: '55', created_time: 1 } }] }] });
  const postFb = (tid, body, secret) => call(app, { method: 'POST', url: `/api/v1/webhooks/facebook/${tid}`, csrf: false, body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, secret) } });

  test('the verification GET answers the challenge only with the company\'s verify token', async () => {
    const q = (tid, token) => `/api/v1/webhooks/facebook/${tid}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
    const ok = await call(app, { url: q(A.tenantId, KEYS.A.verify) });
    assert.equal(ok.status, 200);
    assert.equal(ok.raw.body, '1158201444');
    assert.equal((await call(app, { url: q(A.tenantId, 'wrong-token-1234567') })).status, 403);
    assert.equal((await call(app, { url: q(B.tenantId, KEYS.A.verify) })).status, 403, "A's token does not verify B");
    assert.equal((await call(app, { url: `/api/v1/webhooks/facebook/${A.tenantId}?hub.mode=subscribe&hub.verify_token=${KEYS.A.verify}&hub.challenge=<script>` })).status, 403);
  });

  test('a signed leadgen event creates a lead, enrols it and queues the first step', async () => {
    const seq = await call(app, { method: 'POST', url: '/api/v1/sequences', token: A.token, body: { id: 'seq-fb', name: 'New lead', active: true, steps: [
      { dayOffset: 0, channel: 'email', subject: 'Thanks {{name}}', body: 'Hi {{name}}, {{company}} got your request about {{job}}.' },
      { dayOffset: 2, channel: 'sms', subject: '', body: 'Still need help, {{name}}?' },
    ] } });
    assert.equal(seq.status, 201);
    assert.equal((await put(A, 'facebook', { config: { sequenceId: 'seq-fb' } })).status, 200);
    net.reset();
    net.on('GET', /graph\.facebook\.com\/v\d+\.0\/9001\?fields=/, () => ({ json: {
      id: '9001', created_time: '2026-10-19T10:00:00+0000', ad_id: '77', form_id: '55',
      field_data: [{ name: 'full_name', values: [PII.name] }, { name: 'email', values: [PII.email] }, { name: 'phone_number', values: ['+14035550199'] }, { name: 'what_do_you_need_done?', values: ['EV charger install'] }],
    } }));
    const body = leadEvent('9001');
    const r = await postFb(A.tenantId, body, KEYS.A.app);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, 1);
    assert.match(net.calls[0].url, /appsecret_proof=[0-9a-f]{64}/);
    assert.equal(net.calls[0].headers.authorization, `Bearer ${KEYS.A.page}`);
    const lead = (await call(app, { url: '/api/v1/leads/fb-9001', token: A.token })).body;
    assert.equal(lead.source, 'facebook');
    assert.equal(lead.contactName, PII.name);
    assert.equal(lead.email, PII.email);
    assert.equal(lead.phone, '+14035550199');
    assert.equal(lead.title, 'EV charger install');
    assert.equal(lead.stage, 'new');
    assert.match(lead.notes, /What do you need done: EV charger install/);
    const enrol = (await call(app, { url: '/api/v1/enrolments?leadId=fb-9001', token: A.token })).body.data;
    assert.equal(enrol.length, 1);
    assert.equal(enrol[0].stepIndex, 1, 'the day-0 step is already queued');
    assert.equal(enrol[0].status, 'active');
    const out = (await call(app, { url: '/api/v1/outbox?relatedId=fb-9001', token: A.token })).body.data;
    assert.equal(out.length, 1);
    assert.equal(out[0].subject, 'Thanks Pat');
    assert.equal(out[0].body, 'Hi Pat, Alpha Electric got your request about EV charger install.');

    const replay = await postFb(A.tenantId, body, KEYS.A.app);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, 0);
    assert.equal((await call(app, { url: '/api/v1/leads?limit=500', token: A.token })).body.data.filter((l) => l.source === 'facebook').length, 1);
  });

  test('forged and cross-tenant lead events are refused; a failed fetch asks Facebook to retry', async () => {
    const body = leadEvent('9002');
    assert.equal((await postFb(A.tenantId, body, hex(16))).status, 400);
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/webhooks/facebook/${A.tenantId}`, csrf: false, body, headers: { 'content-type': 'application/json' } })).status, 400);
    await t.superPool.query("UPDATE tenants SET plan = 'business' WHERE id = $1", [B.tenantId]);
    assert.equal((await postFb(B.tenantId, body, KEYS.A.app)).status, 400, "A's app secret cannot post into B");
    net.reset();
    net.on('GET', /graph\.facebook\.com\/v\d+\.0\/9002\?/, () => ({ status: 400, json: { error: { code: 190, message: 'Error validating access token' } } }));
    const r = await postFb(A.tenantId, body, KEYS.A.app);
    assert.equal(r.status, 502);
    const card = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((c) => c.provider === 'facebook');
    assert.equal(card.status, 'error');
    assert.match(card.message, /expired or was revoked/);
    net.on('GET', /graph\.facebook\.com\/v\d+\.0\/9002\?/, () => ({ json: { id: '9002', field_data: [{ name: 'full_name', values: ['Sam'] }] } }));
    assert.equal((await postFb(A.tenantId, body, KEYS.A.app)).body.created, 1, 'the retry after fixing the token imports it');
    await t.superPool.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [A.tenantId]);
    assert.equal((await postFb(A.tenantId, leadEvent('9003'), KEYS.A.app)).status, 403, 'Facebook leads are Business');
    await t.superPool.query("UPDATE tenants SET plan = 'trial' WHERE id = $1", [A.tenantId]);
  });

  test('Subscribe Page posts leadgen to the Page\'s subscribed_apps', async () => {
    net.reset();
    let body;
    net.on('POST', /graph\.facebook\.com\/v\d+\.0\/1234567890\/subscribed_apps\?appsecret_proof=/, (c) => { body = c.body; return { json: { success: true } }; });
    const r = await call(app, { method: 'POST', url: '/api/v1/integrations/facebook/subscribe', token: A.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(body, 'subscribed_fields=leadgen');
  });
});

describe('nothing leaks', { skip }, () => {
  test('no response body ever contained a key, and logs hold no keys or customer details', async () => {
    const all = bodies.join('\n');
    for (const v of SECRET_VALUES) assert.ok(!all.includes(v), `a response contained a secret (${v.slice(0, 6)}…)`);
    const text = logs.text();
    for (const v of [...SECRET_VALUES, PII.email, PII.name, '4035550199', '4035550188', '4035550177']) assert.ok(!text.includes(v), `logs contain ${v.slice(0, 8)}…`);
    assert.ok(!/webhooks\/(stripe|facebook|twilio)/.test(text), 'webhook requests are not logged');
    assert.ok(!/\/api\/v1\/pay\//.test(text), 'pay links are not logged');
    assert.deepEqual(net.unexpected, [], 'no call left the fake network');
  });

  test('disconnecting removes the keys', async () => {
    assert.equal((await call(app, { method: 'DELETE', url: '/api/v1/integrations/twilio', token: A.token })).status, 204);
    const c = (await call(app, { url: '/api/v1/integrations', token: A.token })).body.data.find((x) => x.provider === 'twilio');
    assert.equal(c.status, 'not_connected');
    assert.ok(c.fields.every((f) => !f.set));
    const audit = await call(app, { url: '/api/v1/auditLog?action=integration.disconnect', token: A.token });
    assert.equal(audit.body.data.length, 1);
  });
});
