// Companies: list, filter, search (names and member emails go in a POST body), create,
// and the company detail page (#/tenants/<id>).
import { get, post } from '../api.js';
import { TONE, ago, planName } from '../fmt.js';
import detail from './tenant.js';

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'trial', label: 'On trial' }, { id: 'signups', label: 'Sign-ups' }, { id: 'past_due', label: 'Past due' },
  { id: 'suspended', label: 'Suspended' }, { id: 'closed', label: 'Closing' },
];
const SIGNUP_TONE = { pending: 'info', completed: 'success', expired: 'neutral', abandoned: 'neutral', failed: 'danger' };

/** Self-serve sign-up cell: deposit paid, credited to the first invoice, email confirmed. */
function signupCell(ui, s) {
  const { h } = ui;
  if (!s) return h('span', { class: 'muted' }, 'HQ');
  const bits = [s.depositPaid ? 'deposit paid' : 'no deposit', s.depositCredited ? 'credited' : s.creditError ? 'credit failed' : 'not credited yet'];
  return h('div', null, ui.badge('Self-serve', s.creditError || !s.depositPaid ? 'warning' : 'success'),
    h('div', { class: 'muted hq-small' }, `${bits.join(' · ')}${s.emailVerified ? '' : ' · email not confirmed'}`));
}

