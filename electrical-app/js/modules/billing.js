// Billing (#/billing): the company's Fishtape plan, trial, seats and price, Stripe Checkout
// to subscribe or change plan, and the Stripe customer portal. Owners and admins only
// (the server checks too). Prices and tiers come from plans.js; Enterprise is "Let's talk".
// No DOM work at import time: the public pricing page imports FEATURE_LABELS from here.
import { PLANS, PLAN_IDS, FEATURE_PLAN, EXTRA_USER_CENTS, monthlyCents, planRank } from '../plans.js';
import { apiFetch } from '../session.js';
import { openExternal } from '../lib/native.js';
import { trialDaysLeft } from '../lib/trial.js';

/** Plain names for plans.js feature keys (pricing page and this screen). */
export const FEATURE_LABELS = {
  dashboard: 'Dashboard', clients: 'Clients', leads: 'Leads pipeline', jobs: 'Jobs', schedule: 'Schedule', estimates: 'Estimates',
  invoices: 'Invoices', employees: 'Employees', time: 'Time clock', sops: 'SOPs', calcs: 'CEC calculators', bending: 'Pipe bending',
  wireruns: 'Wire runs', settings: 'Settings', billing: 'Billing', help: 'Help center and support', drawings: 'Drawings and takeoff', panels: 'Panel schedules', inventory: 'Inventory',
  compliance: 'Permits and inspections', sequences: 'Follow-up sequences', security: 'Security audit', 'drawings.rooms': 'Auto-place boxes in rooms',
  'wireruns.trace': 'Trace wire runs on drawings', portal: 'Client portal', 'payments.online': 'Online invoice payments', 'integrations.email': 'Email (Resend)',
  'ai.assistant': 'AI assistant', 'ai.cec': 'AI code helper', 'ai.background': 'Background AI agents', api: 'API access', mcp: 'MCP server for AI tools',
  'integrations.sms': 'SMS (Twilio)', 'integrations.facebook': 'Facebook Lead Ads', 'locations.multi': 'Multiple stock locations',
  sso: 'Single sign-on', 'setup.service': 'Setup done for you',
  quickbooks: 'QuickBooks Online sync', purchasing: 'Supplier bills and purchase orders',
  books: 'Period lock, payroll runs and the rules table', tickets: 'Signed field tickets', reports: 'Job costing and reports',
  'reports.wip': 'WIP (over and under billing) report', monthend: 'Month-end cutoff export',
};

/** Features a plan adds over the one below it. */
export function featuresAddedBy(planId) {
  return Object.keys(FEATURE_PLAN).filter((f) => FEATURE_PLAN[f] === planId);
}

