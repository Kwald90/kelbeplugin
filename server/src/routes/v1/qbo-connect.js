// QuickBooks connection routes (docs/integrations/quickbooks.md 2.2, 2.6, 2.7, 2.9, 7.2): status, the
// connect ticket, the public start / callback / done / launch / disconnected pages, takeover,
// disconnect and pause. The OAuth work is W1's (qbo/connection.js); these routes only carry it.
// Office routes are owner, admin and office sessions only (requireQboRole): field roles, crew
// sessions and API keys get 403. Routes that change anything need a two-step-verified session.
// Responses never carry tokens, realm ids or Intuit ids of the realm; the callback answers 302 only.
import { ApiError, validationFailed } from '../../errors.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { loadTenantPlan, tenantHas, requireFeature, onTrial } from '../../services/entitlements.js';
import { FEATURE_PLAN } from '../../../../electrical-app/js/plans.js';
import { qboCfg } from '../../qbo/env.js';
import { requireQboRole } from '../../qbo/roles.js';
import {
  FLOW_COOKIE, FLOW_COOKIE_PATH, flowCookieOptions, createConnectTicket, startPage, startFromTicket, completeCallback, takeover,
  disconnect, setPaused, loadConnection, hasTakeoverOffer,
} from '../../qbo/connection.js';
import { PAGE_HEADERS, RESULT_TEXT, donePage, disconnectedPage } from '../../qbo/pages.js';
import { budgetGate } from '../../qbo/client.js';
import { errorResponses, tenantCtx } from '../util.js';

const tags = ['quickbooks'];
const TICKET_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 503 qbo_unavailable when QBO_ENVIRONMENT is unset (every QuickBooks route but status, 7.1). */
export const qboAvailable = (config) => async () => {
  if (!qboCfg(config).enabled) throw new ApiError(503, 'qbo_unavailable', 'QuickBooks is not available on this server.');
};

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The Status object of 7.2 for an office user. */
export async function buildStatus(db, config, p) {
  const q = qboCfg(config);
  const tenantId = p.tenantId;
  const plan = await loadTenantPlan(db, tenantId);
  const entitled = Boolean(plan && tenantHas(plan, 'quickbooks'));
  const base = { available: q.enabled, environment: q.environment, plan: { entitled, needs: FEATURE_PLAN.quickbooks || 'pro' }, writesEnabled: q.writesEnabled };
  if (!q.enabled) return { ...base, state: 'not_connected' };
  return db.withTenant(tenantCtx(p), async (tx) => {
    const c = await loadConnection(tx);
    if (!c) return { ...base, state: 'not_connected', takeoverOffer: await hasTakeoverOffer(db, tenantId, p.userId) };
    const counts = (await tx.query(
      `SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending, count(*) FILTER (WHERE state = 'error')::int AS error,
              count(*) FILTER (WHERE state = 'blocked')::int AS blocked, count(*) FILTER (WHERE state = 'conflict')::int AS conflict,
              count(*) FILTER (WHERE state = 'needs_review')::int AS needs_review, count(*) FILTER (WHERE meta ? 'mismatch')::int AS mismatch
         FROM qbo_links WHERE tenant_id = $1 AND realm_hash = $2`, [tx.tenantId, c.realm_hash])).rows[0];
    const waiting = c.state === 'active' ? 0 : (await tx.query('SELECT count(*)::int AS n FROM qbo_outbox WHERE tenant_id = $1', [tx.tenantId])).rows[0].n;
    const opt = (await tx.query("SELECT key, value FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'option' AND key IN ('writeMode', 'syncFrom')", [tx.tenantId])).rows;
    const by = c.connected_by ? (await tx.query('SELECT display_name FROM users WHERE id = $1', [c.connected_by])).rows[0]?.display_name || null : null;
    const month = `${new Date().toISOString().slice(0, 7)}-01`;
    const used = (await tx.query("SELECT coreplus_calls FROM qbo_api_usage WHERE month = $1 AND tenant_id = $2 AND environment = 'production'", [month, tx.tenantId])).rows[0]?.coreplus_calls || 0;
    const budget = plan && onTrial(plan) ? q.trialReadBudget : q.tenantReadBudget;
    const lookupsEnabled = q.environment !== 'production' || !budgetGate('lookup', budget ? (used / budget) * 100 : 0, 0);
    const f = c.features || {};
    return {
      ...base,
      state: c.state, pauseReason: c.pause_reason, reconnectReason: c.reconnect_reason, companyName: c.company_name,
      features: {
        edition: f.edition ?? null, salesTax: Boolean(f.salesTax), customTxnNumbers: Boolean(f.customTxnNumbers), purchaseOrders: f.purchaseOrders !== false,
        timeTracking: f.timeTracking !== false, bills: f.bills !== false, classes: Boolean(f.classes), locations: Boolean(f.locations), projects: Boolean(f.projects),
        multicurrency: Boolean(f.multicurrency), taxFiledThrough: f.taxFiledThrough ?? null, province: f.province ?? null,
      },
      connectedAt: iso(c.connected_at), connectedBy: by,
      syncFrom: (opt.find((o) => o.key === 'syncFrom')?.value) || (c.sync_from ? new Date(c.sync_from).toISOString().slice(0, 10) : null),
      lastPullAt: iso(c.last_pull_at), lastPushAt: iso(c.last_push_at),
      counts: { pending: counts.pending, error: counts.error, blocked: counts.blocked, conflict: counts.conflict, needsReview: counts.needs_review, mismatch: counts.mismatch, waitingOffline: waiting },
      writeMode: opt.find((o) => o.key === 'writeMode')?.value === 'shadow' ? 'shadow' : 'live',
      refreshExpiresAt: iso(c.refresh_expires_at), hardExpiresAt: iso(c.refresh_hard_expires_at),
      setup: { phase: c.setup?.phase || null, done: c.setup?.done ?? 0, total: c.setup?.total ?? 0, errors: c.setup?.errors ?? 0, finishedAt: c.setup?.finishedAt ?? null },
      lookupsEnabled,
      ...(c.pause_reason === 'brake' ? { brake: { count: c.brake_allow_count ?? null } } : {}),
      takeoverOffer: await hasTakeoverOffer(db, tenantId, p.userId),
    };
  });
}

