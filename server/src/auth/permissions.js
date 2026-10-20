// Roles and permission keys. This is the server copy of the map in
// electrical-app/js/auth.js; test/unit.test.js fails if the two drift apart.
// The server is the authority: the PWA only uses its copy to hide screens.

/** Permission keys, same order as electrical-app/js/auth.js. */
export const PERMS = [
  'dashboard', 'clients', 'leads', 'sequences', 'jobs', 'schedule', 'drawings', 'estimates', 'invoices',
  'inventory', 'employees', 'time', 'time-approve', 'sops', 'compliance', 'security', 'calcs', 'panels', 'settings',
  'safety',
];

/** @type {Record<string, { label: string, perms: string[] }>} */
export const ROLES = {
  owner: { label: 'Owner', perms: PERMS },
  admin: { label: 'Admin', perms: PERMS },
  office: { label: 'Office', perms: PERMS.filter((p) => !['security', 'settings'].includes(p)) },
  foreman: { label: 'Foreman', perms: ['dashboard', 'jobs', 'schedule', 'drawings', 'inventory', 'time', 'time-approve', 'sops', 'compliance', 'calcs', 'panels', 'safety'] },
  electrician: { label: 'Electrician', perms: ['dashboard', 'jobs', 'drawings', 'time', 'sops', 'calcs', 'panels', 'compliance', 'safety'] },
  apprentice: { label: 'Apprentice', perms: ['dashboard', 'jobs', 'drawings', 'time', 'sops', 'calcs', 'safety'] },
};

export const ROLE_NAMES = Object.keys(ROLES);

/** Same list as auth.isManager() in the PWA. */
export const MANAGER_ROLES = ['owner', 'admin', 'office', 'foreman'];

/** Roles that must have TOTP MFA before using the API (plus HQ staff). */
export const MFA_ROLES = ['owner', 'admin'];

/** Roles allowed to manage members, API keys and tenant secrets. */
export const ADMIN_ROLES = ['owner', 'admin'];

/**
 * A crew (PIN) session on a shared device is capped at foreman: a PIN is not
 * MFA, so owner/admin powers need a full sign-in.
 */
export const CREW_ROLE_CAP = 'foreman';

export function permsForRole(role) {
  return new Set(ROLES[role]?.perms || []);
}

export function isManagerRole(role) {
  return MANAGER_ROLES.includes(role);
}

/** Cap a role for crew sessions: owner/admin become foreman, others keep theirs. */
export function capCrewRole(role) {
  return ADMIN_ROLES.includes(role) ? CREW_ROLE_CAP : role;
}
