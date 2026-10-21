// Push: the outbox, worked by the qbo_sync pass (docs/integrations/quickbooks.md 5.3). Rows are
// claimed 50 at a time by rank (dependencies first) and deleted only in the transaction that records
// the link outcome, while the claim stands. For each record: eligibility (4.1), the origin rule
// (5.2), the holds (4.7, 4.8, 4.11), dependencies (pushed first in the same pass), then either the
// create protocol or the three-way reconcile.
//
// Create protocol (5.3): the link is committed as `pending` with a marker and a stable request id
// before the create is sent. An answer that never came, or a later pass finding such a link without
// a QBO id (a crash), is resolved by adopt-by-search before any retry, so a retried create never
// makes a second object.
import { lineCents } from '../../../electrical-app/js/lib/money.js';
import { QboError, classifyQboFault, faultOf } from './client.js';
import { writeLog } from './log.js';
import { recordLabel } from './log.js';
import { upsertOutbox } from './hooks.js';
import {
  txWrite, getLink, getLinkById, insertLink, updateLink, requeueDependents, finishOutbox, deferOutbox, loadRecord, system,
  linkFailure, holdLink, reconcile, voidLocalInvoice, checkBrake, countWrite, shadowLog, ctxFor, writeOpts, taxCheck, taxAfterWrite,
  optionOf, taxFiledThrough, timeUp, passStopFor, BrakeError, PassStop, localToday, moduleRefusal, linkMeta,
  specialItemsMissing, rstAccountMissing, timeLockedThrough, inPayrollRun,
} from './engine.js';
import { FencedError } from './lease.js';
import { fishtapeToCanon, qboToCanon, canonEqual, markerFor, toCents, toDollars, str, localDay } from './map/canon.js';
import { canonToQbo, entityFor, paymentLineSummary, rebuildPaymentLines } from './map/to-qbo.js';
import { linkMetaFromQbo } from './map/to-fishtape.js';
import { canonCollection, fieldsOf } from './map/merge.js';
import { needsTaxReason } from './map/tax.js';
import { nextDisplayName, qboQuote, qboName } from './map/names.js';
import { normEmail, phoneKey, nameKey } from './map/match.js';
import { requestIdFor } from './map/requestid.js';
import { openReview, openConflict } from './conflicts.js';

const BATCH = 50;
const MONEY_COLLECTIONS = new Set(['estimates', 'invoices', 'payments', 'bills', 'purchaseOrders']);
const DOCS = new Set(['estimates', 'invoices']);
const NAME_ENTITIES = new Set(['Customer', 'Vendor', 'Item']);
const lastUpdated = (o) => o?.MetaData?.LastUpdatedTime || null;
const ref = (r) => (r && typeof r === 'object' ? str(r.value) : str(r));

// ---- the outbox ----------------------------------------------------------------------------------

/** Claim due rows (5.3). Shadow mode reads them without claiming (nothing moves). */
async function claimRows(run) {
  if (run.shadow) {
    return run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
      `SELECT * FROM qbo_outbox WHERE tenant_id = $1 AND not_before <= now() ORDER BY rank, enqueued_at LIMIT $2`, [tx.tenantId, BATCH])).rows);
  }
  return txWrite(run, async (tx) => (await tx.query(
    `UPDATE qbo_outbox o SET claimed_until = now() + interval '5 minutes', claimed_epoch = $2
      FROM (SELECT collection, record_id FROM qbo_outbox WHERE tenant_id = $1 AND not_before <= now()
              AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY rank, enqueued_at LIMIT $3 FOR UPDATE SKIP LOCKED) d
      WHERE o.tenant_id = $1 AND o.collection = d.collection AND o.record_id = d.record_id
      RETURNING o.*`, [tx.tenantId, run.epoch, BATCH])).rows.sort((a, b) => a.rank - b.rank || new Date(a.enqueued_at) - new Date(b.enqueued_at)));
}

/** How long a row shadow mode has looked at waits before the next look (the dispatcher runs every minute). */
const SHADOW_RECHECK = '1 hour';

/**
 * Work the outbox until it is empty or the pass is out of time. Returns true when work is left.
 * Shadow mode looks at one batch (the rows stay for when the company goes live) and moves those rows'
 * not_before an hour on, so the dispatcher does not run a pass for them every minute of the practice
 * week. Going live makes every row due at once (7.6); a newer edit makes its row due in 20 s as usual.
 */
