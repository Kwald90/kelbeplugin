// Self-serve sign-up: the public form (validated, honeypot, rate-limited, no duplicate
// emails), the Stripe Checkout Session (plan + 14-day trial + $1 deposit charged now), the
// signed webhook that turns a paid sign-up into a company (idempotent per event and per
// session) and credits the $1 back, the welcome link, clean-up of abandoned sign-ups, HQ's
// view, and nothing the visitor typed in the logs. Stripe is the in-memory fake.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { skip, createTestDatabase } from './support/db.js';
import { call, enrolTotp, ORIGIN } from './support/app.js';
import { NOTIFY_EMAIL, WEBHOOK_SECRET, hqUser, startHqApp } from './support/hq.js';
import { ensureStripeCatalog } from '../src/services/billing.js';
import { DEPOSIT_LOOKUP_KEY, cleanupSignups, ensureDepositPrice } from '../src/services/signup.js';

let t, app, stripe, logs, admin;
const URL = '/api/v1/public/signup';
const PII = { companyName: 'Sparkwell Electric Ltd', name: 'Robin Sparkwell', email: 'Robin.Sparkwell@Sparkwell.example', password: 'correct horse battery staple' };
const form = (over = {}) => ({ ...PII, province: 'SK', plan: 'pro', users: 3, acceptTerms: true, ...over });
let ipN = 0;
const freshIp = () => `198.51.100.${++ipN}`;
const post = (body, ip = freshIp(), headers = {}) => app.inject({
  method: 'POST', url: URL, remoteAddress: ip, headers: { 'content-type': 'application/json', 'x-fishtape': '1', ...headers }, payload: JSON.stringify(body),
});
const json = (r) => JSON.parse(r.body || 'null');
const q = async (sql, params = []) => (await t.superPool.query(sql, params)).rows;
const signupRow = async (email) => (await q('SELECT * FROM signups WHERE email = $1 ORDER BY created_at DESC LIMIT 1', [email.toLowerCase()]))[0];

let evn = 0;
async function deliver(type, object, { secret = WEBHOOK_SECRET, id } = {}) {
  const event = { id: id || `evt_signup_${++evn}_${Date.now()}`, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } };
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await app.inject({ method: 'POST', url: '/api/v1/webhooks/platform-stripe', headers: { 'content-type': 'application/json', 'stripe-signature': header }, payload });
  return { status: res.statusCode, body: JSON.parse(res.body || 'null'), event };
}

/** Fill the form, then pay in (fake) Checkout: returns the session as the completed event carries it. */
async function signUpAndPay(over = {}) {
  const r = await post(form(over));
  assert.equal(r.statusCode, 201, r.body);
  const sessionId = stripe.state.checkoutSessions.at(-1).id;
  return { session: stripe.completeCheckout(sessionId), url: json(r).url };
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('signup');
  ({ app, stripe, logs } = await startHqApp(t, { signup: { perHour: 3, globalPerHour: 1000 } }));
  await ensureStripeCatalog(stripe);
  await ensureDepositPrice(stripe);
  admin = await hqUser(t, app, 'hq_staff');
});
after(async () => { await app?.close(); await t?.close(); });

describe('the deposit price', { skip }, () => {
  test('is one-time $1.00 CAD under a fishtape_* lookup key, and set-up is idempotent', async () => {
    const p = stripe.state.prices.find((x) => x.lookup_key === DEPOSIT_LOOKUP_KEY);
    assert.equal(p.unit_amount, 100);
    assert.equal(p.currency, 'cad');
    assert.equal(p.recurring, undefined);
    assert.equal(p.product, 'fishtape_signup_deposit');
    assert.equal((await ensureDepositPrice(stripe)).action, 'unchanged');
    // Every product and lookup key we created is ours: the Stripe account is shared.
    for (const id of stripe.state.products.keys()) assert.match(id, /^fishtape_/);
    for (const x of stripe.state.prices) if (x.lookup_key) assert.match(x.lookup_key, /^fishtape_/);
  });
});

