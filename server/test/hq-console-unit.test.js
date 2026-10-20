// HQ console pieces that need no database: finance math, CSV, announcement targeting, the
// SSE tap that counts assistant tools, settings validation, help snippets and the HQ URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { computeFinance, csvCell, financeCsv, invoiceTax, isFishtapeInvoice, isFishtapeSubscription, listAll, subscriptionMonthlyCents } from '../src/services/hq-finance.js';
import { matchesAudience, isLive } from '../src/routes/hq-announcements.js';
import { aiFeatureOf, sseTap } from '../src/routes/hq-ai.js';
import { createErrorRing } from '../src/routes/hq-developer.js';
import { settingsProblems, stripeMode } from '../src/services/hq-settings.js';
import { plainSnippet, slugify } from '../src/services/hq-help.js';
import { hqUrl } from '../src/services/hq-common.js';
import { invoice, sub, subItem } from './support/fake-stripe-finance.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const now = NOW.getTime();
const DAY = 86_400_000;
const at = (days) => new Date(now + days * DAY);

function scenario() {
  const tenants = [
    { id: 'A', stripe_customer_id: 'cus_a', plan: 'starter', trial_ends_at: null, billing_status: 'active' },
    { id: 'B', stripe_customer_id: 'cus_b', plan: 'business', trial_ends_at: at(3), billing_status: 'trialing' },
    { id: 'C', stripe_customer_id: 'cus_c', plan: 'trial', trial_ends_at: at(-10), billing_status: 'none' },
    { id: 'D', stripe_customer_id: 'cus_d', plan: 'pro', trial_ends_at: at(-20), billing_status: 'active' },
    { id: 'E', stripe_customer_id: 'cus_e', plan: 'pro', trial_ends_at: null, billing_status: 'active' },
  ];
  const o = { now };
  const subscriptions = [
    sub('sub_a', 'cus_a', 'active', [subItem('fishtape_starter_monthly_cad', 4900), subItem('fishtape_extra_user_monthly_cad', 1500, 2)], { ...o, periodEndInDays: 20 }),
    sub('sub_d', 'cus_d', 'active', [subItem('fishtape_pro_monthly_cad', 12900)], { ...o, periodEndInDays: 5 }),
    { ...sub('sub_b', 'cus_b', 'trialing', [subItem('fishtape_business_monthly_cad', 27900)], { ...o, periodEndInDays: 3 }), trial_end: Math.floor(at(3) / 1000) },
    sub('sub_x', 'cus_x', 'canceled', [subItem('fishtape_starter_monthly_cad', 4900)], { ...o, createdDaysAgo: 100, canceledDaysAgo: 5 }),
    sub('sub_e', 'cus_e', 'active', [subItem('fishtape_pro_yearly_cad', 120000, 1, 'year')], { ...o, periodEndInDays: 200 }),
  ];
  subscriptions[3].metadata = { tenant_id: 'X' };
  const invoices = [
    invoice('in_a1', 'cus_a', 'paid', { amountPaid: 7900, tax: 395, daysAgo: 2, now }),
    invoice('in_d1', 'cus_d', 'paid', { amountPaid: 12900, tax: 645, daysAgo: 2, now }),
    invoice('in_b1', 'cus_b', 'open', { amountDue: 27900, amountRemaining: 27900, attempts: 2, daysAgo: 1, now }),
    invoice('in_old', 'cus_a', 'paid', { amountPaid: 7900, tax: 395, daysAgo: 40, now }),
  ];
  const refunds = [{ id: 're_1', amount: 1000, status: 'succeeded', created: Math.floor((now - DAY) / 1000), charge: { customer: 'cus_a' } }];
  const signups = [
    { status: 'completed', deposit_paid_cents: 100, deposit_paid_at: at(-3), credited_at: at(-3), tenant_id: 'B' },
    { status: 'completed', deposit_paid_cents: 100, deposit_paid_at: at(-25), credited_at: at(-25), tenant_id: 'D' },
    { status: 'failed', deposit_paid_cents: 100, deposit_paid_at: at(-2), credited_at: null, tenant_id: null },
  ];
  return { tenants, subscriptions, invoices, refunds, signups, failedEvents30d: 3, now: NOW };
}

