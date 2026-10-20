// Who may use the QuickBooks routes (docs/integrations/quickbooks.md 7.1). Office roles only:
// owner, admin and office sessions. Field roles, crew (PIN) sessions and API keys get 403 from
// every QuickBooks route. Every route that changes anything also needs a session that passed
// two-step sign-in, whatever the role (open question 13.1, default).
import { ApiError, forbidden } from '../errors.js';

export const QBO_ROLES = ['owner', 'admin', 'office'];
export const QBO_ADMIN_ROLES = ['owner', 'admin'];

/** The system actor the sync writes as (loop prevention keys on type 'system' and id 'qbo', 5.2). */
export const QBO_ACTOR = Object.freeze({ type: 'system', id: 'qbo', label: 'QuickBooks sync' });

/** An office session (not crew, not an API key, not an agent or system principal). */
export function canUseQbo(principal) {
  return Boolean(principal && principal.kind === 'session' && !principal.crew && QBO_ROLES.includes(principal.role));
}

/**
 * Fastify preHandler. Use with `config: { auth: 'manager', apiKey: false }` (office level) or
 * `config: { auth: 'admin', apiKey: false }` (admin level): `manager` alone would let foremen in.
 * @param {'office'|'admin'} level
 * @param {{ write?: boolean }} [opts] write: the session must have passed two-step sign-in
 */
export function requireQboRole(level, { write = false } = {}) {
  if (level !== 'office' && level !== 'admin') throw new Error(`requireQboRole: unknown level ${level}`);
  const roles = level === 'admin' ? QBO_ADMIN_ROLES : QBO_ROLES;
  return async function qboRoleGuard(req) {
    const p = req.principal;
    if (!canUseQbo(p) || !roles.includes(p.role)) {
      throw forbidden(level === 'admin' ? 'Only an owner or admin can do this.' : 'QuickBooks is for office users only.');
    }
    if (write && !req.auth?.session?.mfa_verified_at) {
      throw new ApiError(403, 'mfa_required', 'Turn on two-step sign-in to change QuickBooks data.', { mfa: 'enrol', link: '#/account' });
    }
  };
}