describe('the sign-up form', { skip }, () => {
  test('options tell the form the trial length and deposit', async () => {
    const r = await call(app, { url: URL });
    assert.equal(r.status, 200);
    assert.deepEqual({ open: r.body.open, trialDays: r.body.trialDays, depositCents: r.body.depositCents, currency: r.body.currency },
      { open: true, trialDays: 14, depositCents: 100, currency: 'CAD' });
    assert.deepEqual(r.body.plans, ['starter', 'pro', 'business']);
  });

  test('validation names fields and never echoes what was typed', async () => {
    const cases = [
      [{ email: 'not-an-email' }, 'validation_failed', '/email'],
      [{ acceptTerms: false }, 'validation_failed', '/acceptTerms'],
      [{ password: 'short' }, 'weak_password', '/password'],
      [{ password: PII.email }, 'weak_password', '/password'],
      [{ plan: 'enterprise' }, 'validation_failed', null],
      [{ users: 0 }, 'validation_failed', null],
      [{ province: 'XX' }, 'validation_failed', null],
      [{ companyName: '   ' }, 'validation_failed', '/companyName'],
      [{ extra: PII.email }, 'validation_failed', null],
    ];
    for (const [over, code, path] of cases) {
      const r = await post(form(over));
      assert.equal(r.statusCode, 400, JSON.stringify(over));
      const b = json(r);
      assert.equal(b.error.code, code, JSON.stringify(over));
      if (path) assert.equal(b.error.details.errors[0].path, path);
      for (const s of [PII.companyName, PII.name, PII.email, PII.email.toLowerCase(), PII.password, 'not-an-email']) assert.ok(!r.body.includes(s), `echoed ${s}`);
    }
    const missing = await post({ email: PII.email });
    assert.equal(missing.statusCode, 400);
    assert.equal((await q('SELECT count(*)::int AS n FROM signups'))[0].n, 0);
    assert.equal(stripe.state.checkoutSessions.length, 0, 'nothing reaches Stripe');
  });

  test('the honeypot looks accepted but stores and charges nothing', async () => {
    const r = await post(form({ website: 'http://spam.example' }));
    assert.equal(r.statusCode, 201);
    assert.match(json(r).url, /signup\.html\?done=1$/);
    assert.equal((await q('SELECT count(*)::int AS n FROM signups'))[0].n, 0);
    assert.equal(stripe.state.checkoutSessions.length, 0);
  });

  test('browsers need the CSRF header and an allowed Origin', async () => {
    const r = await app.inject({ method: 'POST', url: URL, remoteAddress: freshIp(), headers: { 'content-type': 'application/json' }, payload: JSON.stringify(form()) });
    assert.equal(r.statusCode, 403);
    const o = await post(form(), freshIp(), { origin: 'https://evil.example' });
    assert.equal(o.statusCode, 403);
  });

  test('an email that already has an account is refused (any case)', async () => {
    await t.superPool.query("INSERT INTO users (email, display_name) VALUES ('taken@shop.example', 'Taken')");
    const r = await post(form({ email: 'Taken@Shop.example' }));
    assert.equal(r.statusCode, 409);
    assert.equal(json(r).error.code, 'email_in_use');
  });

  test('a valid form stores a pending sign-up (hashed password, no company) and opens Checkout', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM tenants'))[0].n;
    const r = await post(form({ users: 12 }));
    assert.equal(r.statusCode, 201, r.body);
    const s = stripe.state.checkoutSessions.at(-1);
    assert.equal(json(r).url, s.url);
    for (const h of Object.values(r.headers)) for (const x of [PII.email, PII.name, PII.companyName]) assert.ok(!String(h).includes(x));

    const row = await signupRow(PII.email);
    assert.equal(row.status, 'pending');
    assert.equal(row.tenant_id, null);
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.ok(!JSON.stringify(row).includes(PII.password), 'the password is never stored');
    assert.equal(row.stripe_checkout_session_id, s.id);
    assert.equal(row.trial_days, 14);
    assert.equal((await q('SELECT count(*)::int AS n FROM tenants'))[0].n, before, 'not a company yet');

    // The session: subscription mode, plan + extra users + the $1 deposit, a 14-day trial.
    const price = (key) => stripe.state.prices.find((p) => p.lookup_key === key).id;
    assert.equal(s.mode, 'subscription');
    assert.deepEqual(s.line_items, [
      { price: price('fishtape_pro_monthly_cad'), quantity: 1 },
      { price: price('fishtape_extra_user_monthly_cad'), quantity: 2 }, // 12 users, Pro includes 10
      { price: price(DEPOSIT_LOOKUP_KEY), quantity: 1 },
    ]);
    assert.equal(s.subscription_data.trial_period_days, 14);
    assert.deepEqual(s.subscription_data.metadata, { fishtape_signup_id: row.id, plan: 'pro' });
    assert.deepEqual(s.metadata, { fishtape_signup_id: row.id, plan: 'pro' });
    assert.equal(s.client_reference_id, `signup_${row.id}`);
    assert.deepEqual(s.payment_method_types, ['card']);
    assert.equal(s.customer_email, PII.email.toLowerCase());
    assert.equal(s.success_url, `${ORIGIN}/site/signup.html?done=1`);
    assert.equal(s.cancel_url, `${ORIGIN}/site/signup.html?plan=pro&cancelled=1`);
    const mins = (s.expires_at * 1000 - Date.now()) / 60_000;
    assert.ok(mins > 31 && mins <= 60, `expires in ${mins} min`);
    assert.match(s.custom_text.submit.message, /CA\$1\.00 today/);
    const ev = await q("SELECT summary, meta FROM audit_events WHERE action = 'signup.started'");
    assert.equal(ev[0].summary, 'Self-serve sign-up started (Pro)');
  });

  test('trying again with the same email replaces the open sign-up', async () => {
    const first = await signupRow(PII.email);
    const r = await post(form({ plan: 'starter', users: 1 }));
    assert.equal(r.statusCode, 201, r.body);
    const old = (await q('SELECT status, email, password_hash FROM signups WHERE id = $1', [first.id]))[0];
    assert.deepEqual(old, { status: 'abandoned', email: null, password_hash: null });
    assert.equal(stripe.state.checkoutSessions.find((x) => x.id === first.stripe_checkout_session_id).status, 'expired');
    assert.deepEqual(stripe.state.checkoutSessions.at(-1).line_items.length, 2, 'Starter for 1 user: plan + deposit');
  });

  test('it is rate-limited per IP even with RATE_LIMIT=off', async () => {
    const ip = '203.0.113.99';
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(form({ email: 'nope' }), ip)).statusCode);
    assert.deepEqual(codes, [400, 400, 400, 429, 429]);
    assert.equal(json(await post(form({ email: 'nope' }), ip)).error.code, 'rate_limited');
    assert.equal((await post(form({ email: 'nope' }), '203.0.113.100')).statusCode, 400, 'another IP is fine');
  });

  test('and overall, across IPs', async () => {
    const t2 = await startHqApp(t, { stripe, signup: { perHour: 10, globalPerHour: 2 } });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await t2.app.inject({ method: 'POST', url: URL, remoteAddress: `192.0.2.${i + 1}`, headers: { 'content-type': 'application/json', 'x-fishtape': '1' }, payload: '{}' })).statusCode);
      }
      assert.deepEqual(codes, [400, 400, 429]);
    } finally { await t2.app.close(); }
  });
});

