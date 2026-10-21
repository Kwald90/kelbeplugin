// Employees (S20): staff list, roles, licences, rates, PINs; detail with certs, time, schedule, SOP acks.
// Release 1 (docs/releases/r1-get-paid.md 2.3, 6.4; docs/office/job-costing.md): hire date, bill rate,
// the truck clock-ins take (defaultEquipmentId), burden overrides, and the wage history: "New rate
// from <date>" adds to rateHistory and leaves the cost of earlier days alone (rateCents stays the
// rate in force today). Wages, history and burden are money: managers who see money only.
import { ROLES } from '../auth.js';
import { entryHours } from '../lib/money.js';
import { burdenRate, rateOn, pctText } from '../lib/burden.js';
import { costingRules } from './reports.js';
import { weekStart, addDays } from './schedule.js';
import { sopRev, ackRev } from './sops.js';

const COLORS = ['#8a5a00', '#1f5fb8', '#1d7044', '#7a3fb0', '#b42318', '#0f7b8a', '#c25e00', '#5f5a51'];

function licenceBadge(ui, expiry) {
  if (!expiry) return ui.badge('none', 'neutral');
  const d = ui.daysUntil(expiry);
  if (d < 0) return ui.badge(`expired ${ui.fmtDate(expiry)}`, 'danger');
  if (d <= 30) return ui.badge(`${d}d · ${ui.fmtDate(expiry)}`, 'warning');
  return ui.badge(ui.fmtDate(expiry), 'success');
}

