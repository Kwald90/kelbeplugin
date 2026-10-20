// The QuickBooks Online HTTP client (docs/integrations/quickbooks.md 2.1, 5.8, 5.11). One client per
// tenant and purpose. Every call: QBO enabled, QBO_WRITES for Core calls, throttled_until, the
// CorePlus budgets, the per-tenant limiter, a fresh access token (one forced refresh on a 401), a
// 30 s timeout, a usage count in qbo_api_usage and a QboError whose message comes from a fixed
// table. Logs carry method, entity, status, fault code and intuit_tid only: never the URL (it holds
// the realm id), the query text or a body. Intuit's detail is scrubbed (names too) and kept on
// QboError.detail for the tenant's own sync log.
import { ProviderError, request, scrub } from '../integrations/http.js';
import { loadTenantPlan, onTrial } from '../services/entitlements.js';
import { notify } from '../services/notify.js';
import { qboCfg } from './env.js';
import { limiter as defaultLimiter } from './limiter.js';
import { platformEvent, setPaused, withAccessToken } from './connection.js';

// ---- errors -----------------------------------------------------------------------------------

/** Fixed, customer-free messages (5.8). Keyed by kind, or `kind:variant` for a more exact one. */
export const QBO_MESSAGES = {
  auth: 'QuickBooks needs to be reconnected.',
  platform: "QuickBooks refused Fishtape's app credentials. Fishtape support has been told.",
  stale: 'The QuickBooks copy changed while Fishtape was saving. Trying again.',
  duplicate_number: 'QuickBooks already has a document with this number.',
  duplicate_name: 'QuickBooks rejected a duplicate name.',
  not_found: 'QuickBooks could not find this record. It may have been deleted there.',
  validation: 'QuickBooks rejected the data.',
  'validation:amount': 'QuickBooks rejected a line amount (amount is not quantity times rate).',
  'validation:tax_override': 'QuickBooks refused the tax amounts.',
  throttled: 'QuickBooks is limiting requests. Trying again shortly.',
  unavailable: 'QuickBooks is not answering right now. Trying again later.',
  'unavailable:timeout': 'QuickBooks did not answer in time. Trying again later.',
  'unavailable:disabled': 'QuickBooks is not available on this server.',
  'unavailable:writes_off': 'Sending to QuickBooks is paused by Fishtape.',
  'unavailable:locked': 'The QuickBooks company is busy or locked. Trying again later.',
  'unavailable:breaker': 'Fishtape cannot reach QuickBooks right now. Trying again later.',
  'unavailable:not_connected': 'QuickBooks is not connected.',
  budget: "This month's QuickBooks read allowance is used up.",
  'budget:lookup': 'QuickBooks look-ups are paused for the rest of the month.',
  feature: "This isn't available on the company's QuickBooks plan.",
  closed_books: 'The books are closed in QuickBooks for this date.',
  permission: "QuickBooks says Fishtape's connection isn't allowed to do that.",
  open_balance: 'Customer has an open balance in QuickBooks.',
  other: 'QuickBooks returned an error.',
};

export function qboMessage(kind, variant = null) {
  return (variant && QBO_MESSAGES[`${kind}:${variant}`]) || QBO_MESSAGES[kind] || QBO_MESSAGES.other;
}

/**
 * A QuickBooks failure. `message` is from QBO_MESSAGES (safe anywhere: job errors, HQ, users);
 * `detail` is Intuit's text after scrub with the name-safe rule, for the tenant's own sync log and
 * link error only.
 */
export class QboError extends Error {
  /**
   * @param {'auth'|'platform'|'stale'|'duplicate_number'|'duplicate_name'|'not_found'|'validation'|'throttled'|'unavailable'|'budget'|'feature'|'closed_books'|'permission'|'open_balance'|'other'} kind
   * @param {{ faultCode?: string|null, status?: number|null, intuitTid?: string|null, retryAfterS?: number|null, retry?: boolean, detail?: string|null, variant?: string|null, outcomeUnknown?: boolean, code?: string }} [o]
   */
  constructor(kind, o = {}) {
    super(qboMessage(kind, o.variant));
    this.name = 'QboError';
    this.kind = kind;
    this.variant = o.variant ?? null;
    this.faultCode = o.faultCode ?? null;
    this.status = o.status ?? null;
    this.intuitTid = o.intuitTid ?? null;
    this.retryAfterS = o.retryAfterS ?? null;
    this.retry = o.retry ?? RETRYABLE.has(kind);
    this.detail = o.detail ?? null;
    // A write whose answer never came (timeout, network, 5xx): it may have landed (adopt-by-search, 5.3).
    this.outcomeUnknown = Boolean(o.outcomeUnknown);
    // A stable code for API answers (7.1).
    this.code = o.code || CODES[`${kind}:${this.variant}`] || CODES[kind] || 'qbo_error';
  }
}

