// HQ finance and invoicing (Fishtape's subscriptions on the Stripe account in STRIPE_SECRET_KEY):
//   GET  /api/hq/finance                      cached summary (worker refreshes hourly) + company names
//   POST /api/hq/finance/refresh              refresh from Stripe now
//   GET  /api/hq/finance/export?kind=         CSV: revenue | plans | renewals | failed (audited)
//   GET  /api/hq/invoices                     live list: company, status, date range
//   POST /api/hq/invoices/:id/resend          email the invoice again (HQ staff)
//   POST /api/hq/invoices/:id/uncollectible   mark an open invoice uncollectible (HQ admin)
//   POST /api/hq/invoices/:id/credit-note     credit note with amount and reason (HQ admin)
//   POST /api/hq/invoices/:id/refund          refund with amount and reason (HQ admin)
// Every invoice action is audited in HQ's chain and in the company's own chain. Only a
// Fishtape company's invoices can be touched; other invoices on the account are "not found".
import { hqAudit, requireHqAdmin } from '../services/hq-common.js';
import { createFinance, financeCsv } from '../services/hq-finance.js';

const invoiceParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^in_[A-Za-z0-9_]{1,250}$' } } };
const money = (c) => `$${(c / 100).toFixed(2)}`;
const amountBody = {
  type: 'object', required: ['amountCents', 'reason', 'requestKey'], additionalProperties: false,
  properties: {
    amountCents: { type: 'integer', minimum: 1, maximum: 100000000 },
    reason: { type: 'string', minLength: 5, maxLength: 500 },
    requestKey: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
    stripeReason: { type: 'string', enum: ['duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory'] },
  },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function hqFinanceRoutes(app, { config, db }) {
  const finance = createFinance({ config, db });
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  const names = async () => (await finance.companies()).names;

  app.get('/api/hq/finance', { config: hq, schema: { tags, summary: 'Finance summary from Stripe and the database (cached)' } }, async () => {
    const snap = await finance.snapshot();
    return { configured: finance.configured(), ...snap, companies: Object.fromEntries(await names()) };
  });

  app.post('/api/hq/finance/refresh', { config: hq, schema: { tags, summary: 'Refresh the finance summary from Stripe now' } }, async (req) => {
    await finance.refresh();
    await db.withHq((c) => hqAudit(c, req, null, { action: 'hq.finance_refresh', collection: 'finance_snapshots', summary: 'Refreshed finance from Stripe' }));
    const snap = await finance.snapshot();
    return { configured: true, ...snap, companies: Object.fromEntries(await names()) };
  });

  app.get('/api/hq/finance/export', {
    config: hq,
    schema: { tags, summary: 'Finance CSV (audited)', querystring: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['revenue', 'plans', 'renewals', 'failed'] } } } },
  }, async (req, reply) => {
    const snap = await finance.snapshot();
    if (!snap.data) { reply.code(409); return { error: { code: 'no_data', message: 'Refresh from Stripe first.', requestId: req.id } }; }
    const csv = financeCsv(req.query.kind, snap.data, await names());
    await db.withHq((c) => hqAudit(c, req, null, { action: 'hq.finance_export', collection: 'finance_snapshots', summary: `Exported ${req.query.kind} CSV` }));
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="fishtape-${req.query.kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  });

  app.get('/api/hq/invoices', {
    config: hq,
    schema: {
      tags, summary: 'Fishtape subscription invoices from Stripe',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          tenantId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['draft', 'open', 'paid', 'uncollectible', 'void'] },
          from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req) => finance.listInvoices(req.query));

  /** Audit in HQ's chain and the company's. */
  const audit = (req, tenant, action, summary, meta) => db.withHq(async (c) => {
    await hqAudit(c, req, null, { action, collection: 'invoices_stripe', recordId: req.params.id, summary: `${tenant.name}: ${summary}`.slice(0, 500), meta });
    await hqAudit(c, req, tenant.id, { action, collection: 'invoices_stripe', recordId: req.params.id, summary: `Fishtape billing: ${summary}`.slice(0, 500), meta });
  });

  app.post('/api/hq/invoices/:id/resend', { config: hq, schema: { tags, summary: 'Email the invoice to the company again (audited)', params: invoiceParams } }, async (req) => {
    const { inv, tenant } = await finance.resend(req.params.id);
    await audit(req, tenant, 'hq.invoice_resend', `invoice ${inv.number || inv.id} sent again`);
    return { ok: true };
  });

  app.post('/api/hq/invoices/:id/uncollectible', {
    config: hq,
    schema: { tags, summary: 'Mark an open invoice uncollectible (HQ admin; audited)', params: invoiceParams, body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } } } },
  }, async (req) => {
    requireHqAdmin(req);
    const { inv, tenant } = await finance.markUncollectible(req.params.id);
    await audit(req, tenant, 'hq.invoice_uncollectible', `invoice ${inv.number || inv.id} marked uncollectible: ${req.body.reason.trim()}`);
    return { ok: true, status: inv.status || 'uncollectible' };
  });

  app.post('/api/hq/invoices/:id/credit-note', { config: hq, schema: { tags, summary: 'Issue a credit note (HQ admin; amount and reason; audited)', params: invoiceParams, body: amountBody } }, async (req) => {
    requireHqAdmin(req);
    const b = req.body;
    const { inv, tenant, note } = await finance.creditNote(req.params.id, { amountCents: b.amountCents, reason: b.reason.trim(), stripeReason: b.stripeReason, requestKey: b.requestKey });
    await audit(req, tenant, 'hq.invoice_credit_note', `credit note ${money(note.amountCents)} on invoice ${inv.number || inv.id}: ${b.reason.trim()}`, { amountCents: note.amountCents, creditNote: note.id });
    return { ok: true, creditNote: note };
  });

  app.post('/api/hq/invoices/:id/refund', { config: hq, schema: { tags, summary: 'Refund a paid invoice (HQ admin; amount and reason; audited)', params: invoiceParams, body: amountBody } }, async (req) => {
    requireHqAdmin(req);
    const b = req.body;
    const { inv, tenant, refund } = await finance.refund(req.params.id, { amountCents: b.amountCents, reason: b.reason.trim(), requestKey: b.requestKey, hqUserId: req.principal.userId });
    await audit(req, tenant, 'hq.invoice_refund', `refund ${money(refund.amountCents)} on invoice ${inv.number || inv.id}: ${b.reason.trim()}`, { amountCents: refund.amountCents, refund: refund.id });
    return { ok: true, refund };
  });

}
