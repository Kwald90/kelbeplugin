// HQ console additions against a real Postgres: roles (admin vs staff), audits, finance and
// invoicing with a mocked Stripe (refund and credit-note guards, the shared account), settings
// and legal re-acceptance, user admin actions, announcement targeting and dismissals, the
// help center (drafts hidden from companies), developer usage, AI caps and errors, the audit
// log viewer, and that no response carries a secret.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, addMember, apiKey } from './support/app.js';
import { hqUser, startHqApp } from './support/hq.js';
import { financeStripe, invoice, sub, subItem } from './support/fake-stripe-finance.js';
import { HANDLERS, runOnce } from '../src/services/queue.js';
import { createFinanceHandlers, scheduleFinanceJobs } from '../src/services/hq-finance.js';
import { authError, mockAnthropic, restoreAnthropic, sse, text, toolUse, turn } from './support/anthropic-mock.js';
import { setSecret } from '../src/services/secrets.js';
import { drainPlatformEmail } from '../src/services/platform-email.js';

// Fake secrets that must never show up in a response. Built at run time: nothing key-shaped is committed.
const fake = (...parts) => parts.join('_');
const SECRETS = { STRIPE_SECRET_KEY: fake('sk', 'test', 'SUPERSECRETkey123'), RESEND_API_KEY: fake('re', 'SUPERSECRETresend') };
process.env.STRIPE_SECRET_KEY = SECRETS.STRIPE_SECRET_KEY;
process.env.RESEND_API_KEY = SECRETS.RESEND_API_KEY;
process.env.EMAIL_FROM = 'Fishtape <noreply@fishtapehq.test>';

let t, app, stripe, A, B, admin, staff, crew;
const responses = [];
const hq = async (token, url, opts = {}) => {
  const r = await call(app, { url, token, ...opts });
  responses.push({ url, body: r.raw.body, headers: r.headers });
  return r;
};
const events = async (tenantId, action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id IS NOT DISTINCT FROM $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows;
const key = () => `k-${Math.random().toString(36).slice(2, 12)}`;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('hqconsole');
  const now = Date.now();
  stripe = financeStripe({
    account: { id: 'acct_1TCB', settings: { dashboard: { display_name: 'True Collar Built' } }, country: 'CA', default_currency: 'cad', charges_enabled: true, payouts_enabled: true },
    prices: [
      { id: 'price_s', lookup_key: 'fishtape_starter_monthly_cad', unit_amount: 4900, currency: 'cad', active: true, recurring: { interval: 'month' } },
      { id: 'price_p', lookup_key: 'fishtape_pro_monthly_cad', unit_amount: 9999, currency: 'cad', active: true, recurring: { interval: 'month' } },
    ],
    webhookEndpoints: [{ id: 'we_1', url: 'https://app.fishtape.test/api/v1/webhooks/platform-stripe', status: 'enabled', enabled_events: ['invoice.paid', 'invoice.payment_failed'] }],
    subscriptions: [
      sub('sub_alpha', 'cus_alpha', 'active', [subItem('fishtape_pro_monthly_cad', 12900)], { now }),
      sub('sub_tcb', 'cus_tcb', 'active', [subItem('tcb_maintenance_plan', 99900)], { now }),
    ],
    invoices: [
      invoice('in_alpha_paid', 'cus_alpha', 'paid', { amountPaid: 12900, daysAgo: 3, paymentIntent: 'pi_alpha', now }),
      invoice('in_alpha_open', 'cus_alpha', 'open', { amountDue: 12900, amountRemaining: 12900, attempts: 1, daysAgo: 1, now }),
      invoice('in_bravo_paid', 'cus_bravo', 'paid', { amountPaid: 4900, daysAgo: 2, now }),
      invoice('in_tcb_paid', 'cus_tcb', 'paid', { amountPaid: 99900, daysAgo: 2, paymentIntent: 'pi_tcb', now }),
    ],
    refunds: [],
    invoicePayments: [{ invoice: 'in_bravo_paid', status: 'paid', payment: { payment_intent: 'pi_bravo' } }],
  });
  ({ app } = await startHqApp(t, { stripe, hq: { testResend: async () => ({ status: 'ok', message: 'Connected. fishtapehq.test is verified.' }) } }));
  A = await ownerTenant(t, app, 'Alpha Wiring');
  B = await ownerTenant(t, app, 'Bravo Power');
  await t.superPool.query("UPDATE tenants SET stripe_customer_id = 'cus_alpha', province = 'ON', plan = 'pro', billing_status = 'active' WHERE id = $1", [A.tenantId]);
  await t.superPool.query("UPDATE tenants SET stripe_customer_id = 'cus_bravo', province = 'BC' WHERE id = $1", [B.tenantId]);
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
  crew = await addMember(t, app, A.tenantId, { role: 'electrician' });
});
after(async () => { await app?.close(); await t?.close(); });

