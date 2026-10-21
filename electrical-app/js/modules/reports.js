// Job costing (#/reports): the numbers that say whether a job made money (docs/releases/r1-get-paid.md
// 6, 11; docs/office/job-costing.md). Office money roles only (the `invoices` permission); computed on
// this device from the synced records with the same libraries the server's /api/v1/reports uses, so
// it works offline and agrees with the exports.
//   #/reports              job profit for a period
//   #/reports/jobs/<id>    one job by cost type and cost code: budget against actual, accrued, committed
//   #/reports/wip          work in progress as of a day (Pro), and contracts completed this fiscal year
//   #/reports/rst          the RST self-assessment worksheet and supplier credits to claim
//   #/reports/variances    supplier bills priced above the PO or the price book
//   #/reports/rates        burden per employee, break-even, trucks and equipment with rate history,
//                          recovery against actual, and the costing settings
import { COST_COLLECTIONS, jobProfit, jobProfitList, jobProfitCsv, wipReport, wipCsv, priceVariances, breakEven, equipmentRecovery, equipmentRateOn, NO_CODE } from '../lib/costing.js';
import { rstSelfAssessment, rstCsv, ADD_TO_RETURN, RESALE_RST_MESSAGE, OWN_USE_REASON_LABEL } from '../lib/rst.js';
import { pctText } from '../lib/burden.js';
import { endOfLastMonth, dayIn, zoneFor } from '../lib/closing.js';
import { costCodeLabel } from '../lib/cost-codes.js';
import { vendorName } from '../lib/purchasing.js';
import { hasFeature, FEATURE_PLAN } from '../plans.js';

const RULES_META = 'rules';
const SECTIONS = [
  { id: 'profit', label: 'Job profit', href: '#/reports' },
  { id: 'wip', label: 'WIP', href: '#/reports/wip' },
  { id: 'rst', label: 'RST', href: '#/reports/rst' },
  { id: 'variances', label: 'Price variances', href: '#/reports/variances' },
  { id: 'rates', label: 'Rates', href: '#/reports/rates' },
];
const TYPE_LABEL = { labour: 'Labour (burdened)', material: 'Material', subcontract: 'Subcontract', equipment: 'Trucks and equipment', other: 'Other', accrued: 'Received, not billed (accrued)' };

/** The module's stylesheet (loaded by the module, so index.html does not change). */
export function ensureStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/reports.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'css/reports.css';
  document.head.append(link);
}

/** The rules as lib/burden.js reads them: Fishtape's rows from the last /rules/effective answer, the company's from the store. */
export function costingRules(store) {
  const m = store.meta(RULES_META);
  const rows = Array.isArray(m?.rules) ? m.rules : Array.isArray(m) ? m : [];
  return { platform: rows.filter((r) => r.origin !== 'company'), company: store.list('rules') };
}

/** Every record the costing libraries read, from the store. */
export function costSources(store, ui) {
  const out = {};
  for (const c of COST_COLLECTIONS) { try { out[c] = store.list(c); } catch { out[c] = []; } }
  return { ...out, settings: store.settings(), rules: costingRules(store), dayOf: ui.localDay };
}

/** Is WIP in the company's plan (Pro)? Demo mode is always open. */
export function wipAllowed(ctx) {
  const ent = ctx.auth.synced ? ctx.app?.session?.me?.entitlements : null;
  if (!ent || !Object.hasOwn(FEATURE_PLAN, 'reports.wip')) return true;
  const overrides = Object.fromEntries(Object.keys(FEATURE_PLAN).map((f) => [f, (ent.features || []).includes(f)]));
  return hasFeature(ent.plan, 'reports.wip', overrides);
}

const todayOf = (store) => dayIn(new Date().toISOString(), zoneFor(store.settings()?.company?.province));
const firstOfMonth = (d) => `${d.slice(0, 7)}-01`;

