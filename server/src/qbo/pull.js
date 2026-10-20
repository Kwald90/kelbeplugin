// Pull: QuickBooks changes into Fishtape (docs/integrations/quickbooks.md 5.4). One CDC cursor asks
// for every entity each time, so a lost webhook for one entity is caught by the next pass whatever
// triggered it. Our own writes coming back are dropped by SyncToken (loop prevention, second layer,
// no read needed). TimeActivity is not in CDC: it is read by id for inbox rows and every 6 hours by
// its update time. Webhook-only signals (TimeActivity deletes, merges) are confirmed by a read
// before anything is written. A cursor older than 29 days runs a full reconcile by id.
import { randomUUID } from 'node:crypto';
import { QboError } from './client.js';
import { recordLabel, writeLog } from './log.js';
import {
  txWrite, getLink, linksByRemote, insertLink, updateLink, loadRecord, system, reconcile, ctxFor, checkBrake, countWrite, shadowLog,
  optionOf, moduleRefusal, timeUp, passStopFor, finishOutbox, localToday,
} from './engine.js';
import { qboToCanon, customerFromQbo, isVoidedInvoice, toCents, str } from './map/canon.js';
import { canonToFishtape, settlementCents, settlementRecord, depositRecord, billStatusFromQbo, linkMetaFromQbo } from './map/to-fishtape.js';
import { qboQuote } from './map/names.js';
import { openConflict, openReview } from './conflicts.js';
import { setPaused } from './connection.js';

/** Every CDC call asks for all of these from the one cursor (5.4). */
export const CDC_ENTITIES = ['Customer', 'Vendor', 'Item', 'Estimate', 'Invoice', 'Payment', 'Bill', 'Purchase', 'PurchaseOrder', 'Deposit', 'Transfer'];
const ENTITY_RANK = { Customer: 1, Vendor: 1, Item: 1, Employee: 1, Estimate: 2, Invoice: 3, PurchaseOrder: 3, Payment: 4, Bill: 4, Purchase: 4, Deposit: 4, TimeActivity: 5, Transfer: 6 };
const FULL_AFTER_MS = 29 * 86_400_000;
const TIME_EVERY_MS = 6 * 3_600_000;
const CDC_CAP = 1000;
const ref = (r) => (r && typeof r === 'object' ? str(r.value) : str(r));
const lastUpdated = (o) => o?.MetaData?.LastUpdatedTime || null;
const tenantRead = (run, fn) => run.db.withTenant({ tenantId: run.tenantId }, fn);

/**
 * One pull: CDC from the cursor (or a full reconcile), then inbox rows, then TimeActivity.
 * The cursor moves only when the calls covered the whole window (and never in shadow mode).
 */