const RETRYABLE = new Set(['stale', 'throttled', 'unavailable']);
const CODES = {
  auth: 'qbo_reconnect_needed', throttled: 'qbo_throttled', unavailable: 'qbo_unavailable', budget: 'qbo_budget',
  'budget:lookup': 'lookup_budget', 'unavailable:not_connected': 'qbo_not_connected',
};

const CLOSED_BOOKS = /clos(?:ed|ing) (?:date|period|books)|account(?:ing)? period (?:has|is) closed|books are closed/i;
const OPEN_BALANCE = /open balance|balance (?:is not|must be) zero|has a balance/i;
const AMOUNT_RULE = /amount is not equal to unitprice/i;

/**
 * Classify an Intuit answer (5.8). Pure: unit-tested over every fault code the engine handles.
 * @param {{ status?: number|null, faultCode?: string|number|null, detail?: string|null, message?: string|null }} f
 * @returns {{ kind: string, retry: boolean, variant: string|null }}
 */
export function classifyQboFault({ status = null, faultCode = null, detail = '', message = '' } = {}) {
  const code = faultCode == null ? '' : String(faultCode).replace(/^0+(?=\d)/, '');
  const text = `${message || ''} ${detail || ''}`;
  const r = (kind, variant = null, retry = RETRYABLE.has(kind)) => ({ kind, retry, variant });
  switch (code) {
    case '5010': return r('stale');
    case '6140': return r('duplicate_number');
    case '6240': return r('duplicate_name');
    case '610': return r('not_found');
    case '5020': return r('permission');
    case '5030': return r('feature');
    case '140': case '150': return r('unavailable', 'locked', true);
    case '3200': case '3100': case '3201': case '3202': return r('auth');
    default: break;
  }
  if (CLOSED_BOOKS.test(text)) return r('closed_books');
  if (OPEN_BALANCE.test(text)) return r('open_balance');
  if (status === 401) return r('auth');
  if (status === 403) return r('permission');
  if (status === 429) return r('throttled');
  if (status != null && status >= 500) return r('unavailable');
  if (code === '6000' || code === '2010' || code === '2020' || code === '2050' || code === '6190') {
    if (AMOUNT_RULE.test(text)) return r('validation', 'amount');
    if (/override|-37100/i.test(text)) return r('validation', 'tax_override');
    return r('validation');
  }
  if (status === 404) return r('not_found');
  if (status === 400) return r('validation', AMOUNT_RULE.test(text) ? 'amount' : null);
  return r('other');
}

/** Intuit's fault, in either of its spellings ({ Fault: { Error } } or { fault: { error } }). */
export function faultOf(json) {
  const f = json?.Fault || json?.fault;
  const e = (f?.Error || f?.error || [])[0];
  if (!e) return null;
  return { code: e.code ?? e.Code ?? null, message: e.Message ?? e.message ?? '', detail: e.Detail ?? e.detail ?? '', type: f.type || null };
}

// ---- budgets ----------------------------------------------------------------------------------

/**
 * The CorePlus budget rules of 5.11 for one call. Pure.
 * @param {string} purpose sync | lookup | check | scan | cdc | connect | reference
 * @param {number} tenantPct this tenant's month so far, % of its budget
 * @param {number} workspacePct every tenant's month so far, % of QBO_READ_BUDGET
 * @returns {null | { variant: string|null, pause: 'budget'|'tenant_budget'|null }}
 */
export function budgetGate(purpose, tenantPct, workspacePct) {
  if (purpose === 'connect') return null;
  if (workspacePct >= 100) return { variant: null, pause: 'budget' };
  if (tenantPct >= 150) return { variant: null, pause: 'tenant_budget' };
  if (tenantPct >= 100 && ['lookup', 'check', 'scan', 'cdc'].includes(purpose)) return { variant: purpose === 'lookup' ? 'lookup' : null, pause: null };
  if (tenantPct >= 80 && purpose === 'lookup') return { variant: 'lookup', pause: null };
  if (workspacePct >= 90 && ['lookup', 'cdc'].includes(purpose)) return { variant: purpose === 'lookup' ? 'lookup' : null, pause: null };
  return null;
}

