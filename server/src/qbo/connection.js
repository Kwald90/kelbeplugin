// A tenant's QuickBooks connection (docs/integrations/quickbooks.md section 2): the connect ticket,
// interstitial, flow cookie and state row; the callback with the same-company and revoke rules;
// takeover; token storage, the refresh lease and the platform token breaker; pause and resume;
// reconnect-needed; disconnect and purge.
//
// Tokens and the realm id live in tenant_secrets (internal names, envelope-encrypted). They never go
// into a response, a log line, an error message, an audit summary or a job payload. The realm is
// found from webhooks by realm_hash = HMAC(master-key subkey, environment:realmId) instead.
//
// `cfg` everywhere is the server config or config.qbo. No database transaction is ever held across
// a call to Intuit.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TenantTx } from '../db.js';
import { ApiError, forbidden, notFound, validationFailed } from '../errors.js';
import { sha256 } from '../lib/crypto.js';
import { createEmail } from '../lib/email.js';
import { appendAudit, requestFacts } from '../services/audit.js';
import { featureNotInPlan, loadTenantPlan, tenantHas } from '../services/entitlements.js';
import { notify } from '../services/notify.js';
import { enqueue } from '../services/queue.js';
import { deleteSecret, getSecret, setSecret } from '../services/secrets.js';
import { qboCfg } from './env.js';
import { QBO_PKCE, authorizeUrl, codeChallengeFor, exchangeCode, refreshTokens, revokeToken } from './oauth.js';
import { QboError, createQboClient } from './client.js';
import { QBO_ACTOR } from './roles.js';
import { interstitialHeaders, interstitialPage } from './pages.js';

export const SECRET_NAMES = Object.freeze({ refresh: 'qbo.refresh_token', access: 'qbo.access_token', realm: 'qbo.realm_id' });
const INTERNAL = Object.freeze({ internal: true });

export const FLOW_COOKIE = 'ft_qbo_flow';
export const FLOW_COOKIE_PATH = '/api/v1/qbo/oauth';
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const REALM_ID_RE = /^\d{1,20}$/;
const OFFICE = ['owner', 'admin', 'office'];
const TICKET_TTL_S = 120;
const FLOW_TTL_S = 600;
const RECONNECT_FROM = ['reconnect_needed', 'paused', 'active', 'disconnected'];

const b64 = (n = 32) => randomBytes(n).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tenantDb = (db, tenantId, fn, opts) => db.withTenant({ tenantId }, fn, opts);
// A Fastify request or already-picked audit facts.
const facts = (request) => (request?.headers ? requestFacts(request) : request || undefined);

/** Cookie options for ft_qbo_flow (HttpOnly, Secure, SameSite=Lax, only on the OAuth paths, 10 minutes). */
export function flowCookieOptions(config = {}) {
  return { httpOnly: true, secure: config.secureCookies ?? true, sameSite: 'lax', path: FLOW_COOKIE_PATH, maxAge: FLOW_TTL_S };
}

/** Where a connect result goes: the PWA for `web`, the static done page for `app` (or when unknown). */
export function resultUrl(cfg, returnTo, result) {
  const q = qboCfg(cfg);
  const r = encodeURIComponent(result);
  return returnTo === 'web' ? `${q.publicOrigin}/#/quickbooks?connect=${r}` : `${q.publicOrigin}/api/v1/qbo/oauth/done?result=${r}`;
}

// ---- realms and connection rows ---------------------------------------------------------------

/** realm_hash for a realm id in an environment. */
export function realmHashFor(sealer, environment, realmId) {
  return sealer.mac('qbo-realm', `${environment}:${realmId}`);
}

/** realm_hash for a realm id in this server's environment. */
export function realmHash(sealer, cfg, realmId) {
  return realmHashFor(sealer, qboCfg(cfg).environment, realmId);
}

/** The tenant holding a realm, or null. A plain read of qbo_realms (hashes and tenant ids only). */
export async function qboRealmOwner(db, hash) {
  const { rows } = await db.query('SELECT tenant_id FROM qbo_realms WHERE realm_hash = $1', [hash]);
  return rows[0]?.tenant_id ?? null;
}
export { qboRealmOwner as qbo_realm_owner };

export async function tenantForRealm(db, sealer, cfg, realmId) {
  if (!REALM_ID_RE.test(String(realmId))) return null;
  return qboRealmOwner(db, realmHash(sealer, cfg, String(realmId)));
}

/** The tenant's qbo_connections row (snake_case columns, no secrets), or null. */
export async function loadConnection(tx) {
  const { rows } = await tx.query('SELECT * FROM qbo_connections WHERE tenant_id = $1', [tx.tenantId]);
  return rows[0] || null;
}

/** One platform health event for HQ alerts (kinds and counts only). */
export async function platformEvent(q, kind, environment, tenantId = null) {
  await q.query('INSERT INTO qbo_platform_events (kind, environment, tenant_id) VALUES ($1, $2, $3)', [kind, environment || null, tenantId]);
}

/**
 * Queue a sync pass. `sweep: true` (every move back to active, 2.5) uses its own dedupe key and
 * payload, so the engine runs the Fishtape-side sweep (5.12) before its first push.
 */
export function enqueueSync(q, tenantId, { sweep = false, runAt = null } = {}) {
  return enqueue(q, {
    kind: 'qbo_sync', tenantId, payload: sweep ? { sweep: true } : {}, runAt,
    dedupeKey: sweep ? `qbo_sync:${tenantId}:sweep` : `qbo_sync:${tenantId}`, maxAttempts: 5,
  });
}