function employeeForm(ctx, emp, onSaved) {
  const { store, ui, auth } = ctx;
  const mgr = auth.isManager();
  const me = auth.current();
  const money = mgr && auth.seesMoney?.();
  const b = emp?.burden || {};
  // only owners can make or edit owners/admins
  const roleOpts = Object.entries(ROLES).filter(([k]) => me.role === 'owner' || !['owner', 'admin'].includes(k) || emp?.role === k)
    .map(([value, r]) => ({ value, label: r.label }));
  return ui.formSheet({
    title: emp ? `Edit ${emp.name}` : 'New employee',
    submitLabel: emp ? 'Save' : 'Add employee',
    fields: [
      { label: 'Full name', name: 'name', value: emp?.name, required: true, span: true },
      { label: 'Role', name: 'role', type: 'select', value: emp?.role || 'electrician', options: roleOpts, hint: mgr ? null : 'Managers only' },
      { label: 'Hourly rate (cost)', name: 'rateCents', type: 'money', value: emp?.rateCents ?? 0 },
      { label: 'Email', name: 'email', type: 'email', value: emp?.email },
      { label: 'Phone', name: 'phone', type: 'tel', value: emp?.phone },
      { label: 'Licence no.', name: 'licenceNo', value: emp?.licenceNo },
      { label: 'Payroll ID', name: 'payrollId', value: emp?.payrollId, hint: 'Employee ID in Wagepoint or QuickBooks, for payroll exports' },
      { label: 'Licence expiry', name: 'licenceExpiry', type: 'date', value: emp?.licenceExpiry },
      { label: 'PIN (4 digits, optional)', name: 'pin', value: emp?.pin, placeholder: '••••', hint: 'Asked when switching to this user' },
      { label: 'Colour', name: 'color', type: 'color', value: emp?.color || COLORS[store.count('employees') % COLORS.length] },
      { label: 'Active', name: 'active', type: 'checkbox', value: emp ? emp.active !== false : true },
      ...(mgr ? [{ label: 'Hire date', name: 'hireDate', type: 'date', value: emp?.hireDate || '', hint: 'Vacation pay goes up on the fifth anniversary' }] : []),
      ...(mgr ? [{ label: 'Truck they drive', name: 'defaultEquipmentId', type: 'select', value: emp?.defaultEquipmentId || '', options: ui.recordOptions(store.list('equipment', (q) => q.active !== false && q.kind === 'truck'), 'name', '— none —'), hint: 'Clock-ins charge this truck to the job' }] : []),
      ...(money ? [
        { label: 'T&M bill rate (optional)', name: 'billRateCents', type: 'money', value: emp?.billRateCents ?? null, hint: 'Overrides the company labour rate on T&M invoices' },
        { label: 'Vacation pay % (blank = the rule)', name: 'burden.vacationPct', type: 'number', step: '0.01', min: '0', value: b.vacationPct ?? '' },
        { label: 'Holiday pay % (blank = the rule)', name: 'burden.holidayPct', type: 'number', step: '0.01', min: '0', value: b.holidayPct ?? '' },
        { label: 'WCB % (blank = the company rate)', name: 'burden.wcbPct', type: 'number', step: '0.01', min: '0', value: b.wcbPct ?? '' },
        { label: 'Non-productive % (blank = company)', name: 'burden.nonProductivePct', type: 'number', step: '0.1', min: '0', value: b.nonProductivePct ?? '' },
        { label: 'Paid hours a year (blank = company)', name: 'burden.annualHours', type: 'number', step: '1', min: '0', value: b.annualHours ?? '' },
        { label: 'Benefits per hour (optional)', name: 'burden.benefitsCentsPerHour', type: 'money', value: b.benefitsCentsPerHour ?? null },
      ] : []),
    ],
    danger: emp && mgr && emp.id !== me.id ? { label: 'Delete', onClick: async () => {
      if (store.count('timeEntries', (t) => t.employeeId === emp.id)) { store.update('employees', emp.id, { active: false }); ui.toast(`${emp.name} has time on record, so they were deactivated instead`); return; }
      store.remove('employees', emp.id); ui.toast('Employee deleted'); ctx.nav('#/employees');
    } } : null,
    onSubmit(v, form) {
      if (v.pin && !/^\d{4}$/.test(v.pin)) { ui.toast('PIN must be exactly 4 digits', 'error'); return false; }
      if (!mgr) { delete v.role; delete v.rateCents; delete v.pin; delete v.payrollId; delete v.hireDate; delete v.defaultEquipmentId; }
      Object.assign(v, burdenFields(v, form, emp, money));
      if (v.hireDate === '') v.hireDate = null;
      if (v.defaultEquipmentId === '') v.defaultEquipmentId = null;
      // A changed wage in this form is the rate from today on; the history keeps earlier days.
      if (money && emp && v.rateCents != null && v.rateCents !== emp.rateCents) v.rateHistory = withRate(emp, ui.today(), v.rateCents);
      if (v.payrollId != null) v.payrollId = String(v.payrollId).trim().slice(0, 64);
      if (emp && emp.id === me.id && v.role && v.role !== emp.role && ['owner', 'admin'].includes(emp.role) && !['owner', 'admin'].includes(v.role)) {
        const admins = store.count('employees', (e) => e.active !== false && ['owner', 'admin'].includes(e.role));
        if (admins <= 1) { ui.toast('You are the last owner/admin; keep that role', 'error'); return false; }
      }
      const saved = emp ? store.update('employees', emp.id, v) : store.add('employees', v);
      if (emp && (v.role !== emp.role || v.pin !== emp.pin)) store.log('permission-change', `${saved.name}: role ${emp.role}→${saved.role}${v.pin !== emp.pin ? ', PIN changed' : ''}`, 'employees', saved.id);
      ui.toast(emp ? 'Saved' : `${saved.name} added`, 'success');
      onSaved?.(saved);
    },
  });
}

/** The burden overrides and bill rate from the form ('burden.x' fields; blank = the company default). */
function burdenFields(v, form, emp, money) {
  const out = {};
  for (const k of Object.keys(v)) if (k.startsWith('burden.')) delete v[k];
  if (!money) { delete v.billRateCents; return out; }
  const raw = (name) => String(form?.querySelector(`[name="${name}"]`)?.value ?? '').trim();
  const numOrNull = (name, cents = false) => {
    const r = raw(name);
    if (r === '') return null;
    const n = Number(r);
    return Number.isFinite(n) ? (cents ? Math.round(n * 100) : n) : null;
  };
  const hours = numOrNull('burden.annualHours');
  const burden = {
    vacationPct: numOrNull('burden.vacationPct'), holidayPct: numOrNull('burden.holidayPct'), wcbPct: numOrNull('burden.wcbPct'),
    nonProductivePct: numOrNull('burden.nonProductivePct'), annualHours: hours == null ? null : Math.round(hours),
    benefitsCentsPerHour: numOrNull('burden.benefitsCentsPerHour', true),
  };
  if (Object.values(burden).some((x) => x != null) || emp?.burden) out.burden = burden;
  out.billRateCents = numOrNull('billRateCents', true);
  return out;
}

