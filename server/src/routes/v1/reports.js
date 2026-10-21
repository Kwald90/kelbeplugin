// /api/v1/reports: job costing reports (docs/releases/r1-get-paid.md 6, 11; docs/office/job-costing.md).
//   GET /api/v1/reports/job-profit?from&to&jobId&format=csv   revenue, cost by type and cost code, margin
//   GET /api/v1/reports/wip?asOf&format=csv                  work in progress (plan feature reports.wip)
//   GET /api/v1/reports/rst?from&to&format=csv               the RST self-assessment worksheet
//   GET /api/v1/reports/break-even                           burden per employee, break-even, truck recovery
// Money: the `invoices` permission (an API key that may read invoices), the `reports` plan feature and
// module switch. Read-only: no audit event. Responses are never cached (app.js sets no-store).
import { badRequest, forbidden } from '../../errors.js';
import { canRead } from '../../auth/access.js';
import { assertFeature, requireFeature } from '../../services/entitlements.js';
import { requireModule } from '../../services/modules.js';
import { loadCostSources, jobProfitReport, jobProfitReportCsv, wip, wipReportCsv, rst, rstReportCsv, breakEvenReport } from '../../services/reports.js';
import { errorResponses, tenantCtx } from '../util.js';

const tags = ['reports'];
const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const FORMAT = { type: 'string', enum: ['json', 'csv'] };
const MAX_DAYS = 800;

/** Money readers only: the office (invoices permission), or an API key that may read invoices. */
function requireMoney(req) {
  const p = req.principal;
  const ok = p.kind === 'api_key' ? canRead(p, 'invoices') : p.perms?.has('invoices');
  if (!ok) throw forbidden('Job costing reports need the invoices permission.');
}

function checkRange(from, to) {
  if (from && to && to < from) throw badRequest('to is before from.');
  if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) throw badRequest(`Ask for at most ${MAX_DAYS} days at a time.`);
}

function csv(reply, name, text) {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${name}.csv"`);
  return text;
}

/** @param {import('fastify').FastifyInstance} app */
export default async function reportRoutes(app, { db }) {
  const pre = [requireFeature(db, 'reports'), requireModule(db, 'reports')];
  const load = (req) => db.withTenant(tenantCtx(req.principal), (tx) => loadCostSources(tx));

  app.get('/api/v1/reports/job-profit', {
    config: { auth: 'tenant' },
    preHandler: pre,
    schema: {
      tags, summary: 'Job profit',
      description: 'Per job for a period: revenue (invoice work lines, gross of holdback; never deposits, releases or interest), cost by type and cost code including accrued received-not-billed material, gross profit, margin, budget margin and committed purchase orders. invoices permission.',
      querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', pattern: DAY }, to: { type: 'string', pattern: DAY }, jobId: ID, format: FORMAT } },
      response: errorResponses,
    },
  }, async (req, reply) => {
    requireMoney(req);
    const { from = '', to = '', jobId = null, format } = req.query;
    checkRange(from, to);
    const src = await load(req);
    const list = jobProfitReport(src, { from, to, jobId });
    if (format === 'csv') return csv(reply, `job-profit-${to || src.today}`, jobProfitReportCsv(list));
    return { from: from || null, to: to || src.today, jobs: list };
  });

  app.get('/api/v1/reports/wip', {
    config: { auth: 'tenant' },
    preHandler: [...pre, async (req) => assertFeature(db, req.principal?.tenantId, 'reports.wip')],
    schema: {
      tags, summary: 'Work in progress',
      description: 'Per open fixed-price job (service calls excluded): contract, estimated cost, cost to date, percent complete (capped at 1, or the job\'s override), earned revenue (a projected loss is taken in full), billed, over and under billed; T&M jobs earn billed plus unbilled at sell. Also the contracts completed this fiscal year. Plan feature reports.wip.',
      querystring: { type: 'object', additionalProperties: false, properties: { asOf: { type: 'string', pattern: DAY }, format: FORMAT } },
      response: errorResponses,
    },
  }, async (req, reply) => {
    requireMoney(req);
    const src = await load(req);
    const report = wip(src, { asOf: req.query.asOf || '' });
    if (req.query.format === 'csv') return csv(reply, `wip-${report.asOf}`, wipReportCsv(report));
    return report;
  });

  app.get('/api/v1/reports/rst', {
    config: { auth: 'tenant' },
    preHandler: pre,
    schema: {
      tags, summary: 'RST self-assessment worksheet',
      description: 'For a date range (default last month): own-use material and bill lines to self-assess at the rate on the day, and resale lines a supplier charged RST on (credits to claim). It files nothing: add the self-assessed RST to the return QuickBooks prepares.',
      querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', pattern: DAY }, to: { type: 'string', pattern: DAY }, format: FORMAT } },
      response: errorResponses,
    },
  }, async (req, reply) => {
    requireMoney(req);
    checkRange(req.query.from, req.query.to);
    const src = await load(req);
    const report = rst(src, { from: req.query.from || '', to: req.query.to || '' });
    if (req.query.format === 'csv') return csv(reply, `rst-${report.from}-to-${report.to}`, rstReportCsv(report, src));
    return report;
  });

  app.get('/api/v1/reports/break-even', {
    config: { auth: 'tenant' },
    preHandler: pre,
    schema: {
      tags, summary: 'Rates and break-even',
      description: 'Burden per field employee (CPP, EI and WCB with their yearly maximums, vacation and holiday pay, non-productive time), the break-even and target billing rates (labour cost only without overhead), equipment recovery per productive hour, and each truck\'s recovery against its bills this year.',
      response: errorResponses,
    },
  }, async (req) => {
    requireMoney(req);
    const src = await load(req);
    return breakEvenReport(src);
  });
}