export async function runPush(run) {
  for (;;) {
    if (timeUp(run)) return true;
    const rows = await claimRows(run);
    if (!rows.length) return false;
    for (const row of rows) {
      if (timeUp(run)) return true;
      await processRow(run, row);
    }
    if (run.shadow) {
      await txWrite(run, (tx) => tx.query(
        `UPDATE qbo_outbox SET not_before = now() + interval '${SHADOW_RECHECK}'
          WHERE tenant_id = $1 AND not_before <= now() AND (collection, record_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
        [run.tenantId, rows.map((r) => r.collection), rows.map((r) => r.record_id)]));
      return false;
    }
  }
}

/** One outbox row; per-record failures never stop the pass (5.8). */
export async function processRow(run, row) {
  const label = row.collection;
  try {
    const record = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, row.collection, row.record_id));
    if (row.collection === 'stripePayouts') return await pushPayout(run, row, record);
    let link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, row.collection, row.record_id));
    // A credit-note application's link is role apply (9.2).
    if (!link && row.collection === 'payments') link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', row.record_id, 'apply'));
    if (row.op === 'delete' || !record || record.deleted) return await pushDelete(run, row, record, link);
    if (link?.role === 'apply') link = null; // processRecord finds it itself
    return await processRecord(run, row.collection, row.record_id, { row, record, link, stale: row.stale, held: row.held, actorType: row.actor_type });
  } catch (e) {
    if (e instanceof BrakeError || e instanceof FencedError || e instanceof PassStop) throw e;
    if (passStopFor(e)) throw passStopFor(e);
    const link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, row.collection, row.record_id)).catch(() => null);
    await linkFailure(run, link, row, e, { collection: row.collection, recordId: row.record_id, label });
    return 'error';
  }
}

// ---- one record ----------------------------------------------------------------------------------

/**
 * Push one Fishtape record (outbox row, dependency, Retry, Send now, a resolved review).
 * @param {object} o { row, record, link, stale, held, actorType, force, sendNow, asDependency, depth, role }
 * @returns {Promise<string>} the link state (or 'skipped')
 */
export async function processRecord(run, collection, id, o = {}) {
  const row = o.row || null;
  const record = o.record || await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, collection, id));
  let link = o.link !== undefined ? o.link : await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, collection, id));
  if (!record || record.deleted) {
    if (row) return pushDelete(run, row, record, link);
    return 'skipped';
  }
  const doc = record.data;
  const label = recordLabel(collection, doc);
  const skip = async (message, outcome = 'skipped') => {
    if (!run.shadow) await txWrite(run, async (tx) => { await finishOutbox(tx, run, row); if (message) await writeLog(tx, { direction: 'push', outcome, action: 'skip', actorType: row?.actor_type, collection, recordId: id, label, message }); });
    return 'skipped';
  };
  // A Fishtape credit note applied to an invoice has its own link (role apply, r1-get-paid.md 9.2).
  if (collection === 'payments' && doc.method === 'credit-note') return processCreditApply(run, record, { ...o, row, label, skip });

  if (link && (link.state === 'unlinked' || link.owner === 'none')) return skip('Not linked to QuickBooks.');
  // A pulled invoice's Deposit and its settlement payment live in QuickBooks (4.7, 4.9): their links
  // are role deposit or settlement, so the main link is missing. An edit here is never sent as a new
  // QuickBooks payment, whatever its fields now say.
  if (collection === 'payments' && !link && await quickbooksOwnedPayment(run, id)) return skip('From QuickBooks; change it there.');
  if (link && link.owner === 'quickbooks' && !o.force) return skip('Edit in QuickBooks.');
  if (link && link.state === 'needs_review' && !o.force) return skip(null);
  if (link && link.state === 'deleted_remote' && !o.force) return skip('Removed in QuickBooks.');
  if (link && link.state === 'deleted_local') {
    // Restored in Fishtape after QuickBooks voided or deleted its copy (4.7): never re-created by itself.
    if (run.shadow) return 'conflict';
    await txWrite(run, async (tx) => {
      await updateLink(tx, run, link.id, { state: 'conflict' });
      await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'restored_local', fields: [{ field: 'status', label: 'Status', base: 'Removed', fishtape: 'Restored in Fishtape', quickbooks: collection === 'invoices' ? 'Voided in QuickBooks; create a new invoice in QuickBooks?' : 'Removed in QuickBooks; create it again?' }] });
      await finishOutbox(tx, run, row);
    });
    return 'conflict';
  }

  // Who made the change, for the origin rule (5.2): a writer an earlier hold kept on the link counts
  // until a person approves (force) or someone allowed to handle money changes the record again.
  const risky = (t) => (MONEY_COLLECTIONS.has(collection) && ['api_key', 'agent', 'field_user'].includes(t)) || (collection === 'timeEntries' && ['api_key', 'agent'].includes(t));
  const kept = !o.force && link?.meta?.originActor && risky(link.meta.originActor) && !['user', 'stripe'].includes(o.actorType) ? link.meta.originActor : null;
  const actorType = kept || o.actorType || 'system';

  // Eligibility (4.1). A wait here finishes the outbox row: a risky writer is kept on the link.
  const el = eligible(run, collection, doc, o);
  if (el.hold) return holdLink(run, { link, collection, recordId: id, entity: entityFor(collection, doc), row, state: el.hold.state, reason: el.hold.reason, message: el.hold.message, label, originActor: !o.force && risky(actorType) ? actorType : null });
  if (!el.ok) {
    if (!link) return skip(null);
    if (collection === 'timeEntries' && link.qbo_id) return pushDelete(run, row, record, link, { unapproved: true });
    if (collection === 'purchaseOrders' && doc.status === 'cancelled' && link.qbo_id) return pushDelete(run, row, record, link);
    // Linked but no longer eligible (an invoice back to draft): the change goes anyway (QBO cannot un-send).
  }

  // Origin (5.2): money reaches the books only from people allowed to handle money.
  const reviewOrigin = !o.force && (risky(actorType) || link?.meta?.originRejected === true);
  if (reviewOrigin) {
    const who = { api_key: 'an API key', agent: 'the assistant', field_user: 'a field user' }[actorType];
    // A push-only record keeps a change the office chose not to send: every later send needs approval.
    const message = who ? `Made by ${who}; approve to send to QuickBooks.` : 'Holds a change that was not sent to QuickBooks; approve to send it.';
    return holdLink(run, { link, collection, recordId: id, entity: entityFor(collection, doc), row, state: 'needs_review', reason: 'origin', message, label, review: { message } });
  }
  if (link?.meta?.originRejected && o.force) {
    link = await txWrite(run, (tx) => updateLink(tx, run, link.id, { meta: { ...link.meta, originRejected: undefined, originActor: undefined } }));
  } else if (link?.meta?.originActor && !kept) {
    link = await txWrite(run, (tx) => updateLink(tx, run, link.id, { meta: { ...link.meta, originActor: undefined } }));
  }

  // Holds (4.7, 4.8, 4.9, 4.10, 4.11).
  const creating = !link || !link.qbo_id;
  const hold = await localHolds(run, collection, doc, { creating, force: o.force, link });
  if (hold?.skip) return skip(hold.skip);
  if (hold) return holdLink(run, { link, collection, recordId: id, entity: entityFor(collection, doc), row, state: hold.state, reason: hold.reason, message: hold.message, label, review: hold.state === 'needs_review' ? { message: hold.message } : null });

  // Dependencies (5.3 step 3), pushed first in this pass.
  const dep = await ensureDependencies(run, collection, doc, o);
  if (dep.blocked) {
    return holdLink(run, { link, collection, recordId: id, entity: entityFor(collection, doc), row, state: 'blocked', reason: dep.reason || 'dependency', message: dep.message || 'Waiting for a record it needs.', dependsOn: dep.blocked, label });
  }
  if (link && (link.state === 'blocked' || link.state === 'error') && link.qbo_id) {
    link = await txWrite(run, (tx) => updateLink(tx, run, link.id, { state: 'pending', reason: null, meta: { ...(link.meta || {}), dependsOn: undefined } }));
  }

  // A create whose tax step never finished (a crash or a failed override after the create, 4.8).
  if (link && link.qbo_id && link.reason === 'tax_override' && link.snapshot == null && DOCS.has(collection) && !run.shadow && !o.prepareOnly) {
    return resumeTaxStep(run, collection, record, link, { row, label });
  }

  let state;
  // The wizard gathers prepared creates into batches (createBatch); everything before the send is the same.
  if (creating && o.prepareOnly) return { prepared: await prepareCreate(run, collection, record, link, { ...o, row, label }) };
  if (creating) state = await createRemote(run, collection, record, link, { ...o, row, label });
  else state = await reconcile(run, link, { record, row, stale: o.stale, held: o.held, force: o.force, direction: 'push' });

  if (collection === 'payments' && state === 'synced') await processFee(run, record);
  return state;
}

// ---- eligibility and holds ------------------------------------------------------------------------

/** A payment that only mirrors QuickBooks: an invoice's Deposit or its settlement (links role deposit or settlement). */
async function quickbooksOwnedPayment(run, id) {
  return run.db.withTenant({ tenantId: run.tenantId }, async (tx) => Boolean(await getLink(tx, 'payments', id, 'deposit') || await getLink(tx, 'invoices', id, 'settlement')));
}

/**
 * A record's date as QuickBooks will hold it: the local day in the company zone (4.7, 4.11). A time
 * entry's clockIn is a UTC instant; its UTC date is the next day for any evening clock-in in Canada.
 */
export const dateOf = (run, collection, d) => {
  const zone = run?.ctx?.company?.zone;
  if (collection === 'estimates') return d.issueDate || localDay(d.createdAt, zone) || null;
  if (collection === 'invoices') return d.issueDate || null;
  if (collection === 'timeEntries') return localDay(d.clockIn, zone) || null;
  return d.date || null;
};

/** Created in QBO when (4.1). { ok } or { hold } for a wait the badge explains. */
function eligible(run, collection, d, o) {
  const opt = (k, dflt) => optionOf(run.ctx.mappings, k, dflt);
  const f = run.ctx.features || {};
  const syncFrom = str(opt('syncFrom', null));
  const inScope = (open) => !syncFrom || open || (dateOf(run, collection, d) || '9999') >= syncFrom;
  switch (collection) {
    case 'clients': case 'vendors': return { ok: true };
    case 'jobs': return { ok: Boolean(o.asDependency) && opt('jobsAsSubCustomers', true) !== false && Boolean(d.clientId) };
    case 'items': return { ok: opt('items', 'on_use') === 'all' || Boolean(o.asDependency) };
    case 'estimates': return { ok: (d.status !== 'draft' || opt('pushDrafts', false) === true || Boolean(o.sendNow)) && inScope(['sent', 'accepted'].includes(d.status)) };
    case 'invoices': return { ok: (d.status !== 'draft' || opt('pushDrafts', false) === true || Boolean(o.sendNow)) && inScope(['sent', 'partial'].includes(d.status)) };
    case 'payments': return { ok: true };
    case 'bills':
      if (f.bills === false) return { hold: { state: 'blocked', reason: 'feature_missing', message: "Bills aren't available on this QuickBooks plan." } };
      return { ok: d.status !== 'draft' && inScope(false) };
    case 'purchaseOrders':
      if (f.purchaseOrders === false) return { hold: { state: 'blocked', reason: 'feature_missing', message: 'Purchase orders need QuickBooks Plus.' } };
      return { ok: ['open', 'sent', 'closed'].includes(d.status) };
    case 'timeEntries': {
      if (opt('syncTime', true) === false || opt('timeOwner', null) !== 'fishtape') return { ok: false };
      if (f.timeTracking === false) return { hold: { state: 'blocked', reason: 'feature_missing', message: "Time tracking isn't available on this QuickBooks plan." } };
      return { ok: d.approved === true && Boolean(d.clockIn) && Boolean(d.clockOut) && inScope(false) };
    }
    default: return { ok: false };
  }
}

/** Waits that keep a record out of QuickBooks for now (4.7, 4.8, 4.9, 4.10, 4.11). */
async function localHolds(run, collection, d, { creating, force, link }) {
  const date = dateOf(run, collection, d);
  const filed = taxFiledThrough(run.ctx.features, run.ctx.mappings);
  const closed = str(run.ctx.features?.bookCloseDate);
  if (DOCS.has(collection)) {
    if (needsTaxReason(d)) return { state: 'blocked', reason: 'tax_reason', message: 'Pick why this has no tax.' };
    if (creating) {
      // Holdback, deposit and interest lines go on their own products (r1-get-paid.md 9.2, 9.8).
      const items = specialItemsMissing(run, d);
      if (items) return { state: 'blocked', reason: 'mapping_missing', message: items };
      const msg = taxCheck(run, d, collection === 'invoices' ? 'invoice' : 'estimate');
      if (msg) return { state: 'blocked', reason: 'mapping_missing', message: msg };
      if (d.number && await localDuplicate(run, collection, d)) return { state: 'blocked', reason: 'duplicate_number_local', message: `Another ${collection === 'invoices' ? 'invoice' : 'estimate'} in Fishtape has number ${d.number}. Renumber it.` };
    }
  }
  if (collection === 'payments') {
    if (d.method === 'credit' && d.source === 'quickbooks') return { skip: 'Settled in QuickBooks; never sent.' };
    // Never pushed in R1 (9.2): money on account, an application of it, a refund, a reversal. The
    // office records them in QuickBooks; approving does not send them.
    const never = neverPushed(d);
    if (never) return { state: 'needs_review', reason: never.reason, message: never.message };
    if (!d.invoiceId) return { state: 'blocked', reason: 'no_invoice', message: 'Not sent: no invoice.' };
    if (creating && d.source === 'quickbooks') return { skip: 'From QuickBooks; never sent.' };
    const inv = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, 'invoices', d.invoiceId));
    if (creating && inv?.data?.status === 'void') return { skip: 'The invoice is void.' };
    if (creating && d.source === 'stripe') {
      const cutover = str(optionOf(run.ctx.mappings, 'stripeCutover', optionOf(run.ctx.mappings, 'syncFrom', null)));
      if (cutover && (d.date || '9999') < cutover) return { skip: 'Already in your books (before the Stripe cutover).' };
    }
  }
  if (collection === 'bills') {
    const lines = (d.lines || []).reduce((s, l) => s + (Number.isInteger(l.amountCents) ? l.amountCents : lineCents(l)), 0);
    const taxes = (d.taxes || []).reduce((s, t) => s + (Math.round(Number(t.cents)) || 0), 0);
    if (Number.isInteger(d.totalCents) && Math.abs(lines + taxes - d.totalCents) > 2) return { state: 'blocked', reason: 'totals_mismatch', message: "Bill total doesn't add up." };
    // RST charged on resale lines goes to account.rstRecoverable (9.3), never into job cost.
    if (creating) {
      const missing = rstAccountMissing(run, fishtapeToCanon('bills', d, ctxFor(run, link, 'bills')));
      if (missing) return { state: 'blocked', reason: 'mapping_missing', message: missing };
    }
  }
  if (collection === 'timeEntries' && creating && !force) {
    // The later of the option and Fishtape's payroll runs (9.6).
    const locked = timeLockedThrough(run);
    if (locked && date && date <= locked) return { state: 'needs_review', reason: 'payroll_locked', message: 'Hours already paid; change them in QuickBooks Payroll if needed.' };
  }
  if (creating && closed && date && date <= closed && ['estimates', 'invoices', 'payments', 'bills', 'purchaseOrders', 'timeEntries'].includes(collection)) {
    return { state: 'blocked', reason: 'books_closed', message: 'The books are closed in QuickBooks for this date.' };
  }
  if (creating && !force && filed && date && date <= filed && (DOCS.has(collection) || collection === 'bills') && !link?.meta?.filedConfirmed) {
    return { state: 'needs_review', reason: 'filed_period', message: 'This adds to a GST period already filed.' };
  }
  return null;
}

/**
 * Payments R1 never sends (r1-get-paid.md 9.2): money on account (no invoice) and its later
 * application (appliedFromId), refunds and reversals. They wait in review for the office to record
 * them in QuickBooks; approving does not send them. Null for any other payment.
 */
export function neverPushed(d) {
  if (!d) return null;
  if (d.reversesId) return { reason: 'reversal', message: 'Record the returned payment in QuickBooks.' };
  if (d.method === 'refund') return { reason: 'refund', message: 'Record this refund in QuickBooks.' };
  if (!d.invoiceId || d.appliedFromId) return { reason: 'on_account', message: 'Record this in QuickBooks: money on account is not sent.' };
  return null;
}

/** Review reasons a person settles in QuickBooks: approving them never sends anything (9.2). */
export const NEVER_PUSHED_REASONS = ['on_account', 'refund', 'reversal'];

/**
 * A Fishtape credit note applied to an invoice (r1-get-paid.md 9.2): a $0 QuickBooks payment with
 * the invoice and the CreditMemo as its two lines, link role apply. It is held in review
 * (credit_apply) until the sandbox confirms QuickBooks takes it (option creditApplyConfirmed) or the
 * office approves it; both documents go first. Later changes are pushed like any push-only record.
 */
async function processCreditApply(run, record, o) {
  const d = record.data;
  const { row = null, label, skip } = o;
  let link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', record.id, 'apply'));
  if (link && (link.state === 'unlinked' || link.owner === 'none')) return skip('Not linked to QuickBooks.');
  if (link && link.owner === 'quickbooks') return skip('Applied in QuickBooks; change it there.');
  if (link && link.state === 'needs_review' && !o.force) return skip(null);
  if (!d.invoiceId || !d.creditNoteId) return skip('Not sent: the credit note or the invoice is missing.');
  const hold = (state, reason, message, extra = {}) => holdLink(run, { link, collection: 'payments', recordId: record.id, entity: 'Payment', role: 'apply', row, state, reason, message, label, owner: 'fishtape', ...extra });
  const confirmed = optionOf(run.ctx.mappings, 'creditApplyConfirmed', false) === true;
  if (!o.force && !confirmed && !link?.qbo_id && link?.meta?.applyApproved !== true) {
    const message = 'A credit note applied to an invoice. QuickBooks takes it as a $0 payment; approve to send it (this is checked in the QuickBooks sandbox first).';
    return hold('needs_review', 'credit_apply', message, { review: { message } });
  }
  const dep = await ensureDependencies(run, 'payments', d, o);
  if (dep.blocked) return hold('blocked', dep.reason || 'dependency', dep.message || 'Waiting for the credit note and the invoice to reach QuickBooks.', { dependsOn: dep.blocked });
  if (link && (link.state === 'blocked' || link.state === 'error') && link.qbo_id) {
    link = await txWrite(run, (tx) => updateLink(tx, run, link.id, { state: 'pending', reason: null, meta: { ...(link.meta || {}), dependsOn: undefined } }));
  }
  if (!link || !link.qbo_id) return createRemote(run, 'payments', record, link, { role: 'apply', row, label });
  return reconcile(run, link, { record, row, force: o.force, direction: 'push' });
}

/** Two offline devices issued the same number (4.7): another live document, already linked, has it. */
async function localDuplicate(run, collection, d) {
  return run.db.withTenant({ tenantId: run.tenantId }, async (tx) => {
    const table = collection === 'invoices' ? 'invoices' : 'estimates';
    const { rows } = await tx.query(
      `SELECT r.id FROM ${table} r JOIN qbo_links l ON l.tenant_id = r.tenant_id AND l.collection = $3 AND l.record_id = r.id AND l.role = 'main' AND l.qbo_id IS NOT NULL
        WHERE r.tenant_id = $1 AND r.number = $2 AND r.id <> $4 AND r.deleted_at IS NULL LIMIT 1`, [tx.tenantId, d.number, collection, d.id]);
    return rows.length > 0;
  });
}

// ---- dependencies ----------------------------------------------------------------------------------

/** What a record needs in QuickBooks first (5.3 step 3): [collection, id, required]. */
async function dependenciesOf(run, collection, d) {
  const out = [];
  const sub = optionOf(run.ctx.mappings, 'jobsAsSubCustomers', true) !== false;
  const job = async (jobId) => {
    if (!jobId) return;
    const clientId = run.jobsClient?.get(jobId) || null;
    if (sub && clientId) { out.push(['clients', clientId, true]); out.push(['jobs', jobId, false]); } else if (clientId) out.push(['clients', clientId, true]);
  };
  const items = (lines) => { for (const l of lines || []) if (l.itemId) out.push(['items', l.itemId, false]); };
  switch (collection) {
    case 'jobs': if (d.clientId) out.push(['clients', d.clientId, true]); break;
    case 'estimates': case 'invoices':
      if (d.clientId) out.push(['clients', d.clientId, true]);
      await job(d.jobId);
      items(d.lines);
      break;
    case 'payments':
      if (d.invoiceId) out.push(['invoices', d.invoiceId, true]);
      if (d.method === 'credit-note' && d.creditNoteId) out.push(['invoices', d.creditNoteId, true]); // its CreditMemo (9.2)
      break;
    case 'bills':
      if (d.vendorId) out.push(['vendors', d.vendorId, true]);
      await job(d.jobId);
      for (const l of d.lines || []) { await job(l.jobId); if (l.poLine?.purchaseOrderId) out.push(['purchaseOrders', l.poLine.purchaseOrderId, false]); }
      items(d.lines);
      break;
    case 'purchaseOrders':
      if (d.vendorId) out.push(['vendors', d.vendorId, true]);
      await job(d.jobId);
      for (const l of d.lines || []) await job(l.jobId);
      items(d.lines);
      break;
    case 'timeEntries':
      if (d.employeeId) out.push(['employees', d.employeeId, true]);
      await job(d.jobId);
      break;
    default: break;
  }
  const seen = new Set();
  return out.filter(([c, i]) => { const k = `${c}|${i}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Push what a record needs first. A dependency is met when its link has a qbo_id (any state but
 * unlinked). Returns { ok } or { blocked: [link ids], reason?, message? }.
 */
async function ensureDependencies(run, collection, d, o) {
  if ((o.depth || 0) > 3) return { blocked: [], message: 'Too many records depend on each other.' };
  const blocked = [];
  let reason = null, message = null;
  for (const [coll, id, required] of await dependenciesOf(run, collection, d)) {
    const met = async () => {
      const l = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, coll, id));
      return { l, ok: Boolean(l && l.qbo_id && l.state !== 'unlinked') };
    };
    let { l, ok } = await met();
    if (ok) continue;
    if (coll === 'employees') { reason = 'employee_not_linked'; message = 'The employee is not linked to QuickBooks.'; if (l) blocked.push(l.id); else blocked.push(`employees:${id}`); continue; }
    const rec = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, coll, id));
    if (!rec || rec.deleted) { if (required) { blocked.push(l?.id || `${coll}:${id}`); } continue; }
    if (run.shadow) continue;
    // The dependency keeps its own writer for the origin rule (5.2): an API key's invoice waiting in the
    // outbox is held for review even when an office payment needs it first.
    const depActor = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
      'SELECT actor_type FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3', [tx.tenantId, coll, id])).rows[0]?.actor_type || 'system');
    await processRecord(run, coll, id, { asDependency: true, depth: (o.depth || 0) + 1, actorType: depActor });
    ({ l, ok } = await met());
    if (!ok && (required || l)) blocked.push(l?.id || `${coll}:${id}`);
  }
  return blocked.length ? { blocked, reason, message } : { ok: true };
}