export default {
  id: 'reports',
  title: 'Job costing',
  icon: 'activity',
  group: 'money',
  perm: 'invoices',
  render(root, ctx) {
    ensureStyles();
    const { ui, store, auth, nav } = ctx;
    const [section, id] = ctx.params;
    const host = ui.h('div', { class: 'reports' });
    root.append(host);
    if (!auth.seesMoney?.()) {
      host.append(ui.page({ title: 'Job costing' }, ui.empty({ icon: 'lock', title: 'Job costing is for the office', text: 'Costs and margins are shown to people who see money.' })));
      return;
    }
    // The rules table drives burden; load it once when signed in (Books keeps it too).
    if (auth.synced && !store.meta(RULES_META)) {
      const province = store.settings().company?.province || 'ON';
      ctx.app.api.get(`/api/v1/rules/effective?province=${encodeURIComponent(province)}`)
        .then((r) => { store.setMeta(RULES_META, { ...r, fetchedAt: new Date().toISOString() }); draw(); }).catch(() => {});
    }
    const active = section === 'jobs' ? 'profit' : SECTIONS.some((s) => s.id === section) ? section : 'profit';
    const state = { from: ctx.query.from || `${todayOf(store).slice(0, 4)}-01-01`, to: ctx.query.to || todayOf(store), asOf: ctx.query.asOf || endOfLastMonth(todayOf(store)) };
    const draw = () => {
      const body = ui.h('div', { class: 'stack' });
      ui.clear(host).append(ui.page({ title: 'Job costing', subtitle: 'Profit by job, work in progress, RST, price variances and your rates' },
        ui.h('div', { class: 'ops-tabs-row' }, ui.tabs(SECTIONS.map(({ id: i, label }) => ({ id: i, label })), active, (i) => nav(SECTIONS.find((s) => s.id === i).href))),
        body));
      const src = costSources(store, ui);
      if (section === 'jobs' && id) jobDetail(body, ctx, src, id, state);
      else if (active === 'wip') wipSection(body, ctx, src, state, draw);
      else if (active === 'rst') rstSection(body, ctx, src, state, draw);
      else if (active === 'variances') variancesSection(body, ctx, src);
      else if (active === 'rates') ratesSection(body, ctx, src, draw);
      else profitSection(body, ctx, src, state, draw);
    };
    draw();
    // Redraw on data changes, but not under an open sheet (it would steal the form).
    let dirty = false, pending = null;
    const overlay = () => document.querySelector('.sheet, .dialog');
    const later = () => { if (overlay()) { dirty = true; return; } clearTimeout(pending); pending = setTimeout(draw, 120); };
    const offs = [...COST_COLLECTIONS, 'settings', 'rules'].map((c) => store.on(c, later));
    const obs = new MutationObserver(() => { if (dirty && !overlay()) { dirty = false; draw(); } });
    obs.observe(document.body, { childList: true });
    return () => { offs.forEach((f) => f()); obs.disconnect(); clearTimeout(pending); };
  },
};

// ---- helpers --------------------------------------------------------------------------------

function rangeBar(ui, state, keys, onChange, extra = []) {
  const { h } = ui;
  const input = (k, label) => {
    const el = h('input', { type: 'date', name: k, value: state[k] || '' });
    el.addEventListener('change', () => { state[k] = el.value; onChange(); });
    return h('label', { class: 'field' }, h('span', null, label), el);
  };
  return h('div', { class: 'row rep-range' }, keys.map(([k, label]) => input(k, label)), h('span', { class: 'grow' }), ...extra);
}

function note(ui, text, tone = 'info') {
  return ui.h('div', { class: ['card', 'rep-note', tone] }, ui.icon(tone === 'warn' ? 'alert' : 'info', 18), ui.h('p', null, text));
}

const pct = (v) => (v == null ? '—' : `${v}%`);
const jobName = (j) => [j?.number, j?.title].filter(Boolean).join(' · ') || 'Job';

// ---- job profit ------------------------------------------------------------------------------

