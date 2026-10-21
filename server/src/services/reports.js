// Job costing reports on the server (docs/releases/r1-get-paid.md 6, 11; docs/office/job-costing.md):
// job profit, WIP, the RST self-assessment worksheet and the break-even rates, computed with the PWA's
// own pure libraries (electrical-app/js/lib/costing.js, rst.js, burden.js) over records loaded in one
// tenant transaction, so the API, its CSV and the screens report the same numbers.
import { COLLECTIONS as ALL, collectionDef } from '../collections.js';
import { badRequest } from '../errors.js';
import { COST_COLLECTIONS, jobProfitList, jobProfitCsv, wipReport, wipCsv, breakEven, equipmentRecovery } from '../../../electrical-app/js/lib/costing.js';
import { rstSelfAssessment, rstCsv } from '../../../electrical-app/js/lib/rst.js';
import { dayIn, zoneFor } from '../../../electrical-app/js/lib/closing.js';

/** Rows per collection a report reads; a company over it asks for a narrower report. */
export const MAX_ROWS = 100_000;

/** "$1,234.56" style amounts for the CSV files (plain numbers with two decimals). */
export const csvMoney = (c) => (Number(c || 0) / 100).toFixed(2);

/**
 * The records the costing libraries read, plus the company's settings, zone, today and rules
 * ({ platform, company } rows for lib/burden.js rulesFor). Read inside the tenant's transaction.
 */
export async function loadCostSources(tx, collections = COST_COLLECTIONS) {
  const out = {};
  for (const coll of collections) {
    if (!ALL.includes(coll)) continue;
    const def = collectionDef(coll);
    const { rows } = await tx.query(`SELECT id, data FROM ${def.table} WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT $2`, [tx.tenantId, MAX_ROWS + 1]);
    if (rows.length > MAX_ROWS) throw badRequest(`Too many ${coll} records for one report; ask for a narrower one.`);
    out[coll] = rows.map((r) => ({ ...r.data, id: r.id }));
  }
  const { rows: s } = await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  const settings = s[0]?.data || {};
  const province = settings.company?.province || 'ON';
  const zone = zoneFor(province);
  const { rows: platform } = await tx.query(
    "SELECT key, province, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, value, status, source, source_url, note, confirmed_by, confirmed_at FROM platform_rules WHERE province IN ('', $1)", [province]);
  const { rows: company } = await tx.query('SELECT id, data FROM rules WHERE tenant_id = $1 AND deleted_at IS NULL', [tx.tenantId]);
  return {
    ...out, settings, province, zone, today: dayIn(new Date().toISOString(), zone),
    rules: { platform, company: company.map((r) => ({ ...r.data, id: r.id })) },
    dayOf: (iso) => dayIn(iso, zone),
  };
}

/** The job-profit list for a period (and one job). Drops the per-record detail the screens don't need. */
export function jobProfitReport(src, { from = '', to = '', jobId = null } = {}) {
  const jobs = (src.jobs || []).filter((j) => !jobId || j.id === jobId);
  const list = jobProfitList({ ...src, jobs, from, to: to || src.today });
  return list.map(({ actuals, budget, ...rest }) => ({ ...rest, budgetLabourHours: budget?.labourHours ?? null, committed: actuals.committed, accrued: actuals.accrued, burdenCents: actuals.burdenCents, otPremiumCents: actuals.otPremiumCents, truckCents: actuals.truckCents }));
}

export function jobProfitReportCsv(list) {
  return jobProfitCsv(list, { money: csvMoney });
}

export function wip(src, { asOf = '' } = {}) {
  return wipReport({ ...src, asOf: asOf || src.today });
}

export function wipReportCsv(report) {
  return wipCsv(report, { money: csvMoney });
}

/** The RST worksheet (3.5) for a range; default last month. */
export function rst(src, { from = '', to = '' } = {}) {
  let f = from, t = to;
  if (!f || !t) {
    const [y, m] = src.today.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 2, 1));
    const last = new Date(Date.UTC(y, m - 1, 0));
    f = f || first.toISOString().slice(0, 10);
    t = t || last.toISOString().slice(0, 10);
  }
  const r = rstSelfAssessment({ ...src, from: f, to: t, province: src.province });
  return { from: f, to: t, province: src.province, ...r };
}

export function rstReportCsv(report, src) {
  return rstCsv(report, { money: csvMoney, jobs: new Map((src.jobs || []).map((j) => [j.id, j])), vendors: new Map((src.vendors || []).map((v) => [v.id, v])) });
}

/** Break-even rates (6.5) and each truck's recovery against its bills, year to date. */
export function breakEvenReport(src) {
  const be = breakEven({ ...src, on: src.today });
  const yearStart = `${src.today.slice(0, 4)}-01-01`;
  const trucks = equipmentRecovery({ ...src, from: yearStart, to: src.today });
  return { asOf: src.today, ...be, labourRateCents: Number.isFinite(Number(src.settings?.labourRateCents)) ? Number(src.settings.labourRateCents) : null, equipment: trucks };
}
