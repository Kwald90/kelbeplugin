// Roles and permissions. One device can be shared by a crew: the current user
// is picked from Employees (with an optional 4-digit PIN). This is access
// control for a trusted device, not security against someone with dev tools;
// real auth arrives with a backend (see replica/architecture.md).
import { store } from './store.js';

export const PERMS = [
  'dashboard', 'clients', 'leads', 'sequences', 'jobs', 'schedule', 'drawings', 'estimates', 'invoices',
  'inventory', 'employees', 'time', 'time-approve', 'sops', 'compliance', 'security', 'calcs', 'panels', 'settings',
];

export const ROLES = {
  owner: { label: 'Owner', perms: PERMS },
  admin: { label: 'Admin', perms: PERMS },
  office: { label: 'Office', perms: PERMS.filter((p) => !['security', 'settings'].includes(p)) },
  foreman: { label: 'Foreman', perms: ['dashboard', 'jobs', 'schedule', 'drawings', 'inventory', 'time', 'time-approve', 'sops', 'compliance', 'calcs', 'panels'] },
  electrician: { label: 'Electrician', perms: ['dashboard', 'jobs', 'drawings', 'time', 'sops', 'calcs', 'panels', 'compliance'] },
  apprentice: { label: 'Apprentice', perms: ['dashboard', 'jobs', 'drawings', 'time', 'sops', 'calcs'] },
};

const KEY = 'kc.currentUser';

export const auth = {
  current() {
    let id = null;
    try { id = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    const u = id && store.get('employees', id);
    if (u && u.active !== false) return u;
    // fall back to the first owner/admin, so a fresh install is usable
    return store.list('employees', (e) => e.active !== false && (e.role === 'owner' || e.role === 'admin'))[0]
      || { id: null, name: 'Owner', role: 'owner', color: '#8a5a00' };
  },
  signIn(employeeId, pin) {
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
    return (ROLES[this.role()]?.perms || []).includes(perm);
  },
  isManager() { return ['owner', 'admin', 'office', 'foreman'].includes(this.role()); },
};
