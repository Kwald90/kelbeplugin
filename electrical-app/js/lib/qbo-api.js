// The QuickBooks routes of the Fishtape API (docs/integrations/quickbooks.md section 7), one
// function per route, over session.js request() (cookie on the web, Keychain bearer token in the
// iOS app, X-Fishtape on writes). Every QuickBooks call in the PWA goes through here, so the
// screens never build a QuickBooks URL themselves.
//
// Nothing is cached or stored here: the screens keep what they show in memory only (8.7).
// Customer names typed into a look-up go in POST bodies, never in a URL (7.8, TM-LEAK-05).
// Errors are session.js ApiError: { status, code, message, details } ('offline' when the network
// fails). Codes from section 7.1: mfa_required, feature_not_in_plan, qbo_unavailable,
// qbo_not_connected, qbo_reconnect_needed, qbo_not_ready, qbo_throttled (details.retryAfterS),
// lookup_budget, qbo_busy, qbo_pause_locked, qbo_brake_count, setup_incomplete...
import { request } from '../session.js';

const BASE = '/api/v1/qbo';
const enc = encodeURIComponent;

/** '?a=1&b=2' from an object, leaving out empty values; '' when nothing is left. */
export function query(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Collections that have QuickBooks links (contract 5.2). */
export const QBO_COLLECTIONS = ['clients', 'jobs', 'items', 'vendors', 'estimates', 'invoices', 'payments', 'bills', 'purchaseOrders', 'timeEntries'];

const rec = (collection, id) => {
  if (!QBO_COLLECTIONS.includes(collection)) throw new Error(`Not a QuickBooks collection: ${collection}`);
  return `${BASE}/records/${enc(collection)}/${enc(id)}`;
};

/** QuickBooks ids are digits only (7.8); anything else never reaches a URL. */
const qboIdOf = (id) => {
  const s = String(id ?? '');
  if (!/^\d{1,20}$/.test(s)) throw new Error('Not a QuickBooks id');
  return s;
};

const LOOKUP_ENTITIES = { customers: 'customer', invoices: 'invoice', estimates: 'estimate' };

/**
 * Routes answered with a bare 202 (7.5 record sync, 7.6 reference refresh): request() wants JSON
 * and calls any other answer 'no_api', so an empty 202 is read here as { queued: true }.
 */
export const accepted = (p) => p.catch((e) => {
  if (e?.status === 202 && e.code === 'no_api') return { queued: true };
  throw e;
});

export const qboApi = {
  // ---- 7.2 connection ------------------------------------------------------------------
  status: () => request('GET', `${BASE}/status`),
  /** { url } of the interstitial (2.2). returnTo: 'web' in a browser, 'app' in the iOS app. */
  connect: ({ returnTo = 'web', reconnect = false } = {}) => request('POST', `${BASE}/connect`, { returnTo, ...(reconnect ? { reconnect: true } : {}) }),
  takeover: () => request('POST', `${BASE}/connect/takeover`, { confirm: true }),
  disconnect: ({ purge = false } = {}) => request('POST', `${BASE}/disconnect`, { purge: Boolean(purge) }),
  /** Pause or resume. Resuming from the safety brake needs allowCount (5.8). */
  pause: (paused, { allowCount } = {}) => request('POST', `${BASE}/pause`, { paused: Boolean(paused), ...(allowCount != null ? { allowCount } : {}) }),

  // ---- 7.4 setup wizard ------------------------------------------------------------------
  scan: () => request('POST', `${BASE}/setup/scan`),
  matches: ({ kind, status, choice, q, cursor, limit } = {}) => request('GET', `${BASE}/setup/matches${query({ kind, status, choice, q, cursor, limit })}`),
  /** choices: [{ id, choice, qboId?, fishtapeId?, fieldChoices?, confirmed? }] (max 500). */
  setChoices: (choices) => request('PUT', `${BASE}/setup/matches`, { choices }),
  /** bulk: { kind, status, choice } or { kind, fieldsFrom: 'fishtape'|'quickbooks' }. */
  bulkChoices: (bulk) => request('PUT', `${BASE}/setup/matches`, { bulk }),
  plan: () => request('GET', `${BASE}/setup/plan`),
  apply: ({ raiseNumbers = false } = {}) => request('POST', `${BASE}/setup/apply`, raiseNumbers ? { raiseNumbers: true } : {}),
  cancelSetup: () => request('POST', `${BASE}/setup/cancel`),

  // ---- 7.5 sync, records and log ---------------------------------------------------------
  sync: (direction = 'both') => request('POST', `${BASE}/sync`, { direction }),
  /** { data: { recordId: RecordState } }; ids omitted = every link of the collection. */
  recordsStatus: (collection, ids) => request('GET', `${BASE}/records/status${query({ collection, ids: ids ? ids.slice(0, 200) : undefined })}`),
  record: (collection, id, { live = false } = {}) => request('GET', `${rec(collection, id)}${live ? '?live=1' : ''}`),
  /** Retry (no options), "Send to QuickBooks now" ({ force: true }) or "Send to QuickBooks as new" ({ asNew: true }). */
  pushRecord: (collection, id, { force = false, asNew = false } = {}) => accepted(request('POST', `${rec(collection, id)}/sync`, { ...(force ? { force: true } : {}), ...(asNew ? { asNew: true } : {}) })),
  renumber: (collection, id) => request('POST', `${rec(collection, id)}/renumber`),
  link: (collection, id, qboId) => request('PUT', `${rec(collection, id)}/link`, { qboId: qboIdOf(qboId) }),
  unlink: (collection, id) => request('DELETE', `${rec(collection, id)}/link`),
  checks: ({ cursor, limit } = {}) => request('GET', `${BASE}/checks${query({ cursor, limit })}`),
  log: ({ cursor, limit, outcome, collection, recordId } = {}) => request('GET', `${BASE}/log${query({ cursor, limit, outcome, collection, recordId })}`),

  // ---- 7.6 mappings ----------------------------------------------------------------------
  mappings: () => request('GET', `${BASE}/mappings`),
  /** set: [{ kind, key, value }], remove: [{ kind, key }]. Answers like mappings(). */
  saveMappings: ({ set = [], remove = [] } = {}) => request('PUT', `${BASE}/mappings`, { set, remove }),
  refreshReference: () => accepted(request('POST', `${BASE}/reference/refresh`)),

  // ---- 7.7 conflicts ---------------------------------------------------------------------
  conflicts: ({ status = 'open', cursor, limit } = {}) => request('GET', `${BASE}/conflicts${query({ status, cursor, limit })}`),
  conflict: (id) => request('GET', `${BASE}/conflicts/${enc(id)}`),
  resolve: (id, { choice, fields, recordId } = {}) => request('POST', `${BASE}/conflicts/${enc(id)}/resolve`, { choice, ...(fields ? { fields } : {}), ...(recordId ? { recordId } : {}) }),

  // ---- 7.8 look-up -----------------------------------------------------------------------
  /** entity: customers | invoices | estimates. The search terms go in the body. */
  lookup: (entity, body) => {
    if (!LOOKUP_ENTITIES[entity]) throw new Error(`Unknown look-up: ${entity}`);
    return request('POST', `${BASE}/lookup/${entity}`, body);
  },
  lookupOne: (entity, qboId) => request('GET', `${BASE}/lookup/${LOOKUP_ENTITIES[entity] || entity}/${qboIdOf(qboId)}`),
  importOne: (entity, qboId) => request('POST', `${BASE}/lookup/${LOOKUP_ENTITIES[entity] || entity}/${qboIdOf(qboId)}/import`),
};

export default qboApi;
