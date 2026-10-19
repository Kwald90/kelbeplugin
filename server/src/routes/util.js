// Small helpers shared by route modules.
import { requestFacts } from '../services/audit.js';
import { SESSION_COOKIE, cookieOptions } from '../auth/sessions.js';

/** Actor + request facts for audit events. */
export function who(req, fallbackActor = { type: 'system', id: null }) {
  return { actor: req.principal?.actor || fallbackActor, request: requestFacts(req) };
}

/** The tenant context for withTenant from a principal. */
export function tenantCtx(p) {
  return { tenantId: p.tenantId, userId: p.userId || null };
}

export function setSessionCookie(reply, config, token, ttlS) {
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(config, ttlS));
}

export function clearSessionCookie(reply, config) {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config, 0));
}

/** Per-route rate limit for authentication endpoints (per client IP). */
export function authLimit(config, max = config.rateLimit.authPerMinute) {
  return config.rateLimit.enabled ? { max, timeWindow: '1 minute', keyGenerator: (req) => `auth:${req.routeOptions.url}:${req.ip}` } : false;
}

export const errorResponses = {
  400: { $ref: 'error#' }, 401: { $ref: 'error#' }, 403: { $ref: 'error#' }, 404: { $ref: 'error#' }, 409: { $ref: 'error#' }, 429: { $ref: 'error#' },
};
