// HQ Rules: the platform rows of the rules table (docs/releases/r1-get-paid.md 2.7). Legal and
// statutory values Fishtape maintains for every company: prompt-payment day counts, holdback,
// payroll maximums, tax timing. Definitions (label, unit, kind) live in code
// (electrical-app/js/lib/rules.js RULE_DEFS); values live in `platform_rules`, edited here.
// A company may override a row with its own record (Books -> Rules); that is not HQ's business.
//
//   GET    /api/hq/rules                                         definitions, platform rows, gaps (HQ staff)
//   PUT    /api/hq/rules                                         add or change one row (HQ admin; audited)
//   DELETE /api/hq/rules?key=&province=&effectiveFrom=           remove one row (HQ admin; audited)
//
// Statuses: verified (a lawyer, accountant or the official text confirmed it: who and when are
// required), sourced (a published source is cited), verify (unconfirmed). A deadline never runs on
// `verify`; that is enforced where rules are read (lib/rules.js ruleValue), not here.
import { ApiError, notFound } from '../errors.js';
import { hqAudit, iso, requireHqAdmin } from '../services/hq-common.js';

const KEY_RE = '^[a-z][A-Za-z0-9]*(\\.[A-Za-z0-9]+){1,5}$';
const DAY_RE = '^\\d{4}-\\d{2}-\\d{2}$';
const DEFAULT_FROM = '1900-01-01';