// ---- create protocol (5.3) -------------------------------------------------------------------------

/** Mapper extras for a time entry (the job's number and title for the description). */
async function relatedOf(run, collection, d) {
  if (collection !== 'timeEntries' || !d.jobId) return {};
  const job = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, 'jobs', d.jobId));
  return job && !job.deleted ? { related: { job: job.data } } : {};
}

/** The canonical form, with the first-invoice-only estimate link (4.7). */
function canonForCreate(run, collection, d, ctx) {
  const L = fishtapeToCanon(collection, d, ctx);
  if (collection === 'invoices' && L.estimateRef) {
    const est = run.index.byRecord.get(`estimates|main|${d.estimateId}`);
    if (est?.meta?.estimateLinked && est.meta.estimateLinked !== d.id) L.estimateRef = null;
  }
  return L;
}

/**
 * Create the QuickBooks object for a record (role main, or fee for a Stripe fee Purchase).
 * @returns {Promise<string>} link state
 */
export async function createRemote(run, collection, record, link, o = {}) {
  const prep = await prepareCreate(run, collection, record, link, o);
  if (prep.done) return prep.done;
  const { entity, build, L, row, label } = prep;
  link = prep.link;
  checkBrake(run);
  await txWrite(run, (tx) => updateLink(tx, run, link.id, { meta: { ...link.meta, sent: true } })).then((l) => { link = l; });
  let obj;
  try {
    obj = await run.client.create(entity, build.body, { requestId: link.meta.createRequestId });
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    if (e.outcomeUnknown) {
      const found = await adoptBySearch(run, link, entity, build.body);
      if (found) return finishCreate(run, link, collection, record, found, build, { row, label, L, adopted: true });
      // Not there: retry once with the same request id (correctness never depends on Intuit's dedupe).
      try {
        obj = await run.client.create(entity, build.body, { requestId: link.meta.createRequestId });
      } catch (e2) {
        await linkFailure(run, link, row, e2, { action: 'create', collection, recordId: record.id, label });
        return 'pending';
      }
    } else if (e.kind === 'duplicate_number') {
      const found = await adoptBySearch(run, link, entity, build.body);
      if (found) return finishCreate(run, link, collection, record, found, build, { row, label, L, adopted: true });
      // Ours is not there: the next create (after Renumber) is a new request with its own id.
      link = await txWrite(run, (tx) => updateLink(tx, run, link.id, { meta: nextCreateMeta(link.meta) }));
      await holdLink(run, { link, collection, recordId: record.id, entity, role: link.role, row, state: 'error', reason: 'duplicate_number', message: 'QuickBooks already has a document with this number. Renumber it.', label });
      return 'error';
    } else if (e.kind === 'duplicate_name' && NAME_ENTITIES.has(entity)) {
      const found = await adoptBySearch(run, link, entity, build.body);
      if (found) return finishCreate(run, link, collection, record, found, build, { row, label, L, adopted: true });
      return nameTaken(run, collection, record, link, entity, build.body, { row, label, L });
    } else {
      await linkFailure(run, link, row, e, { action: 'create', collection, recordId: record.id, label });
      return 'error';
    }
  }
  countWrite(run);
  return finishCreate(run, link, collection, record, obj, build, { row, label, L });
}