describe('Checkout -> company (signed platform webhook)', { skip }, () => {
  let paid, row, tenant, firstDelivery;

  test('an unsigned or forged event changes nothing', async () => {
    ({ session: paid } = await signUpAndPay());
    const forged = await deliver('checkout.session.completed', paid, { secret: 'whsec_wrong' });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, 'invalid_signature');
    const unsigned = await app.inject({ method: 'POST', url: '/api/v1/webhooks/platform-stripe', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: paid } }) });
    assert.equal(unsigned.statusCode, 400);
    assert.equal((await signupRow(PII.email)).status, 'pending');
  });

  test('a paid sign-up becomes a company on a 14-day trial of its plan, with the $1 credited and a welcome email', async () => {
    const r = await deliver('checkout.session.completed', paid);
    firstDelivery = r;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, 'applied');
    row = await signupRow(PII.email);
    assert.equal(row.status, 'completed');
    assert.equal(row.password_hash, null, 'the hash moved to the account');
    assert.equal(row.deposit_paid_cents, 100);
    assert.ok(row.deposit_paid_at && row.credited_at);
    assert.match(row.credit_txn_id, /^cbtxn_/);

    tenant = (await q('SELECT * FROM tenants WHERE id = $1', [row.tenant_id]))[0];
    assert.equal(tenant.name, PII.companyName);
    assert.equal(tenant.province, 'SK');
    assert.equal(tenant.plan, 'pro', 'the chosen tier, not plan "trial": Stripe says it is trialing');
    assert.equal(tenant.billing_status, 'trialing');
    assert.equal(tenant.billing_plan, 'pro');
    assert.equal(tenant.stripe_customer_id, paid.customer);
    assert.equal(tenant.stripe_subscription_id, paid.subscription);
    const days = (new Date(tenant.trial_ends_at) - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days <= 14, `trial ${days} days`);

    const owner = (await q('SELECT u.email, u.password_hash, u.email_verified_at, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = $1', [tenant.id]));
    assert.equal(owner.length, 1);
    assert.equal(owner[0].email, PII.email.toLowerCase());
    assert.equal(owner[0].role, 'owner');
    assert.match(owner[0].password_hash, /^\$argon2id\$/);
    assert.equal(owner[0].email_verified_at, null, 'verified by the welcome link');

    // -$1.00 CAD on the Stripe customer balance: it comes off the first invoice after the trial.
    const credits = stripe.state.calls.filter((c) => c.name === 'customers.createBalanceTransaction');
    assert.equal(credits.length, 1);
    assert.equal(credits[0].args.customer, paid.customer);
    assert.equal(credits[0].args.amount, -100);
    assert.equal(credits[0].args.currency, 'cad');
    assert.equal(credits[0].args.idempotencyKey, `fishtape-signup-credit-${row.id}`);
    assert.equal(stripe.state.customers.get(paid.customer).balance, -100);

    const mail = await q('SELECT to_address, subject, text_body, tenant_id FROM email_outbox ORDER BY created_at');
    const welcome = mail.find((m) => m.to_address === PII.email.toLowerCase());
    assert.ok(welcome, 'welcome email queued');
    assert.equal(welcome.tenant_id, tenant.id);
    assert.match(welcome.text_body, new RegExp(`${ORIGIN.replace(/\./g, '\\.')}/#/welcome\\?token=ftw_`));
    assert.match(welcome.text_body, /two-step sign-in/);
    assert.match(welcome.text_body, /CA\$1\.00 deposit/);
    const hqMail = mail.find((m) => m.to_address === NOTIFY_EMAIL);
    assert.match(hqMail.subject, /New sign-up: Sparkwell Electric/);
    for (const s of [PII.email.toLowerCase(), PII.name]) assert.ok(!hqMail.text_body.includes(s), 'HQ alert has no personal details');

    const audit = await q("SELECT action, summary FROM audit_events WHERE tenant_id = $1 ORDER BY seq", [tenant.id]);
    assert.deepEqual(audit.map((a) => a.action), ['tenant.create', 'billing.subscription', 'signup.completed', 'billing.deposit_credited']);
    assert.match(audit[2].summary, /Pro trial until \d{4}-\d{2}-\d{2}; CA\$1\.00 deposit paid/);
  });

  test('replays are no-ops: the same event, or another event for the same session', async () => {
    const again = await deliver(firstDelivery.event.type, firstDelivery.event.data.object, { id: firstDelivery.event.id });
    assert.equal(again.body.outcome, 'duplicate');
    const other = await deliver('checkout.session.completed', paid);
    assert.equal(other.status, 200);
    assert.equal(other.body.outcome, 'ignored');
    assert.equal((await q('SELECT count(*)::int AS n FROM tenants WHERE name = $1', [PII.companyName]))[0].n, 1);
    assert.equal(stripe.state.calls.filter((c) => c.name === 'customers.createBalanceTransaction').length, 1);
    assert.equal((await q('SELECT count(*)::int AS n FROM email_outbox WHERE to_address = $1', [PII.email.toLowerCase()]))[0].n, 1);
  });

  test('the owner signs in with their password, sets up two-step sign-in and sees the trial', async () => {
    const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email: PII.email, password: PII.password, mode: 'bearer' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mfa, 'enrol');
    await enrolTotp(app, r.body.token);
    const me = await call(app, { url: '/api/v1/me', token: r.body.token });
    assert.equal(me.body.tenant.id, tenant.id);
    assert.equal(me.body.entitlements.plan, 'pro');
    assert.equal(me.body.entitlements.onTrial, true);
    assert.equal(me.body.entitlements.trialEndsAt, new Date(tenant.trial_ends_at).toISOString());
    const billing = await call(app, { url: '/api/v1/billing', token: r.body.token });
    assert.equal(billing.body.onTrial, true);
    assert.equal(billing.body.status, 'trialing');
    assert.deepEqual(billing.body.deposit, { cents: 100, credited: true });
    assert.ok(!JSON.stringify(billing.body).includes('cus_'));
  });

  test('the welcome link verifies the email once and opens a session that goes to MFA', async () => {
    const mail = (await q('SELECT text_body FROM email_outbox WHERE to_address = $1', [PII.email.toLowerCase()]))[0];
    const token = decodeURIComponent(mail.text_body.match(/token=([^\s]+)/)[1]);
    const r = await call(app, { method: 'POST', url: '/api/v1/public/signup/welcome', body: { token } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mfa, 'verify', 'TOTP was set up in the previous step, so this session must verify it');
    assert.ok(r.cookies.some((c) => c.name === 'ft_session' && c.httpOnly));
    assert.equal(r.body.token, undefined, 'cookie mode: no token in the body');
    assert.ok((await q('SELECT email_verified_at FROM users WHERE email = $1', [PII.email.toLowerCase()]))[0].email_verified_at);
    const again = await call(app, { method: 'POST', url: '/api/v1/public/signup/welcome', body: { token } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'invalid_token');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/public/signup/welcome', body: { token: 'ftw_guess' } })).body.error.code, 'invalid_token');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/public/signup/welcome', body: { token }, csrf: false })).status, 403, 'CSRF header needed');
  });

  test('when the trial ends Stripe bills the plan; a failed payment uses the grace period', async () => {
    const sub = structuredClone(stripe.state.subscriptions.get(paid.subscription));
    const active = await deliver('customer.subscription.updated', { ...sub, status: 'active', trial_end: sub.trial_end });
    assert.equal(active.body.outcome, 'applied');
    let tn = (await q('SELECT plan, billing_status FROM tenants WHERE id = $1', [tenant.id]))[0];
    assert.deepEqual(tn, { plan: 'pro', billing_status: 'active' });
    await deliver('invoice.payment_failed', { id: 'in_signup_1', object: 'invoice', customer: paid.customer, amount_due: 4800, currency: 'cad', attempt_count: 1 });
    tn = (await q('SELECT billing_status, grace_ends_at FROM tenants WHERE id = $1', [tenant.id]))[0];
    assert.equal(tn.billing_status, 'past_due');
    assert.ok(tn.grace_ends_at);
  });

  test('a pending sign-up that gets an account meanwhile fails safely: subscription cancelled, HQ told', async () => {
    const email = 'race@volt.example';
    const { session } = await signUpAndPay({ email, companyName: 'Race Volt Inc' });
    await t.superPool.query("INSERT INTO users (email, display_name) VALUES ($1, 'Someone')", [email]);
    const r = await deliver('checkout.session.completed', session);
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'failed');
    const s = await signupRow(email);
    assert.equal(s.status, 'failed');
    assert.equal(s.failure, 'email_in_use');
    assert.equal(s.password_hash, null);
    assert.equal(s.tenant_id, null);
    assert.equal(stripe.state.subscriptions.get(session.subscription).status, 'canceled');
    assert.equal((await q("SELECT count(*)::int AS n FROM tenants WHERE name = 'Race Volt Inc'"))[0].n, 0);
    assert.ok((await q('SELECT subject FROM email_outbox WHERE to_address = $1', [NOTIFY_EMAIL])).some((m) => /could not finish/.test(m.subject)));
  });

  test('a Stripe outage while crediting is retried; a refusal is noted for HQ', async () => {
    const { session } = await signUpAndPay({ email: 'retry@amp.example', companyName: 'Retry Amp Co', plan: 'business', users: 1 });
    stripe.state.failBalance = Object.assign(new Error('Stripe is down'), { statusCode: 503 });
    const first = await deliver('checkout.session.completed', session, { id: 'evt_signup_retry' });
    assert.equal(first.status, 500, 'Stripe will deliver it again');
    let s = await signupRow('retry@amp.example');
    assert.equal(s.status, 'completed', 'the company exists already');
    assert.equal(s.credited_at, null);
    stripe.state.failBalance = null;
    const retry = await deliver('checkout.session.completed', session, { id: 'evt_signup_retry' });
    assert.equal(retry.body.outcome, 'applied');
    s = await signupRow('retry@amp.example');
    assert.ok(s.credited_at);
    assert.equal((await q("SELECT count(*)::int AS n FROM tenants WHERE name = 'Retry Amp Co'"))[0].n, 1);
    assert.equal((await q("SELECT plan, billing_status FROM tenants WHERE name = 'Retry Amp Co'"))[0].plan, 'business');
    // Its owner has not set up TOTP: the welcome link's session goes straight to enrolment.
    const mail = (await q("SELECT text_body FROM email_outbox WHERE to_address = 'retry@amp.example'"))[0];
    const w = await call(app, { method: 'POST', url: '/api/v1/public/signup/welcome', body: { token: decodeURIComponent(mail.text_body.match(/token=([^\s]+)/)[1]), mode: 'bearer' } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.mfa, 'enrol');
    assert.match(w.body.token, /^fts_/);
    assert.equal((await call(app, { url: '/api/v1/clients', token: w.body.token })).body.error.code, 'mfa_enrolment_required');

    const { session: s2 } = await signUpAndPay({ email: 'refused@amp.example', companyName: 'Refused Amp Co', users: 1 });
    stripe.state.failBalance = Object.assign(new Error('Currency mismatch'), { statusCode: 400, code: 'invalid_request_error' });
    const r2 = await deliver('checkout.session.completed', s2);
    stripe.state.failBalance = null;
    assert.equal(r2.status, 200);
    const row2 = await signupRow('refused@amp.example');
    assert.equal(row2.status, 'completed');
    assert.equal(row2.credit_error, 'invalid_request_error');
  });
});

