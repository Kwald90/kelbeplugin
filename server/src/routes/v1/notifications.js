// /api/v1/notifications: the signed-in person's own notifications (the bell) and their daily
// digest setting. Rows are written by services/notify.js; RLS (migration 0090) limits every read
// and change to the person in app.user_id, so nobody sees another member's or company's bell.
//
// Sessions only (crew included): an API key acts for a company, not a person, so it has no bell.
// Marking your own notifications read is not company data and is not audited (it would flood the
// audit log); turning the email digest on or off is.
import { badRequest } from '../../errors.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { enqueue } from '../../services/queue.js';
import { createEmail } from '../../lib/email.js';
import { BRAND } from '../../brand.js';
import { tenantCtx } from '../util.js';

const tags = ['notifications'];
const view = (r) => ({
  id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  readAt: r.read_at ? (r.read_at instanceof Date ? r.read_at.toISOString() : r.read_at) : null,
});
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f-]{36})$/;

/** @param {import('fastify').FastifyInstance} app */
export default async function notificationRoutes(app, { db }) {
  const session = { auth: 'tenant', apiKey: false };
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);

  app.get('/api/v1/notifications', {
    config: session,
    schema: {
      tags, summary: 'Your notifications, newest first, with the unread count',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { unread: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, cursor: { type: 'string', maxLength: 100 } },
      },
    },
  }, async (req) => inTenant(req, async (tx) => {
    const { unread, limit, cursor } = req.query;
    const params = [tx.tenantId];
    const where = ['tenant_id = $1'];
    if (unread) where.push('read_at IS NULL');
    if (cursor) {
      const m = CURSOR.exec(cursor);
      if (!m) throw badRequest('Invalid cursor.');
      params.push(m[1], m[2]);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await tx.query(`SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ck FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    const count = await tx.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND read_at IS NULL', [tx.tenantId]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map(view), unread: count.rows[0].n, more: rows.length > limit,
      cursor: rows.length > limit && last ? `${last.ck}|${last.id}` : null,
    };
  }));

  app.patch('/api/v1/notifications', {
    config: session,
    schema: {
      tags, summary: 'Mark notifications read or unread: by id, or all of yours',
      body: {
        type: 'object', additionalProperties: false, required: ['read'],
        properties: { ids: { type: 'array', maxItems: 200, items: { type: 'string', format: 'uuid' } }, all: { type: 'boolean' }, read: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    const { ids, all, read } = req.body;
    if (!all && !ids?.length) throw badRequest('Send ids or all: true.');
    return inTenant(req, async (tx) => {
      const params = [tx.tenantId, read];
      let where = 'tenant_id = $1';
      if (!all) { params.push(ids); where += ' AND id = ANY($3::uuid[])'; }
      where += read ? ' AND read_at IS NULL' : ' AND read_at IS NOT NULL';
      const r = await tx.query(`UPDATE notifications SET read_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE ${where}`, params);
      const count = await tx.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND read_at IS NULL', [tx.tenantId]);
      return { updated: r.rowCount, unread: count.rows[0].n };
    }, { write: true });
  });

  app.get('/api/v1/notifications/prefs', { config: session, schema: { tags, summary: 'Your notification settings in this company' } }, async (req) => inTenant(req, async (tx) => {
    const { rows } = await tx.query('SELECT digest, last_digest_at FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2', [tx.tenantId, req.principal.userId]);
    return { digest: Boolean(rows[0]?.digest), lastDigestAt: rows[0]?.last_digest_at || null };
  }));

  app.put('/api/v1/notifications/prefs', {
    config: session,
    schema: { tags, summary: 'Turn the daily email digest on or off', body: { type: 'object', additionalProperties: false, required: ['digest'], properties: { digest: { type: 'boolean' } } } },
  }, async (req) => inTenant(req, async (tx) => {
    const p = req.principal;
    await tx.query(
      `INSERT INTO notification_prefs (tenant_id, user_id, digest) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET digest = EXCLUDED.digest, updated_at = now()`, [tx.tenantId, p.userId, req.body.digest]);
    await appendAudit(tx, tx.tenantId, {
      actor: p.actor, request: requestFacts(req), action: 'notifications.digest', collection: 'notification_prefs', recordId: p.userId,
      summary: `Daily notification email ${req.body.digest ? 'on' : 'off'}`,
    });
    return { digest: req.body.digest };
  }, { write: true }));
}

// ---- the daily digest (worker) ------------------------------------------------------

const dayKey = (d) => d.toISOString().slice(0, 10);

/** Queue today's digest run (deduplicated: once a day however many workers call it). Runs at 13:00 UTC (morning across Canada). */
export function scheduleNotificationDigest(db, now = new Date()) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13));
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return enqueue(db, { kind: 'notifications_digest', runAt: at, dedupeKey: `notifications_digest:${dayKey(at)}`, maxAttempts: 3 });
}

/**
 * Email each person who turned the digest on what they haven't read since the last one, through
 * the platform email outbox. The email holds titles only and a link to the app.
 */
export async function runNotificationDigest(db, { config, email = createEmail(), now = new Date() } = {}) {
  const tenants = (await db.query("SELECT id, name FROM tenants WHERE status = 'active'")).rows;
  let sent = 0;
  for (const t of tenants) {
    const users = await db.withTenant({ tenantId: t.id }, async (tx) => (await tx.query('SELECT user_id FROM notification_prefs WHERE tenant_id = $1 AND digest', [tx.tenantId])).rows);
    for (const { user_id: userId } of users) {
      const u = (await db.query(
        `SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2
          WHERE u.id = $1 AND u.status = 'active' AND m.status = 'active' AND u.email IS NOT NULL`, [userId, t.id])).rows[0];
      if (!u) continue;
      const did = await db.withTenant({ tenantId: t.id, userId }, async (tx) => {
        const { rows } = await tx.query(
          `SELECT id, title FROM notifications WHERE tenant_id = $1 AND read_at IS NULL AND emailed_at IS NULL
            AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 51`, [tx.tenantId]);
        await tx.query('UPDATE notification_prefs SET last_digest_at = $3 WHERE tenant_id = $1 AND user_id = $2', [tx.tenantId, userId, now]);
        if (!rows.length) return false;
        const list = rows.slice(0, 50).map((r) => `- ${r.title}`).join('\n');
        await email.send(tx, {
          tenantId: tx.tenantId, to: u.email, template: 'notifications-digest',
          subject: `${rows.length > 50 ? '50+' : rows.length} new in ${BRAND.name} for ${t.name}`.slice(0, 200),
          text: `Here is what came in for ${t.name}:\n\n${list}\n\nOpen ${BRAND.name}: ${config?.publicOrigin || ''}/#/notifications\n\nTurn this email off in ${BRAND.name} under Notifications.`,
        });
        await tx.query('UPDATE notifications SET emailed_at = $2 WHERE tenant_id = $1 AND id = ANY($3::uuid[])', [tx.tenantId, now, rows.map((r) => r.id)]);
        return true;
      }, { write: true });
      if (did) sent++;
    }
  }
  return { sent };
}

/** Worker handlers (src/worker.js). */
export function createNotificationHandlers({ config }) {
  return {
    async notifications_digest({ db }) {
      try { return await runNotificationDigest(db, { config }); } finally { await scheduleNotificationDigest(db); }
    },
  };
}