/**
 * The rate history with a new rate from `from`: the current rate is kept from the hire date (or the
 * start) when there was no history yet, and a rate already on that day is replaced.
 */
export function withRate(emp, from, rateCents) {
  let list = Array.isArray(emp?.rateHistory) ? emp.rateHistory.slice() : [];
  if (!list.length && Number.isInteger(emp?.rateCents)) list.push({ from: /^\d{4}-\d{2}-\d{2}$/.test(emp.hireDate || '') && emp.hireDate < from ? emp.hireDate : '1900-01-01', rateCents: emp.rateCents });
  list = list.filter((r) => r.from !== from).concat({ from, rateCents }).sort((a, b) => String(a.from).localeCompare(String(b.from)));
  return list.slice(-200);
}

function newRateSheet(ctx, emp) {
  const { store, ui } = ctx;
  ui.formSheet({
    title: `New rate for ${emp.name}`,
    submitLabel: 'Add rate',
    fields: [
      { label: 'From', name: 'from', type: 'date', value: ui.today(), required: true },
      { label: 'Hourly rate (cost)', name: 'rateCents', type: 'money', value: emp.rateCents ?? 0, required: true },
    ],
    onSubmit(v) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.from || '')) { ui.toast('Pick the date the rate starts', 'error'); return false; }
      const rateHistory = withRate(emp, v.from, v.rateCents);
      const current = rateOn(rateHistory, ui.today()) ?? v.rateCents;
      store.update('employees', emp.id, { rateHistory, rateCents: current }, { summary: `${emp.name}: new rate from ${v.from}` });
      ui.toast(`New rate from ${ui.fmtDate(v.from)}`, 'success');
    },
  });
}

/** Pay and burden on the employee page (managers who see money). */
function payCard(ctx, e) {
  const { store, ui } = ctx;
  const { h } = ui;
  const br = burdenRate(e, { rules: costingRules(store), settings: store.settings(), on: ui.today() });
  const hist = (e.rateHistory || []).slice().sort((a, b) => String(b.from).localeCompare(String(a.from)));
  const truck = e.defaultEquipmentId ? store.get('equipment', e.defaultEquipmentId) : null;
  const line = (label, value) => h('div', { class: 'row' }, h('span', { class: 'grow' }, label), h('strong', null, value));
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h3', { class: 'grow', style: { margin: 0 } }, 'Pay and burden'), ui.button('New rate from…', { size: 'sm', icon: 'plus', onClick: () => newRateSheet(ctx, e) })),
    h('div', { class: 'stack' },
      line('Wage today', `${ui.fmtMoney(br.wageCents)}/h`),
      line('Cost per paid hour', `${ui.fmtMoney(br.costPerPaidHourCents)}/h`),
      line('Cost per productive hour', `${ui.fmtMoney(br.costPerProductiveHourCents)}/h`),
      h('div', { class: 'muted' }, `Vacation ${pctText(br.vacationPct)}, holiday ${pctText(br.holidayPct)}, statutory ${pctText(br.statutoryPct)} (CPP ${pctText(br.cppPct)}, EI ${pctText(br.eiPct)}, WCB ${pctText(br.wcbPct)}), non-productive ${pctText(br.nonProductivePct)}`),
      e.billRateCents ? h('div', { class: 'muted' }, `T&M bill rate ${ui.fmtMoney(e.billRateCents)}/h`) : null,
      h('div', { class: 'muted' }, `Hired ${e.hireDate ? ui.fmtDate(e.hireDate) : 'date not set'}${truck ? ` · drives ${truck.name}` : ''}`),
      br.warnings.length ? h('ul', { class: 'muted', style: { margin: 0, paddingLeft: '18px' } }, br.warnings.map((w) => h('li', null, w))) : null,
      hist.length ? h('details', null, h('summary', null, `Rate history (${hist.length})`),
        h('ul', { style: { margin: 0, paddingLeft: '18px' } }, hist.map((r) => h('li', null, `From ${r.from === '1900-01-01' ? 'the start' : ui.fmtDate(r.from)}: ${ui.fmtMoney(r.rateCents)}/h`)))) : null));
}

