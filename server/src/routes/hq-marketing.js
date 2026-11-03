// HQ Marketing hub: the sell-side pieces (the catalog and co-branded editions) and the tracked
// trial links. Pieces carry a block model edited and reordered in hq/js/pages/marketing.js;
// campaigns carry a trial length and show their funnel (visits -> starts -> completed).
//   GET    /api/hq/marketing                     pieces, campaigns and the plan list
//   GET    /api/hq/marketing/pieces/:id          one piece (full content)
//   POST   /api/hq/marketing/pieces              create a piece (HQ admin; audited)
//   PUT    /api/hq/marketing/pieces/:id          save a piece's content/co-brand/status (admin)
//   DELETE /api/hq/marketing/pieces/:id          remove a piece (admin)
//   PUT    /api/hq/marketing/campaigns/:code     create or update a tracked link (admin)
//   DELETE /api/hq/marketing/campaigns/:code     remove a tracked link (admin)
import { ApiError } from '../errors.js';
import { hqAudit, requireHqAdmin } from '../services/hq-common.js';
import { PLAN_IDS } from '../../../electrical-app/js/plans.js';
import {
  createPiece, deleteCampaign, deletePiece, getPiece, listCampaigns, listPieces,
  saveCampaign, savePiece, slugProblem, validCode,
} from '../services/marketing.js';

const CODE_SCHEMA = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' };

/** @param {import('fastify').FastifyInstance} app */
export default async function hqMarketingRoutes(app, { db }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  app.get('/api/hq/marketing', { config: hq, schema: { tags, summary: 'Marketing pieces, tracked links and their funnel' } }, async (req) => {
    return db.withHq(async (c) => {
      const pieces = await listPieces(c, { seederId: req.principal.userId });
      const campaigns = await listCampaigns(c);
      return { pieces: pieces.map(({ content, ...p }) => p), campaigns, plans: PLAN_IDS };
    });
  });

  app.get('/api/hq/marketing/pieces/:id', {
    config: hq,
    schema: { tags, summary: 'One marketing piece with its full content', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    const piece = await db.withHq((c) => getPiece(c, req.params.id));
    if (!piece) throw new ApiError(404, 'not_found', 'No such marketing piece.');
    return { piece };
  });

  app.post('/api/hq/marketing/pieces', {
    config: hq,
    schema: {
      tags, summary: 'Create a marketing piece (HQ admin; audited)',
      body: {
        type: 'object', additionalProperties: false, required: ['slug', 'title'],
        properties: {
          slug: { type: 'string', minLength: 1, maxLength: 63 },
          title: { type: 'string', minLength: 1, maxLength: 160 },
          kind: { type: 'string', enum: ['catalog', 'flyer', 'onepager', 'email'] },
        },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const slug = String(req.body.slug).toLowerCase();
    const problem = slugProblem(slug);
    if (problem) throw new ApiError(400, 'validation_failed', problem);
    return db.withHq(async (c) => {
      const existing = await c.query('SELECT 1 FROM marketing_pieces WHERE slug = $1', [slug]);
      if (existing.rows.length) throw new ApiError(409, 'slug_taken', 'A piece already uses that slug.');
      const piece = await createPiece(c, { slug, title: req.body.title, kind: req.body.kind }, req.principal.userId);
      await hqAudit(c, req, null, { action: 'hq.marketing_piece_create', collection: 'marketing_pieces', recordId: piece.id, summary: `Marketing piece created: ${piece.title} (${slug})` });
      return { piece };
    });
  });

  app.put('/api/hq/marketing/pieces/:id', {
    config: hq,
    schema: {
      tags, summary: 'Save a marketing piece: content, co-brand, title or status (HQ admin; audited)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          status: { type: 'string', enum: ['draft', 'published'] },
          content: { type: 'object', additionalProperties: true },
          cobrand: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    return db.withHq(async (c) => {
      const before = await getPiece(c, req.params.id);
      if (!before) throw new ApiError(404, 'not_found', 'No such marketing piece.');
      const piece = await savePiece(c, req.params.id, req.body, req.principal.userId);
      const what = Object.keys(req.body).join(', ');
      await hqAudit(c, req, null, { action: 'hq.marketing_piece_save', collection: 'marketing_pieces', recordId: piece.id, summary: `Marketing piece saved: ${piece.title} (${what})` });
      return { piece };
    });
  });

  app.delete('/api/hq/marketing/pieces/:id', {
    config: hq,
    schema: { tags, summary: 'Remove a marketing piece (HQ admin; audited)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    requireHqAdmin(req);
    return db.withHq(async (c) => {
      const before = await getPiece(c, req.params.id);
      if (!before) throw new ApiError(404, 'not_found', 'No such marketing piece.');
      await deletePiece(c, req.params.id);
      await hqAudit(c, req, null, { action: 'hq.marketing_piece_remove', collection: 'marketing_pieces', recordId: req.params.id, summary: `Marketing piece removed: ${before.title}` });
      return { removed: true };
    });
  });

  app.put('/api/hq/marketing/campaigns/:code', {
    config: hq,
    schema: {
      tags, summary: 'Create or update a tracked trial link (HQ admin; audited)',
      params: { type: 'object', required: ['code'], properties: { code: CODE_SCHEMA } },
      body: {
        type: 'object', additionalProperties: false, required: ['label', 'trialDays'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 120 },
          trialDays: { type: 'integer', minimum: 1, maximum: 730 },
          plan: { type: ['string', 'null'], enum: [...PLAN_IDS, null] },
          pieceId: { type: ['string', 'null'], format: 'uuid' },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const code = String(req.params.code).toLowerCase();
    if (!validCode(code)) throw new ApiError(400, 'validation_failed', 'A code is letters, numbers, dashes or underscores.');
    const { label, trialDays, plan = null, pieceId = null, active = true } = req.body;
    return db.withHq(async (c) => {
      if (pieceId) {
        const p = await c.query('SELECT 1 FROM marketing_pieces WHERE id = $1', [pieceId]);
        if (!p.rows.length) throw new ApiError(400, 'validation_failed', 'That linked piece does not exist.');
      }
      await saveCampaign(c, code, { label, trialDays, plan, pieceId, active }, req.principal.userId);
      await hqAudit(c, req, null, { action: 'hq.marketing_campaign_save', collection: 'marketing_campaigns', recordId: code, summary: `Tracked link saved: ${code} (${trialDays}-day trial${plan ? `, ${plan}` : ''})` });
      const campaigns = await listCampaigns(c);
      return { campaigns };
    });
  });

  app.delete('/api/hq/marketing/campaigns/:code', {
    config: hq,
    schema: { tags, summary: 'Remove a tracked trial link (HQ admin; audited)', params: { type: 'object', required: ['code'], properties: { code: CODE_SCHEMA } } },
  }, async (req) => {
    requireHqAdmin(req);
    const code = String(req.params.code).toLowerCase();
    return db.withHq(async (c) => {
      const { removed } = await deleteCampaign(c, code);
      if (!removed) throw new ApiError(404, 'not_found', 'No such tracked link.');
      await hqAudit(c, req, null, { action: 'hq.marketing_campaign_remove', collection: 'marketing_campaigns', recordId: code, summary: `Tracked link removed: ${code}` });
      return { removed: true };
    });
  });
}