describe('roles and headers', { skip }, () => {
  const GETS = ['/api/hq/finance', '/api/hq/invoices', '/api/hq/developer', '/api/hq/developer/usage', '/api/hq/developer/webhooks', '/api/hq/ai',
    '/api/hq/settings', '/api/hq/settings/stripe', '/api/hq/settings/email', '/api/hq/users', '/api/hq/announcements', '/api/hq/help'];

  test('anonymous callers get 401, company owners 403, staff 200 with no-store', async () => {
    for (const url of GETS) {
      assert.equal((await call(app, { url })).status, 401, url);
      assert.equal((await call(app, { url, token: A.token })).status, 403, url);
      const r = await hq(staff.token, url);
      assert.equal(r.status, 200, `${url} ${JSON.stringify(r.body)}`);
      assert.equal(r.headers['cache-control'], 'no-store', url);
    }
  });

  test('HQ staff cannot change things', async () => {
    const tries = [
      ['PUT', '/api/hq/settings', { support: { email: 'x@fishtapehq.com' } }],
      ['POST', '/api/hq/invoices/in_alpha_paid/refund', { amountCents: 100, reason: 'customer asked', requestKey: key() }],
      ['POST', '/api/hq/invoices/in_alpha_paid/credit-note', { amountCents: 100, reason: 'customer asked', requestKey: key() }],
      ['POST', '/api/hq/invoices/in_alpha_open/uncollectible', { reason: 'gone bust' }],
      ['POST', `/api/hq/users/${A.userId}/unlock`, {}],
      ['POST', `/api/hq/users/${A.userId}/revoke-sessions`, { reason: 'lost phone' }],
      ['POST', `/api/hq/users/${A.userId}/force-reset`, { reason: 'lost phone' }],
      ['POST', '/api/hq/announcements', { title: 'Hi' }],
      ['PUT', `/api/hq/ai/caps/${A.tenantId}`, { monthlyCapCents: 1, reason: 'testing caps' }],
      ['PUT', '/api/hq/help/categories/misc', { name: 'Misc' }],
    ];
    for (const [method, url, body] of tries) {
      const r = await hq(staff.token, url, { method, body });
      assert.equal(r.status, 403, `${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(stripe.calls.filter((c) => /refunds.create|creditNotes.create|markUncollectible/.test(c.name)).length, 0);
  });
});

describe('finance and invoicing', { skip }, () => {
  test('before a refresh the page says so; a refresh counts only Fishtape objects', async () => {
    const empty = await hq(staff.token, '/api/hq/finance');
    assert.equal(empty.body.data, null);
    assert.equal(empty.body.configured, true);
    const r = await hq(staff.token, '/api/hq/finance/refresh', { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.mrrCents, 12900, 'True Collar Built\'s own subscription is not Fishtape MRR');
    assert.equal(r.body.data.thisMonth.grossCents, 12900 + 4900);
    assert.equal(r.body.data.failedPayments.open[0].tenantId, A.tenantId);
    assert.equal(r.body.data.tax.present, false);
    assert.equal(r.body.companies[A.tenantId], 'Alpha Wiring');
    assert.equal(r.body.stale, false);
    assert.equal((await events(null, 'hq.finance_refresh')).length, 1);
  });

  test('the worker job refreshes the same cache', async () => {
    await t.superPool.query('DELETE FROM finance_snapshots');
    await scheduleFinanceJobs(t.db);
    const handlers = { ...HANDLERS, ...createFinanceHandlers({ config: {}, stripe }) };
    const out = await runOnce(t.db, { handlers });
    assert.equal(out.kind, 'hq_finance_refresh');
    assert.equal(out.outcome, 'done', JSON.stringify(out));
    assert.equal(out.result.mrrCents, 12900);
    assert.ok((await hq(staff.token, '/api/hq/finance')).body.data.revenue.length === 12);
  });

  test('CSV export is audited and safe', async () => {
    const r = await call(app, { url: '/api/hq/finance/export?kind=revenue', token: staff.token });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /fishtape-revenue-/);
    assert.match(r.raw.body, /^month,gross_cad/);
    assert.equal((await events(null, 'hq.finance_export')).length, 1);
  });

  test('invoices: only Fishtape companies\' invoices, filterable', async () => {
    const all = await hq(staff.token, '/api/hq/invoices');
    assert.deepEqual(all.body.data.map((i) => i.id).sort(), ['in_alpha_open', 'in_alpha_paid', 'in_bravo_paid']);
    assert.equal(all.body.data.find((i) => i.id === 'in_alpha_paid').tenantName, 'Alpha Wiring');
    assert.ok(all.body.data[0].hostedInvoiceUrl.startsWith('https://'));
    const alpha = await hq(staff.token, `/api/hq/invoices?tenantId=${A.tenantId}&status=open`);
    assert.deepEqual(alpha.body.data.map((i) => i.id), ['in_alpha_open']);
  });

  test('resend: staff may, audited in both chains; another business\'s invoice is not found', async () => {
    assert.equal((await hq(staff.token, '/api/hq/invoices/in_alpha_open/resend', { method: 'POST' })).status, 200);
    assert.ok(stripe.calls.some((c) => c.name === 'invoices.sendInvoice' && c.args === 'in_alpha_open'));
    assert.equal((await events(A.tenantId, 'hq.invoice_resend')).length, 1);
    assert.equal((await events(null, 'hq.invoice_resend')).length, 1);
    assert.equal((await hq(staff.token, '/api/hq/invoices/in_tcb_paid/resend', { method: 'POST' })).status, 404);
  });

  test('refund guards: reason, amount, status, ownership; then refund once, audited', async () => {
    const url = '/api/hq/invoices/in_alpha_paid/refund';
    assert.equal((await hq(admin.token, url, { method: 'POST', body: { amountCents: 500, reason: 'no', requestKey: key() } })).status, 400, 'reason too short');
    const tooMuch = await hq(admin.token, url, { method: 'POST', body: { amountCents: 12901, reason: 'customer asked', requestKey: key() } });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, 'amount_too_large');
    assert.equal((await hq(admin.token, '/api/hq/invoices/in_alpha_open/refund', { method: 'POST', body: { amountCents: 100, reason: 'customer asked', requestKey: key() } })).status, 409, 'open invoice');
    assert.equal((await hq(admin.token, '/api/hq/invoices/in_tcb_paid/refund', { method: 'POST', body: { amountCents: 100, reason: 'customer asked', requestKey: key() } })).status, 404, 'True Collar Built invoice');
    assert.equal(stripe.calls.filter((c) => c.name === 'refunds.create').length, 0);

    const k = key();
    const ok = await hq(admin.token, url, { method: 'POST', body: { amountCents: 2900, reason: 'Billed for a seat they removed', requestKey: k } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.refund.amountCents, 2900);
    const created = stripe.calls.filter((c) => c.name === 'refunds.create');
    assert.equal(created.length, 1);
    assert.equal(created[0].args.payment_intent, 'pi_alpha');
    assert.equal(created[0].args.idempotencyKey, `fishtape-hq-refund-in_alpha_paid-${k}`);
    const ev = await events(A.tenantId, 'hq.invoice_refund');
    assert.match(ev[0].summary, /refund \$29\.00 .*Billed for a seat they removed/);
    assert.equal((await events(null, 'hq.invoice_refund')).length, 1);
    // what is left: 129.00 - 29.00
    const again = await hq(admin.token, url, { method: 'POST', body: { amountCents: 10001, reason: 'customer asked', requestKey: key() } });
    assert.equal(again.body.error.details.maxCents, 10000);
  });

  test('refund finds the payment through invoice payments (newer Stripe API)', async () => {
    const r = await hq(admin.token, '/api/hq/invoices/in_bravo_paid/refund', { method: 'POST', body: { amountCents: 100, reason: 'deposit refund', requestKey: key() } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stripe.calls.filter((c) => c.name === 'refunds.create').at(-1).args.payment_intent, 'pi_bravo');
  });

  test('credit notes: amount bounded by what is left, open and paid invoices, audited', async () => {
    const big = await hq(admin.token, '/api/hq/invoices/in_alpha_open/credit-note', { method: 'POST', body: { amountCents: 13000, reason: 'goodwill', requestKey: key() } });
    assert.equal(big.body.error.code, 'amount_too_large');
    const ok = await hq(admin.token, '/api/hq/invoices/in_alpha_open/credit-note', { method: 'POST', body: { amountCents: 1500, reason: 'Outage on Oct 3', stripeReason: 'product_unsatisfactory', requestKey: key() } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const cn = stripe.calls.filter((c) => c.name === 'creditNotes.create');
    assert.equal(cn[0].args.amount, 1500);
    assert.equal(cn[0].args.credit_amount, undefined, 'an open invoice just owes less');
    const paid = await hq(admin.token, '/api/hq/invoices/in_alpha_paid/credit-note', { method: 'POST', body: { amountCents: 500, reason: 'Goodwill credit', requestKey: key() } });
    assert.equal(paid.status, 200);
    assert.equal(stripe.calls.filter((c) => c.name === 'creditNotes.create').at(-1).args.credit_amount, 500, 'paid: credit on the balance');
    assert.equal((await events(A.tenantId, 'hq.invoice_credit_note')).length, 2);
  });

  test('mark uncollectible: admin, open invoices only, with a reason', async () => {
    assert.equal((await hq(admin.token, '/api/hq/invoices/in_alpha_paid/uncollectible', { method: 'POST', body: { reason: 'company closed' } })).status, 409);
    const r = await hq(admin.token, '/api/hq/invoices/in_alpha_open/uncollectible', { method: 'POST', body: { reason: 'company closed' } });
    assert.equal(r.status, 200);
    assert.equal((await events(A.tenantId, 'hq.invoice_uncollectible')).length, 1);
  });
});

describe('settings and legal', { skip }, () => {
  test('env settings are read-only and secrets show only as set', async () => {
    const r = await hq(staff.token, '/api/hq/settings');
    const env = Object.fromEntries(r.body.env.map((e) => [e.key, e]));
    assert.equal(env.STRIPE_SECRET_KEY.value, 'set (test mode)');
    assert.equal(env.RESEND_API_KEY.value, 'set');
    assert.equal(env.BRAND.value, 'Fishtape');
    assert.match(env.TRIAL_DAYS.value, /days/);
    assert.ok(env.HQ_PUBLIC_URL.value.endsWith('/hq/'));
    assert.equal(r.body.settings.support.email, 'support@fishtapehq.com');
  });

  test('admin saves support and legal settings; audited; bad values refused', async () => {
    const bad = await hq(admin.token, '/api/hq/settings', { method: 'PUT', body: { support: { email: 'not-an-email' } } });
    assert.equal(bad.status, 400);
    const r = await hq(admin.token, '/api/hq/settings', { method: 'PUT', body: { support: { email: 'Help@FishtapeHQ.com', senderName: 'Fishtape help' } } });
    assert.equal(r.body.settings.support.email, 'help@fishtapehq.com');
    const ev = await events(null, 'hq.settings_update');
    assert.match(ev.at(-1).summary, /support email/);
  });

  test("system email goes out under HQ's sender name, on EMAIL_FROM's address", async () => {
    await t.superPool.query("INSERT INTO email_outbox (to_address, subject, text_body, template) VALUES ('someone@example.test', 'Hi', 'Body', 'test')");
    const sent = [];
    const r = await drainPlatformEmail(t.db, { send: async (m) => { sent.push(m.from); return { id: 'x' }; }, cfg: { provider: 'resend', apiKey: 'test-key', from: 'Fishtape <noreply@fishtapehq.test>' } });
    assert.ok(r.sent >= 1);
    assert.ok(sent.every((f) => f === 'Fishtape help <noreply@fishtapehq.test>'), JSON.stringify(sent));
  });

  test('Stripe check names the account and finds price and webhook problems', async () => {
    const r = await hq(staff.token, '/api/hq/settings/stripe');
    assert.equal(r.body.account.name, 'True Collar Built');
    assert.equal(r.body.prices.find((p) => p.key === 'fishtape_starter_monthly_cad').ok, true);
    assert.equal(r.body.prices.find((p) => p.key === 'fishtape_pro_monthly_cad').ok, false, 'amount differs from plans.js');
    assert.equal(r.body.prices.find((p) => p.key === 'fishtape_business_monthly_cad').found, false);
    assert.equal(r.body.webhook.endpoint.status, 'enabled');
    assert.ok(r.body.webhook.endpoint.missingEvents.includes('checkout.session.completed'));
    assert.ok(r.body.problems.some((p) => /stripe-setup/.test(p)));
  });

  test('email check (live call injected)', async () => {
    const r = await hq(staff.token, '/api/hq/settings/email?live=true');
    assert.equal(r.body.keySet, true);
    assert.equal(r.body.live.status, 'ok');
  });

  test('a new terms version with re-acceptance is asked for until accepted', async () => {
    assert.deepEqual((await call(app, { url: '/api/v1/announcements', token: A.token })).body.legal, []);
    await hq(admin.token, '/api/hq/settings', { method: 'PUT', body: { legal: { terms: { version: '2026-11-01', requireReacceptance: true } } } });
    const pub = await call(app, { url: '/api/v1/legal' });
    assert.equal(pub.body.terms.version, '2026-11-01');
    assert.equal((await call(app, { url: '/api/v1/public/signup' })).body.termsVersion, '2026-11-01', 'sign-up asks for the version HQ set');
    const need = (await call(app, { url: '/api/v1/announcements', token: A.token })).body.legal;
    assert.deepEqual(need.map((d) => [d.doc, d.version]), [['terms', '2026-11-01']]);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/legal/accept', token: A.token, body: { doc: 'terms', version: 'old' } })).status, 409);
    const ok = await call(app, { method: 'POST', url: '/api/v1/legal/accept', token: A.token, body: { doc: 'terms', version: '2026-11-01' } });
    assert.deepEqual(ok.body.needsAcceptance, []);
    assert.deepEqual((await call(app, { url: '/api/v1/announcements', token: A.token })).body.legal, []);
    assert.equal((await call(app, { url: '/api/v1/announcements', token: B.token })).body.legal.length, 1, 'Bravo has not accepted');
    assert.equal((await events(null, 'legal.accept')).length, 1);
  });
});

describe('users', { skip }, () => {
  test('every user with companies, roles and MFA; no hashes or secrets', async () => {
    const r = await hq(staff.token, '/api/hq/users');
    const owner = r.body.data.find((u) => u.id === A.userId);
    assert.equal(owner.mfa, true);
    assert.deepEqual(owner.memberships.map((m) => [m.tenantName, m.role]), [['Alpha Wiring', 'owner']]);
    const text = JSON.stringify(r.body);
    for (const bad of ['password_hash', 'pin_hash', 'token_hash', 'secret_enc', '$argon2']) assert.ok(!text.includes(bad), bad);
    assert.equal((await events(null, 'hq.users_view')).length >= 1, true);
  });

  test('unlock clears password and PIN lockouts, audited in the company too', async () => {
    await t.superPool.query("UPDATE users SET failed_logins = 4, locked_until = now() + interval '10 minutes' WHERE id = $1", [crew.userId]);
    await t.superPool.query("UPDATE memberships SET pin_failed = 5, pin_locked_until = now() + interval '10 minutes' WHERE user_id = $1", [crew.userId]);
    const before = (await hq(staff.token, '/api/hq/users')).body.data.find((u) => u.id === crew.userId);
    assert.equal(before.locked, true);
    assert.equal(before.pinLocked, true);
    const r = await hq(admin.token, `/api/hq/users/${crew.userId}/unlock`, { method: 'POST', body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.locked, false);
    assert.equal(r.body.user.pinLocked, false);
    assert.equal((await events(A.tenantId, 'hq.user_unlock')).length, 1);
  });

  test('revoke sessions signs the person out', async () => {
    assert.equal((await call(app, { url: '/api/v1/clients', token: crew.token })).status, 200);
    const r = await hq(admin.token, `/api/hq/users/${crew.userId}/revoke-sessions`, { method: 'POST', body: { reason: 'Lost phone on site' } });
    assert.ok(r.body.revoked >= 1);
    assert.equal((await call(app, { url: '/api/v1/clients', token: crew.token })).status, 401);
    assert.match((await events(null, 'hq.user_revoke_sessions'))[0].summary, /Lost phone on site/);
  });

  test('force reset clears the password, signs out and emails a 24 h link; never on yourself', async () => {
    const self = await hq(admin.token, `/api/hq/users/${admin.userId}/force-reset`, { method: 'POST', body: { reason: 'testing self' } });
    assert.equal(self.status, 409);
    const r = await hq(admin.token, `/api/hq/users/${B.userId}/force-reset`, { method: 'POST', body: { reason: 'Account takeover worry' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.hasPassword, false);
    assert.equal((await call(app, { url: '/api/v1/clients', token: B.token })).status, 401);
    const mail = (await t.superPool.query("SELECT to_address, text_body FROM email_outbox WHERE template = 'password-reset-forced'")).rows;
    assert.equal(mail.length, 1);
    assert.match(mail[0].text_body, /#\/reset-password\?token=ftr_/);
    const link = (await t.superPool.query("SELECT expires_at - created_at AS ttl FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [B.userId])).rows[0];
    assert.equal(link.ttl.hours ?? link.ttl.days * 24, 24);
    assert.ok(!JSON.stringify(r.body).includes('ftr_'), 'the link is only in the email');
    assert.equal((await events(B.tenantId, 'hq.user_force_reset')).length, 1);
  });
});

describe('announcements', { skip }, () => {
  let onlyOn;
  test('admin creates, targets and schedules; companies see only theirs', async () => {
    const mk = (body) => hq(admin.token, '/api/hq/announcements', { method: 'POST', body });
    onlyOn = (await mk({ title: 'Ontario: new ESA forms', body: 'Updated permit forms are in.', targetProvinces: ['ON'], status: 'published', linkUrl: '#/compliance' })).body;
    await mk({ title: 'For trials', targetPlans: ['trial'], status: 'published' });
    await mk({ title: 'Draft one', status: 'draft' });
    await mk({ title: 'Next week', status: 'published', startsAt: new Date(Date.now() + 7 * 86400e3).toISOString() });
    const everyone = (await mk({ title: 'Everyone', status: 'published', dismissible: true })).body;
    assert.equal((await mk({ title: 'Bad link', linkUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await mk({ title: 'Bad dates', startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' })).status, 400);

    // Alpha: Pro in ON. Bravo needs a fresh session (force-reset above): use an office member.
    const bravoOffice = await addMember(t, app, B.tenantId, { role: 'office' });
    const a = (await call(app, { url: '/api/v1/announcements', token: A.token })).body.data.map((x) => x.title);
    const b = (await call(app, { url: '/api/v1/announcements', token: bravoOffice.token })).body.data.map((x) => x.title);
    assert.deepEqual(a.sort(), ['Everyone', 'Ontario: new ESA forms']);
    assert.deepEqual(b.sort(), ['Everyone', 'For trials'], 'Bravo is on a trial in BC');
    assert.equal(everyone.status, 'published');

    const list = await hq(staff.token, '/api/hq/announcements');
    assert.equal(list.body.data.find((x) => x.title === 'Ontario: new ESA forms').reach, 1);
    assert.equal(list.body.data.find((x) => x.title === 'Next week').live, false);
    assert.equal((await events(null, 'hq.announcement_create')).length, 5);
  });

  test('dismissals are per person', async () => {
    const r = await call(app, { method: 'POST', url: `/api/v1/announcements/${onlyOn.id}/dismiss`, token: A.token });
    assert.equal(r.status, 204);
    assert.ok(!(await call(app, { url: '/api/v1/announcements', token: A.token })).body.data.some((x) => x.id === onlyOn.id));
    const other = await addMember(t, app, A.tenantId, { role: 'foreman' });
    assert.ok((await call(app, { url: '/api/v1/announcements', token: other.token })).body.data.some((x) => x.id === onlyOn.id));
    const bravoOffice = await addMember(t, app, B.tenantId, { role: 'office' });
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/announcements/${onlyOn.id}/dismiss`, token: bravoOffice.token })).status, 404, 'not shown to Bravo');
    const sticky = (await hq(admin.token, '/api/hq/announcements', { method: 'POST', body: { title: 'Maintenance tonight', status: 'published', dismissible: false, tone: 'warning' } })).body;
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/announcements/${sticky.id}/dismiss`, token: A.token })).status, 400);
    assert.equal((await hq(staff.token, '/api/hq/announcements')).body.data.find((x) => x.id === onlyOn.id).dismissals, 1);
    const arch = await hq(admin.token, `/api/hq/announcements/${sticky.id}`, { method: 'PATCH', body: { status: 'archived' } });
    assert.equal(arch.body.status, 'archived');
    assert.ok(!(await call(app, { url: '/api/v1/announcements', token: A.token })).body.data.some((x) => x.id === sticky.id));
  });
});

describe('help center', { skip }, () => {
  let draft;
  test('ten starter articles are published in categories', async () => {
    const r = await call(app, { url: '/api/v1/help/articles', token: A.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 10);
    assert.ok(r.body.categories.length >= 5);
    assert.equal(r.body.support.email, 'help@fishtapehq.com');
    const one = await call(app, { url: '/api/v1/help/articles/pipe-bending', token: crew.token ? A.token : A.token });
    assert.match(one.body.body, /##/);
    const s = await call(app, { method: 'POST', url: '/api/v1/help/search', token: A.token, body: { q: 'scale' } });
    assert.ok(s.body.data.some((a) => a.slug === 'setting-the-scale'));
    assert.equal((await call(app, { url: '/api/v1/help/articles' })).status, 401);
  });

  test('staff write drafts; companies never see drafts; admins publish', async () => {
    const c = await hq(staff.token, '/api/hq/help/articles', { method: 'POST', body: { title: 'Secret roadmap notes', summary: 'internal', body: 'Zebracorn feature coming', categoryId: 'getting-started' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    draft = c.body;
    assert.equal(draft.status, 'draft');
    assert.equal(draft.slug, 'secret-roadmap-notes');
    assert.equal((await hq(staff.token, '/api/hq/help/articles', { method: 'POST', body: { title: 'x', status: 'published' } })).status, 403);
    const list = (await call(app, { url: '/api/v1/help/articles', token: A.token })).body.data;
    assert.ok(!list.some((a) => a.id === draft.id));
    assert.equal((await call(app, { url: `/api/v1/help/articles/${draft.slug}`, token: A.token })).status, 404);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/help/search', token: A.token, body: { q: 'zebracorn' } })).body.data.length, 0);
    assert.equal((await hq(staff.token, '/api/hq/help/search', { method: 'POST', body: { q: 'zebracorn' } })).body.data.length, 1, 'HQ sees drafts');
    // RLS backs the query filter: the app role cannot read a draft even asking directly.
    const rows = await t.db.withTenant({ tenantId: A.tenantId }, (tx) => tx.query('SELECT id FROM help_articles WHERE id = $1', [draft.id]));
    assert.equal(rows.rows.length, 0);

    assert.equal((await hq(staff.token, `/api/hq/help/articles/${draft.id}`, { method: 'PATCH', body: { status: 'published' } })).status, 403);
    assert.equal((await hq(staff.token, `/api/hq/help/articles/${draft.id}`, { method: 'PATCH', body: { body: 'Zebracorn, revised' } })).status, 200);
    const pub = await hq(admin.token, `/api/hq/help/articles/${draft.id}`, { method: 'PATCH', body: { status: 'published' } });
    assert.equal(pub.body.status, 'published');
    assert.ok(pub.body.publishedAt);
    assert.equal((await call(app, { url: `/api/v1/help/articles/${draft.slug}`, token: A.token })).status, 200);
    assert.equal((await hq(staff.token, `/api/hq/help/articles/${draft.id}`, { method: 'PATCH', body: { body: 'staff edit' } })).status, 403, 'published: admins edit');
    assert.equal((await hq(admin.token, '/api/hq/help/articles', { method: 'POST', body: { title: 'Secret roadmap notes' } })).status, 409, 'slug taken');
    assert.equal((await events(null, 'hq.help_publish')).length, 1);
    assert.equal((await hq(staff.token, `/api/hq/help/articles/${draft.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await hq(admin.token, `/api/hq/help/articles/${draft.id}`, { method: 'DELETE' })).status, 204);
  });

  test('categories: admin only', async () => {
    const r = await hq(admin.token, '/api/hq/help/categories/billing', { method: 'PUT', body: { name: 'Billing', position: 60 } });
    assert.ok(r.body.categories.some((c) => c.id === 'billing'));
    assert.equal((await hq(admin.token, '/api/hq/help/categories/billing', { method: 'DELETE' })).status, 204);
  });
});

