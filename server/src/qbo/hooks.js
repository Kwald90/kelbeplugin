// The records hook (docs/integrations/quickbooks.md 5.2). services/records.js calls these after every
// write and every delete, REST and sync alike. A Fishtape change of a synced collection becomes one
// qbo_outbox row per record, in every connection state (edits made while sync is off wait there), and
// an active connection gets a qbo_sync pass 20 seconds later (a burst of edits becomes one pass).
// The engine's own writes (system:qbo) are never queued: loop prevention, first layer.
// Nothing here throws: it runs in a savepoint, and the dispatcher and the sweep catch up.
import { enqueueSync } from './connection.js';

/** Collections whose records sync with QuickBooks (5.2 step 2). */
export const QBO_COLLECTIONS = ['clients', 'jobs', 'items', 'vendors', 'estimates', 'invoices', 'payments', 'bills', 'purchaseOrders', 'timeEntries'];

/** Push order (dependencies first, 5.2). */
export const QBO_RANK = Object.freeze({
  clients: 10, vendors: 10, jobs: 20, items: 20, employees: 20, estimates: 30, invoices: 40, purchaseOrders: 40,
  payments: 50, bills: 50, timeEntries: 60, stripePayouts: 70,
});

const FIELD_ROLES = new Set(['foreman', 'electrician', 'apprentice']);
const DEBOUNCE_S = 20;

/**
 * Who made a write, for the origin rule (5.2 step 5). `who` is { actor, kind?, role?, crew? }:
 * records.js adds the principal's kind, role and crew flag to the audit actor.
 * @returns {'user'|'field_user'|'api_key'|'agent'|'stripe'|'system'}
 */
export function actorTypeOf(who) {
  const actor = who?.actor || {};
  if (who?.kind === 'api_key' || actor.type === 'api_key') return 'api_key';
  if (actor.type === 'agent') return 'agent';
  if (actor.type === 'system') return actor.id === 'stripe' ? 'stripe' : 'system';
  if (who?.crew || FIELD_ROLES.has(who?.role)) return 'field_user';
  return 'user';
}

/**
 * The actor type of a record's last writer from its updated_by text ('user:<id>', 'agent:...',
 * 'api_key:<id>', 'system:stripe'), for the sweep (5.12). Roles are looked up by the caller.
 */
export function actorTypeOfUpdatedBy(updatedBy, roleOfUser = null) {
  const s = String(updatedBy || '');
  const [type, ...rest] = s.split(':');
  const id = rest.join(':');
  if (type === 'api_key') return 'api_key';
  if (type === 'agent') return 'agent';
  if (type === 'system') return id === 'stripe' ? 'stripe' : 'system';
  if (type === 'user' && roleOfUser && FIELD_ROLES.has(roleOfUser)) return 'field_user';
  return 'sweep';
}

const isQboActor = (who) => who?.actor?.type === 'system' && who?.actor?.id === 'qbo';

// The connection row, read once per transaction.
const connCache = new WeakMap();
async function connectionOf(tx) {
  if (connCache.has(tx)) return connCache.get(tx);
  const { rows } = await tx.query('SELECT state FROM qbo_connections WHERE tenant_id = $1', [tx.tenantId]);
  const row = rows[0] || null;
  connCache.set(tx, row);
  return row;
}

/**
 * The outbox upsert (5.2 step 6), shared with the sweep. On conflict the earliest enqueued_at
 * stays, stale and held accumulate, the newest op wins, an api_key or agent actor in the burst
 * stays (it is held for review), a field user's stays when the system (sweep, setup wizard) queues
 * the same record again, not_before moves 20 s on and the claim is cleared, so the pass
 * that claimed an older edit never deletes this one.
 */
export async function upsertOutbox(tx, { collection, recordId, op, stale = false, held = {}, actorType, rank, delayS = DEBOUNCE_S }) {
  await tx.query(
    `INSERT INTO qbo_outbox (tenant_id, collection, record_id, op, stale, held, actor_type, rank, not_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
     ON CONFLICT (tenant_id, collection, record_id) DO UPDATE SET
       op = EXCLUDED.op, stale = qbo_outbox.stale OR EXCLUDED.stale, held = qbo_outbox.held || EXCLUDED.held,
       actor_type = CASE WHEN qbo_outbox.actor_type IN ('api_key', 'agent')
                           OR (qbo_outbox.actor_type = 'field_user' AND EXCLUDED.actor_type = 'system') THEN qbo_outbox.actor_type
                         ELSE EXCLUDED.actor_type END,
       not_before = EXCLUDED.not_before, claimed_until = NULL, claimed_epoch = NULL`,
    [tx.tenantId, collection, recordId, op, Boolean(stale), JSON.stringify(held || {}), actorType, rank ?? QBO_RANK[collection] ?? 50, delayS]);
}

async function queue(tx, coll, id, op, who, { stale = false, held = null, enabled = false } = {}) {
  if (!enabled) return;                                  // 1: QuickBooks is off on this server: no query at all
  if (!QBO_COLLECTIONS.includes(coll)) return;           // 2
  if (isQboActor(who)) return;                           // 3: the engine's own write
  const run = async () => {
    const conn = await connectionOf(tx);                 // 4: any state, disconnected included
    if (!conn) return;
    await upsertOutbox(tx, {                             // 5, 6
      collection: coll, recordId: id, op, stale, held: held && typeof held === 'object' ? held : {}, actorType: actorTypeOf(who), rank: QBO_RANK[coll],
    });
    if (conn.state === 'active') {                       // 7: shadow mode is active too
      await enqueueSync(tx, tx.tenantId, { runAt: new Date(Date.now() + DEBOUNCE_S * 1000) });
    }
  };
  try {
    if (typeof tx.savepoint === 'function') await tx.savepoint(run); else await run();
  } catch (e) {
    if (process.env.DEBUG_QBO) console.error('qbo hook failed', e);
  }
}

/**
 * After create, update and restore.
 * @param {object} opts { stale, held, enabled } enabled: QuickBooks is configured on this server (cfg.qbo.enabled)
 */
export async function qboAfterWrite(tx, coll, id, before, after, who, opts = {}) {
  await queue(tx, coll, id, 'upsert', who, opts);
}

/** After a soft delete. */
export async function qboAfterDelete(tx, coll, id, before, who, opts = {}) {
  await queue(tx, coll, id, 'delete', who, opts);
}
