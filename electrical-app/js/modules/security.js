// Security audit: access review, activity log, security audit checklists.
import { ROLES, PERMS } from '../auth.js';
import { checklistCards, checklistProgress, newChecklistFromTemplate } from './compliance.js';
import { api } from '../session.js';

export const SECURITY_TEMPLATES = [
  {
    title: 'Quarterly security review', items: [
      ['Every active user still works here and needs access', 'Access'],
      ['Owner/admin roles limited to the people who need them (2 or fewer)', 'Access'],
      ['Every user on a shared device has a PIN', 'Devices'],
      ['Backup exported in the last 30 days and stored off the device', 'Data'],
      ['Activity log reviewed for unusual deletes or failed sign-ins', 'Monitoring'],
      ['Customer data only on company-managed devices', 'Data'],
      ['Device OS and browser up to date', 'Devices'],
      ['Wi-Fi at the shop uses WPA2/WPA3 with a non-default password', 'Network'],
    ],
  },
  {
    title: 'New-hire onboarding', items: [
      ['Employee record created with the lowest role that fits the job', 'Access'],
      ['PIN set and shared with the employee only', 'Access'],
      ['Lockout/tagout and site SOPs assigned and acknowledged', 'Training'],
      ['Licence number and expiry recorded', 'Compliance'],
      ['Company device issued and logged (if any)', 'Devices'],
      ['Explained: no customer data on personal accounts', 'Data'],
    ],
  },
  {
    title: 'Leaver offboarding', items: [
      ['Employee marked inactive in the app', 'Access'],
      ['PIN cleared; signed out of every shared device', 'Access'],
      ['Company devices, keys and fobs returned', 'Devices'],
      ['Shared passwords they knew (Wi-Fi, supplier portals) rotated', 'Access'],
      ['Van inventory counted and transferred', 'Assets'],
      ['Open time entries closed and approved', 'Payroll'],
    ],
  },
  {
    title: 'Device check', items: [
      ['Screen lock with passcode or biometrics enabled', 'Devices'],
      ['Find My / remote wipe turned on', 'Devices'],
      ['OS updates current', 'Devices'],
      ['App added to Home Screen from the company URL only', 'Devices'],
      ['Persistent storage granted (Settings shows "persistent")', 'Data'],
      ['No unapproved apps with access to photos or files', 'Data'],
    ],
  },
];

const PERM_LABEL = {
  dashboard: 'Dashboard', clients: 'Clients', leads: 'Leads', sequences: 'Sequences', jobs: 'Jobs', schedule: 'Schedule',
  drawings: 'Drawings', estimates: 'Estimates', invoices: 'Invoices', inventory: 'Inventory', employees: 'Employees',
  time: 'Time clock', 'time-approve': 'Approve time', sops: 'SOPs', compliance: 'Compliance', security: 'Security',
  calcs: 'Calcs', panels: 'Panels', settings: 'Settings',
};

/** Findings from the access review, also used for the security score. */
export function accessFindings(store, daysUntil) {
  const emps = store.list('employees');
  const active = emps.filter((e) => e.active !== false);
  const out = [];
  const admins = active.filter((e) => e.role === 'owner' || e.role === 'admin');
  if (admins.length > 2) out.push({ tone: 'warning', text: `${admins.length} active owners/admins. Keep it to 2 or fewer.`, who: admins.map((e) => e.name).join(', ') });
  const noPin = active.filter((e) => !e.pin);
  if (noPin.length) out.push({ tone: 'warning', text: `${noPin.length === 1 ? `${noPin[0].name} has` : `${noPin.length} people have`} no PIN, so anyone holding the device can act as them${noPin.length > 1 ? `: ${noPin.map((e) => e.name).join(', ')}` : ''}.`, who: noPin.map((e) => e.name).join(', ') });
  for (const e of emps.filter((e) => e.active === false)) out.push({ tone: 'neutral', text: `${e.name} is inactive. Confirm devices and keys were returned.`, who: e.name, id: e.id });
  for (const e of active.filter((e) => e.licenceNo && e.licenceExpiry && daysUntil(e.licenceExpiry) < 0)) out.push({ tone: 'danger', text: `${e.name}'s licence expired ${-daysUntil(e.licenceExpiry)} days ago.`, who: e.name, id: e.id });
  return out;
}

