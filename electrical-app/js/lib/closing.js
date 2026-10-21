// The period lock (docs/releases/r1-get-paid.md 2.6, docs/office/period-lock.md): which records a
// closed month makes read-only, which day a record falls in, and when a late arrival is posted.
// Pure and shared: the server's write guards (server/src/services/write-guards.js) refuse with the
// same answers the PWA uses to show a lock icon and disable editing.
//
// - Books lock (`booksThrough`): records whose lock day is on or before it are read-only; they are
//   changed by reversal (a credit note, a reversal payment, a supplier credit, an opposite move, a
//   time correction). Draft invoices are never locked.
// - Posting date (`postedOn`): a payment, bill, stock move, time entry, equipment use or count
//   dated in a closed period is still accepted; it posts on the first open day and is flagged late.
//   Nothing a phone sends late is thrown away.
// - Payroll lock: a time entry is locked when its id is in an exported payroll run, never by date.
//   `payrollThrough` only says "payroll exported through" (QuickBooks, the Late hours queue).

/** The document's own date per collection (time entries: the clock-in; corrections: workDay). */
export const DOC_DATE_FIELD = {
  invoices: 'issueDate', payments: 'date', bills: 'date', stockMoves: 'date',
  timeEntries: 'clockIn', equipmentUse: 'date', stockCounts: 'date',
};

/** Collections whose records get a server posting date. */
export const POSTED_COLLECTIONS = ['payments', 'bills', 'stockMoves', 'timeEntries', 'equipmentUse', 'stockCounts'];

/** Fields that may still change on a locked record ('a.b' is field b of object a). */
export const LOCK_SAFE_FIELDS = {
  invoices: ['status', 'payLink', 'sentAt', 'promptPayment', 'disputes',
    'holdback.retainedByCustomerCents', 'holdback.retainedRecordedAt', 'holdback.retainedRecordedBy', 'updatedAt'],
  payments: ['stripe', 'updatedAt'],
  bills: ['status', 'varianceAck', 'updatedAt'],
  // Hours in a closed month that no payroll run took are "late hours": they stay approvable (and an
  // off-site flag reviewable) so the next run can pay them; the hours themselves change by correction.
  timeEntries: ['approved', 'approvedAt', 'approvedBy', 'flag', 'updatedAt'],
};
/** Extra safe fields for one actor: the QuickBooks push writes DocNumber (number) on invoices. */
export const ACTOR_SAFE_FIELDS = { 'system:qbo': { invoices: ['number'] } };

/** Status moves a locked record may still make (a payment received today marks a September invoice paid). */
export const LOCKED_STATUS_MOVES = { invoices: ['sent', 'partial', 'paid'], bills: ['open', 'paid'] };

const ZONES = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto',
  QC: 'America/Toronto', NB: 'America/Moncton', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns',
  YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit',
};
/** The company's time zone from its province (the QuickBooks engine uses the same table). */
export const zoneFor = (province) => ZONES[String(province || '').toUpperCase()] || 'America/Toronto';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