export async function runPull(run, { full = false } = {}) {
  const passStart = new Date();
  const conn = await tenantRead(run, async (tx) => (await tx.query('SELECT cdc_cursor, time_cursor, connected_at, dirty_at FROM qbo_connections WHERE tenant_id = $1', [tx.tenantId])).rows[0]);
  if (!conn) return;
  const cursor = conn.cdc_cursor ? new Date(conn.cdc_cursor) : new Date(conn.connected_at || Date.now());
  let newCursor = null;
  if (full || Date.now() - cursor.getTime() > FULL_AFTER_MS) {
    const started = new Date();
    // The cursor moves only when the whole reconcile ran; otherwise the next pass runs it again.
    if (await fullReconcile(run, { since: new Date(cursor.getTime() - 2 * 60_000) })) newCursor = new Date(started.getTime() - 60_000);
  } else {
    let since = new Date(cursor.getTime() - 2 * 60_000);
    let covered = true;
    // Settlement waits for the last page: an invoice and its payment can land on different pages (4.9).
    await withSettlesAfter(run, async () => {
      for (let page = 0; page < 20; page++) {
        const res = await run.client.cdc(CDC_ENTITIES, since);
        const objects = [];
        for (const [entity, list] of Object.entries(res.entities)) for (const o of list) objects.push({ entity, o });
        await processObjects(run, objects);
        if (res.count < CDC_CAP) { newCursor = new Date(Date.parse(res.time || new Date().toISOString()) - 60_000); break; }
        // More than the cap: carry on from the newest object seen (CDC has no end time; 5.4).
        const newest = objects.map((x) => Date.parse(lastUpdated(x.o) || 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
        if (!newest || newest <= since.getTime()) { covered = false; break; }
        since = new Date(newest);
        if (timeUp(run)) { covered = false; break; }
      }
    });
    if (!covered) newCursor = null;
  }
  await processInbox(run);
  await pullTimeActivity(run, conn);
  if (run.shadow) {
    // The cursor stays (going live reads the window again for real), but the pull ran: record when, and
    // clear the webhook's dirty mark, so the dispatcher paces the practice week like a live one (a CDC
    // every 6 hours, a pass per webhook) instead of a full pass every minute.
    await txWrite(run, (tx) => tx.query(
      `UPDATE qbo_connections SET last_pull_at = now(), dirty_at = CASE WHEN dirty_at IS NOT NULL AND dirty_at <= $2 THEN NULL ELSE dirty_at END, updated_at = now()
        WHERE tenant_id = $1`, [run.tenantId, passStart]));
    return;
  }
  await txWrite(run, (tx) => tx.query(
    `UPDATE qbo_connections SET cdc_cursor = COALESCE($2, cdc_cursor), last_pull_at = now(),
        dirty_at = CASE WHEN dirty_at IS NOT NULL AND dirty_at <= $3 THEN NULL ELSE dirty_at END, updated_at = now()
      WHERE tenant_id = $1`, [run.tenantId, newCursor, passStart]));
}

/** One object's failure is logged and never stops the pull; pass-ending errors go up (5.8). */
async function pullError(run, entity, e) {
  const stop = passStopFor(e);
  if (stop) throw stop;
  if (e?.name === 'BrakeError' || e?.name === 'FencedError' || e?.name === 'PassStop') throw e;
  run.stats.errors++;
  await tenantRead(run, (tx) => writeLog(tx, { direction: 'pull', outcome: 'error', action: 'pull', qboEntity: entity, message: e instanceof QboError ? e.message : 'Could not apply a QuickBooks change.', errorCode: e instanceof QboError ? e.kind : 'internal', intuitTid: e?.intuitTid || null })).catch(() => {});
}

/**
 * Run fn with invoice settlement held back to its end (4.9): a QuickBooks payment and the invoice it
 * paid arrive together, and the invoice (rank 3) comes before the payment (rank 4). Settling at once
 * would count the payment as a settlement before its own Fishtape payment exists, and count it twice.
 */
async function withSettlesAfter(run, fn) {
  if (run.settleLater) return fn();
  run.settleLater = new Map();
  let ok = false;
  try {
    const r = await fn();
    ok = true;
    return r;
  } finally {
    const later = run.settleLater;
    run.settleLater = null;
    if (ok) {
      for (const { inv, o } of later.values()) {
        try { await pullDeposit(run, inv, o); await settle(run, inv, o); } catch (e) { await pullError(run, 'Invoice', e); }
      }
    }
  }
}

/** Settle a pulled invoice now, or at the end of the batch it came in (withSettlesAfter). */
async function settleInvoice(run, inv, o) {
  if (run.settleLater) { run.settleLater.set(inv.id, { inv, o }); return; }
  await pullDeposit(run, inv, o);
  await settle(run, inv, o);
}

/** By entity rank, then QuickBooks update time (5.4 step 5). */
async function processObjects(run, objects) {
  objects.sort((a, b) => (ENTITY_RANK[a.entity] || 9) - (ENTITY_RANK[b.entity] || 9) || Date.parse(lastUpdated(a.o) || 0) - Date.parse(lastUpdated(b.o) || 0));
  await withSettlesAfter(run, async () => {
    for (const { entity, o } of objects) {
      if (timeUp(run)) return;
      try {
        await processRemote(run, entity, o);
      } catch (e) {
        await pullError(run, entity, e);
      }
    }
  });
}

/** One QuickBooks object from CDC, a read or the inbox. */
export async function processRemote(run, entity, o) {
  if (entity === 'Customer' && o.ParentRef) run.index.parents.set(String(o.Id), ref(o.ParentRef));
  if (entity === 'Deposit') return;
  const links = await tenantRead(run, (tx) => linksByRemote(tx, entity, o.Id));
  if (o.status === 'Deleted') {
    for (const l of links) await remoteDeleted(run, l, {});
    return;
  }
  const mains = links.filter((l) => l.role === 'main' || l.role === 'fee');
  if (!mains.length && !links.length) return pullCreate(run, entity, o);
  // A voided payment is a delete for every Fishtape payment on it (4.9).
  if (entity === 'Payment' && toCents(o.TotalAmt) === 0 && (o.Line || []).every((l) => !toCents(l.Amount)) && /^Voided/i.test(String(o.PrivateNote || ''))) {
    for (const l of mains) await remoteDeleted(run, l, {});
    return;
  }
  for (const l of mains) {
    if (['unlinked', 'deleted_local'].includes(l.state)) continue;
    if (l.sync_token != null && String(o.SyncToken) === String(l.sync_token)) continue; // our own write coming back
    if (l.collection === 'jobs' && o.Active === false) { await remoteDeleted(run, l, {}); continue; }
    await reconcile(run, l, { remote: o, direction: 'pull' });
  }
  if (entity === 'Invoice') {
    const inv = mains.find((l) => l.collection === 'invoices');
    if (inv) await settleInvoice(run, inv, o);
  }
  if (entity === 'Payment') await pullPaymentLines(run, o, links);
  if (entity === 'Bill') {
    const b = mains.find((l) => l.collection === 'bills');
    if (b) await billStatus(run, b, o);
  }
}

// ---- deletes from QuickBooks --------------------------------------------------------------------

/**
 * The object is gone in QuickBooks (deleted, or not found when read). Section 4 per collection:
 * names and push-only objects become deleted_remote; an estimate pulled from QuickBooks is deleted in
 * Fishtape unless it changed here; an invoice is voided with a note; a payment Fishtape made (or
 * one from Stripe) opens a conflict instead of disappearing.
 */
export async function remoteDeleted(run, link, { record = null, row = null } = {}) {
  if (['deleted_local', 'unlinked', 'deleted_remote'].includes(link.state)) return;
  const rec = record || await tenantRead(run, (tx) => loadRecord(tx, link.collection, link.record_id));
  const label = recordLabel(link.collection, rec?.data || { id: link.record_id });
  if (run.shadow) { await shadowLog(run, { direction: 'pull', action: 'pull_delete', collection: link.collection, recordId: link.record_id, label, message: 'Would mark removed in QuickBooks' }); return; }
  const changedHere = rec && link.fishtape_version != null && Number(rec.version) !== Number(link.fishtape_version);
  const pushedByUs = Boolean(link.meta?.createRequestId);
  await txWrite(run, async (tx) => {
    const gone = (state = 'deleted_remote') => updateLink(tx, run, link.id, { state, reason: 'remote_deleted' });
    const log = (message) => writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'pull_delete', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message });
    const conflict = async (message) => {
      await updateLink(tx, run, link.id, { state: 'conflict' });
      await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'remote_deleted', fields: [{ field: 'status', label: 'Status', base: 'Exists', fishtape: 'Still here', quickbooks: message }] });
      await writeLog(tx, { direction: 'pull', outcome: 'conflict', action: 'pull_delete', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message });
      run.stats.conflicts++;
    };
    if (!rec || rec.deleted) { await gone(); await finishOutbox(tx, run, row); return; }
    switch (link.role === 'main' ? link.collection : 'other') {
      case 'estimates':
      case 'bills':
        if (changedHere || pushedByUs) await conflict(`Deleted in QuickBooks on ${localToday(run)}. Delete it here, or create it again in QuickBooks?`);
        else { checkBrake(run); await system.remove(tx, run, link.collection, link.record_id); countWrite(run); await gone(); await log('Deleted in QuickBooks'); }
        break;
      case 'invoices': {
        checkBrake(run);
        const note = `Deleted in QuickBooks on ${localToday(run)}`;
        const notes = [str(rec.data.notes), note].filter(Boolean).join('\n');
        await system.patch(tx, run, 'invoices', link.record_id, { status: 'void', notes });
        countWrite(run);
        await gone();
        await log(note);
        break;
      }
      case 'payments':
        if (rec.data.source === 'stripe' || pushedByUs) {
          await conflict(`Removed in QuickBooks: ${localToday(run)}.${rec.data.source === 'stripe' ? ' The money was received in Stripe.' : ''} Keep it in Fishtape and send it again, or delete it here?`);
        } else {
          checkBrake(run);
          await system.remove(tx, run, 'payments', link.record_id);
          countWrite(run);
          await gone();
          if (rec.data.invoiceId) await system.refreshInvoice(tx, run, rec.data.invoiceId);
          await log('Deleted in QuickBooks');
        }
        break;
      default:
        await gone();
        await writeLog(tx, { direction: 'pull', outcome: 'warning', action: 'pull_delete', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: link.collection === 'timeEntries' ? 'Deleted in QuickBooks; send it again from the record if needed.' : 'Removed or made inactive in QuickBooks; the Fishtape record is kept.' });
    }
    await finishOutbox(tx, run, row);
  });
}

