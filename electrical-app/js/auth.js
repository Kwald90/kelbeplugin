// Roles and permissions.
//
// Signed in (synced mode): the role and permission keys come from the server (/api/v1/me,
// the membership role; crew PIN sessions are capped at foreman). The server enforces them on
// every call; the PWA only uses them to show and hide screens.
// Demo mode: one device shared by a crew picks the current person from Employees (with an
// optional PIN). That is access control for a trusted device, not security.
import { store } from './store.js';

export const PERMS = [
  'dashboard', 'clients', 'leads', 'sequences', 'jobs', 'schedule', 'drawings', 'estimates', 'invoices',
  'inventory', 'employees', 'time', 'time-approve', 'sops', 'compliance', 'security', 'calcs', 'panels', 'settings',
  'safety',
];

export const ROLES = {
  owner: { label: 'Owner', perms: PERMS },
  admin: { label: 'Admin', perms: PERMS },
  office: { label: 'Office', perms: PERMS.filter((p) => !['security', 'settings'].includes(p)) },
  foreman: { label: 'Foreman', perms: ['dashboard', 'jobs', 'schedule', 'drawings', 'inventory', 'time', 'time-approve', 'sops', 'compliance', 'calcs', 'panels', 'safety'] },
  electrician: { label: 'Electrician', perms: ['dashboard', 'jobs', 'drawings', 'time', 'sops', 'calcs', 'panels', 'compliance', 'safety'] },
  apprentice: { label: 'Apprentice', perms: ['dashboard', 'jobs', 'drawings', 'time', 'sops', 'calcs', 'safety'] },
};

const MANAGER_ROLES = ['owner', 'admin', 'office', 'foreman'];
const KEY = 'kc.currentUser';
const COLORS = ['#8a5a00', '#1d7044', '#1f5fb8', '#7a3fb0', '#b42318', '#5f5a51'];

/** The signed-in account in synced mode, from /me; null in demo mode. */
let account = null;

function colorFor(id = '') {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export const auth = {
  /** Use the server's view of who is signed in (synced mode). Pass null for demo mode. */
  setAccount(me) {
    if (!me?.tenant) { account = null; return; }
    account = {
      userId: me.user.id,
      name: me.user.displayName || 'Me',
      role: me.tenant.role,
      perms: new Set(me.tenant.perms || []),
      employeeId: me.tenant.employeeId || null,
      membershipId: me.tenant.membershipId || null,
      crew: me.session?.kind === 'crew',
      tenantId: me.tenant.id,
      tenantName: me.tenant.name,
    };
    store.setActor(account.employeeId || account.userId);
  },
  get account() { return account ? { ...account, perms: [...account.perms] } : null; },
  get synced() { return Boolean(account); },
  isCrew() { return Boolean(account?.crew); },

  /** The current person as an employees-shaped record ({ id, name, role, color }). */
  current() {
    if (account) {
      const e = account.employeeId ? store.get('employees', account.employeeId) : null;
      // The id stays the linked employee record (time clock, SOP acks); the role is the membership's.
      return { ...(e || {}), id: account.employeeId, name: e?.name || account.name, role: account.role, color: e?.color || colorFor(account.userId) };
    }
    let id = null;
    try { id = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    const u = id && store.get('employees', id);
    if (u && u.active !== false) return u;
    // fall back to the first owner/admin, so a fresh install is usable
    return store.list('employees', (e) => e.active !== false && (e.role === 'owner' || e.role === 'admin'))[0]
      || { id: null, name: 'Owner', role: 'owner', color: '#8a5a00' };
  },

  /** Demo mode only: pick who is using the device. */
  signIn(employeeId, pin) {
    if (account) return false;
    const e = store.get('employees', employeeId);
    if (!e) return false;
    if (e.pin && String(e.pin) !== String(pin ?? '')) { store.log('sign-in-failed', `Wrong PIN for ${e.name}`, 'employees', e.id); return false; }
    try { localStorage.setItem(KEY, employeeId); } catch { /* ignore */ }
    store.setActor(employeeId);
    store.log('sign-in', `${e.name} signed in`, 'employees', e.id);
    return true;
  },
  role() { return this.current().role || 'apprentice'; },
  can(perm) {
    if (!perm) return true;
    if (account) return account.perms.has(perm);
    return (ROLES[this.role()]?.perms || []).includes(perm);
  },
  isManager() { return MANAGER_ROLES.includes(this.role()); },
  isAdmin() { return ['owner', 'admin'].includes(this.role()); },
};
