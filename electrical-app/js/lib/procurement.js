// Procurement / long-lead log: the gear with long lead times on a job — switchgear, transformers,
// panels, big breakers — that has to be ordered early or it holds up the whole job. One record per
// item: a job link, a description, the vendor, an optional PO link (by id), quantity, where it is in
// the buying pipeline (to-order … delivered), order/promised/need-by dates, the lead time in weeks,
// a delivered flag and notes. The log flags items "at risk" — promised after they are needed, or a
// date already blown. Pure logic, shared by the module (modules/procurement.js) and the tests.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** The buying pipeline, earliest first. `rank` orders it; `committed` is true once money is spent. */
export const PROC_STATUSES = [
  { id: 'to-order', label: 'To order', rank: 0, tone: 'neutral', committed: false },
  { id: 'quoted', label: 'Quoted', rank: 1, tone: 'info', committed: false },
  { id: 'ordered', label: 'Ordered', rank: 2, tone: 'info', committed: true },
  { id: 'released', label: 'Released', rank: 3, tone: 'accent', committed: true },
  { id: 'shipped', label: 'Shipped', rank: 4, tone: 'accent', committed: true },
  { id: 'delivered', label: 'Delivered', rank: 5, tone: 'success', committed: true },
];

export const statusOf = (id) => PROC_STATUSES.find((s) => s.id === id) || PROC_STATUSES[0];
export const statusLabel = (id) => statusOf(id).label;
export const statusTone = (id) => statusOf(id).tone;
export const statusRank = (id) => statusOf(id).rank;

/** A new to-order item for a job. */
export function newProcurementItem({ job = null, description = '', vendor = '', quantity = 1, by = null } = {}) {
  return {
    id: newId('pr'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    description: String(description || '').slice(0, 300),
    vendor: String(vendor || '').slice(0, 200),
    purchaseOrderId: null,
    quantity: Number.isFinite(Number(quantity)) ? Number(quantity) : 1,
    status: 'to-order',
    orderDate: null,
    promisedDate: null,
    needByDate: null,
    leadTimeWeeks: null,
    delivered: false,
    deliveredDate: null,
    notes: '',
    createdBy: by || null,
  };
}

/** Is it in hand? The delivered flag or the delivered status (either counts). */
export const isDelivered = (item) => item?.delivered === true || (item?.status || 'to-order') === 'delivered';

/** Still outstanding (not yet in hand). */
export const isOutstanding = (item) => !isDelivered(item);

/**
 * Why an item is at risk as of a day (YYYY-MM-DD), or null if it is fine. Delivered items are never
 * at risk. In order of seriousness:
 *   'promised-after-need' — the vendor's promised date is after the date it is needed on site
 *   'promised-overdue'    — the promised date has passed and it still is not here
 *   'need-by-passed'      — the need-by date has passed and it still is not here
 */
export function atRiskReason(item, asOf = null) {
  if (!item || isDelivered(item)) return null;
  const promised = item.promisedDate || null;
  const needBy = item.needByDate || null;
  if (promised && needBy && String(promised) > String(needBy)) return 'promised-after-need';
  if (asOf && promised && String(promised) < String(asOf)) return 'promised-overdue';
  if (asOf && needBy && String(needBy) < String(asOf)) return 'need-by-passed';
  return null;
}

/** A plain-language line for the risk reason, for the UI and the printed log. */
export function riskLabel(reason) {
  switch (reason) {
    case 'promised-after-need': return 'Promised after it is needed';
    case 'promised-overdue': return 'Promised date passed';
    case 'need-by-passed': return 'Need-by date passed';
    default: return '';
  }
}

/** Is the item at risk of being late as of a day? */
export const isAtRisk = (item, asOf = null) => atRiskReason(item, asOf) != null;

/** How marking an item delivered changes it: in hand, flagged, stamped and moved to delivered. */
export function markDeliveredPatch({ date = null } = {}) {
  return { delivered: true, status: 'delivered', deliveredDate: date || new Date().toISOString().slice(0, 10) };
}

/** Undo a delivery: back to shipped, clearing the flag and the date. */
export function reopenPatch() {
  return { delivered: false, status: 'shipped', deliveredDate: null };
}

/** Filter the log by job and/or status ('' = any; '__none' = not linked to a job). */
export function filterItems(items, { jobId = '', status = '' } = {}) {
  return (items || []).filter((it) => {
    if (jobId && jobId !== '__none' && it.jobId !== jobId) return false;
    if (jobId === '__none' && it.jobId) return false;
    if (status === 'outstanding' && isDelivered(it)) return false;
    if (status === 'delivered' && !isDelivered(it)) return false;
    if (status && status !== 'outstanding' && status !== 'delivered' && (it.status || 'to-order') !== status) return false;
    return true;
  });
}

/**
 * Sort for the log: outstanding before delivered, at-risk outstanding first, then by need-by date
 * (soonest first), then promised date, then description.
 */
export function sortItems(items, asOf = null) {
  return [...(items || [])].sort((a, b) =>
    (Number(isDelivered(a)) - Number(isDelivered(b))) ||
    (Number(isAtRisk(b, asOf)) - Number(isAtRisk(a, asOf))) ||
    String(a.needByDate || '9999').localeCompare(String(b.needByDate || '9999')) ||
    String(a.promisedDate || '9999').localeCompare(String(b.promisedDate || '9999')) ||
    String(a.description || '').localeCompare(String(b.description || '')));
}

/** Counts for the log: total, delivered, outstanding, at-risk, and a per-status breakdown. */
export function summarize(items, asOf = null) {
  const out = { total: 0, delivered: 0, outstanding: 0, atRisk: 0, byStatus: {} };
  for (const s of PROC_STATUSES) out.byStatus[s.id] = 0;
  for (const it of items || []) {
    out.total++;
    const s = it.status || 'to-order';
    if (Object.hasOwn(out.byStatus, s)) out.byStatus[s]++;
    if (isDelivered(it)) out.delivered++;
    else {
      out.outstanding++;
      if (isAtRisk(it, asOf)) out.atRisk++;
    }
  }
  return out;
}

/** "6 weeks" or '' for a lead time in weeks. */
export const leadTimeLabel = (weeks) => {
  const w = Number(weeks);
  if (!Number.isFinite(w) || w <= 0) return '';
  return `${Number.isInteger(w) ? w : Number(w.toFixed(1))} week${w === 1 ? '' : 's'}`;
};

export const procurementLabel = (it) => {
  const d = String(it?.description || '').trim();
  if (d) return d.length > 60 ? `${d.slice(0, 57)}…` : d;
  return it?.vendor ? `Item from ${it.vendor}` : 'Long-lead item';
};
