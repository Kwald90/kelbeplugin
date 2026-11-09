// /api/v1/booking: the signed-in owner manages THIS company's public booking page (the slug and
// the on/off flag). The form's content (service types, fields, confirmation message, contact) is
// ordinary settings, synced like everything else; only the slug claim needs the server, because
// booking_pages is a platform table whose slug is globally unique (routes it to the right tenant
// with no tenant context). Owner/admin only, and gated by the `booking` plan feature.
import { ApiError } from '../../errors.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { requireFeature } from '../../services/entitlements.js';
import { slugProblem, getBookingPage, saveBookingPage } from '../../services/booking.js';
import { errorResponses } from '../util.js';

const tags = ['booking'];

/** @param {import('fastify').FastifyInstance} app */
export default async function bookingRoutes(app, { db }) {
  app.get('/api/v1/booking', {
    config: { auth: 'admin' },
    preHandler: requireFeature(db, 'booking'),
    schema: { tags, summary: 'This company\'s booking page: its public slug and whether it is live', response: errorResponses },
  }, async (req) => {
    const page = await getBookingPage(db, req.principal.tenantId);
    return { page };
  });

  app.put('/api/v1/booking', {
    config: { auth: 'admin' },
    preHandler: requireFeature(db, 'booking'),
    schema: {
      tags, summary: 'Claim or update this company\'s booking slug and on/off flag (slug is globally unique)',
      body: {
        type: 'object', additionalProperties: false, required: ['slug'],
        properties: {
          slug: { type: 'string', minLength: 2, maxLength: 63 },
          enabled: { type: 'boolean' },
        },
      },
      response: errorResponses,
    },
  }, async (req) => {
    const slug = String(req.body.slug || '').trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) throw new ApiError(400, 'bad_slug', problem);
    const enabled = req.body.enabled === true;
    let page;
    try {
      page = await saveBookingPage(db, req.principal.tenantId, { slug, enabled });
    } catch (e) {
      if (e?.code === '23505') throw new ApiError(409, 'slug_taken', 'That web address is already in use. Please choose another.');
      throw e;
    }
    await db.withTenant({ tenantId: req.principal.tenantId, userId: req.principal.userId }, (tx) => appendAudit(tx, req.principal.tenantId, {
      actor: req.principal.actor, action: 'booking.save', collection: 'booking_pages', recordId: slug,
      summary: `Booking page ${enabled ? 'live' : 'off'} at /${slug}`, meta: { slug, enabled }, request: requestFacts(req),
    }), { write: true }).catch(() => {});
    return { page };
  });
}