// ---- creating Fishtape records from QuickBooks (4.1) ------------------------------------------------

/**
 * A new record id for a pulled record. Never derived from a QuickBooks id: QBO ids stay out of
 * Fishtape records (3.1). The record and its link are written in one transaction, so a retried pull
 * finds the link and never makes a second record.
 */
export const pulledId = () => randomUUID();

/**
 * Create a Fishtape record and its link from a QuickBooks object (pull, the wizard, an import).
 * Returns { collection, id, state } or null when the object does not come into Fishtape.
 */
export async function createFromRemote(run, collection, entity, o, { owner = 'both', reviewReason = null, force = false, extra = {} } = {}) {
  const existing = await tenantRead(run, (tx) => linksByRemote(tx, entity, o.Id));
  const mine = existing.find((l) => l.collection === collection && l.role === 'main');
  if (mine) return { collection, id: mine.record_id, state: mine.state };
  const ctx = ctxFor(run, null, collection);
  const R = qboToCanon(entity, o, { ...ctx, collection });
  const report = {};
  const body = { ...canonToFishtape(collection, R, ctx, { existing: null, report }), ...extra };
  const id = pulledId();
  if (collection === 'clients' && o.CompanyName == null) body.type = body.type || 'residential';
  if (collection === 'invoices' && isVoidedInvoice(o)) body.status = 'void';
  if (collection === 'bills') { body.status = billStatusFromQbo(o, 'open') || 'open'; if (body.kind === 'receipt') body.status = 'paid'; }
  if (collection === 'estimates' && !body.status) body.status = 'sent';
  let state = 'synced';
  let reason = reviewReason;
  if (report.taxInclusive && ['estimates', 'invoices'].includes(collection)) { state = 'needs_review'; owner = 'quickbooks'; reason = 'tax_inclusive'; }
  else if (report.taxShape && ['estimates', 'invoices'].includes(collection)) { state = 'needs_review'; owner = 'quickbooks'; reason = 'tax_shape'; }
  else if (R.extra?.taxInclusive && collection === 'bills') owner = 'quickbooks';
  else if (reviewReason) state = 'needs_review';
  const label = recordLabel(collection, { ...body, id });
  if (run.shadow) {
    await shadowLog(run, { direction: 'pull', action: 'pull_create', collection, recordId: id, qboEntity: entity, label, message: `Would create a Fishtape ${collection} record` });
    return { collection, id, state: 'shadow' };
  }
  const created = await txWrite(run, async (tx) => {
    const again = (await linksByRemote(tx, entity, o.Id)).find((l) => l.collection === collection && l.role === 'main');
    if (again) return { link: again, version: again.fishtape_version, existed: true };
    checkBrake(run);
    let version;
    try {
      const rec = await loadRecord(tx, collection, id);
      if (rec && !rec.deleted) version = rec.version;
      else if (rec?.deleted) version = (await system.restore(tx, run, collection, id)).version;
      else version = (await system.create(tx, run, collection, { ...body, id })).version;
    } catch (e) {
      const why = moduleRefusal(e);
      if (!why) throw e;
      await writeLog(tx, { direction: 'pull', outcome: 'skipped', action: 'pull_create', collection, recordId: id, qboEntity: entity, label, message: why === 'plan' ? 'Not in your plan.' : 'That module is turned off.', errorCode: 'module_off' });
      return null;
    }
    countWrite(run);
    const meta = { ...linkMetaFromQbo(entity, o, ctx), ...(o.CustomerRef ? { customerRef: ref(o.CustomerRef) } : {}) };
    const link = await insertLink(tx, run, {
      collection, record_id: id, role: 'main', qbo_entity: entity, qbo_id: String(o.Id), sync_token: String(o.SyncToken), qbo_updated_at: lastUpdated(o),
      fishtape_version: version, state, owner, snapshot: { ...R }, meta, reason,
    });
    if (state === 'needs_review') {
      const text = { tax_inclusive: 'Tax-inclusive in QuickBooks; Fishtape shows its total without the tax split.', tax_shape: 'QuickBooks uses tax codes Fishtape cannot show exactly on this document.' }[reason] || 'Check this record against QuickBooks.';
      await openReview(tx, run, link, { reason, label, message: text });
    }
    if (collection === 'invoices' && body.number) await raiseNextNumber(tx, run, 'invoice', body.number);
    if (collection === 'estimates' && body.number) await raiseNextNumber(tx, run, 'estimate', body.number);
    run.stats.pulled++;
    await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'pull_create', collection, recordId: id, qboEntity: entity, label, message: 'Created from QuickBooks' });
    return { link, version };
  });
  if (!created) return null;
  if (created.existed) return { collection, id: created.link.record_id, state: created.link.state, link: created.link };
  return { collection, id, state, link: created.link };
}

