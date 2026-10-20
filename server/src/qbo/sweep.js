// The Fishtape-side sweep (docs/integrations/quickbooks.md 5.12). CDC makes sure no QuickBooks change
// is missed; the sweep does the same for Fishtape changes that never reached the outbox: edits made
// while QuickBooks was off on the server, a hook that failed, writes that bypassed records.js (direct
// SQL, scrubs, imports). It reads only the Fishtape database (no CorePlus call) and respects the origin
// rule through each record's updated_by. It runs on the first pass after any move back to active
// (qbo_sync with payload.sweep), after a reconnect and the wizard apply, and daily from qbo_check.
import { collectionDef } from '../collections.js';
import { assertEpoch } from './lease.js';
import { QBO_COLLECTIONS, QBO_RANK, actorTypeOfUpdatedBy, upsertOutbox } from './hooks.js';

/**
 * @param {object} deps { db }
 * @param {{ run?: object, epoch?: number }} [o] the pass (its epoch fences the writes)
 * @returns {Promise<{ queued: number }>}
 */
export async function sweep(deps, tenantId, o = {}) {
  const epoch = o.run?.epoch ?? o.epoch ?? null;
  return deps.db.withTenant({ tenantId }, async (tx) => {
    if (epoch != null) await assertEpoch(tx, tenantId, epoch);
    const conn = (await tx.query('SELECT realm_hash, fishtape_cursor FROM qbo_connections WHERE tenant_id = $1', [tenantId])).rows[0];
    if (!conn) return { queued: 0 };
    const roles = new Map((await tx.query('SELECT user_id::text AS id, role FROM memberships WHERE tenant_id = $1', [tenantId])).rows.map((r) => [r.id, r.role]));
    const actor = (updatedBy) => {
      const s = String(updatedBy || '');
      return actorTypeOfUpdatedBy(s, s.startsWith('user:') ? roles.get(s.slice(5)) : null);
    };
    const cursor = Number(conn.fishtape_cursor || 0);
    let maxSeq = cursor;
    let queued = 0;
    for (const coll of QBO_COLLECTIONS) {
      const def = collectionDef(coll);
      // 1 and 3: linked records changed (or deleted) since the version the link last saw.
      const changed = await tx.query(
        `SELECT r.id, r.version, r.deleted_at, r.updated_by, l.state FROM qbo_links l JOIN ${def.table} r ON r.tenant_id = l.tenant_id AND r.id = l.record_id
          WHERE l.tenant_id = $1 AND l.collection = $2 AND l.role = 'main' AND l.realm_hash = $3
            AND l.state NOT IN ('unlinked', 'deleted_local') AND l.owner NOT IN ('quickbooks', 'none')
            AND (l.fishtape_version IS DISTINCT FROM r.version OR r.deleted_at IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM qbo_outbox o WHERE o.tenant_id = l.tenant_id AND o.collection = l.collection AND o.record_id = l.record_id)`,
        [tenantId, coll, conn.realm_hash]);
      for (const r of changed.rows) {
        if (r.deleted_at && r.state === 'deleted_remote') continue;
        await upsertOutbox(tx, { collection: coll, recordId: r.id, op: r.deleted_at ? 'delete' : 'upsert', actorType: actor(r.updated_by), rank: QBO_RANK[coll], delayS: 0 });
        queued++;
      }
      // 2: records newer than the cursor that have no link yet (the pass decides whether they are eligible).
      const fresh = await tx.query(
        `SELECT r.id, r.change_seq, r.updated_by FROM ${def.table} r
          WHERE r.tenant_id = $1 AND r.change_seq > $2 AND r.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM qbo_links l WHERE l.tenant_id = r.tenant_id AND l.collection = $3 AND l.record_id = r.id AND l.role = 'main')
            AND NOT EXISTS (SELECT 1 FROM qbo_outbox o WHERE o.tenant_id = r.tenant_id AND o.collection = $3 AND o.record_id = r.id)
          ORDER BY r.change_seq LIMIT 5000`, [tenantId, cursor, coll]);
      for (const r of fresh.rows) {
        if (String(r.updated_by || '') === 'system:qbo') continue;
        await upsertOutbox(tx, { collection: coll, recordId: r.id, op: 'upsert', actorType: actor(r.updated_by), rank: QBO_RANK[coll], delayS: 0 });
        queued++;
      }
      const top = await tx.query(`SELECT max(change_seq)::bigint AS m FROM ${def.table} WHERE tenant_id = $1`, [tenantId]);
      maxSeq = Math.max(maxSeq, Number(top.rows[0].m || 0));
    }
    await tx.query('UPDATE qbo_connections SET fishtape_cursor = $2, updated_at = now() WHERE tenant_id = $1', [tenantId, maxSeq]);
    return { queued };
  }, { write: true });
}