/** The calendar day of a date or time in a zone: '2026-09-30' stays as it is; an ISO time is converted. */
export function dayIn(value, zone = 'America/Toronto') {
  if (value == null || value === '') return null;
  const s = String(value);
  if (DAY_RE.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return DAY_RE.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: zone || 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** YYYY-MM-DD plus n days. */
export function addDay(day, n = 1) {
  const [y, m, d] = String(day).split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** The last day of the month before `day` (the default "Close through"). */
export function endOfLastMonth(day) {
  const [y, m] = String(day).split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, 0));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** The document day of a record (no posting date): what the person typed or the clock said. */
export function documentDay(coll, record, { zone } = {}) {
  if (!record) return null;
  if (coll === 'timeEntries' && record.kind === 'correction') return dayIn(record.workDay, zone);
  const f = DOC_DATE_FIELD[coll];
  return f ? dayIn(record[f], zone) : null;
}

/** The day a record falls in for the lock: postedOn for posted collections (old records: the document day). */
export function lockDay(coll, record, { zone } = {}) {
  if (!record) return null;
  if (POSTED_COLLECTIONS.includes(coll) && typeof record.postedOn === 'string' && DAY_RE.test(record.postedOn)) return record.postedOn;
  return documentDay(coll, record, { zone });
}

/**
 * On create: the posting date and the late flag. postedOn = the document day, or the day after the
 * books lock when the document day is on or before it (then late: true). Never refuses.
 */
export function postingFor(coll, record, locks = {}, { zone, today } = {}) {
  const doc = documentDay(coll, record, { zone }) || today || dayIn(new Date().toISOString(), zone);
  const through = locks?.booksThrough || null;
  if (through && doc <= through) return { postedOn: addDay(through, 1), late: true };
  return { postedOn: doc, late: false };
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** Key-order-independent equality. */
export function same(a, b) {
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : isObj(v) ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
  return canon(a) === canon(b);
}

/** Fields that changed between two copies, apart from the safe ones ('a.b' safe fields compare the rest of a). */
export function changedFields(before, after, safe = []) {
  const top = new Set(safe.filter((k) => !k.includes('.')));
  const nested = {};
  for (const k of safe.filter((x) => x.includes('.'))) { const [a, b] = k.split('.'); (nested[a] ||= new Set()).add(b); }
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const k of keys) {
    if (k === 'id' || k === 'createdAt' || top.has(k)) continue;
    let a = before?.[k], b = after?.[k];
    if (nested[k] && (isObj(a) || isObj(b))) {
      const strip = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([x]) => !nested[k].has(x))) : o);
      a = strip(a); b = strip(b);
      if (isObj(a) && !Object.keys(a).length) a = undefined;
      if (isObj(b) && !Object.keys(b).length) b = undefined;
    }
    if (!same(a, b)) out.push(k);
  }
  return out;
}

const actorKey = (actor) => (actor ? `${actor.type}:${actor.id ?? ''}` : '');
const fmtThrough = (d) => d;

/** The refusal for a closed period. */
function locked(through) {
  return { code: 'period_locked', through, message: `This is in a closed period (through ${fmtThrough(through)}). Record a reversal dated today instead.` };
}

/** Is this record read-only under the books lock (before any change)? */
function booksLocked(locks, coll, record, { zone }) {
  const through = locks?.booksThrough;
  if (!through || !record) return false;
  if (coll === 'invoices') {
    if ((record.status || 'draft') === 'draft') return false;
    const day = lockDay(coll, record, { zone });
    return Boolean(day && day <= through);
  }
  if (!POSTED_COLLECTIONS.includes(coll)) return false;
  const day = lockDay(coll, record, { zone });
  return Boolean(day && day <= through);
}

/** The payroll run date of a locked entry ('' when unknown). */
const payrollDate = (locks, id) => (locks?.payrollEntryDates instanceof Map ? locks.payrollEntryDates.get(id) : null) || '';

/**
 * The lock's answer for one write: null (allowed) or { code, through, message }.
 * locks: { booksThrough, payrollThrough, payrollEntryIds: Set, payrollEntryDates?: Map, qboBookCloseDate }.
 * before: stored copy or null (create); after: the new copy or null (delete).
 * actor: { type, id } of the writer (system:qbo may write invoice numbers and import history).
 */