/** The person is an active owner or admin of an active tenant; and whether the tenant has QuickBooks in its plan. */
async function adminFacts(db, tenantId, userId) {
  const { rows } = await db.query(
    `SELECT m.role, u.email, u.display_name, t.status AS tenant_status, t.name AS tenant_name,
            (m.status = 'active' AND u.status = 'active' AND t.status = 'active' AND m.role IN ('owner', 'admin')) AS admin
       FROM memberships m JOIN users u ON u.id = m.user_id JOIN tenants t ON t.id = m.tenant_id
      WHERE m.tenant_id = $1 AND m.user_id = $2`, [tenantId, userId]);
  const r = rows[0];
  if (!r) return { admin: false, entitled: false };
  const plan = await loadTenantPlan(db, tenantId);
  return { admin: Boolean(r.admin), entitled: Boolean(plan && tenantHas(plan, 'quickbooks')), email: r.email, displayName: r.display_name, tenantName: r.tenant_name };
}

// ---- features (2.8) ---------------------------------------------------------------------------

const nameValue = (list, name) => (Array.isArray(list) ? list : []).find((n) => n?.Name === name)?.Value;
const truthy = (v) => v === true || v === 'true';

/**
 * qbo_connections.features from CompanyInfo and Preferences (2.8). taxFiledThrough comes from the
 * daily reference refresh (TaxAgency), not from here; a reconnect keeps the stored value.
 */
export function detectFeatures(info, prefs) {
  const edition = String(nameValue(info?.NameValue, 'OfferingSku') || '').trim() || null;
  const tier = /advanced|plus/i.test(edition || '') ? 'plus' : /essentials/i.test(edition || '') ? 'essentials' : edition ? 'basic' : 'plus';
  const acct = prefs?.AccountingInfoPrefs || {};
  const sales = prefs?.SalesFormsPrefs || {};
  const vendorPrefs = prefs?.VendorAndPurchasesPrefs || {};
  const other = prefs?.OtherPrefs?.NameValue;
  return {
    edition,
    salesTax: truthy(prefs?.TaxPrefs?.UsingSalesTax),
    customTxnNumbers: truthy(sales.CustomTxnNumbers),
    purchaseCustomTxnNumbers: truthy(vendorPrefs.UseCustomTxnNumbers ?? nameValue(other, 'UseCustomTxnNumbers')),
    estimates: truthy(sales.AllowEstimates),
    discounts: truthy(sales.AllowDiscount),
    deposits: truthy(sales.AllowDeposit),
    bills: tier !== 'basic',
    timeTracking: tier !== 'basic' && prefs?.TimeTrackingPrefs !== null,
    purchaseOrders: tier === 'plus',
    classes: truthy(acct.ClassTrackingPerTxn) || truthy(acct.ClassTrackingPerTxnLine),
    locations: truthy(acct.TrackDepartments),
    projects: truthy(nameValue(other, 'ProjectsEnabled')),
    multicurrency: truthy(prefs?.CurrencyPrefs?.MultiCurrencyEnabled),
    payroll: truthy(nameValue(info?.NameValue, 'PayrollFeature')),
    bookCloseDate: acct.BookCloseDate || null,
    province: info?.CompanyAddr?.CountrySubDivisionCode || null,
  };
}

const homeCurrency = (prefs) => prefs?.CurrencyPrefs?.HomeCurrency?.value || prefs?.CurrencyPrefs?.HomeCurrency || null;

// ---- connect: ticket, interstitial, start --------------------------------------------------

/**
 * Step 1 of 2.2: a one-time ticket for an owner or admin (the route checks role and MFA).
 * @returns {Promise<{ url: string }>}
 */
export async function createConnectTicket(db, cfg, { tenantId, userId, returnTo, reconnect = false }) {
  const q = qboCfg(cfg);
  if (!q.enabled) throw new ApiError(503, 'qbo_unavailable', 'QuickBooks is not available on this server.');
  if (returnTo !== 'web' && returnTo !== 'app') throw validationFailed('returnTo must be web or app.');
  const who = await adminFacts(db, tenantId, userId);
  if (!who.admin) throw forbidden('Only an owner or admin can connect QuickBooks.');
  if (!who.entitled) throw featureNotInPlan('quickbooks');
  const conn = await tenantDb(db, tenantId, loadConnection);
  if (reconnect && !conn) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  // 2.6: a reconnect from reconnect_needed, paused, active or disconnected (before purge); not during setup.
  if (reconnect && !RECONNECT_FROM.includes(conn.state)) throw new ApiError(409, 'qbo_reconnect_not_allowed', 'QuickBooks is connected and being set up; there is nothing to reconnect.');
  if (!reconnect && conn && conn.state !== 'disconnected') throw new ApiError(409, 'qbo_already_connected', 'QuickBooks is already connected. Use Reconnect.');
  const ticket = b64();
  await db.query(
    `INSERT INTO qbo_oauth_states (tenant_id, user_id, stage, ticket_hash, return_to, reconnect, expires_at)
     VALUES ($1, $2, 'ticket', $3, $4, $5, now() + make_interval(secs => $6))`,
    [tenantId, userId, sha256(ticket), returnTo, Boolean(reconnect), TICKET_TTL_S]);
  return { url: `${q.publicOrigin}/api/v1/qbo/oauth/start?ticket=${ticket}` };
}

/**
 * GET start: the interstitial (the ticket is not consumed). `web` tickets need the issuer's own session.
 * @returns {Promise<{ html: string, headers: object } | { redirect: string }>}
 */
export async function startPage(db, cfg, ticket, { sessionUserId = null } = {}) {
  const q = qboCfg(cfg);
  if (!q.enabled) return { redirect: resultUrl(q, null, 'unavailable') };
  if (!TICKET_RE.test(String(ticket || ''))) return { redirect: resultUrl(q, null, 'state_invalid') };
  const { rows } = await db.query(
    `SELECT s.return_to, s.user_id, t.name AS tenant_name, u.email
       FROM qbo_oauth_states s JOIN tenants t ON t.id = s.tenant_id JOIN users u ON u.id = s.user_id
      WHERE s.ticket_hash = $1 AND s.stage = 'ticket' AND s.expires_at > now()`, [sha256(ticket)]);
  const row = rows[0];
  if (!row) return { redirect: resultUrl(q, null, 'state_invalid') };
  if (row.return_to === 'web' && sessionUserId !== row.user_id) return { redirect: resultUrl(q, 'web', 'state_invalid') };
  return {
    html: interstitialPage({ tenantName: row.tenant_name, userEmail: row.email, ticket, cancelUrl: resultUrl(q, row.return_to, 'denied') }),
    headers: interstitialHeaders(q.oauth.authorize),
  };
}

