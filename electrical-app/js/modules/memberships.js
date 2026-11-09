// Residential service plans / memberships (#/memberships): recurring plans the shop sells to
// homeowners — an annual electrical safety plan, priority service, a member discount.
//   #/memberships?tab=plans      the plan list (office)
//   #/memberships?tab=renewals   plans coming up for renewal (office)
// Pure logic: js/lib/memberships.js. The recurring-billing cousin of Service agreements
// (js/modules/service.js). Local-first: a plan always tracks its status and renewal date by hand.
// When the company has connected its own Stripe (Integrations), a plan can also be put on a Stripe
// subscription — the server creates/cancels it and the company's Stripe webhook keeps the status in
// step. Without Stripe it is a manual record and the billing buttons explain that.
import {
  newMembership, CADENCES, MEMBERSHIP_STATUSES, cadenceLabel, nextRenewal, renewPatch,
  isDueForRenewal, statusTone, membershipLabel, isBilledByStripe,
} from '../lib/memberships.js';
import { moneyFormatter } from '../lib/money.js';
import { api, available } from './integrations.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/service.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/service.css';
  document.head.append(link);
}

export default {
  id: 'memberships',
  title: 'Service plans',
  icon: 'refresh',
  group: 'work',
  perm: 'clients',
  render(root, ctx) {
    loadCss();
    return home(root, ctx);
  },
};

const clientName = (store, id) => (id ? store.get('clients', id)?.name || '—' : '—');