export function lockProblem(locks, coll, before, after, { zone, actor } = {}) {
  if (!locks) return null;
  // Payroll lock: by entry id only, every field, approval included.
  if (coll === 'timeEntries' && before?.id && locks.payrollEntryIds?.has?.(before.id)) {
    if (!after || changedFields(before, after, ['updatedAt']).length) {
      const on = payrollDate(locks, before.id);
      return { code: 'payroll_locked', through: locks.payrollThrough || null,
        message: `These hours were exported to payroll${on ? ` on ${on}` : ''}. Add a correction instead.` };
    }
  }
  const through = locks.booksThrough;
  if (!through) return null;
  const key = actorKey(actor);

  if (coll === 'invoices') {
    const wasDraft = !before || (before.status || 'draft') === 'draft';
    if (after && !booksLocked(locks, coll, before, { zone })) {
      // An open copy may not land in the closed period: leaving draft (or a device creating a sent
      // invoice) while dated in it, or re-dating a sent invoice into it.
      const status = after.status || 'draft';
      const day = dayIn(after.issueDate, zone);
      if (status !== 'draft' && status !== 'void' && day && day <= through) {
        // A QuickBooks import of history dated on or before QuickBooks' own close date is allowed.
        if (!before && key === 'system:qbo' && locks.qboBookCloseDate && day <= locks.qboBookCloseDate) return null;
        return { ...locked(through), message: wasDraft
          ? `This invoice is dated in a closed period (through ${through}). Re-date this invoice to today.`
          : `An invoice cannot be re-dated into a closed period (through ${through}). Keep its date, or issue a credit note and a new invoice.` };
      }
      return null;
    }
  }

  if (coll === 'jobs') {
    // Change orders approved on or before the lock are frozen; a new change order corrects them.
    const beforeCos = new Map((before?.changeOrders || []).filter((c) => c?.id).map((c) => [c.id, c]));
    const afterCos = new Map((after?.changeOrders || []).filter((c) => c?.id).map((c) => [c.id, c]));
    const coName = (co) => (co?.title ? `"${co.title}"` : 'This change order');
    for (const [id, co] of beforeCos) {
      const on = dayIn(co.approvedOn, zone);
      if (!on || on > through) continue;
      if (!afterCos.has(id) || !same(co, afterCos.get(id))) {
        return { ...locked(through), message: `${coName(co)} was approved in a closed period (through ${through}). Add a new change order with a negative amount instead.` };
      }
    }
    // Nor may a change order be approved (or back-dated) into the closed period: a new one, or one
    // whose approval day changes, must be approved after the lock.
    for (const [id, co] of afterCos) {
      const on = dayIn(co.approvedOn, zone);
      if (!on || on > through) continue;
      const prev = beforeCos.get(id);
      if (!prev || dayIn(prev.approvedOn, zone) !== on) {
        return { ...locked(through), message: `${coName(co)} cannot be approved on ${on}: that is in a closed period (through ${through}). Approve it today.` };
      }
    }
    return null;
  }

  if (!before || !booksLocked(locks, coll, before, { zone })) return null;
  if (!after) return locked(through);
  const safe = [...(LOCK_SAFE_FIELDS[coll] || ['updatedAt']), ...(ACTOR_SAFE_FIELDS[key]?.[coll] || [])];
  const changed = changedFields(before, after, safe);
  if (changed.length) return locked(through);
  const moves = LOCKED_STATUS_MOVES[coll];
  if (moves && (before.status || null) !== (after.status || null)) {
    if (!moves.includes(before.status) || !moves.includes(after.status)) return locked(through);
  }
  return null;
}

/** Read-only display in the PWA: the books lock or (time entries) an exported payroll run. */
export function isLocked(locks, coll, record, { zone } = {}) {
  if (!locks || !record) return false;
  if (coll === 'timeEntries' && locks.payrollEntryIds?.has?.(record.id)) return true;
  return booksLocked(locks, coll, record, { zone });
}

/** The locks as the PWA sees them: settings.closing (a server-written mirror) and the payroll runs. */
export function locksFrom(settings, payrollRuns = []) {
  const c = settings?.closing || {};
  const payrollEntryIds = new Set();
  const payrollEntryDates = new Map();
  for (const r of payrollRuns || []) {
    if (!r || r.status !== 'exported' || r.deleted) continue;
    const on = typeof r.exportedAt === 'string' ? r.exportedAt.slice(0, 10) : '';
    for (const id of [...(r.entryIds || []), ...(r.lateEntryIds || [])]) { payrollEntryIds.add(id); payrollEntryDates.set(id, on); }
  }
  return { booksThrough: c.booksThrough || null, payrollThrough: c.payrollThrough || null, payrollEntryIds, payrollEntryDates, qboBookCloseDate: null };
}

/** Late hours: worked on or before payrollThrough and in no exported run (the next run takes them). */
export function isLateHours(entry, locks, { zone } = {}) {
  if (!entry || !locks?.payrollThrough) return false;
  if (locks.payrollEntryIds?.has?.(entry.id)) return false;
  const day = documentDay('timeEntries', entry, { zone });
  return Boolean(day && day <= locks.payrollThrough);
}

/** What replaces an edit of a locked record (the button the PWA offers instead). */
export const REVERSAL_ACTION = {
  invoices: 'Issue credit note', payments: 'Record a reversal', bills: 'Supplier credit', stockMoves: 'Reverse',
  timeEntries: 'Add a correction', equipmentUse: 'Add a correction', stockCounts: 'Count again',
};
