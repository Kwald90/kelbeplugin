// The QuickBooks sync engine (docs/integrations/quickbooks.md section 5): one pass per tenant under the
// lease (5.8), pull first, then push, then pull again when the push wrote anything. This file holds
// what every part shares: the pass ("run"), the mapper context, the link store, Fishtape record
// access as the system actor, the safety brake, and reconcile (the three-way merge of one link and
// writing its result on both sides, 5.5). push.js works the outbox, pull.js reads QuickBooks.
//
// No database transaction is ever open during a call to Intuit. Every transaction that writes
// links, the outbox, conflicts or Fishtape records first checks the lease epoch (assertEpoch), so a
// pass that was fenced (pause, reconnect needed, disconnect, another worker) writes nothing more.
// Shadow mode (option writeMode 'shadow') runs every step and logs each would-be write instead.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { collectionDef } from '../collections.js';
import { systemPrincipal, systemWho } from '../integrations/state.js';
import { refreshInvoiceStatus } from '../integrations/payments.js';
import { appendAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { enqueue } from '../services/queue.js';
import { qboCfg } from './env.js';
import { QboError, createQboClient } from './client.js';
import { loadConnection, platformEvent, setPaused } from './connection.js';
import { QBO_ACTOR } from './roles.js';
import { assertEpoch, FencedError } from './lease.js';
import { recordLabel, errorText, writeLog, writeShadowLog, writesLastHour } from './log.js';
import { QBO_RANK, upsertOutbox } from './hooks.js';
import { fishtapeToCanon, qboToCanon, isVoidedInvoice, canonEqual, str, toCents } from './map/canon.js';
import { canonToQbo, entityFor } from './map/to-qbo.js';
import { canonToFishtape, linkMetaFromQbo } from './map/to-fishtape.js';
import { threeWayMerge, canonCollection, fieldsOf, conflictRows, MONEY_RECORD_KEYS, PUSH_ONLY_COLLECTIONS } from './map/merge.js';
import { expectedTax, lineTaxKey, kindsUsed, taxMismatchMessage, compareTax, taxOverride } from './map/tax.js';
import { requestIdFor } from './map/requestid.js';
import { docTotals } from '../../../electrical-app/js/lib/money.js';
import { runPush, processRecord } from './push.js';
import { runPull } from './pull.js';
import { openConflict, closeConflict, openReview } from './conflicts.js';
import { sweep as runSweep } from './sweep.js';

// ---- constants ---------------------------------------------------------------------------------

/** Writes on either side per tenant per rolling hour before the safety brake stops the pass (5.8). */
export const BRAKE_LIMIT = 500;
/** A qbo_sync pass stops after 4 minutes; work left goes to a continuation job (5.8). */
export const PASS_MS = 4 * 60_000;
/** Retry backoff per link, minutes (5.8); after the 8th attempt the link is poison (error). */
export const BACKOFF_MIN = [1, 2, 4, 8, 16, 32, 60, 60];

const ZONES = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto',
  QC: 'America/Toronto', NB: 'America/Moncton', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns',
  YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit',
};
export const zoneOf = (province) => ZONES[province] || 'America/Toronto';

const DOCS = new Set(['estimates', 'invoices']);
const LINK_JSON = new Set(['snapshot', 'prev_values', 'meta']);
const LINK_COLUMNS = new Set(['realm_hash', 'qbo_entity', 'qbo_id', 'qbo_line', 'sync_token', 'qbo_updated_at', 'fishtape_version', 'state', 'owner',
  'snapshot', 'prev_values', 'meta', 'reason', 'attempts', 'next_attempt_at', 'last_error', 'synced_at', 'record_id', 'collection', 'role']);

// ---- errors that end a pass ------------------------------------------------------------------

/** The safety brake tripped: nothing more is written this hour (5.8). */
export class BrakeError extends Error {
  constructor(count) { super('Safety brake: too many QuickBooks changes in an hour.'); this.name = 'BrakeError'; this.count = count; }
}
/** Stop the pass without failing the job (throttled, reconnect needed, budget, writes off). */
export class PassStop extends Error {
  constructor(reason, cause = null) { super(cause?.message || reason); this.name = 'PassStop'; this.reason = reason; this.cause = cause; }
}

/** QboError kinds that end the whole pass rather than one record. */
export function passStopFor(e) {
  if (!(e instanceof QboError)) return null;
  if (e.kind === 'throttled') return new PassStop('throttled', e);
  if (e.kind === 'auth' || e.kind === 'platform') return new PassStop('auth', e);
  if (e.kind === 'budget') return new PassStop('budget', e);
  if (e.kind === 'unavailable' && ['writes_off', 'disabled', 'not_connected', 'breaker'].includes(e.variant)) return new PassStop(e.variant, e);
  return null;
}

// ---- the pass ------------------------------------------------------------------------------------

const ref = (r) => (r && typeof r === 'object' ? str(r.value) : str(r));
const k3 = (...p) => p.map((x) => String(x ?? '')).join('|');

/** The mappings of the connection's realm, as the mappers read them (7.6). */
export async function loadMappings(tx, realmHash) {
  const out = { item: {}, taxCode: {}, purchaseTaxCode: {}, account: {}, paymentMethod: {}, depositTo: {}, paidFrom: {}, class: {}, department: {}, term: {}, option: {} };
  const { rows } = await tx.query('SELECT kind, key, value, realm_hash = $2 AS ours FROM qbo_mappings WHERE tenant_id = $1', [tx.tenantId, realmHash]);
  let foreign = 0;
  for (const r of rows) {
    if (!r.ours) { foreign++; continue; }
    (out[r.kind] ||= {})[r.key] = r.value;
  }
  return { mappings: out, foreign };
}

/** Options with their defaults (6.1). */
export function optionOf(mappings, key, dflt) {
  const v = mappings?.option?.[key];
  return v === undefined || v === null ? dflt : v;
}

/** The later of QuickBooks' filed-through date and the office's own (2.8). */
export function taxFiledThrough(features, mappings) {
  const a = str(features?.taxFiledThrough);
  const b = str(optionOf(mappings, 'taxFiledThrough', null));
  if (a && b) return a > b ? a : b;
  return a || b || null;
}

/** First day of the current month (the default syncFrom, 6.1). */
export const monthStart = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

async function loadIndex(tx, run) {
  const { rows } = await tx.query(
    `SELECT id, collection, record_id, role, qbo_entity, qbo_id, qbo_line, state, owner, meta, realm_hash = $2 AS ours FROM qbo_links WHERE tenant_id = $1`,
    [tx.tenantId, run.conn.realm_hash]);
  run.index = { byRecord: new Map(), byQbo: new Map(), parents: new Map(), foreign: 0 };
  for (const r of rows) {
    if (!r.ours) { run.index.foreign++; continue; }
    indexLink(run, r);
  }
  const jobs = await tx.query("SELECT id, data->>'clientId' AS client_id FROM jobs WHERE tenant_id = $1 AND deleted_at IS NULL", [tx.tenantId]);
  run.jobsClient = new Map(jobs.rows.map((j) => [j.id, j.client_id]));
}

/** Keep the in-memory index in step with a link row (after every insert or update). */
export function indexLink(run, link) {
  if (!run.index || !link) return;
  const key = k3(link.collection, link.role, link.record_id);
  const prev = run.index.byRecord.get(key);
  if (prev?.qbo_id && prev.role === 'main') run.index.byQbo.delete(k3(prev.collection, prev.qbo_id));
  run.index.byRecord.set(key, { ...link });
  if (link.qbo_id && link.role === 'main' && link.state !== 'unlinked') run.index.byQbo.set(k3(link.collection, link.qbo_id), link.record_id);
  if (link.collection === 'jobs' && link.qbo_id && link.meta?.parentRef) run.index.parents.set(String(link.qbo_id), String(link.meta.parentRef));
}

