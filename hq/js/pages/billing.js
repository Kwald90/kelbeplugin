// HQ billing: Fishtape's own subscriptions (Stripe), plan mix, failed payments, MRR estimate.
import { get } from '../api.js';
import { TONE, ago, planName } from '../fmt.js';

const MIX_ORDER = ['trial', 'starter', 'pro', 'business', 'enterprise'];

export default {
  render(root, { ui, nav }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    root.append(ui.page({ title: 'Billing', subtitle: 'Fishtape subscriptions on Fishtape\'s own Stripe account' }, body));
    const money = (cents, cur) => (cents == null ? '—' : `${ui.fmtMoney(cents)}${cur && cur !== 'cad' ? ` ${cur.toUpperCase()}` : ''}`);

    async function load() {
      let b;
      try { b = await get('/api/hq/billing'); } catch (e) { ui.clear(body); body.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message })); return; }
      ui.clear(body);
      if (!b.stripeConfigured || !b.webhookConfigured) {
        body.append(h('div', { class: 'hq-banner degraded' }, ui.icon('alert', 20), h('div', null,
          h('strong', null, 'Stripe is not fully set up here'),
          h('span', { class: 'hq-small' }, `${b.stripeConfigured ? '' : 'STRIPE_SECRET_KEY is missing. '}${b.webhookConfigured ? '' : 'STRIPE_WEBHOOK_SECRET is missing. '}Run server/scripts/stripe-setup.js, then add the webhook endpoint /api/v1/webhooks/platform-stripe.`))));
      }
      const pastDue = b.subscriptions.filter((s) => s.status === 'past_due' || s.graceEndsAt);
      const totalMix = Object.values(b.planMix).reduce((a, n) => a + n, 0) || 1;
      body.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'MRR (estimate)', value: ui.fmtMoney(b.mrrCents, { whole: true }), hint: 'Plan prices plus extra users, CAD', tone: 'success' }),
        ui.stat({ label: 'Subscriptions', value: b.subscriptions.filter((s) => ['active', 'past_due', 'trialing'].includes(s.status)).length, hint: `${b.subscriptions.length} with any Stripe state` }),
        ui.stat({ label: 'Past due', value: pastDue.length, tone: pastDue.length ? 'danger' : null }),
        ui.stat({ label: 'Failed payments (90 d)', value: b.failedPayments.length, tone: b.failedPayments.length ? 'danger' : null })));

      body.append(...ui.section('Plan mix (companies not closing)', h('div', { class: 'card stack' },
        MIX_ORDER.filter((k) => b.planMix[k]).map((k) => h('div', { class: 'hq-bar' },
          h('span', null, planName(k)),
          h('div', { class: 'progress', role: 'img', 'aria-label': `${planName(k)}: ${b.planMix[k]} companies` }, h('i', { style: { width: `${(b.planMix[k] / totalMix) * 100}%` } })),
          h('span', { class: 'right num' }, String(b.planMix[k])))))));

      body.append(...ui.section('Subscriptions', ui.table({
        columns: [
          { key: 'name', label: 'Company', render: (s) => h('strong', null, s.tenantName), sort: (s) => s.tenantName },
          { key: 'plan', label: 'Plan', render: (s) => h('div', null, planName(s.plan || s.effectivePlan), s.plan && s.plan !== s.effectivePlan ? h('div', { class: 'muted hq-small' }, `in force: ${planName(s.effectivePlan)}`) : null) },
          { key: 'status', label: 'Status', render: (s) => ui.badge(s.status.replace(/_/g, ' '), TONE[s.status]), sort: (s) => s.status },
          { key: 'seats', label: 'Seats (used / billed)', align: 'right', render: (s) => `${s.seats} / ${s.billedSeats ?? '—'}` },
          { key: 'renews', label: 'Renews', render: (s) => (s.currentPeriodEnd ? `${ui.fmtDate(s.currentPeriodEnd)}${s.cancelAtPeriodEnd ? ' (cancels)' : ''}` : '—') },
          { key: 'grace', label: 'Grace ends', render: (s) => (s.graceEndsAt ? ui.badge(ui.fmtDate(s.graceEndsAt), 'danger') : '—') },
        ],
        rows: b.subscriptions,
        onRowClick: (s) => nav(`tenants/${s.tenantId}`),
        empty: h('div', { class: 'card flat muted' }, 'No company has subscribed yet.'),
      })));

      body.append(...ui.section('Failed payments', ui.table({
        columns: [
          { key: 'at', label: 'When', render: (e) => `${ui.fmtDateTime(e.at)} (${ago(e.at)})`, sort: (e) => e.at },
          { key: 'company', label: 'Company', render: (e) => (e.tenantId ? h('a', { href: `#/tenants/${e.tenantId}` }, e.tenantName) : h('span', { class: 'muted' }, 'Unknown customer')) },
          { key: 'amount', label: 'Amount', align: 'right', render: (e) => money(e.amountCents, e.currency) },
          { key: 'summary', label: 'Detail', render: (e) => e.summary || '—' },
        ],
        rows: b.failedPayments,
        empty: h('div', { class: 'card flat muted' }, 'No failed payments in the last 90 days.'),
      })));

      body.append(...ui.section('Recent Stripe events', ui.table({
        columns: [
          { key: 'at', label: 'Received', render: (e) => ui.fmtDateTime(e.at) },
          { key: 'type', label: 'Type', render: (e) => h('span', { class: 'mono hq-small' }, e.type) },
          { key: 'company', label: 'Company', render: (e) => e.tenantName || '—' },
          { key: 'amount', label: 'Amount', align: 'right', render: (e) => money(e.amountCents, e.currency) },
          { key: 'outcome', label: 'Outcome', render: (e) => ui.badge(e.outcome.replace(/_/g, ' '), e.outcome === 'applied' ? 'success' : e.outcome === 'unknown_customer' ? 'warning' : 'neutral') },
        ],
        rows: b.recentEvents,
        empty: h('div', { class: 'card flat muted' }, 'No webhook events yet.'),
      })));
    }

    load();
    return () => {};
  },
};
