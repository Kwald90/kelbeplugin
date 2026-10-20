// HQ AI page: spend per company and month, top tools, companies near their cap, editing a
// cap, the platform model and effort (env, read-only) and recent AI errors.
//   GET /api/hq/ai                    everything above (staff)
//   PUT /api/hq/ai/caps/:tenantId     set or clear a company's monthly cap (HQ admin; audited in its log)
//
// This plugin also watches AI traffic app-wide (it skips encapsulation like hq-health.js):
// errors on /api/v1/ai/* and /api/mcp, and the `tool` / `error` events inside streamed
// assistant replies, are counted by name and code only. Prompts, replies, keys and upstream
// bodies are never kept.
import { Transform } from 'node:stream';
import { notFound } from '../errors.js';
import { readAiConfig } from '../ai/config.js';
import { microToCents, monthStart } from '../ai/usage.js';
import { hqAudit, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';

const STREAM_ROUTE = '/api/v1/ai/conversations/:id/messages';
const day = (d = new Date()) => d.toISOString().slice(0, 10);

/** Feature name for an AI route. */
export function aiFeatureOf(url = '') {
  if (url.startsWith('/api/mcp')) return 'mcp';
  if (url.startsWith('/api/v1/ai/conversations')) return 'chat';
  if (url.startsWith('/api/v1/ai/')) return url.split('/')[4]?.replace(/[^a-z_]/g, '').slice(0, 30) || 'ai';
  return null;
}

/**
 * Reads server-sent events as they pass and calls onEvent(name, data) for each complete one.
 * Returns a Transform that passes every byte through unchanged.
 */
export function sseTap(onEvent) {
  let buf = '';
  return new Transform({
    transform(chunk, enc, cb) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: ([a-z_]+)$/m.exec(frame)?.[1];
        if (ev === 'tool' || ev === 'error') {
          try { onEvent(ev, JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] || 'null')); } catch { /* not ours to fix */ }
        }
      }
      if (buf.length > 1_000_000) buf = ''; // one huge frame: stop looking, keep streaming
      cb(null, chunk);
    },
  });
}

/** In-memory tool counts, flushed in batches through ai_tool_add(); errors written at once. */
export function createAiRecorder(db, log) {
  let tools = new Map();
  const safe = (p) => p.catch((e) => log?.warn?.({ code: e?.code }, 'ai stats write failed'));
  return {
    tool(tenantId, name, ok) {
      if (!tenantId || !/^[a-z0-9_]{1,64}$/.test(String(name))) return;
      const k = `${day()}|${tenantId}|${name}`;
      const v = tools.get(k) || { calls: 0, errors: 0 };
      v.calls++; if (!ok) v.errors++;
      tools.set(k, v);
    },
    error(tenantId, feature, code, status) {
      const c = String(code || 'internal').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60) || 'internal';
      return safe(db.query('INSERT INTO ai_error_log (tenant_id, feature, code, status) VALUES ($1, $2, $3, $4)', [tenantId || null, String(feature || 'ai').slice(0, 30), c, status || null]));
    },
    async flush() {
      if (!tools.size) return;
      const batch = [...tools.entries()].map(([k, v]) => { const [d, tenantId, tool] = k.split('|'); return { day: d, tenantId, tool, ...v }; });
      tools = new Map();
      await safe(db.query('SELECT ai_tool_add($1::jsonb)', [JSON.stringify(batch)]));
    },
  };
}