describe('abandoned and expired sign-ups', { skip }, () => {
  test('checkout.session.expired closes the sign-up and removes the personal details', async () => {
    const r = await post(form({ email: 'gone@watt.example', companyName: 'Watt Gone Ltd' }));
    assert.equal(r.statusCode, 201);
    const s = stripe.state.checkoutSessions.at(-1);
    s.status = 'expired';
    const ev = await deliver('checkout.session.expired', structuredClone(s));
    assert.equal(ev.body.outcome, 'applied');
    const row = (await q('SELECT status, email, display_name, password_hash, tenant_id FROM signups WHERE stripe_checkout_session_id = $1', [s.id]))[0];
    assert.deepEqual(row, { status: 'expired', email: null, display_name: null, password_hash: null, tenant_id: null });
    assert.equal((await q("SELECT count(*)::int AS n FROM tenants WHERE name = 'Watt Gone Ltd'"))[0].n, 0);
  });

  test('the hourly sweep abandons sign-ups whose webhook never came and deletes old ones', async () => {
    const r = await post(form({ email: 'quiet@ohm.example', companyName: 'Quiet Ohm' }));
    assert.equal(r.statusCode, 201);
    await t.superPool.query("UPDATE signups SET expires_at = now() - interval '2 hours' WHERE email = 'quiet@ohm.example'");
    await t.superPool.query("UPDATE signups SET updated_at = now() - interval '31 days' WHERE status = 'expired'");
    const out = await cleanupSignups(t.db);
    assert.ok(out.abandoned >= 1);
    assert.ok(out.deleted >= 1);
    const row = (await q("SELECT status, email, password_hash FROM signups WHERE company_name = 'Quiet Ohm'"))[0];
    assert.deepEqual(row, { status: 'abandoned', email: null, password_hash: null });
    assert.equal((await q("SELECT count(*)::int AS n FROM signups WHERE company_name = 'Watt Gone Ltd'"))[0].n, 0);
  });

  test('an event for an unknown session is recorded and ignored', async () => {
    const r = await deliver('checkout.session.completed', { id: 'cs_test_nope', object: 'checkout.session', metadata: { fishtape_signup_id: '00000000-0000-4000-8000-000000000000' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'ignored');
  });
});

describe('HQ sees sign-ups', { skip }, () => {
  test('a sign-ups list and a sign-up column on Companies, HQ staff only', async () => {
    const list = await call(app, { url: '/api/hq/signups', token: admin.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.byStatus.completed >= 2 && list.body.byStatus.failed >= 1 && list.body.byStatus.abandoned >= 1);
    const done = list.body.data.find((s) => s.companyName === PII.companyName && s.status === 'completed');
    assert.equal(done.depositPaid, true);
    assert.equal(done.depositCredited, true);
    assert.ok(done.trialEndsAt);
    assert.ok(!JSON.stringify(list.body).includes('argon2'), 'never a password hash');
    assert.equal((await call(app, { url: '/api/hq/signups?status=failed', token: admin.token })).body.data.every((s) => s.status === 'failed'), true);

    const tenants = await call(app, { url: '/api/hq/tenants', token: admin.token });
    const co = tenants.body.data.find((x) => x.name === PII.companyName);
    assert.equal(co.signup.depositPaid, true);
    assert.equal(co.signup.depositCredited, true);
    assert.equal(co.signup.emailVerified, true);
    assert.ok(!JSON.stringify(tenants.body).includes('cus_test'), 'no Stripe ids');

    assert.equal((await call(app, { url: '/api/hq/signups' })).status, 401);
  });
});

describe('logs', { skip }, () => {
  test('nothing the visitor typed reaches the logs', () => {
    const text = logs.text();
    assert.ok(text.includes('checkout.session.completed'), 'the event type is logged');
    for (const s of [PII.companyName, PII.name, PII.email, PII.email.toLowerCase(), PII.password, 'Sparkwell', 'race@volt.example', 'ftw_']) {
      assert.ok(!text.includes(s), `log contains ${s}`);
    }
  });
});