test('MRR and ARR count active and past-due subscriptions at monthly list prices', () => {
  const f = computeFinance(scenario());
  // 4900 + 2 x 1500 (Alpha) + 12900 (Delta) + 120000 / 12 (yearly) ; trialing Bravo is not revenue yet
  assert.equal(f.mrrCents, 7900 + 12900 + 10000);
  assert.equal(f.arrCents, f.mrrCents * 12);
  const starter = f.subscriptions.byPlan.find((p) => p.plan === 'starter');
  assert.deepEqual([starter.active, starter.mrrCents], [1, 7900]);
  assert.equal(f.subscriptions.byPlan.find((p) => p.plan === 'business').trialing, 1);
  assert.equal(f.subscriptions.active, 3);
});

test('monthly normalisation of intervals', () => {
  assert.equal(subscriptionMonthlyCents({ items: { data: [subItem('k', 1200, 1, 'year')] } }), 100);
  assert.equal(subscriptionMonthlyCents({ items: { data: [subItem('k', 1000, 3)] } }), 3000);
  assert.equal(subscriptionMonthlyCents({ items: { data: [{ price: { unit_amount: 100, recurring: { interval: 'week', interval_count: 2 } }, quantity: 1 }] } }), 217);
  assert.equal(subscriptionMonthlyCents({ items: { data: [{ price: { unit_amount: 100 } }] } }), 0, 'one-time prices are not MRR');
});

test('trials, conversion and churn', () => {
  const f = computeFinance(scenario());
  assert.equal(f.trials.active, 1, 'Bravo is trialing');
  assert.equal(f.trials.endingIn7Days, 1);
  assert.equal(f.trials.endedLast90Days, 2, 'Charlie and Delta');
  assert.equal(f.trials.converted, 1, 'Delta pays');
  assert.equal(f.trials.conversionPct, 50);
  assert.equal(f.churn.canceledLast30Days, 1);
  assert.equal(f.churn.baseSubscriptions, 4, 'live 30 days ago, trials still running excluded');
  assert.equal(f.churn.ratePct, 25);
  assert.equal(f.churn.lostMrrCents, 4900);
});

test('revenue, refunds, tax, deposits, renewals and failed payments', () => {
  const f = computeFinance(scenario());
  assert.equal(f.revenue.length, 12);
  assert.equal(f.revenue[11].month, '2026-10');
  assert.deepEqual(f.thisMonth, { grossCents: 20800, refundsCents: 1000, netCents: 19800 });
  assert.equal(f.revenue[10].grossCents, 7900, 'September');
  assert.equal(f.revenue[11].taxCents, 1040);
  assert.equal(f.tax.present, true);
  assert.equal(f.tax.collectedLast12MonthsCents, 1435);
  assert.equal(f.refunds.last30DaysCents, 1000);
  assert.equal(f.refunds.recent[0].tenantId, 'A');
  assert.deepEqual(f.deposits, { count: 3, totalCents: 300, last30Days: 3, credited: 2, toRefund: 1, becamePaying: 1 });
  assert.equal(f.revenue[11].depositsCents, 200);
  assert.deepEqual(f.renewals.map((r) => r.tenantId), ['B', 'D'], 'soonest first, within 14 days');
  assert.equal(f.renewals[0].firstCharge, true);
  assert.equal(f.failedPayments.open.length, 1);
  assert.deepEqual([f.failedPayments.open[0].tenantId, f.failedPayments.open[0].amountCents, f.failedPayments.open[0].attempts], ['B', 27900, 2]);
  assert.equal(f.failedPayments.eventsLast30Days, 3);
});

