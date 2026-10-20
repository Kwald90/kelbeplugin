// HQ developer page:
//   GET /api/hq/developer            environment and version, migrations, recent server errors
//   GET /api/hq/developer/usage      API requests per company and per API key (last N days)
//   GET /api/hq/developer/webhooks   webhook deliveries: company integrations + Fishtape's Stripe
// GET /api/hq/openapi.json is the API document for the explorer; feature flags and developer
// health have their own pages.
//
// This plugin also counts requests app-wide (it skips encapsulation like hq-health.js):
// per company, day and credential (API key id or 'session'), flushed in batches through
// api_usage_add(); and keeps the last server errors in memory: time, route pattern, status,
// error code and request id. No URLs with ids, bodies or messages are kept.
import { hostname } from 'node:os';
import { migrationStatus } from '../migrate.js';
import { hqAudit, hqUrl, iso } from '../services/hq-common.js';

const RING = 100;
const day = (d = new Date()) => d.toISOString().slice(0, 10);

/** Request counts per (day, company, credential), flushed in one statement. */
export function createUsageCounter(db, log) {
  let counts = new Map();
  return {
    record(p, status) {
      if (!p?.tenantId) return;
      const actorKey = p.kind === 'api_key' && p.apiKeyId ? p.apiKeyId : 'session';
      const k = `${day()}|${p.tenantId}|${actorKey}`;
      const v = counts.get(k) || { requests: 0, e4: 0, e5: 0 };
      v.requests++;
      if (status >= 500) v.e5++; else if (status >= 400) v.e4++;
      counts.set(k, v);
    },
    async flush() {
      if (!counts.size) return;
      const batch = [...counts.entries()].map(([k, v]) => { const [d, tenantId, actorKey] = k.split('|'); return { day: d, tenantId, actorKey, ...v }; });
      counts = new Map();
      try { await db.query('SELECT api_usage_add($1::jsonb)', [JSON.stringify(batch)]); } catch (e) { log?.warn?.({ code: e?.code }, 'api usage write failed'); }
    },
  };
}

/** The last RING server errors (5xx) seen by this process. */
export function createErrorRing(size = RING) {
  const items = [];
  return {
    add(e) { items.push(e); if (items.length > size) items.shift(); },
    list() { return [...items].reverse(); },
  };
}