describe('developer, AI and the audit log', { skip }, () => {
  test('API usage per company and per API key', async () => {
    const k = await apiKey(app, A.token, ['clients:read'], 'Zapier');
    for (let i = 0; i < 3; i++) await call(app, { url: '/api/v1/clients', token: k });
    await call(app, { url: '/api/v1/clients', token: A.token });
    const r = await hq(staff.token, '/api/hq/developer/usage');
    const alpha = r.body.companies.find((c) => c.tenantId === A.tenantId);
    assert.ok(alpha.requests >= 4);
    assert.equal(alpha.apiKeyRequests, 3);
    const keyRow = r.body.keys.find((x) => x.name === 'Zapier');
    assert.equal(keyRow.requests, 3);
    assert.ok(keyRow.prefix.startsWith('ft_'));
    assert.ok(!JSON.stringify(r.body).includes(k), 'never the key itself');
  });

  test('developer info and webhook log', async () => {
    const d = await hq(staff.token, '/api/hq/developer');
    assert.equal(d.body.environment, 'test');
    assert.equal(d.body.migrations.pending.length, 0);
    const spec = await hq(staff.token, '/api/hq/openapi.json');
    assert.ok(spec.body.paths['/api/v1/help/articles'].get.summary);
    assert.equal((await call(app, { url: '/api/hq/openapi.json', token: A.token })).status, 403);
    assert.ok(Array.isArray(d.body.errors.recent));
    await t.superPool.query("INSERT INTO integration_events (tenant_id, provider, event_id, kind) VALUES ($1, 'stripe', 'evt_1234567890abcdefghijklmnop', 'checkout.session.completed')", [A.tenantId]);
    const w = await hq(staff.token, '/api/hq/developer/webhooks');
    assert.equal(w.body.company[0].tenantName, 'Alpha Wiring');
    assert.ok(w.body.company[0].eventId.includes('…'), 'long ids are shortened');
    assert.equal((await events(null, 'hq.webhooks_view')).length >= 1, true);
  });

  test('AI usage, caps (audited in the company) and errors', async () => {
    await t.superPool.query(
      `INSERT INTO ai_usage (tenant_id, feature, model, input_tokens, output_tokens, cost_micro_usd) VALUES
         ($1, 'assistant', 'claude-opus-5-5', 1000, 500, 45000000), ($2, 'cec', 'claude-opus-5-5', 10, 5, 100000)`, [A.tenantId, B.tenantId]);
    // An AI error before streaming (no key) is recorded by code. The assistant is a Business feature.
    await t.superPool.query("UPDATE tenants SET plan = 'business' WHERE id = $1", [A.tenantId]);
    const conv = await call(app, { method: 'POST', url: '/api/v1/ai/conversations', token: A.token, body: { mode: 'assistant', units: 'metric' } });
    const say = await call(app, { method: 'POST', url: `/api/v1/ai/conversations/${conv.body.id}/messages`, token: A.token, body: { text: 'hi' } });
    assert.equal(say.body.error.code, 'ai_not_connected');
    // Streamed replies pass through untouched while tool calls and mid-stream errors are counted.
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => setSecret(tx, app.sealer, 'anthropic.api_key', ['sk', 'ant', 'api03', 'hqconsoletestkey'].join('-')));
    mockAnthropic([turn([text('Looking.'), toolUse('search_price_book', { query: 'receptacle' })]), turn([text('Found two receptacles.')]), authError()]);
    const stream = await app.inject({ method: 'POST', url: `/api/v1/ai/conversations/${conv.body.id}/messages`, headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, payload: { text: 'price of a receptacle?' } });
    const evs = sse(stream.body);
    assert.ok(evs.some((e) => e.event === 'tool' && e.data.name === 'search_price_book' && e.data.status === 'done'));
    assert.match(evs.filter((e) => e.event === 'text').map((e) => e.data.delta).join(''), /Found two receptacles/);
    assert.equal(evs.at(-1).event, 'done');
    const bad = await app.inject({ method: 'POST', url: `/api/v1/ai/conversations/${conv.body.id}/messages`, headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, payload: { text: 'again' } });
    assert.ok(sse(bad.body).some((e) => e.event === 'error' && e.data.code === 'ai_key_rejected'));
    restoreAnthropic();
    const r = await hq(staff.token, '/api/hq/ai');
    assert.ok(r.body.tools.some((x) => x.tool === 'search_price_book' && x.via === 'assistant' && x.calls === 1));
    assert.ok(r.body.errors.some((e) => e.code === 'ai_key_rejected' && e.feature === 'chat'));
    assert.ok(!JSON.stringify(r.body).includes('receptacle'), 'no prompt or reply text in HQ');
    assert.equal(r.body.config.model, 'claude-opus-5-5');
    assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(r.body.config.effort));
    const alpha = r.body.usage.find((u) => u.tenantId === A.tenantId);
    assert.ok(alpha.costCents >= 4500 && alpha.costCents < 4600, String(alpha.costCents));
    assert.ok(r.body.nearCap.some((c) => c.tenantId === A.tenantId && c.pct >= 90), 'about US$45 of the US$50 default');
    assert.ok(r.body.errors.some((e) => e.code === 'ai_not_connected' && e.tenantName === 'Alpha Wiring'));

    assert.equal((await hq(admin.token, `/api/hq/ai/caps/${A.tenantId}`, { method: 'PUT', body: { monthlyCapCents: 20000 } })).status, 400, 'reason required');
    const set = await hq(admin.token, `/api/hq/ai/caps/${A.tenantId}`, { method: 'PUT', body: { monthlyCapCents: 20000, reason: 'Busy month, asked by owner' } });
    assert.equal(set.body.monthlyCapCents, 20000);
    const ev = await events(A.tenantId, 'hq.ai_cap_set');
    assert.match(ev[0].summary, /US\$50\.00\) to US\$200\.00: Busy month/);
    const back = await hq(admin.token, `/api/hq/ai/caps/${A.tenantId}`, { method: 'PUT', body: { monthlyCapCents: null, reason: 'Back to the default' } });
    assert.equal(back.body.capIsDefault, true);
  });

  test('audit log: one company\'s chain with verification, filters, paging; viewing is logged in that chain', async () => {
    const r = await hq(staff.token, '/api/hq/audit/search', { method: 'POST', body: { scope: A.tenantId, limit: 5 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verification.ok, true);
    assert.equal(r.body.data.length, 5);
    assert.equal(r.body.more, true);
    const next = await hq(staff.token, '/api/hq/audit/search', { method: 'POST', body: { scope: A.tenantId, limit: 5, cursor: r.body.cursor } });
    assert.ok(next.body.data[0].seq < r.body.data[4].seq);
    const filtered = await hq(staff.token, '/api/hq/audit/search', { method: 'POST', body: { scope: A.tenantId, action: 'hq.invoice' } });
    assert.ok(filtered.body.data.length >= 3 && filtered.body.data.every((e) => e.action.startsWith('hq.invoice')));
    const byActor = await hq(staff.token, '/api/hq/audit/search', { method: 'POST', body: { scope: 'hq', actor: 'hq_admin' } });
    assert.ok(byActor.body.data.length > 0 && byActor.body.data.every((e) => e.actorType === 'hq'));
    const hour = 3600e3;
    const dated = await hq(staff.token, '/api/hq/audit/search', { method: 'POST', body: { scope: 'platform', from: new Date(Date.now() - hour).toISOString(), to: new Date(Date.now() + hour).toISOString() } });
    const old = await hq(staff.token, '/api/hq/audit/search', { method: 'POST', body: { scope: 'platform', to: new Date(Date.now() - 24 * hour).toISOString() } });
    assert.equal(old.body.data.length, 0);
    assert.equal(dated.body.verification.ok, true);
    assert.ok(dated.body.data.length > 0);
    assert.ok((await events(A.tenantId, 'hq.audit_view')).length >= 1);
    const all = await hq(staff.token, '/api/hq/audit/verify-all', { method: 'POST' });
    assert.equal(all.body.ok, true);
    assert.ok(all.body.chains.some((c) => c.name === 'Platform'));
  });
});

describe('no secrets anywhere', { skip }, () => {
  test('no response carried a key, hash or token', () => {
    assert.ok(responses.length > 50);
    for (const { url, body } of responses) {
      for (const s of [SECRETS.STRIPE_SECRET_KEY, SECRETS.RESEND_API_KEY, 'whsec_', 'password_hash', 'token_hash', 'secret_enc', '$argon2']) {
        assert.ok(!String(body).includes(s), `${url} leaked ${s}`);
      }
    }
  });
});
