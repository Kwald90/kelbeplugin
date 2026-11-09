// Submittal log: the shop-drawing / product-data / sample items a contractor submits to the GC or
// engineer for review on a commercial job. A submittal has an auto number per job, a spec section and
// description, a type, a status through the review cycle, submitted and returned dates, the reviewer
// and a revision number. "Submitting" stamps the submitted date; a review outcome stamps the returned
// date; "revise & resubmit" bumps the revision. Pure logic, shared by the module and its tests (no DOM).

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Submittal item types. */
export const TYPES = [
  { id: 'product-data', label: 'Product data' },
  { id: 'shop-drawing', label: 'Shop drawing' },
  { id: 'sample', label: 'Sample' },
];
export const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[0];
export const typeLabel = (id) => typeOf(id).label;

/**
 * The statuses a submittal moves through. `terminal` marks the ones that close out the cycle; `closed`
 * marks an accepted/rejected final state (for counts). `review` is a reviewer's return outcome.
 */
export const STATUSES = [
  { id: 'draft', label: 'Draft' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'under-review', label: 'Under review' },
  { id: 'approved', label: 'Approved', review: true, terminal: true, closed: true },
  { id: 'approved-as-noted', label: 'Approved as noted', review: true, terminal: true, closed: true },
  { id: 'revise-resubmit', label: 'Revise & resubmit', review: true },
  { id: 'rejected', label: 'Rejected', review: true, terminal: true, closed: true },
];
export const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
export const statusLabel = (id) => statusOf(id).label;

/** The reviewer return outcomes (what a reviewer stamps a submittal with). */
export const REVIEW_OUTCOMES = STATUSES.filter((s) => s.review);

/** Is the submittal in a closed/final state (approved, approved-as-noted or rejected)? */
export const isClosed = (s) => !!statusOf(s?.status || 'draft').closed;
/** Is the submittal still a draft (not yet sent out)? */
export const isDraft = (s) => (s?.status || 'draft') === 'draft';
/** Is the submittal out for review (submitted or under review)? */
export const isOutstanding = (s) => { const id = s?.status || 'draft'; return id === 'submitted' || id === 'under-review'; };

/**
 * The next submittal number for a job: one more than the highest number already used on that job
 * (submittals are numbered per job). Items without a job are numbered as their own group.
 */
export function nextNumber(items, jobId) {
  const scope = (items || []).filter((s) => (s.jobId || null) === (jobId || null));
  return scope.reduce((m, s) => Math.max(m, Number(s.number) || 0), 0) + 1;
}

/** A new, draft submittal for a job, numbered against the submittals already on that job. */
export function newSubmittal({ job = null, items = [], by = null, type = 'shop-drawing' } = {}) {
  return {
    id: newId('sub'),
    number: nextNumber(items, job?.id || null),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    specSection: '',
    description: '',
    type: TYPES.some((t) => t.id === type) ? type : 'shop-drawing',
    status: 'draft',
    submittedDate: null,
    returnedDate: null,
    reviewer: '',
    revision: 0,
    notes: '',
    photos: [],
    createdBy: by || null,
  };
}

/** How submitting a draft changes it: mark it submitted and stamp the submitted date. */
export function submitPatch(sub, { at = null } = {}) {
  void sub;
  return { status: 'submitted', submittedDate: at || new Date().toISOString().slice(0, 10) };
}

/** How recording a reviewer's return changes it: set the outcome status and stamp the returned date. */
export function reviewPatch(sub, outcome, { at = null } = {}) {
  void sub;
  const status = REVIEW_OUTCOMES.some((o) => o.id === outcome) ? outcome : 'approved';
  return { status, returnedDate: at || new Date().toISOString().slice(0, 10) };
}

/**
 * How starting a fresh revision changes a returned submittal: bump the revision number, clear the
 * returned date and send it back to draft so it can be resubmitted.
 */
export function revisePatch(sub) {
  return { status: 'draft', revision: (Number(sub?.revision) || 0) + 1, submittedDate: null, returnedDate: null };
}

/** Filter a list by job and/or status ('' = any). */
export function filterSubmittals(items, { jobId = '', status = '' } = {}) {
  return (items || []).filter((s) => {
    if (jobId && jobId !== '__none' && s.jobId !== jobId) return false;
    if (jobId === '__none' && s.jobId) return false;
    if (status && (s.status || 'draft') !== status) return false;
    return true;
  });
}

/** Outstanding (out for review) first, then drafts, then closed; within a group, lowest number last. */
export function sortSubmittals(items) {
  const rank = (s) => (isOutstanding(s) ? 0 : isDraft(s) ? 1 : 2);
  return [...(items || [])].sort((a, b) =>
    (rank(a) - rank(b)) ||
    ((Number(b.number) || 0) - (Number(a.number) || 0)));
}

/** Counts for a list: total, drafts, outstanding (out for review), and closed. */
export function summarize(items) {
  const out = { total: 0, draft: 0, outstanding: 0, closed: 0 };
  for (const s of items || []) {
    out.total++;
    if (isClosed(s)) out.closed++;
    else if (isDraft(s)) out.draft++;
    else out.outstanding++;
  }
  return out;
}

/** "SUB-003" (padded) for a number, with the revision suffix if any ("SUB-003 R2"). */
export const submittalNo = (s) => {
  if (!(Number(s?.number) > 0)) return 'SUB';
  const rev = Number(s?.revision) > 0 ? ` R${s.revision}` : '';
  return `SUB-${String(s.number).padStart(3, '0')}${rev}`;
};

/** A short label: "SUB-003 · Panelboards". */
export const submittalLabel = (s) => {
  const d = String(s?.description || '').trim();
  return d ? `${submittalNo(s)} · ${d.length > 60 ? `${d.slice(0, 57)}…` : d}` : submittalNo(s);
};
