// GET /api/v1/kpis: crew KPIs from work tasks over a date range, and a work plan's progress
// (by phase, burn-up, forecast finish). Computed with the PWA's own lib/kpis.js, so the API,
// HQ and the screens report the same numbers. Read-only: no audit event. Needs the `kpis`
// permission (owner, admin, office, foreman) or an API key that may read workTasks, and the
// `kpis` plan feature.
import { badRequest, forbidden, notFound } from '../../errors.js';
import { canRead } from '../../auth/access.js';
import { requireFeature } from '../../services/entitlements.js';
import { crewKpis, jobProgress } from '../../../../electrical-app/js/lib/kpis.js';
import { errorResponses, tenantCtx } from '../util.js';

const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
const MAX_DAYS = 400;
const MAX_TASKS = 20_000;
export const KPI_NOTE = 'KPIs describe what was recorded, not how good anyone is. Read them with context: weather, deliveries, other trades, the task mix and plan changes all move them.';

const query = {
  type: 'object', additionalProperties: false, required: ['from', 'to'],
  properties: {
    from: { type: 'string', pattern: DAY }, to: { type: 'string', pattern: DAY },
    planId: { type: 'string', minLength: 1, maxLength: 128 }, jobId: { type: 'string', minLength: 1, maxLength: 128 },
    employeeId: { type: 'string', minLength: 1, maxLength: 128 },
  },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function kpiRoutes(app, { db }) {
  app.get('/api/v1/kpis', {
    config: { auth: 'tenant' },
    preHandler: requireFeature(db, 'kpis'),
    schema: {
      tags: ['workplan'],
      summary: 'Crew KPIs for a date range, and a work plan\'s progress',
      description: `Per worker and crew: tasks completed, on-time %, planned vs actual hours, quantity per hour by task type, blocked time and reasons, evidence compliance, rework. With planId: % complete by phase, burn-up and forecast finish. ${KPI_NOTE}`,
      querystring: query,
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    const allowed = p.kind === 'api_key' ? canRead(p, 'workTasks') : p.perms.has('kpis');
    if (!allowed) throw forbidden('KPIs need the kpis permission.');
    const { from, to, planId, jobId, employeeId } = req.query;
    if (to < from) throw badRequest('to is before from.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) throw badRequest(`Ask for at most ${MAX_DAYS} days at a time.`);

    return db.withTenant(tenantCtx(p), async (tx) => {
      const params = [tx.tenantId, from, to];
      const where = ['tenant_id = $1', 'deleted_at IS NULL', 'day >= $2', 'day <= $3'];
      for (const [col, v] of [['plan_id', planId], ['job_id', jobId], ['employee_id', employeeId]]) {
        if (v) { params.push(v); where.push(`${col} = $${params.length}`); }
      }
      params.push(MAX_TASKS + 1);
      const { rows } = await tx.query(`SELECT id, data FROM work_tasks WHERE ${where.join(' AND ')} LIMIT $${params.length}`, params);
      if (rows.length > MAX_TASKS) throw badRequest('Too many tasks in this range; ask for a shorter one.');
      const tasks = rows.map((r) => ({ ...r.data, id: r.id }));
      const k = crewKpis(tasks, { from, to });

      const ids = k.workers.map((w) => w.employeeId);
      const names = new Map();
      if (ids.length && (p.kind !== 'api_key' || canRead(p, 'employees'))) {
        const e = await tx.query("SELECT id, data->>'name' AS name FROM employees WHERE tenant_id = $1 AND id = ANY($2)", [tx.tenantId, ids]);
        for (const r of e.rows) names.set(r.id, r.name);
      }

      let job = null;
      if (planId) {
        const plan = await tx.query('SELECT id, data FROM work_plans WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, planId]);
        if (!plan.rows[0]) throw notFound('No such work plan.');
        const all = await tx.query('SELECT id, data FROM work_tasks WHERE tenant_id = $1 AND plan_id = $2 AND deleted_at IS NULL LIMIT $3', [tx.tenantId, planId, MAX_TASKS]);
        // Progress as of the end of the range (or today, if that is earlier).
        const asOf = [to, new Date().toISOString().slice(0, 10)].sort()[0];
        job = jobProgress({ ...plan.rows[0].data, id: planId }, all.rows.map((r) => ({ ...r.data, id: r.id })), { today: asOf });
      }
      return {
        from, to, note: KPI_NOTE,
        workers: k.workers.map((w) => ({ ...w, name: names.get(w.employeeId) ?? null })),
        crew: k.crew,
        job,
      };
    });
  });
}