export default {
  render(root, ctx) {
    if (ctx.params[0]) return detail.render(root, ctx);
    const { ui, nav, isAdmin } = ctx;
    const { h } = ui;
    let rows = [];
    let signups = null; // sign-ups that are not companies (yet): loaded with the Sign-ups tab
    let filter = 'all';
    let term = '';
    let serverHits = null;
    const tableHost = h('div');
    const signupHost = h('div');
    const tabsHost = h('div');
    const search = ui.searchBox('Name, or Enter for member email', (v) => { term = v; serverHits = null; draw(); });
    search.querySelector('input').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || term.trim().length < 2) return;
      try { serverHits = new Set((await post('/api/hq/tenants/search', { q: term.trim() })).data.map((t) => t.id)); draw(); } catch (err) { ui.toast(err.message, 'error'); }
    });

    root.append(ui.page({
      title: 'Companies', subtitle: 'Every company on Fishtape',
      actions: [isAdmin ? ui.button('New company', { variant: 'primary', icon: 'plus', onClick: create }) : null].filter(Boolean),
    }, h('div', { class: 'hq-toolbar' }, tabsHost, h('span', { class: 'grow' }), search), tableHost, signupHost));

    function visible() {
      const q = term.trim().toLowerCase();
      return rows.filter((t) => {
        if (filter === 'trial' && !(t.onTrial ?? t.plan === 'trial')) return false;
        if (filter === 'signups' && !t.signup) return false;
        if (filter === 'past_due' && !(t.billing.status === 'past_due' || t.billing.graceEndsAt)) return false;
        if (['active', 'suspended', 'closed'].includes(filter) && t.status !== filter) return false;
        if (serverHits) return serverHits.has(t.id);
        return !q || t.name.toLowerCase().includes(q) || t.slug.includes(q) || t.id === q;
      });
    }

    function draw() {
      ui.clear(tabsHost);
      tabsHost.append(ui.tabs(FILTERS.map((f) => ({ ...f, label: `${f.label}` })), filter, (id) => { filter = id; draw(); }));
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'name', label: 'Company', render: (t) => h('div', null, h('strong', null, t.name), h('div', { class: 'muted hq-small' }, `${t.slug}${t.province ? ` · ${t.province}` : ''}`)), sort: (t) => t.name.toLowerCase() },
          { key: 'status', label: 'Status', render: (t) => ui.badge(t.status === 'closed' ? 'closing' : t.status, TONE[t.status]), sort: (t) => t.status },
          { key: 'plan', label: 'Plan', render: (t) => h('div', null, planName(t.effectivePlan), (t.onTrial ?? t.plan === 'trial') ? h('div', { class: 'muted hq-small' }, t.trialEndsAt ? `trial ends ${ui.fmtDate(t.trialEndsAt)}` : 'trial, no end set') : null), sort: (t) => t.effectivePlan },
          { key: 'signup', label: 'Sign-up', render: (t) => signupCell(ui, t.signup), sort: (t) => (t.signup ? (t.signup.depositCredited ? 2 : 1) : 0) },
          { key: 'seats', label: 'Seats', align: 'right', render: (t) => `${t.seats.used} / ${t.seats.included ?? '∞'}${t.seats.extra ? ` (+${t.seats.extra})` : ''}`, sort: (t) => t.seats.used },
          { key: 'billing', label: 'Billing', render: (t) => (t.billing.status === 'none' ? h('span', { class: 'muted' }, '—') : ui.badge(t.billing.status.replace(/_/g, ' '), TONE[t.billing.status])), sort: (t) => t.billing.status },
          { key: 'active', label: 'Last active', render: (t) => (t.lastActiveAt ? ago(t.lastActiveAt) : '—'), sort: (t) => t.lastActiveAt || '' },
          { key: 'created', label: 'Created', render: (t) => ui.fmtDate(t.createdAt), sort: (t) => t.createdAt },
        ],
        rows: visible(),
        onRowClick: (t) => nav(`tenants/${t.id}`),
        empty: ui.empty({ icon: 'users', title: rows.length ? 'No companies match' : 'No companies yet' }),
      }));
      drawSignups();
    }

    /** On the Sign-ups tab: sign-ups that did not (or not yet) become companies. */
    function drawSignups() {
      ui.clear(signupHost);
      if (filter !== 'signups') return;
      if (!signups) {
        signupHost.append(h('p', { class: 'muted' }, 'Loading sign-ups…'));
        get('/api/hq/signups').then((r) => { signups = r.data; drawSignups(); })
          .catch((e) => { ui.clear(signupHost); signupHost.append(ui.empty({ icon: 'alert', title: 'Could not load sign-ups', text: e.message })); });
        return;
      }
      const open = signups.filter((s) => s.status !== 'completed');
      signupHost.append(h('h3', { class: 'hq-subhead' }, 'Not finished'), ui.table({
        columns: [
          { key: 'company', label: 'Company', render: (s) => h('div', null, h('strong', null, s.companyName), h('div', { class: 'muted hq-small' }, [s.name, s.email].filter(Boolean).join(' · ') || 'details removed')), sort: (s) => s.companyName.toLowerCase() },
          { key: 'status', label: 'Status', render: (s) => h('div', null, ui.badge(s.status, SIGNUP_TONE[s.status]), s.failure ? h('div', { class: 'muted hq-small' }, s.failure.replace(/_/g, ' ')) : null), sort: (s) => s.status },
          { key: 'plan', label: 'Plan', render: (s) => `${planName(s.plan)} · ${s.users} user${s.users === 1 ? '' : 's'}`, sort: (s) => s.plan },
          { key: 'deposit', label: 'Deposit', render: (s) => (s.depositPaid ? ui.badge(`paid${s.status === 'failed' ? ', refund it' : ''}`, s.status === 'failed' ? 'danger' : 'success') : h('span', { class: 'muted' }, 'not paid')), sort: (s) => Number(s.depositPaid) },
          { key: 'created', label: 'Started', render: (s) => ago(s.createdAt), sort: (s) => s.createdAt },
        ],
        rows: open,
        empty: h('p', { class: 'muted' }, 'Every recent sign-up became a company.'),
      }));
    }

    async function load() {
      try { rows = (await get('/api/hq/tenants')).data; draw(); } catch (e) { ui.clear(tableHost); tableHost.append(ui.empty({ icon: 'alert', title: 'Could not load companies', text: e.message })); }
    }

    function create() {
      ui.formSheet({
        title: 'New company',
        fields: [
          { label: 'Company name', name: 'name', required: true, span: true },
          { label: 'Province', name: 'province', type: 'select', options: [{ value: '', label: '—' }, ...PROVINCES] },
          { label: 'Plan', name: 'plan', type: 'select', value: 'trial', options: [{ value: 'trial', label: 'Trial (Business features)' }, { value: 'starter', label: 'Starter' }, { value: 'pro', label: 'Pro' }, { value: 'business', label: 'Business' }, { value: 'enterprise', label: 'Enterprise' }] },
          { label: 'Trial length (days)', name: 'trialDays', type: 'number', value: 14, min: 1, max: 365 },
          { label: 'Owner name', name: 'ownerName' },
          { label: 'Owner email', name: 'ownerEmail', type: 'email', required: true, hint: 'They get an invite to set a password (7 days). An existing account is added as owner instead.' },
        ],
        submitLabel: 'Create and invite',
        onSubmit: (v) => {
          post('/api/hq/tenants', { name: v.name, province: v.province || null, plan: v.plan, ...(v.plan === 'trial' && v.trialDays ? { trialDays: v.trialDays } : {}), ownerName: v.ownerName, ownerEmail: v.ownerEmail })
            .then((r) => { ui.toast(r.ownerInvited ? 'Company created; owner invited' : 'Company created; existing account added as owner', 'success'); nav(`tenants/${r.tenant.id}`); })
            .catch((e) => ui.toast(e.message, 'error'));
        },
      });
    }

    load();
    return () => {};
  },
};
