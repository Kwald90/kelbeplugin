// Conflicts, reviews, unlink and relink (docs/integrations/quickbooks.md 5.6, 7.5, 7.7). While a
// conflict is open neither side of that record is written; a later change on either side re-runs the
// merge, which closes the conflict by itself when the two sides agree again. A person resolves it
// field by field, approves a held write, or unlinks (a tombstone that never sends a second copy).
import { ApiError, notFound, validationFailed } from '../errors.js';
import { appendAudit } from '../services/audit.js';
import { recordLabel, writeLog } from './log.js';
import { QboError } from './client.js';
import { QBO_RANK, upsertOutbox } from './hooks.js';
import {
  makeRun, stampPush, txWrite, getLink, getLinkById, updateLink, loadRecord, system, reconcile, tripBrake, BrakeError, PassStop, ctxFor,
  linksByRemote, voidLocalInvoice, assertActive, lockedReview, invoiceWithJob, pulledInvoiceProblem,
} from './engine.js';
import { processRecord, pushDelete, removeLinked } from './push.js';
import { remoteDeleted } from './pull.js';
import { fishtapeToCanon, qboToCanon, canonEqual, str } from './map/canon.js';
import { canonCollection, fieldsOf, aliasHash, MONEY_RECORD_KEYS, PUSH_ONLY_COLLECTIONS } from './map/merge.js';
import { QBO_ENTITY } from './map/to-qbo.js';
import { exemptionFor } from '../../../electrical-app/js/lib/exemption.js';

const ID = /^\d{1,20}$/;
/** Review reasons where 'quickbooks' drops a held Fishtape edit: Fishtape goes back to QuickBooks' copy. */
const DROP_REASONS = ['origin', 'filed_period', 'payroll_locked'];

// ---- storage ----------------------------------------------------------------------------------------

