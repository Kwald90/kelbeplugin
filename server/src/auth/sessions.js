// Opaque session tokens. The token goes to the client once (cookie ft_session or a
// bearer token for the iOS app); only its sha-256 is stored.
import { randomToken, sha256 } from '../lib/crypto.js';

export const SESSION_COOKIE = 'ft_session';
export const DEVICE_COOKIE = 'ft_device';
export const SESSION_PREFIX = 'fts_';
export const DEVICE_PREFIX = 'ftd_';

/**
 * @param {{ query: Function }} q platform client or db
 * @param {object} o
 * @param {string} o.userId
 * @param {string|null} o.tenantId
 * @param {'web'|'bearer'|'crew'} o.kind
 * @param {string|null} [o.deviceId]
 * @param {string} o.authMethod
 * @param {boolean} [o.mfaVerified]
 * @param {number} o.ttlS
 * @param {number} o.idleS
 * @param {{ ip?: string, userAgent?: string }} [o.request]
 */
export async function createSession(q, o) {
  const token = randomToken(SESSION_PREFIX);
  const { rows } = await q.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, kind, device_id, auth_method, mfa_verified_at, idle_timeout_s, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END, $8, now() + make_interval(secs => $9), $10, $11)
     RETURNING id, expires_at`,
    [sha256(token), o.userId, o.tenantId, o.kind, o.deviceId || null, o.authMethod, Boolean(o.mfaVerified), o.idleS, o.ttlS,
      o.request?.ip?.slice(0, 100) || null, o.request?.userAgent?.slice(0, 300) || null]);
  return { token, id: rows[0].id, expiresAt: rows[0].expires_at };
}

const SESSION_SQL = (where) => `
  SELECT s.id AS session_id, s.user_id, s.tenant_id, s.kind, s.device_id, s.auth_method, s.mfa_verified_at, s.mfa_failed,
         s.expires_at, s.revoked_at, (s.last_seen_at + make_interval(secs => s.idle_timeout_s)) AS idle_expires_at,
         s.last_seen_at < now() - interval '60 seconds' AS stale_seen,
         s.expires_at <= now() OR s.last_seen_at + make_interval(secs => s.idle_timeout_s) <= now() AS expired,
         u.email, u.display_name, u.platform_role, u.status AS user_status,
         EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa_enrolled,
         EXISTS (SELECT 1 FROM memberships m2 JOIN tenants t2 ON t2.id = m2.tenant_id
                  WHERE m2.user_id = u.id AND m2.status = 'active' AND t2.status = 'active' AND m2.role IN ('owner', 'admin')) AS mfa_role,
         m.id AS membership_id, m.role, m.employee_id, m.status AS membership_status,
         t.status AS tenant_status, t.name AS tenant_name,
         d.revoked_at AS device_revoked_at, d.tenant_id AS device_tenant_id
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
    LEFT JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN devices d ON d.id = s.device_id
   WHERE ${where}`;

/**
 * @returns {Promise<{ row: object|null, error: null|'invalid'|'expired' }>}
 */
export async function lookupSession(q, token) {
  if (typeof token !== 'string' || !token.startsWith(SESSION_PREFIX) || token.length > 200) return { row: null, error: 'invalid' };
  const { rows } = await q.query(SESSION_SQL('s.token_hash = $1'), [sha256(token)]);
  const r = rows[0];
  if (!r || r.revoked_at || r.user_status !== 'active') return { row: null, error: 'invalid' };
  if (r.kind === 'crew' && (r.device_revoked_at || r.device_tenant_id !== r.tenant_id)) return { row: null, error: 'invalid' };
  if (r.expired) return { row: null, error: 'expired' };
  if (r.stale_seen) await q.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.session_id]);
  return { row: r, error: null };
}

/** The same row as lookupSession, by session id (no expiry checks). */
export async function sessionRowById(q, id) {
  const { rows } = await q.query(SESSION_SQL('s.id = $1'), [id]);
  return rows[0] || null;
}

export function revokeSession(q, sessionId) {
  return q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

/** Revoke every session of a user, optionally keeping one. */
export function revokeUserSessions(q, userId, keepSessionId = null) {
  return q.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2',
    [userId, keepSessionId]);
}

/** MFA state of a session row from lookupSession. */
export function mfaState(row) {
  if (row.kind === 'crew') return 'ok';
  if (row.mfa_enrolled && !row.mfa_verified_at) return 'verify';
  if ((row.mfa_role || row.platform_role) && !row.mfa_enrolled) return 'enrol';
  return 'ok';
}

export function cookieOptions(config, maxAgeS, path = '/') {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path, maxAge: maxAgeS };
}
