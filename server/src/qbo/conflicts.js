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
  makeRun, txWrite, getLink, getLinkById, updateLink, loadRecord, system, reconcile, tripBrake, BrakeError, PassStop, ctxFor,
  linksByRemote, voidLocalInvoice,
} from './engine.js';
import { processRecord, pushDelete } from './push.js';
import { remoteDeleted } from './pull.js';
import { fishtapeToCanon, qboToCanon, str } from './map/canon.js';
import { canonCollection, fieldsOf, MONEY_RECORD_KEYS } from './map/merge.js';
import { QBO_ENTITY } from './map/to-qbo.js';

const ID = /^\d{1,20}$/;

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
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, fields: row.fields || [],
    resolution: row.resolution || null, resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  };
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
export async function relinkRecord(run, collection, id, qboId, who) {
  if (!ID.test(String(qboId || ''))) throw validationFailed('qboId must be a QuickBooks id.');
  const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, collection, id));
  if (!rec || rec.deleted) throw notFound();
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

// ---- resolve (5.6, 7.7) ------------------------------------------------------------------------------

const CHOICES = {
  fields: ['fishtape', 'quickbooks', 'fields'],
  review: ['fishtape', 'quickbooks', 'unlink', 'link', 'create'],
  deleted: ['restore', 'delete', 'fishtape', 'quickbooks'],
  merged: ['unlink'],
};

/**
 * Resolve a conflict. The caller holds the tenant lease (5.8; API actions wait 10 s for it) and
 * passes its epoch. Writes the audit event qbo.conflict.resolve and a log row.
 * @returns {Promise<object>} the conflict (resolved)
 */
export async function resolveConflict(deps, tenantId, conflictId, { choice, fields = null, recordId = null }, who, { epoch } = {}) {
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'sync' });
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  const c = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conflictId])).rows[0]);
  if (!c) throw notFound();
  if (c.status !== 'open') throw new ApiError(409, 'qbo_conflict_closed', 'This conflict is already resolved.');
  if (!CHOICES[c.kind]?.includes(choice)) throw validationFailed(`Choose one of: ${CHOICES[c.kind].join(', ')}.`);
  const link = await run.db.withTenant({ tenantId }, (tx) => getLinkById(tx, c.link_id));
  if (!link) throw notFound();
  const by = who?.actor ? `${who.actor.type}:${who.actor.id ?? ''}` : 'system';
  const resolution = { choice, ...(fields ? { fields } : {}), ...(recordId ? { recordId } : {}) };
  const close = async (status = 'resolved') => txWrite(run, async (tx) => {
    await closeConflict(tx, link.id, by, resolution, status);
    await appendAudit(tx, tenantId, { actor: who.actor, action: 'qbo.conflict.resolve', collection: link.collection, recordId: link.record_id, summary: `Resolved a QuickBooks ${c.kind} (${choice})`, request: who.request, meta: { conflictId, choice } });
    await writeLog(tx, { direction: 'system', outcome: 'info', action: 'resolve', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label: c.label, message: `Resolved: ${choice}` });
  });
  try {
    if (c.kind === 'fields') await resolveFields(run, link, c, choice, fields);
    else if (c.kind === 'review') await resolveReview(run, link, c, choice, who);
    else if (c.kind === 'deleted') await resolveDeleted(run, link, c, choice);
    else if (c.kind === 'merged') {
      if (!recordId) throw validationFailed('recordId is required.');
      await unlinkRecord(run, link.collection, recordId, who);
    }
  } catch (e) {
    if (e instanceof BrakeError) { await tripBrake(run, e.count); throw new ApiError(409, 'qbo_paused', 'QuickBooks sync paused by the safety brake.'); }
    if (e instanceof PassStop && e.cause) throw e.cause;
    throw e;
  }
  const still = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conflictId])).rows[0]);
  if (still?.status === 'open') await close();
  else await txWrite(run, (tx) => appendAudit(tx, tenantId, { actor: who.actor, action: 'qbo.conflict.resolve', collection: link.collection, recordId: link.record_id, summary: `Resolved a QuickBooks ${c.kind} (${choice})`, request: who.request, meta: { conflictId, choice } }));
  const row = await run.db.withTenant({ tenantId }, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conflictId])).rows[0]);
  return conflictView(row);
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
  const held = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
    'SELECT held FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, link.collection, link.record_id])).rows[0]?.held || {});
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
  const l = await txWrite(run, (tx) => updateLink(tx, run, link.id, { snapshot: B, state: 'pending', prev_values: {} }));
  await reconcile(run, l, { record: fresh, remote: obj, force: true, direction: 'push' });
}

/** Reviews: approve (send), keep QuickBooks' copy, unlink, or for a taken name link or create. */
async function resolveReview(run, link, c, choice, who) {
  const reason = c.reason || link.reason;
  if (choice === 'unlink') { await unlinkRecord(run, link.collection, link.record_id, who); return; }
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
    if (reason === 'filed_period') meta.filedConfirmed = true;
    if (reason === 'payout_items') meta.payoutApproved = true;
    let snapshot = link.snapshot;
    if (link.qbo_id && ['wizard_differs', 'tax_shape', 'tax_inclusive', 'totals_differ'].includes(reason)) {
      // Fishtape's version replaces QuickBooks': the base becomes QuickBooks' copy, so every difference is sent.
      const obj = await run.client.read(link.qbo_entity, link.qbo_id);
      snapshot = { ...qboToCanon(link.qbo_entity, obj, { ...ctxFor(run, link, link.collection), collection: link.collection }), extra: link.snapshot?.extra };
    }
    const l = await txWrite(run, async (tx) => {
      await closeConflict(tx, link.id, 'system', { choice });
      return updateLink(tx, run, link.id, { owner: link.collection === 'stripePayouts' ? 'fishtape' : (['jobs', 'purchaseOrders', 'timeEntries'].includes(link.collection) ? 'fishtape' : 'both'), state: link.qbo_id ? 'pending' : 'pending', reason: null, meta, snapshot });
    });
    if (link.collection === 'stripePayouts') {
      await txWrite(run, (tx) => upsertOutbox(tx, { collection: 'stripePayouts', recordId: link.record_id, op: 'upsert', actorType: 'system', rank: QBO_RANK.stripePayouts, delayS: 0 }));
      return;
    }
    const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, link.collection, link.record_id));
    if (!rec || rec.deleted) return;
    if (l.qbo_id) await reconcile(run, l, { record: rec, force: true, direction: 'push' });
    else await processRecord(run, link.collection, link.record_id, { force: true, link: l, actorType: 'user' });
    return;
  }
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
}

const optionOf2 = (run, key) => run.ctx.mappings?.option?.[key];

export { remoteDeleted, str };