function refsFor(run) {
  const main = (coll, id) => run.index.byRecord.get(k3(coll, 'main', id));
  const live = (l) => l && l.qbo_id && l.state !== 'unlinked' && l.state !== 'deleted_local';
  return {
    qboIdFor: (coll, id) => { const l = main(coll, id); return live(l) ? l.qbo_id : null; },
    fishtapeIdFor: (coll, qboId) => run.index.byQbo.get(k3(coll, qboId)) || null,
    itemKind: (qboItemId) => (run.index.byQbo.get(k3('items', qboItemId)) ? 'material' : null),
    itemType: (qboItemId) => {
      const id = run.index.byQbo.get(k3('items', qboItemId));
      const l = id ? main('items', id) : null;
      return l?.meta?.qboType || run.itemTypes?.get(String(qboItemId)) || null;
    },
    clientOfJob: (jobId) => run.jobsClient?.get(jobId) || null,
    employeeEntity: (employeeId) => main('employees', employeeId)?.qbo_entity || 'Employee',
    poLineId: (poId, index) => { const l = main('purchaseOrders', poId); return l?.meta?.lineIds?.[String(index)] ?? null; },
    parentOf: (qboCustomerId) => run.index.parents.get(String(qboCustomerId)) || null,
  };
}

/** Reference lists the mappers and the tax checks need (3.8): tax codes, rates, agencies, item types. */
async function loadReference(tx, realmHash) {
  const { rows } = await tx.query(
    "SELECT kind, qbo_id, data FROM qbo_reference WHERE tenant_id = $1 AND realm_hash = $2 AND kind IN ('TaxCode', 'TaxRate', 'TaxAgency', 'Item')",
    [tx.tenantId, realmHash]);
  const rates = { codes: [], rates: [], agencies: [] };
  const itemTypes = new Map();
  for (const r of rows) {
    if (r.kind === 'TaxCode') rates.codes.push(r.data);
    else if (r.kind === 'TaxRate') rates.rates.push(r.data);
    else if (r.kind === 'TaxAgency') rates.agencies.push(r.data);
    else if (r.kind === 'Item') itemTypes.set(String(r.qbo_id), r.data.Type || null);
  }
  return { rates, itemTypes };
}

/**
 * A pass over one tenant. Returns null when there is no connection.
 * @param {object} deps { db, sealer, config, records, now?, log? }
 * @param {{ epoch: number, purpose?: string, budgetMs?: number, ignoreBrake?: boolean, workerId?: string }} o
 */
export async function makeRun(deps, tenantId, o) {
  const cfg = qboCfg(deps.config);
  const loaded = await deps.db.withTenant({ tenantId }, async (tx) => {
    const conn = await loadConnection(tx);
    if (!conn) return null;
    const { mappings, foreign } = await loadMappings(tx, conn.realm_hash);
    const settings = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tenantId])).rows[0]?.data || {};
    const reference = await loadReference(tx, conn.realm_hash);
    const brakeCount = await writesLastHour(tx);
    return { conn, mappings, foreign, settings, reference, brakeCount };
  });
  if (!loaded) return null;
  const { conn, mappings } = loaded;
  const run = {
    deps, cfg, db: deps.db, tenantId, conn, epoch: o.epoch, workerId: o.workerId || 'qbo',
    shadow: optionOf(mappings, 'writeMode', 'live') === 'shadow',
    deadline: Date.now() + (o.budgetMs ?? PASS_MS),
    stats: { pushed: 0, pulled: 0, conflicts: 0, errors: 0, shadow: 0 },
    wrote: false,
    ignoreBrake: Boolean(o.ignoreBrake),
    brake: { count: loaded.brakeCount, limit: brakeLimit(conn, deps.brakeLimit ?? BRAKE_LIMIT) },
    itemTypes: loaded.reference.itemTypes,
    settings: loaded.settings,
    customerCache: new Map(),
  };
  run.client = deps.client || createQboClient({ db: deps.db, sealer: deps.sealer, config: deps.config, tenantId, purpose: o.purpose || 'sync', log: deps.log });
  await deps.db.withTenant({ tenantId }, (tx) => loadIndex(tx, run));
  const province = loaded.settings?.company?.province || conn.features?.province || null;
  run.ctx = {
    mappings, features: conn.features || {}, company: { province, zone: zoneOf(province) }, rates: loaded.reference.rates,
    refs: refsFor(run), now: deps.now ? deps.now() : new Date(),
  };
  if (loaded.foreign || run.index.foreign) await realmMismatch(run);
  return run;
}

function brakeLimit(conn, base) {
  const allowed = conn.brake_allow_until && new Date(conn.brake_allow_until) > new Date() ? Number(conn.brake_allow_count) || 0 : 0;
  return base + allowed;
}

/** Rows written for another realm are never acted on (3.2): log and alert once per pass. */
async function realmMismatch(run) {
  await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => {
    await writeLog(tx, { direction: 'system', outcome: 'warning', action: 'realm_mismatch', message: 'Rows for another QuickBooks company were ignored.' });
    await platformEvent(tx, 'realm_mismatch', run.conn.environment, run.tenantId);
  }).catch(() => {});
}

/** The mapper context for one link (3.4 meta, the role and line). */
export function ctxFor(run, link, collection, extra = {}) {
  return { ...run.ctx, collection, link: link ? { role: link.role, qbo_line: link.qbo_line, meta: link.meta || {}, qbo_id: link.qbo_id } : { role: 'main', meta: {} }, ...extra };
}

export const timeUp = (run) => Date.now() > run.deadline;

// ---- transactions and the brake -------------------------------------------------------------------

/** A write transaction for the pass: tenant lock, then the epoch check (5.8). */
export function txWrite(run, fn) {
  return run.db.withTenant({ tenantId: run.tenantId }, async (tx) => {
    await assertEpoch(tx, run.tenantId, run.epoch);
    return fn(tx);
  }, { write: true });
}

/** Before every write on either side: the rolling-hour count (5.8). The wizard's apply is exempt. */
export function checkBrake(run) {
  if (run.ignoreBrake || run.shadow) return;
  if (run.brake.count + 1 > run.brake.limit) throw new BrakeError(run.brake.count + 1);
}
export function countWrite(run) {
  run.brake.count++;
  run.wrote = true;
}

/** Shadow mode: log what would be written, write nothing (5.8). */
export async function shadowLog(run, e) {
  run.stats.shadow++;
  await run.db.withTenant({ tenantId: run.tenantId }, (tx) => writeShadowLog(tx, e));
}

// ---- links ------------------------------------------------------------------------------------------

export async function getLink(tx, collection, recordId, role = 'main') {
  const { rows } = await tx.query('SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = $4', [tx.tenantId, collection, recordId, role]);
  return rows[0] || null;
}
export async function getLinkById(tx, id) {
  const { rows } = await tx.query('SELECT * FROM qbo_links WHERE tenant_id = $1 AND id = $2', [tx.tenantId, id]);
  return rows[0] || null;
}
export async function linksByRemote(tx, entity, qboId) {
  const { rows } = await tx.query(
    "SELECT * FROM qbo_links WHERE tenant_id = $1 AND qbo_entity = $2 AND qbo_id = $3 AND state <> 'unlinked' ORDER BY role, qbo_line", [tx.tenantId, entity, String(qboId)]);
  return rows;
}