test('no tax data gives a clear note', () => {
  const s = scenario();
  s.invoices = s.invoices.map(({ total_taxes, automatic_tax, ...rest }) => rest);
  const f = computeFinance(s);
  assert.equal(f.tax.present, false);
  assert.match(f.tax.note, /Stripe Tax is not turned on/);
  assert.equal(invoiceTax({ tax: 50 }), 50);
  assert.equal(invoiceTax({}), null);
});

test('only Fishtape objects count on the shared Stripe account', () => {
  const customers = new Set(['cus_a']);
  assert.equal(isFishtapeSubscription(sub('s', 'cus_tcb', 'active', [subItem('tcb_reno_retainer', 50000)]), customers), false);
  assert.equal(isFishtapeSubscription(sub('s', 'cus_new', 'active', [subItem('fishtape_pro_monthly_cad', 12900)]), customers), true);
  assert.equal(isFishtapeSubscription(sub('s', 'cus_a', 'active', []), customers), true);
  assert.equal(isFishtapeInvoice(invoice('in_t', 'cus_tcb', 'paid'), customers), false);
  assert.equal(isFishtapeInvoice({ customer: 'cus_z', lines: { data: [{ pricing: { price_details: { price: { lookup_key: 'fishtape_signup_deposit_cad' } } } }] } }, customers), true);
});

