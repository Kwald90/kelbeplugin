// Fishtape's own Enterprise sales pipeline.
//   POST /api/v1/public/enterprise-leads   the "Let's talk" form on the pricing page (public)
//   /api/hq/leads                          HQ works the pipeline
// The form is rate-limited per IP (always on, separate from RATE_LIMIT), has a honeypot
// field, validates without echoing, and never logs what was sent. Lead details live in
// hq_leads only; the notification email names the company and links to HQ.
import { randomUUID } from 'node:crypto';
import { ApiError, notFound } from '../errors.js';
import { appendAudit } from '../services/audit.js';
import { EMAIL_RE, PROVINCES, normaliseEmail } from '../services/tenants.js';
import { hqAudit, hqSettings, iso, uuidParams } from '../services/hq-common.js';
import { BRAND } from '../brand.js';

export const TEAM_SIZES = ['1-5', '6-15', '16-50', '51-200', '200+'];
export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const HOUR = 3_600_000;

/** Sliding one-hour window per key, plus a global cap. In memory, per process. */
export function createLeadLimiter({ perKey, global, now = () => Date.now() }) {
  const hits = new Map();
  let all = [];
  return function allow(key) {
    const t = now();
    all = all.filter((x) => t - x < HOUR);
    const mine = (hits.get(key) || []).filter((x) => t - x < HOUR);
    if (mine.length >= perKey || all.length >= global) { hits.set(key, mine); return false; }
    mine.push(t); all.push(t);
    hits.set(key, mine);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((x) => t - x < HOUR)) hits.delete(k);
    return true;
  };
}

const leadView = (l) => ({
  id: l.id, name: l.name, email: l.email, company: l.company, phone: l.phone, province: l.province, teamSize: l.team_size, message: l.message,
  source: l.source, stage: l.stage, ownerId: l.owner_id, ownerName: l.owner_name || null, notes: l.notes,
  nextStepAt: l.next_step_at ? new Date(l.next_step_at).toISOString().slice(0, 10) : null, valueCents: l.value_cents,
  createdAt: iso(l.created_at), updatedAt: iso(l.updated_at),
});

