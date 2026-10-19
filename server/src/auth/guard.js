// Authentication and authorisation for every request (one onRequest hook).
//
// Each route declares config.auth:
//   public   no credentials needed (credentials are still read when present)
//   session  any live session, even one still waiting for MFA (logout, me, MFA routes)
//   user     a session that has passed MFA (switch tenant, password change, new tenant)
//   tenant   a session with an active tenant membership, or an API key (data routes)
//   manager  tenant session (not API key, not crew) with owner/admin/office/foreman
//   admin    tenant session (not API key, not crew) with owner/admin
//   device   a registered shared device token (crew list and PIN sign-in)
//   hq       HQ staff: platform role + TOTP verified on this session
// config.apiKey === false keeps API keys out of a tenant route.
import { ApiError, forbidden, unauthenticated } from '../errors.js';
import { ADMIN_ROLES, capCrewRole, isManagerRole, permsForRole } from './permissions.js';
import { looksLikeApiKey, lookupApiKey } from './apikeys.js';
import { lookupDevice } from './devices.js';
import { DEVICE_COOKIE, DEVICE_PREFIX, SESSION_COOKIE, lookupSession, mfaState } from './sessions.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF guard for browser (cookie) requests: state-changing requests must carry
 * `X-Fishtape: 1` (which forces a CORS preflight cross-origin) and, when the browser
 * sends an Origin, it must be one of ours. Bearer requests are exempt: browsers never
 * attach an Authorization header on their own.
 */
export function csrfGuard(req, config) {
  if (!UNSAFE.has(req.method)) return;
  if (req.headers.authorization) return;
  if (req.headers['x-fishtape'] !== '1') throw new ApiError(403, 'csrf_failed', 'Missing X-Fishtape: 1 header.');
  const origin = req.headers.origin;
  if (origin !== undefined && !config.corsOrigins.includes(origin)) throw new ApiError(403, 'csrf_failed', 'This origin may not call the API.');
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (h === undefined) return null;
  const m = /^Bearer\s+(\S{1,512})$/i.exec(String(h));
  if (!m) throw unauthenticated('Malformed Authorization header.');
  return m[1];
}

/**
 * Read whatever credentials the request carries.
 * @returns {Promise<{ via: 'cookie'|'bearer'|null, session: object|null, sessionError: string|null, apiKey: object|null, device: object|null, deviceToken: string|null }>}
 */
async function readCredentials(req, { db, config }, wantDevice) {
  const out = { via: null, session: null, sessionError: null, apiKey: null, device: null, deviceToken: null };
  const token = bearerToken(req);
  if (token) {
    out.via = 'bearer';
    if (looksLikeApiKey(token)) {
      out.apiKey = await lookupApiKey(db, config, token);
      if (!out.apiKey) throw new ApiError(401, 'invalid_api_key', 'This API key is not valid here.');
    } else if (token.startsWith(DEVICE_PREFIX)) {
      out.deviceToken = token;
    } else {
      const s = await lookupSession(db, token);
      out.session = s.row;
      out.sessionError = s.error;
    }
  } else if (req.cookies?.[SESSION_COOKIE]) {
    out.via = 'cookie';
    const s = await lookupSession(db, req.cookies[SESSION_COOKIE]);
    out.session = s.row;
    out.sessionError = s.error;
  }
  if (wantDevice) {
    out.deviceToken ??= req.headers['x-fishtape-device'] || req.cookies?.[DEVICE_COOKIE] || null;
    if (out.deviceToken) out.device = await lookupDevice(db, String(out.deviceToken));
  }
  return out;
}

function requireSession(auth) {
  if (auth.session) return auth.session;
  if (auth.sessionError === 'expired') throw new ApiError(401, 'session_expired', 'Your session has expired. Sign in again.');
  throw unauthenticated();
}

function requireMfa(row) {
  const state = mfaState(row);
  if (state === 'verify') throw new ApiError(403, 'mfa_required', 'Enter the code from your authenticator app.', { mfa: 'verify' });
  if (state === 'enrol') throw new ApiError(403, 'mfa_enrolment_required', 'Set up two-step sign-in before continuing.', { mfa: 'enrol' });
}

export function sessionPrincipal(row) {
  const role = row.kind === 'crew' ? capCrewRole(row.role) : row.role;
  return {
    kind: 'session',
    tenantId: row.tenant_id,
    userId: row.user_id,
    sessionId: row.session_id,
    role,
    perms: permsForRole(role),
    isManager: isManagerRole(role),
    employeeId: row.employee_id || null,
    scopes: null,
    crew: row.kind === 'crew',
    actor: { type: 'user', id: row.user_id, label: row.display_name },
  };
}

export function apiKeyPrincipal(k) {
  return {
    kind: 'api_key',
    tenantId: k.tenant_id,
    userId: null,
    apiKeyId: k.id,
    role: null,
    perms: new Set(),
    isManager: false,
    employeeId: null,
    scopes: k.scopes,
    crew: false,
    actor: { type: 'api_key', id: k.id, label: k.name },
  };
}

function tenantPrincipal(auth, cfg) {
  if (auth.apiKey) {
    if (cfg.apiKey === false) throw forbidden('API keys cannot use this endpoint.');
    return apiKeyPrincipal(auth.apiKey);
  }
  const row = requireSession(auth);
  requireMfa(row);
  if (!row.tenant_id) throw new ApiError(403, 'no_tenant', 'Pick a company first.');
  if (row.tenant_status !== 'active') throw new ApiError(403, 'tenant_inactive', 'This company account is not active.');
  if (!row.membership_id || row.membership_status !== 'active') throw new ApiError(403, 'membership_inactive', 'You are not an active member of this company.');
  return sessionPrincipal(row);
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: import('../db.js').Db, config: import('../config.js').Config }} deps
 */
export function installAuth(app, deps) {
  app.decorateRequest('auth', null);
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    const cfg = req.routeOptions?.config || {};
    const mode = cfg.auth || 'public';
    csrfGuard(req, deps.config);
    req.auth = await readCredentials(req, deps, mode === 'device');
    req.principal = authorize(req.auth, mode, cfg);
  });
}

function authorize(auth, mode, cfg) {
  switch (mode) {
    case 'public':
      return null;
    case 'session':
      requireSession(auth);
      return null;
    case 'user': {
      const row = requireSession(auth);
      requireMfa(row);
      if (row.kind === 'crew') throw forbidden('Crew sessions cannot do this.');
      return null;
    }
    case 'tenant':
      return tenantPrincipal(auth, cfg);
    case 'manager':
    case 'admin': {
      if (auth.apiKey) throw forbidden('API keys cannot use this endpoint.');
      const p = tenantPrincipal(auth, cfg);
      if (p.crew) throw forbidden('Crew sessions cannot do this.');
      if (mode === 'admin' ? !ADMIN_ROLES.includes(p.role) : !p.isManager) throw forbidden();
      return p;
    }
    case 'device':
      if (!auth.device) throw new ApiError(401, 'invalid_device', 'This device is not registered or was revoked.');
      return null;
    case 'hq': {
      const row = requireSession(auth);
      requireMfa(row);
      if (!row.platform_role || !row.mfa_enrolled || row.kind === 'crew') throw forbidden('HQ staff only.');
      return { kind: 'hq', userId: row.user_id, platformRole: row.platform_role, actor: { type: 'hq', id: row.user_id, label: row.display_name } };
    }
    default:
      throw new Error(`unknown auth mode ${mode}`);
  }
}
