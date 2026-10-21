// Cost codes (docs/releases/r1-get-paid.md 2.8, docs/office/cost-codes.md): one short list of job
// phases shared by estimate lines, invoice lines, time entries, bill and PO lines, stock moves,
// material requests, field tickets, equipment use and change orders, all through `costCodeId`.
// A missing code means "no code"; reports group it as "Uncoded". Pure (no DOM).

export const COST_CODE_GROUPS = [
  { id: 'rough-in', label: 'Rough-in' }, { id: 'service', label: 'Service and distribution' }, { id: 'trim', label: 'Trim and finish' },
  { id: 'change-order', label: 'Change orders' }, { id: 'service-call', label: 'Service calls' }, { id: 'callback', label: 'Callbacks and warranty' },
  { id: 'temp-power', label: 'Temporary power' }, { id: 'low-voltage', label: 'Low voltage' }, { id: 'general', label: 'General conditions' },
  { id: 'other', label: 'Other' },
];

/**
 * The standard nine, with fixed ids so "Add the standard codes" twice never duplicates. The callback
 * code is not billable and its material counts as own use (warranty material: RST self-assessed).
 */
export const STANDARD_COST_CODES = [
  { id: 'cc-rough-in', code: '100', name: 'Rough-in', group: 'rough-in', billable: true, ownUse: null, order: 1 },
  { id: 'cc-service', code: '200', name: 'Service and distribution', group: 'service', billable: true, ownUse: null, order: 2 },
  { id: 'cc-trim', code: '300', name: 'Trim and finish', group: 'trim', billable: true, ownUse: null, order: 3 },
  { id: 'cc-change-order', code: '400', name: 'Change orders', group: 'change-order', billable: true, ownUse: null, order: 4 },
  { id: 'cc-service-call', code: '500', name: 'Service calls', group: 'service-call', billable: true, ownUse: null, order: 5 },
  { id: 'cc-callback', code: '600', name: 'Callbacks and warranty', group: 'callback', billable: false, ownUse: 'callback', order: 6 },
  { id: 'cc-temp-power', code: '700', name: 'Temporary power', group: 'temp-power', billable: true, ownUse: null, order: 7 },
  { id: 'cc-low-voltage', code: '800', name: 'Low voltage', group: 'low-voltage', billable: true, ownUse: null, order: 8 },
  { id: 'cc-general', code: '900', name: 'General conditions', group: 'general', billable: true, ownUse: null, order: 9 },
];

export const UNCODED = 'Uncoded';

/** "100 Rough-in". */
export const costCodeLabel = (cc) => (cc ? `${cc.code} ${cc.name}`.trim() : UNCODED);

/** Active codes, in their order, then by code. */
export function activeCostCodes(list = []) {
  return (list || []).filter((c) => c && c.active !== false && !c.deleted)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
}

/**
 * The code a clock-in, ticket or move takes without asking: the phase the office set on the job
 * (jobs.currentCostCodeId), else the callback code for warranty and callback jobs, else none.
 * Only an active code is returned.
 */
export function defaultCostCode(job, codes = []) {
  const active = activeCostCodes(codes);
  const has = (id) => id && active.some((c) => c.id === id);
  if (has(job?.currentCostCodeId)) return job.currentCostCodeId;
  if (job && ['warranty', 'callback'].includes(job.kind)) {
    const cb = active.find((c) => c.id === 'cc-callback') || active.find((c) => c.group === 'callback');
    if (cb) return cb.id;
  }
  return null;
}

/** The standard codes a list is missing (by id), ready to add. */
export function missingStandardCodes(list = []) {
  const have = new Set((list || []).map((c) => c.id));
  const codes = new Set(activeCostCodes(list).map((c) => String(c.code)));
  return STANDARD_COST_CODES.filter((c) => !have.has(c.id) && !codes.has(c.code)).map((c) => ({ ...c, active: true }));
}

/** A code's problem for the editor (and the server's duplicate check): a sentence or null. */
export function costCodeProblem(cc, list = []) {
  const code = String(cc?.code ?? '').trim();
  if (!code) return 'Enter a code.';
  if (code.length > 20) return 'Codes are 20 characters at most.';
  if (!String(cc?.name ?? '').trim()) return 'Enter a name.';
  if (cc.active !== false && activeCostCodes(list).some((c) => c.id !== cc.id && String(c.code).trim().toLowerCase() === code.toLowerCase())) {
    return `Another active cost code uses ${code}.`;
  }
  return null;
}