/** Insert a link (a new id unless given). Returns the row. */
export async function insertLink(tx, run, f) {
  const id = f.id || randomUUID();
  const { rows } = await tx.query(
    `INSERT INTO qbo_links (tenant_id, id, realm_hash, collection, record_id, role, qbo_entity, qbo_id, qbo_line, sync_token, qbo_updated_at,
        fishtape_version, state, owner, snapshot, prev_values, meta, reason, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
    [tx.tenantId, id, run.conn.realm_hash, f.collection, f.record_id, f.role || 'main', f.qbo_entity, f.qbo_id ?? null, f.qbo_line ?? '',
      f.sync_token ?? null, f.qbo_updated_at ?? null, f.fishtape_version ?? null, f.state, f.owner || 'both',
      f.snapshot === undefined ? null : JSON.stringify(f.snapshot), JSON.stringify(f.prev_values || {}), JSON.stringify(f.meta || {}), f.reason ?? null,
      f.state === 'synced' ? new Date() : null]);
  indexLink(run, rows[0]);
  return rows[0];
}

/** Update a link's columns. JSON columns are replaced whole. Returns the row. */
export async function updateLink(tx, run, id, f) {
  const sets = [];
  const params = [tx.tenantId, id];
  for (const [k, v] of Object.entries(f)) {
    if (!LINK_COLUMNS.has(k) || v === undefined) continue;
    params.push(LINK_JSON.has(k) ? (v === null ? null : JSON.stringify(v)) : v);
    sets.push(`${k} = $${params.length}`);
  }
  if (f.state === 'synced' && f.synced_at === undefined) sets.push('synced_at = now()');
  sets.push('updated_at = now()');
  const { rows } = await tx.query(`UPDATE qbo_links SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`, params);
  if (rows[0]) indexLink(run, rows[0]);
  return rows[0] || null;
}

/**
 * Re-queue every link waiting for this one (5.3 step 3). A wait recorded before the dependency had a
 * link of its own names it as "<collection>:<record id>".
 */
export async function requeueDependents(tx, link) {
  const keys = [String(link.id), `${link.collection}:${link.record_id}`];
  const { rows } = await tx.query(
    `SELECT collection, record_id FROM qbo_links WHERE tenant_id = $1 AND state IN ('blocked', 'pending') AND meta->'dependsOn' ?| $2::text[]`, [tx.tenantId, keys]);
  for (const r of rows) await upsertOutbox(tx, { collection: r.collection, recordId: r.record_id, op: 'upsert', actorType: 'system', rank: QBO_RANK[r.collection], delayS: 0 });
  return rows.length;
}

/** Re-queue every error and blocked link (a mapping change, 7.6; a feature back on, 2.8). */
export async function requeueStuck(tx, { collections = null, reasons = null } = {}) {
  const { rows } = await tx.query(
    `SELECT collection, record_id FROM qbo_links WHERE tenant_id = $1 AND state IN ('error', 'blocked') AND role = 'main'
        AND ($2::text[] IS NULL OR collection = ANY($2)) AND ($3::text[] IS NULL OR reason = ANY($3))`, [tx.tenantId, collections, reasons]);
  for (const r of rows) await upsertOutbox(tx, { collection: r.collection, recordId: r.record_id, op: 'upsert', actorType: 'system', rank: QBO_RANK[r.collection], delayS: 0 });
  await tx.query(
    `UPDATE qbo_links SET attempts = 0, next_attempt_at = NULL WHERE tenant_id = $1 AND state IN ('error', 'blocked') AND role = 'main'
        AND ($2::text[] IS NULL OR collection = ANY($2)) AND ($3::text[] IS NULL OR reason = ANY($3))`, [tx.tenantId, collections, reasons]);
  return rows.length;
}

// ---- the outbox row being processed ------------------------------------------------------------------

/** Delete the outbox row in the transaction that records the link outcome, only while our claim stands (5.3). */
export async function finishOutbox(tx, run, row) {
  if (!row || run.shadow) return;
  await tx.query(
    `DELETE FROM qbo_outbox WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND claimed_until IS NOT NULL AND claimed_epoch = $4`,
    [tx.tenantId, row.collection, row.record_id, run.epoch]);
}

/** Keep the outbox row for a later retry. */
export async function deferOutbox(tx, run, row, at) {
  if (!row || run.shadow) return;
  await tx.query(
    `UPDATE qbo_outbox SET not_before = $5, claimed_until = NULL, claimed_epoch = NULL
      WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND claimed_epoch = $4`,
    [tx.tenantId, row.collection, row.record_id, run.epoch, at]);
}

// ---- Fishtape records ----------------------------------------------------------------------------------

/** A Fishtape record of a synced collection, deleted ones included. stripePayouts come from stripe_payouts. */
export async function loadRecord(tx, collection, id) {
  if (collection === 'stripePayouts') {
    const { rows } = await tx.query('SELECT *, (extract(epoch FROM received_at) * 1000)::bigint AS v FROM stripe_payouts WHERE tenant_id = $1 AND payout_id = $2', [tx.tenantId, id]);
    const r = rows[0];
    return r ? { id, data: r, version: Number(r.v), deleted: false, updatedBy: 'system:stripe', changeSeq: null } : null;
  }
  const def = collectionDef(collection);
  if (!def) return null;
  const { rows } = await tx.query(`SELECT id, data, version, change_seq, deleted_at, updated_by FROM ${def.table} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]);
  const r = rows[0];
  return r ? { id: r.id, data: { ...r.data, id: r.id }, version: Number(r.version), deleted: Boolean(r.deleted_at), updatedBy: r.updated_by, changeSeq: Number(r.change_seq) } : null;
}

const qboPrincipal = (tenantId) => systemPrincipal(tenantId, 'qbo', 'QuickBooks sync');
const qboWho = (tenantId) => systemWho(qboPrincipal(tenantId));

/** Fishtape writes as the system actor (5.7): validation, history, audit and plan checks all apply. */
export const system = {
  async patch(tx, run, collection, id, patch) {
    return run.deps.records.patchRecord(tx, qboPrincipal(run.tenantId), collection, id, patch, {}, qboWho(run.tenantId));
  },
  async create(tx, run, collection, body) {
    return run.deps.records.createRecord(tx, qboPrincipal(run.tenantId), collection, body, qboWho(run.tenantId));
  },
  async remove(tx, run, collection, id) {
    return run.deps.records.deleteRecord(tx, qboPrincipal(run.tenantId), collection, id, {}, qboWho(run.tenantId));
  },
  async restore(tx, run, collection, id) {
    return run.deps.records.restoreRecord(tx, qboPrincipal(run.tenantId), collection, id, qboWho(run.tenantId));
  },
  async refreshInvoice(tx, run, invoiceId) {
    return refreshInvoiceStatus(tx, run.deps.records, qboPrincipal(run.tenantId), qboWho(run.tenantId), invoiceId);
  },
};

/** A Fishtape write refused by the plan or a module switch (5.7): blocked/module_off or paused/plan. */
export function moduleRefusal(e) {
  if (e instanceof ApiError && e.code === 'module_turned_off') return 'module_off';
  if (e instanceof ApiError && e.code === 'feature_not_in_plan') return 'plan';
  return null;
}

// ---- link outcomes ------------------------------------------------------------------------------------

/** Error handling for one record (5.8): retry with backoff, poison after 8, or a permanent state. */
export async function linkFailure(run, link, row, e, { action = 'update', collection, recordId, label, direction = 'push' } = {}) {
  const stop = passStopFor(e);
  if (stop) throw stop;
  if (e instanceof FencedError || e instanceof BrakeError || e instanceof PassStop) throw e;
  run.stats.errors++;
  const kind = e instanceof QboError ? e.kind : 'other';
  const permanent = {
    feature: ['blocked', 'feature_missing'], closed_books: ['blocked', 'books_closed'], open_balance: ['error', 'open_balance'],
    validation: ['error', e?.variant === 'amount' ? 'amount_rule' : 'validation'], permission: ['error', 'permission'],
    not_found: ['error', 'not_found'], duplicate_name: ['error', 'duplicate_name'], duplicate_number: ['error', 'duplicate_number'],
  }[kind];
  const attempts = (link?.attempts || 0) + 1;
  const retry = !permanent && (e instanceof QboError ? e.retry !== false : true) && attempts < BACKOFF_MIN.length;
  const message = errorText(e);
  await txWrite(run, async (tx) => {
    if (link) {
      const state = retry ? (link.state === 'synced' || link.state === 'pending' ? link.state : 'pending') : permanent ? permanent[0] : 'error';
      await updateLink(tx, run, link.id, {
        attempts, last_error: message ? message.slice(0, 500) : null, state,
        reason: retry ? link.reason : (permanent ? permanent[1] : (kind === 'other' ? 'error' : kind)),
        next_attempt_at: retry ? new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000) : null,
      });
    }
    if (retry) await deferOutbox(tx, run, row, new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000));
    else await finishOutbox(tx, run, row);
    await writeLog(tx, {
      direction, outcome: 'error', action, actorType: row?.actor_type, collection: collection || link?.collection, recordId: recordId || link?.record_id,
      qboEntity: link?.qbo_entity, label, message, errorCode: e instanceof QboError ? (e.faultCode ? `${kind}:${e.faultCode}` : kind) : 'internal', intuitTid: e?.intuitTid || run.client.lastIntuitTid,
    });
  });
  if (!retry && kind === 'feature' && link) await featureMissing(run, link.collection);
}

