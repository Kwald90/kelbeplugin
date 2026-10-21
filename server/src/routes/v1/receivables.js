// Statements and the credit-hold recheck (docs/releases/r1-get-paid.md 4.5, 10.1; docs/office/getting-paid.md).
//
//   GET  /api/v1/statements/:clientId?from&to[&format=html]   a client's statement (JSON, or HTML to print)
//   POST /api/v1/statements/:clientId/send { from, to, toEmail? }  email it through the company's outbox
//   POST /api/v1/receivables/recheck/:clientId                  recompute the client's hold (after a payment)
//
// All need the invoices permission (money). Statements are built from electrical-app/js/lib/receivables.js,
// the same library the PWA prints with. Sending needs email on the plan and a connected provider; it is
// audited (statement.send). The recheck queues the receivables_client job (deduplicated per client).
import { ApiError, badRequest, forbidden, notFound } from '../../errors.js';
import { appendAudit } from '../../services/audit.js';
import { enqueue } from '../../services/queue.js';
import { requireFeature } from '../../services/entitlements.js';
import { channelsReady, queueClientRecheck, statementFor, statementHtml, statementText } from '../../services/receivables.js';
import { errorResponses, tenantCtx, who } from '../util.js';

const tags = ['receivables'];
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const needInvoices = (p) => { if (!p?.perms?.has?.('invoices')) throw forbidden('Statements and holds are for the office.'); };

/** @param {import('fastify').FastifyInstance} app */
export default async function receivablesRoutes(app, { db, records }) {
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);

  app.get('/api/v1/statements/:clientId', {
    config: { auth: 'tenant' },
    schema: {
      tags, summary: "A client's statement",
      description: 'Opening balance, invoices, credit notes, payments and refunds in the period with a running balance, aging of what is collectible, and on their own lines holdback the customer kept, disputed amounts, on-account money, unapplied credit notes and deposits. invoices permission.',
      params: { type: 'object', required: ['clientId'], properties: { clientId: ID } },
      querystring: { type: 'object', additionalProperties: false, properties: { from: DAY, to: DAY, format: { type: 'string', enum: ['json', 'html'] } } },
      response: { ...errorResponses },
    },
  }, async (req, reply) => {
    needInvoices(req.principal);
    if (req.query.from && req.query.to && req.query.from > req.query.to) throw badRequest('The start is after the end.');
    const data = await inTenant(req, (tx) => statementFor(tx, req.params.clientId, { from: req.query.from, to: req.query.to }));
    if (!data) throw notFound('No such client.');
    if (req.query.format === 'html') {
      reply.header('content-type', 'text/html; charset=utf-8');
      return statementHtml(data);
    }
    return { client: { id: data.client.id, name: data.client.name || '' }, currency: data.currency, ...data.statement };
  });

  app.post('/api/v1/statements/:clientId/send', {
    config: { auth: 'tenant', apiKey: false },
    preHandler: requireFeature(db, 'integrations.email'),
    schema: {
      tags, summary: "Email a client's statement",
      description: 'Builds the statement on the server and queues it in the company outbox (kind statement), to toEmail, else the client\'s statement email, else their email. invoices permission; email on the plan and connected.',
      params: { type: 'object', required: ['clientId'], properties: { clientId: ID } },
      body: { type: 'object', additionalProperties: false, properties: { from: DAY, to: DAY, toEmail: { type: 'string', maxLength: 254 } } },
      response: { ...errorResponses },
    },
  }, async (req, reply) => {
    const p = req.principal;
    needInvoices(p);
    const w = who(req);
    const out = await inTenant(req, async (tx) => {
      if (!(await channelsReady(tx)).email) throw new ApiError(409, 'not_connected', 'Connect email (SendGrid or Resend) to send statements, or print it.');
      const data = await statementFor(tx, req.params.clientId, { from: req.body?.from, to: req.body?.to });
      if (!data) throw notFound('No such client.');
      const to = String(req.body?.toEmail || data.client.credit?.statementEmail || data.client.email || '').trim();
      if (!EMAIL_RE.test(to)) throw badRequest('Enter the email address to send it to.');
      const st = data.statement;
      const id = `stmt-${req.params.clientId}-${st.to}-${Date.now().toString(36)}`.slice(0, 128);
      const rec = await records.createRecord(tx, p, 'outbox', {
        id, channel: 'email', kind: 'statement', to, relatedId: req.params.clientId, status: 'queued', dueAt: new Date().toISOString(),
        subject: `Statement from ${data.company?.name || 'your contractor'}: ${st.from} to ${st.to}`.slice(0, 300), body: statementText(data),
      }, w);
      await enqueue(tx, { kind: 'integrations_send', tenantId: tx.tenantId, payload: { outboxId: rec.id }, dedupeKey: `integrations_send:${tx.tenantId}:${rec.id}`, maxAttempts: 1 });
      await appendAudit(tx, tx.tenantId, { actor: w.actor, action: 'statement.send', collection: 'clients', recordId: req.params.clientId, summary: `${st.from} to ${st.to}`, meta: { outboxId: rec.id }, request: w.request });
      return { outboxId: rec.id, to };
    }, { write: true });
    reply.code(201);
    return { queued: true, ...out };
  });

  app.post('/api/v1/receivables/recheck/:clientId', {
    config: { auth: 'tenant' },
    schema: {
      tags, summary: "Recompute a client's credit hold",
      description: 'Queues the receivables_client job for this client (deduplicated while one waits). The PWA calls it after the office records a payment while online. invoices permission.',
      params: { type: 'object', required: ['clientId'], properties: { clientId: ID } },
      response: { ...errorResponses },
    },
  }, async (req, reply) => {
    needInvoices(req.principal);
    const w = who(req);
    const queued = await inTenant(req, async (tx) => {
      const { rows } = await tx.query('SELECT 1 FROM clients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, req.params.clientId]);
      if (!rows[0]) throw notFound('No such client.');
      const id = await queueClientRecheck(tx, req.params.clientId);
      await appendAudit(tx, tx.tenantId, { actor: w.actor, action: 'receivables.recheck', collection: 'clients', recordId: req.params.clientId, summary: 'Credit hold recheck', request: w.request });
      return Boolean(id);
    }, { write: true });
    reply.code(202);
    return { queued };
  });
}
