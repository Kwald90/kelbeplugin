// notify(): put something in people's notification bell. Call it with the transaction you are
// already in (a TenantTx from db.withTenant), so the notification commits with the change it is
// about:
//
//   await notify(tx, { role: ['owner', 'admin'], kind: 'payment', title: 'Card payment received', link: '#/invoices/abc' });
//   await notify(tx, { userId, kind: 'job_assigned', title: 'You are on J-1042', link: '#/jobs/j1', ref: 'job:j1' });
//   await notify(tx, { perm: 'invoices', kind: 'payment', ... });   // everyone whose role has a permission
//
// Targets: userId (one person or an array), employeeId (the employees record a member is linked to),
// role (one role or an array), or perm (a permission key from auth/permissions.js). Only active members of the transaction's company get it. `ref` makes
// it once-only per person (a webhook retried, a job saved twice). Titles and bodies are shown in the
// app and in the optional daily email digest: keep contact details (emails, phone numbers) out.
//
// It never throws: a notification is never worth failing the payment or lead it reports. It runs
// in a savepoint and returns the number of people notified (0 on failure).
import { ROLES } from '../auth/permissions.js';

const KIND = /^[a-z][a-z0-9_.-]{0,39}$/;
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/**
 * @param {{ query: Function, tenantId: string, savepoint?: Function }} tx
 * @param {{ userId?: string|string[], employeeId?: string|string[], role?: string|string[], perm?: string, kind: string, title: string, body?: string, link?: string, ref?: string }} n
 * @returns {Promise<number>}
 */
export async function notify(tx, n) {
  try {
    if (!tx?.tenantId || !n || !KIND.test(n.kind || '') || !String(n.title || '').trim()) return 0;
    const link = n.link && /^#\//.test(n.link) ? clip(n.link, 500) : null;
    let roles = null;
    if (n.role) roles = [].concat(n.role);
    else if (n.perm) roles = Object.entries(ROLES).filter(([, r]) => r.perms.includes(n.perm)).map(([k]) => k);
    const userIds = n.userId ? [].concat(n.userId).filter(Boolean) : null;
    const employeeIds = n.employeeId ? [].concat(n.employeeId).filter(Boolean).map(String) : null;
    if (!roles && !userIds && !employeeIds) return 0;
    // One insert per person, each in its own savepoint: a repeated ref (unique per person) skips
    // that person only. (INSERT ... ON CONFLICT would need to read other people's rows, which RLS forbids.)
    const kind = n.kind, title = clip(n.title.trim(), 300), body = clip(n.body, 2000), ref = clip(n.ref, 200);
    const run = async () => {
      const { rows } = await tx.query(
        `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active'
            AND ($2::text[] IS NULL OR m.role = ANY($2)) AND ($3::uuid[] IS NULL OR m.user_id = ANY($3))
            AND ($4::text[] IS NULL OR m.employee_id = ANY($4))`, [tx.tenantId, roles, userIds, employeeIds]);
      let count = 0;
      for (const { user_id: userId } of rows) {
        await tx.query('SAVEPOINT notify_one');
        try {
          await tx.query('INSERT INTO notifications (tenant_id, user_id, kind, title, body, link, ref) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [tx.tenantId, userId, kind, title, body, link, ref]);
          await tx.query('RELEASE SAVEPOINT notify_one');
          count++;
        } catch (e) {
          await tx.query('ROLLBACK TO SAVEPOINT notify_one');
          if (e?.code !== '23505') throw e; // 23505: this person already has this ref
        }
      }
      return count;
    };
    return typeof tx.savepoint === 'function' ? await tx.savepoint(run) : await run();
  } catch (e) {
    if (process.env.DEBUG_NOTIFY) console.error('notify failed', e);
    return 0;
  }
}

/** The roles that may approve or dismiss AI suggestions (routes/v1/ai.js: managers). */
export const MANAGER_ROLES = ['owner', 'admin', 'office', 'foreman'];