function home(root, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const tabs = [{ id: 'plans', label: 'Plans' }, { id: 'renewals', label: 'Renewals' }];
  let tab = tabs.some((t) => t.id === ctx.query.tab) ? ctx.query.tab : 'plans';
  const tabHost = h('div', { class: 'sv-tabs' });
  const body = h('div', { class: 'sv-body' });
  const draw = () => {
    ui.clear(tabHost).append(ui.tabs(tabs, tab, (t) => { tab = t; history.replaceState(null, '', `#/memberships?tab=${t}`); draw(); }));
    ui.clear(body);
    try { ({ plans: plansTab, renewals: renewalsTab }[tab])(body, ctx); }
    catch (e) { console.error(e); body.append(ui.empty({ icon: 'alert', title: 'Something went wrong', text: e.message })); }
  };
  root.append(ui.page({ title: 'Service plans', subtitle: 'Recurring memberships you sell to homeowners — safety plans, priority service, member discounts' }, tabHost, body));
  draw();
  const off = store.on('serviceMemberships', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
  return () => off();
}

// ---------- plans ----------
function plansTab(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const rows = store.list('serviceMemberships').sort((a, b) => String(a.renewalDate || '').localeCompare(String(b.renewalDate || '')));
  el.append(h('div', { class: 'row sv-toolbar' }, h('span', { class: 'grow' }), ui.button('New plan', { variant: 'primary', icon: 'plus', onClick: () => editMembership(ctx) })));
  el.append(rows.length ? ui.table({
    columns: [
      { key: 'client', label: 'Customer', render: (m) => clientName(store, m.clientId), sort: (m) => clientName(store, m.clientId) },
      { key: 'plan', label: 'Plan', render: (m) => membershipLabel(m) },
      { key: 'cadence', label: 'Billing', render: (m) => cadenceLabel(m.cadence) },
      { key: 'price', label: 'Price', align: 'right', render: (m) => (m.priceCents == null ? '—' : `${money(m.priceCents)}/${m.cadence === 'monthly' ? 'mo' : 'yr'}`) },
      { key: 'renewal', label: 'Renews', render: (m) => (m.renewalDate ? ui.fmtDate(m.renewalDate) : '—'), sort: (m) => m.renewalDate || '' },
      { key: 'billing', label: 'Billing', render: (m) => (isBilledByStripe(m) ? ui.badge('Stripe', 'info') : ui.badge('manual', 'neutral')) },
      { key: 'status', label: 'Status', render: (m) => ui.badge(m.status || 'pending', statusTone(m.status)) },
    ],
    rows, onRowClick: (m) => editMembership(ctx, m.id),
  }) : ui.empty({ icon: 'refresh', title: 'No service plans yet', text: 'Sell a recurring plan — an annual safety inspection, priority dispatch, a member discount — and bill it monthly or yearly. Connect Stripe to charge it automatically.', action: ui.button('New plan', { variant: 'primary', icon: 'plus', onClick: () => editMembership(ctx) }) }));
}

function editMembership(ctx, id = null) {
  const { store, ui } = ctx;
  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const m = id ? store.get('serviceMemberships', id) : newMembership({ by: store.actorId, startDate: ui.today() });
  if (!m) { ui.toast('That plan is gone.', 'error'); return; }
  ui.formSheet({
    title: id ? 'Edit plan' : 'New plan',
    fields: [
      { label: 'Customer', name: 'clientId', type: 'select', required: true, value: m.clientId || '', options: [{ value: '', label: '— choose —' }, ...ui.recordOptions(clients)] },
      { label: 'Plan name', name: 'planName', value: m.planName, span: true, placeholder: 'Home Safe — annual electrical plan' },
      { label: 'Billing', name: 'cadence', type: 'select', value: m.cadence || 'annual', options: CADENCES.map((c) => ({ value: c.id, label: c.label })) },
      { label: 'Price per cycle', name: 'priceCents', type: 'money', value: m.priceCents },
      { label: 'Member discount %', name: 'discountPct', type: 'number', min: '0', max: '100', value: m.discountPct ?? '' },
      { label: 'Start date', name: 'startDate', type: 'date', value: m.startDate || ui.today() },
      { label: 'Renews on', name: 'renewalDate', type: 'date', value: m.renewalDate || '', hint: 'Left blank, it is set one cycle after the start' },
      { label: 'Status', name: 'status', type: 'select', value: m.status || 'pending', options: MEMBERSHIP_STATUSES.map((s) => ({ value: s, label: s })) },
      { label: 'Perks (one per line)', name: 'perks', type: 'textarea', value: (m.perks || []).join('\n'), span: true, placeholder: 'Priority dispatch\nAnnual safety inspection\nNo overtime rates' },
      { label: 'Notes', name: 'notes', type: 'textarea', value: m.notes, span: true },
    ],
    submitLabel: id ? 'Save' : 'Create',
    danger: id ? { label: 'Delete', onClick: () => { store.remove('serviceMemberships', id); ui.toast('Plan deleted'); } } : null,
    extra: id ? billingControls(ctx, m) : null,
    onSubmit: (v) => {
      if (!v.clientId) { ui.toast('Pick a customer', 'error'); return false; }
      const cadence = CADENCES.some((c) => c.id === v.cadence) ? v.cadence : 'annual';
      const start = v.startDate || m.startDate || null;
      const perks = String(v.perks || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50);
      const discountPct = v.discountPct === '' || v.discountPct == null ? null : Math.max(0, Math.min(100, Number(v.discountPct)));
      const patch = {
        clientId: v.clientId, planName: v.planName || 'Membership plan', cadence,
        priceCents: v.priceCents ?? null, discountPct, perks, status: v.status,
        startDate: start, renewalDate: v.renewalDate || nextRenewal(start, cadence) || null, notes: v.notes || '',
      };
      if (id) store.update('serviceMemberships', id, patch);
      else store.add('serviceMemberships', { ...m, ...patch });
    },
  });
}

// ---------- Stripe billing controls (shown when editing an existing plan) ----------
function billingControls(ctx, m) {
  const { store, ui } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack sv-billing' });
  const render = (state) => {
    ui.clear(host);
    if (state === 'loading') { host.append(h('p', { class: 'muted' }, 'Checking billing…')); return; }
    if (!state?.payments) {
      host.append(h('p', { class: 'muted' }, 'Stripe is not connected, so this plan is tracked by hand — update the status and renewal date above as you bill it. Connect Stripe under Integrations to charge it automatically.'),
        h('div', { class: 'row' }, ui.button('Open Integrations', { variant: 'ghost', href: '#/integrations' })));
      return;
    }
    if (isBilledByStripe(m)) {
      host.append(
        h('p', { class: 'muted' }, `Billed on Stripe subscription ${String(m.stripeSubscriptionId).slice(0, 18)}…${m.billingStatus ? ` · status ${m.billingStatus}` : ''}.`),
        h('div', { class: 'row' }, ui.button('Cancel Stripe billing', { variant: 'ghost danger', onClick: () => cancelBilling(ctx, m, host) })));
      return;
    }
    if (m.priceCents == null || m.priceCents < 50 || !m.clientId) {
      host.append(h('p', { class: 'muted' }, 'Set a customer and a price (at least $0.50), then save, to bill this plan through Stripe.'));
      return;
    }
    host.append(
      h('p', { class: 'muted' }, 'Charge this plan automatically: Stripe opens a secure checkout page for the customer to enter their card, then bills every cycle.'),
      h('div', { class: 'row' }, ui.button('Set up Stripe billing', { variant: 'primary', icon: 'dollar', onClick: () => startBilling(ctx, m, host) })));
  };
  render('loading');
  Promise.resolve(available()).then((a) => render(a)).catch(() => render(null));
  return h('section', { class: 'card' }, h('h3', null, 'Recurring billing'), host);
}

async function startBilling(ctx, m, host) {
  const { ui } = ctx;
  try {
    const r = await api('/integrations/stripe/membership-subscription', { method: 'POST', body: { membershipId: m.id } });
    if (r?.checkoutUrl) {
      window.open(r.checkoutUrl, '_blank', 'noopener,noreferrer');
      ui.toast('Stripe checkout opened. Billing starts once the customer pays.', 'success');
    } else ui.toast('Stripe did not return a checkout page.', 'error');
  } catch (e) {
    ui.toast(e.message || 'Could not start Stripe billing.', 'error');
  }
}

async function cancelBilling(ctx, m, host) {
  const { ui } = ctx;
  if (!(await ui.confirmDialog('Cancel the Stripe subscription for this plan? The customer will not be billed again.', { okLabel: 'Cancel billing' }))) return;
  try {
    await api('/integrations/stripe/membership-cancel', { method: 'POST', body: { membershipId: m.id } });
    ui.toast('Stripe billing cancelled.', 'success');
  } catch (e) {
    ui.toast(e.message || 'Could not cancel Stripe billing.', 'error');
  }
}

// ---------- renewals ----------
function renewalsTab(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const today = ui.today();
  const all = store.list('serviceMemberships', (m) => m.status === 'active');
  const due = all.filter((m) => isDueForRenewal(m, today)).sort((a, b) => String(a.renewalDate).localeCompare(String(b.renewalDate)));
  const soon = all.filter((m) => !isDueForRenewal(m, today) && m.renewalDate && m.renewalDate <= ui.today(30));
  if (!due.length && !soon.length) { el.append(ui.empty({ icon: 'check', title: 'Nothing renewing', text: 'No active plans renew in the next 30 days.' })); return; }
  if (due.length) el.append(...ui.section(`Due now (${due.length})`, h('div', { class: 'list' }, due.map((m) => renewalRow(ctx, m, true)))));
  if (soon.length) el.append(...ui.section('Coming up', h('div', { class: 'list' }, soon.map((m) => renewalRow(ctx, m, false)))));
}

function renewalRow(ctx, m, overdue) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const priced = m.priceCents == null ? '' : ` · ${money(m.priceCents)}/${m.cadence === 'monthly' ? 'mo' : 'yr'}`;
  const row = h('div', { class: 'list-row' },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, membershipLabel(m)),
      h('div', { class: 'meta' }, `${clientName(store, m.clientId)} · renews ${ui.fmtDate(m.renewalDate)}${priced}`)),
    overdue ? ui.badge('due', 'danger') : ui.badge(ui.fmtDate(m.renewalDate), 'warning'));
  // Stripe-billed plans renew themselves; a manual plan gets a one-tap "mark renewed".
  if (!isBilledByStripe(m)) {
    row.append(ui.button('Mark renewed', { size: 'sm', variant: 'primary', onClick: () => {
      store.update('serviceMemberships', m.id, { ...renewPatch(m), lastPaymentAt: new Date().toISOString() });
      ui.toast(`Renewed to ${ui.fmtDate(nextRenewal(m.renewalDate, m.cadence))}.`, 'success');
    } }));
  } else {
    row.append(ui.badge('Stripe', 'info'));
  }
  return row;
}