/**
 * POST start: consumes the ticket once, stores sha256(state) and sha256(flow), and sends the browser
 * to Intuit. The route sets FLOW_COOKIE = flowCookie with flowCookieOptions().
 * @returns {Promise<{ redirect: string, flowCookie?: string }>}
 */
export async function startFromTicket(db, sealer, cfg, ticket) {
  const q = qboCfg(cfg);
  if (!q.enabled) return { redirect: resultUrl(q, null, 'unavailable') };
  if (!TICKET_RE.test(String(ticket || ''))) return { redirect: resultUrl(q, null, 'state_invalid') };
  const state = b64();
  const flow = b64();
  const { rows } = await db.query(
    `UPDATE qbo_oauth_states SET stage = 'authorizing', state_hash = $2, flow_hash = $3, expires_at = now() + make_interval(secs => $4)
      WHERE ticket_hash = $1 AND stage = 'ticket' AND expires_at > now() RETURNING id, return_to`,
    [sha256(ticket), sha256(state), sha256(flow), FLOW_TTL_S]);
  if (!rows[0]) return { redirect: resultUrl(q, null, 'state_invalid') };
  let codeChallenge = null;
  if (QBO_PKCE) {
    const verifier = b64();
    codeChallenge = codeChallengeFor(verifier);
    await db.query('UPDATE qbo_oauth_states SET verifier_sealed = $2 WHERE id = $1', [rows[0].id, sealer.seal('qbo-pkce', verifier, `qbo-pkce:${rows[0].id}`)]);
  }
  return { redirect: authorizeUrl(q, { state, redirectUri: q.redirectUri(), codeChallenge }), flowCookie: flow };
}

// ---- connect: callback ------------------------------------------------------------------------

/**
 * The OAuth callback (2.2 step 3). Always a redirect (the route answers 302 and clears the flow
 * cookie). Checks stop at the first failure; see the contract for the order.
 * @returns {Promise<{ redirect: string, tenantId: string|null, result: string }>}
 */
export async function completeCallback(db, sealer, cfg, { code, state, realmId, error, flowCookie, sessionUserId = null }) {
  const q = qboCfg(cfg);
  const done = (result, returnTo = null, tenantId = null) => ({ result, tenantId, redirect: resultUrl(q, returnTo, result) });
  if (!q.enabled) return done('unavailable');
  if (!TICKET_RE.test(String(state || ''))) return done('state_invalid');

  // Single use: the row is gone whatever happens next.
  const { rows } = await db.query(
    "DELETE FROM qbo_oauth_states WHERE state_hash = $1 AND stage = 'authorizing' RETURNING *, expires_at > now() AS live", [sha256(state)]);
  const row = rows[0];
  if (!row) return done('state_invalid');
  const back = (result) => done(result, row.return_to, row.tenant_id);
  const flowOk = Boolean(row.live && flowCookie && row.flow_hash && timingSafeEqual(sha256(flowCookie), Buffer.from(row.flow_hash)));
  if (!flowOk) return back('state_invalid');
  if (row.return_to === 'web' && sessionUserId && sessionUserId !== row.user_id) return back('state_invalid');

  const who = await adminFacts(db, row.tenant_id, row.user_id);
  if (!who.admin) return back('forbidden');
  if (!who.entitled) return back('plan');
  if (error || !code) return back('denied');
  if (!REALM_ID_RE.test(String(realmId || ''))) return back('exchange_failed');

  const codeVerifier = row.verifier_sealed ? sealer.open('qbo-pkce', row.verifier_sealed, `qbo-pkce:${row.id}`) : null;
  let tokens;
  try {
    tokens = await exchangeCode(q, { code, redirectUri: q.redirectUri(), codeVerifier });
  } catch (e) {
    if (e?.kind === 'platform') await openBreaker(db, q, row.tenant_id);
    return back('exchange_failed');
  }

  const hash = realmHash(sealer, q, realmId);
  // Revoke rule: revoke the new grant only when no tenant holds this realm (2.2). A failed revoke is
  // kept for the daily retries, never just dropped while the grant may be live.
  const fail = async (result) => {
    if ((await qboRealmOwner(db, hash)) == null) {
      await revokeToken(q, tokens.refreshToken).catch(() => queueRevoke(db, sealer, q.environment, tokens.refreshToken, hash).catch(() => {}));
    }
    return back(result);
  };

  let info, prefs;
  try {
    const c = createQboClient({ db, sealer, config: q, tenantId: row.tenant_id, purpose: 'connect', token: { accessToken: tokens.accessToken, realmId } });
    info = await c.companyInfo();
    prefs = await c.preferences();
  } catch {
    return fail('exchange_failed');
  }
  if (String(info?.Country || '').toUpperCase() !== 'CA') return fail('not_canada');
  if (String(homeCurrency(prefs) || '').toUpperCase() !== 'CAD') return fail('not_cad');

  const owner = await qboRealmOwner(db, hash);
  if (owner && owner !== row.tenant_id) {
    // Never revoke: the grant is shared with the tenant that holds the realm. Keep the tokens sealed
    // for 10 minutes so an admin here can take the company over (2.9).
    await saveTakeoverOffer(db, sealer, row, { hash, tokens, realmId, companyName: info?.CompanyName || null, features: detectFeatures(info, prefs) });
    return back('realm_in_use');
  }

  // Same company rule, whatever the request said (2.2): old links never meet another company.
  const conn = await tenantDb(db, row.tenant_id, loadConnection);
  if (conn && (!Buffer.from(conn.realm_hash).equals(hash) || conn.environment !== q.environment)) return fail(row.reconnect ? 'wrong_company' : 'purge_required');

  try {
    await tenantDb(db, row.tenant_id, (tx) => connectTx(tx, sealer, q, {
      userId: row.user_id, displayName: who.displayName, tokens, realmId, hash,
      companyName: info?.CompanyName || null, features: detectFeatures(info, prefs),
    }), { write: true });
  } catch (e) {
    if (e?.code === 'qbo_realm_in_use') return back('realm_in_use');
    if (e?.code === 'qbo_purge_required') return fail(row.reconnect ? 'wrong_company' : 'purge_required');
    return fail('exchange_failed');
  }
  return back('ok');
}

