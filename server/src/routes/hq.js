// /api/hq/*: Fishtape HQ (staff only). Uses the fishtape_hq role (BYPASSRLS); every read
// of a tenant's own data writes an audit event into that tenant's chain.
import { notFound } from '../errors.js';
import { appendAudit, requestFacts } from '../services/audit.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function hqRoutes(app, { db }) {
  app.get('/api/hq/tenants', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'Companies with member counts' } }, async () => {
    const rows = await db.withHq(async (c) => (await c.query(
      `SELECT t.id, t.slug, t.name, t.status, t.province, t.plan, t.created_at,
              (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS members
         FROM tenants t ORDER BY t.created_at`)).rows);
    return { data: rows.map((t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status, province: t.province, plan: t.plan, createdAt: t.created_at, members: t.members })) };
  });

  app.get('/api/hq/tenants/:id/audit/verify', {
    config: { auth: 'hq' },
    schema: { tags: ['hq'], summary: 'Verify a company\'s audit hash chain (audited)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    return db.withHq(async (c) => {
      const t = await c.query('SELECT id, name FROM tenants WHERE id = $1', [req.params.id]);
      if (!t.rows[0]) throw notFound('No such company.');
      const { rows } = await c.query('SELECT * FROM audit_verify_chain($1)', [req.params.id]);
      // Reading a tenant's audit log is a read of tenant data: record it in their chain.
      await appendAudit(c, req.params.id, {
        actor: req.principal.actor, action: 'hq.audit_verify', collection: 'audit_events', summary: `HQ verified the audit chain (${rows[0].checked} events)`, request: requestFacts(req),
      });
      return { tenantId: req.params.id, ok: rows[0].ok, checked: rows[0].checked, firstBadSeq: rows[0].first_bad_seq };
    });
  });
}
