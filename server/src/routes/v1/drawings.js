// GET /api/v1/drawings/:id/cost-impact: what the job's drawings show now against the job's
// estimate (and change orders already raised from drawings), priced from the price book.
// Computed with the PWA's own lib/drawing-costs.js, so the editor's Changes panel and the API
// agree. Read-only: no audit event.
//
// Money roles (owner, admin, office, foremen when the company allows it, API keys whose scopes
// cover items, estimates, jobs and settings) get the prices; anyone else who may read the
// drawing gets only what changed and who changed it, never a price, cost, rate or hour (redactCostImpact). Another company's drawing is a 404.
import { notFound, forbidden } from '../../errors.js';
import { canRead, seesMoney, redactForReader } from '../../auth/access.js';
import { loadMoneyAccess } from '../../services/records.js';
import { jobCostImpact, publicCostImpact, redactCostImpact } from '../../../../electrical-app/js/lib/drawing-costs.js';
import { errorResponses, tenantCtx } from '../util.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } } };
/** Collections the priced comparison reads money from. */
const PRICE_SOURCES = ['items', 'estimates', 'jobs', 'settings'];
/** Most drawings of one job read for a comparison (objects and history only). */
const MAX_JOB_DRAWINGS = 500;

/** @param {import('fastify').FastifyInstance} app */
export default async function drawingRoutes(app, { db }) {
  app.get('/api/v1/drawings/:id/cost-impact', {
    config: { auth: 'tenant' },
    schema: {
      tags: ['drawings'],
      summary: "Cost impact of a drawing's changes against its job's estimate",
      description: 'Symbols on all of the job\'s drawings compared with the estimate takeoff plus change orders already raised from drawings. '
        + 'Money roles get material, markup and labour; other readers get the changed counts and who changed them, without prices.',
      params: idParam,
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    if (!canRead(p, 'drawings')) throw forbidden('You cannot read drawings.');
    return db.withTenant(tenantCtx(p), async (tx) => {
      await loadMoneyAccess(tx, p);
      const one = await tx.query("SELECT id, data->>'jobId' AS job_id FROM drawings WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL", [tx.tenantId, req.params.id]);
      if (!one.rows[0]) throw notFound();
      const jobId = one.rows[0].job_id;
      // An API key gets prices only when its scopes also cover where they come from (the price
      // book, the estimate, the job and the company rates), as they would through /records.
      const money = seesMoney(p) && (p.kind !== 'api_key' || PRICE_SOURCES.every((c) => canRead(p, c)));
      if (!jobId) return { drawingId: req.params.id, ...(money ? publicCostImpact({ ready: false, reason: 'no-job' }) : redactCostImpact({ ready: false, reason: 'no-job' })) };

      const jobRow = await tx.query('SELECT id, data FROM jobs WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, jobId]);
      const job = jobRow.rows[0] ? { ...jobRow.rows[0].data, id: jobRow.rows[0].id } : null;
      const [drawings, estimates, items, settings] = await Promise.all([
        tx.query(`SELECT id, jsonb_build_object('objects', data->'objects', 'history', data->'history', 'name', data->'name') AS data
                    FROM drawings WHERE tenant_id = $1 AND job_id = $2 AND deleted_at IS NULL LIMIT ${MAX_JOB_DRAWINGS}`, [tx.tenantId, jobId]),
        tx.query('SELECT id, data FROM estimates WHERE tenant_id = $1 AND deleted_at IS NULL AND (job_id = $2 OR id = $3)', [tx.tenantId, jobId, job?.estimateId ?? '']),
        tx.query("SELECT id, data FROM items WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'symbol' IS NOT NULL", [tx.tenantId]),
        tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]),
      ]);
      const rec = (r) => ({ ...r.data, id: r.id });
      const r = jobCostImpact({
        job, drawings: drawings.rows.map(rec), estimates: estimates.rows.map(rec), items: items.rows.map(rec), settings: settings.rows[0]?.data || {},
      });
      const body = money ? publicCostImpact(r) : redactCostImpact(r);
      // the job reference as this reader may see it
      if (body.job && job) body.job = { id: job.id, number: redactForReader(p, 'jobs', job).number ?? null, title: job.title ?? null };
      return { drawingId: req.params.id, ...body };
    });
  });
}