/**
 * The success path of a connect, inside the tenant's transaction (callback and takeover): tokens and
 * realm id stored, connection upserted, realm row, audit, notification, reference refresh queued.
 */
async function connectTx(tx, sealer, q, { userId, displayName, tokens, realmId, hash, companyName, features, action = null, actor = null, request = null }) {
  const tenantId = tx.tenantId;
  const conn = await loadConnection(tx);
  if (conn && (!Buffer.from(conn.realm_hash).equals(hash) || conn.environment !== q.environment)) {
    throw Object.assign(new Error('purge required'), { code: 'qbo_purge_required' });
  }
  await tx.query('INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [hash, tenantId, q.environment]);
  const held = await tx.query('SELECT tenant_id FROM qbo_realms WHERE realm_hash = $1', [hash]);
  if (held.rows[0]?.tenant_id !== tenantId) throw Object.assign(new Error('realm in use'), { code: 'qbo_realm_in_use' });

  await setSecret(tx, sealer, SECRET_NAMES.refresh, tokens.refreshToken, 'system:qbo', INTERNAL);
  await setSecret(tx, sealer, SECRET_NAMES.access, tokens.accessToken, 'system:qbo', INTERNAL);
  await setSecret(tx, sealer, SECRET_NAMES.realm, realmId, 'system:qbo', INTERNAL);

  // A reconnect returns to the state before (2.6); from disconnected, active when the wizard was applied.
  // A pause survives reconnect_needed (pause_reason stays set, state_before is the state before it).
  const setupDone = conn?.setup?.phase === 'done';
  let state = 'setup';
  if (conn) {
    if (['setup', 'active', 'paused'].includes(conn.state)) state = conn.state;
    else if (conn.state === 'reconnect_needed' && conn.pause_reason) state = 'paused';
    else if (conn.state === 'reconnect_needed' && ['setup', 'active'].includes(conn.state_before)) state = conn.state_before;
    else state = setupDone ? 'active' : 'setup';
  }
  await tx.query(
    `INSERT INTO qbo_connections (tenant_id, environment, realm_hash, state, company_name, features, connected_at, connected_by,
        access_expires_at, refresh_expires_at, refresh_hard_expires_at, last_refresh_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now() + make_interval(secs => $8), now() + make_interval(secs => $9),
        CASE WHEN $10::bigint IS NULL THEN NULL ELSE now() + make_interval(secs => $10::bigint) END, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
        environment = EXCLUDED.environment, realm_hash = EXCLUDED.realm_hash, state = EXCLUDED.state,
        state_before = CASE WHEN EXCLUDED.state = 'paused' THEN qbo_connections.state_before END,
        pause_reason = CASE WHEN EXCLUDED.state = 'paused' THEN qbo_connections.pause_reason END,
        paused_since = CASE WHEN EXCLUDED.state = 'paused' THEN qbo_connections.paused_since END,
        reconnect_reason = NULL, company_name = EXCLUDED.company_name,
        features = qbo_connections.features || EXCLUDED.features,
        connected_at = now(), connected_by = EXCLUDED.connected_by,
        access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
        refresh_hard_expires_at = COALESCE(EXCLUDED.refresh_hard_expires_at, qbo_connections.refresh_hard_expires_at),
        last_refresh_at = now(), refreshing_until = NULL, throttled_until = NULL,
        disconnected_at = NULL, purge_after = NULL, updated_at = now()`,
    [tenantId, q.environment, hash, state, companyName ? String(companyName).slice(0, 200) : null, JSON.stringify(features || {}), userId,
      tokens.expiresIn, tokens.refreshExpiresIn, tokens.refreshHardExpiresIn]);

  const reconnect = Boolean(conn);
  const label = companyName || 'QuickBooks company';
  await appendAudit(tx, tenantId, {
    actor: actor || { type: 'user', id: userId, label: displayName || null },
    action: action || (reconnect ? 'qbo.reconnect' : 'qbo.connect'),
    collection: 'qbo_connections', request: facts(request),
    summary: `${reconnect ? 'Reconnected' : 'Connected'} QuickBooks company ${label}`.slice(0, 300),
  });
  await notify(tx, {
    role: OFFICE, kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:connect:${Date.now()}`,
    title: `QuickBooks ${reconnect ? 'reconnected' : 'connected'}: ${label}`,
    body: `${displayName || 'An admin'} connected the QuickBooks company ${label}. If you did not expect this, disconnect it in QuickBooks settings.`,
  });
  await enqueue(tx, { kind: 'qbo_reference_refresh', tenantId, dedupeKey: `qbo_reference_refresh:${tenantId}`, maxAttempts: 3 });
  if (state === 'active') await enqueueSync(tx, tenantId, { sweep: true });
  return { state };
}

async function saveTakeoverOffer(db, sealer, row, { hash, tokens, realmId, companyName, features }) {
  const id = randomUUID();
  const sealed = sealer.seal('qbo-takeover', JSON.stringify({ tokens, realmId, companyName, features }), `qbo-takeover:${id}`);
  await db.query("DELETE FROM qbo_oauth_states WHERE tenant_id = $1 AND user_id = $2 AND stage = 'takeover'", [row.tenant_id, row.user_id]);
  await db.query(
    `INSERT INTO qbo_oauth_states (id, tenant_id, user_id, stage, ticket_hash, realm_hash, tokens_sealed, return_to, reconnect, expires_at)
     VALUES ($1, $2, $3, 'takeover', $4, $5, $6, $7, $8, now() + interval '10 minutes')`,
    [id, row.tenant_id, row.user_id, sha256(b64()), hash, sealed, row.return_to, row.reconnect]);
}

/** Whether this admin has an open takeover offer (Status.takeoverOffer, 7.2). */
export async function hasTakeoverOffer(db, tenantId, userId) {
  const { rows } = await db.query(
    "SELECT 1 FROM qbo_oauth_states WHERE tenant_id = $1 AND user_id = $2 AND stage = 'takeover' AND expires_at > now() LIMIT 1", [tenantId, userId]);
  return rows.length > 0;
}

/**
 * Move a realm held by another tenant to the caller (2.9). One platform transaction: the old tenant
 * is disconnected with purge and without revoke (the grant is shared and now belongs here), then
 * the caller's connect completes.
 * @returns {Promise<{ ok: true }>}
 */
export async function takeover(db, sealer, cfg, { tenantId, userId, actor = null, request = null }) {
  const q = qboCfg(cfg);
  if (!q.enabled) throw new ApiError(503, 'qbo_unavailable', 'QuickBooks is not available on this server.');
  const { rows } = await db.query(
    `SELECT * FROM qbo_oauth_states WHERE tenant_id = $1 AND user_id = $2 AND stage = 'takeover' AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [tenantId, userId]);
  const row = rows[0];
  if (!row) throw notFound('No takeover offer is open. Connect to QuickBooks again.');
  const opened = sealer.open('qbo-takeover', row.tokens_sealed, `qbo-takeover:${row.id}`);
  if (!opened) throw notFound('No takeover offer is open. Connect to QuickBooks again.');
  const offer = JSON.parse(opened);
  const who = await adminFacts(db, tenantId, userId);
  if (!who.admin) throw forbidden('Only an owner or admin can move a QuickBooks company.');
  if (!who.entitled) throw featureNotInPlan('quickbooks');
  const hash = Buffer.from(row.realm_hash);
  const own = await tenantDb(db, tenantId, loadConnection);
  if (own && (!Buffer.from(own.realm_hash).equals(hash) || own.environment !== q.environment)) {
    throw new ApiError(409, 'qbo_purge_required', 'Delete the links to the other QuickBooks company first.');
  }
  const by = actor || { type: 'user', id: userId, label: who.displayName || null };
  const companyName = offer.companyName || 'QuickBooks company';
  await db.tx(async (client) => {
    // Single use, in the same transaction: a failure below leaves the offer for another try.
    const del = await client.query('DELETE FROM qbo_oauth_states WHERE id = $1 RETURNING id', [row.id]);
    if (!del.rows[0]) throw notFound('No takeover offer is open. Connect to QuickBooks again.');
    const asTenant = async (id) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true), set_config('app.portal_client_id', '', true)", [id]);
      await client.query('SELECT pg_advisory_xact_lock(tenant_lock_key($1))', [id]);
      return new TenantTx(client, { tenantId: id });
    };
    const old = await qboRealmOwner(client, hash);
    if (old && old !== tenantId) {
      const tx = await asTenant(old);
      await tx.query('UPDATE qbo_connections SET lease_epoch = lease_epoch + 1, lease_until = NULL WHERE tenant_id = $1', [old]);
      await disconnectTx(tx, {
        purge: true, actor: QBO_ACTOR, request, action: 'qbo.takeover',
        summary: `QuickBooks company ${companyName} moved to another Fishtape company by a QuickBooks admin`,
      });
      const owners = await tx.query(
        `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.role = 'owner' AND m.status = 'active' AND u.status = 'active' AND u.email IS NOT NULL`, [old]);
      const day = new Date().toISOString().slice(0, 10);
      const email = createEmail();
      for (const o of owners.rows) {
        await email.send(client, {
          to: o.email, tenantId: old, template: 'qbo-takeover', subject: 'Your QuickBooks company was connected elsewhere',
          text: `QuickBooks company ${companyName} was connected to another Fishtape company by a QuickBooks admin of that company on ${day}.\n\nFishtape no longer syncs with it. If this was not expected, talk to whoever manages your QuickBooks, and contact Fishtape support.`,
        });
      }
    }
    const tx = await asTenant(tenantId);
    await connectTx(tx, sealer, q, {
      userId, displayName: who.displayName, tokens: offer.tokens, realmId: offer.realmId, hash,
      companyName: offer.companyName, features: offer.features || {}, action: 'qbo.takeover', actor: by, request,
    });
  });
  return { ok: true };
}

