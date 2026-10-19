// Talking to the API and remembering who is signed in on this device.
//
// On the web the session token never reaches page JavaScript: the browser keeps the httpOnly
// ft_session cookie (and ft_device for a shared iPad). localStorage holds only what an offline start
// needs and non-secret flags: which company database to open (two UUIDs), demo mode, the
// shared-device marker, units and theme. No tokens, names, emails or customer data.
//
// The iOS app runs at capacitor://localhost, another origin, so the API's cookies can't work there.
// It calls FISHTAPE_API_BASE (set by config.js, which mobile/scripts/copy-web.mjs writes), asks for a
// bearer token where a session starts (mode: 'bearer'), keeps that token and the shared-iPad device
// token in the iOS Keychain (lib/native.js), and sends them as Authorization and X-Fishtape-Device.
import { getUnits, hasUnitsChoice, setUnits } from './lib/units.js';
import { isNativeApp, getSecret, setSecret, removeSecret } from './lib/native.js';

const K = {
  mode: 'ft.mode',            // 'demo' while the local-only demo is in use
  pointer: 'ft.session',      // { u: userId, t: tenantId } of the last synced company
  device: 'ft.device',        // { id, name, tenantId } when this is a registered shared iPad
  prefsSynced: 'ft.prefs.synced', // { u, units, theme }: the last prefs agreed with the server
  theme: 'kc.theme',
};

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Same origin by default (nginx proxies /api/). The iOS app's config.js sets FISHTAPE_API_BASE. */
export const API_BASE = String(globalThis.FISHTAPE_API_BASE || '').replace(/\/$/, '');

/** Errors that mean the API could not be reached (rather than a refusal). */
export const isUnreachable = (e) => ['offline', 'no_api', 'unavailable'].includes(e?.code) || e?.status === 0 || e?.status >= 500;

// ---- iOS app: bearer tokens from the Keychain ------------------------------------

/** Calls that start a session. In the app they ask for a bearer token instead of a cookie. */
const SESSION_STARTS = new Set(['/api/v1/auth/login', '/api/v1/auth/signup', '/api/v1/devices/crew/sign-in']);
/** Tokens read from the Keychain once per run (undefined: not read yet). */
const tokens = { session: undefined, device: undefined };

async function nativeToken(kind) {
  if (tokens[kind] === undefined) {
    try { tokens[kind] = await getSecret(kind); } catch { tokens[kind] = null; }
  }
  return tokens[kind];
}

async function keepToken(kind, value) {
  tokens[kind] = value || null;
  try {
    if (value) await setSecret(kind, value); else await removeSecret(kind);
  } catch (e) { console.warn(`Couldn't update the ${kind} token in the Keychain`, e); }
}

/**
 * fetch() options that carry the credentials: the cookie on the web (`webCredentials`), the Keychain
 * tokens in the iOS app. `newSession` leaves the old session token out (signing in again).
 */
export async function authInit(headers = {}, { webCredentials = 'include', newSession = false } = {}) {
  if (!isNativeApp()) return { headers, credentials: webCredentials };
  const [s, d] = await Promise.all([newSession ? null : nativeToken('session'), nativeToken('device')]);
  return {
    headers: { ...headers, ...(s ? { Authorization: `Bearer ${s}` } : {}), ...(d ? { 'X-Fishtape-Device': d } : {}) },
    credentials: 'omit',
  };
}

/**
 * fetch() for an API path ('/api/v1/...'). Every API call in the PWA goes through here (request()
 * below, and the billing, integrations and assistant helpers that need the raw Response): same
 * origin with the session cookie on the web; FISHTAPE_API_BASE with the Keychain tokens and no
 * cookies in the iOS app. `init` is fetch()'s; its `credentials` is the web setting.
 */
export async function apiFetch(path, init = {}) {
  const { newSession = false, ...rest } = init;
  const { headers, credentials } = await authInit(init.headers || {}, { webCredentials: init.credentials || 'include', newSession });
  return fetch(API_BASE + path, { ...rest, headers, credentials });
}

/**
 * One API call. JSON in and out; state-changing calls send X-Fishtape: 1 (the CSRF guard).
 * Throws ApiError with the server's { code, message } on errors, code 'offline' when the
 * network fails and 'no_api' when something other than the API answered (a static server).
 */
export async function request(method, path, body) {
  const nativeApp = isNativeApp();
  const startsSession = nativeApp && method === 'POST' && SESSION_STARTS.has(path);
  if (startsSession) body = { ...(body || {}), mode: 'bearer' };
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Fishtape'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await apiFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include', cache: 'no-store', newSession: startsSession });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach the server. Check your connection.");
  }
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new ApiError(res.status, res.status >= 500 ? 'unavailable' : 'no_api', "The server isn't answering right now.");
  }
  let json = null;
  try { json = await res.json(); } catch { throw new ApiError(res.status, 'unavailable', 'The server sent an unreadable answer.'); }
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong.', e.details);
  }
  if (nativeApp) {
    if (startsSession && typeof json?.token === 'string') await keepToken('session', json.token);
    if (method === 'POST' && path === '/api/v1/devices' && typeof json?.deviceToken === 'string') await keepToken('device', json.deviceToken);
  }
  return json;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