function listView(root, ctx) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const mgr = auth.isManager();
  let q = '', showInactive = false;
  const body = h('div');
  const draw = () => {
    const needle = q.toLowerCase();
    const rows = store.list('employees', (e) => (showInactive || e.active !== false) && (!needle || [e.name, e.role, e.email, e.licenceNo].join(' ').toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name));
    ui.clear(body).append(ui.table({
      columns: [
        { key: 'name', label: 'Name', sort: (e) => e.name, render: (e) => h('span', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('span', { class: 'avatar', style: { background: e.color || '#5f5a51' } }, ui.initials(e.name)),
          h('span', null, h('strong', null, e.name), e.active === false ? h('span', { class: 'muted' }, ' (inactive)') : null)) },
        { key: 'role', label: 'Role', sort: (e) => e.role, render: (e) => ui.badge(ROLES[e.role]?.label || e.role, ['owner', 'admin'].includes(e.role) ? 'accent' : 'neutral') },
        { key: 'phone', label: 'Phone', render: (e) => (e.phone ? h('a', { href: 'tel:' + e.phone, onClick: (ev) => ev.stopPropagation() }, e.phone) : '—') },
        { key: 'licenceNo', label: 'Licence', render: (e) => e.licenceNo || '—' },
        { key: 'exp', label: 'Licence expiry', sort: (e) => e.licenceExpiry || '9999', render: (e) => licenceBadge(ui, e.licenceExpiry) },
        mgr ? { key: 'rate', label: 'Rate', align: 'right', sort: (e) => e.rateCents || 0, render: (e) => `${ui.fmtMoney(e.rateCents)}/h` } : null,
      ].filter(Boolean),
      rows, onRowClick: (e) => nav('#/employees/' + e.id),
      empty: ui.empty({ icon: 'id-card', title: 'No employees', text: 'Add your crew to schedule them and track time.' }),
    }));
  };
  root.append(ui.page({ title: 'Employees', subtitle: 'Crew, roles, licences and rates',
    actions: mgr ? [ui.button('Add employee', { variant: 'primary', icon: 'plus', onClick: () => employeeForm(ctx, null, (e) => nav('#/employees/' + e.id)) })] : [] },
  h('div', { class: 'row ops-toolbar' }, ui.searchBox('Search people', (v) => { q = v; draw(); }), h('span', { class: 'grow' }),
    h('label', { class: 'field check' }, h('input', { type: 'checkbox', onChange: (e) => { showInactive = e.target.checked; draw(); } }), h('span', null, 'Show inactive'))),
  body));
  draw();
  return store.on('employees', draw);
}

