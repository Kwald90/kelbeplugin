// Public marketing endpoints: resolve a tracked trial link, and serve a published piece.
//   GET /api/v1/public/campaign/:code     trial terms for a tracked link; counts the visit
//   GET /api/v1/public/marketing/:slug     a published piece's content, for site/piece.html
// Both are read-only and carry no company data. The code rides the sign-up body from here on,
// landing in signups.campaign_code (services/marketing.js, services/signup.js).
import { ApiError } from '../errors.js';
import { publishedPiece, resolveCampaign } from '../services/marketing.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function publicMarketingRoutes(app, { db }) {
  const tags = ['public'];

  app.get('/api/v1/public/campaign/:code', {
    config: { auth: 'public' },
    schema: {
      tags, summary: 'Resolve a tracked trial link to its trial length and plan (counts a visit)',
      params: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' } } },
    },
  }, async (req) => {
    const resolved = await resolveCampaign(db, String(req.params.code).toLowerCase(), { countVisit: true });
    if (!resolved) throw new ApiError(404, 'not_found', 'That link is not active.');
    return resolved;
  });

  app.get('/api/v1/public/marketing/:slug', {
    config: { auth: 'public' },
    schema: {
      tags, summary: 'A published marketing piece (title, blocks and co-brand)',
      params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string', maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]{0,62}$' } } },
    },
  }, async (req) => {
    const piece = await publishedPiece(db, req.params.slug);
    if (!piece) throw new ApiError(404, 'not_found', 'No such page.');
    return { piece: { title: piece.title, kind: piece.kind, content: piece.content, cobrand: piece.cobrand } };
  });
}
