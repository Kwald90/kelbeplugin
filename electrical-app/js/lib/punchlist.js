// Punch list / deficiencies: the snag list an electrician works through at the end of a job. A
// punch item is a deficiency on a job — an area/location, a description, the trade responsible, a
// severity and a status (open or closed) — optionally assigned to an employee and due by a date,
// with before/after photos. "Resolving" an item closes it and stamps who closed it and when. The
// printable punch report groups the open items by area. Pure logic, shared by the module and tests.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Severities, worst first for sorting. `rank` orders them (higher = more urgent). */
export const SEVERITIES = [
  { id: 'high', label: 'High', rank: 3 },
  { id: 'medium', label: 'Medium', rank: 2 },
  { id: 'low', label: 'Low', rank: 1 },
];

export const STATUSES = ['open', 'closed'];

/** Common trades a deficiency belongs to (a datalist on the form; any text is allowed). */
export const TRADES = ['Electrical', 'Mechanical', 'HVAC', 'Plumbing', 'Fire alarm', 'Controls', 'Low voltage', 'General', 'Other'];

export const severityOf = (id) => SEVERITIES.find((s) => s.id === id) || SEVERITIES.at(-1);
export const severityRank = (id) => severityOf(id).rank;
export const severityLabel = (id) => severityOf(id).label;

const NO_AREA = 'No area';

/** A new, open punch item for a job. */
export function newPunchItem({ job = null, by = null, date = null, area = '', severity = 'medium' } = {}) {
  return {
    id: newId('pi'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    area: String(area || '').slice(0, 200),
    description: '',
    trade: '',
    severity: SEVERITIES.some((s) => s.id === severity) ? severity : 'medium',
    status: 'open',
    assigneeId: null,
    dueDate: null,
    photos: [],
    notes: '',
    resolvedAt: null,
    resolvedBy: null,
    openedAt: date || null,
    createdBy: by || null,
  };
}

/** Is the item still open? (anything that is not explicitly 'closed' counts as open). */
export const isOpen = (it) => (it?.status || 'open') !== 'closed';

/** Is an open item past its due date as of a day (YYYY-MM-DD)? Closed items are never overdue. */
export function isOverdue(it, asOf) {
  if (!isOpen(it) || !it?.dueDate) return false;
  return String(it.dueDate) < String(asOf);
}

/** How resolving an item changes it: close it and stamp who and when. */
export function resolvePatch(item, { by = null, at = null } = {}) {
  void item;
  return { status: 'closed', resolvedAt: at || new Date().toISOString(), resolvedBy: by || null };
}

/** How reopening a closed item changes it: back to open, clearing the resolution stamp. */
export function reopenPatch() {
  return { status: 'open', resolvedAt: null, resolvedBy: null };
}

/** Filter a list by job and/or status ('open' | 'closed' | '' = any). */
export function filterItems(items, { jobId = '', status = '' } = {}) {
  return (items || []).filter((it) => {
    if (jobId && jobId !== '__none' && it.jobId !== jobId) return false;
    if (jobId === '__none' && it.jobId) return false;
    if (status === 'open' && !isOpen(it)) return false;
    if (status === 'closed' && isOpen(it)) return false;
    return true;
  });
}

/** Open items first, then by severity (worst first), then by due date (soonest first), then area. */
export function sortItems(items) {
  return [...(items || [])].sort((a, b) =>
    (Number(isOpen(b)) - Number(isOpen(a))) ||
    (severityRank(b.severity) - severityRank(a.severity)) ||
    String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) ||
    String(a.area || '').localeCompare(String(b.area || '')));
}

/** Group items by area for the printable report: [{ area, items }], areas A→Z, blank area last. */
export function groupByArea(items) {
  const byArea = new Map();
  for (const it of items || []) {
    const key = (it.area || '').trim() || NO_AREA;
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(it);
  }
  return [...byArea.entries()]
    .sort((a, b) => (a[0] === NO_AREA ? 1 : b[0] === NO_AREA ? -1 : a[0].localeCompare(b[0])))
    .map(([area, list]) => ({ area, items: sortItems(list) }));
}

/** Counts for a list: total, open, closed, and open items by severity. */
export function summarize(items, asOf = null) {
  const out = { total: 0, open: 0, closed: 0, high: 0, medium: 0, low: 0, overdue: 0 };
  for (const it of items || []) {
    out.total++;
    if (isOpen(it)) {
      out.open++;
      out[it.severity] = (out[it.severity] ?? 0) + (SEVERITIES.some((s) => s.id === it.severity) ? 1 : 0);
      if (asOf && isOverdue(it, asOf)) out.overdue++;
    } else {
      out.closed++;
    }
  }
  return out;
}

export const punchLabel = (it) => {
  const d = String(it?.description || '').trim();
  if (d) return d.length > 60 ? `${d.slice(0, 57)}…` : d;
  return it?.area ? `Deficiency · ${it.area}` : 'Deficiency';
};
