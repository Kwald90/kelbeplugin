// Release 1 write guards (docs/releases/r1-get-paid.md 2.6, 2.8, 2.10): every rule that needs the
// database, run by services/records.js on every write path (REST create, patch, delete and restore,
// and each branch of a sync mutation), for every actor including the QuickBooks pull. The pure rules
// live in auth/access.js checkWriteRules; this file adds:
//
//   posting date      payments, bills, stock moves, time, equipment use, counts: postedOn and late on create
//   period lock       edits and deletes of records in a closed period (409 period_locked)
//   payroll lock      any change to a time entry in an exported payroll run (409 payroll_locked)
//   signatures        a new signature is checked (digest, snapshot shape) and stored valid or unverified;
//                     a document referencing one must point at a live signature of this document
//                     (422 signature_invalid); a signed document's signed keys are frozen
//   ticket numbers    T-1001 onward from doc_counters, so two offline phones never collide
//   move cost         stock moves stamped with the item's average (or catalogue) cost on create
//   change orders     a signed change order is never removed; signed keys frozen
//   uniqueness        active cost codes (409 duplicate_code), company rules (409 duplicate_rule)
//   van counts        a van's owner may count their own van (draft and counted only)
//
// Only the closing route's own writes (system:closing) skip the lock check. A write and a lock move
// never interleave: writes take the shared form of the closing advisory lock, setLock the exclusive.
import { createHash } from 'node:crypto';
import { ApiError, validationFailed } from '../errors.js';
import { appendAudit } from './audit.js';
import { notify } from './notify.js';
import { loadLocks } from './period-lock.js';
import { POSTED_COLLECTIONS, lockProblem, postingFor, dayIn } from '../../../electrical-app/js/lib/closing.js';
import { SIGNED_KEYS, SNAPSHOT_BUILDERS, signedContent, snapshotOf, signatureCovers, sameSnapshot } from '../../../electrical-app/js/lib/signing.js';
import { ruleIdentity } from '../../../electrical-app/js/lib/rules.js';

/** Collections the period lock looks at. */
const LOCK_COLLECTIONS = new Set(['invoices', 'jobs', ...POSTED_COLLECTIONS]);
const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
const same = (a, b) => canon(a) === canon(b);
const actorOf = (p, who) => who?.actor || p?.actor || { type: 'system', id: null };
const actorKey = (a) => `${a?.type}:${a?.id ?? ''}`;

/** The advisory lock key every write shares with a lock move (2.6 Concurrency). */
export const closingLockKey = (tenantId) => `${tenantId}:closing`;

/**
 * Every R1 guard for one write, after checkRules and before the row is written. Throws ApiError,
 * or returns the data to store with server-stamped fields (postedOn, late, number, unitCostCents,
 * signature status). before: stored data or null (create); after: data to store or null (delete).
 * opts.id: the record id (for creates where `after` has none yet).
 */