/** @param {import('fastify').FastifyInstance} app */
async function hqAiRoutes(app, { db }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];
  const rec = createAiRecorder(db, app.log);
  app.decorate('hqAiStats', rec);
  const timer = setInterval(() => { rec.flush(); }, 30_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); await rec.flush(); });

  app.addHook('onError', async (req, reply, err) => {
    const feature = aiFeatureOf(req.routeOptions?.url || '');
    if (!feature) return;
    const status = err.statusCode >= 400 ? err.statusCode : 500;
    const code = String(err.code || '');
    if (code.startsWith('ai_') || status >= 500) await rec.error(req.principal?.tenantId, feature, status >= 500 && !code.startsWith('ai_') ? 'internal' : code, status);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions?.url !== STREAM_ROUTE || !payload || typeof payload.pipe !== 'function') return payload;
    const tenantId = req.principal?.tenantId;
    const tap = sseTap((ev, data) => {
      if (ev === 'tool' && (data?.status === 'done' || data?.status === 'error')) rec.tool(tenantId, data.name, data.status === 'done');
      if (ev === 'error') rec.error(tenantId, 'chat', data?.code, null);
    });
    payload.on('error', (e) => tap.destroy(e));
    return payload.pipe(tap);
  });

  app.get('/api/hq/ai', {
    config: hq,
    schema: { tags, summary: 'AI spend per company and month, top tools, caps, model and recent errors', querystring: { type: 'object', additionalProperties: false, properties: { months: { type: 'integer', minimum: 1, maximum: 12, default: 6 } } } },
  }, async (req) => {
    await rec.flush();
    const cfg = readAiConfig();
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (req.query.months - 1), 1));
    return db.withHq(async (c) => {
      const usage = (await c.query(
        `SELECT u.tenant_id, t.name, to_char(date_trunc('month', u.at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, count(*)::int AS calls,
                COALESCE(sum(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens), 0)::bigint AS input, COALESCE(sum(u.output_tokens), 0)::bigint AS output,
                COALESCE(sum(u.cost_micro_usd), 0)::bigint AS cost
           FROM ai_usage u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.at >= $1 GROUP BY 1, 2, 3 ORDER BY 3 DESC, cost DESC`, [from])).rows;
      const byFeature = (await c.query(
        `SELECT feature, count(*)::int AS calls, COALESCE(sum(cost_micro_usd), 0)::bigint AS cost FROM ai_usage WHERE at >= $1 GROUP BY 1 ORDER BY cost DESC`, [monthStart(now)])).rows;
      const caps = (await c.query(
        `SELECT t.id, t.name, s.monthly_cap_cents, s.updated_at,
                COALESCE((SELECT sum(cost_micro_usd) FROM ai_usage u WHERE u.tenant_id = t.id AND u.at >= $1), 0)::bigint AS spent,
                (SELECT max(at) FROM ai_usage u WHERE u.tenant_id = t.id) AS last_used
           FROM tenants t LEFT JOIN ai_settings s ON s.tenant_id = t.id WHERE t.status <> 'closed' ORDER BY t.name`, [monthStart(now)])).rows;
      const tools = (await c.query(
        `SELECT tool, 'assistant' AS via, sum(calls)::int AS calls, sum(errors)::int AS errors FROM ai_tool_daily WHERE day >= current_date - 30 GROUP BY tool
         UNION ALL
         SELECT meta->>'tool', 'mcp', count(*)::int, count(*) FILTER (WHERE meta->>'ok' = 'false')::int
           FROM audit_events WHERE action = 'mcp.tool_call' AND at >= now() - interval '30 days' AND meta ? 'tool' GROUP BY 1
         ORDER BY calls DESC LIMIT 20`)).rows;
      const errors = (await c.query(
        `SELECT e.at, e.tenant_id, t.name, e.feature, e.code, e.status FROM ai_error_log e LEFT JOIN tenants t ON t.id = e.tenant_id
         UNION ALL
         SELECT u.at, u.tenant_id, t.name, u.feature, 'stop_' || u.stop_reason, NULL FROM ai_usage u LEFT JOIN tenants t ON t.id = u.tenant_id
          WHERE u.stop_reason IN ('refusal', 'max_tokens') AND u.at > now() - interval '30 days'
         ORDER BY 1 DESC LIMIT 50`)).rows;
      const errorCounts = (await c.query(
        `SELECT code, count(*)::int AS n FROM ai_error_log WHERE at > now() - interval '7 days' GROUP BY code ORDER BY n DESC LIMIT 10`)).rows;
      await hqAudit(c, req, null, { action: 'hq.ai_view', collection: 'ai_usage', summary: 'Viewed AI usage and caps' });
      const capRows = caps.map((r) => {
        const cap = r.monthly_cap_cents ?? cfg.defaultMonthlyCapCents;
        const spent = microToCents(r.spent);
        return { tenantId: r.id, tenantName: r.name, capCents: cap, capIsDefault: r.monthly_cap_cents == null, spentCents: spent, pct: cap > 0 ? Math.round((spent / cap) * 100) : (spent > 0 ? 100 : 0), lastUsedAt: iso(r.last_used), capUpdatedAt: iso(r.updated_at) };
      });
      return {
        config: {
          model: cfg.model, backgroundModel: cfg.backgroundModel, effort: cfg.effort, backgroundEffort: cfg.backgroundEffort,
          defaultCapCents: cfg.defaultMonthlyCapCents, maxSteps: cfg.maxSteps, fallbacks: cfg.fallbacks, thinkingDisplay: cfg.thinkingDisplay,
          env: ['AI_MODEL', 'AI_EFFORT', 'AI_BACKGROUND_MODEL', 'AI_BACKGROUND_EFFORT', 'AI_DEFAULT_MONTHLY_CAP_CENTS', 'AI_MAX_STEPS'],
        },
        monthTotal: { costCents: microToCents(byFeature.reduce((a, r) => a + Number(r.cost), 0)), calls: byFeature.reduce((a, r) => a + r.calls, 0), byFeature: byFeature.map((r) => ({ feature: r.feature, calls: r.calls, costCents: microToCents(r.cost) })) },
        usage: usage.map((r) => ({ tenantId: r.tenant_id, tenantName: r.name, month: r.month, calls: r.calls, inputTokens: r.input, outputTokens: r.output, costCents: microToCents(r.cost) })),
        caps: capRows.filter((r) => r.spentCents > 0 || !r.capIsDefault).sort((a, b) => b.pct - a.pct),
        nearCap: capRows.filter((r) => r.pct >= 80).sort((a, b) => b.pct - a.pct),
        companies: capRows.map(({ tenantId, tenantName, capCents, capIsDefault }) => ({ tenantId, tenantName, capCents, capIsDefault })),
        tools: tools.map((r) => ({ tool: r.tool, via: r.via, calls: r.calls, errors: r.errors })),
        errors: errors.map((r) => ({ at: iso(r.at), tenantId: r.tenant_id, tenantName: r.name, feature: r.feature, code: r.code, status: r.status })),
        errorCounts: errorCounts.map((r) => ({ code: r.code, count: r.n })),
      };
    });
  });

  app.put('/api/hq/ai/caps/:tenantId', {
    config: hq,
    schema: {
      tags, summary: 'Set a company\'s monthly AI cap in US cents, or null for the default (HQ admin; audited in the company\'s log)', params: uuidParams('tenantId'),
      body: {
        type: 'object', required: ['monthlyCapCents', 'reason'], additionalProperties: false,
        properties: { monthlyCapCents: { type: ['integer', 'null'], minimum: 0, maximum: 100000000 }, reason: { type: 'string', minLength: 5, maxLength: 300 } },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const cfg = readAiConfig();
    const { tenantId } = req.params;
    const cap = req.body.monthlyCapCents;
    return db.withHq(async (c) => {
      const t = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0];
      if (!t) throw notFound('No such company.');
      const before = (await c.query('SELECT monthly_cap_cents FROM ai_settings WHERE tenant_id = $1', [tenantId])).rows[0]?.monthly_cap_cents ?? null;
      await c.query(
        `INSERT INTO ai_settings (tenant_id, monthly_cap_cents, updated_at, updated_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (tenant_id) DO UPDATE SET monthly_cap_cents = EXCLUDED.monthly_cap_cents, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, cap, `hq:${req.principal.userId}`]);
      const fmt = (v) => (v == null ? `default (US$${(cfg.defaultMonthlyCapCents / 100).toFixed(2)})` : `US$${(v / 100).toFixed(2)}`);
      const summary = `${'Fishtape HQ'} changed the monthly AI cap from ${fmt(before)} to ${fmt(cap)}: ${req.body.reason.trim()}`.slice(0, 500);
      await hqAudit(c, req, tenantId, { action: 'hq.ai_cap_set', collection: 'ai_settings', recordId: tenantId, summary, meta: { from: before, to: cap } });
      await hqAudit(c, req, null, { action: 'hq.ai_cap_set', collection: 'ai_settings', recordId: tenantId, summary: `AI cap for ${t.name}: ${fmt(before)} -> ${fmt(cap)}`.slice(0, 500) });
      return { tenantId, monthlyCapCents: cap ?? cfg.defaultMonthlyCapCents, capIsDefault: cap == null };
    });
  });
}

hqAiRoutes[Symbol.for('skip-override')] = true;
hqAiRoutes[Symbol.for('fastify.display-name')] = 'hq-ai';

export default hqAiRoutes;