/** @param {import('fastify').FastifyInstance} app */
export default async function hqLeadRoutes(app, { config, db, email }) {
  const settings = hqSettings(config);
  const allow = createLeadLimiter({ perKey: settings.leadsPerHour, global: settings.leadsGlobalPerHour });
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  app.post('/api/v1/public/enterprise-leads', {
    config: { auth: 'public' },
    onRequest: async (req) => {
      // Counted before validation, so malformed floods are limited too.
      if (!allow(`ip:${req.ip}`)) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later or email us.');
    },
    schema: {
      tags: ['public'], summary: 'Enterprise "Let\'s talk" form: creates a lead in Fishtape HQ and emails sales',
      body: {
        type: 'object', required: ['name', 'email', 'company'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          email: { type: 'string', minLength: 3, maxLength: 254 },
          company: { type: 'string', minLength: 1, maxLength: 200 },
          phone: { type: 'string', maxLength: 40 },
          province: { type: 'string', enum: ['', ...PROVINCES] },
          teamSize: { type: 'string', enum: ['', ...TEAM_SIZES] },
          message: { type: 'string', maxLength: 4000 },
          // Honeypot: hidden from people, so anything in it came from a bot.
          website: { type: 'string', maxLength: 500 },
        },
      },
      response: { 202: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  }, async (req, reply) => {
    const b = req.body;
    reply.code(202);
    if (str(b.website)) return { ok: true }; // looks accepted; nothing stored
    const lead = {
      id: randomUUID(), name: str(b.name), email: normaliseEmail(b.email), company: str(b.company),
      phone: str(b.phone) || null, province: b.province || null, teamSize: b.teamSize || null, message: str(b.message) || null,
    };
    if (!lead.name || !lead.company || !EMAIL_RE.test(lead.email)) {
      throw new ApiError(400, 'validation_failed', 'Check your name, email and company.', { errors: [{ path: '/email', message: 'must be a valid email address' }] });
    }
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO hq_leads (id, name, email, company, phone, province, team_size, message, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pricing')`,
        [lead.id, lead.name, lead.email, lead.company, lead.phone, lead.province, lead.teamSize, lead.message]);
      await appendAudit(c, null, { actor: { type: 'system', id: 'public-form', label: 'Pricing page' }, action: 'lead.create', collection: 'hq_leads', recordId: lead.id, summary: 'Enterprise lead received' });
      if (settings.notifyEmail) {
        await email.send(c, {
          to: settings.notifyEmail, template: 'hq-lead',
          subject: `New Enterprise lead: ${lead.company.slice(0, 80)}`,
          text: `${lead.company} asked about ${BRAND.name} Enterprise${lead.teamSize ? ` (team of ${lead.teamSize})` : ''}${lead.province ? `, ${lead.province}` : ''}.\n\n`
            + `Contact details and message are in HQ: ${config.publicOrigin}/hq/#/leads/${lead.id}\n`,
        });
      }
    });
    if (!settings.notifyEmail) req.log.warn('HQ_NOTIFY_EMAIL is not set: a lead was stored without a notification email');
    return { ok: true };
  });

  // ---- HQ pipeline ------------------------------------------------------------------

  const LEAD_SQL = 'SELECT l.*, u.display_name AS owner_name FROM hq_leads l LEFT JOIN users u ON u.id = l.owner_id';

  app.get('/api/hq/leads', {
    config: { auth: 'hq' },
    schema: { tags: ['hq'], summary: 'Enterprise leads, newest first', querystring: { type: 'object', additionalProperties: false, properties: { stage: { type: 'string', enum: LEAD_STAGES } } } },
  }, async (req) => {
    const rows = await db.withHq(async (c) => (await c.query(`${LEAD_SQL} WHERE ($1::text IS NULL OR l.stage = $1) ORDER BY l.created_at DESC LIMIT 500`, [req.query.stage || null])).rows);
    const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0]));
    for (const l of rows) byStage[l.stage]++;
    return { data: rows.map(leadView), byStage, stages: LEAD_STAGES };
  });

  app.get('/api/hq/leads/:id', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'One lead', params: uuidParams('id') } }, async (req) => {
    const l = await db.withHq(async (c) => (await c.query(`${LEAD_SQL} WHERE l.id = $1`, [req.params.id])).rows[0]);
    if (!l) throw notFound('No such lead.');
    return leadView(l);
  });

  app.patch('/api/hq/leads/:id', {
    config: { auth: 'hq' },
    schema: {
      tags: ['hq'], summary: 'Move a lead along the pipeline (audited, without contact details)', params: uuidParams('id'),
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          stage: { type: 'string', enum: LEAD_STAGES }, notes: { type: 'string', maxLength: 8000 }, nextStepAt: { type: ['string', 'null'], format: 'date' },
          valueCents: { type: ['integer', 'null'], minimum: 0 }, assignToMe: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    return db.withHq(async (c) => {
      const cur = (await c.query('SELECT id, stage FROM hq_leads WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such lead.');
      await c.query(
        `UPDATE hq_leads SET stage = COALESCE($2, stage), notes = COALESCE($3, notes),
                next_step_at = CASE WHEN $4 THEN $5::date ELSE next_step_at END,
                value_cents = CASE WHEN $6 THEN $7::bigint ELSE value_cents END,
                owner_id = CASE WHEN $8 THEN $9::uuid ELSE owner_id END, updated_at = now()
          WHERE id = $1`,
        [cur.id, b.stage ?? null, b.notes ?? null, 'nextStepAt' in b, b.nextStepAt ?? null, 'valueCents' in b, b.valueCents ?? null,
          'assignToMe' in b, b.assignToMe ? req.principal.userId : null]);
      await hqAudit(c, req, null, {
        action: 'hq.lead_update', collection: 'hq_leads', recordId: cur.id,
        summary: `Lead ${cur.id.slice(0, 8)}${b.stage && b.stage !== cur.stage ? `: ${cur.stage} -> ${b.stage}` : ' updated'}`, meta: { fields: Object.keys(b) },
      });
      return leadView((await c.query(`${LEAD_SQL} WHERE l.id = $1`, [cur.id])).rows[0]);
    });
  });
}