export async function runWriteGuards(tx, p, coll, before, after, who, opts = {}) {
  const actor = actorOf(p, who);
  const key = actorKey(actor);
  let out = after;
  const id = opts.id ?? after?.id ?? before?.id ?? null;

  if (LOCK_COLLECTIONS.has(coll)) {
    // Lock order everywhere: the tenant's write lock (the row stamp trigger takes it anyway), then the
    // closing lock. Taking them in this order on every path means a lock move and a write never deadlock.
    await tx.query('SELECT pg_advisory_xact_lock(tenant_lock_key($1))', [tx.tenantId]);
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [closingLockKey(tx.tenantId)]);
    const locks = await loadLocks(tx);
    if (key !== 'system:closing') {
      const problem = lockProblem(locks, coll, before ? { ...before, id: before.id ?? id } : null, out ? { ...out, id: out.id ?? id } : null, { zone: locks.zone, actor });
      if (problem) throw new ApiError(409, problem.code, problem.message, { through: problem.through });
    }
    // A restored record (undo of a soft delete) keeps the posting date it had.
    if (!before && out && POSTED_COLLECTIONS.includes(coll) && !out.postedOn) {
      const posting = postingFor(coll, out, locks, { zone: locks.zone, today: locks.today });
      out = { ...out, postedOn: posting.postedOn, late: posting.late };
      if (posting.late) await lateNotice(tx, locks.today);
    }
  }

  switch (coll) {
    case 'fieldTickets':
      if (out) {
        if (!out.number && !before?.number) out = { ...out, number: await nextTicketNumber(tx) };
        await signatureReference(tx, 'fieldTickets', before, out, id, { snapshot: (sig) => ticketSnapshotFor(sig, { ...out, id }) });
      }
      break;
    case 'estimates':
      if (out) await signatureReference(tx, 'estimates', before, out, id, { snapshot: (sig) => rebuild(sig, { ...out, id }) });
      if (before && !out && before.signatureId && await liveSignature(tx, before.signatureId)) {
        throw new ApiError(409, 'document_signed', 'A signed estimate is kept. Revise it instead.');
      }
      break;
    case 'jobs':
      if (out) out = await changeOrderGuards(tx, before, out, id);
      break;
    case 'signatures':
      out = await signatureGuard(tx, p, before, out, id, actor, who);
      break;
    case 'stockMoves':
      if (!before && out && !(key === 'system:receiving' && Number.isInteger(out.unitCostCents))) out = await stampMoveCost(tx, out);
      break;
    case 'costCodes':
      if (out && out.active !== false && String(out.code ?? '').trim()) {
        const { rows } = await tx.query(
          `SELECT id FROM cost_codes WHERE tenant_id = $1 AND deleted_at IS NULL AND id <> $2 AND lower(btrim(code)) = lower(btrim($3))
             AND coalesce(data->>'active', 'true') <> 'false' LIMIT 1`, [tx.tenantId, id, String(out.code)]);
        if (rows[0]) throw new ApiError(409, 'duplicate_code', `Another active cost code uses ${String(out.code).trim()}.`);
      }
      break;
    case 'rules':
      if (out) {
        const mine = ruleIdentity(out);
        const { rows } = await tx.query('SELECT id, data FROM rules WHERE tenant_id = $1 AND deleted_at IS NULL AND id <> $2 AND rule_key = $3', [tx.tenantId, id, String(out.key)]);
        if (rows.some((r) => ruleIdentity(r.data) === mine)) throw new ApiError(409, 'duplicate_rule', 'This rule already has a company value for that province and date. Change that one instead.');
      }
      break;
    case 'stockCounts':
      await vanCountRule(tx, p, before, out);
      break;
    default:
  }
  return out;
}

// ---- notifications -------------------------------------------------------------------------

/** Late postings tell the office once a day (counts only; Books lists them). */
async function lateNotice(tx, today) {
  await notify(tx, {
    role: ['owner', 'admin', 'office'], kind: 'late_posting', title: 'Records arrived for a closed period',
    body: 'They were posted on the first open day and flagged late. Books lists them.', link: '#/books', ref: `late_posting:${today}`,
  });
}

// ---- field tickets -----------------------------------------------------------------------------

