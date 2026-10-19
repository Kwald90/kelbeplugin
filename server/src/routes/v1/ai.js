// /api/v1/ai/*: the assistant and CEC helper (streamed chat), drafts people accept,
// background suggestions, usage and the company's AI settings. Signed-in people only
// (API keys use the MCP server at /api/mcp). Every call uses the company's own Anthropic
// key; plan features: ai.assistant, ai.cec, ai.background (Business).
import { PassThrough } from 'node:stream';
import { ApiError, conflict, forbidden, notFound } from '../../errors.js';
import { ADMIN_ROLES } from '../../auth/permissions.js';
import { canRead } from '../../auth/access.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { getSecret } from '../../services/secrets.js';
import { assertFeature, loadTenantPlan, tenantHas } from '../../services/entitlements.js';
import { readAiConfig } from '../../ai/config.js';
import { createChat } from '../../ai/chat.js';
import { ANTHROPIC_SECRET } from '../../ai/client.js';
import { aiSettings, monthUsage, monthUsageByFeature } from '../../ai/usage.js';
import { acceptDraft, discardDraft, getDraft, listDrafts } from '../../ai/drafts.js';
import { backgroundPrincipal, scanTenant } from '../../ai/background.js';
import { tenantCtx, who } from '../util.js';

const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const tags = ['ai'];
const session = { auth: 'tenant', apiKey: false };
const MB = 1024 * 1024;

/** Which permission a suggestion kind needs to be seen and acted on. */
const SUGGESTION_READ = {
  overdue_invoice: 'invoices', permit_expiry: 'permits', certification_expiry: 'certifications',
  licence_expiry: 'employees', low_stock: 'items', unapproved_time: 'timeEntries',
};

const suggestionView = (r, outbox) => ({
  id: r.id, kind: r.kind, status: r.status, title: r.title, detail: r.detail, related: r.related_id ? { collection: r.related_collection, id: r.related_id } : null,
  draftedBy: r.drafted_by, createdAt: r.created_at, decidedAt: r.decided_at,
  message: outbox ? { id: outbox.id, channel: outbox.channel, to: outbox.to, subject: outbox.subject, body: outbox.body, status: outbox.status } : null,
});

