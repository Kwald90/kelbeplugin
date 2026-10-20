// /api/v1/me: who is signed in, their companies, the active company's role, permissions
// and plan entitlements, and their own preferences. PATCH /api/v1/me/prefs saves the
// preferences that follow a person across devices (units, theme, drawing-canvas finger gestures).
//
// Nothing here is secret: no tokens, hashes (only whether a password is set), MFA secrets or
// recovery codes, and only the caller's own user and memberships. Every /api response is
// Cache-Control: no-store.
import { ApiError } from '../../errors.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { userMemberships } from '../../services/tenants.js';
import { loadTenantPlan, tenantEntitlements } from '../../services/entitlements.js';
import { capCrewRole, permsForRole } from '../../auth/permissions.js';
import { mfaState } from '../../auth/sessions.js';

/** What a finger gesture on the drawing canvas can do (electrical-app/js/canvas/gestures.js). */
const GESTURE_ACTIONS = ['undo', 'redo', 'wheel', 'lastTool', 'fit', 'none'];

/** Preference keys and the values each may take. Anything else is dropped. */
export const PREFS = {
  units: ['metric', 'imperial'],
  theme: ['light', 'dark', 'system'],
  twoFingerTap: GESTURE_ACTIONS,
  threeFingerTap: GESTURE_ACTIONS,
  longPress: GESTURE_ACTIONS,
};

/** Keep only known keys with allowed values. */
export function cleanPrefs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, allowed] of Object.entries(PREFS)) if (allowed.includes(raw[k])) out[k] = raw[k];
  return out;
}

/**
 * The /me body for a session row from lookupSession().
 * @param {import('../../db.js').Db} db
 */
export async function meBody(db, row) {
  const role = row.membership_status === 'active' ? (row.kind === 'crew' ? capCrewRole(row.role) : row.role) : null;
  const state = mfaState(row);
  const hasTenant = Boolean(row.tenant_id && role);
  const [memberships, prefsRow, plan] = await Promise.all([
    userMemberships(db, row.user_id),
    db.query('SELECT prefs, password_hash IS NOT NULL AS has_password FROM users WHERE id = $1', [row.user_id]),
    // Entitlements only once MFA is satisfied: before that the session can do nothing with them.
    hasTenant && state === 'ok' ? loadTenantPlan(db, row.tenant_id) : null,
  ]);
  return {
    // hasPassword: false for a Google/Microsoft-only account (or one HQ cleared). The Account page
    // then offers an emailed link to set one instead of a "change password" form that can't work.
    user: { id: row.user_id, email: row.email, displayName: row.display_name, platformRole: row.platform_role || null, hasPassword: Boolean(prefsRow.rows[0]?.has_password) },
    session: { kind: row.kind, expiresAt: row.expires_at, mfa: state === 'ok' ? null : state, mfaEnrolled: Boolean(row.mfa_enrolled) },
    tenant: hasTenant ? {
      id: row.tenant_id, name: row.tenant_name, status: row.tenant_status, role, employeeId: row.employee_id || null,
      membershipId: row.membership_id, perms: [...permsForRole(role)],
      // where the company was registered: seeds a new device's settings (store.open defaults)
      province: plan?.province || null,
    } : null,
    memberships: memberships.map((m) => ({ tenantId: m.tenant_id, tenantName: m.tenant_name, role: m.role, status: m.status, tenantStatus: m.tenant_status })),
    entitlements: plan ? tenantEntitlements(plan) : null,
    prefs: cleanPrefs(prefsRow.rows[0]?.prefs),
  };
}

const prefsBody = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: Object.fromEntries(Object.entries(PREFS).map(([k, allowed]) => [k, { type: 'string', enum: allowed }])),
};

/** @param {import('fastify').FastifyInstance} app */
export default async function meRoutes(app, { db }) {
  app.get('/api/v1/me', {
    config: { auth: 'session' },
    schema: {
      tags: ['auth'],
      summary: 'The signed-in user, companies, active company role and permissions, plan entitlements and preferences',
      description: 'Answers even before MFA (session.mfa says what is still needed); entitlements are null until then.',
    },
  }, async (req) => meBody(db, req.auth.session));

  app.patch('/api/v1/me/prefs', {
    config: { auth: 'session' },
    schema: { tags: ['auth'], summary: 'Save your preferences (units, theme, canvas gestures); returns all of them', body: prefsBody },
  }, async (req) => {
    const s = req.auth.session;
    const state = mfaState(s);
    if (state === 'verify') throw new ApiError(403, 'mfa_required', 'Enter the code from your authenticator app.', { mfa: 'verify' });
    if (state === 'enrol') throw new ApiError(403, 'mfa_enrolment_required', 'Set up two-step sign-in before continuing.', { mfa: 'enrol' });
    const patch = cleanPrefs(req.body);
    const { rows } = await db.query(
      'UPDATE users SET prefs = prefs || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING prefs', [s.user_id, JSON.stringify(patch)]);
    const actor = { type: 'user', id: s.user_id, label: s.display_name };
    const event = { actor, action: 'user.prefs', summary: 'Preferences updated', meta: { keys: Object.keys(patch) }, request: requestFacts(req) };
    // In the active company's chain when there is one, else the platform chain.
    if (s.tenant_id && s.membership_status === 'active') {
      await db.withTenant({ tenantId: s.tenant_id, userId: s.user_id }, (tx) => appendAudit(tx, s.tenant_id, event), { write: true });
    } else {
      await db.tx((c) => appendAudit(c, null, event));
    }
    return { prefs: cleanPrefs(rows[0]?.prefs) };
  });
}
