// /api/v1/receiving: field receiving without prices (docs/releases/r1-get-paid.md 6.6, 8.4).
//   GET  /api/v1/receiving?jobId=|locationId=   open purchase-order lines to receive: item, description,
//                                               ordered, received (never a price)
//   POST /api/v1/receiving/:poId                { lines: [{ index, qty }], toLocationId?, jobId? }
// The `inventory` or `jobs` permission, in a signed-in session (online only; the PWA says so). The
// server records the receipt as the system actor `receiving` (services/receiving.js): the PO line's
// receivedQty, a receive move at the PO price, the location's stock and the item's moving average.
import { forbidden } from '../../errors.js';
import { receive, receivingLines } from '../../services/receiving.js';
import { errorResponses, tenantCtx, who } from '../util.js';

const tags = ['receiving'];
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };

function requireReceiver(req) {
  const p = req.principal;
  if (!p.perms?.has('inventory') && !p.perms?.has('jobs')) throw forbidden('Receiving needs the inventory or jobs permission.');
}

/** @param {import('fastify').FastifyInstance} app */
export default async function receivingRoutes(app, { db, records }) {
  app.get('/api/v1/receiving', {
    config: { auth: 'tenant', apiKey: false },
    schema: {
      tags, summary: 'Purchase-order lines to receive',
      description: 'Open and sent purchase orders\' lines not yet fully received, for one job (jobId), for stock orders (locationId), or all. Quantities only: no prices.',
      querystring: { type: 'object', additionalProperties: false, properties: { jobId: ID, locationId: ID } },
      response: errorResponses,
    },
  }, async (req) => {
    requireReceiver(req);
    const lines = await db.withTenant(tenantCtx(req.principal), (tx) => receivingLines(tx, { jobId: req.query.jobId || null, locationId: req.query.locationId || null }));
    return { lines };
  });

  app.post('/api/v1/receiving/:poId', {
    config: { auth: 'tenant', apiKey: false },
    schema: {
      tags, summary: 'Receive purchase-order lines',
      description: 'Records what arrived: raises each line\'s received quantity, records a receive move (into a location, adding to its stock and the item\'s moving average, or onto the job), and returns quantities only. 409 po_not_open for a draft, closed or cancelled order; 422 for a line that does not exist, a line without a price-book item going into stock, or a line with nowhere to go.',
      params: { type: 'object', required: ['poId'], properties: { poId: ID } },
      body: {
        type: 'object', additionalProperties: false, required: ['lines'],
        properties: {
          lines: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['index', 'qty'], properties: { index: { type: 'integer', minimum: 0, maximum: 199 }, qty: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 } } } },
          toLocationId: ID, jobId: ID,
        },
      },
      response: errorResponses,
    },
  }, async (req, reply) => {
    requireReceiver(req);
    const out = await db.withTenant(tenantCtx(req.principal), (tx) => receive(tx, records, req.principal, req.params.poId, req.body, { request: who(req).request }), { write: true });
    reply.code(201);
    return out;
  });
}