// ---- tokens (2.4) -----------------------------------------------------------------------------

const breaker = { until: 0 };
/** Is the platform token breaker open (Fishtape's own client credentials refused)? */
export function tokenBreakerOpen(now = Date.now()) { return breaker.until > now; }
/** Tests: close the breaker. */
export function resetTokenBreaker() { breaker.until = 0; }

async function openBreaker(db, q, tenantId) {
  const wasOpen = tokenBreakerOpen();
  breaker.until = Date.now() + 10 * 60_000;
  if (wasOpen) return;
  await tenantDb(db, tenantId, (tx) => platformEvent(tx, 'platform_credentials', q.environment, tenantId)).catch(() => {});
}

const inflight = new Map();
const FRESH_MS = 5 * 60_000;
const isFresh = (at) => at && new Date(at).getTime() > Date.now() + FRESH_MS;

async function readTokens(db, sealer, tenantId) {
  return tenantDb(db, tenantId, async (tx) => {
    const conn = await loadConnection(tx);
    if (!conn) return { conn: null };
    return {
      conn,
      access: await getSecret(tx, sealer, SECRET_NAMES.access, INTERNAL),
      refresh: await getSecret(tx, sealer, SECRET_NAMES.refresh, INTERNAL),
      realmId: await getSecret(tx, sealer, SECRET_NAMES.realm, INTERNAL),
    };
  });
}