/** QuickBooks answered 5030 for an entity: the feature is off in this edition (2.8). */
async function featureMissing(run, collection) {
  const feature = { bills: 'bills', purchaseOrders: 'purchaseOrders', timeEntries: 'timeTracking' }[collection];
  if (!feature) return;
  await txWrite(run, (tx) => tx.query(
    `UPDATE qbo_connections SET features = features || jsonb_build_object($2::text, false), updated_at = now() WHERE tenant_id = $1`, [run.tenantId, feature]));
  run.ctx.features = { ...run.ctx.features, [feature]: false };
}

/** Set a link to blocked or needs_review (or error) with a reason and finish the outbox row. */
export async function holdLink(run, { link, collection, recordId, entity, role = 'main', row, state, reason, message = null, dependsOn = null, owner, label, review = null }) {
  if (run.shadow) {
    await shadowLog(run, { direction: 'push', action: 'hold', collection, recordId, label, message: `Would wait: ${reason}` });
    return null;
  }
  return txWrite(run, async (tx) => {
    let l = link ? await getLinkById(tx, link.id) : await getLink(tx, collection, recordId, role);
    const meta = { ...(l?.meta || {}) };
    if (dependsOn) meta.dependsOn = dependsOn; else delete meta.dependsOn;
    if (l) l = await updateLink(tx, run, l.id, { state, reason, last_error: message, meta, ...(owner ? { owner } : {}) });
    else l = await insertLink(tx, run, { collection, record_id: recordId, role, qbo_entity: entity, state, reason, meta, owner, ...(message ? {} : {}) });
    if (message && l) l = await updateLink(tx, run, l.id, { last_error: message.slice(0, 500) });
    if (review) await openReview(tx, run, l, { reason, label, ...review });
    await finishOutbox(tx, run, row);
    await writeLog(tx, { direction: 'push', outcome: state === 'needs_review' ? 'warning' : 'skipped', action: state === 'needs_review' ? 'review' : 'blocked', actorType: row?.actor_type, collection, recordId, qboEntity: entity, label, message: message || reason, errorCode: reason });
    return l;
  });
}

// ---- reconcile (5.5) ----------------------------------------------------------------------------------

const lastUpdated = (o) => o?.MetaData?.LastUpdatedTime || null;

/** The record with device money values held by records.js applied (5.2): L shows the device's value. */
function withHeld(data, held) {
  if (!held || typeof held !== 'object' || !Object.keys(held).length) return data;
  return { ...data, ...held };
}

/** The record keys behind changed canonical fields (for meta.pulledKeys, 5.2). */
function recordKeysOf(collection, fields, patch) {
  const money = MONEY_RECORD_KEYS[collection] || {};
  const keys = new Set(Object.keys(patch || {}));
  for (const f of fields) for (const k of money[f] || []) if (patch && k in patch) keys.add(k);
  keys.delete('updatedAt');
  return [...keys];
}

/** Payment extras the mappers need (4.9): the invoice's QBO customer and balance, the invoice it was on. */
function paymentOpts(run, record, B) {
  if (!record) return {};
  const inv = run.index.byRecord.get(k3('invoices', 'main', record.invoiceId));
  return {
    invoiceCustomerRef: inv?.meta?.customerRef || null,
    invoiceBalanceCents: inv?.meta?.qboBalanceCents ?? null,
    previousInvoiceRef: B?.invoiceRef || null,
  };
}

/** Options for canonToQbo for a record (shared by create and update). */
export async function writeOpts(run, tx, collection, record, B = null) {
  const opts = { today: localToday(run) };
  if (collection === 'payments') Object.assign(opts, paymentOpts(run, record, B));
  if (DOCS.has(collection) && record?.clientId) {
    const c = await tx.query('SELECT data->>\'email\' AS email FROM clients WHERE tenant_id = $1 AND id = $2', [tx.tenantId, record.clientId]);
    if (c.rows[0]?.email) opts.billEmail = c.rows[0].email;
  }
  return opts;
}

export const localToday = (run) => new Date(run.ctx.now || Date.now()).toLocaleDateString('en-CA', { timeZone: run.ctx.company.zone });

/** The QuickBooks codes of a document's kinds (4.8). */
export function codeIdsByKind(run, doc) {
  const codes = run.ctx.mappings.taxCode || {};
  return Object.fromEntries(kindsUsed(doc).map((k) => [k, codes[lineTaxKey(doc, k)] || null]));
}

/** The pre-push tax check (4.8): null when fine, else the message. */
export function taxCheck(run, doc, docWord) {
  if (!run.ctx.features?.salesTax) return null;
  const date = doc.issueDate || String(doc.createdAt || '').slice(0, 10) || undefined;
  const r = expectedTax(doc, codeIdsByKind(run, doc), run.ctx.rates, date);
  return r.ok ? null : taxMismatchMessage(r.mismatch, docWord);
}

/**
 * After a write that carries tax (4.8): compare Fishtape's tax per rate with QuickBooks', override a
 * difference of 2 cents or less, refuse more. Returns { obj, outcome: 'equal'|'overridden'|'delta'|'mismatch', deltaCents }.
 */
export async function taxAfterWrite(run, link, collection, record, obj, { requestParts, L = null }) {
  if (!run.ctx.features?.salesTax || !obj?.TxnTaxDetail) return { obj, outcome: 'equal' };
  let totals, codeIds, date, purchase = false, entity;
  if (DOCS.has(collection)) {
    totals = docTotals(record);
    codeIds = Object.values(codeIdsByKind(run, record));
    date = record.issueDate || undefined;
    entity = collection === 'invoices' ? 'Invoice' : 'Estimate';
  } else if (collection === 'bills' && L) {
    // Purchases: QuickBooks must hold the recoverable tax printed on the bill (4.8).
    const taxes = (L.taxes || []).map((t) => ({ id: t.id, pct: t.pct, cents: t.cents, baseCents: 0 }));
    totals = { taxes, taxCents: taxes.reduce((s, t) => s + t.cents, 0) };
    codeIds = [run.ctx.mappings.purchaseTaxCode?.[L.extra?.taxKey]].filter(Boolean);
    date = L.date || undefined;
    purchase = true;
    entity = link.qbo_entity;
    if (!taxes.length || !codeIds.length) return { obj, outcome: 'equal' };
  } else return { obj, outcome: 'equal' };
  const cmp = compareTax(totals, obj.TxnTaxDetail, run.ctx.rates, date);
  if (cmp.equal) return { obj, outcome: 'equal' };
  if (!cmp.withinTolerance && !purchase) return { obj, outcome: 'mismatch', cmp };
  const detail = taxOverride(totals, codeIds, run.ctx.rates, { date, purchase });
  const delta = purchase ? 0 : toCents(obj.TotalAmt) - totals.totalCents;
  if (!detail) return { obj, outcome: purchase ? 'equal' : 'delta', deltaCents: delta };
  checkBrake(run);
  try {
    const body = purchase ? { ...readable(obj), Id: obj.Id, SyncToken: obj.SyncToken, TxnTaxDetail: detail } : { Id: obj.Id, SyncToken: obj.SyncToken, TxnTaxDetail: detail };
    const fixed = await run.client.update(entity, body, { requestId: requestIdFor([run.tenantId, link.id, 'tax', ...requestParts, obj.SyncToken]), sparse: !purchase });
    countWrite(run);
    return { obj: fixed, outcome: 'overridden' };
  } catch (e) {
    if (e instanceof QboError && e.kind === 'validation') return { obj, outcome: purchase ? 'equal' : 'delta', deltaCents: delta };
    throw e;
  }
}