test('listAll pages with starting_after', async () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}` }));
  const list = async ({ starting_after, limit }) => {
    const from = starting_after ? items.findIndex((x) => x.id === starting_after) + 1 : 0;
    return { data: items.slice(from, from + limit), has_more: from + limit < items.length };
  };
  assert.equal((await listAll(list)).length, 250);
  assert.equal((await listAll(list, {}, 120)).length, 200, 'stops after the page that passes max');
});

test('CSV: quoting and formula injection', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell('@SUM'), "'@SUM");
  const csv = financeCsv('revenue', computeFinance(scenario()));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'month,gross_cad,refunds_cad,net_cad,tax_cad,deposits_cad,paid_invoices');
  assert.equal(lines[12], '2026-10,208.00,10.00,198.00,10.40,2.00,2');
  const renewals = financeCsv('renewals', computeFinance(scenario()), new Map([['B', '=Bravo, Inc.']]));
  assert.match(renewals, /"'=Bravo, Inc\."/);
  assert.throws(() => financeCsv('nope', computeFinance(scenario())), /Unknown export/);
});

test('announcement targeting by plan, trial and province', () => {
  const alpha = { plan: 'pro', province: 'ON', billing_status: 'active' };
  const trial = { plan: 'trial', trial_ends_at: at(5), province: 'BC', billing_status: 'none' };
  const selfServeTrial = { plan: 'starter', province: 'AB', billing_status: 'trialing' };
  assert.equal(matchesAudience({ target_plans: [], target_provinces: [] }, alpha), true);
  assert.equal(matchesAudience({ target_plans: ['pro'], target_provinces: [] }, alpha), true);
  assert.equal(matchesAudience({ target_plans: ['starter'], target_provinces: [] }, alpha), false);
  assert.equal(matchesAudience({ target_plans: ['trial'], target_provinces: [] }, trial), true);
  assert.equal(matchesAudience({ target_plans: ['business'], target_provinces: [] }, trial), true, 'a running trial has Business');
  assert.equal(matchesAudience({ target_plans: ['trial'], target_provinces: [] }, selfServeTrial), true);
  assert.equal(matchesAudience({ target_plans: [], target_provinces: ['ON', 'MB'] }, alpha), true);
  assert.equal(matchesAudience({ target_plans: ['pro'], target_provinces: ['BC'] }, alpha), false);
  assert.equal(isLive({ status: 'published', starts_at: at(-1), ends_at: null }, NOW), true);
  assert.equal(isLive({ status: 'published', starts_at: at(1), ends_at: null }, NOW), false, 'scheduled');
  assert.equal(isLive({ status: 'published', starts_at: at(-3), ends_at: at(-1) }, NOW), false, 'ended');
  assert.equal(isLive({ status: 'draft', starts_at: at(-1) }, NOW), false);
});

test('the SSE tap passes every byte through and reports tool and error events', async () => {
  const seen = [];
  const src = new PassThrough();
  const tap = sseTap((ev, data) => seen.push([ev, data]));
  const out = [];
  tap.on('data', (c) => out.push(c));
  src.pipe(tap);
  const frames = 'event: start\ndata: {}\n\nevent: tool\ndata: {"name":"search_price_book","status":"done"}\n\nevent: text\ndata: {"delta":"hi"}\n\nevent: error\ndata: {"code":"ai_key_rejected","message":"x"}\n\n';
  src.write(frames.slice(0, 30));
  src.write(frames.slice(30, 77));
  src.end(frames.slice(77));
  await new Promise((r) => tap.on('end', r));
  assert.equal(Buffer.concat(out).toString(), frames);
  assert.deepEqual(seen.map((s) => [s[0], s[1].name || s[1].code]), [['tool', 'search_price_book'], ['error', 'ai_key_rejected']]);
  assert.equal(aiFeatureOf('/api/mcp'), 'mcp');
  assert.equal(aiFeatureOf('/api/v1/ai/conversations/:id/messages'), 'chat');
  assert.equal(aiFeatureOf('/api/v1/clients'), null);
});

test('error ring keeps the newest entries first, bounded', () => {
  const r = createErrorRing(3);
  for (let i = 0; i < 5; i++) r.add({ i });
  assert.deepEqual(r.list().map((x) => x.i), [4, 3, 2]);
});

test('settings validation, Stripe key mode, help snippets and slugs', () => {
  assert.deepEqual(settingsProblems({ support: { email: 'help@fishtapehq.com', senderName: 'Fishtape support' } }), []);
  assert.equal(settingsProblems({ support: { email: 'nope' } })[0].path, '/support/email');
  assert.equal(settingsProblems({ support: { senderName: 'Evil <x@y.z>' } })[0].path, '/support/senderName');
  assert.equal(settingsProblems({ legal: { terms: { version: 'v 2' } } })[0].path, '/legal/terms/version');
  assert.equal(settingsProblems({ legal: { privacy: { url: 'javascript:alert(1)' } } })[0].path, '/legal/privacy/url');
  assert.deepEqual(settingsProblems({ legal: { terms: { version: '2026-11-01', url: '/site/terms.html' } } }), []);
  assert.equal(stripeMode('sk_live_abc'), 'live');
  assert.equal(stripeMode('rk_test_abc'), 'test');
  assert.equal(plainSnippet('Open **Drawings** and see [Settings](#/settings) <b>scale</b>'), 'Open Drawings and see Settings scale');
  assert.equal(slugify('Importing a PDF plan set!'), 'importing-a-pdf-plan-set');
});

test('HQ links in emails use HQ_PUBLIC_URL, else the app host /hq/', () => {
  const config = { publicOrigin: 'https://app.fishtapehq.com' };
  assert.equal(hqUrl(config, {}), 'https://app.fishtapehq.com/hq/');
  assert.equal(hqUrl(config, { HQ_PUBLIC_URL: 'https://hq.fishtapehq.com' }), 'https://hq.fishtapehq.com/');
  assert.equal(hqUrl(config, { HQ_PUBLIC_URL: 'https://tgelectrical.truecollarbuilt.com/hq/' }), 'https://tgelectrical.truecollarbuilt.com/hq/');
  assert.equal(hqUrl(config, { HQ_PUBLIC_URL: 'javascript:alert(1)' }), 'https://app.fishtapehq.com/hq/', 'anything odd falls back');
});
