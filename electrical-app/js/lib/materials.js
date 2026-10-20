// Material requests: crew ask for material during the day ("need 50 two-hole clamps",
// "3/4 EMT x 20 sticks"), the requests collect, and once a day at a time the company sets they go
// to the office as one list grouped by job (the bell, an email, the Material requests page).
// Pure, no DOM: the PWA (modules/materials.js) and the server worker (services/materials.js)
// both use it, so the schedule and the list read the same everywhere.
//
// A request: { jobId, itemId?, description, qty, unit, note, urgent, employeeId (who asked),
//   status: requested → sent → ordered → fulfilled (or cancelled), sentAt, batchId, orderedAt,
//   fulfilledAt, stockMoveId?, costCents? (office only; never shown to crew) }.

export const STATUSES = ['requested', 'sent', 'ordered', 'fulfilled', 'cancelled'];
export const STATUS_LABEL = { requested: 'Waiting to send', sent: 'Sent to the office', ordered: 'Ordered', fulfilled: 'Fulfilled', cancelled: 'Cancelled' };
export const DEFAULT_SEND_AT = '15:00';
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Each province's time zone (its most populous zone; settings.materialRequests.timeZone
 * overrides it, e.g. for Lloydminster or northwest Ontario). Saskatchewan stays on CST all year.
 */
export const PROVINCE_TZ = {
  AB: 'America/Edmonton', BC: 'America/Vancouver', MB: 'America/Winnipeg', NB: 'America/Moncton', NL: 'America/St_Johns',
  NS: 'America/Halifax', NT: 'America/Yellowknife', NU: 'America/Iqaluit', ON: 'America/Toronto', PE: 'America/Halifax',
  QC: 'America/Toronto', SK: 'America/Regina', YT: 'America/Whitehorse',
};

export function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}

/** The company's send set-up: { sendAt 'HH:MM', timeZone, emailTo }. */
export function requestSettings(settings = {}) {
  const mr = settings?.materialRequests || {};
  const sendAt = HHMM.test(String(mr.sendAt || '')) ? mr.sendAt : DEFAULT_SEND_AT;
  const province = settings?.company?.province || 'ON';
  const timeZone = validTimeZone(mr.timeZone) ? mr.timeZone : PROVINCE_TZ[province] || 'America/Toronto';
  const emailTo = String(mr.emailTo || settings?.company?.email || '').trim();
  return { sendAt, timeZone, emailTo, province };
}

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of an instant in a zone: { day: 'YYYY-MM-DD', hh, mm, ss }. */
export function zonedParts(date, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(date)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hh = Number(p.hour) % 24;
  return { day: `${p.year}-${p.month}-${p.day}`, hh, mm: Number(p.minute), ss: Number(p.second) };
}

/** The local calendar day of an instant in a zone. */
export const localDayIn = (date, tz) => zonedParts(date, tz).day;

