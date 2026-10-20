// Finance: MRR/ARR, subscriptions by plan, trials and conversion, churn, $1 deposits,
// revenue by month, refunds, renewals and failed payments, GST/HST. From Fishtape's Stripe
// objects (the account is shared with True Collar Built; only Fishtape's count) and the
// database, cached by the worker; Refresh pulls from Stripe now.
import { get, post } from '../api.js';
import { ago, planName } from '../fmt.js';
import { banner, downloadFrom, loader } from '../kit.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) el.append(k);
  return el;
};

/** Net revenue per month: one series, bars from the baseline, a tooltip per bar. */
function revenueChart(ui, months) {
  const W = 600, H = 120, n = months.length, slot = W / n, barW = Math.max(4, slot - 8);
  const max = Math.max(1, ...months.map((m) => m.netCents));
  const chart = svg('svg', { class: 'hq-spark hq-rev', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Net revenue by month, last 12 months. Highest ${ui.fmtMoney(max, { whole: true })}.` });
  chart.append(svg('line', { class: 'base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
  months.forEach((m, i) => {
    const hgt = Math.max(0, (m.netCents / max) * (H - 6));
    const g = svg('g');
    g.append(svg('title', {}, `${m.month}: net ${ui.fmtMoney(m.netCents)} (gross ${ui.fmtMoney(m.grossCents)}, refunds ${ui.fmtMoney(m.refundsCents)})`));
    g.append(svg('rect', { class: 'hit', x: i * slot, y: 0, width: slot, height: H }));
    if (hgt > 0) g.append(svg('rect', { class: 'req', x: i * slot + (slot - barW) / 2, y: H - hgt, width: barW, height: hgt, rx: 3 }));
    chart.append(g);
  });
  // Month names in HTML below the bars, so they keep their shape when the chart stretches.
  const axis = ui.h('div', { class: 'hq-rev-axis', 'aria-hidden': 'true' },
    months.map((m) => ui.h('span', null, new Date(`${m.month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' }))));
  return ui.h('div', null, chart, axis);
}

export default {
  render(root, { ui, nav }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' });
    const stamp = h('span', { class: 'muted hq-small' });
    const refreshBtn = ui.button('Refresh from Stripe', { size: 'sm', icon: 'download', onClick: refresh });
    const exportBtn = ui.button('Export CSV', { size: 'sm', icon: 'download', onClick: exportCsv });
    root.append(ui.page({ title: 'Finance', subtitle: 'Fishtape subscriptions on the True Collar Built Stripe account, amounts in CAD', actions: [stamp, exportBtn, refreshBtn] }, body));
    const money = (c, whole = false) => (c == null ? '—' : ui.fmtMoney(c, { whole }));
    let names = {};
    const co = (id) => (id ? h('a', { href: `#/tenants/${id}` }, names[id] || 'Unknown company') : h('span', { class: 'muted' }, 'Not linked to a company'));

    async function refresh() {
      refreshBtn.disabled = true;
      try { draw(await post('/api/hq/finance/refresh')); ui.toast('Refreshed from Stripe', 'success'); } catch (e) { ui.toast(e.message, 'error', 5000); } finally { refreshBtn.disabled = false; }
    }

    function exportCsv() {
      const s = ui.openSheet({
        title: 'Export CSV', dialog: true,
        body: h('div', { class: 'list' }, [['revenue', 'Revenue, refunds and tax by month'], ['plans', 'Subscriptions by plan'], ['renewals', 'Renewals in the next 14 days'], ['failed', 'Failed payments']].map(([kind, label]) =>
          h('button', { type: 'button', class: 'list-row click hq-list-btn', onClick: async () => {
            try { await downloadFrom(ui, `/api/hq/finance/export?kind=${kind}`, `fishtape-${kind}-${new Date().toISOString().slice(0, 10)}.csv`); s.close(); } catch (e) { ui.toast(e.message, 'error'); }
          } }, h('div', { class: 'grow' }, h('div', { class: 'title' }, label), h('div', { class: 'meta' }, `${kind}.csv`)), ui.icon('download', 18)))),
      });
    }

    function draw(r) {
      names = r.companies || {};
      ui.clear(body);
      stamp.textContent = r.refreshedAt ? `Updated ${ago(r.refreshedAt)}` : '';
      exportBtn.disabled = !r.data;
      if (!r.configured) body.append(banner(ui, 'degraded', 'Stripe is not set up here', 'STRIPE_SECRET_KEY is missing, so there is no subscription data. Settings shows what to set.'));
      if (r.error) body.append(banner(ui, 'danger', 'The last refresh failed', r.error));
      if (!r.data) {
        body.append(ui.empty({ icon: 'dollar', title: 'No finance data yet', text: 'The worker refreshes this every hour. Refresh now to pull it from Stripe.', action: r.configured ? ui.button('Refresh from Stripe', { variant: 'primary', onClick: refresh }) : null }));
        return;
      }
      if (r.stale) body.append(banner(ui, 'degraded', 'These numbers are more than 2 hours old', 'Is the worker running? Refresh pulls them now.'));
      const d = r.data;
      body.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'MRR', value: money(d.mrrCents, true), hint: 'Active and past-due subscriptions, list prices', tone: 'success' }),
        ui.stat({ label: 'ARR', value: money(d.arrCents, true), hint: 'MRR × 12' }),
        ui.stat({ label: 'Paying subscriptions', value: d.subscriptions.active + d.subscriptions.pastDue, hint: `${d.subscriptions.pastDue} past due · ${d.subscriptions.trialing} trialing`, tone: d.subscriptions.pastDue ? 'danger' : null }),
        ui.stat({ label: 'Trials', value: d.trials.active, hint: `${d.trials.endingIn7Days} end within 7 days` }),
        ui.stat({ label: 'Trial → paid (90 d)', value: d.trials.conversionPct == null ? '—' : `${d.trials.conversionPct}%`, hint: `${d.trials.converted} of ${d.trials.endedLast90Days} ended trials` }),
        ui.stat({ label: 'Churn (30 d)', value: d.churn.ratePct == null ? '—' : `${d.churn.ratePct}%`, hint: `${d.churn.canceledLast30Days} cancelled · ${money(d.churn.lostMrrCents, true)} MRR lost`, tone: d.churn.canceledLast30Days ? 'warning' : null }),
        ui.stat({ label: '$1 deposits', value: d.deposits.count, hint: `${d.deposits.last30Days} in 30 days · ${d.deposits.credited} credited${d.deposits.toRefund ? ` · ${d.deposits.toRefund} to refund` : ''}`, tone: d.deposits.toRefund ? 'danger' : null }),
        ui.stat({ label: 'Net revenue this month', value: money(d.thisMonth.netCents, true), hint: `refunds ${money(d.refunds.last30DaysCents)} in 30 days` })));

      body.append(...ui.section('Revenue by month', h('div', { class: 'card stack' },
        revenueChart(ui, d.revenue),
        ui.table({
          columns: [
            { key: 'month', label: 'Month', render: (m) => new Date(`${m.month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) },
            { key: 'gross', label: 'Paid', align: 'right', render: (m) => money(m.grossCents) },
            { key: 'refunds', label: 'Refunds', align: 'right', render: (m) => money(m.refundsCents) },
            { key: 'net', label: 'Net', align: 'right', render: (m) => h('strong', null, money(m.netCents)) },
            { key: 'tax', label: 'GST/HST', align: 'right', render: (m) => (d.tax.present ? money(m.taxCents) : '—') },
            { key: 'deposits', label: 'Deposits', align: 'right', render: (m) => money(m.depositsCents) },
            { key: 'n', label: 'Invoices', align: 'right', render: (m) => String(m.invoices) },
          ],
          rows: [...d.revenue].reverse(),
        }),
        h('span', { class: 'muted hq-small' }, 'Paid includes the $1 sign-up deposits (also shown on their own). Amounts are list prices; Stripe discounts and balance credits are not taken off MRR.'))));

      body.append(h('div', { class: 'grid-2' },
        h('div', null, ...ui.section('Subscriptions by plan', ui.table({
          columns: [
            { key: 'plan', label: 'Plan', render: (p) => h('strong', null, planName(p.plan)) },
            { key: 'active', label: 'Active', align: 'right', render: (p) => String(p.active) },
            { key: 'pastDue', label: 'Past due', align: 'right', render: (p) => (p.pastDue ? ui.badge(String(p.pastDue), 'danger') : '0') },
            { key: 'trialing', label: 'Trialing', align: 'right', render: (p) => String(p.trialing) },
            { key: 'mrr', label: 'MRR', align: 'right', render: (p) => money(p.mrrCents, true) },
          ],
          rows: d.subscriptions.byPlan,
          empty: h('div', { class: 'card flat muted' }, 'No Fishtape subscriptions yet.'),
        }))),
        h('div', null, ...ui.section('GST/HST collected', h('div', { class: ['card', 'stack'] },
          d.tax.present ? h('div', { class: 'hq-big' }, money(d.tax.collectedLast12MonthsCents)) : null,
          h('p', { class: d.tax.present ? 'muted hq-small' : null, style: { margin: 0 } }, d.tax.present ? 'Last 12 months, from Stripe Tax on Fishtape invoices.' : d.tax.note))))));

      body.append(...ui.section('Renewals in the next 14 days', ui.table({
        columns: [
          { key: 'at', label: 'Date', render: (x) => `${ui.fmtDate(x.at)} (${ago(x.at)})`, sort: (x) => x.at },
          { key: 'co', label: 'Company', render: (x) => co(x.tenantId) },
          { key: 'plan', label: 'Plan', render: (x) => planName(x.plan) },
          { key: 'kind', label: '', render: (x) => (x.firstCharge ? ui.badge('trial ends, first charge', 'info') : x.status === 'past_due' ? ui.badge('past due', 'danger') : null) },
          { key: 'amount', label: 'Amount', align: 'right', render: (x) => money(x.amountCents) },
        ],
        rows: d.renewals,
        empty: h('div', { class: 'card flat muted' }, 'Nothing renews in the next 14 days.'),
      })));

      body.append(...ui.section('Failed payments', h('div', { class: 'stack' },
        h('p', { class: 'muted hq-small', style: { margin: 0 } }, `${d.failedPayments.eventsLast30Days} failed-payment events from Stripe in the last 30 days. Open invoices still failing:`),
        ui.table({
          columns: [
            { key: 'co', label: 'Company', render: (x) => co(x.tenantId) },
            { key: 'n', label: 'Invoice', render: (x) => h('span', { class: 'mono hq-small' }, x.number || x.invoiceId) },
            { key: 'amount', label: 'Owing', align: 'right', render: (x) => money(x.amountCents) },
            { key: 'attempts', label: 'Attempts', align: 'right', render: (x) => String(x.attempts) },
            { key: 'next', label: 'Next try', render: (x) => (x.nextAttemptAt ? ago(x.nextAttemptAt) : 'none scheduled') },
          ],
          rows: d.failedPayments.open,
          onRowClick: (x) => nav(`invoices?company=${x.tenantId || ''}&status=open`),
          empty: h('div', { class: 'card flat muted' }, 'No open invoices are failing.'),
        }))));

      body.append(...ui.section('Recent refunds', ui.table({
        columns: [
          { key: 'at', label: 'When', render: (x) => ui.fmtDateTime(x.at) },
          { key: 'co', label: 'Company', render: (x) => co(x.tenantId) },
          { key: 'amount', label: 'Amount', align: 'right', render: (x) => money(x.amountCents) },
          { key: 'reason', label: 'Reason', render: (x) => (x.reason || '—').replace(/_/g, ' ') },
        ],
        rows: d.refunds.recent,
        empty: h('div', { class: 'card flat muted' }, 'No refunds in the last 13 months.'),
      })));
      if (d.scanned) body.append(h('p', { class: 'muted hq-small' }, `Scanned ${d.scanned.subscriptions} subscriptions, ${d.scanned.invoices} invoices and ${d.scanned.refunds} refunds on the account; ${d.scanned.fishtapeInvoices} invoices are Fishtape's. Refresh took ${r.durationMs ?? '—'} ms.`));
    }

    loader(ui, body, async () => draw(await get('/api/hq/finance')));
    return () => {};
  },
};