function profitSection(body, ctx, src, state, redraw) {
  const { ui, nav } = ctx;
  const { h } = ui;
  const list = jobProfitList({ ...src, from: state.from, to: state.to });
  const sum = (k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const revenue = sum('revenueCents'), cost = sum('costCents');
  h(body, null,
    rangeBar(ui, state, [['from', 'From'], ['to', 'To']], redraw, [
      ui.button('Export CSV', { icon: 'download', onClick: () => ui.download(`job-profit-${state.to}.csv`, jobProfitCsv(list, { money: (c) => ui.centsToInput(c) }), 'text/csv') })]),
    h('div', { class: 'grid ops-stats' },
      ui.stat({ label: 'Revenue', value: ui.fmtMoney(revenue, { whole: true }), hint: 'invoice work lines, before tax' }),
      ui.stat({ label: 'Cost', value: ui.fmtMoney(cost, { whole: true }), hint: `${ui.fmtMoney(sum('accruedCents'), { whole: true })} accrued` }),
      ui.stat({ label: 'Gross profit', value: ui.fmtMoney(revenue - cost, { whole: true }), tone: revenue - cost < 0 ? 'danger' : 'success', hint: revenue ? `${Math.round(((revenue - cost) / revenue) * 1000) / 10}% margin` : '' }),
      ui.stat({ label: 'Committed', value: ui.fmtMoney(sum('committedCents'), { whole: true }), hint: 'open purchase orders, not in cost' })),
    list.some((x) => x.burdenMissing) ? note(ui, 'Some labour is at the bare wage: no burden is set up yet. Set the rates on Job costing → Rates (and load the year\'s CPP/EI values on Books → Rules).', 'warn') : null,
    ui.table({
      columns: [
        { key: 'job', label: 'Job', sort: (x) => x.number, render: (x) => h('span', null, h('strong', null, x.number || '—'), ` ${x.title}`) },
        { key: 'rev', label: 'Revenue', align: 'right', sort: (x) => x.revenueCents, render: (x) => ui.fmtMoney(x.revenueCents) },
        { key: 'cost', label: 'Cost', align: 'right', sort: (x) => x.costCents, render: (x) => ui.fmtMoney(x.costCents) },
        { key: 'gp', label: 'Gross profit', align: 'right', sort: (x) => x.grossProfitCents, render: (x) => h('span', { class: x.grossProfitCents < 0 ? 'rep-neg' : null }, ui.fmtMoney(x.grossProfitCents)) },
        { key: 'margin', label: 'Margin', align: 'right', sort: (x) => x.marginPct ?? -999, render: (x) => pct(x.marginPct) },
        { key: 'budget', label: 'Budget margin', align: 'right', sort: (x) => x.budgetMarginPct ?? -999, render: (x) => pct(x.budgetMarginPct) },
        { key: 'committed', label: 'Committed', align: 'right', sort: (x) => x.committedCents, render: (x) => (x.committedCents ? ui.fmtMoney(x.committedCents) : '—') },
      ],
      rows: list,
      onRowClick: (x) => nav(`#/reports/jobs/${x.jobId}`),
      empty: ui.empty({ icon: 'activity', title: 'Nothing in this period', text: 'Jobs with revenue or cost between these dates show here.' }),
    }));
}

function jobDetail(body, ctx, src, id, state) {
  const { ui, store } = ctx;
  const { h } = ui;
  const job = store.get('jobs', id);
  if (!job) { h(body, null, ui.empty({ icon: 'briefcase', title: 'This job no longer exists', action: ui.button('Job profit', { href: '#/reports' }) })); return; }
  const p = jobProfit({ ...src, job, from: '', to: state.to });
  const a = p.actuals;
  const codes = new Map(store.list('costCodes').map((c) => [c.id, c]));
  h(body, null,
    h('div', { class: 'row' }, ui.button('', { icon: 'chevron-left', title: 'Job profit', href: '#/reports' }), h('h2', { class: 'section rep-title' }, jobName(job)), h('span', { class: 'grow' }),
      ui.button('Open job', { icon: 'briefcase', variant: 'ghost', href: `#/jobs/${job.id}` })),
    h('div', { class: 'grid ops-stats' },
      ui.stat({ label: 'Contract', value: ui.fmtMoney(p.contractCents, { whole: true }), hint: 'with approved change orders' }),
      ui.stat({ label: 'Estimated cost', value: ui.fmtMoney(p.estCostCents, { whole: true }), hint: p.budgetMarginPct != null ? `${p.budgetMarginPct}% budget margin` : 'no budget yet' }),
      ui.stat({ label: 'Cost to date', value: ui.fmtMoney(p.costCents, { whole: true }), hint: `as of ${ui.fmtDate(state.to)}`, tone: p.estCostCents && p.costCents > p.estCostCents ? 'danger' : null }),
      ui.stat({ label: 'Billed', value: ui.fmtMoney(p.revenueCents, { whole: true }), hint: p.marginPct != null ? `${p.marginPct}% margin on billed` : '' }),
      ui.stat({ label: 'Committed', value: ui.fmtMoney(p.committedCents, { whole: true }), hint: 'open purchase orders' })),
    p.burdenMissing ? note(ui, 'Labour on this job is at the bare wage: no burden is set up yet (Job costing → Rates).', 'warn') : null,
    h('h3', { class: 'section' }, 'By cost type'),
    ui.table({
      columns: [{ key: 'type', label: 'Cost type' }, { key: 'cents', label: 'Actual', align: 'right' }],
      rows: Object.entries(p.byType).filter(([, v]) => v).map(([k, v]) => ({ type: TYPE_LABEL[k] || k, cents: ui.fmtMoney(v) })),
      empty: ui.empty({ icon: 'activity', title: 'No cost yet' }),
    }),
    a.labourCents ? h('p', { class: 'muted rep-small' }, `Labour: ${ui.fmtMoney(a.labourWageCents)} wages, ${ui.fmtMoney(a.burdenCents)} burden, ${ui.fmtMoney(a.otPremiumCents)} overtime premium; ${ui.fmtHours(a.hours)} work, ${ui.fmtHours(a.travelHours)} travel. Trucks ${ui.fmtMoney(a.truckCents)}.`) : null,
    h('h3', { class: 'section' }, 'Budget against actual by cost code'),
    ui.table({
      columns: [
        { key: 'code', label: 'Cost code', render: (x) => (x.id === NO_CODE ? 'Uncoded' : costCodeLabel(codes.get(x.id)) || x.id) },
        { key: 'est', label: 'Budget', align: 'right', render: (x) => (x.estCents ? ui.fmtMoney(x.estCents) : '—') },
        { key: 'act', label: 'Actual', align: 'right', render: (x) => ui.fmtMoney(x.actualCents) },
        { key: 'var', label: 'Left', align: 'right', render: (x) => (x.estCents ? h('span', { class: x.estCents - x.actualCents < 0 ? 'rep-neg' : null }, ui.fmtMoney(x.estCents - x.actualCents)) : '—') },
        { key: 'hours', label: 'Hours', align: 'right', render: (x) => (x.hours ? ui.fmtNum(x.hours, 1) : '—') },
      ],
      rows: Object.entries(p.byCostCode).map(([k, v]) => ({ id: k, ...v })).sort((x, y) => String(x.id).localeCompare(String(y.id))),
      empty: ui.empty({ icon: 'list', title: 'No cost codes used yet' }),
    }),
    a.accrued.length ? [h('h3', { class: 'section' }, 'Received, not billed yet (accrued)'), poRows(ui, store, a.accrued)] : null,
    a.committed.length ? [h('h3', { class: 'section' }, 'Committed: on order, not received or billed'), poRows(ui, store, a.committed)] : null,
  );
}

function poRows(ui, store, rows) {
  return ui.table({
    columns: [
      { key: 'po', label: 'Purchase order', render: (x) => ui.h('a', { href: `#/purchasing/orders/${x.purchaseOrderId}` }, `${x.number || 'PO'} line ${x.index + 1}`) },
      { key: 'd', label: 'Description', render: (x) => x.description || '—' },
      { key: 'q', label: 'Qty', align: 'right', render: (x) => ui.fmtNum(x.qty, 2) },
      { key: 'c', label: 'At PO price', align: 'right', render: (x) => ui.fmtMoney(x.cents) },
    ],
    rows,
  });
}

// ---- WIP ---------------------------------------------------------------------------------------

function wipSection(body, ctx, src, state, redraw) {
  const { ui } = ctx;
  const { h } = ui;
  if (!wipAllowed(ctx)) {
    h(body, null, ui.empty({ icon: 'lock', title: 'Work in progress is on the Pro plan', text: 'Earned revenue, over and under billing and the completed-contracts list for your bonding company.', action: ui.button('Plans', { href: '#/billing' }) }));
    return;
  }
  const w = wipReport({ ...src, asOf: state.asOf });
  const t = w.totals;
  h(body, null,
    rangeBar(ui, state, [['asOf', 'As of']], redraw, [
      ui.button('Export CSV', { icon: 'download', onClick: () => ui.download(`wip-${w.asOf}.csv`, wipCsv(w, { money: (c) => ui.centsToInput(c) }), 'text/csv') }),
      ui.button('Print', { icon: 'printer', variant: 'ghost', onClick: () => window.print() })]),
    h('div', { class: 'grid ops-stats' },
      ui.stat({ label: 'Earned', value: ui.fmtMoney(t.earnedCents, { whole: true }) }),
      ui.stat({ label: 'Billed', value: ui.fmtMoney(t.billedCents, { whole: true }) }),
      ui.stat({ label: 'Under billed', value: ui.fmtMoney(t.underBilledCents, { whole: true }), hint: 'an asset' }),
      ui.stat({ label: 'Over billed', value: ui.fmtMoney(t.overBilledCents, { whole: true }), hint: 'a liability' }),
      t.lossProvisionCents ? ui.stat({ label: 'Loss provision', value: ui.fmtMoney(t.lossProvisionCents, { whole: true }), tone: 'danger' }) : null),
    h('p', { class: 'muted rep-small' }, 'Percent complete is cost to date over estimated cost (at most 100%), or the job\'s own figure for material stored on site. A job heading for a loss takes the whole loss now. T&M jobs earn what is billed plus time and material not billed yet. Service calls are left out.'),
    ui.table({
      columns: [
        { key: 'job', label: 'Job', render: (x) => ui.h('a', { href: `#/reports/jobs/${x.jobId}` }, `${x.number} ${x.title}`) },
        { key: 'c', label: 'Contract', align: 'right', render: (x) => (x.contractCents == null ? 'T&M' : ui.fmtMoney(x.contractCents)) },
        { key: 'e', label: 'Est. cost', align: 'right', render: (x) => (x.estCostCents == null ? '—' : ui.fmtMoney(x.estCostCents)) },
        { key: 'ctd', label: 'Cost to date', align: 'right', render: (x) => ui.fmtMoney(x.costToDateCents) },
        { key: 'pct', label: 'Complete', align: 'right', render: (x) => (x.pct == null ? '—' : h('span', null, `${Math.round(x.pct * 1000) / 10}%`, x.pctOverridden ? ' *' : '', x.noEstimate ? h('span', { class: 'muted' }, ' no estimate') : null)) },
        { key: 'earned', label: 'Earned', align: 'right', render: (x) => ui.fmtMoney(x.earnedCents) },
        { key: 'billed', label: 'Billed', align: 'right', render: (x) => ui.fmtMoney(x.billedCents) },
        { key: 'under', label: 'Under', align: 'right', render: (x) => (x.underBilledCents ? ui.fmtMoney(x.underBilledCents) : '—') },
        { key: 'over', label: 'Over', align: 'right', render: (x) => (x.overBilledCents ? ui.fmtMoney(x.overBilledCents) : '—') },
        { key: 'loss', label: 'Loss', align: 'right', render: (x) => (x.lossProvisionCents ? h('span', { class: 'rep-neg' }, ui.fmtMoney(x.lossProvisionCents)) : '') },
      ],
      rows: w.rows,
      empty: ui.empty({ icon: 'activity', title: 'No open jobs', text: 'Jobs scheduled, in progress or on hold show here.' }),
    }),
    h('h3', { class: 'section' }, `Contracts completed since ${ui.fmtDate(w.fiscalYearStart)}`),
    ui.table({
      columns: [
        { key: 'job', label: 'Job', render: (x) => `${x.number} ${x.title}` },
        { key: 'done', label: 'Completed', render: (x) => ui.fmtDate(x.completedOn) },
        { key: 'c', label: 'Contract', align: 'right', render: (x) => ui.fmtMoney(x.contractCents) },
        { key: 'cost', label: 'Cost', align: 'right', render: (x) => ui.fmtMoney(x.costCents) },
        { key: 'gp', label: 'Gross profit', align: 'right', render: (x) => ui.fmtMoney(x.grossProfitCents) },
      ],
      rows: w.completed,
      empty: ui.empty({ icon: 'check', title: 'None yet this fiscal year' }),
    }));
}

// ---- RST ---------------------------------------------------------------------------------------

function rstSection(body, ctx, src, state, redraw) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const today = todayOf(store);
  if (!state.rstFrom) { const end = endOfLastMonth(today); state.rstFrom = firstOfMonth(end); state.rstTo = end; }
  const province = store.settings().company?.province || 'MB';
  const r = rstSelfAssessment({ ...src, from: state.rstFrom, to: state.rstTo, province });
  const jobs = new Map(src.jobs.map((j) => [j.id, j]));
  const vendors = new Map(src.vendors.map((v) => [v.id, v]));
  const writeOff = async (x) => {
    if (!(await ui.confirmDialog(`Move ${ui.fmtMoney(x.rstCents)} of RST into the cost of this line? Do this only when the supplier won't credit it.`, { okLabel: 'Write off to cost', danger: false }))) return;
    const bill = store.get('bills', x.billId);
    if (!bill) return;
    const lines = (bill.lines || []).map((l, i) => (i === x.lineIndex ? { ...l, resaleCreditWrittenOff: { by: String(auth.who().name || 'office').slice(0, 120), at: new Date().toISOString() } } : l));
    store.update('bills', bill.id, { lines }, { summary: 'RST credit written off to cost' });
    ui.toast('Written off to cost', 'success');
  };
  h(body, null,
    rangeBar(ui, state, [['rstFrom', 'From'], ['rstTo', 'To']], redraw, [
      ui.button('Export CSV', { icon: 'download', onClick: () => ui.download(`rst-${state.rstFrom}-to-${state.rstTo}.csv`, rstCsv(r, { money: (c) => ui.centsToInput(c), jobs, vendors }), 'text/csv') })]),
    note(ui, ADD_TO_RETURN),
    h('div', { class: 'grid ops-stats' },
      ui.stat({ label: 'RST to self-assess', value: ui.fmtMoney(r.totals.selfAssessCents), hint: `on ${ui.fmtMoney(r.totals.costCents, { whole: true })} of own-use purchases` }),
      ui.stat({ label: 'Credits to claim', value: ui.fmtMoney(r.totals.creditCents), hint: 'RST suppliers charged on resale material', tone: r.totals.creditCents ? 'accent' : null })),
    h('h3', { class: 'section' }, 'Self-assess'),
    ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (x) => ui.fmtDate(x.date) },
        { key: 'what', label: 'What', render: (x) => x.description },
        { key: 'src', label: 'From', render: (x) => ({ move: 'Stock', request: 'Material request', bill: 'Bill (no RST charged)' })[x.source] },
        { key: 'job', label: 'Job', render: (x) => jobs.get(x.jobId)?.number || '—' },
        { key: 'why', label: 'Use', render: (x) => OWN_USE_REASON_LABEL[x.reason] || x.reason },
        { key: 'cost', label: 'Cost', align: 'right', render: (x) => ui.fmtMoney(x.costCents) },
        { key: 'rst', label: 'RST', align: 'right', render: (x) => ui.fmtMoney(x.rstCents) },
      ],
      rows: r.selfAssess,
      empty: ui.empty({ icon: 'check', title: 'Nothing to self-assess', text: 'Own-use material (warranty, no-charge, shop, trucks) and out-of-province purchases show here.' }),
    }),
    h('h3', { class: 'section' }, 'Credits to claim from suppliers'),
    h('p', { class: 'muted rep-small' }, RESALE_RST_MESSAGE),
    ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (x) => ui.fmtDate(x.date) },
        { key: 'bill', label: 'Bill', render: (x) => h('a', { href: `#/purchasing/bills/${x.billId}` }, `${vendorName(vendors.get(x.vendorId))}: ${x.description || 'line ' + (x.lineIndex + 1)}`) },
        { key: 'rst', label: 'RST charged', align: 'right', render: (x) => ui.fmtMoney(x.rstCents) },
        { key: 'x', label: '', render: (x) => ui.button('Write off to cost', { size: 'sm', variant: 'ghost', onClick: (e) => { e.stopPropagation(); writeOff(x); } }) },
      ],
      rows: r.resaleCredits,
      empty: ui.empty({ icon: 'check', title: 'No RST charged on resale material' }),
    }));
}