/** A QuickBooks object as a full-update body (read-only fields dropped). */
const readable = (o) => { const b = { ...o }; for (const k of ['MetaData', 'domain', 'sparse']) delete b[k]; return b; };

/**
 * Reconcile one link (5.5): L, R and B, the merge, then the write on each side. `remote` is the
 * current QBO object when the caller has it (CDC); otherwise it is read. Returns the link state.
 * @param {object} o { record, remote, stale, held, force, row (outbox), direction: 'push'|'pull', attempt }
 */
export async function reconcile(run, link, o = {}) {
  const collection = link.collection;
  const canonColl = canonCollection(collection, link.role);
  const direction = o.direction || 'push';
  const row = o.row || null;
  const record = o.record || await run.db.withTenant({ tenantId: run.tenantId }, (tx) => loadRecord(tx, collection, link.record_id));
  if (!record || record.deleted) return link.state;
  const label = recordLabel(collection, record.data);
  let obj = o.remote || null;
  if (!obj) {
    try {
      obj = await run.client.read(link.qbo_entity, link.qbo_id);
    } catch (e) {
      if (e instanceof QboError && e.kind === 'not_found') {
        const { remoteDeleted } = await import('./pull.js');
        await remoteDeleted(run, link, { record, row });
        return 'deleted_remote';
      }
      throw e;
    }
  }
  if (obj?.status === 'Deleted') {
    const { remoteDeleted } = await import('./pull.js');
    await remoteDeleted(run, link, { record, row });
    return 'deleted_remote';
  }
  if (link.qbo_entity === 'Customer' && obj?.ParentRef) run.index.parents.set(String(obj.Id), ref(obj.ParentRef));

  const ctx = ctxFor(run, link, collection);
  const B = link.snapshot;

  // Voids first (4.7): a QuickBooks void only sets the status; its zeroed lines never reach Fishtape.
  if (collection === 'invoices' && link.role === 'main' && isVoidedInvoice(obj)) return voidedRemote(run, link, record, obj, { row, label, B });

  // A payment's line that left its invoice (4.9): gone (a void, an unapply) is a remote delete; moved to
  // another invoice is a conflict on the invoice, never read as a delete plus a create.
  if (collection === 'payments' && link.role === 'main' && link.qbo_entity === 'Payment' && link.qbo_line) {
    const invLines = (obj.Line || []).filter((l) => (l.LinkedTxn || []).some((t) => t.TxnType === 'Invoice') && toCents(l.Amount));
    const mine = invLines.find((l) => l.LinkedTxn.some((t) => t.TxnType === 'Invoice' && String(t.TxnId) === String(link.qbo_line)));
    if (!mine) {
      if (invLines.length === 1 && B?.invoiceRef === link.qbo_line && String(record.data.invoiceId || '') && run.ctx.refs.qboIdFor('invoices', record.data.invoiceId) === link.qbo_line) {
        if (run.shadow) return 'conflict';
        await txWrite(run, async (tx) => {
          await updateLink(tx, run, link.id, { state: 'conflict' });
          await openConflict(tx, run, link, { kind: 'fields', label, reason: 'payment_moved', fields: [{ field: 'invoiceRef', label: 'Invoice', base: `QuickBooks #${link.qbo_line}`, fishtape: `QuickBooks #${link.qbo_line}`, quickbooks: `QuickBooks #${(invLines[0].LinkedTxn.find((t) => t.TxnType === 'Invoice') || {}).TxnId}` }] });
          await finishOutbox(tx, run, row);
        });
        run.stats.conflicts++;
        return 'conflict';
      }
      const { remoteDeleted } = await import('./pull.js');
      await remoteDeleted(run, link, { record, row });
      return 'deleted_remote';
    }
  }

  const data = withHeld(record.data, o.held);
  const L = fishtapeToCanon(collection, data, ctx);
  const R = qboToCanon(link.qbo_entity, obj, { ...ctx, collection });

  // A pulled tax-inclusive document cannot be represented exactly (4.8): QuickBooks keeps the truth.
  if (DOCS.has(collection) && R.extra?.taxInclusive && link.owner !== 'quickbooks') {
    return reviewFromRemote(run, link, { row, reason: 'tax_inclusive', label, obj, message: 'Tax-inclusive in QuickBooks; check it there.' });
  }

  const meta = { ...(link.meta || {}) };
  const seen = { ...(meta.fieldSeenAt || {}) };
  if (B) {
    for (const f of fieldsOf(canonColl)) {
      if (!canonEqual(canonColl, f, R[f] ?? null, B[f] ?? null) && !seen[f]) seen[f] = lastUpdated(obj) || new Date().toISOString();
    }
  }
  const prev = link.prev_values || {};
  const result = threeWayMerge(canonColl, B, L, R, {
    localAt: record.data.updatedAt || null, remoteAt: seen, prevValues: prev, stale: Boolean(o.stale), held: o.held, remoteAlias: meta.remoteAlias || null,
  });
  if (meta.remoteAlias && result.aliasDropped.length) {
    meta.remoteAlias = { ...meta.remoteAlias };
    for (const f of result.aliasDropped) delete meta.remoteAlias[f];
  }

  if (result.conflicts.length) {
    // A held device value is shown against what Fishtape had before the pull (5.2).
    const conflicts = result.conflicts.map((c) => (o.held && Object.prototype.hasOwnProperty.call(prev, c.field) ? { ...c, base: prev[c.field] } : c));
    run.stats.conflicts++;
    if (run.shadow) {
      await shadowLog(run, { direction, action: 'conflict', collection, recordId: link.record_id, label, message: `Would open a conflict: ${conflicts.map((c) => c.field).join(', ')}` });
      return 'conflict';
    }
    await txWrite(run, async (tx) => {
      // Device values held by records.js stay with the link until a person decides (5.2).
      const heldNow = o.held && Object.keys(o.held).length ? { ...(meta.held || {}), ...o.held } : meta.held;
      await updateLink(tx, run, link.id, { state: 'conflict', meta: { ...meta, fieldSeenAt: seen, ...(heldNow ? { held: heldNow } : {}) } });
      await openConflict(tx, run, { ...link, state: 'conflict' }, { kind: 'fields', label, fields: conflictRows(canonColl, conflicts) });
      await finishOutbox(tx, run, row);
      await writeLog(tx, { direction, outcome: 'conflict', action: 'conflict', actorType: row?.actor_type, collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: `Changed on both sides: ${conflicts.map((c) => c.field).join(', ')}` });
    });
    return 'conflict';
  }

  let toRemote = link.owner === 'quickbooks' || link.owner === 'none' ? [] : result.toRemote;
  let toLocal = result.toLocal;
  const pushOnly = PUSH_ONLY_COLLECTIONS.includes(canonColl);
  // Push-only records: a QuickBooks-side edit is logged and overwritten by the next Fishtape change,
  // never pulled back and never pushed from a pull alone (4.3, 4.11). A purchase order's status is pulled.
  if (pushOnly && direction === 'pull') {
    const localMoved = fieldsOf(canonColl).some((f) => !canonEqual(canonColl, f, L[f] ?? null, (B || {})[f] ?? null));
    if (!localMoved) {
      const remoteMoved = toRemote.length > 0;
      toRemote = [];
      if (remoteMoved && !toLocal.length) {
        if (run.shadow) return link.state;
        await txWrite(run, (tx) => writeLog(tx, { direction: 'pull', outcome: 'warning', action: 'remote_edit_ignored', collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: 'Changed in QuickBooks; Fishtape keeps its copy and sends it with the next change.' }));
        return link.state;
      }
    }
  }

  // Holds before anything is sent (4.7, 4.8, 4.11), unless a person approved (force).
  if (toRemote.length && !o.force) {
    const hold = await remoteHolds(run, link, collection, record.data, L, R, B, toRemote, obj);
    if (hold) {
      if (hold.conflict) {
        if (run.shadow) return 'conflict';
        await txWrite(run, async (tx) => {
          await updateLink(tx, run, link.id, { state: 'conflict' });
          await openConflict(tx, run, link, { kind: hold.conflict, label, reason: hold.reason, fields: hold.fields || [] });
          await finishOutbox(tx, run, row);
          await writeLog(tx, { direction, outcome: 'conflict', action: 'conflict', collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: hold.message });
        });
        run.stats.conflicts++;
        return 'conflict';
      }
      await holdLink(run, { link, collection, recordId: link.record_id, entity: link.qbo_entity, row, state: hold.state, reason: hold.reason, message: hold.message, label, review: hold.state === 'needs_review' ? { message: hold.message } : null });
      return hold.state;
    }
  }

  const ctxWrite = ctxFor(run, link, collection);
  let written = obj;
  let built = null;
  let patchedVersion = null;
  let patch = null;
  const report = {};

  // QuickBooks side.
  if (toRemote.length) {
    if (collection === 'invoices' && toRemote.includes('status') && L.status === 'void') {
      return voidLocalInvoice(run, link, record, obj, { row, label });
    }
    built = canonToQbo(collection, result.merged, ctxWrite, { existing: obj, fields: toRemote, ...(await run.db.withTenant({ tenantId: run.tenantId }, (tx) => writeOpts(run, tx, collection, record.data, B))) });
    if (built.error) {
      await holdLink(run, { link, collection, recordId: link.record_id, entity: link.qbo_entity, row, state: 'error', reason: built.error, message: built.error === 'number_too_long' ? 'The number is longer than QuickBooks allows (21 characters).' : 'QuickBooks cannot take this document as it is.', label });
      return 'error';
    }
    if (run.shadow) {
      await shadowLog(run, { direction, action: 'update', collection, recordId: link.record_id, label, message: `Would update QuickBooks: ${toRemote.join(', ')}` });
    } else {
      checkBrake(run);
      const body = { ...built.body, Id: obj.Id, SyncToken: obj.SyncToken };
      try {
        written = await run.client.update(link.qbo_entity, body, { requestId: requestIdFor([run.tenantId, link.id, 'update', record.version, obj.SyncToken]), sparse: built.sparse });
        countWrite(run);
      } catch (e) {
        if (e instanceof QboError && e.kind === 'stale' && (o.attempt || 0) < 2) {
          // 5010: the object moved; merge again with the fresh copy (5.8).
          return reconcile(run, link, { ...o, remote: null, attempt: (o.attempt || 0) + 1, record });
        }
        throw e;
      }
      if ((DOCS.has(collection) || collection === 'bills') && (toRemote.includes('lines') || toRemote.includes('taxes'))) {
        const tax = await taxAfterWrite(run, link, collection, record.data, written, { requestParts: ['update', record.version], L });
        written = tax.obj;
        if (tax.outcome === 'mismatch') {
          await txWrite(run, async (tx) => {
            await updateLink(tx, run, link.id, { state: 'error', reason: 'tax_mismatch', sync_token: written.SyncToken, qbo_updated_at: lastUpdated(written), last_error: 'QuickBooks tax differs from Fishtape by more than 2 cents. Check the tax code mapping.' });
            await finishOutbox(tx, run, row);
            await writeLog(tx, { direction, outcome: 'error', action: 'update', collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: 'QuickBooks tax differs by more than 2 cents', errorCode: 'tax_mismatch' });
            await notify(tx, { role: ['owner', 'admin', 'office'], kind: 'quickbooks', link: '#/quickbooks/activity', ref: `qbo:tax:${link.id}:${record.version}`, title: `QuickBooks tax doesn't match on ${label}`, body: 'Check the tax code mapping in QuickBooks settings.' });
          });
          return 'error';
        }
        if (tax.outcome === 'delta') meta.taxDeltaCents = tax.deltaCents;
        else if (tax.outcome === 'overridden' || tax.outcome === 'equal') delete meta.taxDeltaCents;
      }
    }
  }

  // Fishtape side.
  if (toLocal.length) {
    patch = canonToFishtape(collection, result.merged, ctxWrite, { existing: record.data, fields: toLocal, report });
    if (Object.keys(patch).length) {
      const remoteAt = Date.parse(lastUpdated(obj) || '') || 0;
      const localAt = Date.parse(record.data.updatedAt || '') || 0;
      patch.updatedAt = new Date(Math.min(Date.now(), Math.max(remoteAt, localAt))).toISOString();
    }
  }

  if (run.shadow) {
    if (patch && Object.keys(patch).length) await shadowLog(run, { direction, action: 'pull_update', collection, recordId: link.record_id, label, message: `Would change Fishtape: ${toLocal.join(', ')}` });
    return link.state;
  }

  const final = await txWrite(run, async (tx) => {
    if (patch && Object.keys(patch).length > 1) {
      checkBrake(run);
      try {
        const v = await system.patch(tx, run, collection, link.record_id, patch);
        patchedVersion = v.version;
        countWrite(run);
      } catch (e) {
        const why = moduleRefusal(e);
        if (!why) throw e;
        await updateLink(tx, run, link.id, { state: 'blocked', reason: why === 'plan' ? 'module_off' : why });
        await finishOutbox(tx, run, row);
        return { state: 'blocked', planDrop: why === 'plan' };
      }
      if (collection === 'payments' && record.data.invoiceId) await system.refreshInvoice(tx, run, record.data.invoiceId);
      if (collection === 'invoices' && toLocal.includes('lines')) await system.refreshInvoice(tx, run, link.record_id);
    }
    const newMeta = { ...meta, ...linkMetaFromQbo(link.qbo_entity, written, ctxWrite, { pushed: built }) };
    if (written?.CustomerRef) newMeta.customerRef = ref(written.CustomerRef);
    newMeta.fieldSeenAt = {};
    if (patchedVersion != null) {
      const pulled = { ...(newMeta.pulledKeys || {}) };
      for (const k of recordKeysOf(collection, toLocal, patch)) pulled[k] = patchedVersion;
      newMeta.pulledKeys = pulled;
    }
    delete newMeta.dependsOn;
    const prevValues = { ...prev };
    for (const f of toRemote) delete prevValues[f];
    for (const f of toLocal) prevValues[f] = L[f] ?? null;
    let state = 'synced';
    let owner = link.owner;
    let reason = null;
    if (report.taxShape && link.owner !== 'quickbooks') { state = 'needs_review'; owner = 'quickbooks'; reason = 'tax_shape'; }
    const updated = await updateLink(tx, run, link.id, {
      ...(collection === 'payments' && link.role === 'main' && link.qbo_entity === 'Payment' && result.merged.invoiceRef ? { qbo_line: String(result.merged.invoiceRef) } : {}),
      snapshot: { ...result.merged, extra: L.extra }, sync_token: written?.SyncToken ?? link.sync_token, qbo_updated_at: lastUpdated(written),
      fishtape_version: patchedVersion ?? record.version, state, reason, owner, attempts: 0, last_error: null, next_attempt_at: null,
      meta: newMeta, prev_values: prevValues,
    });
    if (state === 'needs_review') await openReview(tx, run, updated, { reason, label, message: 'QuickBooks uses tax codes Fishtape cannot show exactly on this document.' });
    if (link.state === 'conflict') await closeConflict(tx, link.id, 'system');
    if (link.state !== 'synced' && state === 'synced') await requeueDependents(tx, link);
    await finishOutbox(tx, run, row);
    if (toRemote.length) {
      run.stats.pushed++;
      await writeLog(tx, { direction: 'push', outcome: 'ok', action: 'update', actorType: row?.actor_type || 'system', collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: `Updated in QuickBooks: ${toRemote.join(', ')}${built?.warnings?.length ? `. ${built.warnings.join('; ')}` : ''}`, intuitTid: run.client.lastIntuitTid });
    }
    if (patchedVersion != null) {
      run.stats.pulled++;
      await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'pull_update', collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message: `Updated from QuickBooks: ${toLocal.join(', ')}` });
    }
    return { state };
  });
  if (final.planDrop) await setPaused(run.db, run.tenantId, true, 'plan').catch(() => {});
  return final.state;
}