const ALERT_PCTS = [50, 80, 100];
const monthKey = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

// Workspace CorePlus total, cached per process for a minute (a sum over every tenant's row).
const workspaceCache = { month: null, at: 0, calls: 0 };
async function workspaceCalls(db, month) {
  if (workspaceCache.month === month && Date.now() - workspaceCache.at < 60_000) return workspaceCache.calls;
  const { rows } = await db.query(
    "SELECT COALESCE(sum(coreplus_calls), 0)::bigint AS n FROM qbo_api_usage WHERE month = $1 AND environment = 'production'", [month]);
  Object.assign(workspaceCache, { month, at: Date.now(), calls: Number(rows[0].n) });
  return workspaceCache.calls;
}
/** Tests: forget the cached workspace total. */
export function resetUsageCache() { Object.assign(workspaceCache, { month: null, at: 0, calls: 0 }); }

// An Intuit 429 carrying the monthly-cap message, per environment: first seen at.
const capSeen = new Map();

// ---- the client -------------------------------------------------------------------------------

const ENTITIES = new Set(['Account', 'Attachable', 'Bill', 'BillPayment', 'Class', 'CompanyInfo', 'CreditMemo', 'Customer', 'Department',
  'Deposit', 'Employee', 'Estimate', 'Invoice', 'Item', 'JournalEntry', 'Payment', 'PaymentMethod', 'Preferences', 'Purchase',
  'PurchaseOrder', 'TaxAgency', 'TaxCode', 'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor']);
const ID = /^\d{1,20}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,50}$/;
const REALM = '{realm}';

function entityPath(entity) {
  if (!ENTITIES.has(entity)) throw new Error(`qbo: unknown entity ${entity}`);
  return entity.toLowerCase();
}

function normaliseLog(log) {
  if (!log) return () => {};
  if (typeof log === 'function') return (level, extra) => log(level, 'qbo call', extra);
  return (level, extra) => { const f = log[level] || log.info; if (typeof f === 'function') f.call(log, extra, 'qbo call'); };
}

/**
 * @param {{ db: import('../db.js').Db, sealer: object, config: object, tenantId: string,
 *   purpose?: 'sync'|'lookup'|'check'|'scan'|'cdc'|'reference'|'connect', log?: Function|object,
 *   token?: { accessToken: string, realmId: string }, limiter?: object, maxInFlight?: number }} o
 *   token: use these instead of the stored ones (the connect callback, before anything is stored).
 */
