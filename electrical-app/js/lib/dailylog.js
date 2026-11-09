// Jobsite daily log / diary: one entry per job per day. It records the weather, the crew on site,
// visitors, deliveries, any delays or issues, general notes and photos — the running site diary a
// contractor keeps for the record (and for disputes and claims). Pure logic, shared by the module
// and tests. Local-first: there is no scheduler, the office opens today's log and fills it in.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Weather presets for the day (free text is also allowed on the form). */
export const WEATHER = ['Clear', 'Cloudy', 'Rain', 'Snow', 'Windy', 'Fog', 'Extreme heat', 'Extreme cold'];

/** A new daily log for a job on a date. */
export function newDailyLog({ job = null, date = null, by = null } = {}) {
  return {
    id: newId('dl'),
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    date: date || null,
    weather: '',
    temperature: '',
    crewIds: [],
    visitors: '',
    deliveries: '',
    delays: '',
    notes: '',
    photos: [],
    createdBy: by || null,
  };
}

/** The one existing log for a job on a day, or null (the day form keeps it to one per job/day). */
export function findForDay(logs, jobId, date) {
  if (!jobId || !date) return null;
  return (logs || []).find((l) => l.jobId === jobId && l.date === date) || null;
}

/** Filter logs by job ('' = any, '__none' = not linked to a job). */
export function filterLogs(logs, { jobId = '' } = {}) {
  return (logs || []).filter((l) => {
    if (jobId && jobId !== '__none') return l.jobId === jobId;
    if (jobId === '__none') return !l.jobId;
    return true;
  });
}

/** Newest day first. */
export function sortLogs(logs) {
  return [...(logs || [])].sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** How many crew are marked present. */
export const crewCount = (l) => (Array.isArray(l?.crewIds) ? l.crewIds.length : 0);

/** Does the log carry anything worth noting (so an empty opened day can be flagged)? */
export function hasContent(l) {
  if (!l) return false;
  return Boolean(
    (l.weather || '').trim() || (l.temperature || '').trim() || crewCount(l) ||
    (l.visitors || '').trim() || (l.deliveries || '').trim() || (l.delays || '').trim() ||
    (l.notes || '').trim() || (Array.isArray(l.photos) && l.photos.length));
}

/** Counts for a list of logs: total days, days with crew, days with a delay noted. */
export function summarize(logs) {
  const out = { total: 0, withCrew: 0, withDelays: 0 };
  for (const l of logs || []) {
    out.total++;
    if (crewCount(l)) out.withCrew++;
    if ((l.delays || '').trim()) out.withDelays++;
  }
  return out;
}

export const logLabel = (l) => l?.date || 'Daily log';
