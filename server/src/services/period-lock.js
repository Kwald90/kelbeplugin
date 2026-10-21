// The period lock (docs/releases/r1-get-paid.md 2.6, docs/office/period-lock.md): the company's
// books closing date and its payroll exported-through date, kept as append-only history in
// period_locks (the current lock of a kind is its newest row) and mirrored into settings.closing so
// the PWA can show locked records offline. Payroll locks entries by id through the payrollRuns
// collection, never by date.
//
// loadLocks is cached per transaction; setLock takes the exclusive closing advisory lock, so a lock
// move and a write (which takes the shared form in write-guards.js) never interleave.
import { appendAudit } from './audit.js';
import { notify } from './notify.js';
import { addDay, dayIn, zoneFor } from '../../../electrical-app/js/lib/closing.js';
import { ApiError } from '../errors.js';
import { systemPrincipal, systemWho } from '../integrations/state.js';

const cache = new WeakMap();
const KINDS = ['books', 'payroll'];
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

/** The advisory lock key shared with write-guards.js. */
const lockKey = (tenantId) => `${tenantId}:closing`;

/** Forget the cached locks of a transaction (after a lock move in it). */
export function dropLocksCache(tx) { cache.delete(tx); }

/**
 * The locks in force, plus the company's zone and today in it. Cached per transaction.
 * @returns {Promise<{ booksThrough: string|null, payrollThrough: string|null, payrollEntryIds: Set<string>, payrollEntryDates: Map<string,string>, qboBookCloseDate: string|null, zone: string, today: string }>}
 */