export function createQboClient(o) {
  const { db, sealer, tenantId } = o;
  const cfg = qboCfg(o.config);
  const purpose = o.purpose || 'sync';
  const emit = normaliseLog(o.log);
  const lim = o.limiter || defaultLimiter;
  // The worker holds the tenant lease (one caller); each API process may run 2 look-ups at once.
  const maxInFlight = o.maxInFlight ?? (purpose === 'lookup' ? 2 : 1);
  let plan = null;
  const client = { lastIntuitTid: null, purpose };

  async function tenantBudget() {
    plan ??= await loadTenantPlan(db, tenantId);
    return plan && onTrial(plan) ? cfg.trialReadBudget : cfg.tenantReadBudget;
  }

  /** Throttle and budget checks before a call. */
  async function gate(kind, reads) {
    const month = monthKey();
    const { row } = await db.withTenant({ tenantId }, async (tx) => ({
      row: (await tx.query(
        `SELECT c.throttled_until, c.throttled_until > now() AS throttled,
                CEIL(EXTRACT(EPOCH FROM (c.throttled_until - now())))::int AS wait_s,
                (SELECT u.coreplus_calls FROM qbo_api_usage u WHERE u.month = $2 AND u.tenant_id = $1 AND u.environment = 'production') AS tenant_calls
           FROM qbo_connections c WHERE c.tenant_id = $1`, [tenantId, month])).rows[0] || null,
    }));
    if (row?.throttled) throw new QboError('throttled', { retryAfterS: Math.max(1, row.wait_s || 1) });
    if (reads > 0 && cfg.environment === 'production') {
      const budget = await tenantBudget();
      const tenantPct = budget > 0 ? (Number(row?.tenant_calls || 0) / budget) * 100 : 0;
      const workspacePct = cfg.readBudget > 0 ? ((await workspaceCalls(db, month)) / cfg.readBudget) * 100 : 0;
      const g = budgetGate(purpose, tenantPct, workspacePct);
      if (g) {
        if (g.pause && row) await setPaused(db, tenantId, true, g.pause).catch(() => {});
        throw new QboError('budget', { variant: g.variant, retry: false });
      }
    }
    if (kind === 'core' && !cfg.writesEnabled) throw new QboError('unavailable', { variant: 'writes_off', retry: true });
  }

  /** Count a call in qbo_api_usage; send the 50/80/100% notices once each per month. */
  async function count({ core = 0, coreplus = 0, throttled = 0, errors = 0 }) {
    const month = monthKey();
    const environment = cfg.environment || 'sandbox';
    try {
      await db.withTenant({ tenantId }, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO qbo_api_usage (month, tenant_id, environment, core_calls, coreplus_calls, throttled, errors)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (month, tenant_id, environment) DO UPDATE SET core_calls = qbo_api_usage.core_calls + EXCLUDED.core_calls,
             coreplus_calls = qbo_api_usage.coreplus_calls + EXCLUDED.coreplus_calls, throttled = qbo_api_usage.throttled + EXCLUDED.throttled,
             errors = qbo_api_usage.errors + EXCLUDED.errors
           RETURNING coreplus_calls, alerted_pct`, [month, tenantId, environment, core, coreplus, throttled, errors]);
        if (environment !== 'production' || !coreplus) return;
        workspaceCache.calls += coreplus;
        const budget = await tenantBudget();
        const pct = budget > 0 ? (rows[0].coreplus_calls / budget) * 100 : 0;
        const reached = ALERT_PCTS.filter((p) => pct >= p && rows[0].alerted_pct < p).at(-1);
        if (!reached) return;
        await tx.query('UPDATE qbo_api_usage SET alerted_pct = $4 WHERE month = $1 AND tenant_id = $2 AND environment = $3 AND alerted_pct < $4',
          [month, tenantId, environment, reached]);
        await notify(tx, {
          role: ['owner', 'admin', 'office'], kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:budget:${month}:${reached}`,
          title: reached >= 100 ? "This month's QuickBooks read allowance is used up" : `QuickBooks reads this month: ${reached}% of the allowance`,
          body: reached >= 100 ? 'Look-ups, checks and scheduled pulls wait until the 1st. Changes from QuickBooks still arrive when QuickBooks reports them.' : null,
        });
        await platformEvent(tx, 'budget_threshold', environment, tenantId);
      });
    } catch (e) {
      // Counting must never fail the call it counts.
      if (process.env.DEBUG_QBO) console.error('qbo usage count failed', e);
    }
  }

  /**
   * One HTTP call to Intuit.
   * @param {{ method: 'GET'|'POST', path: string, params?: Record<string, string>, body?: any, raw?: Buffer, contentType?: string,
   *   entity?: string|null, core?: number, coreplus?: number, write?: boolean }} op
   */
  async function call(op) {
    if (!cfg.enabled) throw new QboError('unavailable', { variant: 'disabled', retry: false });
    const core = op.core || 0;
    const coreplus = op.coreplus || 0;
    await gate(core > 0 ? 'core' : 'coreplus', coreplus);
    const release = await lim.acquire(tenantId, { maxInFlight });
    try {
      let forced = false;
      for (;;) {
        const tok = o.token || await withAccessToken(db, sealer, o.config, tenantId, { force: forced });
        const params = new URLSearchParams({ ...(op.params || {}), minorversion: String(cfg.minorVersion) });
        // REALM in a path (companyinfo/REALM) is the realm id, known only from the token.
        const url = `${cfg.apiBase}/${tok.realmId}/${op.path.replace(REALM, tok.realmId)}?${params}`;
        const started = Date.now();
        let res;
        try {
          res = await request('qbo', url, {
            method: op.method,
            headers: {
              authorization: `Bearer ${tok.accessToken}`,
              accept: 'application/json',
              ...(op.raw || op.body !== undefined ? { 'content-type': op.contentType || 'application/json' } : {}),
            },
            body: op.raw ?? (op.body === undefined ? undefined : typeof op.body === 'string' ? op.body : JSON.stringify(op.body)),
            timeoutMs: cfg.requestTimeoutMs,
          });
        } catch (e) {
          await count({ core, coreplus, errors: 1 });
          emit('warn', { method: op.method, entity: op.entity || null, status: null, network: true, ms: Date.now() - started });
          const timeout = e instanceof ProviderError && /in time/.test(e.message);
          throw new QboError('unavailable', { variant: timeout ? 'timeout' : null, retry: true, outcomeUnknown: core > 0 });
        }
        const tid = res.headers?.get?.('intuit_tid') || null;
        client.lastIntuitTid = tid;
        const fault = res.ok ? null : faultOf(res.json);
        emit(res.ok ? 'info' : 'warn', { method: op.method, entity: op.entity || null, status: res.status, faultCode: fault?.code ?? null, intuitTid: tid, ms: Date.now() - started });

        if (res.status === 401 && !forced && !o.token) {
          await count({ core, coreplus, errors: 1 });
          forced = true;
          continue;
        }
        if (res.ok) {
          await count({ core, coreplus });
          if (coreplus) capSeen.delete(cfg.environment);
          return res.json;
        }
        const c = classifyQboFault({ status: res.status, faultCode: fault?.code, detail: fault?.detail, message: fault?.message });
        const detail = scrub([fault?.message, fault?.detail].filter(Boolean).join(': '), 500, { names: true }) || null;
        if (c.kind === 'throttled') {
          await count({ core, coreplus, throttled: 1 });
          await onThrottled(fault);
          throw new QboError('throttled', { status: res.status, faultCode: fault?.code, intuitTid: tid, retryAfterS: 60, detail });
        }
        await count({ core, coreplus, errors: 1 });
        if (res.status >= 500) await db.withTenant({ tenantId }, (tx) => platformEvent(tx, 'intuit_5xx', cfg.environment, tenantId)).catch(() => {});
        throw new QboError(c.kind, {
          variant: c.variant, retry: c.retry, status: res.status, faultCode: fault?.code ?? null, intuitTid: tid, detail,
          outcomeUnknown: core > 0 && res.status >= 500,
        });
      }
    } finally {
      release();
    }
  }

  /** 429: stop every caller for 60 s; a monthly cap that lasts 10 minutes pauses the tenant (5.11). */
  async function onThrottled(fault) {
    await db.withTenant({ tenantId }, (tx) => tx.query(
      "UPDATE qbo_connections SET throttled_until = now() + interval '60 seconds', updated_at = now() WHERE tenant_id = $1", [tenantId])).catch(() => {});
    if (/month/i.test(`${fault?.message || ''} ${fault?.detail || ''}`)) {
      const first = capSeen.get(cfg.environment) ?? Date.now();
      capSeen.set(cfg.environment, first);
      if (Date.now() - first > 10 * 60_000) await setPaused(db, tenantId, true, 'budget').catch(() => {});
    }
  }

  const one = (json, entity) => json?.[entity] ?? null;

  Object.assign(client, {
    /** Read one object by id (CorePlus). */
    async read(entity, id) {
      if (!ID.test(String(id))) throw new Error('qbo: bad id');
      return one(await call({ method: 'GET', path: `${entityPath(entity)}/${id}`, entity, coreplus: 1 }), entity);
    },

    /**
     * Run a query (CorePlus per page). Text is built by the caller with qboQuote and id patterns only.
     * Returns the objects, or the number for `select count(*)`. `all` pages through with
     * STARTPOSITION/MAXRESULTS (the text must not carry them); `max` caps the objects returned.
     */
    async query(text, { all = false, max = Infinity } = {}) {
      const isCount = /^\s*select\s+count\(\*\)/i.test(text);
      const page = async (q) => {
        const json = await call({ method: 'POST', path: 'query', body: q, contentType: 'application/text', entity: null, coreplus: 1 });
        const qr = json?.QueryResponse || {};
        if (isCount) return { count: qr.totalCount ?? 0, list: [] };
        const key = Object.keys(qr).find((k) => Array.isArray(qr[k]));
        return { list: key ? qr[key] : [] };
      };
      if (isCount) return (await page(text)).count;
      if (!all) return (await page(text)).list.slice(0, Number.isFinite(max) ? max : undefined);
      const out = [];
      for (let start = 1; out.length < max; start += 1000) {
        const { list } = await page(`${text} STARTPOSITION ${start} MAXRESULTS 1000`);
        out.push(...list);
        if (list.length < 1000) break;
      }
      return Number.isFinite(max) ? out.slice(0, max) : out;
    },

    /**
     * Change data capture for several entities from `since` (one CorePlus call).
     * @returns {Promise<{ time: string|null, count: number, entities: Record<string, object[]> }>}
     */
    async cdc(entities, since) {
      for (const e of entities) entityPath(e);
      const json = await call({ method: 'GET', path: 'cdc', params: { entities: entities.join(','), changedSince: new Date(since).toISOString() }, entity: 'CDC', coreplus: 1 });
      const out = {};
      let n = 0;
      for (const block of json?.CDCResponse || []) {
        for (const qr of block.QueryResponse || []) {
          for (const [k, v] of Object.entries(qr)) {
            if (!Array.isArray(v)) continue;
            (out[k] ||= []).push(...v);
            n += v.length;
          }
        }
      }
      return { time: json?.time || null, count: n, entities: out };
    },

    /** Create (Core). requestId makes a retried create land once while Intuit remembers it (5.3). */
    async create(entity, body, { requestId } = {}) {
      return one(await call({ method: 'POST', path: entityPath(entity), params: rid(requestId), body, entity, core: 1 }), entity);
    },

    /** Full or sparse update (Core). body carries Id and SyncToken; a stale SyncToken is QboError kind 'stale' (5010). */
    async update(entity, body, { requestId, sparse = false } = {}) {
      return one(await call({ method: 'POST', path: entityPath(entity), params: rid(requestId), body: { ...body, sparse: Boolean(sparse) }, entity, core: 1 }), entity);
    },

    /** Delete (Core). */
    async remove(entity, { Id, SyncToken }, { requestId } = {}) {
      return one(await call({ method: 'POST', path: entityPath(entity), params: { operation: 'delete', ...rid(requestId) }, body: { Id, SyncToken }, entity, core: 1 }), entity);
    },

    /** Void (Core). A Payment is voided with a sparse update and include=void (4.9). */
    async voidTxn(entity, { Id, SyncToken }, { requestId } = {}) {
      const params = entity === 'Payment' ? { operation: 'update', include: 'void', ...rid(requestId) } : { operation: 'void', ...rid(requestId) };
      const body = entity === 'Payment' ? { Id, SyncToken, sparse: true } : { Id, SyncToken };
      return one(await call({ method: 'POST', path: entityPath(entity), params, body, entity, core: 1 }), entity);
    },

    /** Attach a file to an object (Core). */
    async upload({ entity, id }, { fileName, contentType, bytes }, { requestId } = {}) {
      entityPath(entity);
      if (!ID.test(String(id))) throw new Error('qbo: bad id');
      const boundary = `fishtape${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const meta = { AttachableRef: [{ EntityRef: { type: entity, value: String(id) } }], FileName: fileName, ContentType: contentType, Category: 'Receipt' };
      const safeName = String(fileName).replace(/["\r\n]/g, '_');
      const raw = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_0"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_content_0"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const json = await call({ method: 'POST', path: 'upload', params: rid(requestId), raw, contentType: `multipart/form-data; boundary=${boundary}`, entity: 'Attachable', core: 1 });
      return json?.AttachableResponse?.[0]?.Attachable ?? null;
    },

    /**
     * Batch (at most what Intuit allows, 5.8). Items: { bId, operation, <Entity>: body } or { bId, Query }.
     * Writes count as Core, queries as CorePlus. Returns BatchItemResponse.
     */
    async batch(items) {
      const queries = items.filter((i) => i.Query).length;
      const writes = items.length - queries;
      const json = await call({ method: 'POST', path: 'batch', body: { BatchItemRequest: items }, entity: 'Batch', core: writes, coreplus: queries });
      return json?.BatchItemResponse || [];
    },

    /** CompanyInfo (CorePlus). */
    async companyInfo() {
      const json = await call({ method: 'GET', path: `companyinfo/${REALM}`, entity: 'CompanyInfo', coreplus: 1 });
      return json?.CompanyInfo ?? null;
    },

    /** Preferences (CorePlus). */
    async preferences() {
      return (await call({ method: 'GET', path: 'preferences', entity: 'Preferences', coreplus: 1 }))?.Preferences ?? null;
    },
  });

  return client;
}

const rid = (requestId) => {
  if (requestId === undefined || requestId === null) return {};
  if (!REQUEST_ID.test(String(requestId))) throw new Error('qbo: bad request id');
  return { requestid: String(requestId) };
};