/**
 * The only way to an access token. Refreshes when it expires within 5 minutes (or `force`, after a
 * 401), single-flight per tenant: an in-process promise plus a 30-second row lease, with no
 * transaction open during the call to Intuit.
 * @returns {Promise<{ accessToken: string, realmId: string }>}
 */
export async function withAccessToken(db, sealer, cfg, tenantId, { force = false } = {}) {
  const q = qboCfg(cfg);
  if (!q.enabled) throw new QboError('unavailable', { variant: 'disabled', retry: false });
  const cur = await readTokens(db, sealer, tenantId);
  if (!cur.conn || cur.conn.state === 'disconnected') throw new QboError('unavailable', { variant: 'not_connected', retry: false });
  if (cur.conn.environment !== q.environment) {
    await markReconnectNeeded(db, tenantId, 'environment');
    throw new QboError('auth');
  }
  if (cur.conn.state === 'reconnect_needed' || !cur.realmId || !cur.refresh) throw new QboError('auth');
  if (tokenBreakerOpen()) throw new QboError('unavailable', { variant: 'breaker', retry: true });
  if (!force && cur.access && isFresh(cur.conn.access_expires_at)) return { accessToken: cur.access, realmId: cur.realmId };
  if (inflight.has(tenantId)) return inflight.get(tenantId);
  const p = refreshFlow(db, sealer, q, tenantId, { force, seen: cur.access }).finally(() => inflight.delete(tenantId));
  inflight.set(tenantId, p);
  return p;
}

async function refreshFlow(db, sealer, q, tenantId, { force, seen }) {
  const deadline = Date.now() + 20_000;
  const usable = (t) => t.access && isFresh(t.conn?.access_expires_at) && (!force || t.access !== seen);
  for (;;) {
    const { rows } = await tenantDb(db, tenantId, (tx) => tx.query(
      `UPDATE qbo_connections SET refreshing_until = now() + interval '30 seconds'
        WHERE tenant_id = $1 AND (refreshing_until IS NULL OR refreshing_until < now()) RETURNING access_expires_at`, [tenantId]));
    if (rows[0]) break;
    // Another process is refreshing: wait for it, then use its token.
    if (Date.now() > deadline) throw new QboError('unavailable', { retry: true });
    await sleep(250);
    const t = await readTokens(db, sealer, tenantId);
    if (!t.conn || t.conn.state === 'reconnect_needed') throw new QboError('auth');
    if (!t.conn.refreshing_until && usable(t)) return { accessToken: t.access, realmId: t.realmId };
  }

  let leased = true;
  const clearLease = async () => {
    if (!leased) return;
    leased = false;
    await tenantDb(db, tenantId, (tx) => tx.query('UPDATE qbo_connections SET refreshing_until = NULL WHERE tenant_id = $1', [tenantId])).catch(() => {});
  };
  try {
    const cur = await readTokens(db, sealer, tenantId);
    if (!cur.conn || cur.conn.state === 'reconnect_needed' || cur.conn.state === 'disconnected' || !cur.refresh) throw new QboError('auth');
    if (usable(cur)) return { accessToken: cur.access, realmId: cur.realmId };

    let tokens = null;
    try {
      tokens = await refreshTokens(q, cur.refresh);
    } catch (e) {
      if (e?.kind === 'platform') {
        await openBreaker(db, q, tenantId);
        throw new QboError('unavailable', { variant: 'breaker', retry: true });
      }
      if (e?.kind !== 'auth') throw e;
      // invalid_grant: another process may have rotated the token; try the stored one once.
      const again = await readTokens(db, sealer, tenantId);
      if (again.refresh && again.refresh !== cur.refresh) {
        try {
          tokens = await refreshTokens(q, again.refresh);
        } catch (e2) {
          if (e2?.kind === 'platform') { await openBreaker(db, q, tenantId); throw new QboError('unavailable', { variant: 'breaker', retry: true }); }
          if (e2?.kind !== 'auth') throw e2;
        }
      }
      if (!tokens) {
        await clearLease();
        await onInvalidGrant(db, q, tenantId);
      }
    }
    await tenantDb(db, tenantId, async (tx) => {
      await setSecret(tx, sealer, SECRET_NAMES.refresh, tokens.refreshToken, 'system:qbo', INTERNAL);
      await setSecret(tx, sealer, SECRET_NAMES.access, tokens.accessToken, 'system:qbo', INTERNAL);
      await tx.query(
        `UPDATE qbo_connections SET access_expires_at = now() + make_interval(secs => $2), refresh_expires_at = now() + make_interval(secs => $3),
            refresh_hard_expires_at = CASE WHEN $4::bigint IS NULL THEN refresh_hard_expires_at ELSE now() + make_interval(secs => $4::bigint) END,
            last_refresh_at = now(), refreshing_until = NULL, updated_at = now()
          WHERE tenant_id = $1`, [tenantId, tokens.expiresIn, tokens.refreshExpiresIn, tokens.refreshHardExpiresIn]);
    });
    leased = false;
    return { accessToken: tokens.accessToken, realmId: cur.realmId };
  } finally {
    await clearLease();
  }
}

/** invalid_grant twice: reconnect needed, unless many tenants hit it at once (mass-revoke guard, 2.4). */
async function onInvalidGrant(db, q, tenantId) {
  const others = await tenantDb(db, tenantId, async (tx) => {
    const { rows } = await tx.query(
      `SELECT count(DISTINCT tenant_id)::int AS n FROM qbo_platform_events
        WHERE kind = 'invalid_grant' AND at > now() - interval '15 minutes' AND tenant_id IS DISTINCT FROM $1`, [tenantId]);
    await platformEvent(tx, 'invalid_grant', q.environment, tenantId);
    return rows[0].n;
  });
  if (others >= 5) throw new QboError('unavailable', { variant: 'breaker', retry: true });
  await markReconnectNeeded(db, tenantId, 'revoked');
  throw new QboError('auth');
}

