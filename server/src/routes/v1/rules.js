// GET /api/v1/rules/effective: the rules table in force for a province and day (docs/releases/r1-get-paid.md
// 2.7, docs/office/rules-table.md). Definitions come from electrical-app/js/lib/rules.js; values are
// Fishtape's platform rows (platform_rules, maintained by HQ) and the company's own overrides (the
// `rules` collection, edited on Books → Rules like any record). Any signed-in member may read it:
// it holds law and policy, never money. The PWA keeps the last answer for offline use.
import { RULE_DEFS, resolveRules } from '../../../../electrical-app/js/lib/rules.js';
import { dayIn, zoneFor } from '../../../../electrical-app/js/lib/closing.js';
import { errorResponses, tenantCtx } from '../util.js';

const ruleOut = (key, r) => ({
  key, province: r.province, value: r.value, status: r.status, origin: r.origin, source: r.source, sourceUrl: r.sourceUrl, note: r.note,
  effectiveFrom: r.effectiveFrom, confirmedBy: r.confirmedBy, confirmedAt: r.confirmedAt,
  ...(r.id ? { id: r.id } : {}), ...(r.staleOverride ? { staleOverride: true } : {}), ...(r.missingYear ? { missingYear: r.missingYear } : {}),
});

/** @param {import('fastify').FastifyInstance} app */
export default async function rulesRoutes(app, { db }) {
  // Not /api/v1/rules: that is the `rules` collection's REST list (company overrides), so the table in
  // force lives one level down (a static path beats the collection's /:id route).
  app.get('/api/v1/rules/effective', {
    config: { auth: 'tenant' },
    schema: {
      tags: ['rules'], summary: 'The rules table in force',
      description: 'Legal and statutory values (prompt-payment day counts, holdback, payroll maximums, tax timing) for a province and day: Fishtape\'s rows with the company\'s overrides applied. A value whose status is verify never drives a deadline.',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { province: { type: 'string', pattern: '^[A-Z]{2}$' }, on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      },
      response: { ...errorResponses },
    },
  }, async (req) => {
    const p = req.principal;
    return db.withTenant(tenantCtx(p), async (tx) => {
      const { rows: s } = await tx.query("SELECT data->'company'->>'province' AS province FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
      const province = req.query.province || s[0]?.province || 'ON';
      const on = req.query.on || dayIn(new Date().toISOString(), zoneFor(s[0]?.province));
      const { rows: platform } = await tx.query(
        "SELECT key, province, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, value, status, source, source_url, note, confirmed_by, confirmed_at FROM platform_rules WHERE province IN ('', $1)", [province]);
      const { rows: company } = await tx.query('SELECT id, data FROM rules WHERE tenant_id = $1 AND deleted_at IS NULL', [tx.tenantId]);
      const resolved = resolveRules(platform, company.map((r) => ({ ...r.data, id: r.id })), { province, on });
      const defs = Object.fromEntries(Object.entries(RULE_DEFS).map(([k, d]) => [k, {
        label: d.label, unit: d.unit, kind: d.kind, scope: d.scope, province: d.province, yearly: d.yearly, companyOnly: d.companyOnly, usedBy: d.usedBy, description: d.description,
      }]));
      return { province, on, defs, rules: [...resolved.entries()].map(([k, r]) => ruleOut(k, r)) };
    });
  });
}