/** Holds checked before a QuickBooks write (4.7, 4.8, 4.9, 4.11). Null when the write may go. */
async function remoteHolds(run, link, collection, doc, L, R, B, toRemote, obj) {
  const filed = taxFiledThrough(run.ctx.features, run.ctx.mappings);
  const money = ['lines', 'date', 'taxes', 'number', 'amountCents'];
  if ((DOCS.has(collection) || collection === 'bills') && filed) {
    const dates = [L.date, B?.date, R.date].filter(Boolean);
    if (dates.some((d) => d <= filed) && toRemote.some((f) => money.includes(f))) {
      return { state: 'needs_review', reason: 'filed_period', message: 'This changes a GST period already filed.' };
    }
  }
  if (collection === 'timeEntries') {
    const locked = str(optionOf(run.ctx.mappings, 'timeLockedThrough', null));
    if (locked && [L.date, B?.date].some((d) => d && d <= locked)) return { state: 'needs_review', reason: 'payroll_locked', message: 'Hours already paid; change them in QuickBooks Payroll if needed.' };
  }
  if (collection === 'invoices') {
    const hasPayments = R.extra?.balanceCents != null && R.extra.totalCents != null && R.extra.balanceCents < R.extra.totalCents;
    if (hasPayments && (toRemote.includes('clientRef') || toRemote.includes('jobRef'))) {
      return { conflict: 'fields', reason: 'customer_change', message: "QuickBooks can't move an invoice with payments to another customer.", fields: [{ field: 'clientRef', label: 'Customer', base: 'Same customer', fishtape: 'Another customer', quickbooks: "QuickBooks can't move an invoice with payments to another customer" }] };
    }
  }
  if (DOCS.has(collection) && toRemote.includes('lines')) {
    const msg = taxCheck(run, doc, collection === 'invoices' ? 'invoice' : 'estimate');
    if (msg) return { state: 'blocked', reason: 'mapping_missing', message: msg };
  }
  if (collection === 'payments' && (toRemote.includes('amountCents') || toRemote.includes('invoiceRef'))) {
    const deposited = obj?.DepositToAccountRef && run.ctx.mappings.depositTo && !Object.values(run.ctx.mappings.depositTo).map(String).includes(ref(obj.DepositToAccountRef))
      && ref(obj.DepositToAccountRef) !== String(run.ctx.mappings.account?.stripeClearing || '');
    if (deposited) return { conflict: 'fields', reason: 'deposited', message: 'Deposited in QuickBooks; change it there.', fields: [{ field: 'amountCents', label: 'Amount', base: '', fishtape: 'Changed in Fishtape', quickbooks: 'Deposited in QuickBooks; change it there' }] };
  }
  return null;
}