/**
 * After a pull, a Fishtape-style number at or above the next number raises it (4.7), with a system
 * patch that keeps the settings record's updatedAt so an offline settings edit still wins.
 */
async function raiseNextNumber(tx, run, kind, number) {
  const prefix = { invoice: 'INV', estimate: 'E' }[kind];
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(number || ''));
  if (!m) return;
  const n = Number(m[1]);
  const s = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0]?.data;
  if (!s) return;
  const cur = Number(s.nextNumbers?.[kind]) || 0;
  if (n < cur) return;
  await system.patch(tx, run, 'settings', 'settings', { nextNumbers: { ...(s.nextNumbers || {}), [kind]: n + 1 }, updatedAt: s.updatedAt });
}

/** A client for a QuickBooks customer a pulled document needs (created on demand, 13.14). */
async function ensureCustomer(run, qboCustomerId) {
  if (!qboCustomerId) return null;
  const c = customerFromQbo(run.ctx, qboCustomerId);
  if (c.jobRef) return { jobId: run.ctx.refs.fishtapeIdFor('jobs', c.jobRef) };
  const clientId = c.clientRef ? run.ctx.refs.fishtapeIdFor('clients', c.clientRef) : null;
  if (clientId) return { clientId };
  let customer = null;
  try { customer = await run.client.read('Customer', c.clientRef || qboCustomerId); } catch (e) { if (!(e instanceof QboError && e.kind === 'not_found')) throw e; }
  if (!customer) return null;
  if (customer.ParentRef) {
    run.index.parents.set(String(customer.Id), ref(customer.ParentRef));
    return ensureCustomer(run, ref(customer.ParentRef));
  }
  const made = await createFromRemote(run, 'clients', 'Customer', customer);
  return made ? { clientId: made.id } : null;
}

const inScope = (run, date, open) => {
  const syncFrom = str(optionOf(run.ctx.mappings, 'syncFrom', null));
  return open || !syncFrom || (date && date >= syncFrom);
};

const MARKER_RE = /Fishtape ref ([0-9a-f]{12})/;

/**
 * An unlinked object may be one of our own creates whose answer never arrived (a crash or a timeout
 * before the link was written, 5.3): its marker, or for names the exact name of a pending create,
 * points at the pending link. It is adopted there, never created a second time in Fishtape.
 */
async function adoptFromPull(run, entity, o) {
  const text = [o.PrivateNote, o.Description, o.Memo].filter(Boolean).join(' ');
  const m = MARKER_RE.exec(text);
  const pendingLink = await tenantRead(run, async (tx) => {
    if (m) {
      return (await tx.query("SELECT * FROM qbo_links WHERE tenant_id = $1 AND qbo_id IS NULL AND qbo_entity = $2 AND meta->>'marker' = $3", [tx.tenantId, entity, m[0]])).rows[0] || null;
    }
    if (!['Customer', 'Vendor', 'Item'].includes(entity)) return null;
    const { rows } = await tx.query("SELECT * FROM qbo_links WHERE tenant_id = $1 AND qbo_id IS NULL AND qbo_entity = $2 AND state = 'pending' AND meta ? 'sent'", [tx.tenantId, entity]);
    for (const l of rows) {
      const rec = await loadRecord(tx, l.collection, l.record_id);
      const name = l.meta?.sendName || rec?.data?.name || (l.collection === 'jobs' ? [rec?.data?.number, rec?.data?.title].filter(Boolean).join(' ') : null);
      if (name && String(name).trim().toLowerCase() === String(o.DisplayName || o.Name || '').trim().toLowerCase()) return l;
    }
    return null;
  });
  if (!pendingLink) return false;
  if (run.shadow) return true;
  const l = await txWrite(run, (tx) => updateLink(tx, run, pendingLink.id, {
    qbo_id: String(o.Id), sync_token: null, qbo_updated_at: lastUpdated(o), snapshot: null, meta: { ...(pendingLink.meta || {}), sent: undefined },
  }));
  await txWrite(run, (tx) => writeLog(tx, { direction: 'pull', outcome: 'info', action: 'adopt', collection: l.collection, recordId: l.record_id, qboEntity: entity, message: 'Found our own earlier send in QuickBooks; linked it.' }));
  await reconcile(run, l, { remote: o, direction: 'push' });
  return true;
}

/** A QuickBooks object with no link: the creation rules of 4.1. */
async function pullCreate(run, entity, o) {
  if (await adoptFromPull(run, entity, o)) return null;
  const opt = (k, d) => optionOf(run.ctx.mappings, k, d);
  switch (entity) {
    case 'Customer':
      if (o.Active === false || o.Job === true || o.ParentRef) return null;
      if (opt('importCustomers', 'active') !== 'all') return null; // created when a document needs it (13.14)
      return createFromRemote(run, 'clients', 'Customer', o);
    case 'Vendor':
      if (o.Active === false || String(o.Id) === String(opt('stripeVendorId', ''))) return null;
      return createFromRemote(run, 'vendors', 'Vendor', o);
    case 'Item': {
      if (o.Active === false || !['Service', 'NonInventory', 'Inventory'].includes(o.Type)) return null;
      if (Object.values(run.ctx.mappings.item || {}).map(String).includes(String(o.Id))) return null; // generic items stay QuickBooks-only
      return createFromRemote(run, 'items', 'Item', o);
    }
    case 'Estimate':
    case 'Invoice': {
      const inv = entity === 'Invoice';
      const open = inv ? toCents(o.Balance) > 0 : ['Pending', 'Accepted'].includes(o.TxnStatus);
      if (!inScope(run, o.TxnDate, open)) return null;
      if (inv && isVoidedInvoice(o)) return null;
      const who = await ensureCustomer(run, ref(o.CustomerRef));
      if (!who) return null;
      const made = await createFromRemote(run, inv ? 'invoices' : 'estimates', entity, o);
      if (made && inv) {
        const link = made.link || await tenantRead(run, (tx) => getLink(tx, 'invoices', made.id));
        if (link) await settleInvoice(run, link, o);
      }
      return made;
    }
    case 'Payment':
      return pullPaymentLines(run, o, []);
    case 'Bill':
    case 'Purchase': {
      if (opt('pullJobCosts', true) === false) return null;
      if (!inScope(run, o.TxnDate, false)) return null;
      const lines = o.Line || [];
      const tagged = lines.some((l) => {
        const d = l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || {};
        const c = ref(d.CustomerRef);
        if (!c) return false;
        const r = customerFromQbo(run.ctx, c);
        return Boolean((r.jobRef && run.ctx.refs.fishtapeIdFor('jobs', r.jobRef)) || (r.clientRef && run.ctx.refs.fishtapeIdFor('clients', r.clientRef)));
      });
      if (!tagged) return null;
      const vendor = ref(o.VendorRef || o.EntityRef);
      if (vendor && !run.ctx.refs.fishtapeIdFor('vendors', vendor)) {
        try { const v = await run.client.read('Vendor', vendor); if (v) await createFromRemote(run, 'vendors', 'Vendor', v); } catch (e) { if (!(e instanceof QboError && e.kind === 'not_found')) throw e; }
      }
      return createFromRemote(run, 'bills', entity, o);
    }
    default:
      return null;
  }
}

// ---- payments (4.9) ---------------------------------------------------------------------------------

/**
 * A QuickBooks payment applied to linked invoices becomes one Fishtape payment per invoice line.
 * A line that left an invoice opens a conflict for payments Fishtape made, and deletes a pulled one.
 */