// ---- price variances ---------------------------------------------------------------------------------

function variancesSection(body, ctx, src) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const tolerancePct = Number(src.settings?.costing?.priceVariancePct ?? 2);
  const vendors = new Map(src.vendors.map((v) => [v.id, v]));
  const rows = [];
  for (const b of src.bills) {
    if (!['open', 'paid'].includes(b.status) || b.varianceAck) continue;
    for (const v of priceVariances(b, { purchaseOrders: src.purchaseOrders, items: src.items, tolerancePct })) rows.push({ bill: b, ...v });
  }
  const check = async (b) => {
    const text = await ui.promptDialog('What did you find? (optional)', { title: 'Mark as checked', okLabel: 'Checked' });
    if (text === null) return;
    store.update('bills', b.id, { varianceAck: { by: String(auth.who().name || 'office').slice(0, 120), at: new Date().toISOString(), note: String(text || '').slice(0, 500) } }, { summary: 'price variance checked' });
    ui.toast('Marked as checked', 'success');
  };
  h(body, null,
    h('p', { class: 'muted rep-small' }, `Bill lines priced more than ${tolerancePct}% and $1.00 above the purchase order (or the wholesaler's job quote on it) or, without an order, the price book's cost. Bills never change the price book.`),
    ui.table({
      columns: [
        { key: 'bill', label: 'Bill', render: (x) => h('a', { href: `#/purchasing/bills/${x.bill.id}` }, `${vendorName(vendors.get(x.bill.vendorId))} ${x.bill.number || ''}`.trim()) },
        { key: 'date', label: 'Date', render: (x) => ui.fmtDate(x.bill.date) },
        { key: 'line', label: 'Line', render: (x) => x.bill.lines?.[x.lineIndex]?.description || `Line ${x.lineIndex + 1}` },
        { key: 'ref', label: 'Against', render: (x) => (x.refKind === 'po' ? `PO price${x.quoteRef ? ` (quote ${x.quoteRef})` : ''}` : 'Price book') },
        { key: 'unit', label: 'Billed / expected', align: 'right', render: (x) => `${ui.fmtMoney(x.billUnitCents)} / ${ui.fmtMoney(x.refUnitCents)}` },
        { key: 'over', label: 'Over', align: 'right', render: (x) => h('span', { class: 'rep-neg' }, `${ui.fmtMoney(x.overCents)} (${x.overPct}%)`) },
        { key: 'ok', label: '', render: (x) => ui.button('Checked', { size: 'sm', onClick: (e) => { e.stopPropagation(); check(x.bill); } }) },
      ],
      rows,
      empty: ui.empty({ icon: 'check', title: 'No price variances', text: 'Supplier bills match their orders and the price book.' }),
    }));
}

