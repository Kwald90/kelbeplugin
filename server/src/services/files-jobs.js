// Worker job for Files (migration 0189): `files_purge_trash` removes, for every company, the files
// that have been in Recently deleted longer than FILES_TRASH_DAYS (row and bytes), with an audit event
// for each. Scheduled daily by the worker's hourly housekeeping (deduplicated while queued).
import { enqueue } from './queue.js';
import { appendAudit } from './audit.js';
import { filesSettings, removeStored } from './files.js';

export const PURGE_KIND = 'files_purge_trash';

/** Daily, deduplicated across workers. */
export function scheduleFilesJobs(db) {
  const tomorrow = new Date(Date.now() + 23 * 3600_000);
  return enqueue(db, { kind: PURGE_KIND, dedupeKey: PURGE_KIND, maxAttempts: 3, runAt: tomorrow });
}

/** Purge one company's expired Recently deleted files. Returns how many went. */
export async function purgeTrash(db, tenantId, store) {
  const gone = await db.withTenant({ tenantId }, async (tx) => {
    const rows = (await tx.query(
      `DELETE FROM files WHERE tenant_id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - make_interval(days => $2)
       RETURNING id, name, storage_key, bytes`, [tx.tenantId, store.trashDays])).rows;
    for (const r of rows) {
      await appendAudit(tx, tx.tenantId, {
        actor: { type: 'system', id: null, label: 'Files clean-up' }, action: 'file.purge', collection: 'files', recordId: r.id,
        summary: `Removed ${r.name} after ${store.trashDays} days in Recently deleted`, meta: { bytes: Number(r.bytes) },
      });
    }
    return rows;
  }, { write: true });
  for (const r of gone) await removeStored(store.dir, r.storage_key).catch(() => {});
  return gone.length;
}

/** @param {{ config: object }} deps */
export function createFilesHandlers({ config }) {
  const store = filesSettings(config);
  return {
    [PURGE_KIND]: async ({ db, log }) => {
      if (store.problem) return { skipped: store.problem };
      let purged = 0;
      const { rows: tenants } = await db.query('SELECT id FROM tenants');
      for (const t of tenants) purged += await purgeTrash(db, t.id, store);
      if (purged) log?.info?.(`${PURGE_KIND} removed ${purged}`);
      return { purged };
    },
  };
}