/** @param {import('fastify').FastifyInstance} app */
export default async function qboConnectRoutes(app, { config, db }) {
  const sealer = app.sealer;
  const office = (write = false) => ({ config: { auth: 'manager', apiKey: false }, preHandler: [requireQboRole('office', { write })] });
  const admin = (write = true) => ({ config: { auth: 'admin', apiKey: false }, preHandler: [requireQboRole('admin', { write })] });
  const available = qboAvailable(config);
  const feature = requireFeature(db, 'quickbooks');

  // The interstitial's form posts here (application/x-www-form-urlencoded), only in this plugin.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body))); } catch (e) { done(e); }
  });

  app.get('/api/v1/qbo/status', {
    ...office(false),
    schema: { tags, summary: 'QuickBooks connection status for the office (counts, state, setup progress)', response: errorResponses },
  }, async (req) => buildStatus(db, config, req.principal));

  app.post('/api/v1/qbo/connect', {
    ...admin(true),
    preHandler: [requireQboRole('admin', { write: true }), available, feature],
    schema: {
      tags, summary: 'Start connecting QuickBooks: a one-time ticket URL to open (120 seconds)',
      body: { type: 'object', additionalProperties: false, required: ['returnTo'], properties: { returnTo: { type: 'string', enum: ['web', 'app'] }, reconnect: { type: 'boolean' } } },
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    return createConnectTicket(db, config, { tenantId: p.tenantId, userId: p.userId, returnTo: req.body.returnTo, reconnect: Boolean(req.body.reconnect) });
  });

  // ---- public pages (logged at warn: no request line with a ticket, code or realm) ----
  const pub = { logLevel: 'warn', config: { auth: 'public' }, schema: { hide: true } };

  app.get('/api/v1/qbo/oauth/start', pub, async (req, reply) => {
    const ticket = typeof req.query?.ticket === 'string' && TICKET_RE.test(req.query.ticket) ? req.query.ticket : '';
    const r = await startPage(db, config, ticket, { sessionUserId: req.auth?.session?.user_id || null });
    if (r.redirect) return reply.code(302).header('location', r.redirect).header('cache-control', 'no-store').send();
    for (const [k, v] of Object.entries(r.headers || {})) reply.header(k, v);
    return reply.code(200).send(r.html);
  });

  app.post('/api/v1/qbo/oauth/start', { ...pub, config: { auth: 'public', csrf: false } }, async (req, reply) => {
    const ticket = typeof req.body?.ticket === 'string' && TICKET_RE.test(req.body.ticket) ? req.body.ticket : '';
    const r = await startFromTicket(db, sealer, config, ticket);
    if (r.flowCookie) reply.setCookie(FLOW_COOKIE, r.flowCookie, flowCookieOptions(config));
    return reply.code(302).header('location', r.redirect).header('cache-control', 'no-store').send();
  });

  app.get('/api/v1/qbo/oauth/callback', pub, async (req, reply) => {
    const qs = req.query || {};
    const s = (v) => (typeof v === 'string' ? v.slice(0, 512) : undefined);
    const r = await completeCallback(db, sealer, config, {
      code: s(qs.code), state: s(qs.state), realmId: s(qs.realmId), error: s(qs.error),
      flowCookie: req.cookies?.[FLOW_COOKIE] || null, sessionUserId: req.auth?.session?.user_id || null,
    });
    reply.clearCookie(FLOW_COOKIE, { ...flowCookieOptions(config), path: FLOW_COOKIE_PATH, maxAge: 0 });
    return reply.code(302).header('location', r.redirect).header('cache-control', 'no-store').send();
  });

  app.get('/api/v1/qbo/oauth/done', pub, async (req, reply) => {
    // Only the page's own result keys (never an inherited name such as constructor).
    const raw = typeof req.query?.result === 'string' ? req.query.result : '';
    const result = /^[a-z_]{1,40}$/.test(raw) && Object.hasOwn(RESULT_TEXT, raw) ? raw : 'exchange_failed';
    for (const [k, v] of Object.entries(PAGE_HEADERS)) reply.header(k, v);
    return reply.code(200).send(donePage(result));
  });

  app.get('/api/v1/qbo/launch', pub, async (req, reply) => {
    const to = `${config.publicOrigin}/#/quickbooks${req.query?.connect === '1' ? '?connect=1' : ''}`;
    return reply.code(302).header('location', to).header('cache-control', 'no-store').send();
  });

  app.get('/api/v1/qbo/disconnected', pub, async (req, reply) => {
    for (const [k, v] of Object.entries(PAGE_HEADERS)) reply.header(k, v);
    return reply.code(200).send(disconnectedPage());
  });

  // ---- takeover, disconnect, pause ----

  app.post('/api/v1/qbo/connect/takeover', {
    ...admin(true),
    preHandler: [requireQboRole('admin', { write: true }), available, feature],
    schema: { tags, summary: 'Move a QuickBooks company connected to another Fishtape company to this one', body: { type: 'object', required: ['confirm'], properties: { confirm: { const: true } } }, response: errorResponses },
  }, async (req) => {
    const p = req.principal;
    return takeover(db, sealer, config, { tenantId: p.tenantId, userId: p.userId, actor: p.actor, request: requestFacts(req) });
  });

  app.post('/api/v1/qbo/disconnect', {
    ...admin(true),
    preHandler: [requireQboRole('admin', { write: true }), available],
    schema: { tags, summary: 'Disconnect QuickBooks; purge deletes the links now (otherwise after 30 days)', body: { type: 'object', additionalProperties: false, properties: { purge: { type: 'boolean' } } }, response: errorResponses },
  }, async (req) => {
    const p = req.principal;
    const r = await disconnect(db, sealer, config, p.tenantId, { actor: p.actor, request: requestFacts(req), purge: Boolean(req.body?.purge) });
    return { ok: true, purged: r.purged };
  });

  app.post('/api/v1/qbo/pause', {
    ...office(true),
    preHandler: [requireQboRole('office', { write: true }), available, feature],
    schema: {
      tags, summary: 'Pause or resume QuickBooks sync (a safety-brake pause needs allowCount)',
      body: { type: 'object', additionalProperties: false, required: ['paused'], properties: { paused: { type: 'boolean' }, allowCount: { type: 'integer', minimum: 0, maximum: 1000000 } } },
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    const conn = await db.withTenant(tenantCtx(p), loadConnection);
    if (!conn || conn.state === 'disconnected') throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
    if (!req.body.paused && conn.pause_reason && conn.pause_reason !== 'user' && conn.pause_reason !== 'brake') {
      throw new ApiError(409, 'qbo_pause_locked', conn.pause_reason === 'hq' ? 'Paused by Fishtape support.' : "This pause can't be lifted here.", { pauseReason: conn.pause_reason });
    }
    if (req.body.paused === false && req.body.allowCount != null && !Number.isInteger(req.body.allowCount)) throw validationFailed('allowCount must be a whole number.');
    await setPaused(db, p.tenantId, req.body.paused, 'user', { allowCount: req.body.allowCount ?? null });
    await db.withTenant(tenantCtx(p), (tx) => appendAudit(tx, p.tenantId, {
      actor: p.actor, action: req.body.paused ? 'qbo.pause' : 'qbo.resume', collection: 'qbo_connections', request: requestFacts(req),
      summary: req.body.paused ? 'Paused QuickBooks sync' : `Resumed QuickBooks sync${req.body.allowCount != null ? ` (allowed ${req.body.allowCount} changes)` : ''}`,
    }));
    return buildStatus(db, config, p);
  });
}