/** A real calendar day as YYYY-MM-DD, or null. */
function validDay(s) {
  if (typeof s !== 'string' || !new RegExp(DAY_RE).test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

const toRow = (r) => ({
  key: r.key, province: r.province, effectiveFrom: r.effective_from, value: r.value ?? null, status: r.status,
  source: r.source, sourceUrl: r.source_url, note: r.note, confirmedBy: r.confirmed_by, confirmedAt: iso(r.confirmed_at),
  updatedBy: r.updated_by, updatedAt: iso(r.updated_at),
});

const SELECT = `SELECT key, province, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, value, status, source, source_url,
                       note, confirmed_by, confirmed_at, updated_by, updated_at FROM platform_rules`;

/** Only plain, JSON-safe definition fields go to the browser. */
function publicDefs(defs) {
  const out = {};
  for (const [key, d] of Object.entries(defs)) {
    out[key] = {
      label: d.label ?? key, unit: d.unit ?? null, kind: d.kind ?? null, scope: d.scope ?? null, province: d.province ?? null,
      yearly: Boolean(d.yearly), usedBy: Array.isArray(d.usedBy) ? d.usedBy : [], description: d.description ?? null,
    };
  }
  return out;
}

/** Company-only keys (a company's WCB rate, its health levy) have no platform row. */
const companyOnly = (key, def) => def?.scope === 'company' || key.startsWith('payroll.company.');

/**
 * Problems with one platform row, as { field: message }, checked against its definition.
 * @param {object} lib the rules library ({ RULE_DEFS, RULE_STATUS, ruleProblem })
 */
export function platformRuleProblems(lib, row) {
  const errors = {};
  const def = Object.hasOwn(lib.RULE_DEFS, row.key) ? lib.RULE_DEFS[row.key] : null;
  if (!def) errors.key = 'Not a rule Fishtape defines (electrical-app/js/lib/rules.js RULE_DEFS).';
  else if (companyOnly(row.key, def)) errors.key = 'This rule is set by each company (Books > Rules), not platform-wide.';
  if (def?.province && row.province !== def.province) errors.province = `This rule is for ${def.province} only.`;
  else if (row.province && !/^[A-Z]{2}$/.test(row.province)) errors.province = 'Use a two-letter province code, or leave it empty for every province.';
  if (!validDay(row.effectiveFrom)) errors.effectiveFrom = 'Use a date (YYYY-MM-DD).';
  else if (def?.yearly && !/^\d{4}-01-01$/.test(row.effectiveFrom)) errors.effectiveFrom = 'A yearly value starts on 1 January of its year.';
  if (!lib.RULE_STATUS.includes(row.status)) errors.status = `Use one of: ${lib.RULE_STATUS.join(', ')}.`;
  if (def && row.value !== null) {
    const p = lib.ruleProblem(def, row.value);
    if (p) errors.value = p;
  }
  if (row.status === 'verified') {
    if (!row.confirmedBy) errors.confirmedBy = 'Say who confirmed it (name and role) before marking it verified.';
    if (!row.confirmedAt) errors.confirmedAt = 'Say when it was confirmed before marking it verified.';
  }
  if (row.status !== 'verify' && row.value !== null && !row.source && !row.sourceUrl) errors.source = 'Name the source (or set the status to verify).';
  if (row.sourceUrl && !/^https:\/\/\S+$/.test(row.sourceUrl)) errors.sourceUrl = 'Use an https:// link.';
  return errors;
}

/**
 * Gaps HQ should fix: yearly values missing for this year, and rows at `verify` that a deadline or
 * rate would need (no alarm runs, or the calculation uses its fallback, until they are confirmed).
 */
export function ruleGaps(defs, rows, year = new Date().getUTCFullYear()) {
  const gaps = [];
  for (const [key, d] of Object.entries(defs)) {
    if (companyOnly(key, d)) continue;
    const mine = rows.filter((r) => r.key === key);
    if (!mine.length) { gaps.push({ key, code: 'missing', text: 'No platform row.' }); continue; }
    if (d.yearly && !mine.some((r) => r.effectiveFrom === `${year}-01-01` && r.value !== null)) {
      gaps.push({ key, code: 'missing_year', text: `No ${year} value: calculations warn and use the company fallback.` });
    }
    const newest = [...mine].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (newest.status === 'verify' && (d.kind === 'deadline' || d.kind === 'rate')) {
      gaps.push({ key, code: 'verify', text: d.kind === 'deadline' ? 'Unconfirmed: no alarm or countdown runs on it.' : 'Unconfirmed: calculations use their fallback.' });
    }
  }
  return gaps;
}

const rowBody = {
  type: 'object', additionalProperties: false, required: ['key', 'status'],
  properties: {
    key: { type: 'string', pattern: KEY_RE, maxLength: 120 },
    province: { type: 'string', pattern: '^([A-Z]{2})?$', default: '' },
    effectiveFrom: { type: 'string', pattern: DAY_RE, default: DEFAULT_FROM },
    value: { type: ['number', 'string', 'boolean', 'array', 'null'], maxLength: 2000, maxItems: 100, default: null },
    status: { type: 'string', maxLength: 20 },
    source: { type: ['string', 'null'], maxLength: 500 },
    sourceUrl: { type: ['string', 'null'], maxLength: 500 },
    note: { type: ['string', 'null'], maxLength: 1000 },
    confirmedBy: { type: ['string', 'null'], maxLength: 200 },
    confirmedAt: { type: ['string', 'null'], maxLength: 40 },
  },
};

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{ config: object, db: object }} deps config.hq.ruleLib may inject the rules library (tests)
 */
export default async function hqRulesRoutes(app, { config, db }) {
  const lib = config.hq?.ruleLib || await import('../../../electrical-app/js/lib/rules.js');
  const hq = { auth: 'hq' };
  const tags = ['hq'];
  const noStore = (reply) => reply.header('cache-control', 'no-store');

  app.get('/api/hq/rules', { config: hq, schema: { tags, summary: 'The rules table: definitions, platform rows and gaps' } }, async (req, reply) => {
    noStore(reply);
    const rows = (await db.withHq((c) => c.query(`${SELECT} ORDER BY key, province, effective_from`))).rows.map(toRow);
    const defs = publicDefs(lib.RULE_DEFS);
    return { defs, statuses: lib.RULE_STATUS, rows, gaps: ruleGaps(defs, rows) };
  });

  app.put('/api/hq/rules', { config: hq, schema: { tags, summary: 'Add or change one platform rule row (HQ admin; audited)', body: rowBody } }, async (req, reply) => {
    noStore(reply);
    requireHqAdmin(req);
    const b = req.body;
    const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const row = {
      key: b.key, province: b.province || '', effectiveFrom: b.effectiveFrom || DEFAULT_FROM, value: b.value ?? null, status: b.status,
      source: clean(b.source), sourceUrl: clean(b.sourceUrl), note: clean(b.note), confirmedBy: clean(b.confirmedBy), confirmedAt: null,
    };
    if (clean(b.confirmedAt)) {
      const t = Date.parse(validDay(b.confirmedAt) ? `${b.confirmedAt}T00:00:00Z` : b.confirmedAt);
      row.confirmedAt = Number.isFinite(t) ? new Date(t).toISOString() : 'invalid';
    }
    const errors = platformRuleProblems(lib, row);
    if (row.confirmedAt === 'invalid') errors.confirmedAt = 'Use a date (YYYY-MM-DD).';
    else if (row.confirmedAt && Date.parse(row.confirmedAt) > Date.now() + 86_400_000) errors.confirmedAt = 'That date is in the future.';
    if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', 'Check the highlighted fields.', { errors });
    // Unverified rows keep no confirmation (the database requires both for verified ones).
    if (row.status !== 'verified') { row.confirmedBy = null; row.confirmedAt = null; }

    return db.withHq(async (c) => {
      const before = (await c.query(`${SELECT} WHERE key = $1 AND province = $2 AND effective_from = $3::date`, [row.key, row.province, row.effectiveFrom])).rows[0];
      const { rows } = await c.query(
        `INSERT INTO platform_rules (key, province, effective_from, value, status, source, source_url, note, confirmed_by, confirmed_at, updated_by, updated_at)
         VALUES ($1, $2, $3::date, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (key, province, effective_from) DO UPDATE SET value = EXCLUDED.value, status = EXCLUDED.status, source = EXCLUDED.source,
           source_url = EXCLUDED.source_url, note = EXCLUDED.note, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING key, province, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, value, status, source, source_url, note,
                   confirmed_by, confirmed_at, updated_by, updated_at`,
        [row.key, row.province, row.effectiveFrom, row.value === null ? null : JSON.stringify(row.value), row.status, row.source, row.sourceUrl,
          row.note, row.confirmedBy, row.confirmedAt, String(req.principal.actor?.label || 'HQ').slice(0, 200)]);
      const where = `${row.key}${row.province ? ` (${row.province})` : ''} from ${row.effectiveFrom}`;
      await hqAudit(c, req, null, {
        action: 'hq.rule_set', collection: 'platform_rules', recordId: `${row.key}|${row.province}|${row.effectiveFrom}`.slice(0, 200),
        summary: before
          ? `Rule ${where}: ${JSON.stringify(before.value)} (${before.status}) -> ${JSON.stringify(row.value)} (${row.status})`
          : `Rule ${where} added: ${JSON.stringify(row.value)} (${row.status})`,
        meta: {
          key: row.key, province: row.province, effectiveFrom: row.effectiveFrom,
          from: before ? { value: before.value ?? null, status: before.status, source: before.source, confirmedBy: before.confirmed_by } : null,
          to: { value: row.value, status: row.status, source: row.source, confirmedBy: row.confirmedBy },
        },
      });
      return { rule: toRow(rows[0]), created: !before };
    });
  });

  app.delete('/api/hq/rules', {
    config: hq,
    schema: {
      tags, summary: 'Remove one platform rule row (HQ admin; audited)',
      querystring: {
        type: 'object', additionalProperties: false, required: ['key', 'effectiveFrom'],
        properties: { key: { type: 'string', pattern: KEY_RE, maxLength: 120 }, province: { type: 'string', pattern: '^([A-Z]{2})?$', default: '' }, effectiveFrom: { type: 'string', pattern: DAY_RE } },
      },
    },
  }, async (req, reply) => {
    noStore(reply);
    requireHqAdmin(req);
    const { key, province = '', effectiveFrom } = req.query;
    return db.withHq(async (c) => {
      const { rows } = await c.query('DELETE FROM platform_rules WHERE key = $1 AND province = $2 AND effective_from = $3::date RETURNING value, status', [key, province, effectiveFrom]);
      if (!rows[0]) throw notFound('No such rule row.');
      await hqAudit(c, req, null, {
        action: 'hq.rule_delete', collection: 'platform_rules', recordId: `${key}|${province}|${effectiveFrom}`.slice(0, 200),
        summary: `Rule ${key}${province ? ` (${province})` : ''} from ${effectiveFrom} removed (was ${JSON.stringify(rows[0].value)}, ${rows[0].status})`,
        meta: { key, province, effectiveFrom, from: { value: rows[0].value ?? null, status: rows[0].status } },
      });
      return { deleted: true };
    });
  });
}
