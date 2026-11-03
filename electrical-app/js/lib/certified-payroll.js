// Certified / prevailing-wage payroll: hours by PROJECT x WORKER x CLASSIFICATION, the breakdown a
// government job's certified payroll report needs. The classification is the worker's labour level
// (lib/labour-levels.js); the rate is the worker's own pay rate, falling back to the level's cost
// rate. Pure logic, shared by the Labour module and tested. Hours are decimal; money is cents (CAD).

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const minutes = (v) => Math.max(0, Number(v) || 0);

/**
 * Roll time entries up to one row per job + worker + classification.
 * @param {{ employeeId:string, jobId?:string, minutes:number }[]} entries
 * @param {{
 *   people?: Map, jobs?: Map,            // id -> employee / job record (for names)
 *   levelOf: (employeeId:string)=>object|null,   // the worker's labour level, or null
 *   rateFor: (employeeId:string, level:object|null)=>number, // pay rate in cents/hour
 * }} ctx
 * @returns {{ jobId, jobName, employeeId, workerName, levelId, classification, hours, rateCents, grossCents }[]}
 */
export function certifiedRows(entries, { people = new Map(), jobs = new Map(), levelOf, rateFor } = {}) {
  const get = (m, id) => (id == null ? null : (m instanceof Map ? m.get(id) : m?.[id]) || null);
  const groups = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.employeeId) continue;
    const min = minutes(e.minutes);
    if (!min) continue;
    const key = `${e.jobId || ''}|${e.employeeId}`;
    if (!groups.has(key)) groups.set(key, { jobId: e.jobId || null, employeeId: e.employeeId, min: 0 });
    groups.get(key).min += min;
  }
  const rows = [...groups.values()].map((g) => {
    const level = levelOf ? levelOf(g.employeeId) : null;
    const rateCents = Math.max(0, Math.round((rateFor ? rateFor(g.employeeId, level) : 0) || 0));
    const hours = round2(g.min / 60);
    return {
      jobId: g.jobId,
      jobName: get(jobs, g.jobId)?.name || (g.jobId ? 'Job' : 'No job'),
      employeeId: g.employeeId,
      workerName: get(people, g.employeeId)?.name || 'Crew',
      levelId: level?.id || null,
      classification: level?.name || 'Unassigned',
      hours,
      rateCents,
      grossCents: Math.round(hours * rateCents),
    };
  });
  rows.sort((a, b) => a.jobName.localeCompare(b.jobName) || a.workerName.localeCompare(b.workerName) || a.classification.localeCompare(b.classification));
  return rows;
}

const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** A certified-payroll CSV: one row per job + worker + classification, with a totals line. */
export function certifiedCsv(rows, { from = '', to = '' } = {}) {
  const head = ['Project', 'Worker', 'Classification', 'Hours', 'Rate ($/h)', 'Gross ($)'];
  const body = (rows || []).map((r) => [r.jobName, r.workerName, r.classification, r.hours.toFixed(2), (r.rateCents / 100).toFixed(2), (r.grossCents / 100).toFixed(2)].map(esc).join(','));
  const totalH = round2((rows || []).reduce((s, r) => s + r.hours, 0));
  const totalG = (rows || []).reduce((s, r) => s + r.grossCents, 0);
  const title = `Certified payroll${from || to ? ` ${from} to ${to}` : ''}`;
  return [esc(title), head.join(','), ...body, ['TOTAL', '', '', totalH.toFixed(2), '', (totalG / 100).toFixed(2)].map(esc).join(',')].join('\n');
}