async function call(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-Fishtape'] = '1';
  let res;
  try {
    res = await apiFetch(path, { method, headers, credentials: 'include', cache: 'no-store', body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('You are offline. Billing needs a connection.'), { code: 'offline', status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Request failed (${res.status})`), { code: data?.error?.code || 'error', status: res.status });
  return data;
}

export default {
  id: 'billing',
  title: 'Billing',
  icon: 'dollar',
  group: 'admin',
  perm: 'settings',
  render(root, ctx) {
    const { ui, query, nav } = ctx;
    const { h } = ui;
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading your plan…'));
    root.append(ui.page({ title: 'Billing', subtitle: 'Your Fishtape plan, users and payments' }, body));
    let info = null;
    let polls = 0;
    let timer = null;

    const fmt = (cents) => ui.fmtMoney(cents, { whole: cents % 100 === 0 });

    async function load() {
      try {
        info = await call('/api/v1/billing');
        draw();
      } catch (e) {
        ui.clear(body);
        if (e.status === 401 || e.code === 'mfa_required' || e.code === 'mfa_enrolment_required') {
          body.append(ui.empty({ icon: 'lock', title: 'Sign in to manage billing', text: 'Billing lives on your Fishtape account online. Sign in (with two-step sign-in) to see your plan.', action: ui.button('Sign in', { variant: 'primary', onClick: () => nav('account') }) }));
        } else if (e.status === 403) {
          body.append(ui.empty({ icon: 'lock', title: 'Owners and admins only', text: e.message }));
        } else {
          body.append(ui.empty({ icon: 'alert', title: 'Billing is unavailable', text: e.message, action: ui.button('Try again', { onClick: load }) }));
        }
      }
    }

    function draw() {
      ui.clear(body);
      const i = info;
      if (i.graceEndsAt) {
        body.append(h('div', { class: 'billing-banner danger' }, ui.icon('alert', 20), h('div', null,
          h('strong', null, 'Your last payment failed'),
          h('span', null, ` Update your card before ${ui.fmtDate(i.graceEndsAt)} to keep ${i.planName}. After that the account drops to Starter (your data stays).`),
          i.hasCustomer ? h('div', null, ui.button('Update payment method', { size: 'sm', variant: 'danger solid', onClick: portal })) : null)));
      } else if (i.onTrial && i.trialEndsAt) {
        // Same count as the app-wide trial banner (lib/trial.js); -1 once the trial has ended.
        const left = new Date(i.trialEndsAt) > new Date() ? trialDaysLeft(i) : -1;
        body.append(h('div', { class: ['billing-banner', left <= 7 ? 'warning' : 'info'] }, ui.icon('clock', 20), h('div', null,
          h('strong', null, left >= 0 ? `Free trial: ${left} day${left === 1 ? '' : 's'} left` : 'Your trial has ended'),
          h('span', null, left < 0 ? ' You are on Starter features. Pick a plan to unlock the rest.'
            // Self-serve sign-up: a trialing subscription that bills when the trial ends.
            : i.hasSubscription ? ` You have ${i.planName} features. On ${ui.fmtDate(i.trialEndsAt)} your card is charged ${i.monthlyCents == null ? 'for your plan' : `${fmt(i.monthlyCents)} plus tax`}${i.deposit?.cents ? `, less your ${fmt(i.deposit.cents)} deposit` : ''}. Change plan or cancel before then.`
              : ` You have ${i.planName} features until ${ui.fmtDate(i.trialEndsAt)}. Pick a plan to keep going.`))));
      }

      body.append(h('div', { class: 'grid' },
        ui.stat({ label: 'Plan', value: i.planName, hint: i.onTrial ? 'Trial' : i.status === 'none' ? 'Not subscribed' : `Subscription ${i.status.replace(/_/g, ' ')}${i.cancelAtPeriodEnd ? ', cancels at period end' : ''}` }),
        ui.stat({ label: 'Users', value: `${i.seats.used}${i.seats.included != null ? ` / ${i.seats.included}` : ''}`, hint: i.seats.extra ? `${i.seats.extra} extra user${i.seats.extra === 1 ? '' : 's'} at ${fmt(EXTRA_USER_CENTS)}/month each` : 'Included in your plan' }),
        ui.stat({ label: 'Monthly', value: i.monthlyCents == null ? 'Custom' : fmt(i.monthlyCents), hint: `${i.currency}, before tax` }),
        ui.stat({ label: i.currentPeriodEnd ? 'Renews' : 'Billing', value: i.currentPeriodEnd ? ui.fmtDate(i.currentPeriodEnd) : '—', hint: i.hasCustomer ? 'Invoices in the billing portal' : 'No payment method yet' })));

      const actions = [];
      if (i.hasCustomer) actions.push(ui.button('Payment method and invoices', { icon: 'receipt', onClick: portal }));
      if (i.hasSubscription && i.seats.billed != null && (i.seats.included ?? 0) + i.seats.extra !== i.seats.billed) {
        actions.push(ui.button(`Bill for ${i.seats.used} users now`, { icon: 'users', onClick: syncSeats }));
      }
      if (actions.length) body.append(h('div', { class: 'row' }, ...actions));

      if (!i.stripeConfigured) body.append(h('p', { class: 'muted' }, 'Online payment is not switched on for this server yet. Contact Fishtape to change plans.'));

      body.append(...ui.section('Plans', h('div', { class: 'billing-plans' }, PLAN_IDS.map((id) => planCard(id)))));
      body.append(h('p', { class: 'muted billing-fine' }, `Prices in ${i.currency} per month, before GST/HST/PST. Each plan includes a number of users; more users are ${fmt(EXTRA_USER_CENTS)}/month each. Downgrading never deletes data: you keep reading everything.`));
    }

    function planCard(id) {
      const p = PLANS[id];
      const i = info;
      const current = i.hasSubscription ? i.subscribedPlan === id : !i.onTrial && i.plan === id && i.status !== 'none';
      const contact = p.contactSales || p.priceCents == null;
      const lower = planRank(id) < planRank(i.subscribedPlan || i.plan);
      const added = featuresAddedBy(id).slice(0, 6);
      let action;
      if (contact) action = ui.button("Let's talk", { variant: 'secondary', onClick: talk });
      else if (current) action = h('span', { class: 'badge success' }, 'Your plan');
      else action = ui.button(i.hasSubscription ? (lower ? `Switch to ${p.name}` : `Upgrade to ${p.name}`) : `Choose ${p.name}`, {
        variant: lower ? 'secondary' : 'primary', disabled: !i.stripeConfigured, onClick: () => choose(id),
      });
      return h('article', { class: ['card', 'billing-plan', current ? 'current' : null] },
        h('h3', null, p.name),
        h('div', { class: 'billing-price' }, contact ? 'Custom' : h('span', null, fmt(p.priceCents), h('small', null, ' /month'))),
        h('p', { class: 'muted' }, p.blurb),
        h('p', { class: 'billing-users' }, p.includedUsers == null ? 'Users to suit you' : `${p.includedUsers} users included, then ${fmt(EXTRA_USER_CENTS)}/user`),
        !contact && i.seats.used > (p.includedUsers ?? Infinity) ? h('p', { class: 'muted billing-users' }, `With your ${i.seats.used} users: ${fmt(monthlyCents(id, i.seats.used))}/month`) : null,
        added.length ? h('ul', { class: 'billing-feats' }, id !== 'starter' ? h('li', { class: 'muted' }, `Everything in ${PLANS[PLAN_IDS[planRank(id) - 1]].name}, plus:`) : null, added.map((f) => h('li', null, ui.icon('check', 14), FEATURE_LABELS[f] || f))) : null,
        h('div', { class: 'billing-action' }, action));
    }

    async function choose(plan) {
      const p = PLANS[plan];
      if (info.hasSubscription) {
        const ok = await ui.confirmDialog(`Your subscription changes to ${p.name} now. Stripe prorates the difference on your next invoice.`, { title: `Switch to ${p.name}?`, okLabel: 'Switch plan', danger: false });
        if (!ok) return;
      }
      try {
        const r = await call('/api/v1/billing/checkout', { method: 'POST', body: { plan } });
        // Stripe Checkout: this tab on the web, a Safari sheet in the iOS app.
        if (r.url) { await openExternal(r.url, { onClose: load }); return; }
        ui.toast(`You are now on ${p.name}`, 'success');
        load();
      } catch (e) { ui.toast(e.message, 'error'); }
    }

    async function portal() {
      try { const r = await call('/api/v1/billing/portal', { method: 'POST' }); await openExternal(r.url, { onClose: load }); } catch (e) { ui.toast(e.message, 'error'); }
    }

    async function syncSeats() {
      try { const r = await call('/api/v1/billing/seats/sync', { method: 'POST' }); ui.toast(r.changed ? `Billing updated: ${r.extra} extra user(s)` : 'Billing already matches', 'success'); load(); } catch (e) { ui.toast(e.message, 'error'); }
    }

    function talk() {
      const company = (() => { try { return ctx.store.settings()?.company?.name || ''; } catch { return ''; } })();
      ui.formSheet({
        title: "Let's talk about Enterprise",
        fields: [
          { label: 'Your name', name: 'name', required: true },
          { label: 'Work email', name: 'email', type: 'email', required: true },
          { label: 'Company', name: 'company', value: company, required: true },
          { label: 'Phone', name: 'phone', type: 'tel' },
          { label: 'Team size', name: 'teamSize', type: 'select', options: [{ value: '', label: '—' }, '1-5', '6-15', '16-50', '51-200', '200+'] },
          { label: 'What do you need?', name: 'message', type: 'textarea', span: true },
        ],
        submitLabel: 'Send',
        onSubmit: (v) => {
          call('/api/v1/public/enterprise-leads', { method: 'POST', body: { name: v.name, email: v.email, company: v.company, phone: v.phone, teamSize: v.teamSize, message: v.message } })
            .then(() => ui.toast('Thanks. We will be in touch within one business day.', 'success'))
            .catch((e) => ui.toast(e.message, 'error'));
        },
      });
    }

    load().then(() => {
      if (query.checkout === 'done') {
        ui.toast('Thanks! Your plan updates as soon as Stripe confirms the payment.', 'success', 4000);
        // The webhook usually lands within seconds; check a few times.
        timer = setInterval(() => { if (++polls > 5 || (info && info.status !== 'none')) clearInterval(timer); else load(); }, 3000);
      } else if (query.checkout === 'cancelled') {
        ui.toast('Checkout cancelled. Nothing was charged.');
      }
    });
    return () => clearInterval(timer);
  },
};