/**
 * Steps 1 to 4 of the create protocol (5.3): the pending link committed first (marker, stable
 * request id), the body, and a search for an earlier send that may have landed. Returns
 * { done: state } when nothing is left to send, else what the send needs.
 */
export async function prepareCreate(run, collection, record, link, o = {}) {
  const role = o.role || 'main';
  const d = record.data;
  const row = o.row || null;
  const label = o.label || recordLabel(collection, d);
  const entity = entityFor(collection, d, role);
  if (run.shadow) {
    await shadowLog(run, { direction: 'push', action: 'create', collection, recordId: record.id, qboEntity: entity, label, message: `Would create a QuickBooks ${entity}` });
    return { done: 'pending' };
  }
  // 1. The pending link, committed before anything is sent.
  if (!link || !link.meta?.createRequestId) {
    link = await txWrite(run, async (tx) => {
      const cur = link ? await getLinkById(tx, link.id) : await getLink(tx, collection, record.id, role);
      const id = cur?.id || (await import('node:crypto')).randomUUID();
      const gen = Number(cur?.meta?.createGen) || 0;
      const meta = { ...(cur?.meta || {}), marker: markerFor(id), createRequestId: requestIdFor([run.tenantId, id, 'create', ...(gen ? [gen] : [])]), createStartedAt: new Date().toISOString() };
      delete meta.dependsOn;
      if (cur) return updateLink(tx, run, cur.id, { state: 'pending', reason: null, qbo_entity: entity, meta });
      return insertLink(tx, run, { id, collection, record_id: record.id, role, qbo_entity: entity, state: 'pending', owner: role === 'fee' || role === 'apply' || ['jobs', 'purchaseOrders', 'timeEntries', 'stripePayouts'].includes(collection) ? 'fishtape' : 'both', meta });
    });
  } else if (link.qbo_entity !== entity) {
    link = await txWrite(run, (tx) => updateLink(tx, run, link.id, { qbo_entity: entity }));
  }
  const ctx = ctxFor(run, link, collection, await relatedOf(run, collection, d));
  const L = canonForCreate(run, collection, d, ctx);
  const opts = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => writeOpts(run, tx, collection, d, null));
  const build = canonToQbo(collection, L, ctx, { existing: null, displayName: link.meta?.sendName || undefined, ...opts });
  if (build.error) {
    await holdLink(run, { link, collection, recordId: record.id, entity, role, row, state: 'error', reason: build.error, message: build.error === 'number_too_long' ? 'The number is longer than QuickBooks allows (21 characters).' : 'QuickBooks cannot take this document as it is.', label });
    return { done: 'error' };
  }
  // 4. A create that may already have landed (a crash, a timeout) is looked for first.
  if (link.meta?.sent) {
    const found = await adoptBySearch(run, link, entity, build.body);
    if (found) return { done: await finishCreate(run, link, collection, record, found, build, { row, label, L, adopted: true }) };
  }
  return { link, entity, build, L, row, label, record, collection };
}

/**
 * The wizard's bulk create (5.8): up to 10 prepared creates (never two that depend on each other) in
 * one batch call, each under the create protocol on its own: its link committed pending, its bId its
 * own create request id. A batch that fails or times out is never re-sent: each item is resolved one
 * by one (adopt-by-search, then a single retry). Returns the state per record id.
 */
export async function createBatch(run, prepared) {
  const out = {};
  if (!prepared.length) return out;
  await txWrite(run, async (tx) => {
    for (const p of prepared) p.link = await updateLink(tx, run, p.link.id, { meta: { ...p.link.meta, sent: true } });
  });
  for (let i = 0; i < prepared.length; i++) checkBrake(run);
  let answers = null;
  try {
    answers = await run.client.batch(prepared.map((p) => ({ bId: p.link.meta.createRequestId, operation: 'create', [p.entity]: p.build.body })));
    for (let i = 0; i < prepared.length; i++) countWrite(run);
  } catch (e) {
    const stop = passStopFor(e);
    if (stop && stop.reason !== 'writes_off') throw stop;
    answers = null;
  }
  for (const p of prepared) {
    const a = answers?.find((x) => x.bId === p.link.meta.createRequestId);
    if (a && a[p.entity]) { out[p.record.id] = await finishCreate(run, p.link, p.collection, p.record, a[p.entity], p.build, { row: p.row, label: p.label, L: p.L }); continue; }
    if (a?.Fault) {
      const f = faultOf(a);
      const c = classifyQboFault({ status: 400, faultCode: f?.code, detail: f?.detail, message: f?.message });
      if (c.kind === 'duplicate_number' || c.kind === 'duplicate_name') {
        out[p.record.id] = await createRemote(run, p.collection, p.record, p.link, { row: p.row, label: p.label });
        continue;
      }
      await linkFailure(run, p.link, p.row, new QboError(c.kind, { variant: c.variant, retry: c.retry, faultCode: f?.code, detail: null }), { action: 'create', collection: p.collection, recordId: p.record.id, label: p.label });
      out[p.record.id] = 'error';
      continue;
    }
    // No answer for this item: resolved one by one (the link has `sent`, so adopt-by-search runs first).
    out[p.record.id] = await createRemote(run, p.collection, p.record, p.link, { row: p.row, label: p.label });
  }
  return out;
}

/**
 * Link meta for a create that definitely did not land (6140, or deleted again for its tax): the next
 * create gets a new request id (a generation in the id), so Intuit's requestid replay never answers it
 * with the earlier request's result (5.3).
 */
function nextCreateMeta(meta) {
  const m = { ...(meta || {}), createGen: (Number(meta?.createGen) || 0) + 1 };
  delete m.createRequestId;
  delete m.sent;
  return m;
}

/** The snapshot after a create (5.3 step 3): QBO's answer, Fishtape's value where both agree. */
function createdSnapshot(collection, role, L, R) {
  const canonColl = canonCollection(collection, role);
  const snap = {};
  for (const f of fieldsOf(canonColl)) snap[f] = canonEqual(canonColl, f, L[f] ?? null, R[f] ?? null) ? (L[f] ?? null) : (R[f] ?? null);
  snap.extra = L.extra;
  return snap;
}

async function finishCreate(run, link, collection, record, obj, build, { row, label, L, adopted = false }) {
  const d = record.data;
  const entity = link.qbo_entity;
  let written = obj;
  const meta = { ...(link.meta || {}) };
  delete meta.sent;
  // The tax state machine of 4.8: the link stays pending (tax_override) until the override is done.
  if (DOCS.has(collection) && !adopted) {
    await txWrite(run, (tx) => updateLink(tx, run, link.id, { qbo_id: String(obj.Id), sync_token: String(obj.SyncToken), reason: 'tax_override' }));
    const tax = await taxAfterWrite(run, link, collection, d, obj, { requestParts: ['create'] });
    if (tax.outcome === 'mismatch') {
      // More than 2 cents after a create: the seconds-old document is deleted again (4.8).
      checkBrake(run);
      await run.client.remove(entity, { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: requestIdFor([run.tenantId, link.id, 'delete', 'tax', obj.SyncToken]) });
      countWrite(run);
      const q = tax.cmp.perRate.map((r) => `$${(r.qboCents / 100).toFixed(2)}`).join(' + ');
      const f = tax.cmp.perRate.map((r) => `$${(r.fishtapeCents / 100).toFixed(2)}`).join(' + ');
      await txWrite(run, async (tx) => {
        await updateLink(tx, run, link.id, { qbo_id: null, sync_token: null, state: 'error', reason: 'tax_mismatch', last_error: `QuickBooks tax ${q}, Fishtape ${f}. Check the tax code mapping.`, meta: nextCreateMeta(meta) });
        await finishOutbox(tx, run, row);
        await writeLog(tx, { direction: 'push', outcome: 'error', action: 'create', actorType: row?.actor_type, collection, recordId: record.id, qboEntity: entity, label, message: `QuickBooks tax ${q}, Fishtape ${f}; the QuickBooks copy was deleted again.`, errorCode: 'tax_mismatch' });
      });
      return 'error';
    }
    written = tax.obj;
    if (tax.outcome === 'delta') meta.taxDeltaCents = tax.deltaCents;
  }
  if (collection === 'bills' && !adopted) {
    // The recoverable tax printed on the bill, not QuickBooks' own sum (4.8 purchases).
    written = (await taxAfterWrite(run, { ...link, qbo_entity: entity }, collection, d, written, { requestParts: ['create'], L })).obj;
  }
  // A payment's own line is the invoice it was sent to (4.9): settlement, the line checks and the
  // merge all find the Fishtape payment by it.
  const paymentLine = collection === 'payments' && (link.role === 'main' || link.role === 'apply') && entity === 'Payment' ? str(L.invoiceRef) || '' : '';
  // The link meta first: R of a payment counts the excess this create left as credit (ownExcessCents).
  Object.assign(meta, linkMeta(entity, written, ctxFor(run, { ...link, meta }, collection), { pushed: build }));
  if (paymentLine && d.source === 'stripe' && str(meta.depositTo) && str(meta.depositTo) === str(run.ctx.mappings.account?.stripeClearing)) meta.stripeClearing = true;
  const ctx = ctxFor(run, { ...link, meta, qbo_line: paymentLine || link.qbo_line }, collection);
  const R = qboToCanon(entity, written, { ...ctx, collection });
  const snapshot = createdSnapshot(collection, link.role, L, R);
  if (written?.CustomerRef) meta.customerRef = ref(written.CustomerRef);
  if (collection === 'jobs' && written?.ParentRef) meta.parentRef = ref(written.ParentRef);
  if (build?.body?.DisplayName || build?.body?.Name) meta.displayName = written?.DisplayName || written?.Name || meta.displayName;
  delete meta.dependsOn;
  const numberingQbo = DOCS.has(collection) && optionOf(run.ctx.mappings, 'numbering', run.ctx.features?.customTxnNumbers === false ? 'quickbooks' : 'fishtape') === 'quickbooks';
  await txWrite(run, async (tx) => {
    let version = record.version;
    if (numberingQbo && written?.DocNumber && written.DocNumber !== d.number) {
      const v = await system.patch(tx, run, collection, record.id, { number: written.DocNumber, updatedAt: d.updatedAt });
      version = v.version;
      snapshot.number = written.DocNumber;
    }
    const l = await updateLink(tx, run, link.id, {
      qbo_id: String(written.Id), sync_token: String(written.SyncToken), qbo_updated_at: lastUpdated(written), snapshot, fishtape_version: version,
      state: 'synced', reason: null, attempts: 0, next_attempt_at: null, last_error: null, meta, prev_values: {}, ...(paymentLine ? { qbo_line: paymentLine } : {}),
    });
    if (collection === 'invoices' && L.estimateRef && d.estimateId) {
      const est = await getLink(tx, 'estimates', d.estimateId);
      if (est && !est.meta?.estimateLinked) await updateLink(tx, run, est.id, { meta: { ...(est.meta || {}), estimateLinked: d.id } });
    }
    await requeueDependents(tx, l);
    await finishOutbox(tx, run, row);
    run.stats.pushed++;
    await writeLog(tx, { direction: 'push', outcome: 'ok', action: 'create', actorType: row?.actor_type || 'system', collection, recordId: record.id, qboEntity: entity, label, message: adopted ? 'Found in QuickBooks (an earlier send had landed)' : `Created in QuickBooks${build?.warnings?.length ? `. ${build.warnings.join('; ')}` : ''}`, intuitTid: run.client.lastIntuitTid });
  });
  if (collection === 'bills' && d.receipt?.dataUrl && !adopted) await uploadReceipt(run, link, entity, written, d).catch(() => {});
  return 'synced';
}

/** The tax step of a create committed with its QuickBooks id but no snapshot (4.8): run it now. */
async function resumeTaxStep(run, collection, record, link, { row, label }) {
  const obj = await run.client.read(link.qbo_entity, link.qbo_id);
  const ctx = ctxFor(run, link, collection);
  const L = canonForCreate(run, collection, record.data, ctx);
  const opts = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => writeOpts(run, tx, collection, record.data, null));
  const build = canonToQbo(collection, L, ctx, { existing: null, ...opts });
  const state = await finishCreate(run, link, collection, record, obj, build, { row, label, L });
  if (state !== 'synced') return state;
  // Anything Fishtape changed meanwhile goes now (the snapshot holds QuickBooks' value for it).
  const fresh = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLinkById(tx, link.id));
  return reconcile(run, fresh, { record, direction: 'push' });
}

/**
 * Adopt-by-search (5.3 step 4): the narrowest filter QuickBooks allows, then the marker (names: the
 * exact name, created after the first send minus 5 minutes). Returns our object or null.
 */
