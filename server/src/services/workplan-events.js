// What a work-task write means for the people involved (lib/workplan.js taskEvents):
//   published  a task reached a worker's list (a day was published, or a task was added to a
//              published day: the "new" badge)
//   blocked    a worker marked a task blocked, with a reason: the foreman should hear about it
// services/records.js calls afterTaskWrite after every work-task write
// (REST and sync), inside the request's transaction.
import { taskEvents } from '../../../electrical-app/js/lib/workplan.js';

/**
 * NOTIFY HOOK (work plans). There is no server-side notify() helper yet; the notifications
 * workstream adds one. Wire it here, batching per person:
 *   published -> the task's worker: "Your list for <day> is ready" (one per worker per day,
 *                not one per task), or "New task added to today" when e.lateAdd
 *   blocked   -> the plan's foreman and the office: "<worker> is blocked on <title>: <reason>"
 * Until then the PWA shows both on its own after the next sync (My day banner and "new"
 * badges for workers; dashboard "Needs attention" and the red board chip for foremen).
 * @param {import('../db.js').TenantTx} tx
 * @param {{ id: string, before: object|null, after: object|null, who: object }} write
 * @returns {Promise<ReturnType<typeof taskEvents>>}
 */
export async function afterTaskWrite(tx, { id, before, after, who }) {
  const events = taskEvents(before, after).map((e) => ({ ...e, taskId: id }));
  // TODO(notifications): if (events.length) await notify(tx, tx.tenantId, events, { actor: who.actor });
  return events;
}
