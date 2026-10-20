// QuickBooks routes for the office (docs/integrations/quickbooks.md 7.4 to 7.8): the setup wizard,
// sync now, per-record states and views, link / unlink / renumber / retry, the "Doesn't match" list,
// the log, mappings and reference lists, conflicts, and live look-ups. Owner, admin and office
// sessions only (requireQboRole): field roles, crew sessions and API keys get 403. Everything that
// changes something needs a two-step-verified session (403 mfa_required) and, for actions that write
// to either side, the tenant lease (wait up to 10 s, else 409 qbo_busy). Every route needs the
// quickbooks plan feature (403 feature_not_in_plan) and a server with QuickBooks on (503).
// Nothing here is given to the assistant, MCP or API keys (10.1); search terms travel in POST bodies.
import { ApiError, forbidden, notFound, validationFailed } from '../../errors.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { requireFeature } from '../../services/entitlements.js';
import { enqueue } from '../../services/queue.js';
import { qboCfg } from '../../qbo/env.js';
import { QboError, createQboClient } from '../../qbo/client.js';
import { requireQboRole, QBO_ADMIN_ROLES } from '../../qbo/roles.js';
import { loadConnection, enqueueSync } from '../../qbo/connection.js';
import { acquireLease, releaseLease } from '../../qbo/lease.js';
import { QBO_COLLECTIONS } from '../../qbo/hooks.js';
import { logEntry, writeLog } from '../../qbo/log.js';
import { makeRun, pushRecord, loadMappings, requeueStuck } from '../../qbo/engine.js';
import { conflictView, resolveConflict, relinkRecord, unlinkRecord } from '../../qbo/conflicts.js';
import { checkList } from '../../qbo/check.js';
import { lookup, importRemote, renumber } from '../../qbo/lookup.js';
import { listMatches, updateMatches, plan, assertReadyToApply, scanWaitS, enqueueApply, requiredMappings } from '../../qbo/wizard.js';
import { companyTaxKeys, suggestTaxCodes, codeMatchesKey, purchaseCodeClaimsPst, salesRateIds, purchaseRateIds, ratePct, parseTaxKey } from '../../qbo/map/tax.js';
import { qboAvailable } from './qbo-connect.js';
import { errorResponses, tenantCtx } from '../util.js';

const tags = ['quickbooks'];
const RECORD_COLLECTIONS = [...QBO_COLLECTIONS, 'employees'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEASE_WAIT_MS = 10_000;
const MAPPING_KINDS = ['item', 'taxCode', 'purchaseTaxCode', 'account', 'paymentMethod', 'depositTo', 'paidFrom', 'class', 'department', 'term', 'option'];
const KEY_RE = /^[A-Za-z0-9+|._:-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_KEYS = ['income.default', 'expense.default', 'jobCost.material', 'jobCost.subcontract', 'jobCost.equipment', 'jobCost.other', 'stripeClearing', 'stripeFees', 'stripePayoutBank'];
const METHOD_KEYS = ['cash', 'check', 'card', 'transfer', 'e-transfer', 'other'];
const PAID_FROM_KEYS = ['card', 'cash', 'cheque', 'debit', 'transfer'];
const ITEM_KEYS = ['material', 'labour', 'other', 'markup', 'travel', 'deposit'];
const DATE = { type: 'date' };
const OPTIONS = {
  syncFrom: DATE, stripeCutover: DATE, timeLockedThrough: DATE, taxFiledThrough: DATE,
  importCustomers: { enum: ['active', 'all'] }, numbering: { enum: ['fishtape', 'quickbooks'] }, jobsAsSubCustomers: { type: 'boolean' },
  items: { enum: ['on_use', 'all'] }, pushDrafts: { type: 'boolean' }, syncTime: { type: 'boolean' }, timeOwner: { enum: ['fishtape', 'quickbooks'] },
  pullJobCosts: { type: 'boolean' }, recordStripeFees: { type: 'boolean' }, recordStripePayouts: { type: 'boolean' }, writeMode: { enum: ['live', 'shadow'] },
};
const ACCOUNT_TYPES = {
  'income.default': ['Income'], 'expense.default': ['Expense', 'Other Expense', 'Cost of Goods Sold'], stripeClearing: ['Bank'], stripePayoutBank: ['Bank'], stripeFees: ['Expense'],
};
const WEB_PATH = {
  Invoice: 'invoice?txnId=', Estimate: 'estimate?txnId=', Payment: 'recvpayment?txnId=', Bill: 'bill?txnId=', Purchase: 'expense?txnId=',
  PurchaseOrder: 'purchaseorder?txnId=', TimeActivity: 'timeactivity?txnId=', Transfer: 'transfer?txnId=', Customer: 'customerdetail?nameId=',
  Vendor: 'vendordetail?nameId=', Employee: 'employeedetail?nameId=', Item: 'items?itemId=',
};
const REASON_TEXT = {
  dependency: 'Waiting for a record it needs.', employee_not_linked: 'The employee is not linked to QuickBooks.', mapping_missing: 'A QuickBooks mapping is missing or does not match.',
  tax_reason: 'Pick why this has no tax.', feature_missing: "Not available on the company's QuickBooks plan.", module_off: 'That module is turned off.',
  currency: 'Not in Canadian dollars.', books_closed: 'The books are closed in QuickBooks for this date.', no_invoice: 'Not sent: no invoice.',
  duplicate_number_local: 'Another Fishtape document has this number. Renumber it.', totals_mismatch: "Bill total doesn't add up.", stripe_unbooked: 'Waiting for its card payments to reach QuickBooks.',
  tax_shape: 'QuickBooks uses tax codes Fishtape cannot show exactly.', totals_differ: 'Totals differ from QuickBooks.', tax_inclusive: 'Tax-inclusive in QuickBooks.',
  filed_period: 'This changes a GST period already filed.', payroll_locked: 'Hours already paid.', origin: 'Waiting for an office user to approve it.',
  payout_items: 'The payout holds items to enter in QuickBooks.', wizard_differs: 'Differs from QuickBooks; choose which to keep.', name_taken: 'The name is taken in QuickBooks.',
  tax_mismatch: 'QuickBooks tax differs from Fishtape.', duplicate_number: 'QuickBooks already has this number. Renumber it.', open_balance: 'Customer has an open balance in QuickBooks.',
};

/** QuickBooks failures as API errors (7.1). */
function apiError(e) {
  if (!(e instanceof QboError)) return e;
  if (e.kind === 'throttled') return new ApiError(429, 'qbo_throttled', e.message, { retryAfterS: e.retryAfterS || 60 });
  if (e.kind === 'budget') return new ApiError(429, e.variant === 'lookup' ? 'lookup_budget' : 'qbo_budget', e.message);
  if (e.kind === 'auth') return new ApiError(409, 'qbo_reconnect_needed', e.message);
  if (e.kind === 'not_found') return new ApiError(404, 'not_found', e.message);
  if (e.kind === 'unavailable' && e.variant === 'not_connected') return new ApiError(409, 'qbo_not_connected', e.message);
  if (e.kind === 'unavailable') return new ApiError(502, 'qbo_unavailable', e.message);
  return new ApiError(502, e.code || 'qbo_error', e.message);
}
const wrap = (fn) => async (req, reply) => { try { return await fn(req, reply); } catch (e) { throw apiError(e); } };

/** @param {import('fastify').FastifyInstance} app */
export default async function qboRoutes(app, { config, db, records }) {
  const deps = { db, sealer: app.sealer, config, records };
  const feature = requireFeature(db, 'quickbooks');
  const available = qboAvailable(config);
  const read = { config: { auth: 'manager', apiKey: false }, preHandler: [requireQboRole('office'), available, feature] };
  const write = { config: { auth: 'manager', apiKey: false }, preHandler: [requireQboRole('office', { write: true }), available, feature] };
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);
  const who = (req) => ({ actor: req.principal.actor, request: requestFacts(req) });
  const conn = (req) => inTenant(req, loadConnection);

  async function needConnection(req, { active = false } = {}) {
    const c = await conn(req);
    if (!c || c.state === 'disconnected') throw new ApiError(409, 'qbo_not_connected', 'QuickBooks is not connected.');
    if (c.state === 'reconnect_needed') throw new ApiError(409, 'qbo_reconnect_needed', 'Reconnect to QuickBooks first.');
    if (active && c.state === 'setup') throw new ApiError(409, 'qbo_not_ready', 'Finish setting up QuickBooks first.');
    if (active && c.state === 'paused') throw new ApiError(409, 'qbo_paused', 'QuickBooks sync is paused.', { pauseReason: c.pause_reason });
    return c;
  }

  /** API actions that write take the tenant lease (5.8): wait up to 10 s, else 409 qbo_busy. */
  async function withApiLease(req, fn) {
    const tenantId = req.principal.tenantId;
    const lease = await acquireLease(db, tenantId, `api:${req.id}`, { waitMs: LEASE_WAIT_MS });
    if (!lease) throw new ApiError(409, 'qbo_busy', 'QuickBooks sync is busy; try again in a minute.');
    try { return await fn(lease.epoch); } finally { await releaseLease(db, tenantId, lease.epoch); }
  }

  const collectionParam = (req) => {
    const { collection, id } = req.params;
    if (!RECORD_COLLECTIONS.includes(collection)) throw notFound('Unknown collection.');
    if (!ID_RE.test(String(id))) throw notFound();
    return { collection, id };
  };
  const recordParams = { type: 'object', required: ['collection', 'id'], properties: { collection: { type: 'string', maxLength: 40 }, id: { type: 'string', maxLength: 128 } } };

  // ---- setup wizard (7.4) --------------------------------------------------------------------------

  app.post('/api/v1/qbo/setup/scan', { ...write, schema: { tags, summary: 'Scan QuickBooks and Fishtape for matches (at most every 15 minutes)', response: errorResponses } }, wrap(async (req, reply) => {
    const c = await needConnection(req);
    if (c.state !== 'setup') throw new ApiError(409, 'qbo_not_ready', 'The scan runs during setup only.');
    const wait = scanWaitS(c);
    if (wait) throw new ApiError(429, 'qbo_throttled', 'The scan ran recently. Try again shortly.', { retryAfterS: wait });
    await inTenant(req, async (tx) => {
      await tx.query("UPDATE qbo_connections SET last_scan_at = now(), setup = setup || '{\"phase\":\"scan_queued\"}'::jsonb WHERE tenant_id = $1", [tx.tenantId]);
      await enqueue(tx, { kind: 'qbo_setup_scan', tenantId: tx.tenantId, dedupeKey: `qbo_setup_scan:${tx.tenantId}`, maxAttempts: 3 });
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.setup.scan', collection: 'qbo_connections', summary: 'Started the QuickBooks matching scan', request: requestFacts(req) });
    });
    reply.code(202);
    return { setup: (await conn(req)).setup };
  }));

  app.get('/api/v1/qbo/setup/matches', {
    ...read,
    schema: {
      tags, summary: 'Matching candidates of the last scan',
      querystring: { type: 'object', properties: { kind: { type: 'string', maxLength: 20 }, status: { type: 'string', maxLength: 20 }, choice: { type: 'string', maxLength: 30 }, cursor: { type: 'string', maxLength: 20 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
      response: errorResponses,
    },
  }, wrap(async (req) => { await needConnection(req); return inTenant(req, (tx) => listMatches(tx, req.query || {})); }));

  app.put('/api/v1/qbo/setup/matches', {
    ...write,
    schema: { tags, summary: 'Change match choices, field choices and filed-period ticks (one by one or in bulk)', body: { type: 'object', properties: { choices: { type: 'array', maxItems: 500 }, bulk: { type: 'object' } } }, response: errorResponses },
  }, wrap(async (req) => {
    await needConnection(req);
    return inTenant(req, async (tx) => {
      const r = await updateMatches(tx, req.body, `${req.principal.actor.type}:${req.principal.actor.id}`);
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.setup.matches', collection: 'qbo_candidates', summary: `Changed ${r.updated} QuickBooks match choice(s)`, request: requestFacts(req) });
      return r;
    }, { write: true });
  }));

  app.get('/api/v1/qbo/setup/plan', { ...read, schema: { tags, summary: 'What apply will do, with warnings', response: errorResponses } }, wrap(async (req) => {
    await needConnection(req);
    return plan(deps, req.principal.tenantId);
  }));

  app.post('/api/v1/qbo/setup/apply', {
    ...write,
    schema: { tags, summary: 'Apply the setup choices (links, then creates both ways)', body: { type: 'object', additionalProperties: false, properties: { raiseNumbers: { type: 'boolean' } } }, response: errorResponses },
  }, wrap(async (req, reply) => {
    const c = await needConnection(req);
    if (c.state !== 'setup' && c.setup?.phase !== 'shadow_linked') throw new ApiError(409, 'qbo_not_ready', 'Setup is already applied.');
    await inTenant(req, async (tx) => {
      await assertReadyToApply(tx, c);
      if (req.body?.raiseNumbers) await raiseNumbers(tx, req);
      await tx.query("UPDATE qbo_connections SET setup = setup || '{\"phase\":\"apply_queued\",\"cancelRequested\":false}'::jsonb WHERE tenant_id = $1", [tx.tenantId]);
      await enqueueApply(tx, tx.tenantId);
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.setup.apply', collection: 'qbo_connections', summary: 'Started applying the QuickBooks setup', request: requestFacts(req) });
    }, { write: true });
    reply.code(202);
    return { setup: (await conn(req)).setup };
  }));

  app.post('/api/v1/qbo/setup/cancel', { ...write, schema: { tags, summary: 'Stop applying after the current chunk', response: errorResponses } }, wrap(async (req) => {
    await needConnection(req);
    await inTenant(req, (tx) => tx.query("UPDATE qbo_connections SET setup = setup || '{\"cancelRequested\":true}'::jsonb WHERE tenant_id = $1", [tx.tenantId]));
    return { setup: (await conn(req)).setup };
  }));

  /** Raise Fishtape's next numbers above QuickBooks' highest (6.4 numbering offer). */
  async function raiseNumbers(tx, req) {
    const s = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0]?.data;
    if (!s) return;
    const next = { ...(s.nextNumbers || {}) };
    for (const [kind, coll, prefix] of [['invoice', 'invoices', 'INV'], ['estimate', 'estimates', 'E']]) {
      const rows = (await tx.query("SELECT qbo_summary->>'docNumber' AS n FROM qbo_candidates WHERE tenant_id = $1 AND kind = $2", [tx.tenantId, coll])).rows;
      const top = rows.map((r) => { const m = new RegExp(`^(?:${prefix}-)?(\\d+)$`).exec(String(r.n || '')); return m ? Number(m[1]) : 0; }).reduce((a, b) => Math.max(a, b), 0);
      if (top && top + 1 > (Number(next[kind]) || 0)) next[kind] = top + 1;
    }
    await records.patchRecord(tx, req.principal, 'settings', 'settings', { nextNumbers: next }, {}, who(req));
  }

  // ---- sync, records and log (7.5) -------------------------------------------------------------------

  const pushAsked = new Map();
  app.post('/api/v1/qbo/sync', {
    ...write,
    schema: { tags, summary: 'Sync now', body: { type: 'object', additionalProperties: false, properties: { direction: { type: 'string', enum: ['both', 'push', 'pull'] } } }, response: errorResponses },
  }, wrap(async (req, reply) => {
    const c = await needConnection(req, { active: true });
    const direction = req.body?.direction || 'both';
    const tenantId = req.principal.tenantId;
    if (direction === 'push') {
      const last = pushAsked.get(tenantId) || 0;
      if (Date.now() - last < 60_000) throw new ApiError(429, 'qbo_throttled', 'Sync was asked for a moment ago.', { retryAfterS: Math.ceil((60_000 - (Date.now() - last)) / 1000) });
      pushAsked.set(tenantId, Date.now());
    } else if (c.last_manual_pull_at && Date.now() - new Date(c.last_manual_pull_at).getTime() < 5 * 60_000) {
      throw new ApiError(429, 'qbo_throttled', 'A pull from QuickBooks ran a moment ago.', { retryAfterS: Math.ceil((5 * 60_000 - (Date.now() - new Date(c.last_manual_pull_at).getTime())) / 1000) });
    }
    await inTenant(req, async (tx) => {
      if (direction !== 'push') await tx.query('UPDATE qbo_connections SET last_manual_pull_at = now(), dirty_at = COALESCE(dirty_at, now()) WHERE tenant_id = $1', [tx.tenantId]);
      await tx.query('UPDATE qbo_outbox SET not_before = now() WHERE tenant_id = $1 AND not_before > now()', [tx.tenantId]);
      await enqueueSync(tx, tx.tenantId);
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.sync', collection: 'qbo_connections', summary: `Asked QuickBooks to sync (${direction})`, request: requestFacts(req) });
    });
    reply.code(202);
    return { queued: true };
  }));

  async function recordStates(tx, collection, ids) {
    const params = [tx.tenantId, collection];
    let filter = '';
    if (ids) { params.push(ids); filter = ' AND l.record_id = ANY($3::text[])'; }
    const { rows } = await tx.query(
      `SELECT l.*, (SELECT c.id FROM qbo_conflicts c WHERE c.tenant_id = l.tenant_id AND c.link_id = l.id AND c.status = 'open' LIMIT 1) AS conflict_id
         FROM qbo_links l WHERE l.tenant_id = $1 AND l.collection = $2 AND l.role = 'main'${filter}`, params);
    return rows;
  }
  const stateOf = (l) => ({
    state: l.state, reason: l.reason, owner: l.owner, message: l.last_error || (l.reason ? REASON_TEXT[l.reason] || null : null),
    syncedAt: l.synced_at ? new Date(l.synced_at).toISOString() : null, conflictId: l.conflict_id || null, docNumber: l.meta?.docNumber || l.snapshot?.number || null,
    ...(l.meta?.mismatch ? { mismatch: l.meta.mismatch } : {}),
  });

  app.get('/api/v1/qbo/records/status', {
    ...read,
    schema: { tags, summary: 'Sync state per record of a collection', querystring: { type: 'object', required: ['collection'], properties: { collection: { type: 'string', maxLength: 40 }, ids: { type: 'string', maxLength: 26000 } } }, response: errorResponses },
  }, wrap(async (req) => {
    const { collection } = req.query;
    if (!RECORD_COLLECTIONS.includes(collection)) throw validationFailed('Unknown collection.');
    let ids = null;
    if (req.query.ids) {
      ids = String(req.query.ids).split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 200 || ids.some((x) => !ID_RE.test(x))) throw validationFailed('ids is a comma list of at most 200 record ids.');
    }
    const rows = await inTenant(req, (tx) => recordStates(tx, collection, ids));
    return { data: Object.fromEntries(rows.map((l) => [l.record_id, stateOf(l)])) };
  }));

  app.get('/api/v1/qbo/records/:collection/:id', {
    ...read,
    schema: { tags, summary: 'One record in QuickBooks: state, summary from the link, last log lines, open conflict', params: recordParams, querystring: { type: 'object', properties: { live: { type: 'string', enum: ['0', '1'] } } }, response: errorResponses },
  }, wrap(async (req) => {
    const { collection, id } = collectionParam(req);
    const out = await inTenant(req, async (tx) => {
      const l = (await recordStates(tx, collection, [id]))[0];
      const log = (await tx.query('SELECT * FROM qbo_sync_log WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 ORDER BY id DESC LIMIT 20', [tx.tenantId, collection, id])).rows.map(logEntry);
      const conflict = l?.conflict_id ? conflictView((await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, l.conflict_id])).rows[0]) : null;
      return { l, log, conflict };
    });
    if (!out.l) return { state: null, quickbooks: null, log: out.log, conflict: null };
    const l = out.l;
    const sandbox = qboCfg(config).environment !== 'production';
    const url = l.qbo_id && WEB_PATH[l.qbo_entity] ? `https://app.${sandbox ? 'sandbox.' : ''}qbo.intuit.com/app/${WEB_PATH[l.qbo_entity]}${l.qbo_id}` : null;
    const quickbooks = {
      entity: l.qbo_entity, qboId: l.qbo_id, docNumber: l.meta?.docNumber || null, updatedAt: l.qbo_updated_at ? new Date(l.qbo_updated_at).toISOString() : null,
      totalCents: l.meta?.qboTotalCents ?? null, balanceCents: l.meta?.qboBalanceCents ?? null, unappliedCents: l.meta?.unappliedCents ?? null, url,
    };
    if (req.query?.live === '1' && l.qbo_id) {
      await lookupLimit(req); // look-up limits apply to the live read (7.5)
      const client = createQboClient({ db, sealer: app.sealer, config, tenantId: req.principal.tenantId, purpose: 'lookup' });
      const o = await client.read(l.qbo_entity, l.qbo_id);
      const { toCents } = await import('../../qbo/map/canon.js');
      Object.assign(quickbooks, { updatedAt: o?.MetaData?.LastUpdatedTime || quickbooks.updatedAt, totalCents: o?.TotalAmt != null ? toCents(o.TotalAmt) : quickbooks.totalCents, balanceCents: o?.Balance != null ? toCents(o.Balance) : quickbooks.balanceCents, docNumber: o?.DocNumber || quickbooks.docNumber });
    }
    return { state: stateOf(l), quickbooks, log: out.log, conflict: out.conflict };
  }));

  app.post('/api/v1/qbo/records/:collection/:id/sync', {
    ...write,
    schema: { tags, summary: 'Retry, Send to QuickBooks now, or Send as new (an unlinked tombstone)', params: recordParams, body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' }, asNew: { type: 'boolean' } } }, response: errorResponses },
  }, wrap(async (req, reply) => {
    const { collection, id } = collectionParam(req);
    if (!QBO_COLLECTIONS.includes(collection)) throw validationFailed('This collection is not sent to QuickBooks.');
    await needConnection(req, { active: true });
    // Send now with force passes the holds: a review it overrides is recorded as approved by this person.
    const held = req.body?.force ? await inTenant(req, async (tx) => (await tx.query(
      "SELECT state, reason FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = 'main' AND state IN ('needs_review', 'blocked')", [tx.tenantId, collection, id])).rows[0]) : null;
    const state = await withApiLease(req, (epoch) => pushRecord(deps, req.principal.tenantId, collection, id, { force: Boolean(req.body?.force), asNew: Boolean(req.body?.asNew), epoch }));
    const summary = req.body?.asNew ? 'Sent to QuickBooks as new' : held ? `Sent to QuickBooks now, approving the hold (${held.reason || held.state})` : 'Sent to QuickBooks now';
    await inTenant(req, (tx) => appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.send', collection, recordId: id, summary, request: requestFacts(req), ...(held ? { meta: { approved: held.reason || held.state } } : {}) }));
    reply.code(202);
    // The push ran at once under the lease; state is the link's state after it (7.5).
    return { queued: true, state };
  }));

  app.post('/api/v1/qbo/records/:collection/:id/renumber', { ...write, schema: { tags, summary: 'Give a document the next number and send it again', params: recordParams, response: errorResponses } }, wrap(async (req) => {
    const { collection, id } = collectionParam(req);
    await needConnection(req, { active: true });
    return withApiLease(req, async (epoch) => {
      const run = await makeRun(deps, req.principal.tenantId, { epoch, purpose: 'sync' });
      const r = await renumber(run, collection, id);
      await inTenant(req, (tx) => appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.renumber', collection, recordId: id, summary: `Renumbered to ${r.number}`, request: requestFacts(req) }));
      await pushRecord(deps, req.principal.tenantId, collection, id, { epoch });
      return r;
    });
  }));

  app.put('/api/v1/qbo/records/:collection/:id/link', {
    ...write,
    schema: { tags, summary: 'Link to a different QuickBooks record (every difference becomes a conflict)', params: recordParams, body: { type: 'object', additionalProperties: false, required: ['qboId'], properties: { qboId: { type: 'string', pattern: '^\\d{1,20}$' } } }, response: errorResponses },
  }, wrap(async (req) => {
    const { collection, id } = collectionParam(req);
    // Relinking reads the QuickBooks record: not while sync is paused (2.5).
    const c = await needConnection(req);
    if (c.state === 'paused') throw new ApiError(409, 'qbo_paused', 'QuickBooks sync is paused.', { pauseReason: c.pause_reason });
    return withApiLease(req, async (epoch) => {
      const run = await makeRun(deps, req.principal.tenantId, { epoch, purpose: 'lookup' });
      const l = await relinkRecord(run, collection, id, req.body.qboId, who(req));
      return { state: stateOf(l) };
    });
  }));

  app.delete('/api/v1/qbo/records/:collection/:id/link', { ...write, schema: { tags, summary: 'Unlink from QuickBooks (both records are kept)', params: recordParams, response: errorResponses } }, wrap(async (req) => {
    const { collection, id } = collectionParam(req);
    await needConnection(req);
    return withApiLease(req, async (epoch) => {
      const run = await makeRun(deps, req.principal.tenantId, { epoch, purpose: 'sync' });
      const l = await unlinkRecord(run, collection, id, who(req));
      return { state: stateOf(l) };
    });
  }));

  const pageQuery = { type: 'object', properties: { cursor: { type: 'string', maxLength: 20 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } };

  app.get('/api/v1/qbo/checks', { ...read, schema: { tags, summary: "The daily check's \"Doesn't match\" list", querystring: pageQuery, response: errorResponses } }, wrap(async (req) => {
    return inTenant(req, (tx) => checkList(tx, req.query || {}));
  }));

  app.get('/api/v1/qbo/log', {
    ...read,
    schema: {
      tags, summary: 'The QuickBooks sync log',
      querystring: { type: 'object', properties: { cursor: { type: 'string', maxLength: 20 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, outcome: { type: 'string', maxLength: 20 }, collection: { type: 'string', maxLength: 40 }, recordId: { type: 'string', maxLength: 128 } } },
      response: errorResponses,
    },
  }, wrap(async (req) => {
    const q = req.query || {};
    const lim = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return inTenant(req, async (tx) => {
      const params = [tx.tenantId];
      const where = ['tenant_id = $1'];
      if (q.cursor) { if (!/^\d{1,18}$/.test(String(q.cursor))) throw validationFailed('Invalid cursor.'); params.push(q.cursor); where.push(`id < $${params.length}`); }
      for (const [k, col] of [['outcome', 'outcome'], ['collection', 'collection'], ['recordId', 'record_id']]) if (q[k]) { params.push(String(q[k])); where.push(`${col} = $${params.length}`); }
      params.push(lim + 1);
      const { rows } = await tx.query(`SELECT * FROM qbo_sync_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`, params);
      const page = rows.slice(0, lim);
      return { data: page.map(logEntry), cursor: rows.length > lim ? String(page[page.length - 1].id) : null, more: rows.length > lim };
    });
  }));

  // ---- mappings and reference lists (7.6) ------------------------------------------------------------

  async function mappingsView(tx, c) {
    const { mappings } = await loadMappings(tx, c.realm_hash);
    const ref = (await tx.query('SELECT kind, qbo_id, name, active, data FROM qbo_reference WHERE tenant_id = $1 AND realm_hash = $2 ORDER BY kind, name', [tx.tenantId, c.realm_hash])).rows;
    const of = (k) => ref.filter((r) => r.kind === k);
    const rates = of('TaxRate').map((r) => r.data);
    const rateRow = (id) => { const r = rates.find((x) => String(x.Id) === String(id)); return r ? { name: r.Name, pct: ratePct(r) } : null; };
    const choices = {
      items: of('Item').filter((r) => !['Category', 'Group'].includes(r.data.Type)).map((r) => ({ id: r.qbo_id, name: r.name, type: r.data.Type || null, active: r.active })),
      accounts: of('Account').map((r) => ({ id: r.qbo_id, name: r.name, type: r.data.AccountType || null, subType: r.data.AccountSubType || null, active: r.active })),
      taxCodes: of('TaxCode').map((r) => ({ id: r.qbo_id, name: r.name, active: r.active, salesRates: salesRateIds(r.data).map(rateRow).filter(Boolean), purchaseRates: purchaseRateIds(r.data).map(rateRow).filter(Boolean) })),
      paymentMethods: of('PaymentMethod').map((r) => ({ id: r.qbo_id, name: r.name, active: r.active })),
      classes: of('Class').map((r) => ({ id: r.qbo_id, name: r.name, active: r.active })),
      departments: of('Department').map((r) => ({ id: r.qbo_id, name: r.name, active: r.active })),
      terms: of('Term').map((r) => ({ id: r.qbo_id, name: r.name, active: r.active })),
    };
    const settings = (await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0]?.data || {};
    const province = settings.company?.province || c.features?.province || null;
    const codes = of('TaxCode').map((r) => r.data);
    const keys = companyTaxKeys(province);
    const suggestions = {
      taxCode: suggestTaxCodes(keys, codes, rates, { province }),
      purchaseTaxCode: suggestTaxCodes([...new Set(keys.filter((k) => !k.startsWith('NONE|')).concat(['NONE', 'stripeFee']))], codes, rates, { province, purchase: true, agencies: of('TaxAgency').map((r) => r.data) }),
    };
    return { mappings, choices, required: await requiredMappings(tx, c, mappings), suggestions };
  }

  app.get('/api/v1/qbo/mappings', { ...read, schema: { tags, summary: 'Mappings, QuickBooks choices, what is still required and suggestions', response: errorResponses } }, wrap(async (req) => {
    const c = await needConnection(req);
    return inTenant(req, (tx) => mappingsView(tx, c));
  }));

  /** Validate one mapping against qbo_reference and its type (7.6). */
  async function checkMapping(tx, c, { kind, key, value }, ctx) {
    if (!MAPPING_KINDS.includes(kind)) throw validationFailed(`Unknown mapping kind ${kind}.`);
    if (!KEY_RE.test(String(key || ''))) throw validationFailed('Bad mapping key.');
    if (kind === 'option') {
      const rule = OPTIONS[key];
      if (!rule) throw validationFailed(`${key} cannot be set here.`);
      if (rule.type === 'date' && !(value === null || /^\d{4}-\d{2}-\d{2}$/.test(String(value)))) throw validationFailed(`${key} must be a date (YYYY-MM-DD).`);
      if (rule.type === 'boolean' && typeof value !== 'boolean') throw validationFailed(`${key} must be true or false.`);
      if (rule.enum && !rule.enum.includes(value)) throw validationFailed(`${key} must be one of ${rule.enum.join(', ')}.`);
      if (key === 'numbering' && value === 'quickbooks' && c.features?.customTxnNumbers) throw validationFailed('QuickBooks numbering needs Custom transaction numbers off in QuickBooks.');
      if (key === 'jobsAsSubCustomers') {
        const pushed = (await tx.query("SELECT 1 FROM qbo_links WHERE tenant_id = $1 AND collection IN ('estimates', 'invoices', 'bills', 'purchaseOrders', 'timeEntries') AND qbo_id IS NOT NULL LIMIT 1", [tx.tenantId])).rows.length;
        if (pushed && value !== (ctx.mappings.option?.jobsAsSubCustomers ?? true)) throw new ApiError(409, 'qbo_option_locked', 'This choice is locked once documents have been sent to QuickBooks.');
      }
      return;
    }
    const allowedKeys = { item: ITEM_KEYS, account: ACCOUNT_KEYS, paymentMethod: METHOD_KEYS, depositTo: METHOD_KEYS, paidFrom: PAID_FROM_KEYS, class: ['default'], department: ['default'], term: ['default'] }[kind];
    if (allowedKeys && !allowedKeys.includes(key)) throw validationFailed(`${key} is not a ${kind} mapping.`);
    if (!/^\d{1,20}$/.test(String(value ?? ''))) throw validationFailed('The value must be a QuickBooks id.');
    const refKind = { item: 'Item', taxCode: 'TaxCode', purchaseTaxCode: 'TaxCode', account: 'Account', paymentMethod: 'PaymentMethod', depositTo: 'Account', paidFrom: 'Account', class: 'Class', department: 'Department', term: 'Term' }[kind];
    const row = (await tx.query('SELECT data, active FROM qbo_reference WHERE tenant_id = $1 AND realm_hash = $2 AND kind = $3 AND qbo_id = $4', [tx.tenantId, c.realm_hash, refKind, String(value)])).rows[0];
    if (!row) throw validationFailed(`QuickBooks has no such ${refKind}. Refresh the lists and try again.`);
    if (row.active === false) throw validationFailed(`That ${refKind} is inactive in QuickBooks.`);
    const d = row.data;
    if (kind === 'item' && ['Category', 'Group'].includes(d.Type)) throw validationFailed('Pick a product or service, not a category.');
    if (kind === 'account') {
      const types = ACCOUNT_TYPES[key] || (key.startsWith('jobCost.') ? ['Expense', 'Other Expense', 'Cost of Goods Sold'] : null);
      if (types && !types.includes(d.AccountType)) throw validationFailed(`That account is a ${d.AccountType}; ${key} needs ${types.join(' or ')}.`);
    }
    if (kind === 'depositTo' && !['Bank', 'Other Current Asset'].includes(d.AccountType)) throw validationFailed('Deposit to a bank account or Undeposited Funds.');
    if (kind === 'paidFrom' && !['Bank', 'Credit Card'].includes(d.AccountType)) throw validationFailed('Paid from a bank or credit card account.');
    if (kind === 'taxCode' && !parseTaxKey(key).none && key !== 'TAX') {
      if (!codeMatchesKey(key, d, ctx.ref, { province: ctx.province })) throw validationFailed(`That QuickBooks code's rates don't match ${key} today.`);
    }
    if (kind === 'purchaseTaxCode' && /PST|RST/.test(key) && purchaseCodeClaimsPst(d, ctx.ref.rates, ctx.ref.agencies)) {
      throw validationFailed('That code would claim PST/RST back; PST and RST paid on purchases go into the cost (pick a GST-only code).');
    }
  }

  app.put('/api/v1/qbo/mappings', {
    ...write,
    schema: {
      tags, summary: 'Set or remove mappings (every change re-queues waiting and failed records)',
      body: { type: 'object', additionalProperties: false, properties: { set: { type: 'array', maxItems: 200 }, remove: { type: 'array', maxItems: 200 } } },
      response: errorResponses,
    },
  }, wrap(async (req) => {
    // Practice mode and Go live belong to an owner or admin (8.2); other office mappings do not.
    const touchesWriteMode = [...(req.body?.set || []), ...(req.body?.remove || [])].some((m) => m?.kind === 'option' && m.key === 'writeMode');
    if (touchesWriteMode && !QBO_ADMIN_ROLES.includes(req.principal.role)) throw forbidden('Only an owner or admin can turn practice mode on or off.');
    const c = await needConnection(req);
    let goLive = false;
    // Setting the Stripe cutover reads the clearing account's balance as the check's opening balance (6.1, 5.13).
    let opening = null;
    const cutover = (req.body?.set || []).find((m) => m?.kind === 'option' && m.key === 'stripeCutover' && m.value);
    if (cutover) {
      const clearing = (req.body.set.find((m) => m?.kind === 'account' && m.key === 'stripeClearing')?.value)
        ?? (await inTenant(req, async (tx) => (await tx.query("SELECT value FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'account' AND key = 'stripeClearing'", [tx.tenantId])).rows[0]?.value));
      if (clearing && /^\d{1,20}$/.test(String(clearing))) {
        const client = createQboClient({ db, sealer: app.sealer, config, tenantId: req.principal.tenantId, purpose: 'reference' });
        const acct = await client.read('Account', String(clearing));
        const { toCents } = await import('../../qbo/map/canon.js');
        opening = toCents(acct?.CurrentBalance ?? 0);
      }
    }
    const out = await inTenant(req, async (tx) => {
      const { mappings } = await loadMappings(tx, c.realm_hash);
      const refRows = (await tx.query("SELECT kind, data FROM qbo_reference WHERE tenant_id = $1 AND realm_hash = $2 AND kind IN ('TaxCode', 'TaxRate', 'TaxAgency')", [tx.tenantId, c.realm_hash])).rows;
      const ctx = {
        mappings, province: ((await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings'", [tx.tenantId])).rows[0]?.data?.company?.province) || c.features?.province || null,
        ref: { codes: refRows.filter((r) => r.kind === 'TaxCode').map((r) => r.data), rates: refRows.filter((r) => r.kind === 'TaxRate').map((r) => r.data), agencies: refRows.filter((r) => r.kind === 'TaxAgency').map((r) => r.data) },
      };
      const by = `${req.principal.actor.type}:${req.principal.actor.id}`;
      const changed = [];
      for (const m of req.body?.set || []) {
        await checkMapping(tx, c, m, ctx);
        const value = m.kind === 'option' ? m.value : String(m.value);
        if (m.kind === 'option' && m.key === 'writeMode' && value === 'live' && mappings.option?.writeMode === 'shadow') goLive = true;
        await tx.query(
          `INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value, realm_hash = EXCLUDED.realm_hash, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [tx.tenantId, c.realm_hash, m.kind, m.key, JSON.stringify(value), by]);
        changed.push(`${m.kind}.${m.key}`);
      }
      for (const m of req.body?.remove || []) {
        if (!MAPPING_KINDS.includes(m?.kind) || !KEY_RE.test(String(m?.key || ''))) throw validationFailed('Bad mapping to remove.');
        if (m.kind === 'option') {
          // A removal is a change back to the default: the same rules as setting it (7.6).
          if (!OPTIONS[m.key]) throw validationFailed(`${m.key} cannot be removed here.`);
          if (m.key === 'jobsAsSubCustomers') await checkMapping(tx, c, { kind: 'option', key: m.key, value: true }, ctx);
          if (m.key === 'writeMode' && mappings.option?.writeMode === 'shadow') goLive = true;
        }
        await tx.query('DELETE FROM qbo_mappings WHERE tenant_id = $1 AND kind = $2 AND key = $3', [tx.tenantId, m.kind, m.key]);
        changed.push(`-${m.kind}.${m.key}`);
      }
      if (opening != null) {
        await tx.query(
          `INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value, updated_by) VALUES ($1, $2, 'option', 'stripeClearingOpeningCents', $3, 'system:qbo')
           ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value, realm_hash = EXCLUDED.realm_hash, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [tx.tenantId, c.realm_hash, JSON.stringify(opening)]);
      }
      await requeueStuck(tx);
      if (goLive) {
        // Out of practice mode: what waited in the outbox goes now.
        await tx.query('UPDATE qbo_outbox SET not_before = now(), claimed_until = NULL, claimed_epoch = NULL WHERE tenant_id = $1', [tx.tenantId]);
        if (c.setup?.phase === 'shadow_linked') await enqueueApply(tx, tx.tenantId);
        else if (c.state === 'active') await enqueueSync(tx, tx.tenantId, { sweep: true });
      }
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.mappings', collection: 'qbo_mappings', summary: `Changed QuickBooks mappings: ${changed.join(', ').slice(0, 400)}`, request: requestFacts(req) });
      await writeLog(tx, { direction: 'system', outcome: 'info', action: 'mappings', message: `Mappings changed: ${changed.length}` });
      return mappingsView(tx, c);
    }, { write: true });
    return out;
  }));

  app.post('/api/v1/qbo/reference/refresh', { ...write, schema: { tags, summary: 'Read the QuickBooks lists again (at most every 5 minutes)', response: errorResponses } }, wrap(async (req, reply) => {
    const c = await needConnection(req);
    if (c.ref_refreshed_at && Date.now() - new Date(c.ref_refreshed_at).getTime() < 5 * 60_000) {
      throw new ApiError(429, 'qbo_throttled', 'The lists were read a moment ago.', { retryAfterS: Math.ceil((5 * 60_000 - (Date.now() - new Date(c.ref_refreshed_at).getTime())) / 1000) });
    }
    await inTenant(req, (tx) => enqueue(tx, { kind: 'qbo_reference_refresh', tenantId: tx.tenantId, payload: { force: true }, dedupeKey: `qbo_reference_refresh:${tx.tenantId}`, maxAttempts: 3 }));
    reply.code(202);
    return { queued: true };
  }));

  // ---- conflicts (7.7) --------------------------------------------------------------------------------

  app.get('/api/v1/qbo/conflicts', {
    ...read,
    schema: { tags, summary: 'QuickBooks conflicts and reviews', querystring: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'resolved', 'dismissed'] }, cursor: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } }, response: errorResponses },
  }, wrap(async (req) => {
    const q = req.query || {};
    const lim = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return inTenant(req, async (tx) => {
      const params = [tx.tenantId, q.status || 'open'];
      let cur = '';
      if (q.cursor) {
        const [at, id] = String(q.cursor).split('|');
        if (!at || !UUID_RE.test(String(id || '')) || Number.isNaN(Date.parse(at))) throw validationFailed('Invalid cursor.');
        params.push(at, id); cur = ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`;
      }
      params.push(lim + 1);
      const { rows } = await tx.query(`SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND status = $2${cur} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
      const page = rows.slice(0, lim);
      const last = page[page.length - 1];
      return { data: page.map(conflictView), cursor: rows.length > lim && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null, more: rows.length > lim };
    });
  }));

  const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
  app.get('/api/v1/qbo/conflicts/:id', { ...read, schema: { tags, summary: 'One conflict', params: uuidParams, response: errorResponses } }, wrap(async (req) => {
    const row = await inTenant(req, async (tx) => (await tx.query('SELECT * FROM qbo_conflicts WHERE tenant_id = $1 AND id = $2', [tx.tenantId, req.params.id])).rows[0]);
    if (!row) throw notFound();
    return conflictView(row);
  }));

  app.post('/api/v1/qbo/conflicts/:id/resolve', {
    ...write,
    schema: {
      tags, summary: 'Resolve a conflict: fishtape, quickbooks, per field, restore, delete, unlink',
      params: uuidParams,
      body: { type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { type: 'string', maxLength: 20 }, fields: { type: 'object' }, recordId: { type: 'string', maxLength: 128 } } },
      response: errorResponses,
    },
  }, wrap(async (req) => {
    await needConnection(req);
    return withApiLease(req, (epoch) => resolveConflict(deps, req.principal.tenantId, req.params.id, req.body, who(req), { epoch }));
  }));

  // ---- live look-up (7.8) -------------------------------------------------------------------------------

  const perUser = new Map();
  const lookupLimit = async (req) => {
    const k = req.principal.userId;
    const now = Date.now();
    const list = (perUser.get(k) || []).filter((t) => now - t < 60_000);
    if (list.length >= 30) throw new ApiError(429, 'qbo_throttled', 'Too many look-ups. Try again in a minute.', { retryAfterS: Math.ceil((60_000 - (now - list[0])) / 1000) });
    list.push(now);
    perUser.set(k, list);
    if (perUser.size > 5000) perUser.clear();
  };
  const lookupRead = { ...read, preHandler: [...read.preHandler, lookupLimit] };

  for (const kind of ['customers', 'invoices', 'estimates']) {
    app.post(`/api/v1/qbo/lookup/${kind}`, {
      ...lookupRead,
      schema: {
        tags, summary: `Search QuickBooks ${kind} (the search text goes in the body, never the URL)`,
        body: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 25 }, clientId: { type: 'string', maxLength: 128 }, qboCustomerId: { type: 'string', maxLength: 20 }, status: { type: 'string', enum: ['open', 'pending', 'all'] } } },
        response: errorResponses,
      },
    }, wrap(async (req) => { await needConnection(req); return lookup(deps, req.principal.tenantId, kind, req.body || {}); }));
  }

  const lookupParams = { type: 'object', required: ['entity', 'qboId'], properties: { entity: { type: 'string', enum: ['customer', 'invoice', 'estimate'] }, qboId: { type: 'string', pattern: '^\\d{1,20}$' } } };
  app.get('/api/v1/qbo/lookup/:entity/:qboId', { ...lookupRead, schema: { tags, summary: 'One QuickBooks customer, invoice or estimate, summarised', params: lookupParams, response: errorResponses } }, wrap(async (req) => {
    await needConnection(req);
    return lookup(deps, req.principal.tenantId, req.params.entity, { qboId: req.params.qboId });
  }));

  app.post('/api/v1/qbo/lookup/:entity/:qboId/import', { ...write, schema: { tags, summary: 'Import a QuickBooks customer, invoice or estimate into Fishtape', params: lookupParams, response: errorResponses } }, wrap(async (req) => {
    await needConnection(req, { active: true });
    return withApiLease(req, async (epoch) => {
      const r = await importRemote(deps, req.principal.tenantId, req.params.entity, req.params.qboId, { epoch });
      await inTenant(req, (tx) => appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'qbo.import', collection: r.collection, recordId: r.id, summary: 'Imported from QuickBooks', request: requestFacts(req) }));
      return r;
    });
  }));
}