/** @param {import('fastify').FastifyInstance} app */
export default async function aiRoutes(app, { db, records }) {
  const aiCfg = readAiConfig();
  const chat = createChat({ db, sealer: app.sealer, records, aiCfg, log: app.log });
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);
  const isAdmin = (p) => ADMIN_ROLES.includes(p.role) && !p.crew;

  // ---- status, settings, usage ---------------------------------------------

  app.get('/api/v1/ai/status', { config: session, schema: { tags, summary: 'Is AI connected and in the plan, this month\'s usage and cap' } }, async (req) => {
    const p = req.principal;
    const t = await loadTenantPlan(db, p.tenantId);
    return inTenant(req, async (tx) => {
      const connected = Boolean(await getSecret(tx, app.sealer, ANTHROPIC_SECRET));
      const s = await aiSettings(tx, aiCfg);
      const u = await monthUsage(tx);
      return {
        connected,
        features: { assistant: tenantHas(t, 'ai.assistant'), cec: tenantHas(t, 'ai.cec'), background: tenantHas(t, 'ai.background'), mcp: tenantHas(t, 'mcp') },
        model: aiCfg.model,
        usage: { since: u.since, calls: u.calls, inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, outputTokens: u.outputTokens, costCents: u.costCents },
        cap: { monthlyCapCents: s.monthlyCapCents, isDefault: s.capIsDefault, reached: u.costMicroUsd >= s.monthlyCapCents * 10_000 },
        settings: { backgroundEnabled: s.backgroundEnabled, backgroundAiDrafts: s.backgroundAiDrafts },
        canManage: isAdmin(p),
      };
    });
  });

  app.put('/api/v1/ai/settings', {
    config: { auth: 'admin' },
    schema: {
      tags, summary: 'Set the monthly AI cap (US cents of estimated spend; null = default) and background agent options',
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          monthlyCapCents: { type: ['integer', 'null'], minimum: 0, maximum: 10_000_000 },
          backgroundEnabled: { type: 'boolean' },
          backgroundAiDrafts: { type: 'boolean' },
        },
      },
    },
  }, async (req) => inTenant(req, async (tx) => {
    const b = req.body;
    const cur = await aiSettings(tx, aiCfg);
    const next = {
      cap: 'monthlyCapCents' in b ? b.monthlyCapCents : (cur.capIsDefault ? null : cur.monthlyCapCents),
      bg: b.backgroundEnabled ?? cur.backgroundEnabled,
      bgAi: b.backgroundAiDrafts ?? cur.backgroundAiDrafts,
    };
    await tx.query(
      `INSERT INTO ai_settings (tenant_id, monthly_cap_cents, background_enabled, background_ai_drafts, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET monthly_cap_cents = EXCLUDED.monthly_cap_cents, background_enabled = EXCLUDED.background_enabled,
         background_ai_drafts = EXCLUDED.background_ai_drafts, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tx.tenantId, next.cap, next.bg, next.bgAi, `user:${req.principal.userId}`]);
    await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'ai.settings_update', summary: 'AI settings changed', meta: { fields: Object.keys(b) }, request: requestFacts(req) });
    return aiSettings(tx, aiCfg);
  }, { write: true }));

  app.get('/api/v1/ai/usage', { config: { auth: 'manager' }, schema: { tags, summary: 'This month\'s AI usage by feature (estimated cost in US cents)' } }, async (req) => inTenant(req, async (tx) => {
    const s = await aiSettings(tx, aiCfg);
    return { month: await monthUsage(tx), byFeature: await monthUsageByFeature(tx), monthlyCapCents: s.monthlyCapCents };
  }));

  // ---- conversations --------------------------------------------------------

  app.post('/api/v1/ai/conversations', {
    config: session,
    schema: {
      tags, summary: 'Start a conversation with the assistant or the CEC helper',
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['assistant', 'cec'], default: 'assistant' },
          units: { type: 'string', enum: ['metric', 'imperial'] },
          title: { type: 'string', maxLength: 200 },
          screen: {
            type: 'object', additionalProperties: false, required: ['collection', 'id'],
            properties: { collection: { type: 'string', enum: ['estimates', 'invoices', 'jobs'] }, id: { type: 'string', minLength: 1, maxLength: 128 }, label: { type: 'string', maxLength: 60 } },
          },
        },
      },
    },
  }, async (req, reply) => {
    const c = await chat.start(req.principal, req.body || {});
    reply.code(201);
    return c;
  });

  app.get('/api/v1/ai/conversations', { config: session, schema: { tags, summary: 'Your recent conversations' } }, async (req) => ({ data: await chat.list(req.principal) }));

  app.get('/api/v1/ai/conversations/:id', { config: session, schema: { tags, summary: 'A conversation with its messages and drafts', params: uuidParam } },
    async (req) => chat.get(req.principal, req.params.id));

  app.delete('/api/v1/ai/conversations/:id', { config: session, schema: { tags, summary: 'Delete one of your conversations', params: uuidParam } },
    async (req) => chat.remove(req.principal, req.params.id));

  app.post('/api/v1/ai/conversations/:id/messages', {
    config: session,
    bodyLimit: 14 * MB,
    schema: {
      tags, summary: 'Send a message; the reply streams back as server-sent events',
      description: 'Events: start, text_start, text {delta}, progress {delta}, tool {id,name,status,label}, draft {draft}, notice {message}, error {code,message}, done {stopReason,usage}. Errors found before streaming (no key, plan, cap, busy) are normal JSON errors.',
      params: uuidParam,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string', maxLength: 20000 },
          images: {
            type: 'array', maxItems: 3,
            items: { type: 'object', additionalProperties: false, required: ['mediaType', 'data'], properties: { mediaType: { type: 'string', maxLength: 40 }, data: { type: 'string', maxLength: 4_200_000 } } },
          },
        },
      },
    },
  }, async (req, reply) => {
    const prep = await chat.prepare(req.principal, req.params.id, req.body);
    const out = new PassThrough();
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    const emit = (event, data) => { if (!out.writableEnded) out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    chat.run(prep, emit, { signal: ac.signal, request: requestFacts(req) }).finally(() => out.end());
    reply.header('content-type', 'text/event-stream; charset=utf-8').header('x-accel-buffering', 'no');
    return reply.send(out);
  });

  // ---- drafts -----------------------------------------------------------------

  app.get('/api/v1/ai/drafts', {
    config: session,
    schema: { tags, summary: 'Drafts proposed by the assistant or agents', querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['proposed', 'accepted', 'discarded'], default: 'proposed' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
  }, async (req) => ({ data: await inTenant(req, (tx) => listDrafts(tx, req.principal, req.query)) }));

  app.get('/api/v1/ai/drafts/:id', { config: session, schema: { tags, summary: 'One draft with its proposed lines and totals', params: uuidParam } },
    async (req) => inTenant(req, (tx) => getDraft(tx, req.principal, req.params.id)));

  app.post('/api/v1/ai/drafts/:id/accept', {
    config: session,
    schema: { tags, summary: 'Accept a draft: writes the estimate lines or a draft invoice as you', params: uuidParam },
  }, async (req) => inTenant(req, (tx) => acceptDraft(tx, req.principal, records, req.params.id, who(req)), { write: true }));

  app.post('/api/v1/ai/drafts/:id/discard', { config: session, schema: { tags, summary: 'Discard a draft', params: uuidParam } },
    async (req) => inTenant(req, (tx) => discardDraft(tx, req.principal, req.params.id, who(req)), { write: true }));

  // ---- background suggestions ---------------------------------------------------

  const visibleKinds = (p) => Object.entries(SUGGESTION_READ).filter(([, c]) => canRead(p, c)).map(([k]) => k);

  async function loadSuggestion(tx, p, id) {
    const { rows } = await tx.query('SELECT * FROM ai_suggestions WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tx.tenantId, id]);
    const s = rows[0];
    if (!s || !visibleKinds(p).includes(s.kind)) throw notFound();
    if (!p.isManager || p.crew) throw forbidden('A manager approves or dismisses suggestions.');
    if (s.status !== 'open') throw conflict(`This suggestion was already ${s.status}.`);
    return s;
  }

  async function outboxOf(tx, s) {
    if (!s.outbox_id) return null;
    const { rows } = await tx.query('SELECT id, data FROM outbox WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, s.outbox_id]);
    return rows[0] ? { ...rows[0].data, id: rows[0].id } : null;
  }

  app.get('/api/v1/ai/suggestions', {
    config: session,
    schema: { tags, summary: 'Suggestions from the background agents', querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'approved', 'dismissed'], default: 'open' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } },
  }, async (req) => inTenant(req, async (tx) => {
    const kinds = visibleKinds(req.principal);
    const { rows } = await tx.query(
      'SELECT * FROM ai_suggestions WHERE tenant_id = $1 AND status = $2 AND kind = ANY($3) ORDER BY created_at DESC LIMIT $4',
      [tx.tenantId, req.query.status, kinds, req.query.limit]);
    const ids = rows.map((r) => r.outbox_id).filter(Boolean);
    const ob = ids.length ? (await tx.query('SELECT id, data FROM outbox WHERE tenant_id = $1 AND id = ANY($2) AND deleted_at IS NULL', [tx.tenantId, ids])).rows : [];
    const byId = new Map(ob.map((o) => [o.id, { ...o.data, id: o.id }]));
    return { data: rows.map((r) => suggestionView(r, byId.get(r.outbox_id))) };
  }));

  app.post('/api/v1/ai/suggestions/:id/approve', {
    config: session,
    schema: {
      tags, summary: 'Approve a suggestion: its draft message (optionally edited) is queued for sending, or its task is queued',
      params: uuidParam,
      body: { type: ['object', 'null'], additionalProperties: false, properties: { subject: { type: 'string', maxLength: 300 }, body: { type: 'string', maxLength: 20000 }, to: { type: 'string', maxLength: 320 } } },
    },
  }, async (req) => inTenant(req, async (tx) => {
    const s = await loadSuggestion(tx, req.principal, req.params.id);
    const w = who(req);
    let message = await outboxOf(tx, s);
    if (message) {
      const edits = Object.fromEntries(Object.entries(req.body || {}).filter(([, v]) => v !== undefined));
      // The draft belongs to the background agent; the person's approval is what releases it (audited as them).
      message = await records.patchRecord(tx, backgroundPrincipal(tx.tenantId), 'outbox', message.id, { ...edits, status: 'queued', approvedBy: `user:${req.principal.userId}` }, {}, w);
    }
    const { rows } = await tx.query("UPDATE ai_suggestions SET status = 'approved', decided_by = $3, decided_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *", [tx.tenantId, s.id, `user:${req.principal.userId}`]);
    await appendAudit(tx, tx.tenantId, { actor: w.actor, action: 'ai.suggestion_approve', collection: 'outbox', recordId: s.outbox_id, summary: s.title.slice(0, 200), meta: { kind: s.kind, edited: Object.keys(req.body || {}) }, request: w.request });
    return suggestionView(rows[0], message);
  }, { write: true }));

  app.post('/api/v1/ai/suggestions/:id/dismiss', { config: session, schema: { tags, summary: 'Dismiss a suggestion (its draft is removed)', params: uuidParam } }, async (req) => inTenant(req, async (tx) => {
    const s = await loadSuggestion(tx, req.principal, req.params.id);
    const w = who(req);
    const message = await outboxOf(tx, s);
    if (message && message.status === 'draft') await records.deleteRecord(tx, backgroundPrincipal(tx.tenantId), 'outbox', message.id, {}, w);
    const { rows } = await tx.query("UPDATE ai_suggestions SET status = 'dismissed', decided_by = $3, decided_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *", [tx.tenantId, s.id, `user:${req.principal.userId}`]);
    await appendAudit(tx, tx.tenantId, { actor: w.actor, action: 'ai.suggestion_dismiss', collection: 'outbox', recordId: s.outbox_id, summary: s.title.slice(0, 200), meta: { kind: s.kind }, request: w.request });
    return suggestionView(rows[0], null);
  }, { write: true }));

  app.post('/api/v1/ai/background/run', { config: { auth: 'manager' }, schema: { tags, summary: 'Run the background checks now (at most every 10 minutes)' } }, async (req) => {
    const p = req.principal;
    await assertFeature(db, p.tenantId, 'ai.background');
    const recent = await inTenant(req, async (tx) => (await tx.query(
      "SELECT 1 FROM ai_agent_runs WHERE tenant_id = $1 AND kind = 'background' AND started_at > now() - interval '10 minutes'", [tx.tenantId])).rowCount);
    if (recent) throw new ApiError(429, 'rate_limited', 'The checks ran in the last 10 minutes. Try again later.');
    const result = await scanTenant({ db, sealer: app.sealer, records, aiCfg, tenantId: p.tenantId, force: true });
    await inTenant(req, (tx) => appendAudit(tx, tx.tenantId, { actor: p.actor, action: 'ai.background_run', summary: 'Background checks run by hand', meta: result, request: requestFacts(req) }), { write: true });
    return result;
  });

}