/** @param {import('fastify').FastifyInstance} app */
async function hqDeveloperRoutes(app, { config, db }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];
  const startedAt = new Date().toISOString();
  const usage = createUsageCounter(db, app.log);
  const ring = createErrorRing();
  app.decorate('hqUsage', usage);
  const timer = setInterval(() => { usage.flush(); }, 30_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); await usage.flush(); });

  app.addHook('onError', async (req, reply, err) => {
    req.ftErrorCode = String(err.code || err.name || 'error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  });
  app.addHook('onResponse', async (req, reply) => {
    usage.record(req.principal, reply.statusCode);
    if (reply.statusCode >= 500) {
      ring.add({ at: new Date().toISOString(), method: req.method, route: req.routeOptions?.url || 'unmatched', status: reply.statusCode, code: req.ftErrorCode || null, requestId: req.id, ms: Math.round(reply.elapsedTime) });
    }
  });

  app.get('/api/hq/developer', { config: hq, schema: { tags, summary: 'Environment, version, migrations and recent server errors' } }, async (req) => {
    const m = await migrationStatus(db);
    const metrics = req.server.hqMetrics?.snapshot?.() || null;
    return {
      environment: config.appEnv, version: config.version, gitSha: config.gitSha, node: process.version, host: hostname(), pid: process.pid,
      startedAt, uptimeSeconds: Math.round(process.uptime()), publicOrigin: config.publicOrigin, hqUrl: hqUrl(config),
      migrations: { current: m.current, latest: m.latest, pending: m.pending },
      links: { openapi: '/api/v1/openapi.json', status: '/api/v1/status', readyz: '/api/readyz' },
      errors: { recent: ring.list(), byRoute: metrics?.errorRoutes || [], lastHour: metrics?.lastHour || null, since: metrics?.since || startedAt },
    };
  });

  // The same document as the public /api/v1/openapi.json, under /api/hq/ so the explorer works
  // on hq.fishtapehq.com (its nginx sends only /api/hq/ and sign-in to hq-api).
  app.get('/api/hq/openapi.json', { config: hq, schema: { hide: true } }, async (req) => req.server.swagger());

  app.get('/api/hq/developer/usage', {
    config: hq,
    schema: { tags, summary: 'API requests per company and per API key', querystring: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 30 } } } },
  }, async (req) => {
    await usage.flush();
    return db.withHq(async (c) => {
      const rows = (await c.query(
        `SELECT u.tenant_id, t.name AS tenant_name, u.actor_key, k.name AS key_name, k.prefix, k.revoked_at, k.last_used_at,
                sum(u.requests)::int AS requests, sum(u.errors_4xx)::int AS e4, sum(u.errors_5xx)::int AS e5, max(u.day) AS last_day
           FROM api_usage_daily u JOIN tenants t ON t.id = u.tenant_id
           LEFT JOIN api_keys k ON u.actor_key <> 'session' AND k.id::text = u.actor_key
          WHERE u.day > current_date - $1::int
          GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY requests DESC`, [req.query.days])).rows;
      const daily = (await c.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(requests)::int AS requests, sum(requests) FILTER (WHERE actor_key <> 'session')::int AS api_key_requests
           FROM api_usage_daily WHERE day > current_date - $1::int GROUP BY 1 ORDER BY 1`, [req.query.days])).rows;
      const companies = new Map();
      for (const r of rows) {
        const co = companies.get(r.tenant_id) || { tenantId: r.tenant_id, tenantName: r.tenant_name, requests: 0, apiKeyRequests: 0, errors4xx: 0, errors5xx: 0 };
        co.requests += r.requests; co.errors4xx += r.e4; co.errors5xx += r.e5;
        if (r.actor_key !== 'session') co.apiKeyRequests += r.requests;
        companies.set(r.tenant_id, co);
      }
      return {
        days: req.query.days,
        companies: [...companies.values()].sort((a, b) => b.requests - a.requests),
        keys: rows.filter((r) => r.actor_key !== 'session').map((r) => ({
          tenantId: r.tenant_id, tenantName: r.tenant_name, keyId: r.actor_key, name: r.key_name || 'deleted key', prefix: r.prefix || null,
          revoked: Boolean(r.revoked_at), lastUsedAt: iso(r.last_used_at), requests: r.requests, errors4xx: r.e4, errors5xx: r.e5,
        })),
        daily: daily.map((d) => ({ day: d.day, requests: d.requests, apiKeyRequests: d.api_key_requests || 0 })),
      };
    });
  });

  app.get('/api/hq/developer/webhooks', { config: hq, schema: { tags, summary: 'Webhook deliveries: company integrations (ids and kinds) and Fishtape\'s Stripe events' } }, async (req) => {
    return db.withHq(async (c) => {
      const company = (await c.query(
        `SELECT e.tenant_id, t.name AS tenant_name, e.provider, e.event_id, e.kind, e.received_at
           FROM integration_events e JOIN tenants t ON t.id = e.tenant_id ORDER BY e.received_at DESC LIMIT 200`)).rows;
      const byProvider = (await c.query(
        `SELECT provider, count(*)::int AS n, max(received_at) AS last_at FROM integration_events WHERE received_at > now() - interval '7 days' GROUP BY provider`)).rows;
      const platform = (await c.query(
        `SELECT e.id, e.type, e.tenant_id, t.name AS tenant_name, e.outcome, e.received_at
           FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.received_at DESC LIMIT 100`)).rows;
      await hqAudit(c, req, null, { action: 'hq.webhooks_view', collection: 'integration_events', summary: 'Viewed the webhook delivery log' });
      const clip = (id) => (id && id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id);
      return {
        company: company.map((e) => ({ tenantId: e.tenant_id, tenantName: e.tenant_name, provider: e.provider, eventId: clip(e.event_id), kind: e.kind, at: iso(e.received_at) })),
        byProvider: byProvider.map((r) => ({ provider: r.provider, last7Days: r.n, lastAt: iso(r.last_at) })),
        platform: platform.map((e) => ({ id: clip(e.id), type: e.type, tenantId: e.tenant_id, tenantName: e.tenant_name, outcome: e.outcome, at: iso(e.received_at) })),
      };
    });
  });
}

hqDeveloperRoutes[Symbol.for('skip-override')] = true;
hqDeveloperRoutes[Symbol.for('fastify.display-name')] = 'hq-developer';

export default hqDeveloperRoutes;
