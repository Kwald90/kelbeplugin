// POST /api/v1/tickets/:id/send { kind: 'copy'|'notice' } (docs/releases/r1-get-paid.md 4.1;
// docs/field/tickets.md): "Send copy now" (to the signer) and "Send as written notice" (to the general
// contractor, for a refused ticket or a stale unsigned draft). The office (invoices permission), online,
// in a full session; email on the plan and connected (otherwise the office prints it). Audited
// (ticket.send_copy, ticket.send_notice). The notice is stored on the ticket (notice { outboxId, queuedAt, to, kind }).
import { forbidden } from '../../errors.js';
import { requireFeature } from '../../services/entitlements.js';
import { sendTicket } from '../../services/tickets.js';
import { errorResponses, tenantCtx, who } from '../util.js';

const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };

/** @param {import('fastify').FastifyInstance} app */
export default async function ticketRoutes(app, { db, records }) {
  app.post('/api/v1/tickets/:id/send', {
    config: { auth: 'tenant', apiKey: false },
    preHandler: requireFeature(db, 'integrations.email'),
    schema: {
      tags: ['tickets'], summary: 'Send a field ticket copy or a written notice now',
      description: 'kind copy: to the signer\'s email. kind notice: the written notice of extra work to the general contractor (refused tickets and unsigned drafts). invoices permission, full session.',
      params: { type: 'object', required: ['id'], properties: { id: ID } },
      body: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['copy', 'notice'] } } },
      response: { ...errorResponses },
    },
  }, async (req, reply) => {
    const p = req.principal;
    if (!p.perms.has('invoices')) throw forbidden('Only the office sends tickets and notices.');
    if (p.kind !== 'session' || p.crew) throw forbidden('Sending a notice needs a full sign-in, not a crew PIN.');
    const out = await db.withTenant(tenantCtx(p), (tx) => sendTicket(db, tx, records, p, who(req), req.params.id, req.body.kind), { write: true });
    reply.code(201);
    return { queued: true, ...out };
  });
}
