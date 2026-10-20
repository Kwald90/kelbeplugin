// What a work-task write means for the people involved (lib/workplan.js taskEvents):
//   published  a task reached a worker's list (a day was published, or a task was added to a
//              published day: the "new" badge)
//   blocked    a worker marked a task blocked, with a reason: the foreman should hear about it
// services/records.js calls afterTaskWrite after every work-task write
// (REST and sync), inside the request's transaction.
import { taskEvents } from '../../../electrical-app/js/lib/workplan.js';
import { notify } from './notify.js';

/**
 * NOTIFY HOOK (work plans), wired to services/notify.js, batched per person:
 *   published -> the task's worker: "Your list for <day> is ready" (one per worker per day,
 *                not one per task), or "New task added to today" when e.lateAdd
 *   blocked   -> the plan's foreman and the office: "<worker> is blocked on <title>: <reason>"
 * The PWA also shows both after the next sync (My day banner and "new" badges for workers;
 * dashboard "Needs attention" and the red board chip for foremen).
 * @param {import('../db.js').TenantTx} tx
 * @param {{ id: string, before: object|null, after: object|null, who: object }} write
 * @returns {Promise<ReturnType<typeof taskEvents>>}
 */
export async function afterTaskWrite(tx, { id, before, after, who }) {
  const events = taskEvents(before, after).map((e) => ({ ...e, taskId: id }));
  for (const e of events) {
    if (e.kind === 'published' && e.employeeId) {
      // One "your list is ready" per worker per day (the ref), or one per task added later.
      await notify(tx, e.lateAdd
        ? { employeeId: e.employeeId, kind: 'workplan', title: `New task added for ${e.date}: ${e.title}`.slice(0, 300), link: '#/today', ref: `wp-add:${id}` }
        : { employeeId: e.employeeId, kind: 'workplan', title: `Your list for ${e.date} is ready`, link: '#/today', ref: `wp-day:${e.employeeId}:${e.date}` });
    } else if (e.kind === 'blocked') {
      const worker = e.employeeId ? (await tx.query('SELECT data->>\'name\' AS name FROM employees WHERE tenant_id = $1 AND id = $2', [tx.tenantId, e.employeeId])).rows[0]?.name : null;
      await notify(tx, { perm: 'workplan', kind: 'workplan', title: `${worker || 'A worker'} is blocked on ${e.title}${e.reason ? `: ${e.reason}` : ''}`.slice(0, 300), link: '#/workplan', ref: `wp-block:${id}:${(after?.blocks || []).length}` });
    }
  }
  return events;
}