export function securityScore(store, daysUntil) {
  let score = 100;
  for (const f of accessFindings(store, daysUntil)) score -= f.tone === 'danger' ? 12 : f.tone === 'warning' ? 6 : 2;
  for (const cl of store.list('checklists', (c) => c.kind === 'security')) {
    const p = checklistProgress(cl);
    score -= p.fail * 8 + (cl.completedAt ? 0 : p.open * 1);
  }
  const failedSignIns = store.count('auditLog', (a) => a.action === 'sign-in-failed' && daysUntil(a.at) > -30);
  score -= Math.min(15, failedSignIns * 3);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export default {
  id: 'security',
  title: 'Security audit',
  icon: 'lock',
  group: 'admin',
  perm: 'security',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    let tab = ctx.query.tab || 'access';
    const filters = { user: '', action: '', coll: '', from: ui.today(-30), to: ui.today() };
    const head = h('div', { class: 'grid stat-grid' });
    const tabsHost = h('div', { class: 'row', style: { marginBottom: '16px' } });
    const body = h('div', { class: 'stack' });

    const empName = (() => { const m = Object.fromEntries(store.list('employees').map((e) => [e.id, e.name])); return (id) => (id ? m[id] || 'Removed user' : 'System'); })();

    function drawHead() {
      ui.clear(head);
      const score = securityScore(store, ui.daysUntil);
      const findings = accessFindings(store, ui.daysUntil);
      const failed = store.count('auditLog', (a) => a.action === 'sign-in-failed' && ui.daysUntil(a.at) > -30);
      const deletes = store.count('auditLog', (a) => a.action === 'delete' && ui.daysUntil(a.at) > -7);
      head.append(
        ui.stat({ label: 'Security score', value: `${score}/100`, tone: score >= 85 ? 'success' : score >= 65 ? 'accent' : 'danger', hint: 'From access findings and audit results' }),
        ui.stat({ label: 'Access findings', value: findings.length, tone: findings.length ? 'accent' : 'success' }),
        ui.stat({ label: 'Failed sign-ins (30d)', value: failed, tone: failed ? 'danger' : null }),
        ui.stat({ label: 'Deletes (7d)', value: deletes }));
    }

    function access() {
      const emps = store.list('employees').sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name));
      const findings = accessFindings(store, ui.daysUntil);
      body.append(...ui.section('Findings', findings.length
        ? h('div', { class: 'list' }, findings.map((f) => h('div', { class: 'list-row' }, ui.icon(f.tone === 'danger' ? 'alert' : 'info', 18), h('div', { class: 'grow' }, f.text), ui.badge(f.tone === 'danger' ? 'High' : f.tone === 'warning' ? 'Medium' : 'Low', f.tone === 'neutral' ? 'neutral' : f.tone))))
        : h('div', { class: 'card' }, h('span', { class: 'row' }, ui.icon('check', 18), 'No access findings. Nice.'))));
      body.append(...ui.section('People and roles', ui.table({
        columns: [
          { key: 'name', label: 'Person', render: (e) => h('span', { class: 'row' }, h('span', { class: 'avatar', style: { background: e.color || '#5f5a51' } }, ui.initials(e.name)), h('strong', null, e.name)), sort: (e) => e.name },
          { key: 'role', label: 'Role', render: (e) => ROLES[e.role]?.label || e.role, sort: (e) => e.role },
          { key: 'status', label: 'Status', render: (e) => ui.statusBadge(e.active === false ? 'closed' : 'active') },
          { key: 'pin', label: 'PIN', render: (e) => (e.pin ? ui.badge('Set', 'success') : ui.badge('None', 'warning')) },
          { key: 'perms', label: 'Permissions', render: (e) => `${(ROLES[e.role]?.perms || []).length} of ${PERMS.length}`, align: 'right' },
        ],
        rows: emps,
        empty: ui.empty({ icon: 'users', title: 'No employees' }),
      })));
      const roles = Object.keys(ROLES);
      const yes = ui.icon('check', 16);
      body.append(...ui.section('What each role can do', h('div', { class: 'table-wrap' }, h('table', { class: 'table perm-matrix' },
        h('thead', null, h('tr', null, h('th', null, 'Area'), roles.map((r) => h('th', { class: 'center' }, ROLES[r].label)))),
        h('tbody', null, PERMS.map((p) => h('tr', null, h('td', null, PERM_LABEL[p] || p),
          roles.map((r) => h('td', { class: 'center' }, ROLES[r].perms.includes(p) ? yes.cloneNode(true) : h('span', { class: 'muted', 'aria-label': 'no' }, '·'))))))))));
    }

    function logRows() {
      return store.list('auditLog').filter((a) => {
        const day = ui.localDay(a.at);
        return (!filters.user || a.userId === filters.user || (filters.user === 'system' && !a.userId))
          && (!filters.action || a.action === filters.action)
          && (!filters.coll || a.collection === filters.coll)
          && (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
      }).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    }

    // Signed in: the company's audit log from the server (every device, the API and agents),
    // newest first, 200 at a time. "This device" shows the local log as before.
    let source = auth.synced ? 'server' : 'device';
    function serverActivity() {
      const f = { action: '', coll: '' };
      let rows = [], cursor = null, loading = false;
      const host = h('div');
      const input = (label, key, ph) => h('label', { class: 'field' }, h('span', null, label), h('input', { value: f[key], placeholder: ph, onChange: (e) => { f[key] = e.target.value.trim(); rows = []; cursor = null; load(); } }));
      body.append(h('div', { class: 'card log-filters' }, h('div', { class: 'form-grid' }, input('Action', 'action', 'e.g. record.delete'), input('Area', 'coll', 'e.g. invoices'),
        h('div', { class: 'field' }, h('span', null, 'Source'), ui.tabs([{ id: 'server', label: 'Company (server)' }, { id: 'device', label: 'This device' }], source, (t) => { source = t; draw(); })))), host);
      const paint = (err) => {
        h(ui.clear(host), null, h('div', { class: 'row', style: { margin: '8px 0' } }, h('span', { class: 'muted' }, err ? err.message : `${rows.length} entries${cursor ? ' loaded' : ''}`), h('span', { class: 'grow' }),
          rows.length ? ui.button('Export CSV', { icon: 'download', size: 'sm', onClick: () => {
            const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            ui.download(`audit-log-${ui.today()}.csv`, [['when', 'who', 'kind', 'action', 'area', 'record', 'detail'].join(','), ...rows.map((a) => [a.at, a.actorLabel, a.actorType, a.action, a.collection, a.recordId, a.summary].map(esc).join(','))].join('\n'), 'text/csv');
            store.log('export', `Audit log CSV (${rows.length} rows)`, 'auditLog');
          } }) : null),
        ui.table({
          columns: [
            { key: 'at', label: 'When', render: (a) => ui.fmtDateTime(a.at) },
            { key: 'who', label: 'Who', render: (a) => h('span', null, a.actorLabel || 'System', a.actorType && a.actorType !== 'user' ? h('span', { class: 'muted' }, ` (${a.actorType.replace('_', ' ')})`) : null) },
            { key: 'action', label: 'Action', render: (a) => ui.badge(a.action, /delete|failed|revoke|locked/.test(a.action) ? 'danger' : /create|add/.test(a.action) ? 'success' : 'neutral') },
            { key: 'collection', label: 'Area', render: (a) => a.collection || '—' },
            { key: 'summary', label: 'Detail', render: (a) => h('span', { class: 'log-summary' }, a.summary || '—') },
          ],
          rows, empty: ui.empty({ icon: 'activity', title: loading ? 'Loading…' : 'No matching entries' }),
        }),
        cursor ? h('div', { class: 'row' }, ui.button('Load more', { size: 'sm', onClick: load })) : null);
      };
      async function load() {
        loading = true; paint();
        const q = new URLSearchParams({ limit: '200' });
        if (f.action) q.set('action', f.action);
        if (f.coll) q.set('collection', f.coll);
        if (cursor) q.set('cursor', cursor);
        try {
          const r = await api.get(`/api/v1/auditLog?${q}`);
          rows = rows.concat(r.data || []); cursor = r.more ? r.cursor : null; loading = false; paint();
        } catch (e) { loading = false; paint(e.code === 'offline' ? new Error('Offline: the company log needs a connection. Switch to This device.') : e); }
      }
      load();
    }

    function activity() {
      if (source === 'server') return serverActivity();
      const all = store.list('auditLog');
      const uniq = (k) => [...new Set(all.map((a) => a[k]).filter(Boolean))].sort();
      const sel = (label, key, opts) => {
        const s = h('select', { 'aria-label': label, onChange: (e) => { filters[key] = e.target.value; drawLog(); } },
          h('option', { value: '' }, `All ${label.toLowerCase()}s`), opts.map((o) => h('option', { value: o.value, selected: filters[key] === o.value }, o.label)));
        return h('label', { class: 'field' }, h('span', null, label), s);
      };
      const date = (label, key) => h('label', { class: 'field' }, h('span', null, label), h('input', { type: 'date', value: filters[key], onChange: (e) => { filters[key] = e.target.value; drawLog(); } }));
      const userOpts = [...store.list('employees').map((e) => ({ value: e.id, label: e.name })), { value: 'system', label: 'System' }];
      body.append(h('div', { class: 'card log-filters' }, h('div', { class: 'form-grid' },
        sel('User', 'user', userOpts), sel('Action', 'action', uniq('action').map((a) => ({ value: a, label: a }))),
        sel('Area', 'coll', uniq('collection').map((a) => ({ value: a, label: a }))), date('From', 'from'), date('To', 'to'),
        auth.synced ? h('div', { class: 'field' }, h('span', null, 'Source'), ui.tabs([{ id: 'server', label: 'Company (server)' }, { id: 'device', label: 'This device' }], source, (t) => { source = t; draw(); })) : null)));
      const logHost = h('div');
      body.append(logHost);
      function drawLog() {
        ui.clear(logHost);
        const rows = logRows();
        const shown = rows.slice(0, 300);
        logHost.append(h('div', { class: 'row', style: { margin: '8px 0' } }, h('span', { class: 'muted' }, `${rows.length} entries${rows.length > shown.length ? ` · showing latest ${shown.length}` : ''}`),
          h('span', { class: 'grow' }), ui.button('Export CSV', { icon: 'download', size: 'sm', onClick: () => exportCsv(rows) })));
        logHost.append(ui.table({
          columns: [
            { key: 'at', label: 'When', render: (a) => ui.fmtDateTime(a.at), sort: (a) => a.at },
            { key: 'user', label: 'Who', render: (a) => empName(a.userId), sort: (a) => empName(a.userId) },
            { key: 'action', label: 'Action', render: (a) => ui.badge(a.action, a.action === 'delete' || a.action === 'sign-in-failed' ? 'danger' : a.action === 'create' ? 'success' : 'neutral') },
            { key: 'collection', label: 'Area' },
            { key: 'summary', label: 'Detail', render: (a) => h('span', { class: 'log-summary' }, a.summary || '—') },
          ],
          rows: shown,
          empty: ui.empty({ icon: 'activity', title: 'No activity in this range' }),
        }));
      }
      function exportCsv(rows) {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [['when', 'user', 'action', 'area', 'record', 'detail'].join(',')];
        for (const a of rows) lines.push([a.at, empName(a.userId), a.action, a.collection, a.recordId, a.summary].map(esc).join(','));
        ui.download(`activity-log-${ui.today()}.csv`, lines.join('\n'), 'text/csv');
        store.log('export', `Activity log CSV (${rows.length} rows)`, 'auditLog');
      }
      drawLog();
    }

    function audits() {
      const rows = store.list('checklists', (c) => c.kind === 'security');
      body.append(checklistCards(ctx, rows, ui.empty({ icon: 'shield-check', title: 'No security audits yet', text: 'Run a quarterly review, or onboard and offboard people with a checklist.',
        action: ui.button('New audit', { variant: 'primary', icon: 'plus', onClick: () => newChecklistFromTemplate(ctx, 'security', SECURITY_TEMPLATES) }) })));
    }

    const TABS = [{ id: 'access', label: 'Access review' }, { id: 'log', label: 'Activity log' }, { id: 'audits', label: 'Audits' }];
    function draw() {
      drawHead();
      ui.clear(tabsHost);
      ui.h(tabsHost, null, ui.tabs(TABS, tab, (t) => { tab = t; draw(); }), h('span', { class: 'grow' }),
        tab === 'audits' ? ui.button('New audit', { variant: 'primary', icon: 'plus', onClick: () => newChecklistFromTemplate(ctx, 'security', SECURITY_TEMPLATES) }) : null,
        tab === 'access' ? ui.button('Manage people', { icon: 'id-card', href: '#/employees' }) : null);
      ui.clear(body);
      ({ access, log: activity, audits })[tab]();
    }

    root.append(ui.page({ title: 'Security audit', subtitle: `Who can do what, what they did, and how we check it · signed in as ${auth.current().name}` }, head, tabsHost, body));
    draw();
    // the log tab redraws itself through its filters; redraw others on data change
    const offs = ['employees', 'checklists'].map((c) => store.on(c, () => { if (tab !== 'log') draw(); else drawHead(); }));
    return () => offs.forEach((f) => f());
  },
};