/** Offset of a zone at an instant, in ms (local wall time minus UTC). */
function offsetAt(t, tz) {
  const p = zonedParts(t, tz);
  const [y, m, d] = p.day.split('-').map(Number);
  return Date.UTC(y, m - 1, d, p.hh, p.mm, p.ss) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens on a local day in a zone. Across a DST change: a time in
 * the spring-forward gap (02:30 that never happens) moves forward to the first real instant after
 * it (03:30); a time that happens twice in the fall-back overlap takes the first.
 */
export function zonedToUtc(day, hhmm, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offs = [...new Set([offsetAt(wall, tz), offsetAt(wall - 86400000, tz), offsetAt(wall + 86400000, tz)])];
  const candidates = [...new Set(offs.map((o) => wall - o))].sort((a, b) => a - b);
  const want = `${day} ${hh}:${mm}`;
  const hit = candidates.find((c) => { const p = zonedParts(c, tz); return `${p.day} ${p.hh}:${p.mm}` === want; });
  if (hit != null) return new Date(hit);
  // In the gap: the earlier offset puts it just after the jump.
  return new Date(wall - Math.min(...offs));
}

/** 'YYYY-MM-DD' plus n days (calendar arithmetic, no time zone involved). */
export function addDay(day, n = 1) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The next scheduled send after `now`: { at: Date, day: local 'YYYY-MM-DD' }. */
export function nextSendAt(now, { sendAt = DEFAULT_SEND_AT, timeZone = 'America/Toronto' } = {}) {
  const t = new Date(now).getTime();
  let day = localDayIn(t, timeZone);
  let at = zonedToUtc(day, sendAt, timeZone);
  if (at.getTime() <= t) { day = addDay(day); at = zonedToUtc(day, sendAt, timeZone); }
  return { at, day };
}

/** "3:00 pm" from 'HH:MM'. */
export function fmtSendAt(hhmm) {
  const [h, m] = String(hhmm || DEFAULT_SEND_AT).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// ---- the list ---------------------------------------------------------------------------

const jobLabel = (job) => (job ? [job.number, job.title].filter(Boolean).join(' · ') : 'No job');

/** "50 ea" / "20 sticks" / "1" */
export function qtyText(r) {
  const q = Number(r.qty);
  const n = Number.isFinite(q) ? String(Math.round(q * 100) / 100) : String(r.qty ?? '');
  return r.unit ? `${n} ${r.unit}` : n;
}

/** What was asked for, without prices: the price-book name or the typed description. */
export const requestName = (r, items = new Map()) => (r.itemId && items.get(r.itemId)?.name) || r.description || 'Material';

/**
 * Requests grouped by job, jobs by number, requests urgent first then oldest first:
 * [{ jobId, job, label, address, requests }].
 */
export function groupByJob(requests, jobs = []) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const groups = new Map();
  for (const r of requests) {
    const k = r.jobId || '';
    if (!groups.has(k)) {
      const job = byId.get(r.jobId) || null;
      groups.set(k, { jobId: r.jobId || null, job, label: jobLabel(job), address: job?.address || '', requests: [] });
    }
    groups.get(k).requests.push(r);
  }
  const out = [...groups.values()];
  for (const g of out) g.requests.sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return out.sort((a, b) => (a.jobId ? 0 : 1) - (b.jobId ? 0 : 1) || String(a.job?.number || a.label).localeCompare(String(b.job?.number || b.label), undefined, { numeric: true }));
}

/**
 * The combined list as plain text (the office email and the bell's body). Never prices.
 * @param {{ company?: string, dayLabel?: string, groups: ReturnType<typeof groupByJob>, items?: Map, employees?: Map, link?: string }} o
 */
export function combinedText({ company = '', dayLabel = '', groups, items = new Map(), employees = new Map(), link = '' }) {
  const n = groups.reduce((s, g) => s + g.requests.length, 0);
  const urgent = groups.reduce((s, g) => s + g.requests.filter((r) => r.urgent).length, 0);
  const head = `Material requests${company ? ` for ${company}` : ''}${dayLabel ? `, ${dayLabel}` : ''}: ${n} item${n === 1 ? '' : 's'} for ${groups.length} job${groups.length === 1 ? '' : 's'}${urgent ? ` (${urgent} urgent)` : ''}.`;
  const blocks = groups.map((g) => [
    `${g.label}${g.address ? ` (${g.address})` : ''}`,
    ...g.requests.map((r) => {
      const who = employees.get(r.employeeId)?.name;
      const extra = [who, r.urgent ? 'URGENT' : null, r.note ? `"${String(r.note).slice(0, 200)}"` : null].filter(Boolean).join(' · ');
      return `  - ${qtyText(r)}  ${requestName(r, items)}${extra ? `  (${extra})` : ''}`;
    }),
  ].join('\n'));
  return [head, '', blocks.join('\n\n'), link ? `\nOpen the list: ${link}` : ''].join('\n').trim();
}

/**
 * Requests rolled into one purchase list: same item (or same typed description) and unit added
 * up across jobs. [{ key, itemId, description, unit, qty, jobs: [label], requestIds, costCents }]
 */
export function purchaseList(requests, { items = new Map(), jobs = [] } = {}) {
  const byJob = new Map(jobs.map((j) => [j.id, j]));
  const rows = new Map();
  for (const r of requests) {
    const name = requestName(r, items);
    const unit = r.unit || items.get(r.itemId)?.unit || '';
    const key = `${r.itemId || name.trim().toLowerCase()}|${unit}`;
    if (!rows.has(key)) rows.set(key, { key, itemId: r.itemId || null, description: name, unit, qty: 0, jobs: [], requestIds: [], costCents: items.get(r.itemId)?.costCents ?? r.costCents ?? null });
    const row = rows.get(key);
    row.qty = Math.round((row.qty + (Number(r.qty) || 0)) * 100) / 100;
    row.requestIds.push(r.id);
    const label = byJob.get(r.jobId)?.number || (r.jobId ? 'job' : 'no job');
    if (!row.jobs.includes(label)) row.jobs.push(label);
  }
  return [...rows.values()].sort((a, b) => a.description.localeCompare(b.description));
}

/**
 * The change to a request whose "From stock" move was undone: the stock went back, so the request
 * is open again at the step it had reached (it can be taken from stock again, or fulfilled).
 */
export function reopenAfterUndo(r) {
  return { status: r.orderedAt ? 'ordered' : r.sentAt ? 'sent' : 'requested', fulfilledAt: null, stockMoveId: null, fromLocationId: null };
}

/** Stock of an item by location, most first: [{ locationId, name, qty }] (only where there is some). */
export function stockByLocation(item, locations = []) {
  const name = new Map(locations.map((l) => [l.id, l.name]));
  return Object.entries(item?.stock || {}).map(([locationId, q]) => ({ locationId, name: name.get(locationId) || 'Unknown location', qty: Number(q) || 0 }))
    .filter((x) => x.qty > 0).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

/** "You have 12 in Van 2" (the best location), or null when there is none in stock. */
export function stockHint(item, locations = []) {
  const s = stockByLocation(item, locations);
  if (!s.length) return null;
  const more = s.length > 1 ? `, ${s.slice(1, 3).map((x) => `${x.qty} in ${x.name}`).join(', ')}` : '';
  return `You have ${s[0].qty} in ${s[0].name}${more}`;
}

/** Best guess at a price-book item for typed text ("3/4 EMT", "two-hole clamp 3/4"). */
export function matchItems(text, items, limit = 6) {
  const words = String(text || '').toLowerCase().split(/[\s,]+/).filter((w) => w.length > 0);
  if (!words.length) return [];
  return items.map((i) => {
    const hay = `${i.name} ${i.sku || ''} ${i.category || ''}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? (w.length > 2 ? 2 : 1) : 0), 0);
    return { item: i, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, limit).map((x) => x.item);
}

/** What a request can show to a reader without money permissions: no cost. */
export function withoutMoney(r) {
  if (!r || !('costCents' in r)) return r;
  const { costCents, ...rest } = r;
  return rest;
}