/** QuickBooks voided the invoice (4.7): Fishtape's status becomes void, nothing else. */
async function voidedRemote(run, link, record, obj, { row, label, B }) {
  if (record.data.status !== 'void' && B?.status === 'void') {
    // Set back from void in Fishtape: QuickBooks cannot un-void.
    if (run.shadow) return 'conflict';
    await txWrite(run, async (tx) => {
      await updateLink(tx, run, link.id, { state: 'conflict' });
      await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'voided_remote', fields: [{ field: 'status', label: 'Status', base: 'Void', fishtape: 'Open', quickbooks: 'Voided in QuickBooks. Create a new invoice in QuickBooks?' }] });
      await finishOutbox(tx, run, row);
    });
    return 'conflict';
  }
  if (run.shadow) {
    if (record.data.status !== 'void') await shadowLog(run, { direction: 'pull', action: 'pull_update', collection: 'invoices', recordId: link.record_id, label, message: 'Would mark void (voided in QuickBooks)' });
    return link.state;
  }
  return txWrite(run, async (tx) => {
    let version = record.version;
    if (record.data.status !== 'void') {
      checkBrake(run);
      version = (await system.patch(tx, run, 'invoices', link.record_id, { status: 'void' })).version;
      countWrite(run);
      await writeLog(tx, { direction: 'pull', outcome: 'ok', action: 'pull_update', collection: 'invoices', recordId: link.record_id, qboEntity: 'Invoice', label, message: 'Voided in QuickBooks' });
    }
    await updateLink(tx, run, link.id, {
      snapshot: { ...(B || {}), status: 'void' }, sync_token: obj.SyncToken, qbo_updated_at: lastUpdated(obj), fishtape_version: version, state: 'synced', reason: null,
      meta: { ...(link.meta || {}), qboTotalCents: 0, qboBalanceCents: 0 },
    });
    await finishOutbox(tx, run, row);
    return 'synced';
  });
}

/** A Fishtape void (or delete) of a linked invoice (4.7): QuickBooks void only while nothing is applied. */
export async function voidLocalInvoice(run, link, record, obj, { row, label, deleting = false }) {
  const unpaid = toCents(obj.Balance) === toCents(obj.TotalAmt);
  if (!unpaid) {
    if (run.shadow) return 'conflict';
    await txWrite(run, async (tx) => {
      if (deleting) await system.restore(tx, run, 'invoices', link.record_id);
      await updateLink(tx, run, link.id, { state: 'conflict' });
      await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'has_payments', fields: [{ field: 'status', label: 'Status', base: 'Open', fishtape: deleting ? 'Deleted' : 'Void', quickbooks: 'This invoice has payments in QuickBooks. Remove them there first, or keep it open.' }] });
      await finishOutbox(tx, run, row);
      await writeLog(tx, { direction: 'push', outcome: 'conflict', action: 'void', collection: 'invoices', recordId: link.record_id, qboEntity: 'Invoice', label, message: 'Has payments in QuickBooks; not voided' });
    });
    run.stats.conflicts++;
    return 'conflict';
  }
  if (run.shadow) { await shadowLog(run, { direction: 'push', action: 'void', collection: 'invoices', recordId: link.record_id, label, message: 'Would void in QuickBooks' }); return link.state; }
  checkBrake(run);
  let voided;
  try {
    voided = await run.client.voidTxn('Invoice', { Id: obj.Id, SyncToken: obj.SyncToken }, { requestId: requestIdFor([run.tenantId, link.id, 'void', record.version, obj.SyncToken]) });
    countWrite(run);
  } catch (e) {
    if (e instanceof QboError && !e.retry && passStopFor(e) == null) {
      // QuickBooks refused (closed books, a deposit): Fishtape never shows it gone while it is open there.
      await txWrite(run, async (tx) => {
        if (deleting) await system.restore(tx, run, 'invoices', link.record_id);
        else await system.patch(tx, run, 'invoices', link.record_id, { status: record.data.status === 'void' ? 'sent' : record.data.status });
        await updateLink(tx, run, link.id, { state: 'conflict' });
        await openConflict(tx, run, link, { kind: 'deleted', label, reason: 'refused', fields: [{ field: 'status', label: 'Status', base: 'Open', fishtape: deleting ? 'Deleted' : 'Void', quickbooks: `QuickBooks refused: ${e.message}` }] });
        await finishOutbox(tx, run, row);
      });
      return 'conflict';
    }
    throw e;
  }
  await txWrite(run, async (tx) => {
    await updateLink(tx, run, link.id, {
      state: deleting ? 'deleted_local' : 'synced', reason: null, sync_token: voided?.SyncToken ?? obj.SyncToken, qbo_updated_at: lastUpdated(voided),
      snapshot: { ...(link.snapshot || {}), status: 'void' }, fishtape_version: record.version,
    });
    await finishOutbox(tx, run, row);
    await writeLog(tx, { direction: 'push', outcome: 'ok', action: 'void', collection: 'invoices', recordId: link.record_id, qboEntity: 'Invoice', label, message: 'Voided in QuickBooks' });
  });
  return deleting ? 'deleted_local' : 'synced';
}