async function adoptBySearch(run, link, entity, body) {
  const marker = link.meta?.marker;
  const since = new Date(Date.parse(link.meta?.createStartedAt || new Date().toISOString()) - 5 * 60_000);
  const sinceIso = since.toISOString();
  const createdAfter = (o) => Date.parse(o?.MetaData?.CreateTime || 0) >= since.getTime();
  const has = (o) => [o?.PrivateNote, o?.Description, o?.Memo].some((t) => marker && String(t || '').includes(marker));
  let q = null;
  let byName = false;
  try {
    if (entity === 'Customer' || entity === 'Vendor') { q = `select * from ${entity} where DisplayName = '${qboQuote(body.DisplayName)}'`; byName = true; }
    else if (entity === 'Item') { q = `select * from Item where Name = '${qboQuote(body.Name)}'`; byName = true; }
    else if (body.DocNumber && ['Invoice', 'Estimate', 'Bill', 'Purchase', 'PurchaseOrder'].includes(entity)) q = `select * from ${entity} where DocNumber = '${qboQuote(body.DocNumber)}'`;
  } catch { q = null; byName = false; }
  if (!q) q = `select * from ${entity} where MetaData.CreateTime >= '${sinceIso}'`;
  const list = await run.client.query(q, { max: 1000 });
  if (byName) return list.find((o) => createdAfter(o) && (!marker || qboName(o.DisplayName || o.Name) === qboName(body.DisplayName || body.Name))) || null;
  return list.find(has) || null;
}

/**
 * Duplicate name (6240) after adopt-by-search (4.2): an unlinked holder of the same kind with the same
 * email or phone (items: the same name) is linked with B = null; another unlinked holder needs a person
 * (name_taken); a vendor, an employee or a linked holder gets a " (2)".." (9)" suffix.
 */
async function nameTaken(run, collection, record, link, entity, body, { row, label, L }) {
  const name = body.DisplayName || body.Name;
  let holder = null, holderEntity = null;
  const lists = entity === 'Item' ? ['Item'] : [entity, ...['Customer', 'Vendor', 'Employee'].filter((e) => e !== entity)];
  for (const e of lists) {
    let list = [];
    try { list = await run.client.query(`select * from ${e} where ${e === 'Item' ? 'Name' : 'DisplayName'} = '${qboQuote(name)}'`, { max: 5 }); } catch (err) { if (err instanceof QboError) throw err; }
    if (list.length) { holder = list[0]; holderEntity = e; break; }
  }
  const linkedElsewhere = holder && await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
    "SELECT 1 FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = $2 AND qbo_id = $3 AND state <> 'unlinked' AND id <> $4 LIMIT 1", [tx.tenantId, holderEntity, String(holder.Id), link.id])).rows.length > 0);
  if (holder && holderEntity === entity && !linkedElsewhere) {
    const d = record.data;
    const same = entity === 'Item' ? nameKey(d.name) === nameKey(holder.Name)
      : (normEmail(d.email) && normEmail(d.email) === normEmail(holder.PrimaryEmailAddr?.Address)) || (phoneKey(d.phone).length === 10 && phoneKey(d.phone) === phoneKey(holder.PrimaryPhone?.FreeFormNumber));
    if (same) {
      // Ours by every sign: link it and compare with no base, so nothing is overwritten (4.2).
      const l = await txWrite(run, (tx) => updateLink(tx, run, link.id, { qbo_id: String(holder.Id), sync_token: String(holder.SyncToken), qbo_updated_at: lastUpdated(holder), snapshot: null, state: 'pending', reason: null, meta: { ...link.meta, sent: undefined, displayName: holder.DisplayName || holder.Name } }));
      return reconcile(run, l, { record, row, remote: holder, direction: 'push' });
    }
    await txWrite(run, async (tx) => {
      const l = await updateLink(tx, run, link.id, { state: 'needs_review', reason: 'name_taken', meta: { ...link.meta, sent: undefined, nameHolder: String(holder.Id) } });
      await openReview(tx, run, l, { reason: 'name_taken', label, message: `QuickBooks already has "${name}". Link to it, or create a new one with a number added.` });
      await finishOutbox(tx, run, row);
      await writeLog(tx, { direction: 'push', outcome: 'warning', action: 'review', collection, recordId: record.id, qboEntity: entity, label, message: 'The name is taken in QuickBooks', errorCode: 'name_taken' });
    });
    return 'needs_review';
  }
  return createWithSuffix(run, collection, record, link, { row, label, base: L.name || name });
}

/** Create again with " (n)" (4.2), up to 9; after that error/duplicate_name. */
export async function createWithSuffix(run, collection, record, link, { row, label, base }) {
  const attempt = Math.max(2, Number(link.meta?.nameAttempt || 1) + 1);
  const next = nextDisplayName(base, attempt);
  if (!next) {
    await holdLink(run, { link, collection, recordId: record.id, entity: link.qbo_entity, row, state: 'error', reason: 'duplicate_name', message: 'QuickBooks rejected a duplicate name.', label });
    return 'error';
  }
  const l = await txWrite(run, (tx) => updateLink(tx, run, link.id, {
    state: 'pending', reason: null,
    meta: { ...link.meta, sent: undefined, nameAttempt: attempt, sendName: next, createRequestId: requestIdFor([run.tenantId, link.id, 'create', attempt]), createStartedAt: new Date().toISOString() },
  }));
  return createRemote(run, collection, record, l, { row, label });
}

async function uploadReceipt(run, link, entity, obj, d) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/i.exec(String(d.receipt?.dataUrl || ''));
  if (!m) return;
  checkBrake(run);
  await run.client.upload({ entity, id: obj.Id }, { fileName: String(d.receipt.name || 'receipt').slice(0, 100), contentType: m[1], bytes: Buffer.from(m[2], 'base64') },
    { requestId: requestIdFor([run.tenantId, link.id, 'upload']) });
  countWrite(run);
}

// ---- deletes ---------------------------------------------------------------------------------------

/**
 * A Fishtape delete (or an unapproved time entry, a cancelled PO): deactivate names, delete
 * estimates, bills and time, void invoices under the balance rule, and remove only Fishtape's own
 * line of a payment that holds others (4.2, 4.7, 4.9, 4.10, 4.11).
 */
