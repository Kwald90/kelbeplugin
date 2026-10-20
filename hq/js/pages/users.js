// Users: every account across companies with companies, roles, two-step sign-in, last
// sign-in and lock state. HQ admins can unlock, sign out everywhere and force a password
// reset; every action is audited (HQ's log and each company's). No hashes or secrets here.
import { get, post } from '../api.js';
import { ago } from '../fmt.js';
import { kv, loader } from '../kit.js';

const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'locked', label: 'Locked' }, { id: 'nomfa', label: 'Admins without two-step' },
  { id: 'hq', label: 'HQ staff' }, { id: 'dormant', label: 'Not seen in 90 days' },
];

export default {
  render(root, { ui, isAdmin, me }) {
    const { h } = ui;
    let rows = [];
    let filter = 'all';
    let term = '';
    const tabsHost = h('div');
    const tableHost = h('div');
    root.append(ui.page({ title: 'Users', subtitle: 'Everyone with a Fishtape account' },
      h('div', { class: 'hq-toolbar' }, tabsHost, h('span', { class: 'grow' }), ui.searchBox('Name, email or company', (v) => { term = v; draw(); })), tableHost));

    const isAdminRole = (u) => u.memberships.some((m) => ['owner', 'admin'].includes(m.role) && m.status === 'active');
    function visible() {
      const q = term.trim().toLowerCase();
      return rows.filter((u) => {
        if (filter === 'locked' && !(u.locked || u.pinLocked)) return false;
        if (filter === 'nomfa' && !((isAdminRole(u) || u.platformRole) && !u.mfa)) return false;
        if (filter === 'hq' && !u.platformRole) return false;
        if (filter === 'dormant' && u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < 90 * 86400e3) return false;
        return !q || `${u.name} ${u.email || ''} ${u.memberships.map((m) => m.tenantName).join(' ')}`.toLowerCase().includes(q);
      });
    }

    function draw() {
      ui.clear(tabsHost);
      tabsHost.append(ui.tabs(FILTERS.map((f) => ({ ...f, label: f.id === 'locked' ? `Locked (${rows.filter((u) => u.locked || u.pinLocked).length})` : f.label })), filter, (id) => { filter = id; draw(); }));
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'name', label: 'Person', render: (u) => h('div', null, h('strong', null, u.name), h('div', { class: 'muted hq-small' }, u.email || 'PIN only')), sort: (u) => u.name.toLowerCase() },
          { key: 'cos', label: 'Companies and roles', render: (u) => (u.platformRole ? ui.badge(u.platformRole === 'hq_admin' ? 'HQ admin' : 'HQ staff', 'accent') : h('div', { class: 'hq-small' }, u.memberships.map((m) => h('div', null, `${m.tenantName} · ${m.role}${m.status !== 'active' ? ` (${m.status})` : ''}`)))) },
          { key: 'mfa', label: 'Two-step', render: (u) => (u.mfa ? ui.badge('On', 'success') : (isAdminRole(u) || u.platformRole) ? ui.badge('Missing', 'danger') : ui.badge('Off', 'neutral')), sort: (u) => Number(u.mfa) },
          { key: 'login', label: 'Last sign-in', render: (u) => (u.lastLoginAt ? ago(u.lastLoginAt) : 'never'), sort: (u) => u.lastLoginAt || '' },
          { key: 'state', label: 'State', render: (u) => h('div', { class: 'hq-pill-list' },
            u.status !== 'active' ? ui.badge(u.status, 'neutral') : null,
            u.locked ? ui.badge('locked', 'danger') : null, u.pinLocked ? ui.badge('PIN locked', 'danger') : null,
            !u.hasPassword && u.email ? ui.badge('no password', 'warning') : null,
            u.activeSessions ? ui.badge(`${u.activeSessions} session${u.activeSessions === 1 ? '' : 's'}`, 'info') : null) },
        ],
        rows: visible(),
        onRowClick: open,
        empty: ui.empty({ icon: 'users', title: 'Nobody matches' }),
      }));
    }

    function open(u) {
      const self = u.id === me.id;
      const action = (label, path, { confirm, needReason = true, variant } = {}) => ui.button(label, { variant, disabled: !isAdmin || (self && path !== 'unlock'), onClick: async () => {
        let reason = '';
        if (needReason) {
          reason = await ui.promptDialog('Reason (kept in the audit log; the person\'s companies see it)', { title: label, okLabel: 'Continue' });
          if (reason == null) return;
          if (reason.trim().length < 5) { ui.toast('Give a reason of at least 5 characters', 'error'); return; }
        }
        if (confirm && !(await ui.confirmDialog(confirm, { title: `${label}?`, okLabel: label }))) return;
        try {
          const r = await post(`/api/hq/users/${u.id}/${path}`, needReason ? { reason: reason.trim() } : {});
          ui.toast(`${label}: done`, 'success');
          s.close();
          const i = rows.findIndex((x) => x.id === u.id);
          if (i >= 0) rows[i] = r.user;
          draw();
        } catch (e) { ui.toast(e.message, 'error'); }
      } });
      const s = ui.openSheet({
        title: u.name,
        body: h('div', { class: 'stack' },
          kv(ui, [
            ['Email', u.email || 'none (PIN only)'], ['Account', u.status], ['HQ role', u.platformRole || '—'],
            ['Two-step', u.mfa ? 'on' : 'off'], ['Password', u.hasPassword ? 'set' : 'not set'],
            ['Locked', u.locked ? `until ${ui.fmtDateTime(u.lockedUntil)}` : 'no'], ['Failed sign-ins', u.failedLogins],
            ['Sessions', u.activeSessions], ['Last sign-in', u.lastLoginAt ? ui.fmtDateTime(u.lastLoginAt) : 'never'], ['Last seen', u.lastSeenAt ? ago(u.lastSeenAt) : 'never'],
            ['Created', ui.fmtDate(u.createdAt)],
          ]),
          u.memberships.length ? ui.table({
            columns: [
              { key: 'co', label: 'Company', render: (m) => h('a', { href: `#/tenants/${m.tenantId}` }, m.tenantName) },
              { key: 'role', label: 'Role', render: (m) => m.role },
              { key: 'status', label: 'Status', render: (m) => m.status },
              { key: 'pin', label: 'PIN', render: (m) => (m.pinLocked ? ui.badge('locked', 'danger') : m.hasPin ? 'set' : '—') },
            ],
            rows: u.memberships,
          }) : null,
          h('div', { class: 'hq-pill-list' },
            action('Unlock', 'unlock', { needReason: false }),
            action('Sign out everywhere', 'revoke-sessions', { confirm: `${u.name} is signed out of every device now.` }),
            action('Force password reset', 'force-reset', { variant: 'danger', confirm: `${u.name}'s password is cleared, they are signed out everywhere, and they get an email to set a new one (link works 24 hours).` })),
          !isAdmin ? h('p', { class: 'muted hq-small' }, 'HQ admins take these actions.') : self ? h('p', { class: 'muted hq-small' }, 'For your own account use the app\'s account page.') : null),
      });
    }

    loader(ui, tableHost, async () => { rows = (await get('/api/hq/users')).data; draw(); });
    return () => {};
  },
};