async function pullPaymentLines(run, o, links) {
  // A $0 payment only applies credit memos or journals to invoices: no money came in, so it is not
  // a Fishtape payment; the invoice's settlement payment shows it (4.9).
  if (toCents(o.TotalAmt) === 0) return null;
  const lines = (o.Line || []).map((l) => ({ amount: toCents(l.Amount), inv: str((l.LinkedTxn || []).find((t) => t.TxnType === 'Invoice')?.TxnId) })).filter((x) => x.inv && x.amount);
  const syncFrom = str(optionOf(run.ctx.mappings, 'syncFrom', null));
  for (const line of lines) {
    const invoiceId = run.ctx.refs.fishtapeIdFor('invoices', line.inv);
    if (!invoiceId) continue;
    if (links.some((l) => l.collection === 'payments' && l.role === 'main' && l.qbo_line === line.inv)) continue;
    // A line moved here from another invoice is a change of the existing payment, not a new one.
    if (links.some((l) => l.collection === 'payments' && l.role === 'main' && !lines.some((x) => x.inv === l.qbo_line))) continue;
    if (syncFrom && o.TxnDate && o.TxnDate < syncFrom) {
      const inv = await tenantRead(run, (tx) => loadRecord(tx, 'invoices', invoiceId));
      if (!inv || !['sent', 'partial'].includes(inv.data.status)) continue;
    }
    const ctx = ctxFor(run, { role: 'main', qbo_line: line.inv, meta: {} }, 'payments');
    const R = qboToCanon('Payment', o, { ...ctx, collection: 'payments' });
    const body = canonToFishtape('payments', R, ctx, { existing: null });
    const id = pulledId();
    if (run.shadow) { await shadowLog(run, { direction: 'pull', action: 'pull_create', collection: 'payments', recordId: id, qboEntity: 'Payment', message: 'Would create a Fishtape payment' }); continue; }
    await txWrite(run, async (tx) => {
      if ((await linksByRemote(tx, 'Payment', o.Id)).some((l) => l.collection === 'payments' && l.role === 'main' && l.qbo_line === line.inv)) return;
      checkBrake(run);
      const version = (await system.create(tx, run, 'payments', { ...body, invoiceId, id })).version;
      countWrite(run);
      await insertLink(tx, run, {
        collection: 'payments', record_id: id, role: 'main', qbo_entity: 'Payment', qbo_id: String(o.Id), qbo_line: line.inv, sync_token: String(o.SyncToken),
        qbo_updated_at: lastUpdated(o), fishtape_version: version, state: 'synced', snapshot: R, meta: linkMetaFromQbo('Payment', o, ctx),
      });
      await system.refreshInvoice(tx, run, invoiceId);
      run.stats.pulled++;
      await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'pull_create', collection: 'payments', recordId: id, qboEntity: 'Payment', label: recordLabel('payments', body), message: 'Created from QuickBooks' });
    });
  }
  return null;
}

/** A pulled invoice's Deposit field as its own Fishtape payment (link role deposit, 4.7). */
async function pullDeposit(run, invLink, o) {
  const rec = depositRecord(o, invLink.record_id);
  if (!rec || run.shadow) return;
  const id = `deposit-${invLink.record_id}`.slice(0, 128);
  await txWrite(run, async (tx) => {
    if (await getLink(tx, 'payments', id, 'deposit')) return;
    const existing = await loadRecord(tx, 'payments', id);
    const version = existing ? existing.version : (await system.create(tx, run, 'payments', { ...rec, id })).version;
    await insertLink(tx, run, { collection: 'payments', record_id: id, role: 'deposit', qbo_entity: 'Invoice', qbo_id: String(o.Id), qbo_line: 'deposit', sync_token: String(o.SyncToken), fishtape_version: version, state: 'synced', owner: 'quickbooks', snapshot: { amountCents: rec.amountCents } });
    await system.refreshInvoice(tx, run, invLink.record_id);
    await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'pull_create', collection: 'payments', recordId: id, qboEntity: 'Invoice', message: 'Deposit in QuickBooks' });
  });
}

/**
 * Settlement in QuickBooks (4.9): what credit memos, journals or payments Fishtape does not have
 * paid on the invoice becomes one pull-only Fishtape payment (method credit), kept in step.
 */
export async function settle(run, invLink, o) {
  if (!invLink || invLink.role !== 'main' || run.shadow) return;
  await txWrite(run, async (tx) => {
    const { rows } = await tx.query(
      `SELECT state, snapshot FROM qbo_links WHERE tenant_id = $1 AND collection = 'payments' AND role = 'main' AND qbo_entity = 'Payment' AND qbo_line = $2 AND state NOT IN ('unlinked', 'deleted_local', 'deleted_remote')`,
      [tx.tenantId, String(o.Id)]);
    if (rows.some((r) => r.state === 'pending')) return;
    const linked = rows.map((r) => Number(r.snapshot?.amountCents) || 0);
    const cents = isVoidedInvoice(o) ? 0 : settlementCents(o, linked);
    const id = `credit-${invLink.record_id}`.slice(0, 128);
    const link = await getLink(tx, 'invoices', id, 'settlement');
    const rec = await loadRecord(tx, 'payments', id);
    if (cents > 0) {
      const body = settlementRecord({ invoiceId: invLink.record_id, cents, date: localToday(run) });
      if (!rec) await system.create(tx, run, 'payments', { ...body, id });
      else if (rec.deleted) { await system.restore(tx, run, 'payments', id); await system.patch(tx, run, 'payments', id, { amountCents: cents }); }
      else if (rec.data.amountCents !== cents) await system.patch(tx, run, 'payments', id, { amountCents: cents });
      else if (link) return;
      if (!link) await insertLink(tx, run, { collection: 'invoices', record_id: id, role: 'settlement', qbo_entity: 'Invoice', qbo_id: String(o.Id), qbo_line: 'settlement', state: 'synced', owner: 'quickbooks', snapshot: { amountCents: cents } });
      else await updateLink(tx, run, link.id, { snapshot: { amountCents: cents }, state: 'synced' });
      await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'settlement', collection: 'payments', recordId: id, qboEntity: 'Invoice', message: `Credited or paid in QuickBooks: $${(cents / 100).toFixed(2)}` });
    } else if (rec && !rec.deleted) {
      await system.remove(tx, run, 'payments', id);
      if (link) await tx.query('DELETE FROM qbo_links WHERE tenant_id = $1 AND id = $2', [tx.tenantId, link.id]);
      await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'settlement', collection: 'payments', recordId: id, qboEntity: 'Invoice', message: 'No longer settled in QuickBooks' });
    } else return;
    await system.refreshInvoice(tx, run, invLink.record_id);
  });
}