function detailView(root, ctx, id) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const host = h('div');
  const draw = () => {
    ui.clear(host);
    const e = store.get('employees', id);
    if (!e) return host.append(ui.page({ title: 'Not found' }, ui.empty({ icon: 'user', title: 'This employee no longer exists', action: ui.button('All employees', { href: '#/employees' }) })));
    const canEdit = auth.isManager() || auth.current().id === e.id;
    const ws = weekStart(ui.today()), we = addDays(ws, 6);
    const week = store.list('timeEntries', (t) => t.employeeId === e.id && t.clockIn && ui.localDay(t.clockIn) >= ws && ui.localDay(t.clockIn) <= we);
    const weekHours = week.reduce((s, t) => s + entryHours(t), 0);
    const certs = store.list('certifications', (c) => c.employeeId === e.id);
    const upcoming = store.list('schedule', (s) => s.employeeId === e.id && s.date >= ui.today()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);
    const sops = store.list('sops');
    const required = sops.filter((s) => (s.requiredRoles || []).includes(e.role));

    host.append(ui.page({
      title: e.name, subtitle: `${ROLES[e.role]?.label || e.role}${e.active === false ? ' · inactive' : ''}`,
      actions: [ui.button('', { icon: 'chevron-left', title: 'All employees', href: '#/employees' }), canEdit ? ui.button('Edit', { icon: 'edit', onClick: () => employeeForm(ctx, e) }) : null].filter(Boolean),
    },
    h('div', { class: 'grid ops-stats' },
      ui.stat({ label: 'This week', value: ui.fmtHours(weekHours), hint: weekHours > 40 ? 'overtime' : `${week.length} shift(s)`, tone: weekHours > 40 ? 'danger' : null }),
      ui.stat({ label: 'Licence', value: e.licenceNo || '—', hint: e.licenceExpiry ? `expires ${ui.fmtDate(e.licenceExpiry)}` : 'no expiry set', tone: ui.daysUntil(e.licenceExpiry) < 0 ? 'danger' : ui.daysUntil(e.licenceExpiry) <= 30 ? 'accent' : null }),
      ui.stat({ label: 'SOPs signed', value: `${required.filter((s) => (s.acks || []).some((a) => a.employeeId === e.id && ackRev(a) === sopRev(s))).length}/${required.length}`, hint: 'required for role' })),
    h('div', { class: 'grid-2', style: { marginTop: '16px' } },
      h('div', { class: 'card' }, h('h3', null, 'Contact'),
        h('div', { class: 'stack' },
          h('div', { class: 'row' }, ui.icon('mail', 16), e.email ? h('a', { href: 'mailto:' + e.email }, e.email) : h('span', { class: 'muted' }, '—')),
          h('div', { class: 'row' }, ui.icon('phone', 16), e.phone ? h('a', { href: 'tel:' + e.phone }, e.phone) : h('span', { class: 'muted' }, '—')),
          h('div', { class: 'row' }, ui.icon('key', 16), e.pin ? 'PIN set' : h('span', { class: 'muted' }, 'No PIN')))),
      h('div', { class: 'card' }, h('h3', null, 'Certifications'),
        certs.length ? h('div', { class: 'stack' }, certs.map((c) => h('div', { class: 'row' }, h('span', { class: 'grow' }, h('strong', null, c.name), h('span', { class: 'muted' }, ` · ${c.issuer || ''}`)), licenceBadge(ui, c.expiry))))
          : h('p', { class: 'muted', style: { margin: 0 } }, 'None recorded. Add them in Compliance.')),
      auth.isManager() && auth.seesMoney?.() ? payCard(ctx, e) : null),
    h('h2', { class: 'section' }, 'Upcoming schedule'),
    upcoming.length ? h('div', { class: 'list' }, upcoming.map((s) => {
      const j = store.get('jobs', s.jobId);
      return h('a', { class: 'list-row click', href: j ? '#/jobs/' + j.id : '#/schedule', style: { color: 'inherit', textDecoration: 'none' } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, j ? `${j.number} · ${j.title}` : 'Deleted job'), h('div', { class: 'meta' }, ui.fmtDate(s.date, { weekday: 'short', month: 'short', day: 'numeric' }))),
        h('span', { class: 'num' }, `${s.hours}h`));
    })) : h('p', { class: 'muted' }, 'Nothing scheduled.'),
    h('h2', { class: 'section' }, 'SOP acknowledgements'),
    sops.length ? h('div', { class: 'list' }, sops.map((s) => {
      const ack = (s.acks || []).filter((a) => a.employeeId === e.id).sort((a, b) => ackRev(b) - ackRev(a))[0];
      const isReq = (s.requiredRoles || []).includes(e.role);
      return h('a', { class: 'list-row click', href: '#/sops/' + s.id, style: { color: 'inherit', textDecoration: 'none' } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, s.title), h('div', { class: 'meta' }, `v${sopRev(s)}${isReq ? ' · required' : ''}`)),
        ack && ackRev(ack) === sopRev(s) ? ui.badge(`signed ${ui.fmtDate(ack.at)}`, 'success') : ack ? ui.badge(`v${ackRev(ack)} only`, 'warning') : isReq ? ui.badge('not signed', 'danger') : ui.badge('optional', 'neutral'));
    })) : h('p', { class: 'muted' }, 'No SOPs yet.')));
  };
  root.append(host);
  draw();
  const offs = ['employees', 'certifications', 'timeEntries', 'schedule', 'sops', 'equipment', 'settings', 'rules'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

export default {
  id: 'employees',
  title: 'Employees',
  icon: 'id-card',
  group: 'people',
  perm: 'employees',
  render(root, ctx) {
    return ctx.params[0] ? detailView(root, ctx, ctx.params[0]) : listView(root, ctx);
  },
};