const RECONNECT_TEXT = {
  revoked: 'QuickBooks ended the connection (it was disconnected in QuickBooks, or the sign-in expired).',
  expired: 'The QuickBooks sign-in has expired.',
  not_canada: 'The QuickBooks company is no longer set up as a Canadian company.',
  not_cad: "The QuickBooks company's home currency is not the Canadian dollar.",
  environment: 'This server now uses a different QuickBooks environment.',
  error: 'QuickBooks refused the connection.',
};

/**
 * Sync stops until an admin reconnects. Office roles are told once a day (2.5). A pause in force
 * stays recorded underneath (pause_reason, paused_since and its state_before are kept), so the
 * reconnect returns to that pause and its resume to the state before it.
 */
export async function markReconnectNeeded(db, tenantId, reason) {
  if (!RECONNECT_TEXT[reason]) throw new Error(`qbo: unknown reconnect reason ${reason}`);
  await tenantDb(db, tenantId, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE qbo_connections SET state = 'reconnect_needed', reconnect_reason = $2,
          state_before = CASE WHEN state IN ('setup', 'active') THEN state ELSE state_before END,
          pause_reason = CASE WHEN state = 'paused' THEN pause_reason END,
          paused_since = CASE WHEN state = 'paused' THEN paused_since END,
          refreshing_until = NULL, lease_epoch = lease_epoch + 1, lease_until = NULL, updated_at = now()
        WHERE tenant_id = $1 AND state NOT IN ('reconnect_needed', 'disconnected') RETURNING environment`, [tenantId, reason]);
    if (!rows[0]) return;
    await platformEvent(tx, 'reconnect_needed', rows[0].environment, tenantId);
    await appendAudit(tx, tenantId, { actor: QBO_ACTOR, action: 'qbo.reconnect_needed', collection: 'qbo_connections', summary: `QuickBooks needs reconnecting (${reason})` });
    await notify(tx, {
      role: OFFICE, kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:reconnect:${new Date().toISOString().slice(0, 10)}`,
      title: 'Reconnect to QuickBooks', body: `${RECONNECT_TEXT[reason]} Sync is stopped until an owner or admin reconnects. Nothing is lost meanwhile.`,
    });
  });
}

// ---- pause and resume (2.5) ---------------------------------------------------------------------

/** Pause reasons, weakest first. A stronger pause replaces a weaker one; a weaker one never replaces a stronger one. */
export const PAUSE_ORDER = Object.freeze(['user', 'tenant_budget', 'budget', 'plan', 'brake', 'hq']);

/**
 * Where a resume goes: the state before the pause, else setup unless the wizard was applied. Never
 * a blind 'active' (an unapplied wizard would then sync two sets of books).
 */
export const RESUME_STATE_SQL = "CASE WHEN state_before IN ('setup', 'active') THEN state_before WHEN setup->>'phase' = 'done' THEN 'active' ELSE 'setup' END";

/**
 * Pause or resume. Pausing keeps the state it came from and fences a running pass. When a pause is
 * already in force the stronger reason stays (PAUSE_ORDER): an office user, a budget or the plan
 * check never replaces an HQ pause, so they can never lift it either; a 'user' pause asked of an
 * HQ-paused connection is 409 qbo_pause_locked. paused_since restarts when the reason changes (the
 * 60-day plan clock counts from the plan pause). On a reconnect_needed connection the pause is
 * recorded underneath, and the reconnect returns to it.
 *
 * Resuming with reason R lifts only a pause of reason R ('user' also lifts 'brake'); anything else is
 * 409 qbo_pause_locked. A brake pause stores the tripped count in brake_allow_count (pass it as
 * allowCount when pausing); resuming it needs allowCount >= that count and allows that many writes
 * for one hour (5.8). A move back to active queues a sync with the sweep.
 */
export async function setPaused(db, tenantId, paused, reason, { allowCount = null } = {}) {
  if (!PAUSE_ORDER.includes(reason)) throw new Error(`qbo: unknown pause reason ${reason}`);
  await tenantDb(db, tenantId, async (tx) => {
    if (paused) {
      const { rowCount } = await tx.query(
        `UPDATE qbo_connections SET state = CASE WHEN state = 'reconnect_needed' THEN state ELSE 'paused' END,
            state_before = CASE WHEN state IN ('setup', 'active') THEN state ELSE state_before END,
            paused_since = CASE WHEN pause_reason = $2 THEN COALESCE(paused_since, now()) ELSE now() END,
            pause_reason = $2,
            brake_allow_count = CASE WHEN $2 = 'brake' THEN $3 ELSE brake_allow_count END,
            brake_allow_until = CASE WHEN $2 = 'brake' THEN NULL ELSE brake_allow_until END,
            lease_epoch = lease_epoch + 1, lease_until = NULL, updated_at = now()
          WHERE tenant_id = $1 AND (state IN ('setup', 'active')
            OR (state IN ('paused', 'reconnect_needed') AND COALESCE(array_position($4::text[], pause_reason), 0) <= array_position($4::text[], $2)))`,
        [tenantId, reason, allowCount == null ? null : Math.trunc(allowCount), PAUSE_ORDER]);
      if (rowCount || reason !== 'user') return;
      const conn = await loadConnection(tx);
      if (conn?.pause_reason === 'hq') throw new ApiError(409, 'qbo_pause_locked', 'Paused by Fishtape support.', { pauseReason: 'hq' });
      return;
    }
    const conn = await loadConnection(tx);
    if (!conn || !conn.pause_reason || !['paused', 'reconnect_needed'].includes(conn.state)) return;
    const lifts = reason === 'user' ? ['user', 'brake'] : [reason];
    if (!lifts.includes(conn.pause_reason)) {
      throw new ApiError(409, 'qbo_pause_locked', conn.pause_reason === 'hq' ? 'Paused by Fishtape support.' : "This pause can't be lifted here.", { pauseReason: conn.pause_reason });
    }
    let brake = '';
    const params = [tenantId];
    if (conn.pause_reason === 'brake') {
      const need = conn.brake_allow_count || 1;
      if (!Number.isInteger(allowCount) || allowCount < need) throw new ApiError(409, 'qbo_brake_count', `Confirm the ${need} changes to resume.`, { count: need });
      params.push(allowCount);
      brake = ", brake_allow_count = $2, brake_allow_until = now() + interval '1 hour'";
    }
    // Under reconnect_needed only the pause is lifted; the reconnect then returns to state_before.
    const { rows } = await tx.query(
      `UPDATE qbo_connections SET state = CASE WHEN state = 'reconnect_needed' THEN state ELSE ${RESUME_STATE_SQL} END,
          state_before = CASE WHEN state = 'reconnect_needed' THEN state_before END,
          pause_reason = NULL, paused_since = NULL${brake}, updated_at = now()
        WHERE tenant_id = $1 AND state IN ('paused', 'reconnect_needed') RETURNING state`, params);
    if (rows[0]?.state === 'active') await enqueueSync(tx, tenantId, { sweep: true });
  });
}