/** A pulled Bill's paid status: Balance 0 is paid, a later balance open again (4.10). */
async function billStatus(run, link, o) {
  if (run.shadow) return;
  await txWrite(run, async (tx) => {
    const rec = await loadRecord(tx, 'bills', link.record_id);
    if (!rec || rec.deleted || rec.data.kind === 'receipt') return;
    const status = billStatusFromQbo(o, rec.data.status);
    if (!status) return;
    const v = await system.patch(tx, run, 'bills', link.record_id, { status });
    await updateLink(tx, run, link.id, { fishtape_version: v.version });
  });
}

// ---- inbox: TimeActivity and merges (5.4 steps 3, 4) --------------------------------------------------

async function processInbox(run) {
  const rows = await tenantRead(run, async (tx) => (await tx.query(
    `SELECT * FROM qbo_inbox WHERE tenant_id = $1 AND processed_at IS NULL AND realm_hash = $2 ORDER BY event_time LIMIT 200`, [tx.tenantId, run.conn.realm_hash])).rows);
  if (!rows.length) return;
  const done = async (r, ok, why = null) => {
    if (run.shadow) return;
    await txWrite(run, async (tx) => {
      if (ok || r.attempts + 1 >= 5) {
        await tx.query('UPDATE qbo_inbox SET processed_at = now(), attempts = attempts + $4 WHERE tenant_id = $1 AND entity = $2 AND qbo_id = $3', [tx.tenantId, r.entity, r.qbo_id, ok ? 0 : 1]);
        if (!ok) {
          for (const l of await linksByRemote(tx, r.entity, r.qbo_id)) await updateLink(tx, run, l.id, { state: 'error', reason: 'inbox', last_error: 'A QuickBooks change could not be applied.' });
          await writeLog(tx, { direction: 'pull', outcome: 'error', action: 'inbox', qboEntity: r.entity, message: `A QuickBooks change could not be applied after 5 tries${why ? `: ${why}` : ''}.` });
        }
      } else {
        await tx.query('UPDATE qbo_inbox SET attempts = attempts + 1 WHERE tenant_id = $1 AND entity = $2 AND qbo_id = $3', [tx.tenantId, r.entity, r.qbo_id]);
      }
    });
  };
  const times = rows.filter((r) => r.entity === 'TimeActivity');
  if (times.length) {
    let found = [];
    try {
      found = await run.client.query(`select * from TimeActivity where Id in (${times.map((r) => `'${qboQuote(r.qbo_id)}'`).join(', ')})`, { max: 1000 });
    } catch (e) {
      if (passStopFor(e)) throw passStopFor(e);
      for (const r of times) await done(r, false, e.message);
      found = null;
    }
    if (found) {
      const byId = new Map(found.map((x) => [String(x.Id), x]));
      for (const r of times) {
        try {
          const obj = byId.get(String(r.qbo_id));
          // A delete is acted on only once the read confirms it (5.4 step 3).
          if (obj) await processRemote(run, 'TimeActivity', obj);
          else for (const l of await tenantRead(run, (tx) => linksByRemote(tx, 'TimeActivity', r.qbo_id))) await remoteDeleted(run, l, {});
          await done(r, true);
        } catch (e) {
          if (passStopFor(e)) throw passStopFor(e);
          await done(r, false, e.message);
        }
      }
    }
  }
  for (const r of rows.filter((x) => x.op === 'merged' && x.entity !== 'TimeActivity')) {
    try { await confirmMerge(run, r); await done(r, true); } catch (e) {
      if (passStopFor(e)) throw passStopFor(e);
      await done(r, false, e.message);
    }
  }
  for (const r of rows.filter((x) => x.op !== 'merged' && x.entity !== 'TimeActivity')) await done(r, true);
}

/**
 * A QuickBooks merge (4.2): confirmed by reading both ids (the folded one gone or inactive, the
 * survivor there), then the link moves to the survivor; a survivor already linked opens a conflict.
 */