export async function pushDelete(run, row, record, link, { unapproved = false, force = false } = {}) {
  const collection = row?.collection || link?.collection;
  const id = row?.record_id || link?.record_id;
  const label = recordLabel(collection, record?.data || { id });
  const done = async (message) => {
    if (!run.shadow) await txWrite(run, async (tx) => { await finishOutbox(tx, run, row); if (message) await writeLog(tx, { direction: 'push', outcome: 'skipped', action: 'skip', collection, recordId: id, label, message }); });
    return 'skipped';
  };
  if (!link || !link.qbo_id || ['deleted_local', 'unlinked', 'deleted_remote'].includes(link.state)) return done(null);
  if (link.owner === 'quickbooks' && collection !== 'payments') return done('Edit in QuickBooks.');
  // Already waiting for a person (below): the review decides, the sweep's daily re-queue changes nothing.
  if (!force && link.state === 'needs_review' && ['filed_period', 'payroll_locked'].includes(link.reason)) return done(null);
  if ((collection === 'invoices' || collection === 'bills') && !force && !link.meta?.filedConfirmed) {
    // A void or delete takes the whole document out of a GST return already filed (4.8): a person decides.
    const filed = taxFiledThrough(run.ctx.features, run.ctx.mappings);
    const date = link.snapshot?.date || (record?.data ? dateOf(run, collection, record.data) : null);
    if (filed && date && date <= filed) {
      const message = `This removes ${collection === 'invoices' ? 'an invoice' : 'a bill'} from a GST period already filed.`;
      return holdLink(run, { link, collection, recordId: id, entity: link.qbo_entity, row, state: 'needs_review', reason: 'filed_period', message, label, review: { message } });
    }
  }
  if (collection === 'timeEntries' && !force) {
    // The later of the option and Fishtape's payroll runs; an entry in an exported run is locked (9.6).
    const locked = timeLockedThrough(run);
    const date = link.snapshot?.date;
    if ((locked && date && date <= locked) || await inPayrollRun(run, id)) return holdLink(run, { link, collection, recordId: id, entity: link.qbo_entity, row, state: 'needs_review', reason: 'payroll_locked', message: 'Hours already paid; change them in QuickBooks Payroll if needed.', label, review: { message: 'Hours already paid; change them in QuickBooks Payroll if needed.' } });
  }
  let obj;
  try { obj = await run.client.read(link.qbo_entity, link.qbo_id); } catch (e) {
    if (e instanceof QboError && e.kind === 'not_found') obj = null; else throw e;
  }
  const markGone = async (action, message, sync = null) => txWrite(run, async (tx) => {
    await updateLink(tx, run, link.id, { state: 'deleted_local', reason: unapproved ? 'unapproved' : null, sync_token: sync ?? link.sync_token });
    await finishOutbox(tx, run, row);
    run.stats.pushed++;
    await writeLog(tx, { direction: 'push', outcome: 'ok', action, actorType: row?.actor_type, collection, recordId: id, qboEntity: link.qbo_entity, label, message, intuitTid: run.client.lastIntuitTid });
  });
  if (!obj) { if (!run.shadow) await markGone('delete', 'Already gone in QuickBooks'); return 'deleted_local'; }
  if (run.shadow) { await shadowLog(run, { direction: 'push', action: 'delete', collection, recordId: id, label, message: 'Would remove from QuickBooks' }); return link.state; }
  const rid = (op) => requestIdFor([run.tenantId, link.id, op, link.fishtape_version, obj.SyncToken]);

  switch (collection) {
    case 'clients': case 'vendors': case 'items': case 'jobs': {
      checkBrake(run);
      const body = link.qbo_entity === 'Customer' ? { Id: obj.Id, SyncToken: obj.SyncToken, Active: false } : { ...stripRead(obj), Id: obj.Id, SyncToken: obj.SyncToken, Active: false };
      const r = await run.client.update(link.qbo_entity, body, { requestId: rid('deactivate'), sparse: link.qbo_entity === 'Customer' });
      countWrite(run);
      await markGone('deactivate', 'Made inactive in QuickBooks', r?.SyncToken);
      return 'deleted_local';
    }
    case 'invoices':
      return voidLocalInvoice(run, link, record, obj, { row, label, deleting: true });
    case 'payments':
      if (link.role === 'apply') {
        // A credit-note application is Fishtape's own $0 payment (9.2): voided whole.
        checkBrake(run);
        const r = await run.client.voidTxn('Payment', { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: rid('void') });
        countWrite(run);
        await markGone('void', 'Credit note application voided in QuickBooks', r?.SyncToken);
        return 'deleted_local';
      }
      return deletePayment(run, row, record, link, obj, { label, markGone });
    case 'bills':
      if (link.qbo_entity === 'Bill' && toCents(obj.TotalAmt) > 0 && toCents(obj.Balance) === 0) {
        await txWrite(run, async (tx) => {
          await system.restore(tx, run, collection, id);
          await updateLink(tx, run, link.id, { state: 'conflict' });
          await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'paid', fields: [{ field: 'status', label: 'Status', base: 'Open', fishtape: 'Deleted', quickbooks: 'Paid in QuickBooks; remove the payment there first.' }] });
          await finishOutbox(tx, run, row);
        });
        return 'conflict';
      }
      break;
    case 'purchaseOrders': {
      checkBrake(run);
      try {
        await run.client.remove('PurchaseOrder', { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: rid('delete') });
      } catch (e) {
        if (!(e instanceof QboError) || e.retry || passStopFor(e)) throw e;
        const r = await run.client.update('PurchaseOrder', { ...stripRead(obj), Id: obj.Id, SyncToken: obj.SyncToken, POStatus: 'Closed' }, { requestId: rid('close') });
        countWrite(run);
        await markGone('update', 'Closed in QuickBooks (a bill uses it)', r?.SyncToken);
        return 'deleted_local';
      }
      countWrite(run);
      await markGone('delete', 'Deleted in QuickBooks');
      return 'deleted_local';
    }
    default: break;
  }
  checkBrake(run);
  try {
    await run.client.remove(link.qbo_entity, { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: rid('delete') });
  } catch (e) {
    if (e instanceof QboError && !e.retry && !passStopFor(e) && record) {
      // QuickBooks refused: the Fishtape record comes back and a person decides (4.7, 4.10).
      await txWrite(run, async (tx) => {
        await system.restore(tx, run, collection, id);
        await updateLink(tx, run, link.id, { state: 'conflict' });
        await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'refused', fields: [{ field: 'status', label: 'Status', base: 'Exists', fishtape: 'Deleted', quickbooks: `QuickBooks refused: ${e.message}` }] });
        await finishOutbox(tx, run, row);
      });
      return 'conflict';
    }
    throw e;
  }
  countWrite(run);
  await markGone('delete', 'Deleted in QuickBooks');
  return 'deleted_local';
}

const stripRead = (o) => { const b = { ...o }; for (const k of ['MetaData', 'domain', 'sparse']) delete b[k]; return b; };

/** Fishtape delete of a payment (4.9): void only a payment that holds nothing else. */
async function deletePayment(run, row, record, link, obj, { label, markGone }) {
  const id = link.record_id;
  const others = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
    "SELECT qbo_line FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = 'Payment' AND qbo_id = $2 AND role = 'main' AND id <> $3 AND state NOT IN ('unlinked', 'deleted_local')",
    [tx.tenantId, link.qbo_id, link.id])).rows.map((r) => r.qbo_line).filter(Boolean));
  const mine = link.qbo_line || link.snapshot?.invoiceRef;
  const summary = paymentLineSummary(obj, [mine, ...others].filter(Boolean));
  const otherOwned = summary.ownedLines.filter((l) => l.invoiceQboId !== mine && l.amountCents);
  const rid = (op) => requestIdFor([run.tenantId, link.id, op, link.fishtape_version, obj.SyncToken]);
  const restoreWithConflict = async (message) => txWrite(run, async (tx) => {
    await system.restore(tx, run, 'payments', id);
    await updateLink(tx, run, link.id, { state: 'conflict' });
    await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'deposited', fields: [{ field: 'amountCents', label: 'Amount', base: '', fishtape: 'Deleted', quickbooks: message }] });
    await finishOutbox(tx, run, row);
  });
  // The excess this payment itself left as credit (4.9, meta.ownExcessCents) goes with it: only
  // unapplied money Fishtape does not own keeps the QuickBooks payment alive.
  const ownExcess = Math.min(Math.max(0, summary.unappliedCents), Math.max(0, Math.round(Number(link.meta?.ownExcessCents) || 0)));
  const otherUnapplied = summary.unappliedCents - ownExcess;
  checkBrake(run);
  if (!otherOwned.length && !summary.foreignLines.some((l) => l.amountCents) && !otherUnapplied) {
    try {
      const r = await run.client.voidTxn('Payment', { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: rid('void') });
      countWrite(run);
      await markGone('void', 'Voided in QuickBooks', r?.SyncToken);
    } catch (e) {
      if (e instanceof QboError && e.kind === 'validation') {
        await txWrite(run, async (tx) => {
          await updateLink(tx, run, link.id, { state: 'error', reason: 'deposited', last_error: 'Remove it from the deposit in QuickBooks first.' });
          await finishOutbox(tx, run, row);
        });
        return 'error';
      }
      throw e;
    }
  } else {
    const rebuilt = rebuildPaymentLines(obj, [{ invoiceQboId: mine, amountCents: 0 }], { keepTotal: true });
    try {
      const r = await run.client.update('Payment', { ...stripRead(obj), Id: obj.Id, SyncToken: obj.SyncToken, Line: rebuilt.Line, TotalAmt: toDollars(toCents(rebuilt.TotalAmt) - ownExcess) }, { requestId: rid('delete_line') });
      countWrite(run);
      await markGone('update', 'Removed this part from the QuickBooks payment; the amount is left as credit there', r?.SyncToken);
    } catch (e) {
      if (e instanceof QboError && e.kind === 'validation') { await restoreWithConflict('Deposited in QuickBooks; change it there.'); return 'conflict'; }
      throw e;
    }
  }
  // The Stripe fee Purchase goes with the payment (4.9).
  const fee = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', id, 'fee'));
  if (fee?.qbo_id && fee.state !== 'deleted_local') await removeLinked(run, fee, 'Stripe fee removed with its payment');
  return 'deleted_local';
}

/** Delete a linked QuickBooks object that goes with another (a fee Purchase, a payout Transfer). */
export async function removeLinked(run, link, message) {
  let obj = null;
  try { obj = await run.client.read(link.qbo_entity, link.qbo_id); } catch (e) { if (!(e instanceof QboError && e.kind === 'not_found')) throw e; }
  if (obj) {
    checkBrake(run);
    await run.client.remove(link.qbo_entity, { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: requestIdFor([run.tenantId, link.id, 'delete', obj.SyncToken]) });
    countWrite(run);
  }
  await txWrite(run, async (tx) => {
    await updateLink(tx, run, link.id, { state: 'deleted_local' });
    await writeLog(tx, { direction: 'push', outcome: 'ok', action: 'delete', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, message });
  });
}

// ---- Stripe fees and payouts (4.9) -------------------------------------------------------------------

