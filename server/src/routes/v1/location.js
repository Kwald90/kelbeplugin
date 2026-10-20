// GET /api/v1/location/live: the opt-in live crew map. Off unless the company turned on
// "Live crew map while clocked in" (settings.location.liveCrewMap); then managers (owner, admin,
// office, foreman) see the latest point of each person who is clocked in right now, from the last
// 12 hours, of those who agreed to the current notice. Never anyone off the clock, never a history, never API keys. Every view is audited.
// Raw points otherwise reach only the person they belong to (RLS, 0140_location_access.sql).
import { ApiError, forbidden } from '../../errors.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { liveCrew, tenantLocationSettings } from '../../services/location.js';
import { errorResponses, tenantCtx } from '../util.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function locationRoutes(app, { db }) {
  app.get('/api/v1/location/live', {
    config: { auth: 'tenant' },
    schema: {
      tags: ['time'],
      summary: 'Live crew map: latest location of each person clocked in now (only when the company turned it on)',
      response: errorResponses,
    },
  }, async (req, reply) => {
    const p = req.principal;
    if (p.kind !== 'session' || !p.isManager) throw forbidden('The live crew map is for managers signed in to the app.');
    reply.header('Cache-Control', 'no-store');
    return db.withTenant(tenantCtx(p), async (tx) => {
      const s = await tenantLocationSettings(tx);
      if (!s.enabled || !s.liveCrewMap) throw new ApiError(403, 'live_map_off', 'The live crew map is off for this company. An owner can turn it on in Time clock > Location settings.');
      const crew = await liveCrew(tx, s);
      await appendAudit(tx, tx.tenantId, {
        actor: p.actor, action: 'location.live.view', collection: 'locationPoints',
        summary: `Viewed the live crew map (${crew.length} on the clock)`, request: requestFacts(req),
      });
      return { enabled: true, maxAgeHours: 12, crew };
    });
  });
}