async function confirmMerge(run, r) {
  if (!r.deleted_id) return;
  const read = async (id) => { try { return await run.client.read(r.entity, id); } catch (e) { if (e instanceof QboError && e.kind === 'not_found') return null; throw e; } };
  const folded = await read(r.deleted_id);
  const survivor = await read(r.qbo_id);
  if ((folded && folded.Active !== false) || !survivor) return;
  if (run.shadow) return;
  await txWrite(run, async (tx) => {
    const from = (await linksByRemote(tx, r.entity, r.deleted_id)).filter((l) => l.role === 'main');
    const into = (await linksByRemote(tx, r.entity, r.qbo_id)).filter((l) => l.role === 'main');
    for (const l of from) {
      const other = into.find((x) => x.collection === l.collection);
      if (other) {
        // recordIds: both Fishtape records, so the office can pick which one to unlink (7.7);
        // qboId: the record QuickBooks kept, which this link moves to if the other one is unlinked.
        await updateLink(tx, run, l.id, { state: 'conflict' });
        await openConflict(tx, run, l, { kind: 'merged', label: recordLabel(l.collection, { id: l.record_id }), reason: 'merged', fields: [{ field: 'name', label: 'Merged', base: '', fishtape: 'Two records', quickbooks: 'These two were merged in QuickBooks; merge them in Fishtape or unlink one.', recordIds: [l.record_id, other.record_id], qboId: String(survivor.Id) }] });
        continue;
      }
      await updateLink(tx, run, l.id, { qbo_id: String(survivor.Id), sync_token: null, snapshot: l.snapshot });
      await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'merge', collection: l.collection, recordId: l.record_id, qboEntity: r.entity, message: 'Merged in QuickBooks; now linked to the record that was kept.' });
    }
  });
}

/** TimeActivity changed in QuickBooks (not in CDC), every 6 hours (5.4 step 3). */
async function pullTimeActivity(run, conn) {
  const last = conn.time_cursor ? new Date(conn.time_cursor) : null;
  if (last && Date.now() - last.getTime() < TIME_EVERY_MS) return;
  const since = last || new Date(Date.now() - TIME_EVERY_MS);
  const started = new Date();
  const list = await run.client.query(`select * from TimeActivity where MetaData.LastUpdatedTime > '${since.toISOString()}'`, { all: true, max: 5000 });
  for (const o of list) {
    if (timeUp(run)) return;
    const links = await tenantRead(run, (tx) => linksByRemote(tx, 'TimeActivity', o.Id));
    if (links.length) await processRemote(run, 'TimeActivity', o);
  }
  if (!run.shadow) await txWrite(run, (tx) => tx.query('UPDATE qbo_connections SET time_cursor = $2 WHERE tenant_id = $1', [run.tenantId, started]));
}

// ---- full reconcile (5.4 step 1) ----------------------------------------------------------------------

/**
 * A cursor older than 29 days (CDC reaches back 30): each entity is queried page by page for what
 * changed since the old cursor, created objects included, and handled as a CDC batch would be; then
 * every linked object not seen is read by id, and a missing one was deleted (5.4 step 1). Returns true
 * when it ran to the end.
 */
export async function fullReconcile(run, { since = null } = {}) {
  return withSettlesAfter(run, () => fullReconcileRun(run, since));
}

async function fullReconcileRun(run, since) {
  const seen = new Set();
  if (since) {
    const entities = CDC_ENTITIES.filter((e) => !['Deposit', 'Transfer'].includes(e)).sort((a, b) => (ENTITY_RANK[a] || 9) - (ENTITY_RANK[b] || 9));
    for (const entity of entities) {
      if (timeUp(run)) return false;
      let list;
      try {
        list = await run.client.query(`select * from ${entity} where MetaData.LastUpdatedTime >= '${since.toISOString()}'`, { all: true, max: 50_000 });
      } catch (e) {
        if (e instanceof QboError && e.kind === 'feature') continue; // not in this edition (5030)
        throw passStopFor(e) || e;
      }
      for (const o of list) seen.add(`${entity}|${o.Id}`);
      await processObjects(run, list.map((o) => ({ entity, o })));
    }
  }
  const links = await tenantRead(run, async (tx) => (await tx.query(
    "SELECT * FROM qbo_links WHERE tenant_id = $1 AND realm_hash = $2 AND qbo_id IS NOT NULL AND state NOT IN ('unlinked', 'deleted_local', 'deleted_remote') AND role IN ('main', 'fee')",
    [tx.tenantId, run.conn.realm_hash])).rows);
  const byEntity = new Map();
  for (const l of links) (byEntity.get(l.qbo_entity) || byEntity.set(l.qbo_entity, new Set()).get(l.qbo_entity)).add(String(l.qbo_id));
  const order = [...byEntity.keys()].sort((a, b) => (ENTITY_RANK[a] || 9) - (ENTITY_RANK[b] || 9));
  for (const entity of order) {
    const ids = [...byEntity.get(entity)];
    for (let i = 0; i < ids.length; i += 50) {
      if (timeUp(run)) return false;
      const chunk = ids.slice(i, i + 50).filter((id) => !seen.has(`${entity}|${id}`));
      if (!chunk.length) continue;
      const found = await run.client.query(`select * from ${entity} where Id in (${chunk.map((x) => `'${x}'`).join(', ')})`, { max: 1000 });
      const byId = new Map(found.map((o) => [String(o.Id), o]));
      for (const id of chunk) {
        const o = byId.get(id);
        if (o) await processRemote(run, entity, o);
        else for (const l of links.filter((x) => x.qbo_entity === entity && String(x.qbo_id) === id)) await remoteDeleted(run, l, {});
      }
    }
  }
  return !timeUp(run);
}

export { setPaused };
