// /api/v1/material-requests: the schedule for sending the crew's material requests to the
// office, and "Send now". The requests themselves are ordinary records (collection
// materialRequests: REST and sync). Anyone who may file a request may send the waiting list now
// (an urgent need on site); the list goes to the office, never back to the sender.
// Plan feature `materials` (every plan); the Material requests module must be on to send.
import { forbidden } from '../../errors.js';
import { canRead, canWrite, rowFilter } from '../../auth/access.js';
import { requireFeature } from '../../services/entitlements.js';
import { assertModuleOn } from '../../services/modules.js';
import { scheduleInfo, sendMaterialRequests } from '../../services/materials.js';
import { requestFacts } from '../../services/audit.js';
import { errorResponses, tenantCtx } from '../util.js';

const tags = ['materials'];

/** @param {import('fastify').FastifyInstance} app */
export default async function materialRoutes(app, { db, email, config }) {
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);

  app.get('/api/v1/material-requests/schedule', {
    config: { auth: 'tenant' },
    preHandler: requireFeature(db, 'materials'),
    schema: { tags, summary: 'When waiting material requests next go to the office, how many are waiting, and the last send', response: errorResponses },
  }, async (req) => {
    const p = req.principal;
    if (!canRead(p, 'materialRequests')) throw forbidden('You cannot read material requests.');
    const f = rowFilter(p, 'materialRequests');
    return inTenant(req, (tx) => scheduleInfo(tx, f ? { employeeId: f.value ?? '' } : {}));
  });

  app.post('/api/v1/material-requests/send', {
    config: { auth: 'tenant' },
    preHandler: requireFeature(db, 'materials'),
    schema: {
      tags, summary: 'Send every waiting material request to the office now, as one list grouped by job',
      description: 'Marks the waiting requests sent, notifies the office (bell) and emails the list when an address is set. Returns { batchId, count, jobs, emailed }; count 0 when nothing was waiting.',
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    if (!canWrite(p, 'materialRequests')) throw forbidden('You cannot send material requests.');
    return inTenant(req, async (tx) => {
      await assertModuleOn(tx, 'materials');
      return sendMaterialRequests(tx, { kind: 'now', actor: p.actor, request: requestFacts(req), email, config });
    }, { write: true });
  });
}
