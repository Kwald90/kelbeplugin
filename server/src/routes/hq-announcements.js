// Announcements ("What's new"): HQ writes, schedules and targets banners; companies see them.
//   GET    /api/hq/announcements             all, with how many companies each reaches and dismissals
//   POST   /api/hq/announcements             create (HQ admin; audited)
//   PATCH  /api/hq/announcements/:id         edit, publish, archive (HQ admin; audited)
//   DELETE /api/hq/announcements/:id         delete (HQ admin; audited)
//   GET    /api/v1/announcements             signed in: live banners for my company, not dismissed by me,
//                                            plus legal documents I still have to accept
//   POST   /api/v1/announcements/:id/dismiss signed in: hide one for me (stored per person)
import { badRequest, notFound } from '../errors.js';
import { PROVINCES } from '../services/tenants.js';
import { effectivePlan, onTrial } from '../services/entitlements.js';
import { hqAudit, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';
import { legalStatus } from '../services/hq-settings.js';

export const AUDIENCE_PLANS = ['trial', 'starter', 'pro', 'business', 'enterprise'];
const TONES = ['info', 'success', 'warning'];

/** Plans and province of a company, as announcements target them. */
export function audienceOf(t, now = new Date()) {
  const plans = [effectivePlan(t, now)];
  if (onTrial(t)) plans.push('trial');
  return { plans, province: t.province || null };
}

/** Does an announcement reach this company? Empty target lists mean everyone. */
export function matchesAudience(a, t, now = new Date()) {
  const aud = audienceOf(t, now);
  const plans = a.target_plans || a.targetPlans || [];
  const provinces = a.target_provinces || a.targetProvinces || [];
  if (plans.length && !plans.some((p) => aud.plans.includes(p))) return false;
  if (provinces.length && !provinces.includes(aud.province)) return false;
  return true;
}

/** Live: published, started, not ended. */
export function isLive(a, now = new Date()) {
  return a.status === 'published' && new Date(a.starts_at) <= now && (!a.ends_at || new Date(a.ends_at) > now);
}

const view = (a) => ({
  id: a.id, title: a.title, body: a.body, linkUrl: a.link_url, linkLabel: a.link_label, tone: a.tone,
  targetPlans: a.target_plans, targetProvinces: a.target_provinces, status: a.status, startsAt: iso(a.starts_at), endsAt: iso(a.ends_at),
  dismissible: a.dismissible, createdAt: iso(a.created_at), updatedAt: iso(a.updated_at),
});

const fields = {
  title: { type: 'string', minLength: 1, maxLength: 120 },
  body: { type: 'string', maxLength: 1000 },
  linkUrl: { type: ['string', 'null'], maxLength: 500 },
  linkLabel: { type: ['string', 'null'], maxLength: 40 },
  tone: { type: 'string', enum: TONES },
  targetPlans: { type: 'array', uniqueItems: true, maxItems: 5, items: { type: 'string', enum: AUDIENCE_PLANS } },
  targetProvinces: { type: 'array', uniqueItems: true, maxItems: 13, items: { type: 'string', enum: PROVINCES } },
  status: { type: 'string', enum: ['draft', 'published', 'archived'] },
  startsAt: { type: ['string', 'null'], format: 'date-time' },
  endsAt: { type: ['string', 'null'], format: 'date-time' },
  dismissible: { type: 'boolean' },
};

function checkBody(b) {
  if (b.linkUrl && !/^(https:\/\/[^\s<>"']+|#\/[A-Za-z0-9/_?=&.-]*)$/.test(b.linkUrl)) throw badRequest('The link must start with https:// or be an in-app #/route.');
  if (b.linkUrl && !b.linkLabel) b.linkLabel = 'Learn more';
}

/** @param {import('fastify').FastifyInstance} app */
export default async function hqAnnouncementRoutes(app, { db }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  app.get('/api/hq/announcements', { config: hq, schema: { tags, summary: 'Announcements with reach and dismissals' } }, async () => {
    return db.withHq(async (c) => {
      const rows = (await c.query(
        `SELECT a.*, (SELECT count(*)::int FROM announcement_dismissals d WHERE d.announcement_id = a.id) AS dismissals
           FROM announcements a ORDER BY a.status = 'archived', a.starts_at DESC`)).rows;
      const tenants = (await c.query(
        "SELECT id, plan, trial_ends_at, grace_ends_at, billing_status, province FROM tenants WHERE status = 'active'")).rows;
      const now = new Date();
      return {
        data: rows.map((a) => ({ ...view(a), live: isLive(a, now), dismissals: a.dismissals, reach: tenants.filter((t) => matchesAudience(a, t, now)).length })),
        companies: tenants.length,
      };
    });
  });

  app.post('/api/hq/announcements', {
    config: hq,
    schema: { tags, summary: 'Create an announcement (HQ admin; audited)', body: { type: 'object', required: ['title'], additionalProperties: false, properties: fields } },
  }, async (req, reply) => {
    requireHqAdmin(req);
    const b = { ...req.body };
    checkBody(b);
    return db.withHq(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO announcements (title, body, link_url, link_label, tone, target_plans, target_provinces, status, starts_at, ends_at, dismissible, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, $11, $12, $12) RETURNING *`,
        [b.title.trim(), b.body || '', b.linkUrl || null, b.linkUrl ? b.linkLabel : null, b.tone || 'info', b.targetPlans || [], b.targetProvinces || [],
          b.status || 'draft', b.startsAt || null, b.endsAt || null, b.dismissible ?? true, req.principal.userId]).catch(rethrowCheck);
      await hqAudit(c, req, null, { action: 'hq.announcement_create', collection: 'announcements', recordId: rows[0].id, summary: `Announcement "${rows[0].title}" (${rows[0].status})` });
      reply.code(201);
      return view(rows[0]);
    });
  });

  app.patch('/api/hq/announcements/:id', {
    config: hq,
    schema: { tags, summary: 'Edit, publish or archive an announcement (HQ admin; audited)', params: uuidParams('id'), body: { type: 'object', minProperties: 1, additionalProperties: false, properties: fields } },
  }, async (req) => {
    requireHqAdmin(req);
    const b = { ...req.body };
    checkBody(b);
    return db.withHq(async (c) => {
      const cur = (await c.query('SELECT * FROM announcements WHERE id = $1', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such announcement.');
      const map = { title: 'title', body: 'body', linkUrl: 'link_url', linkLabel: 'link_label', tone: 'tone', targetPlans: 'target_plans', targetProvinces: 'target_provinces', status: 'status', startsAt: 'starts_at', endsAt: 'ends_at', dismissible: 'dismissible' };
      const sets = [];
      const params = [req.params.id];
      for (const [k, col] of Object.entries(map)) {
        if (!(k in b)) continue;
        let v = b[k];
        if (k === 'startsAt' && !v) v = new Date().toISOString();
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      params.push(req.principal.userId);
      const { rows } = await c.query(`UPDATE announcements SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() WHERE id = $1 RETURNING *`, params).catch(rethrowCheck);
      const what = b.status && b.status !== cur.status ? `${cur.status} -> ${b.status}` : 'edited';
      await hqAudit(c, req, null, { action: 'hq.announcement_update', collection: 'announcements', recordId: cur.id, summary: `Announcement "${rows[0].title}" ${what}`, meta: { fields: Object.keys(b) } });
      return view(rows[0]);
    });
  });

  app.delete('/api/hq/announcements/:id', { config: hq, schema: { tags, summary: 'Delete an announcement (HQ admin; audited)', params: uuidParams('id') } }, async (req, reply) => {
    requireHqAdmin(req);
    await db.withHq(async (c) => {
      const { rows } = await c.query('DELETE FROM announcements WHERE id = $1 RETURNING title', [req.params.id]);
      if (!rows[0]) throw notFound('No such announcement.');
      await hqAudit(c, req, null, { action: 'hq.announcement_delete', collection: 'announcements', recordId: req.params.id, summary: `Deleted announcement "${rows[0].title}"` });
    });
    reply.code(204);
  });

  // ---- in the app -------------------------------------------------------------------

  const member = { auth: 'tenant', apiKey: false };

  async function liveFor(p) {
    const t = (await db.query('SELECT id, plan, trial_ends_at, grace_ends_at, billing_status, province FROM tenants WHERE id = $1', [p.tenantId])).rows[0];
    const { rows } = await db.query(
      `SELECT a.* FROM announcements a
        WHERE a.status = 'published' AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
          AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = $1)
        ORDER BY a.starts_at DESC LIMIT 20`, [p.userId]);
    return t ? rows.filter((a) => matchesAudience(a, t)) : [];
  }

  app.get('/api/v1/announcements', { config: member, schema: { tags: ['announcements'], summary: 'Announcements for you and legal documents to accept' } }, async (req) => {
    const p = req.principal;
    const rows = await liveFor(p);
    const legal = await legalStatus(db, p.userId);
    return {
      data: rows.map((a) => ({ id: a.id, title: a.title, body: a.body, linkUrl: a.link_url, linkLabel: a.link_label, tone: a.tone, dismissible: a.dismissible, startsAt: iso(a.starts_at) })),
      legal: legal.needsAcceptance,
    };
  });

  app.post('/api/v1/announcements/:id/dismiss', { config: member, schema: { tags: ['announcements'], summary: 'Hide an announcement for yourself', params: uuidParams('id') } }, async (req, reply) => {
    const p = req.principal;
    const a = (await liveFor(p)).find((x) => x.id === req.params.id);
    if (!a) throw notFound('No such announcement.');
    if (!a.dismissible) throw badRequest('This announcement stays until it ends.');
    await db.query('INSERT INTO announcement_dismissals (announcement_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.id, p.userId]);
    reply.code(204);
  });
}

function rethrowCheck(e) {
  if (e?.code === '23514') throw badRequest('Check the dates: the end must be after the start.');
  throw e;
}
