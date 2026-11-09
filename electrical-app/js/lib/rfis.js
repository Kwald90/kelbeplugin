// RFI log: a Request for Information raised to the GC or engineer on a commercial job. An RFI has an
// auto number per job, a subject and the question, a discipline, who it is to, dates raised and
// needed-by, a status (open → answered → closed), the answer with its date, cost/schedule impact
// flags and attachments. "Answering" stamps the answer and its date; "closing" files it away.
// Pure logic, shared by the module and its tests (no DOM).

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** The statuses an RFI moves through, in order. */
export const STATUSES = [
  { id: 'open', label: 'Open' },
  { id: 'answered', label: 'Answered' },
  { id: 'closed', label: 'Closed' },
];

export const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
export const statusLabel = (id) => statusOf(id).label;

/** Common disciplines an RFI is about (a datalist on the form; any text is allowed). */
export const DISCIPLINES = ['Electrical', 'Mechanical', 'Architectural', 'Structural', 'Plumbing', 'Fire alarm', 'Civil', 'Controls', 'Low voltage', 'General'];

/**
 * The next RFI number for a job: one more than the highest number already used on that job (RFIs are
 * numbered per job, so each job starts at 1). Items without a job are numbered as their own group.
 */
export function nextNumber(items, jobId) {
  const scope = (items || []).filter((r) => (r.jobId || null) === (jobId || null));
  return scope.reduce((m, r) => Math.max(m, Number(r.number) || 0), 0) + 1;
}

/** A new, open RFI for a job, numbered against the RFIs already on that job. */
export function newRfi({ job = null, items = [], by = null, date = null, discipline = 'Electrical' } = {}) {
  return {
    id: newId('rfi'),
    number: nextNumber(items, job?.id || null),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    subject: '',
    discipline: String(discipline || '').slice(0, 80),
    question: '',
    status: 'open',
    dateRaised: date || null,
    neededBy: null,
    toName: '',
    answer: '',
    answeredDate: null,
    answeredBy: null,
    costImpact: false,
    scheduleImpact: false,
    notes: '',
    photos: [],
    createdBy: by || null,
  };
}

/** Is the RFI still awaiting an answer (open)? */
export const isOpen = (r) => (r?.status || 'open') === 'open';
/** Has the RFI been answered but not yet closed out? */
export const isAnswered = (r) => (r?.status || 'open') === 'answered';
export const isClosed = (r) => (r?.status || 'open') === 'closed';

/** Is an open/answered RFI past its needed-by date as of a day (YYYY-MM-DD)? Closed RFIs never are. */
export function isOverdue(r, asOf) {
  if (isClosed(r) || !r?.neededBy) return false;
  return isOpen(r) && String(r.neededBy) < String(asOf);
}

/** How answering an RFI changes it: mark it answered and stamp the date and author. */
export function answerPatch(rfi, { by = null, at = null } = {}) {
  void rfi;
  return { status: 'answered', answeredDate: at || new Date().toISOString().slice(0, 10), answeredBy: by || null };
}

/** How closing an RFI changes it: file it away. */
export function closePatch() {
  return { status: 'closed' };
}

/** How reopening an RFI changes it: back to open, clearing the answer stamp. */
export function reopenPatch() {
  return { status: 'open', answeredDate: null, answeredBy: null };
}

/** Filter a list by job and/or status ('open' | 'answered' | 'closed' | '' = any). */
export function filterRfis(items, { jobId = '', status = '' } = {}) {
  return (items || []).filter((r) => {
    if (jobId && jobId !== '__none' && r.jobId !== jobId) return false;
    if (jobId === '__none' && r.jobId) return false;
    if (status && (r.status || 'open') !== status) return false;
    return true;
  });
}

/** Open RFIs first, then answered, then closed; within a status, lowest number first (newest work at top). */
export function sortRfis(items) {
  const rank = (r) => STATUSES.findIndex((s) => s.id === (r.status || 'open'));
  return [...(items || [])].sort((a, b) =>
    (rank(a) - rank(b)) ||
    ((Number(b.number) || 0) - (Number(a.number) || 0)));
}

/** Counts for a list: total and a count per status, plus overdue open items. */
export function summarize(items, asOf = null) {
  const out = { total: 0, open: 0, answered: 0, closed: 0, overdue: 0 };
  for (const r of items || []) {
    out.total++;
    const s = r.status || 'open';
    if (s === 'answered') out.answered++;
    else if (s === 'closed') out.closed++;
    else out.open++;
    if (asOf && isOverdue(r, asOf)) out.overdue++;
  }
  return out;
}

/** "RFI-003" (padded) for a number, or "RFI" when unnumbered. */
export const rfiNo = (r) => (Number(r?.number) > 0 ? `RFI-${String(r.number).padStart(3, '0')}` : 'RFI');

/** A short label: "RFI-003 · Panel location". */
export const rfiLabel = (r) => {
  const subject = String(r?.subject || '').trim();
  return subject ? `${rfiNo(r)} · ${subject.length > 60 ? `${subject.slice(0, 57)}…` : subject}` : rfiNo(r);
};