// ---- rates -------------------------------------------------------------------------------------

function ratesSection(body, ctx, src, redraw) {
  const { ui, store, auth } = ctx;
  const { h } = ui;
  const today = todayOf(store);
  const s = store.settings();
  const be = breakEven({ ...src, on: today });
  const rec = equipmentRecovery({ ...src, from: `${today.slice(0, 4)}-01-01`, to: today });
  const recBy = new Map(rec.map((x) => [x.equipmentId, x]));
  const labourRate = Number(s.labourRateCents) || 0;
  h(body, null,
    h('div', { class: 'grid ops-stats' },
      ui.stat({ label: 'Labour cost per productive hour', value: ui.fmtMoney(be.burdenedCostPerProductiveHourCents), hint: 'field crew, burdened' }),
      ui.stat({ label: be.labourOnly ? 'Labour cost only, not break-even' : 'Break-even rate', value: ui.fmtMoney(be.breakEvenRateCents), hint: be.labourOnly ? 'add yearly overhead below' : `incl. ${ui.fmtMoney(be.overheadPerProductiveHourCents)} overhead`, tone: be.labourOnly ? 'accent' : null }),
      ui.stat({ label: 'Target rate', value: be.targetRateCents ? ui.fmtMoney(be.targetRateCents) : '—', hint: s.costing?.targetMarginPct != null ? `${s.costing.targetMarginPct}% margin` : 'set a target margin' }),
      ui.stat({ label: 'Your labour rate', value: labourRate ? ui.fmtMoney(labourRate) : '—', tone: labourRate && labourRate < be.breakEvenRateCents ? 'danger' : null, hint: labourRate && labourRate < be.breakEvenRateCents ? 'below break-even' : 'Settings → Billing' }),
      ui.stat({ label: 'Equipment recovery', value: ui.fmtMoney(be.equipmentRecoveryPerProductiveHourCents), hint: 'per productive hour, shown beside, not added' })),
    be.warnings.length ? h('div', { class: 'card rep-note warn' }, ui.icon('alert', 18), h('ul', { class: 'rep-list' }, be.warnings.map((w) => h('li', null, w)))) : null,
    h('h3', { class: 'section' }, 'Burden per employee'),
    ui.table({
      columns: [
        { key: 'name', label: 'Employee', render: (x) => ui.h('a', { href: `#/employees/${x.employeeId}` }, x.name) },
        { key: 'role', label: 'Role' },
        { key: 'wage', label: 'Wage', align: 'right', render: (x) => ui.fmtMoney(x.wageCents) },
        { key: 'stat', label: 'Statutory', align: 'right', render: (x) => pctText(x.statutoryPct) },
        { key: 'paid', label: 'Per paid hour', align: 'right', render: (x) => ui.fmtMoney(x.costPerPaidHourCents) },
        { key: 'prod', label: 'Per productive hour', align: 'right', render: (x) => ui.fmtMoney(x.costPerProductiveHourCents) },
      ],
      rows: be.rows,
      empty: ui.empty({ icon: 'id-card', title: 'No field crew with a wage', text: 'Electricians, apprentices and foremen with a wage count here (Employees).' }),
    }),
    h('h3', { class: 'section' }, 'Trucks and equipment'),
    h('div', { class: 'row' }, h('p', { class: 'muted rep-small grow' }, 'A truck on a time entry is charged to the job once per day (an hour rate over the hours anyone used it, or a day rate split by hours). Recovered this year against fuel, repairs and lease bills marked for it.'),
      auth.can('inventory') ? ui.button('Add truck or equipment', { size: 'sm', icon: 'plus', onClick: () => equipmentSheet(ctx, null) }) : null),
    ui.table({
      columns: [
        { key: 'name', label: 'Name', render: (q) => h('span', null, h('strong', null, q.name || '—'), q.unitNo ? ` #${q.unitNo}` : '', q.active === false ? h('span', { class: 'muted' }, ' (inactive)') : null) },
        { key: 'kind', label: 'Kind', render: (q) => q.kind || 'equipment' },
        { key: 'rate', label: 'Rate today', align: 'right', render: (q) => { const r = equipmentRateOn(q, today); return r.rateCents ? `${ui.fmtMoney(r.rateCents)}/${r.rateUnit}` : '—'; } },
        { key: 'rec', label: 'Recovered', align: 'right', render: (q) => ui.fmtMoney(recBy.get(q.id)?.recoveredCents || 0) },
        { key: 'act', label: 'Actual', align: 'right', render: (q) => ui.fmtMoney(recBy.get(q.id)?.actualCents || 0) },
        { key: 'diff', label: 'Difference', align: 'right', render: (q) => { const d = recBy.get(q.id)?.differenceCents || 0; return h('span', { class: d < 0 ? 'rep-neg' : null }, ui.fmtMoney(d)); } },
      ],
      rows: src.equipment.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
      onRowClick: auth.can('inventory') ? (q) => equipmentSheet(ctx, q) : null,
      empty: ui.empty({ icon: 'truck', title: 'No trucks or equipment yet', text: 'Add each truck with its rate so job costing charges it.' }),
    }),
    h('h3', { class: 'section' }, 'Costing settings'),
    costingForm(ctx, redraw));
}

