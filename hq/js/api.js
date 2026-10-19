// HQ API client: same origin, the ft_session cookie, X-Fishtape on writes (CSRF guard).
// Names, emails and search terms always go in bodies, never in URLs.

export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = error?.code || (status === 0 ? 'offline' : 'error');
    this.details = error?.details;
  }
}

const listeners = new Set();
/** Called with the error when a request finds the session gone or needing MFA. */
export function onAuthProblem(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const AUTH_CODES = new Set(['unauthenticated', 'session_expired', 'session_revoked', 'mfa_required', 'mfa_enrolment_required']);

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, quiet?: boolean }} [o] quiet: do not raise auth events (the sign-in flow)
 */
export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-Fishtape'] = '1';
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, { code: 'offline', message: 'Cannot reach the Fishtape API. Check your connection.' });
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error);
    if (!quiet && AUTH_CODES.has(err.code)) for (const fn of listeners) fn(err);
    throw err;
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });
