// Intuit webhooks (docs/integrations/quickbooks.md 5.9). The HMAC is checked on the raw body before
// anything is parsed or stored. Events are triggers only: they mark the tenant dirty (the next pass
// reads every change from the CDC cursor), and TimeActivity events and merges (which CDC cannot
// replace) are kept in qbo_inbox, one row per object. Nothing here is written to a Fishtape record;
// webhook-only signals are confirmed by a read first (W3).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { enqueue } from '../services/queue.js';
import { qboCfg } from './env.js';
import { enqueueSync, platformEvent, qboRealmOwner, realmHash } from './connection.js';

/** CloudEvents type entity (lower case) to the QBO entity name. */
const ENTITY = Object.fromEntries(['Account', 'Bill', 'BillPayment', 'Class', 'CreditMemo', 'Customer', 'Department', 'Deposit', 'Employee',
  'Estimate', 'Invoice', 'Item', 'JournalEntry', 'Payment', 'PaymentMethod', 'Preferences', 'Purchase', 'PurchaseOrder', 'RefundReceipt',
  'SalesReceipt', 'TaxAgency', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit'].map((e) => [e.toLowerCase(), e]));
const OPS = { created: 'created', create: 'created', updated: 'updated', update: 'updated', deleted: 'deleted', delete: 'deleted',
  merged: 'merged', merge: 'merged', voided: 'voided', void: 'voided', emailed: 'emailed' };
const ID = /^\d{1,20}$/;
const MAX_EVENTS = 5000;

/** Lists that the reference refresh re-reads when they change (5.4). Preferences re-reads features (2.8). */
const REFERENCE_ENTITIES = new Set(['Account', 'Class', 'Department', 'Term', 'PaymentMethod', 'Employee', 'Preferences']);
/** Kept in the inbox: TimeActivity (not in CDC) and merges of linkable names. */
const MERGE_ENTITIES = new Set(['Customer', 'Vendor', 'Item']);

/**
 * base64(HMAC-SHA256(raw body, verifier)) against the intuit-signature header, in constant time,
 * for each verifier (the current one, then QBO_WEBHOOK_VERIFIER_PREVIOUS during a rotation).
 * @param {Buffer|string} raw
 * @param {string|undefined|null} header
 * @param {string[]} verifiers
 */
export function verifyIntuitSignature(raw, header, verifiers) {
  if (typeof header !== 'string' || !header || header.length > 200) return false;
  let given;
  try { given = Buffer.from(header.trim(), 'base64'); } catch { return false; }
  if (given.length !== 32) return false;
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  let ok = false;
  for (const v of verifiers || []) {
    if (!v) continue;
    const want = createHmac('sha256', v).update(body).digest();
    if (timingSafeEqual(want, given)) ok = true;
  }
  return ok;
}

function eventTime(v) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

/**
 * Parse a verified body: a JSON array of CloudEvents (type qbo.<entity>.<op>.v1), or the legacy
 * { eventNotifications: [...] } shape, converted. Unknown types and malformed events are dropped.
 * @param {Buffer|string} raw
 * @returns {QboEvent[]}
 */
export function parseWebhook(raw) {
  let body;
  try { body = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return []; }
  const out = [];
  if (Array.isArray(body)) {
    for (const e of body.slice(0, MAX_EVENTS)) {
      const m = /^qbo\.([a-z]+)\.([a-z_]+)\.v\d+$/.exec(String(e?.type || ''));
      const entity = m && ENTITY[m[1]];
      const op = m && OPS[m[2]];
      const realmId = String(e?.intuitaccountid ?? '');
      const qboId = String(e?.intuitentityid ?? '');
      if (!entity || !op || !ID.test(realmId) || !ID.test(qboId)) continue;
      const deleted = e?.data?.deletedid ?? e?.data?.deletedId ?? null;
      out.push({ id: String(e.id ?? '').slice(0, 200), realmId, entity, op, qboId, deletedId: deleted != null && ID.test(String(deleted)) ? String(deleted) : null, time: eventTime(e.time) });
    }
    return out;
  }
  for (const n of (Array.isArray(body?.eventNotifications) ? body.eventNotifications : [])) {
    const realmId = String(n?.realmId ?? '');
    if (!ID.test(realmId)) continue;
    for (const e of (n?.dataChangeEvent?.entities || [])) {
      const entity = ENTITY[String(e?.name || '').toLowerCase()];
      const op = OPS[String(e?.operation || '').toLowerCase()];
      const qboId = String(e?.id ?? '');
      if (!entity || !op || !ID.test(qboId)) continue;
      const deleted = e?.deletedId ?? e?.deletedid ?? null;
      out.push({
        id: `${realmId}:${entity}:${qboId}:${e?.lastUpdated || ''}`.slice(0, 200), realmId, entity, op, qboId,
        deletedId: deleted != null && ID.test(String(deleted)) ? String(deleted) : null, time: eventTime(e?.lastUpdated),
      });
      if (out.length >= MAX_EVENTS) return out;
    }
  }
  return out;
}

/**
 * Route events to tenants by realm hash and record them (5.9 step 3). Unknown realms and
 * disconnected connections drop. One transaction per tenant.
 * @param {QboEvent[]} events
 * @returns {Promise<{ accepted: number, dropped: number }>}
 */
export async function ingestWebhook(db, sealer, cfg, events) {
  const q = qboCfg(cfg);
  let accepted = 0;
  let dropped = 0;
  if (!q.enabled) return { accepted, dropped: events.length };
  const byRealm = new Map();
  for (const e of events) (byRealm.get(e.realmId) || byRealm.set(e.realmId, []).get(e.realmId)).push(e);
  for (const [realmId, list] of byRealm) {
    const hash = realmHash(sealer, q, realmId);
    const tenantId = await qboRealmOwner(db, hash);
    if (!tenantId) { dropped += list.length; continue; }
    const ok = await db.withTenant({ tenantId }, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE qbo_connections SET dirty_at = now(), last_webhook_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND state <> 'disconnected' AND realm_hash = $2 RETURNING state`, [tenantId, hash]);
      if (!rows[0]) return false;
      const state = rows[0].state;
      let reference = false;
      for (const e of list) {
        if (REFERENCE_ENTITIES.has(e.entity)) reference = true;
        const keep = e.entity === 'TimeActivity' || (e.op === 'merged' && MERGE_ENTITIES.has(e.entity));
        if (!keep || !['created', 'updated', 'deleted', 'merged'].includes(e.op)) continue;
        // One row per object; the newer event wins and is processed again.
        await tx.query(
          `INSERT INTO qbo_inbox (tenant_id, realm_hash, entity, qbo_id, op, deleted_id, event_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, entity, qbo_id) DO UPDATE SET op = EXCLUDED.op, deleted_id = EXCLUDED.deleted_id,
             event_time = EXCLUDED.event_time, realm_hash = EXCLUDED.realm_hash, received_at = now(), attempts = 0, processed_at = NULL
           WHERE qbo_inbox.event_time <= EXCLUDED.event_time`,
          [tenantId, hash, e.entity, e.qboId, e.op, e.deletedId, e.time]);
      }
      if (state === 'active') await enqueueSync(tx, tenantId, { runAt: new Date(Date.now() + 5_000) });
      if (reference && (state === 'active' || state === 'setup')) {
        await enqueue(tx, { kind: 'qbo_reference_refresh', tenantId, dedupeKey: `qbo_reference_refresh:${tenantId}`, runAt: new Date(Date.now() + 60_000), maxAttempts: 3 });
      }
      return true;
    });
    if (ok) accepted += list.length; else dropped += list.length;
  }
  return { accepted, dropped };
}

/** Count a bad or missing signature (HQ alert qbo_webhook_signature). Nothing else is stored. */
export async function recordSignatureFailure(db, cfg) {
  await platformEvent(db, 'webhook_signature', qboCfg(cfg).environment).catch(() => {});
}

/**
 * The whole of POST /api/v1/webhooks/qbo for the route: verify, parse, ingest.
 * @param {Buffer} raw the raw body
 * @param {string|undefined} signature the intuit-signature header
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function receiveWebhook(db, sealer, cfg, raw, signature) {
  const q = qboCfg(cfg);
  if (!q.enabled) return { status: 503, body: { error: { code: 'qbo_unavailable', message: 'QuickBooks is not available on this server.' } } };
  if (!verifyIntuitSignature(raw, signature, q.webhookVerifiers)) {
    await recordSignatureFailure(db, q);
    return { status: 401, body: { error: { code: 'invalid_signature', message: 'Bad or missing signature.' } } };
  }
  const events = parseWebhook(raw);
  await ingestWebhook(db, sealer, q, events);
  return { status: 200, body: { received: events.length } };
}

/** @typedef {{ id: string, realmId: string, entity: string, op: 'created'|'updated'|'deleted'|'merged'|'voided'|'emailed', qboId: string, deletedId: string|null, time: string }} QboEvent */