/** A pulled document Fishtape cannot represent exactly: QuickBooks is the truth until a person decides. */
async function reviewFromRemote(run, link, { row, reason, label, obj, message }) {
  if (run.shadow) return 'needs_review';
  await txWrite(run, async (tx) => {
    const l = await updateLink(tx, run, link.id, { state: 'needs_review', reason, owner: 'quickbooks', sync_token: obj?.SyncToken ?? link.sync_token, qbo_updated_at: lastUpdated(obj) });
    await openReview(tx, run, l, { reason, label, message });
    await finishOutbox(tx, run, row);
    await writeLog(tx, { direction: 'pull', outcome: 'warning', action: 'review', collection: link.collection, recordId: link.record_id, qboEntity: link.qbo_entity, label, message, errorCode: reason });
  });
  return 'needs_review';
}

// ---- the public engine API (12.4) --------------------------------------------------------------------

/**
 * One sync pass (5.1). deps = { db, sealer, config, records, now?, log? }.
 * @param {{ budgetMs?, epoch, sweep?, direction?: 'both'|'push'|'pull', purpose? }} o
 * @returns {Promise<{ pushed, pulled, conflicts, errors, shadow, more?, stopped? }>}
 */
export async function syncTenant(deps, tenantId, o = {}) {
  const run = await makeRun(deps, tenantId, { epoch: o.epoch, budgetMs: o.budgetMs, purpose: o.purpose || 'sync', workerId: o.workerId });
  const empty = { pushed: 0, pulled: 0, conflicts: 0, errors: 0, shadow: 0 };
  if (!run) return { ...empty, skipped: 'not_connected' };
  if (run.conn.state !== 'active') return { ...empty, skipped: run.conn.state };
  const direction = o.direction || 'both';
  let more = false;
  try {
    if (o.sweep) await runSweep(deps, tenantId, { run });
    if (direction !== 'push') await runPull(run, { full: Boolean(o.full) });
    if (direction !== 'pull' && !timeUp(run)) more = await runPush(run);
    if (direction === 'both' && run.wrote && !timeUp(run)) await runPull(run, {});
    if (timeUp(run)) more = true;
  } catch (e) {
    await releaseClaims(run);
    if (e instanceof BrakeError) {
      await tripBrake(run, e.count);
      return { ...run.stats, stopped: 'brake' };
    }
    const stop = e instanceof PassStop ? e : passStopFor(e);
    if (stop) return { ...run.stats, stopped: stop.reason, error: stop.cause || null };
    if (e instanceof FencedError) return { ...run.stats, stopped: 'fenced' };
    throw e;
  }
  await releaseClaims(run);
  return { ...run.stats, more };
}

/** Rows this pass claimed but did not finish go back at once (a stopped pass, 5.3). */
async function releaseClaims(run) {
  if (run.shadow) return;
  await run.db.withTenant({ tenantId: run.tenantId }, (tx) => tx.query(
    'UPDATE qbo_outbox SET claimed_until = NULL, claimed_epoch = NULL WHERE tenant_id = $1 AND claimed_epoch = $2', [run.tenantId, run.epoch])).catch(() => {});
}

/** The safety brake (5.8): pause, log the counts, tell the office and HQ. */
export async function tripBrake(run, count) {
  const waiting = await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM qbo_outbox WHERE tenant_id = $1', [tx.tenantId])).rows[0].n);
  const allowCount = Math.max(count, run.brake.count + waiting);
  await setPaused(run.db, run.tenantId, true, 'brake', { allowCount });
  await run.db.withTenant({ tenantId: run.tenantId }, async (tx) => {
    await writeLog(tx, { direction: 'system', outcome: 'warning', action: 'safety_brake', message: `Stopped after ${run.brake.count} changes in an hour; ${waiting} waiting. Confirm "Allow ${allowCount} changes" to continue.` });
    await platformEvent(tx, 'safety_brake', run.conn.environment, run.tenantId);
    await appendAudit(tx, run.tenantId, { actor: QBO_ACTOR, action: 'qbo.safety_brake', collection: 'qbo_connections', summary: `QuickBooks sync paused by the safety brake (${allowCount} changes)` });
    await notify(tx, {
      role: ['owner', 'admin', 'office'], kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:brake:${new Date().toISOString().slice(0, 13)}`,
      title: 'QuickBooks sync paused: unusually many changes', body: `${allowCount} changes in an hour. Check the activity, then resume and allow them if they are expected.`,
    });
  });
}

/**
 * Reconcile one link by id (API: relink, resolve, Retry). Takes no lease itself: the caller holds it.
 * @returns {Promise<string>} the link state
 */
export async function reconcileLink(deps, tenantId, linkId, { remote = null, force = false, epoch } = {}) {
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'sync' });
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  const link = await run.db.withTenant({ tenantId }, (tx) => getLinkById(tx, linkId));
  if (!link) throw new ApiError(404, 'not_found', 'Not found.');
  try {
    if (!link.qbo_id) return await processRecord(run, link.collection, link.record_id, { force });
    return await reconcile(run, link, { remote, force, direction: 'push' });
  } catch (e) {
    if (e instanceof BrakeError) { await tripBrake(run, e.count); return 'paused'; }
    if (e instanceof PassStop && e.cause) throw e.cause;
    throw e;
  }
}

/**
 * Push one record now (Send now, Retry, Send as new). `asNew` replaces an unlinked tombstone with a
 * fresh create. Takes no lease itself: the caller holds it.
 */
export async function pushRecord(deps, tenantId, collection, id, { force = false, asNew = false, epoch } = {}) {
  const run = await makeRun(deps, tenantId, { epoch, purpose: 'sync' });
  if (!run) throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
  if (asNew) {
    await txWrite(run, async (tx) => {
      const l = await getLink(tx, collection, id);
      if (!l || l.state !== 'unlinked') throw new ApiError(409, 'qbo_not_unlinked', 'Only a record unlinked from QuickBooks can be sent as new.');
      await tx.query('DELETE FROM qbo_links WHERE tenant_id = $1 AND id = $2', [tx.tenantId, l.id]);
      run.index.byRecord.delete(k3(collection, 'main', id));
    });
  }
  try {
    return await processRecord(run, collection, id, { force, sendNow: force });
  } catch (e) {
    if (e instanceof BrakeError) { await tripBrake(run, e.count); return 'paused'; }
    if (e instanceof PassStop && e.cause) throw e.cause;
    throw e;
  }
}

/**
 * The amount-due adjustment (4.9), registered with W6's registerAmountDueAdjuster: an invoice whose
 * QuickBooks tax differed by a cent and could not be overridden is owed at the QuickBooks total.
 */
export async function amountDueAdjustment(tx, invoiceId) {
  const { rows } = await tx.query(
    "SELECT meta->>'taxDeltaCents' AS d FROM qbo_links WHERE tenant_id = $1 AND collection = 'invoices' AND record_id = $2 AND role = 'main' AND state NOT IN ('unlinked', 'deleted_local')",
    [tx.tenantId, invoiceId]);
  const n = Number.parseInt(rows[0]?.d ?? '0', 10);
  return Number.isInteger(n) ? n : 0;
}

/** Enqueue the next part of a long pass under its own key (the running job holds qbo_sync:<id>, 5.8). */
export function enqueueContinuation(q, tenantId) {
  return enqueue(q, { kind: 'qbo_sync', tenantId, dedupeKey: `qbo_sync:${tenantId}:cont`, runAt: new Date(Date.now() + 5_000), maxAttempts: 5 });
}

export { entityFor };