export const session = {
  /** The last /me body (live, or cached for an offline start). */
  me: null,
  /** True when this run talked to the server; false in offline mode. */
  online: false,

  isDemo() { try { return localStorage.getItem(K.mode) === 'demo'; } catch { return false; } },
  setDemo(on) { try { if (on) localStorage.setItem(K.mode, 'demo'); else localStorage.removeItem(K.mode); } catch { /* ignore */ } },

  /** Which company database this device last used: { userId, tenantId } or null. */
  pointer() {
    const p = read(K.pointer);
    return p?.u && p?.t ? { userId: p.u, tenantId: p.t } : null;
  },
  remember(me) { if (me?.user?.id && me?.tenant?.id) write(K.pointer, { u: me.user.id, t: me.tenant.id }); },
  forget() { write(K.pointer, null); },

  /** Registered shared iPad: { id, name, tenantId } or null. The device token itself is an httpOnly cookie. */
  device() { const d = read(K.device); return d?.id ? d : null; },
  setDevice(d) {
    write(K.device, d ? { id: d.id, name: d.name, tenantId: d.tenantId } : null);
    if (!d && isNativeApp()) keepToken('device', null); // the iOS app's copy of the device token
  },

  /**
   * Ask the server who we are.
   * @returns {Promise<{ state: 'signed-in', me: object } | { state: 'signed-out', error: ApiError } | { state: 'offline', error: ApiError }>}
   */
  async load() {
    try {
      const me = await api.get('/api/v1/me');
      this.me = me;
      this.online = true;
      return { state: 'signed-in', me };
    } catch (e) {
      if (isUnreachable(e) || e.status === 429) return { state: 'offline', error: e };
      return { state: 'signed-out', error: e };
    }
  },

  login(email, password) { return api.post('/api/v1/auth/login', { email, password }); },
  async logout() {
    try { await api.post('/api/v1/auth/logout'); } catch { /* signed out anyway */ }
    if (isNativeApp()) await keepToken('session', null);
  },
  async providers() {
    const p = await api.get('/api/v1/auth/providers');
    // Google and Microsoft sign-in is a cookie-and-redirect flow the iOS app can't finish yet.
    return isNativeApp() && p ? { ...p, google: false, microsoft: false } : p;
  },
};

// ---- preferences that follow the person (units, theme) ----------------------

const PREF_KEYS = ['units', 'theme'];

function localPrefs() {
  let theme = 'system';
  try { theme = localStorage.getItem(K.theme) || 'system'; } catch { /* ignore */ }
  return { units: hasUnitsChoice() ? getUnits() : null, theme };
}

function applyLocal(key, value) {
  if (key === 'units') setUnits(value);
  if (key === 'theme') {
    try { if (value === 'system') localStorage.removeItem(K.theme); else localStorage.setItem(K.theme, value); } catch { /* ignore */ }
    if (typeof document !== 'undefined') {
      if (value === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value;
    }
  }
}

/**
 * Decide which side changed since the last agreement. Pure, for tests.
 * @returns {{ push: object, pull: object, agreed: object }}
 */
export function reconcilePrefs({ local, server = {}, synced = null }) {
  const push = {}, pull = {}, agreed = {};
  for (const k of PREF_KEYS) {
    const l = local[k] ?? null, s = server[k] ?? null;
    if (synced && Object.hasOwn(synced, k) && l != null && l !== synced[k]) push[k] = l; // changed here (Settings, the units prompt)
    else if (s != null && s !== l) pull[k] = s;                                        // changed on another device, or first start here
    else if (s == null && l != null) push[k] = l;                                       // the profile has none yet
    agreed[k] = push[k] ?? pull[k] ?? l ?? s;
  }
  return { push, pull, agreed };
}

/**
 * Bring units and theme in line with the profile: local changes go up (PATCH /me/prefs),
 * profile changes come down. localStorage stays the offline cache.
 * @returns {Promise<string[]>} keys that changed on this device
 */
export async function syncPrefs(me, { online = true } = {}) {
  if (!me?.user?.id) return [];
  const marker = read(K.prefsSynced);
  const synced = marker?.u === me.user.id ? marker : null;
  const { push, pull, agreed } = reconcilePrefs({ local: localPrefs(), server: me.prefs || {}, synced });
  for (const [k, v] of Object.entries(pull)) applyLocal(k, v);
  let saved = agreed;
  if (online && Object.keys(push).length) {
    try {
      const r = await api.patch('/api/v1/me/prefs', push);
      me.prefs = r.prefs;
    } catch {
      saved = { ...agreed, ...Object.fromEntries(Object.keys(push).map((k) => [k, synced?.[k] ?? null])) }; // try again next time
    }
  }
  write(K.prefsSynced, { u: me.user.id, ...saved });
  return Object.keys(pull);
}

/** Save one preference now (Account page). */
export async function savePref(me, key, value) {
  applyLocal(key, value);
  return syncPrefs(me, { online: true });
}