/** The "Stripe" vendor for fee expenses, created on first use (4.6). */
async function stripeVendor(run) {
  const have = optionOf(run.ctx.mappings, 'stripeVendorId', null);
  if (have) return String(have);
  let vendor = (await run.client.query("select * from Vendor where DisplayName = 'Stripe'", { max: 1 }))[0] || null;
  if (!vendor) {
    checkBrake(run);
    vendor = await run.client.create('Vendor', { DisplayName: 'Stripe', CompanyName: 'Stripe' }, { requestId: requestIdFor([run.tenantId, 'stripe-vendor']) });
    countWrite(run);
  }
  await txWrite(run, (tx) => tx.query(
    `INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value, updated_by) VALUES ($1, $2, 'option', 'stripeVendorId', $3, 'system:qbo')
     ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value, realm_hash = EXCLUDED.realm_hash, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tx.tenantId, run.conn.realm_hash, JSON.stringify(String(vendor.Id))]));
  run.ctx.mappings.option = { ...run.ctx.mappings.option, stripeVendorId: String(vendor.Id) };
  return String(vendor.Id);
}

/** The Stripe cutover (4.9): Stripe money dated before it is already in the bookkeeper's books. */
const stripeCutover = (run) => str(optionOf(run.ctx.mappings, 'stripeCutover', optionOf(run.ctx.mappings, 'syncFrom', null)));

/**
 * A card payment Fishtape itself created in QuickBooks into the Stripe clearing account (4.9). Only
 * those get a fee Purchase from clearing and count as booked for a payout's Transfer out of clearing.
 * A payment the bookkeeper entered herself (linked by the wizard, relinked, pulled) went into the
 * account she chose, often net of the fee: Fishtape books neither its fee nor its payout.
 */
export function bookedIntoClearing(run, link) {
  const clearing = str(run.ctx.mappings.account?.stripeClearing);
  if (!link || !clearing || !link.meta?.createRequestId || link.meta?.wizard) return false;
  return link.meta.stripeClearing === true || str(link.meta.depositTo) === clearing;
}

/** A Stripe payment's fee as a Purchase (link role fee), once the main Payment exists (4.9). */
async function processFee(run, record) {
  const d = record.data;
  if (d.source !== 'stripe' || optionOf(run.ctx.mappings, 'recordStripeFees', true) === false) return;
  const fee = Number(d.stripe?.feeCents);
  if (!Number.isInteger(fee) || fee <= 0) return;
  if (d.stripe?.feeCurrency && String(d.stripe.feeCurrency).toUpperCase() !== 'CAD') return;
  if (run.shadow) return;
  const cutover = stripeCutover(run);
  if (cutover && (d.date || '0000') < cutover) return;
  const main = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', record.id));
  if (!bookedIntoClearing(run, main)) return;
  await stripeVendor(run);
  const link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', record.id, 'fee'));
  if (link && link.state === 'deleted_local') return;
  if (!link || !link.qbo_id) await createRemote(run, 'payments', record, link, { role: 'fee', label: `Stripe fee ${recordLabel('payments', d)}` });
  else await reconcile(run, link, { record, direction: 'push' });
}

/**
 * A Stripe payout as a Transfer from the clearing account, with payout-level fees as one Purchase
 * (4.9): skipped in test mode, outside CAD or before the cutover; waits for every charge to be
 * booked; refunds, disputes and manual payouts go to review; a payout failed after paid comes out.
 */
async function pushPayout(run, row, record) {
  const id = row.record_id;
  const p = record?.data;
  const label = `Stripe payout ${id}`;
  const link = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'stripePayouts', id));
  const skip = async (message) => {
    if (!run.shadow) await txWrite(run, async (tx) => { await finishOutbox(tx, run, row); await writeLog(tx, { direction: 'push', outcome: 'skipped', action: 'skip', actorType: 'stripe', collection: 'stripePayouts', recordId: id, label, message }); });
    return 'skipped';
  };
  if (!p) return skip('Payout not found.');
  if (p.status === 'failed' && p.paid_seen) {
    if (link?.qbo_id && link.state !== 'deleted_local') {
      if (run.shadow) return 'skipped';
      await removeLinked(run, link, 'Stripe payout failed after it was paid: Transfer deleted');
      const fee = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'stripePayouts', id, 'fee'));
      if (fee?.qbo_id && fee.state !== 'deleted_local') await removeLinked(run, fee, 'Stripe payout failed: payout fees deleted');
      await txWrite(run, (tx) => finishOutbox(tx, run, row));
      return 'deleted_local';
    }
    return skip('Failed payout; nothing was booked.');
  }
  if (p.status !== 'paid') return skip(`Payout is ${p.status}; not booked.`);
  if (optionOf(run.ctx.mappings, 'recordStripePayouts', true) === false) return skip('Payouts are not booked (option off).');
  if (!p.livemode) return skip('Test-mode payout; not booked.');
  if (String(p.currency).toLowerCase() !== 'cad') return skip('Not in Canadian dollars; not booked.');
  // The cutover compares local days, as the payment's own date is (localHolds): never the UTC date.
  const cutover = stripeCutover(run);
  const preCutover = 'Holds charges from before the Stripe cutover; already in your books.';
  if (cutover && p.earliest_charge_at && (localDay(new Date(p.earliest_charge_at).toISOString(), run.ctx.company.zone) || '9999') < cutover) return skip(preCutover);
  if (link?.qbo_id) return reconcile(run, link, { record, row, direction: 'push' });

  const review = async (message) => holdLink(run, { link, collection: 'stripePayouts', recordId: id, entity: 'Transfer', row, state: 'needs_review', reason: 'payout_items', message, label, owner: 'fishtape', review: { message } });
  if (!row.force && link?.meta?.payoutApproved !== true) {
    if (!p.automatic) return review('A manual payout cannot be itemised; check it and enter anything Stripe kept back in QuickBooks.');
    const txns = Array.isArray(p.balance_txns) ? p.balance_txns : [];
    const odd = txns.filter((t) => !['charge', 'payment', 'stripe_fee', 'tax', 'payout'].includes(t.type) && !(t.type === 'adjustment' && Number(t.feeCents) > 0 && !Number(t.amountCents)));
    if (odd.length) return review(`Refunds, disputes or adjustments in this payout (${odd.map((t) => t.type).join(', ')}): enter them in QuickBooks, then approve.`);
    const waiting = [];
    for (const t of txns.filter((x) => x.type === 'charge' || x.type === 'payment')) {
      const pay = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query(
        "SELECT id, data->>'date' AS date FROM payments WHERE tenant_id = $1 AND data->'stripe'->>'paymentIntentId' = $2 AND deleted_at IS NULL LIMIT 1", [tx.tenantId, t.paymentIntentId || ''])).rows[0]);
      if (!pay) return review('A charge in this payout is not a Fishtape payment; enter it in QuickBooks, then approve.');
      // The payment was skipped as already booked (localHolds, the same test): so is its payout.
      if (cutover && (pay.date || '9999') < cutover) return skip(preCutover);
      const main = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', pay.id));
      if (main?.state === 'synced' && !bookedIntoClearing(run, main)) {
        return review('A card payment in this payout was entered in QuickBooks another way (not into the Stripe clearing account); check the deposit there, then approve.');
      }
      const fee = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'payments', pay.id, 'fee'));
      const feeNeeded = optionOf(run.ctx.mappings, 'recordStripeFees', true) !== false && Number(t.feeCents) > 0;
      if (!main || main.state !== 'synced') waiting.push(main?.id || `payments:${pay.id}`);
      if (feeNeeded && (!fee || fee.state !== 'synced')) waiting.push(fee?.id || main?.id || `payments:${pay.id}`);
    }
    if (waiting.length) {
      return holdLink(run, { link, collection: 'stripePayouts', recordId: id, entity: 'Transfer', row, state: 'blocked', reason: 'stripe_unbooked', message: 'Waiting for its card payments and fees to reach QuickBooks.', dependsOn: [...new Set(waiting)], label, owner: 'fishtape' });
    }
  }
  const state = await createRemote(run, 'stripePayouts', record, link, { row, label });
  if (state === 'synced') {
    const { payoutFeeItems } = await import('./map/canon.js');
    if (payoutFeeItems(p.balance_txns).length) {
      await stripeVendor(run);
      const fee = await run.db.withTenant({ tenantId: run.tenantId }, (tx) => getLink(tx, 'stripePayouts', id, 'fee'));
      if (!fee?.qbo_id) await createRemote(run, 'stripePayouts', record, fee, { role: 'fee', label: `Stripe payout fees ${id}` });
    }
  }
  return state;
}

/** Outbox row for a record (the API's Send now and the resolve paths). */
export async function queueRecord(tx, collection, id, actorType = 'system') {
  await upsertOutbox(tx, { collection, recordId: id, op: 'upsert', actorType, delayS: 0 });
}

export { deferOutbox, localToday, moduleRefusal };