// ---- disconnect and purge (2.7) -----------------------------------------------------------------

const PURGE_TABLES = ['qbo_conflicts', 'qbo_links', 'qbo_candidates', 'qbo_reference', 'qbo_inbox', 'qbo_outbox', 'qbo_sync_log', 'qbo_mappings', 'qbo_connections'];

/** Delete every QuickBooks row of the tenant (stripe_payouts stay: they are Stripe data). */
export async function purgeQboData(tx) {
  for (const t of PURGE_TABLES) await tx.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tx.tenantId]);
}

/**
 * Keep a refresh token whose revoke failed, sealed, for daily retries (14 days). `realmHash` lets a
 * retry skip the revoke once a tenant holds that realm again.
 */
export async function queueRevoke(q, sealer, environment, token, realmHash = null) {
  const id = randomUUID();
  await q.query('INSERT INTO qbo_revoke_pending (id, environment, token_sealed, realm_hash) VALUES ($1, $2, $3, $4)',
    [id, environment, sealer.seal('qbo-revoke', token, `qbo-revoke:${id}`), realmHash]);
}

/** Steps 3 to 6 of 2.7 inside the tenant's transaction. Returns whether data was purged. */
async function disconnectTx(tx, { purge, actor, request = null, action = 'qbo.disconnect', summary = null }) {
  const tenantId = tx.tenantId;
  for (const n of Object.values(SECRET_NAMES)) await deleteSecret(tx, n, INTERNAL);
  await tx.query('DELETE FROM qbo_realms WHERE tenant_id = $1', [tenantId]);
  await tx.query("DELETE FROM jobs_queue WHERE tenant_id = $1 AND kind LIKE 'qbo\\_%' AND status = 'queued'", [tenantId]);
  const { rows } = await tx.query(
    `UPDATE qbo_connections SET
        disconnected_at = CASE WHEN state = 'disconnected' THEN COALESCE(disconnected_at, now()) ELSE now() END,
        purge_after = CASE WHEN state = 'disconnected' AND purge_after IS NOT NULL THEN purge_after ELSE now() + interval '30 days' END,
        state = 'disconnected', state_before = NULL, pause_reason = NULL, paused_since = NULL, reconnect_reason = NULL,
        access_expires_at = NULL, refreshing_until = NULL, throttled_until = NULL, dirty_at = NULL,
        lease_epoch = lease_epoch + 1, lease_until = NULL, updated_at = now()
      WHERE tenant_id = $1 RETURNING company_name`, [tenantId]);
  const label = rows[0]?.company_name || 'QuickBooks company';
  if (purge) await purgeQboData(tx);
  await appendAudit(tx, tenantId, {
    actor, action, collection: 'qbo_connections', request: facts(request),
    summary: (summary || `Disconnected QuickBooks company ${label}${purge ? '; links and QuickBooks data deleted' : '; links kept for 30 days'}`).slice(0, 500),
  });
  await notify(tx, {
    role: OFFICE, kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:disconnect:${Date.now()}`,
    title: `QuickBooks disconnected: ${label}`,
    body: purge ? 'Sync has stopped and the links to QuickBooks were deleted. Your Fishtape records stay.' : 'Sync has stopped. Reconnecting the same company within 30 days keeps the links.',
  });
  return Boolean(purge);
}

/**
 * Disconnect (2.7): fence the engine, revoke at Intuit (a failure goes to qbo_revoke_pending), delete
 * the secrets, the realm row and queued qbo_* jobs, keep the outbox, then optionally purge.
 * `revoke: false` for a takeover or HQ path where the grant must stay live. Whatever `revoke` says,
 * the token is never revoked while another tenant holds the realm (2.2): after an HQ release the
 * realm may already be connected to its rightful company, and the revoke may end the whole grant.
 * @returns {Promise<{ purged: boolean }>}
 */
export async function disconnect(db, sealer, cfg, tenantId, { actor = QBO_ACTOR, request = null, purge = false, revoke = true, action = 'qbo.disconnect', summary = null } = {}) {
  const q = qboCfg(cfg);
  const pre = await tenantDb(db, tenantId, async (tx) => {
    const { rows } = await tx.query(
      'UPDATE qbo_connections SET lease_epoch = lease_epoch + 1, lease_until = NULL, updated_at = now() WHERE tenant_id = $1 RETURNING environment, state, realm_hash', [tenantId]);
    if (!rows[0]) return null;
    return { ...rows[0], token: revoke ? await getSecret(tx, sealer, SECRET_NAMES.refresh, INTERNAL) : null };
  });
  if (!pre) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  const holder = pre.token ? await qboRealmOwner(db, pre.realm_hash) : null;
  if (pre.token && (holder == null || holder === tenantId)) {
    try {
      if (!q.enabled || pre.environment !== q.environment) throw new Error('other environment');
      await revokeToken(q, pre.token);
    } catch {
      await queueRevoke(db, sealer, pre.environment, pre.token, pre.realm_hash);
    }
  }
  const purged = await tenantDb(db, tenantId, (tx) => disconnectTx(tx, { purge, actor, request, action, summary }), { write: true });
  return { purged };
}