/** The next ticket number, T-1001 onward (settings.nextNumbers.ticket is only the starting value). */
export async function nextTicketNumber(tx) {
  const { rows: s } = await tx.query("SELECT data->'nextNumbers'->'ticket' AS start FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  const start = Number.isInteger(s[0]?.start) && s[0].start > 0 ? s[0].start : 1001;
  const { rows } = await tx.query(
    `INSERT INTO doc_counters (tenant_id, kind, next) VALUES ($1, 'ticket', $2 + 1)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next = doc_counters.next + 1
     RETURNING next - 1 AS n`, [tx.tenantId, start]);
  return `T-${rows[0].n}`;
}

// ---- signatures --------------------------------------------------------------------------------

/** A snapshot as a document of its type again, so the version's builder can rebuild it. */
function docFromSnapshot(docType, snap) {
  const ticket = (t) => ({ ...t, photos: (t?.photoIds || []).map((x) => ({ id: x })) });
  if (docType === 'fieldTicket') return { doc: ticket(snap), extra: {} };
  if (docType === 'ticketBatch') return { doc: { jobId: snap.jobId, tickets: (snap.tickets || []).map(ticket) }, extra: {} };
  if (docType === 'changeOrder') return { doc: { id: snap.changeOrderId, title: snap.title, amountCents: snap.amountCents, lines: snap.lines }, extra: { jobId: snap.jobId } };
  return { doc: snap, extra: { totalCents: snap.totalCents, taxCents: snap.taxCents } };
}

/** Why a new signature is not 'valid' (null when it is). Never refuses: an odd one is stored unverified. */
export function signatureProblem(sig) {
  const snap = sig?.snapshot;
  if (!isObj(snap)) return 'no_snapshot';
  const v = Number(snap.v);
  if (!SNAPSHOT_BUILDERS[v]?.[sig.docType]) return 'unknown_version';
  if (snap.docType !== sig.docType) return 'snapshot_type';
  let rebuilt;
  try {
    const { doc, extra } = docFromSnapshot(sig.docType, snap);
    rebuilt = snapshotOf(sig.docType, doc, extra, v);
  } catch { return 'snapshot_shape'; }
  if (signedContent(rebuilt) !== signedContent(snap)) return 'snapshot_shape';
  if (sha256hex(signedContent(snap)) !== sig.digest) return 'digest_mismatch';
  const covers = sig.docType === 'ticketBatch' ? (sig.docIds || []).length > 0 : Boolean(sig.docId);
  if (!covers) return 'no_document';
  return null;
}

/** Create: stamp the status. Update: only a void (checkWriteRules allows nothing else). */
async function signatureGuard(tx, p, before, after, id, actor, who) {
  if (!after) return after;
  if (!before) {
    if ((after.method || 'on-device') === 'on-device' && !after.dataUrl) throw validationFailed('A signature taken on the device needs the signature image.', { errors: [{ path: '/dataUrl', message: 'required' }] });
    if (after.method === 'email-reply' && !after.evidence?.dataUrl) throw validationFailed('Acceptance by email needs a photo or screenshot of the reply.', { errors: [{ path: '/evidence/dataUrl', message: 'required' }] });
    const problem = signatureProblem(after);
    const out = { ...after, v: Number(after.snapshot?.v) || after.v || null, status: problem ? 'unverified' : 'valid' };
    delete out.voidedAt; delete out.voidedBy; delete out.voidReason;
    if (problem) {
      out.unverifiedReason = problem;
      await unverifiedNotice(tx, id, after);
    } else delete out.unverifiedReason;
    return out;
  }
  if (before.status !== 'void' && after.status === 'void') {
    const out = { ...after, voidedAt: after.voidedAt || new Date().toISOString(), voidedBy: after.voidedBy || { id: actor.id ?? null, name: actor.label ?? null } };
    await appendAudit(tx, tx.tenantId, { actor, action: 'signature.void', collection: 'signatures', recordId: id, summary: String(after.voidReason || '').slice(0, 200), request: who?.request });
    return out;
  }
  return after;
}

async function unverifiedNotice(tx, id, sig) {
  await notify(tx, {
    perm: 'invoices', kind: 'signature_unverified', title: "A signature didn't match what was signed",
    body: `${sig.signerName || 'A customer'} signed a ${{ estimate: 'estimate', changeOrder: 'change order', fieldTicket: 'field ticket', ticketBatch: 'batch of tickets' }[sig.docType] || 'document'}; it is kept and marked unverified. Check it before you bill.`,
    link: sig.jobId ? `#/jobs/${sig.jobId}` : '#/books', ref: `sig:${id}`,
  });
}

async function loadSignature(tx, id) {
  if (!id) return null;
  const { rows } = await tx.query('SELECT id, data FROM signatures WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, String(id)]);
  return rows[0] ? { ...rows[0].data, id: rows[0].id } : null;
}
const liveSignature = async (tx, id) => { const s = await loadSignature(tx, id); return s && s.status !== 'void' ? s : null; };

/** Mark a signature unverified (the document it was linked to says something else). */
async function markUnverified(tx, sig, reason) {
  await tx.query(
    `UPDATE signatures SET data = data || jsonb_build_object('status', 'unverified', 'unverifiedReason', $3::text, 'updatedAt', $4::text), updated_by = 'system:signatures'
      WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, sig.id, reason, new Date().toISOString()]);
  await unverifiedNotice(tx, sig.id, sig);
}

/** Rebuild a document's snapshot in the signature's version (null when that is not possible). */
function rebuild(sig, doc, extra = {}) {
  const v = Number(sig?.snapshot?.v);
  if (!SNAPSHOT_BUILDERS[v]?.[sig.docType]) return null;
  return snapshotOf(sig.docType, doc, extra, v);
}

/** A ticket's snapshot as its signature saw it (a batch holds one per ticket). */
function ticketSnapshotFor(sig, ticket) {
  const v = Number(sig?.snapshot?.v);
  if (!SNAPSHOT_BUILDERS[v]?.fieldTicket) return null;
  const own = snapshotOf('fieldTicket', ticket, {}, v);
  if (sig.docType === 'ticketBatch') return { own, signed: (sig.snapshot.tickets || []).find((t) => t?.id === ticket.id) || null };
  return { own, signed: sig.snapshot };
}

/**
 * A document that sets or keeps signatureId must reference a live signature of this document
 * (422 signature_invalid). Newly linked to a 'valid' signature whose snapshot differs: the
 * signature becomes unverified (the document still lands). Once signed, the signed keys are frozen.
 */
async function signatureReference(tx, coll, before, after, id, { snapshot }) {
  const sid = after.signatureId || null;
  const prevSid = before?.signatureId || null;
  // Frozen once signed: the signed keys of a document carrying a live signature.
  if (prevSid) {
    const prev = await liveSignature(tx, prevSid);
    if (prev) {
      if (sid !== prevSid) throw new ApiError(409, 'document_signed', 'This was signed. Void the signature first, or make a revision.');
      const keys = SIGNED_KEYS[coll] || [];
      const changed = keys.filter((k) => !same(before[k], after[k]));
      if (changed.length) throw new ApiError(409, 'document_signed', `This was signed, so ${changed.slice(0, 3).join(', ')} cannot change. Make a revision or a new document instead.`, { fields: changed });
      return;
    }
  }
  if (!sid) return;
  const sig = await loadSignature(tx, sid);
  const expected = coll === 'estimates' ? 'estimate' : 'fieldTicket';
  const okType = sig && (sig.docType === expected || (coll === 'fieldTickets' && sig.docType === 'ticketBatch'));
  if (!sig || sig.status === 'void' || !okType || !signatureCovers(sig, id)) {
    throw new ApiError(422, 'signature_invalid', 'The signature this refers to is missing, void, or for another document.');
  }
  if (sid === prevSid || sig.status !== 'valid') return;
  const snap = snapshot(sig);
  const differs = coll === 'fieldTickets' ? !snap?.signed || !sameSnapshot(snap.own, snap.signed) : !snap || !sameSnapshot(snap, sig.snapshot);
  if (differs) await markUnverified(tx, sig, 'document_differs');
}

// ---- change orders ---------------------------------------------------------------------------

/** Signed change orders are never removed (only voided) and their signed keys never change. */
async function changeOrderGuards(tx, before, after, id) {
  const beforeCos = (before?.changeOrders || []).filter((c) => isObj(c) && c.id);
  let cos = Array.isArray(after.changeOrders) ? [...after.changeOrders] : [];
  const have = new Set(cos.filter(isObj).map((c) => c.id));
  for (const co of beforeCos) {
    if (co.signatureId && !have.has(co.id)) cos.push(co); // put back: void it instead of removing it
  }
  const prevById = new Map(beforeCos.map((c) => [c.id, c]));
  for (const co of cos) {
    if (!isObj(co) || !co.id) continue;
    const prev = prevById.get(co.id);
    if (prev?.signatureId && await liveSignature(tx, prev.signatureId)) {
      if (co.signatureId !== prev.signatureId) throw new ApiError(409, 'document_signed', 'This change order was signed. Void it and add a new one instead.');
      const changed = SIGNED_KEYS.changeOrder.filter((k) => !same(prev[k], co[k]));
      if (changed.length) throw new ApiError(409, 'document_signed', 'This change order was signed, so its title, lines and amount cannot change. Add a new change order instead.', { fields: changed });
      continue;
    }
    if (!co.signatureId || co.signatureId === prev?.signatureId) continue;
    const sig = await loadSignature(tx, co.signatureId);
    if (!sig || sig.status === 'void' || sig.docType !== 'changeOrder' || !(sig.docId === co.id || sig.changeOrderId === co.id)) {
      throw new ApiError(422, 'signature_invalid', 'The signature this change order refers to is missing, void, or for another change order.');
    }
    if (sig.status === 'valid') {
      const snap = rebuild(sig, co, { jobId: id });
      if (!snap || !sameSnapshot(snap, sig.snapshot)) await markUnverified(tx, sig, 'document_differs');
    }
  }
  return cos.length === (after.changeOrders || []).length ? after : { ...after, changeOrders: cos };
}

// ---- stock moves and counts ------------------------------------------------------------------

/** unitCostCents = the item's moving average, else its catalogue cost (2.6 move cost). */
async function stampMoveCost(tx, move) {
  const out = { ...move };
  delete out.unitCostCents;
  if (!move.itemId) return out;
  const { rows } = await tx.query("SELECT data->'avgCostCents' AS avg, data->'costCents' AS cost FROM items WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL", [tx.tenantId, String(move.itemId)]);
  const v = Number.isInteger(rows[0]?.avg) ? rows[0].avg : Number.isInteger(rows[0]?.cost) ? rows[0].cost : null;
  if (v != null) out.unitCostCents = v;
  return out;
}

/**
 * Counts: inventory managers do anything; a van's owner (their employee's defaultEquipmentId truck
 * has this locationId) may create and edit draft and counted sheets for that van only.
 */
async function vanCountRule(tx, p, before, after) {
  if (p?.kind !== 'session') return;
  if (p.isManager && p.perms?.has?.('inventory')) return;
  const refuse = (m) => { throw new ApiError(403, 'forbidden', m); };
  if (!p.employeeId) refuse('Your membership is not linked to an employee record, so you cannot count stock.');
  const { rows } = await tx.query(
    `SELECT eq.data->>'locationId' AS loc FROM employees e JOIN equipment eq ON eq.tenant_id = e.tenant_id AND eq.id = e.data->>'defaultEquipmentId' AND eq.deleted_at IS NULL
      WHERE e.tenant_id = $1 AND e.id = $2 AND e.deleted_at IS NULL`, [tx.tenantId, p.employeeId]);
  const van = rows[0]?.loc || null;
  if (!van) refuse('Only the office, or the person who drives a van, can count stock.');
  for (const c of [before, after]) {
    if (!c) continue;
    if (c.locationId !== van) refuse('You can only count your own van.');
    if (!['draft', 'counted', undefined, null].includes(c.status)) refuse('Only a manager posts or voids a count.');
  }
  if (before && !after) refuse('Only a manager deletes a count.');
}

/** Today in the company zone (for callers that have the locks). */
export const todayIn = (zone) => dayIn(new Date().toISOString(), zone);