/** settings.costing (r1-get-paid.md 2.4): edited here by the office. */
function costingForm(ctx, redraw) {
  const { ui, store } = ctx;
  const { h } = ui;
  const c = store.settings().costing || {};
  const num = (name, label, value, hint, step = '1') => ({ label, name, type: 'number', step, min: '0', value: value ?? '', hint });
  const form = h('form', { class: 'card stack rep-form', onSubmit: (e) => { e.preventDefault(); save(); } },
    ui.formGrid([
      num('annualHours', 'Paid hours a year', c.annualHours ?? 2000, 'Per employee; 2,000 is 40 h × 50 weeks.'),
      num('nonProductivePctDefault', 'Non-productive time (%)', c.nonProductivePctDefault ?? 10, 'Shop, school, callbacks and unbilled travel. Travel already charged to jobs is not included.', '0.1'),
      num('statutoryPctFallback', 'Flat statutory % (fallback)', c.statutoryPctFallback, 'Used, with a warning, while a year\'s CPP/EI values are not loaded.', '0.01'),
      { label: 'Yearly overhead', name: 'overheadAnnualCents', type: 'money', value: c.overheadAnnualCents ?? null, hint: 'Office wages, rent, insurance… Leave out truck and equipment costs recovered through equipment rates.' },
      num('targetMarginPct', 'Target margin (%)', c.targetMarginPct, null, '0.1'),
      num('priceVariancePct', 'Flag bill prices above (%)', c.priceVariancePct ?? 2, 'And by more than $1.00 on the line.', '0.1'),
    ]),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save', { variant: 'primary', onClick: () => save() })));
  function save() {
    const v = ui.readForm(form);
    const raw = form.querySelector('[name=overheadAnnualCents]').value.trim();
    store.saveSettings({ costing: {
      ...c, annualHours: v.annualHours == null ? 2000 : Math.round(v.annualHours), nonProductivePctDefault: v.nonProductivePctDefault ?? 10,
      statutoryPctFallback: v.statutoryPctFallback, overheadAnnualCents: raw === '' ? null : v.overheadAnnualCents, targetMarginPct: v.targetMarginPct,
      priceVariancePct: v.priceVariancePct ?? 2,
    } });
    ui.toast('Saved', 'success');
    redraw();
  }
  return form;
}

/** A truck or piece of equipment, with its rate history ("New rate from"). */
export function equipmentSheet(ctx, q) {
  const { ui, store } = ctx;
  const { h } = ui;
  const isNew = !q;
  const today = todayOf(store);
  const locs = store.list('locations');
  const people = store.list('employees', (e) => e.active !== false);
  const history = (q?.rateHistory || []).slice().sort((a, b) => String(b.from).localeCompare(String(a.from)));
  const extra = isNew ? null : h('div', { class: 'stack' },
    h('strong', null, 'Rate history'),
    history.length ? h('ul', { class: 'rep-list' }, history.map((r) => h('li', null, `From ${ui.fmtDate(r.from)}: ${ui.fmtMoney(r.rateCents)}/${r.rateUnit || q.rateUnit || 'hour'}`))) : h('p', { class: 'muted rep-small' }, 'One rate so far.'),
    h('p', { class: 'muted rep-small' }, 'A new rate from a date leaves the cost of earlier days alone.'));
  ui.formSheet({
    title: isNew ? 'New truck or equipment' : q.name || 'Equipment',
    submitLabel: isNew ? 'Add' : 'Save',
    fields: [
      { label: 'Name', name: 'name', value: q?.name || '', required: true, span: true },
      { label: 'Kind', name: 'kind', type: 'select', value: q?.kind || 'truck', options: [{ value: 'truck', label: 'Truck' }, { value: 'equipment', label: 'Equipment' }, { value: 'tool', label: 'Tool' }] },
      { label: 'Unit no.', name: 'unitNo', value: q?.unitNo || '' },
      { label: 'Plate', name: 'plate', value: q?.plate || '' },
      { label: 'Cost to the job', name: 'rateCents', type: 'money', value: q?.rateCents ?? 0 },
      { label: 'Per', name: 'rateUnit', type: 'select', value: q?.rateUnit || 'day', options: [{ value: 'hour', label: 'Hour' }, { value: 'day', label: 'Day' }] },
      isNew ? null : { label: 'New rate applies from', name: 'rateFrom', type: 'date', value: today, hint: 'When you change the rate' },
      { label: 'T&M bill rate (optional)', name: 'billRateCents', type: 'money', value: q?.billRateCents ?? null },
      { label: 'Van stock location', name: 'locationId', type: 'select', value: q?.locationId || '', options: ui.recordOptions(locs, 'name', '— none —'), hint: 'The van this truck carries, so its driver counts it' },
      { label: 'Usual driver', name: 'defaultEmployeeId', type: 'select', value: q?.defaultEmployeeId || '', options: ui.recordOptions(people, 'name', '— none —') },
      { label: 'Active', name: 'active', type: 'checkbox', value: q ? q.active !== false : true },
      { label: 'Note', name: 'note', value: q?.note || '', span: true },
    ].filter(Boolean),
    extra,
    onSubmit: (v, form) => {
      const billRaw = form.querySelector('[name=billRateCents]').value.trim();
      const rec = {
        name: String(v.name).trim().slice(0, 120), kind: v.kind, unitNo: v.unitNo || null, plate: v.plate || null, rateCents: v.rateCents, rateUnit: v.rateUnit,
        billRateCents: billRaw === '' ? null : v.billRateCents, locationId: v.locationId || null, defaultEmployeeId: v.defaultEmployeeId || null, active: v.active, note: v.note || null,
      };
      if (isNew) {
        store.add('equipment', { ...rec, rateHistory: [{ from: today, rateCents: v.rateCents, rateUnit: v.rateUnit }] });
        ui.toast('Added', 'success');
        return;
      }
      const changed = v.rateCents !== q.rateCents || v.rateUnit !== (q.rateUnit || 'day');
      let rateHistory = (q.rateHistory || []).slice();
      if (changed) {
        const from = /^\d{4}-\d{2}-\d{2}$/.test(v.rateFrom) ? v.rateFrom : today;
        if (!rateHistory.length) rateHistory.push({ from: '1900-01-01', rateCents: q.rateCents || 0, rateUnit: q.rateUnit || 'day' });
        rateHistory = rateHistory.filter((r) => r.from !== from).concat({ from, rateCents: v.rateCents, rateUnit: v.rateUnit }).sort((a, b) => a.from.localeCompare(b.from)).slice(-200);
      }
      store.update('equipment', q.id, { ...rec, rateHistory }, { summary: `equipment ${rec.name}` });
      ui.toast('Saved', 'success');
    },
  });
}