export async function loadLocks(tx) {
  if (cache.has(tx)) return cache.get(tx);
  const t = tx.tenantId;
  // One connection: the queries run one after the other.
  const { rows: locks } = await tx.query('SELECT DISTINCT ON (kind) kind, through FROM period_locks WHERE tenant_id = $1 ORDER BY kind, id DESC', [t]);
  const { rows: runs } = await tx.query(
    `SELECT data->'entryIds' AS ids, data->'lateEntryIds' AS late, data->>'exportedAt' AS at FROM payroll_runs
      WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'exported'`, [t]);
  const { rows: qbo } = await tx.query("SELECT features->>'bookCloseDate' AS close FROM qbo_connections WHERE tenant_id = $1", [t]);
  const { rows: s } = await tx.query("SELECT data->'company'->>'province' AS province FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [t]);
  const by = Object.fromEntries(locks.map((r) => [r.kind, iso(r.through)]));
  const payrollEntryIds = new Set();
  const payrollEntryDates = new Map();
  for (const r of runs) {
    for (const id of [...(Array.isArray(r.ids) ? r.ids : []), ...(Array.isArray(r.late) ? r.late : [])]) {
      payrollEntryIds.add(String(id));
      payrollEntryDates.set(String(id), r.at ? String(r.at).slice(0, 10) : '');
    }
  }
  const zone = zoneFor(s[0]?.province);
  const out = {
    booksThrough: by.books || null, payrollThrough: by.payroll || null, payrollEntryIds, payrollEntryDates,
    qboBookCloseDate: qbo[0]?.close && /^\d{4}-\d{2}-\d{2}/.test(qbo[0].close) ? qbo[0].close.slice(0, 10) : null,
    zone, today: dayIn(new Date().toISOString(), zone),
  };
  cache.set(tx, out);
  return out;
}

/** The newest rows of each kind (who and when), for GET /api/v1/closing. */
export async function lockHistory(tx, limit = 50) {
  const { rows } = await tx.query(
    `SELECT id, kind, through, previous, reason, preflight, actor, created_at FROM period_locks WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`, [tx.tenantId, limit]);
  return rows.map((r) => ({ id: String(r.id), kind: r.kind, through: iso(r.through), previous: iso(r.previous), reason: r.reason, preflight: r.preflight, actor: r.actor, at: r.created_at.toISOString() }));
}

const actorString = (a) => `${a?.type || 'system'}:${a?.id ?? ''}${a?.label ? ` ${a.label}` : ''}`.slice(0, 200);

/**
 * Move a lock. kind 'books' or 'payroll'; through YYYY-MM-DD or null (clear). Moving a lock
 * earlier, or clearing it, needs a reason of at least 10 characters. A books date must be before
 * today in the company's zone. Appends a period_locks row, mirrors settings.closing (as
 * system:closing through the records service when given), audits and notifies owners and admins.
 * @returns {Promise<{ through: string|null, previous: string|null }>}
 */
export async function setLock(tx, { kind, through, reason = null, preflight = null, actor, request = null, records = null, notifyKind = 'period_lock' }) {
  if (!KINDS.includes(kind)) throw new ApiError(400, 'bad_request', 'Unknown lock.');
  if (through != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(through))) throw new ApiError(400, 'validation_failed', 'The date must be YYYY-MM-DD.');
  // Same order as write-guards.js: the tenant's write lock, then the closing lock (exclusive here).
  await tx.query('SELECT pg_advisory_xact_lock(tenant_lock_key($1))', [tx.tenantId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(tx.tenantId)]);
  dropLocksCache(tx);
  const cur = await loadLocks(tx);
  const previous = kind === 'books' ? cur.booksThrough : cur.payrollThrough;
  // The books close a past day; payroll's date only says what was exported (a run may end later this week).
  if (kind === 'books' && through && through >= cur.today) throw new ApiError(422, 'lock_in_future', `A closing date must be before today (${cur.today}).`);
  const earlier = through == null ? previous != null : previous != null && through < previous;
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (earlier && why.length < 10) throw new ApiError(422, 'reason_required', 'Moving a closing date back, or clearing it, needs a reason (at least 10 characters).');
  await tx.query(
    'INSERT INTO period_locks (tenant_id, kind, through, previous, reason, preflight, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [tx.tenantId, kind, through, previous, why ? why.slice(0, 500) : null, preflight ? JSON.stringify(preflight) : null, actorString(actor)]);
  dropLocksCache(tx);
  await mirrorSettings(tx, { [kind === 'books' ? 'booksThrough' : 'payrollThrough']: through, lockedAt: new Date().toISOString(), lockedBy: String(actor?.label || actor?.id || 'system').slice(0, 200) }, records);
  await appendAudit(tx, tx.tenantId, {
    actor: actor || { type: 'system', id: 'closing' }, action: `closing.${kind}`, collection: 'settings', recordId: 'settings',
    summary: `${kind === 'books' ? 'Books' : 'Payroll'} closed through ${through || 'nothing'} (was ${previous || 'nothing'})`, meta: { through, previous, reason: why || null }, request,
  });
  if (kind === 'books') {
    await notify(tx, {
      role: ['owner', 'admin'], kind: notifyKind, title: through ? `Books closed through ${through}` : 'The books closing date was cleared',
      body: earlier ? `Moved back from ${previous || 'nothing'}. Payroll and filed returns may no longer match.` : 'Records on or before that day are read-only; change them by reversal.',
      link: '#/books', ref: `lock:books:${through || 'none'}:${Date.now()}`,
    });
  }
  return { through, previous };
}

/** Write settings.closing as system:closing (records service when available, else directly). */
async function mirrorSettings(tx, patch, records) {
  const { rows } = await tx.query("SELECT data->'closing' AS closing FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  const closing = { ...(rows[0]?.closing && typeof rows[0].closing === 'object' ? rows[0].closing : {}), ...patch };
  if (records) {
    const p = systemPrincipal(tx.tenantId, 'closing', 'Period lock');
    const who = systemWho(p);
    if (rows[0]) await records.patchRecord(tx, p, 'settings', 'settings', { closing }, null, who);
    else await records.createRecord(tx, p, 'settings', { id: 'settings', closing }, who);
    return;
  }
  if (rows[0]) {
    await tx.query("UPDATE settings SET data = jsonb_set(data, '{closing}', $2::jsonb), updated_by = 'system:closing' WHERE tenant_id = $1 AND id = 'settings'", [tx.tenantId, JSON.stringify(closing)]);
  } else {
    await tx.query("INSERT INTO settings (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'settings', $2, 'system:closing', 'system:closing')", [tx.tenantId, { id: 'settings', closing }]);
  }
}

const LIST = 10;
/**
 * The pre-close checklist for a books lock through `through` (counts and short lists of ids,
 * numbers and names; no money): open or unapproved time, devices not seen since, draft invoices and
 * draft bills in the period, counted stock counts not posted, signed or refused tickets not priced or
 * billed, open disputes.
 */
export async function preflight(tx, { through, zone }) {
  const t = tx.tenantId;
  const z = zone || (await loadLocks(tx)).zone;
  const after = addDay(through, 2); // generous bound for times stored in UTC; the day check is in the zone
  const counts = {};
  const lists = {};
  const put = (key, items) => { counts[key] = items.length; lists[key] = items.slice(0, LIST); };

  const { rows: te } = await tx.query(
    `SELECT id, data->>'employeeId' AS emp, data->>'clockIn' AS clock_in, data->>'workDay' AS work_day, data->>'clockOut' AS clock_out, data->>'approved' AS approved, data->>'kind' AS kind
       FROM time_entries WHERE tenant_id = $1 AND deleted_at IS NULL AND (coalesce(data->>'clockIn', data->>'workDay') < $2)
        AND (data->>'clockOut' IS NULL AND coalesce(data->>'kind', '') <> 'correction' OR coalesce(data->>'approved', 'false') <> 'true')`, [t, after]);
  const people = await names(tx, 'employees', te.map((r) => r.emp));
  put('timeOpen', te.filter((r) => dayIn(r.kind === 'correction' ? r.work_day : r.clock_in, z) <= through)
    .map((r) => ({ id: r.id, label: `${people.get(r.emp) || 'Someone'} ${dayIn(r.kind === 'correction' ? r.work_day : r.clock_in, z)}`, state: r.clock_out || r.kind === 'correction' ? 'unapproved' : 'open' })));

  const { rows: dev } = await tx.query(
    'SELECT id, name, last_seen_at FROM devices WHERE tenant_id = $1 AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ($2::date + 1)) ORDER BY name', [t, through]);
  put('devicesBehind', dev.map((r) => ({ id: r.id, label: r.name, lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null })));

  const { rows: inv } = await tx.query(
    "SELECT id, number, data->>'issueDate' AS d FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL AND coalesce(status, 'draft') = 'draft' AND data->>'issueDate' <= $2 ORDER BY data->>'issueDate'", [t, through]);
  put('draftInvoices', inv.map((r) => ({ id: r.id, label: `${r.number || 'Draft'} ${r.d || ''}`.trim() })));

  const { rows: bills } = await tx.query(
    "SELECT id, data->>'number' AS number, day FROM bills WHERE tenant_id = $1 AND deleted_at IS NULL AND coalesce(status, 'draft') = 'draft' AND day <= $2 ORDER BY day", [t, through]);
  put('draftBills', bills.map((r) => ({ id: r.id, label: `${r.number || 'Bill'} ${r.day || ''}`.trim() })));

  const { rows: counts1 } = await tx.query(
    "SELECT id, location_id, day FROM stock_counts WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'counted' AND day <= $2", [t, through]);
  const locs = await names(tx, 'locations', counts1.map((r) => r.location_id));
  put('countsNotPosted', counts1.map((r) => ({ id: r.id, label: `${locs.get(r.location_id) || 'A location'} ${r.day || ''}`.trim() })));

  const { rows: tk } = await tx.query(
    "SELECT id, number, status, day FROM field_tickets WHERE tenant_id = $1 AND deleted_at IS NULL AND status IN ('signed', 'refused') AND day <= $2 ORDER BY day", [t, through]);
  put('ticketsUnpriced', tk.map((r) => ({ id: r.id, label: `${r.number || 'Ticket'} ${r.day || ''}`.trim(), state: r.status })));

  const { rows: disp } = await tx.query(
    `SELECT id, number FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL AND jsonb_typeof(data->'disputes') = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'disputes') d WHERE coalesce(d->>'status', 'open') = 'open')`, [t]);
  put('openDisputes', disp.map((r) => ({ id: r.id, label: r.number || 'Invoice' })));

  return { through, counts, lists, open: Object.values(counts).reduce((a, b) => a + b, 0) };
}

async function names(tx, table, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { rows } = await tx.query(`SELECT id, coalesce(data->>'name', data->>'title', id) AS name FROM ${table} WHERE tenant_id = $1 AND id = ANY($2)`, [tx.tenantId, list]);
  return new Map(rows.map((r) => [r.id, r.name]));
}