/** Open (or refresh) the one open conflict of a link (unique per link while open). */
export async function openConflict(tx, run, link, { kind, label = null, reason = null, fields = [] }) {
  const { rows } = await tx.query("SELECT id FROM qbo_conflicts WHERE tenant_id = $1 AND link_id = $2 AND status = 'open'", [tx.tenantId, link.id]);
  if (rows[0]) {
    await tx.query('UPDATE qbo_conflicts SET kind = $3, reason = $4, fields = $5, label = COALESCE($6, label) WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, rows[0].id, kind, reason, JSON.stringify(fields), label ? String(label).slice(0, 200) : null]);
    return rows[0].id;
  }
  const ins = await tx.query(
    `INSERT INTO qbo_conflicts (tenant_id, link_id, kind, collection, record_id, label, reason, fields) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [tx.tenantId, link.id, kind, link.collection, link.record_id, label ? String(label).slice(0, 200) : null, reason, JSON.stringify(fields)]);
  return ins.rows[0].id;
}

/** A review (needs_review link): one row whose `fishtape` text says what to check. */
export function openReview(tx, run, link, { reason, label, message }) {
  return openConflict(tx, run, link, { kind: 'review', label, reason, fields: [{ field: 'review', label: 'Check', base: '', fishtape: message || reason, quickbooks: '' }] });
}

/** Close the open conflict of a link. */
export async function closeConflict(tx, linkId, by = 'system', resolution = null, status = 'resolved') {
  await tx.query(
    `UPDATE qbo_conflicts SET status = $4, resolved_at = now(), resolved_by = $3, resolution = $5 WHERE tenant_id = $1 AND link_id = $2 AND status = 'open'`,
    [tx.tenantId, linkId, String(by).slice(0, 200), status, resolution ? JSON.stringify(resolution) : null]);
}

/** The API shape of a conflict (7.7). */
export function conflictView(row) {
  return {
    id: row.id, kind: row.kind, collection: row.collection, recordId: row.record_id, label: row.label, reason: row.reason, status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    fields: (row.fields || []).map(({ recordIds, qboId, ...f }) => f), // the merge's own keys stay inside
    resolution: row.resolution || null, resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    ...(row.kind === 'merged' ? { recordIds: mergedRecordIds(row) } : {}),
  };
}

/** The two Fishtape records a QuickBooks merge folded together (the conflict's own record first). */
function mergedRecordIds(row) {
  const ids = Array.isArray(row.fields?.[0]?.recordIds) ? row.fields[0].recordIds.map(String) : [];
  return [...new Set([row.record_id, ...ids])];
}

// ---- unlink and relink (5.6, 7.5) -----------------------------------------------------------------

/** Unlink: the link becomes a tombstone; nothing is pushed or pulled for the record any more. */
export async function unlinkRecord(run, collection, id, who) {
  return txWrite(run, async (tx) => {
    const l = await getLink(tx, collection, id);
    if (!l) throw notFound('This record is not linked to QuickBooks.');
    if (l.state === 'unlinked') return l;
    const t = await updateLink(tx, run, l.id, { state: 'unlinked', owner: 'none', reason: null, snapshot: null, prev_values: {}, meta: { ...(l.meta || {}), unlinkedAt: new Date().toISOString() } });
    await closeConflict(tx, l.id, who?.actor ? `${who.actor.type}:${who.actor.id ?? ''}` : 'system', { choice: 'unlink' }, 'dismissed');
    await tx.query('DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, collection, id]);
    await appendAudit(tx, run.tenantId, { actor: who.actor, action: 'qbo.unlink', collection, recordId: id, summary: 'Unlinked from QuickBooks', request: who.request });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'unlink', collection, recordId: id, qboEntity: l.qbo_entity, message: 'Unlinked from QuickBooks' });
    return t;
  });
}

/**
 * Relink to another QuickBooks object (7.5): of the collection's entity, existing and active, not
 * linked elsewhere. The new link has no base (B = null): every differing field is a conflict and
 * nothing is written either way.
 */
export async function relinkRecord(run, collection, id, qboId, who, { entity: wanted = null } = {}) {
  if (!ID.test(String(qboId || ''))) throw validationFailed('qboId must be a QuickBooks id.');
  const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, collection, id));
  if (!rec || rec.deleted) throw notFound();
  if (collection === 'employees') return linkEmployee(run, id, String(qboId), who, wanted);
  const entity = collection === 'bills' ? (rec.data.kind === 'receipt' ? 'Purchase' : 'Bill') : QBO_ENTITY[collection];
  if (!entity || collection === 'stripePayouts') throw validationFailed('This collection cannot be linked.');
  let obj;
  try { obj = await run.client.read(entity, qboId); } catch (e) {
    if (e instanceof QboError && e.kind === 'not_found') throw new ApiError(404, 'not_found', 'QuickBooks has no such record.');
    throw e;
  }
  if (obj.Active === false || (collection === 'clients' && (obj.Job || obj.ParentRef)) || (collection === 'jobs' && !obj.Job && !obj.ParentRef && !obj.IsProject)) {
    throw validationFailed('That QuickBooks record cannot be linked here.');
  }
  const link = await txWrite(run, async (tx) => {
    const taken = (await linksByRemote(tx, entity, qboId)).find((l) => l.role === 'main' && !(l.collection === collection && l.record_id === id));
    if (taken) throw new ApiError(409, 'qbo_already_linked', 'That QuickBooks record is linked to another Fishtape record.');
    const cur = await getLink(tx, collection, id);
    const fields = { qbo_entity: entity, qbo_id: String(obj.Id), qbo_line: '', sync_token: null, snapshot: null, prev_values: {}, state: 'pending', owner: 'both', reason: null, meta: { relinkedAt: new Date().toISOString() } };
    let l;
    if (cur) {
      await closeConflict(tx, cur.id, 'system', { choice: 'relink' }, 'dismissed');
      l = await updateLink(tx, run, cur.id, fields);
    } else {
      const { insertLink } = await import('./engine.js');
      l = await insertLink(tx, run, { collection, record_id: id, role: 'main', ...fields });
    }
    await appendAudit(tx, run.tenantId, { actor: who.actor, action: 'qbo.relink', collection, recordId: id, summary: 'Linked to a different QuickBooks record', request: who.request });
    return l;
  });
  await reconcile(run, link, { remote: obj, record: rec, direction: 'push' });
  return run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLinkById(tx, link.id));
}

/**
 * Link a Fishtape employee to a QuickBooks Employee (or a Vendor for a subcontractor, 4.5) after setup:
 * the wizard's scan only runs once, and someone hired later has approved time waiting for this link.
 * Employees are link-only (QuickBooks keeps them): the link is synced with no base and nothing is
 * written. The time entries that waited for it (blocked/employee_not_linked) go to the outbox.
 */
async function linkEmployee(run, id, qboId, who, wanted) {
  let obj = null;
  let entity = null;
  for (const e of wanted ? [wanted] : ['Employee', 'Vendor']) {
    if (!['Employee', 'Vendor'].includes(e)) throw validationFailed('entity must be Employee or Vendor.');
    try { obj = await run.client.read(e, qboId); entity = e; break; } catch (err) {
      if (!(err instanceof QboError && err.kind === 'not_found')) throw err;
    }
  }
  if (!obj) throw new ApiError(404, 'not_found', 'QuickBooks has no such employee.');
  if (obj.Active === false) throw validationFailed('That QuickBooks employee is inactive.');
  const { insertLink } = await import('./engine.js');
  return txWrite(run, async (tx) => {
    const taken = (await linksByRemote(tx, entity, qboId)).find((l) => l.role === 'main' && !(l.collection === 'employees' && l.record_id === id));
    if (taken) throw new ApiError(409, 'qbo_already_linked', 'That QuickBooks record is linked to another Fishtape record.');
    const cur = await getLink(tx, 'employees', id);
    const fields = { qbo_entity: entity, qbo_id: String(obj.Id), qbo_line: '', sync_token: obj.SyncToken != null ? String(obj.SyncToken) : null, snapshot: {}, prev_values: {},
      state: 'synced', owner: 'quickbooks', reason: null, meta: { displayName: obj.DisplayName || null, linkedAt: new Date().toISOString() } };
    const l = cur ? await updateLink(tx, run, cur.id, fields) : await insertLink(tx, run, { collection: 'employees', record_id: id, role: 'main', ...fields });
    const waiting = (await tx.query(
      `SELECT l.record_id FROM qbo_links l JOIN time_entries r ON r.tenant_id = l.tenant_id AND r.id = l.record_id
        WHERE l.tenant_id = $1 AND l.collection = 'timeEntries' AND l.role = 'main' AND l.state = 'blocked' AND l.reason = 'employee_not_linked'
          AND r.data->>'employeeId' = $2 AND r.deleted_at IS NULL`, [tx.tenantId, id])).rows;
    for (const w of waiting) await upsertOutbox(tx, { collection: 'timeEntries', recordId: w.record_id, op: 'upsert', actorType: 'system', rank: QBO_RANK.timeEntries, delayS: 0 });
    await appendAudit(tx, run.tenantId, { actor: who.actor, action: 'qbo.relink', collection: 'employees', recordId: id, summary: `Linked to a QuickBooks ${entity === 'Vendor' ? 'supplier' : 'employee'}`, request: who.request });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'link', collection: 'employees', recordId: id, qboEntity: entity, message: `Linked to QuickBooks; ${waiting.length} waiting time entr${waiting.length === 1 ? 'y goes' : 'ies go'} now.` });
    return l;
  });
}

// ---- resolve (5.6, 7.7) ------------------------------------------------------------------------------

const CHOICES = {
  fields: ['fishtape', 'quickbooks', 'fields'],
  review: ['fishtape', 'quickbooks', 'unlink', 'link', 'create', 'note'],
  deleted: ['restore', 'delete', 'fishtape', 'quickbooks'],
  merged: ['unlink'],
};
/** Reviews of a QuickBooks change to a record locked in Fishtape (r1-get-paid.md 9.6). */
const LOCK_REASONS = ['period_locked', 'document_signed'];
/** Reviews the office settles in QuickBooks: nothing is ever sent for them in R1 (9.2). */
const NEVER_SEND_REASONS = ['on_account', 'refund', 'reversal'];
const NOTE_MAX = 500;

/**
 * Resolve a conflict. The caller holds the tenant lease (5.8; API actions wait 10 s for it) and
 * passes its epoch. Writes the audit event qbo.conflict.resolve and a log row.
 * @returns {Promise<object>} the conflict (resolved)
 */
export async function resolveConflict(deps, tenantId, conflictId, body, who, o = {}) {
  const run = await makeRun(deps, tenantId, { epoch: o.epoch, purpose: 'sync' });
  try { return await resolveRun(run, deps, tenantId, conflictId, body, who, o); } finally { await stampPush(run); }
}
async function resolveRun(run, deps, tenantId, conflictId, { choice, fields = null, recordId = null, note = null }, who, { epoch } = {}) {
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  const c = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conflictId])).rows[0]);
  if (!c) throw notFound();
  if (c.status !== 'open') throw new ApiError(409, 'qbo_conflict_closed', 'This conflict is already resolved.');
  if (!CHOICES[c.kind]?.includes(choice)) throw validationFailed(`Choose one of: ${CHOICES[c.kind].join(', ')}.`);
  const link = await run.db.withTenant({ tenantId }, (tx) => getLinkById(tx, c.link_id));
  if (!link) throw notFound();
  const reason = c.reason || link.reason;
  // "Keep the difference noted" is only for a QuickBooks change to a locked record (9.6).
  if (choice === 'note' && !LOCK_REASONS.includes(reason)) throw validationFailed('A difference can be noted only for a change to a closed period or a signed document.');
  if (note != null && (typeof note !== 'string' || note.length > NOTE_MAX)) throw validationFailed(`note is text of at most ${NOTE_MAX} characters.`);
  // QuickBooks is the book of record (9.6): Fishtape's locked copy is never pushed over its change.
  if (c.kind === 'review' && choice === 'fishtape' && LOCK_REASONS.includes(reason)) {
    throw new ApiError(409, 'qbo_locked', 'QuickBooks keeps the change. Reopen the period and accept QuickBooks, or keep the difference noted.');
  }
  // Approving a payment R1 never sends (9.2) is refused: record it in QuickBooks, then choose 'quickbooks'.
  if (c.kind === 'review' && choice === 'fishtape' && NEVER_SEND_REASONS.includes(reason)) {
    throw new ApiError(409, 'qbo_not_sent', 'This is not sent to QuickBooks. Record it in QuickBooks, then mark it recorded.');
  }
  // Paused (any reason) or in setup, sync is off (2.5): only choices that never call QuickBooks run.
  // A push-only record's held edit is dropped without reading QuickBooks (dropHeldEdit).
  const offline = choice === 'unlink' || c.kind === 'merged' || (choice === 'quickbooks' && NEVER_SEND_REASONS.includes(reason))
    || (c.kind === 'review' && choice === 'quickbooks' && !LOCK_REASONS.includes(reason) && (!link.qbo_id || !DROP_REASONS.includes(reason) || PUSH_ONLY_COLLECTIONS.includes(canonCollection(link.collection, link.role))));
  if (!offline) assertActive(run);
  const by = who?.actor ? `${who.actor.type}:${who.actor.id ?? ''}` : 'system';
  const resolution = { choice, ...(fields ? { fields } : {}), ...(recordId ? { recordId } : {}), ...(note ? { note: String(note).slice(0, NOTE_MAX) } : {}) };
  const close = async (status = 'resolved') => txWrite(run, async (tx) => {
    await closeConflict(tx, link.id, by, resolution, status);
    await appendAudit(tx, tenantId, { actor: who.actor, action: 'qbo.conflict.resolve', collection: link.collection, recordId: link.record_id, summary: `Resolved a QuickBooks ${c.kind} (${choice})`, request: who.request, meta: { conflictId, choice } });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'resolve', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label: c.label, message: `Resolved: ${choice}` });
  });
  try {
    if (c.kind === 'fields') await resolveFields(run, link, c, choice, fields);
    else if (c.kind === 'review' && LOCK_REASONS.includes(reason) && ['quickbooks', 'note'].includes(choice)) await resolveLocked(run, link, c, choice, { note, by });
    else if (c.kind === 'review') await resolveReview(run, link, c, choice, who);
    else if (c.kind === 'deleted') await resolveDeleted(run, link, c, choice);
    else if (c.kind === 'merged') await resolveMerged(run, link, c, recordId, who);
  } catch (e) {
    if (e instanceof BrakeError) { await tripBrake(run, e.count); throw new ApiError(409, 'qbo_paused', 'QuickBooks sync paused by the safety brake.'); }
    if (e instanceof PassStop && e.cause) throw e.cause;
    throw e;
  }
  const still = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conflictId])).rows[0]);
  if (still?.status === 'open') await close();
  else await txWrite(run, (tx) => appendAudit(tx, tenantId, { actor: who.actor, action: 'qbo.conflict.resolve', collection: link.collection, recordId: link.record_id, summary: `Resolved a QuickBooks ${c.kind} (${choice})`, request: who.request, meta: { conflictId, choice } }));
  const row = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conflictId])).rows[0]);
  // A restore that re-creates the QuickBooks object replaces the link (and its conflicts) with a new one.
  return conflictView(row || { ...c, status: 'resolved', resolution, resolved_at: new Date() });
}

/**
 * Field choices: the side chosen for each field is written to the other. Done by moving the base:
 * a field won by Fishtape gets B = R (so L ≠ B goes to QuickBooks), one won by QuickBooks B = L. A
 * device value held by records.js and chosen here is applied to the record first.
 */
async function resolveFields(run, link, c, choice, fields) {
  const rows = Array.isArray(c.fields) ? c.fields : [];
  const pick = (f) => (choice === 'fields' ? fields?.[f] : choice);
  if (choice === 'fields') {
    if (!fields || typeof fields !== 'object') throw validationFailed('fields is required.');
    for (const r of rows) if (!['fishtape', 'quickbooks'].includes(fields[r.field])) throw validationFailed(`Choose a side for ${r.label || r.field}.`);
  }
  const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
  if (!rec || rec.deleted) throw new ApiError(409, 'qbo_record_gone', 'The Fishtape record is gone.');
  const obj = await run.client.read(link.qbo_entity, link.qbo_id);
  const ctx = ctxFor(run, link, link.collection);
  const queued = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
    'SELECT held FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, link.collection, link.record_id])).rows[0]?.held || {});
  const held = { ...(link.meta?.held || {}), ...queued };
  const canonColl = canonCollection(link.collection, link.role);
  const moneyKeys = MONEY_RECORD_KEYS[canonColl] || {};
  await txWrite(run, async (tx) => {
    const patch = {};
    for (const r of rows) if (pick(r.field) === 'fishtape') for (const k of moneyKeys[r.field] || []) if (k in held) patch[k] = held[k];
    if (Object.keys(patch).length) await system.patch(tx, run, link.collection, link.record_id, patch);
    await tx.query("UPDATE qbo_outbox SET held = '{}'::jsonb WHERE tenant_id = $1 AND collection = $2 AND record_id = $3", [tx.tenantId, link.collection, link.record_id]);
  });
  const fresh = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
  const L = fishtapeToCanon(link.collection, fresh.data, ctx);
  const R = qboToCanon(link.qbo_entity, obj, { ...ctx, collection: link.collection });
  const B = { ...(link.snapshot || {}) };
  const names = rows.map((r) => r.field).filter((f) => fieldsOf(canonColl).includes(f));
  for (const f of names) B[f] = pick(f) === 'fishtape' ? (R[f] ?? null) : (L[f] ?? null);
  const meta = { ...(link.meta || {}) };
  delete meta.held;
  const l = await txWrite(run, (tx) => updateLink(tx, run, link.id, { snapshot: B, state: 'pending', prev_values: {}, meta }));
  await reconcile(run, l, { record: fresh, remote: obj, force: true, direction: 'push' });
}

/**
 * A QuickBooks change to a record locked in Fishtape (r1-get-paid.md 9.6). 'quickbooks' ("Reopen the
 * period and accept QuickBooks"): the base takes Fishtape's value for every field that differs, so
 * the merge writes QuickBooks' copy into Fishtape; while the period is still closed the records
 * service refuses again and the review stays. A create held for the lock is made now. 'note' ("Keep
 * the difference noted"): the note is kept on the link, the base becomes Fishtape's copy and
 * QuickBooks' current values count as equal to it (remoteAlias), so nothing is written either way
 * until either side changes again.
 */
async function resolveLocked(run, link, c, choice, { note, by }) {
  const pending = link.meta?.pendingCreate;
  if (pending) {
    const obj = await run.client.read(link.qbo_entity, link.qbo_id);
    if (choice === 'note') {
      await txWrite(run, async (tx) => {
        await closeConflict(tx, link.id, by, { choice, note });
        await updateLink(tx, run, link.id, { state: 'unlinked', owner: 'none', reason: null, meta: { ...(link.meta || {}), noted: { note: note || null, by, at: new Date().toISOString() } } });
        await writeLog(tx, { direction: 'system', outcome: 'info', action: 'resolve', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label: c.label, message: 'Kept out of Fishtape; the difference is noted.' });
      });
      return;
    }
    const { createFromRemote } = await import('./pull.js');
    const made = await createFromRemote(run, pending.collection || link.collection, pending.entity || link.qbo_entity, obj, { id: link.record_id, replaceLink: link.id });
    if (made?.held) throw new ApiError(409, 'period_locked', 'The period is still closed in Fishtape. Reopen it on Books first.');
    await txWrite(run, (tx) => closeConflict(tx, link.id, by, { choice }));
    return;
  }
  const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
  if (!rec || rec.deleted) throw new ApiError(409, 'qbo_record_gone', 'The Fishtape record is gone.');
  const obj = await run.client.read(link.qbo_entity, link.qbo_id);
  const ctx = ctxFor(run, link, link.collection);
  const canonColl = canonCollection(link.collection, link.role);
  const L = fishtapeToCanon(link.collection, rec.data, ctx);
  const R = qboToCanon(link.qbo_entity, obj, { ...ctx, collection: link.collection });
  const B = { ...(link.snapshot || {}) };
  const differing = fieldsOf(canonColl).filter((f) => !canonEqual(canonColl, f, L[f] ?? null, R[f] ?? null));
  for (const f of differing) B[f] = L[f] ?? null;
  const meta = { ...(link.meta || {}) };
  delete meta.lockedAt;
  if (choice === 'note') {
    const remoteAlias = { ...(meta.remoteAlias || {}) };
    for (const f of differing) remoteAlias[f] = aliasHash(canonColl, f, R[f] ?? null);
    await txWrite(run, async (tx) => {
      await closeConflict(tx, link.id, by, { choice, note });
      await updateLink(tx, run, link.id, {
        state: 'synced', reason: null, snapshot: B, sync_token: obj.SyncToken != null ? String(obj.SyncToken) : link.sync_token,
        meta: { ...meta, remoteAlias, noted: { note: note || null, by, at: new Date().toISOString(), fields: differing } },
      });
      await tx.query('DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, link.collection, link.record_id]);
      await writeLog(tx, { direction: 'system', outcome: 'info', action: 'resolve', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label: c.label, message: `Difference with QuickBooks noted${note ? `: ${String(note).slice(0, 120)}` : ''}` });
    });
    return;
  }
  // Reopened: QuickBooks' copy is written into Fishtape now (or refused again while still closed).
  const l = await txWrite(run, (tx) => updateLink(tx, run, link.id, { state: 'pending', reason: null, snapshot: B, prev_values: {}, meta }));
  const state = await reconcile(run, l, { record: rec, remote: obj, direction: 'pull', force: true });
  if (state === 'needs_review') throw new ApiError(409, 'period_locked', 'The period is still closed in Fishtape. Reopen it on Books first.');
  await txWrite(run, (tx) => closeConflict(tx, link.id, by, { choice }));
}

/**
 * "Fixed in Fishtape" on a pulled invoice's review (r1-get-paid.md 9.7): the check runs again. With
 * the evidence now on the job, the job's exemption is copied onto the invoice (Fishtape-only fields)
 * and the review closes; still missing, 422 exemption_required with what is missing.
 */
async function recheckPulledInvoice(run, link, c, reason) {
  const problem = await txWrite(run, async (tx) => {
    const { rec, job } = await invoiceWithJob(tx, link.record_id);
    if (!rec) throw new ApiError(409, 'qbo_record_gone', 'The Fishtape record is gone.');
    const p = pulledInvoiceProblem(rec.data, { job });
    if (p) return p;
    if (reason === 'exemption_missing' && !rec.data.taxExemptBasis) {
      const ex = exemptionFor({ job, province: rec.data.taxProvince });
      if (ex.taxExemptBasis) {
        try { await system.patch(tx, run, 'invoices', link.record_id, ex); } catch (e) { if (!lockedReview(e)) throw e; }
      }
    }
    await closeConflict(tx, link.id, 'system', { choice: 'fishtape' });
    await updateLink(tx, run, link.id, { state: 'synced', reason: null });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'resolve', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label: c.label, message: 'Checked again in Fishtape: nothing missing.' });
    return null;
  });
  if (problem) {
    const code = problem.reason === 'exemption_missing' ? 'exemption_required' : problem.reason;
    throw new ApiError(422, code, problem.message, problem.missing ? { missing: problem.missing } : undefined);
  }
}

/** Reviews: approve (send), keep QuickBooks' copy, unlink, or for a taken name link or create. */
async function resolveReview(run, link, c, choice, who) {
  const reason = c.reason || link.reason;
  if (choice === 'unlink') { await unlinkRecord(run, link.collection, link.record_id, who); return; }
  // Recorded in QuickBooks by the office (9.2): nothing is sent for it, now or later.
  if (NEVER_SEND_REASONS.includes(reason) && choice === 'quickbooks') {
    await txWrite(run, async (tx) => {
      await closeConflict(tx, link.id, 'system', { choice });
      await tx.query('DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, link.collection, link.record_id]);
      await updateLink(tx, run, link.id, { state: 'unlinked', owner: 'none', reason: null, meta: { ...(link.meta || {}), recordedInQuickBooks: new Date().toISOString() } });
    });
    return;
  }
  // The exemption or holdback was put right in Fishtape (9.7): checked again before the review closes.
  if (['exemption_missing', 'holdback_invalid', 'tax_off_invalid'].includes(reason) && choice === 'fishtape') {
    await recheckPulledInvoice(run, link, c, reason);
    return;
  }
  if (reason === 'name_taken' && (choice === 'link' || choice === 'create')) {
    const holder = link.meta?.nameHolder;
    if (choice === 'link' && holder) { await relinkRecord(run, link.collection, link.record_id, holder, who); return; }
    const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
    const { createWithSuffix } = await import('./push.js');
    const l = await txWrite(run, (tx) => updateLink(tx, run, link.id, { state: 'pending', reason: null }));
    await txWrite(run, (tx) => closeConflict(tx, link.id, 'system', { choice }));
    await createWithSuffix(run, link.collection, rec, l, { row: null, label: c.label, base: fishtapeToCanon(link.collection, rec.data, ctxFor(run, l, link.collection)).name });
    return;
  }
  if (choice === 'fishtape') {
    const meta = { ...(link.meta || {}) };
    delete meta.originRejected;
    if (reason === 'filed_period') meta.filedConfirmed = true;
    if (reason === 'payout_items') meta.payoutApproved = true;
    if (reason === 'credit_apply') meta.applyApproved = true;
    let snapshot = link.snapshot;
    if (link.qbo_id && ['wizard_differs', 'tax_shape', 'tax_inclusive', 'totals_differ'].includes(reason)) {
      // Fishtape's version replaces QuickBooks': the base becomes QuickBooks' copy, so every difference is sent.
      const obj = await run.client.read(link.qbo_entity, link.qbo_id);
      snapshot = { ...qboToCanon(link.qbo_entity, obj, { ...ctxFor(run, link, link.collection), collection: link.collection }), extra: link.snapshot?.extra };
    }
    const l = await txWrite(run, async (tx) => {
      await closeConflict(tx, link.id, 'system', { choice });
      return updateLink(tx, run, link.id, { owner: link.collection === 'stripePayouts' || link.role === 'apply' ? 'fishtape' : (['jobs', 'purchaseOrders', 'timeEntries'].includes(link.collection) ? 'fishtape' : 'both'), state: link.qbo_id ? 'pending' : 'pending', reason: null, meta, snapshot });
    });
    if (link.collection === 'stripePayouts') {
      await txWrite(run, (tx) => upsertOutbox(tx, { collection: 'stripePayouts', recordId: link.record_id, op: 'upsert', actorType: 'system', rank: QBO_RANK.stripePayouts, delayS: 0 }));
      return;
    }
    const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
    if (!rec) return;
    if (rec.deleted) {
      // A held delete or void (a filed GST period, a paid pay period): approved, it goes now.
      if (l.qbo_id) await pushDelete(run, null, rec, l, { force: true });
      return;
    }
    if (l.qbo_id) await reconcile(run, l, { record: rec, force: true, direction: 'push' });
    else await processRecord(run, link.collection, link.record_id, { force: true, link: l, actorType: 'user' });
    return;
  }
  // 'quickbooks' on a held Fishtape edit of a linked record: the edit is dropped for good (5.6).
  if (link.qbo_id && DROP_REASONS.includes(reason)) { await dropHeldEdit(run, link, choice); return; }
  // 'quickbooks': QuickBooks' copy stays the truth, or the held write is dropped.
  await txWrite(run, async (tx) => {
    await closeConflict(tx, link.id, 'system', { choice });
    await tx.query('DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, link.collection, link.record_id]);
    if (!link.qbo_id) await tx.query('DELETE FROM qbo_links WHERE tenant_id = $1 AND id = $2', [tx.tenantId, link.id]);
    else if (['origin', 'filed_period', 'payroll_locked'].includes(reason)) {
      // The edit is not sent; QuickBooks' values come back on the next pull.
      await updateLink(tx, run, link.id, { state: 'synced', reason: null, owner: link.owner === 'quickbooks' ? 'both' : link.owner, sync_token: null });
    } else await updateLink(tx, run, link.id, { state: 'synced', reason: null, owner: 'quickbooks' });
  });
}

/**
 * Drop a held edit (origin, filed period, pay period): QuickBooks' copy wins. The base takes Fishtape's
 * value for every field that differs, so the merge writes QuickBooks' value into Fishtape (as the system
 * actor) and the dropped edit is never sent later. A push-only record has no pull: it keeps its values,
 * and its next send needs approval again (meta.originRejected).
 */
async function dropHeldEdit(run, link, choice) {
  let rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
  const restored = Boolean(rec?.deleted);
  if (restored) {
    // A held delete is dropped: the record comes back in Fishtape, as QuickBooks still has it.
    await txWrite(run, (tx) => system.restore(tx, run, link.collection, link.record_id));
    rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
    link = { ...link, fishtape_version: rec?.version ?? link.fishtape_version };
  }
  const canonColl = canonCollection(link.collection, link.role);
  const pushOnly = PUSH_ONLY_COLLECTIONS.includes(canonColl);
  const finish = async (tx, fields) => {
    await closeConflict(tx, link.id, 'system', { choice });
    await tx.query('DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, link.collection, link.record_id]);
    return updateLink(tx, run, link.id, fields);
  };
  if (!rec || rec.deleted || pushOnly) {
    const meta = { ...(link.meta || {}), ...(pushOnly && rec && !rec.deleted && !restored ? { originRejected: true } : {}) };
    delete meta.originActor;
    await txWrite(run, (tx) => finish(tx, { state: 'synced', reason: null, meta, fishtape_version: link.fishtape_version }));
    return;
  }
  const obj = await run.client.read(link.qbo_entity, link.qbo_id);
  const ctx = ctxFor(run, link, link.collection);
  const L = fishtapeToCanon(link.collection, rec.data, ctx);
  const R = qboToCanon(link.qbo_entity, obj, { ...ctx, collection: link.collection });
  const B = { ...(link.snapshot || {}) };
  for (const f of fieldsOf(canonColl)) if (!canonEqual(canonColl, f, L[f] ?? null, R[f] ?? null)) B[f] = L[f] ?? null;
  const meta = { ...(link.meta || {}) };
  delete meta.held;
  delete meta.originActor;
  const l = await txWrite(run, (tx) => finish(tx, { state: 'pending', reason: null, snapshot: B, prev_values: {}, owner: link.owner === 'quickbooks' ? 'both' : link.owner, meta }));
  await reconcile(run, l, { record: rec, remote: obj, force: true, direction: 'push' });
}

/**
 * A QuickBooks merge folded two linked Fishtape records into one QuickBooks record (4.2): one of the two
 * is unlinked. When it is the other record, this one moves to the record QuickBooks kept, as an
 * uncontested merge does (pull.js confirmMerge). No Intuit call either way.
 */
async function resolveMerged(run, link, c, recordId, who) {
  if (!recordId) throw validationFailed('recordId is required.');
  const ids = mergedRecordIds(c);
  if (!ids.includes(String(recordId))) throw validationFailed(`recordId must be one of: ${ids.join(', ')}.`);
  await unlinkRecord(run, link.collection, recordId, who);
  const survivor = c.fields?.[0]?.qboId;
  if (String(recordId) === link.record_id || !survivor) return;
  await txWrite(run, async (tx) => {
    await updateLink(tx, run, link.id, { qbo_id: String(survivor), sync_token: null, state: 'synced', reason: null });
    await writeLog(tx, { direction: 'system', outcome: 'ok', action: 'merge', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, message: 'Merged in QuickBooks; now linked to the record that was kept.' });
  });
}

/** Deleted on one side: restore it there, or delete it on the other (5.6). */
async function resolveDeleted(run, link, c, choice) {
  const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
  const reason = c.reason;
  const local = ['has_payments', 'refused', 'paid', 'deposited'].includes(reason); // QuickBooks refused a Fishtape delete or void
  if (choice === 'restore' || choice === 'fishtape') {
    if (local) {
      // Keep it: the Fishtape record stays (it was restored) and its status follows QuickBooks again.
      await txWrite(run, async (tx) => {
        if (link.collection === 'invoices' && rec?.data?.status === 'void') await system.patch(tx, run, 'invoices', link.record_id, { status: 'sent' });
        await closeConflict(tx, link.id, 'system', { choice });
        await updateLink(tx, run, link.id, { state: 'synced', reason: null });
      });
      return;
    }
    // Gone in QuickBooks (deleted or voided there): send it again as a new QuickBooks record.
    if (!rec || rec.deleted) throw new ApiError(409, 'qbo_record_gone', 'The Fishtape record is gone.');
    await txWrite(run, async (tx) => {
      await closeConflict(tx, link.id, 'system', { choice });
      await tx.query('DELETE FROM qbo_links WHERE tenant_id = $1 AND id = $2', [tx.tenantId, link.id]);
    });
    run.index.byRecord.delete(`${link.collection}|main|${link.record_id}`);
    if (link.collection === 'invoices' && ['voided_remote', 'restored_local'].includes(reason) && optionOf2(run, 'numbering') !== 'quickbooks') {
      const { renumber } = await import('./lookup.js');
      await renumber(run, 'invoices', link.record_id);
    }
    await processRecord(run, link.collection, link.record_id, { force: true, actorType: 'user', link: null });
    return;
  }
  // 'delete' / 'quickbooks': remove it on the side that still has it.
  if (local) {
    const obj = await run.client.read(link.qbo_entity, link.qbo_id).catch(() => null);
    await txWrite(run, (tx) => closeConflict(tx, link.id, 'system', { choice }));
    if (!obj) return;
    if (link.collection === 'invoices') { await voidLocalInvoice(run, { ...link, state: 'synced' }, rec, obj, { row: null, label: c.label, deleting: Boolean(rec?.deleted) }); return; }
    await pushDelete(run, null, rec, { ...link, state: 'synced' });
    return;
  }
  await txWrite(run, async (tx) => {
    await closeConflict(tx, link.id, 'system', { choice });
    if (rec && !rec.deleted) {
      if (link.collection === 'invoices') await system.patch(tx, run, 'invoices', link.record_id, { status: 'void' });
      else await system.remove(tx, run, link.collection, link.record_id);
    }
    await updateLink(tx, run, link.id, { state: 'deleted_remote', reason: 'remote_deleted' });
  });
  // A Stripe payment's fee Purchase goes with its payment, whichever side deleted it (4.9).
  if (link.collection === 'payments' && link.role === 'main') {
    const fee = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', link.record_id, 'fee'));
    if (fee?.qbo_id && !['deleted_local', 'deleted_remote', 'unlinked'].includes(fee.state)) await removeLinked(run, fee, 'Stripe fee removed with its payment (deleted in QuickBooks)');
  }
}

const optionOf2 = (run, key) => run.ctx.mappings?.option?.[key];

export { remoteDeleted, str };
