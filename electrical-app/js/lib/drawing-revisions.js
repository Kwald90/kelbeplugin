// Drawing revision control: a REGISTER of the construction drawings on a job and which revision is
// current. One record per drawing — its number, title, discipline, the revision in force and a
// history of every revision received (rev, date, description, who it came from, whether it is now
// superseded) — plus a status (current / superseded / void). This is a transmittal register, not
// the heavy drawings/canvas collection: it tracks paper, not markup. Pure logic, shared by the
// module (modules/drawingrevisions.js) and the tests.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Statuses for a drawing in the register. `rank` orders them (lower = more live). */
export const DR_STATUSES = [
  { id: 'current', label: 'Current', rank: 0, tone: 'success' },
  { id: 'superseded', label: 'Superseded', rank: 1, tone: 'warning' },
  { id: 'void', label: 'Void', rank: 2, tone: 'neutral' },
];

export const statusOf = (id) => DR_STATUSES.find((s) => s.id === id) || DR_STATUSES[0];
export const statusLabel = (id) => statusOf(id).label;
export const statusTone = (id) => statusOf(id).tone;
export const statusRank = (id) => statusOf(id).rank;

/** Disciplines a drawing belongs to (a datalist on the form; any code/text is allowed). */
export const DISCIPLINES = [
  { id: 'E', label: 'Electrical' },
  { id: 'A', label: 'Architectural' },
  { id: 'S', label: 'Structural' },
  { id: 'M', label: 'Mechanical' },
  { id: 'P', label: 'Plumbing' },
  { id: 'FA', label: 'Fire alarm' },
  { id: 'T', label: 'Telecom / low voltage' },
  { id: 'I', label: 'Instrumentation' },
  { id: 'C', label: 'Civil' },
  { id: 'O', label: 'Other' },
];

export const disciplineOf = (id) => DISCIPLINES.find((d) => d.id === id) || null;
export const disciplineLabel = (id) => (id ? disciplineOf(id)?.label || id : '');

export const MAX_REVISIONS = 100;

/** One revision received for a drawing. `superseded` is true once a later revision arrives. */
export function newRevEntry({ rev = '', date = null, description = '', receivedFrom = '', superseded = false } = {}) {
  return {
    id: newId('rev'),
    rev: String(rev || '').slice(0, 40),
    date: date || null,
    description: String(description || '').slice(0, 1000),
    receivedFrom: String(receivedFrom || '').slice(0, 200),
    superseded: Boolean(superseded),
  };
}

/**
 * A new drawing in the register for a job. If a first revision is given it seeds the history and
 * becomes the current rev.
 */
export function newDrawing({ job = null, number = '', title = '', discipline = 'E', rev = '', date = null, receivedFrom = '', by = null } = {}) {
  const first = String(rev || '').trim() ? [newRevEntry({ rev, date, receivedFrom })] : [];
  return {
    id: newId('dr'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    number: String(number || '').slice(0, 80),
    title: String(title || '').slice(0, 200),
    discipline: discipline || '',
    currentRev: first.length ? first[0].rev : (String(rev || '').trim() || ''),
    status: 'current',
    revHistory: first,
    notes: '',
    createdBy: by || null,
  };
}

/**
 * How adding a revision changes a drawing: every prior history entry becomes superseded, the new
 * one is live, it becomes the current rev and the drawing is current again. Returns a patch.
 */
export function addRevision(record, { rev = '', date = null, description = '', receivedFrom = '' } = {}) {
  const history = [...(record?.revHistory || [])].map((e) => ({ ...e, superseded: true }));
  const entry = newRevEntry({ rev, date, description, receivedFrom, superseded: false });
  history.push(entry);
  return { revHistory: history.slice(-MAX_REVISIONS), currentRev: entry.rev, status: 'current' };
}

/** Mark the drawing superseded (a newer set replaced it elsewhere, or it was reissued). */
export const markSupersededPatch = () => ({ status: 'superseded' });
/** Void a drawing (withdrawn, never to be built from). */
export const markVoidPatch = () => ({ status: 'void' });
/** Bring a drawing back to current. */
export const reinstatePatch = () => ({ status: 'current' });

/** Is this drawing the current, build-from set? */
export const isCurrent = (d) => (d?.status || 'current') === 'current';

/** The revision in force: the stored currentRev, else the newest non-superseded history entry. */
export function latestRev(record) {
  if (record?.currentRev) return record.currentRev;
  const live = (record?.revHistory || []).filter((e) => !e.superseded);
  if (live.length) return live.at(-1).rev;
  const h = record?.revHistory || [];
  return h.length ? h.at(-1).rev : '';
}

/** Revision history newest first: by date (latest first), then by the order it was added. */
export function sortRevHistory(history) {
  const list = [...(history || [])];
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => String(b.e.date || '').localeCompare(String(a.e.date || '')) || (b.i - a.i))
    .map((x) => x.e);
}

/** Filter the register by job, status and/or discipline. '' / '__none' handled like the other modules. */
export function filterDrawings(records, { jobId = '', status = '', discipline = '' } = {}) {
  return (records || []).filter((d) => {
    if (jobId && jobId !== '__none' && d.jobId !== jobId) return false;
    if (jobId === '__none' && d.jobId) return false;
    if (status && (d.status || 'current') !== status) return false;
    if (discipline && (d.discipline || '') !== discipline) return false;
    return true;
  });
}

/** The current set: the drawings a crew should build from (status 'current'), sorted. */
export function currentSet(records) {
  return sortDrawings((records || []).filter(isCurrent));
}

/** Sort for the register: by discipline, then drawing number (natural-ish), then title. */
export function sortDrawings(records) {
  return [...(records || [])].sort((a, b) =>
    String(a.discipline || '~').localeCompare(String(b.discipline || '~')) ||
    String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true }) ||
    String(a.title || '').localeCompare(String(b.title || '')));
}

/** Group the drawings by discipline for the printable register: [{ discipline, label, items }]. */
export function groupByDiscipline(records) {
  const by = new Map();
  for (const d of sortDrawings(records)) {
    const key = d.discipline || 'O';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(d);
  }
  return [...by.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([discipline, items]) => ({ discipline, label: disciplineLabel(discipline) || 'Other', items }));
}

/** Counts for the register: total, current, superseded, void. */
export function summarize(records) {
  const out = { total: 0, current: 0, superseded: 0, void: 0 };
  for (const d of records || []) {
    out.total++;
    const s = d.status || 'current';
    if (Object.hasOwn(out, s)) out[s]++;
  }
  return out;
}

export const drawingLabel = (d) => {
  const num = String(d?.number || '').trim();
  const title = String(d?.title || '').trim();
  if (num && title) return `${num} — ${title}`;
  return num || title || 'Drawing';
};
