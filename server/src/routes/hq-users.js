// Every account across companies, and the audit log, for HQ:
//   GET  /api/hq/users                       users with companies, roles, MFA, last sign-in, lock state
//   POST /api/hq/users/:id/unlock            clear password and PIN lockouts (HQ admin)
//   POST /api/hq/users/:id/revoke-sessions   sign out everywhere (HQ admin)
//   POST /api/hq/users/:id/force-reset       clear the password, sign out, email a reset link (HQ admin)
//   POST /api/hq/audit/search                audit events by chain, actor, action and time (from/to are ISO times; the page sends local day bounds)
//   POST /api/hq/audit/verify-all            verify every hash chain
// Every action is audited in the platform chain and in each company the person belongs to.
// Responses never carry password, PIN, token or MFA secrets, only whether they exist.
import { ApiError, conflict, notFound } from '../errors.js';
import { BRAND } from '../brand.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { hqAudit, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';

export const FORCED_RESET_TTL_S = 24 * 3600;
const reasonBody = {
  type: 'object', required: ['reason'], additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 5, maxLength: 300 } },
};

/** The email a person gets when HQ resets their password. */
export function forcedResetEmail({ to, link }) {
  return {
    to, template: 'password-reset-forced', subject: `Set a new ${BRAND.name} password`,
    text: `${BRAND.name} support reset the password on your account and signed you out of every device.\n\n`
      + `Set a new password here (the link works for 24 hours):\n\n${link}\n\n`
      + 'If you did not contact support about this, reply to this email.',
  };
}

const USER_SQL = `
  SELECT u.id, u.display_name, u.email, u.platform_role, u.status, u.last_login_at, u.created_at, u.failed_logins,
         u.locked_until, u.locked_until > now() AS locked, u.password_hash IS NOT NULL AS has_password,
         EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa,
         (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions,
         (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
         COALESCE((SELECT json_agg(json_build_object('tenantId', m.tenant_id, 'tenantName', t.name, 'role', m.role, 'status', m.status,
                                    'pinLocked', m.pin_locked_until > now(), 'hasPin', m.pin_hash IS NOT NULL) ORDER BY t.name)
                     FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = u.id), '[]') AS memberships
    FROM users u`;

export function userView(u) {
  const memberships = (u.memberships || []).map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName, role: m.role, status: m.status, pinLocked: Boolean(m.pinLocked), hasPin: Boolean(m.hasPin) }));
  return {
    id: u.id, name: u.display_name, email: u.email, platformRole: u.platform_role, status: u.status,
    mfa: u.mfa, hasPassword: u.has_password, locked: Boolean(u.locked), lockedUntil: u.locked ? iso(u.locked_until) : null,
    failedLogins: u.failed_logins, pinLocked: memberships.some((m) => m.pinLocked),
    activeSessions: u.sessions, lastLoginAt: iso(u.last_login_at), lastSeenAt: iso(u.last_seen_at), createdAt: iso(u.created_at),
    memberships,
  };
}

/** @param {import('fastify').FastifyInstance} app */
export default async function hqUserRoutes(app, { config, db, email }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  app.get('/api/hq/users', { config: hq, schema: { tags, summary: 'Every user with companies, roles, MFA, last sign-in and lock state' } }, async (req) => {
    return db.withHq(async (c) => {
      const { rows } = await c.query(`${USER_SQL} ORDER BY u.created_at DESC LIMIT 5000`);
      await hqAudit(c, req, null, { action: 'hq.users_view', collection: 'users', summary: `Viewed the user list (${rows.length} people)` });
      return { data: rows.map(userView) };
    });
  });

  /** Load the user, refuse acting on yourself where it would lock you out, run fn, audit everywhere. */
  async function act(req, { action, verb, self = false }, fn) {
    requireHqAdmin(req);
    const id = req.params.id;
    if (!self && id === req.principal.userId) throw conflict('Use your own account settings for this, not HQ.');
    return db.withHq(async (c) => {
      const u = (await c.query(`${USER_SQL} WHERE u.id = $1`, [id])).rows[0];
      if (!u) throw notFound('No such user.');
      const result = await fn(c, u);
      const reason = req.body?.reason?.trim() || '';
      const who = u.email || u.display_name;
      await hqAudit(c, req, null, { action, collection: 'users', recordId: id, summary: `${verb} ${who}${reason ? `: ${reason}` : ''}`.slice(0, 500), meta: result?.meta || null });
      // Each company the person belongs to sees it in its own security log.
      for (const m of u.memberships || []) {
        await hqAudit(c, req, m.tenantId, { action, collection: 'users', recordId: id, summary: `${BRAND.name} support: ${verb.toLowerCase()} ${u.display_name}${reason ? ` (${reason})` : ''}`.slice(0, 500) });
      }
      const fresh = (await c.query(`${USER_SQL} WHERE u.id = $1`, [id])).rows[0];
      return { user: userView(fresh), ...(result?.out || {}) };
    });
  }

  app.post('/api/hq/users/:id/unlock', {
    config: hq,
    schema: { tags, summary: 'Clear password and PIN lockouts (HQ admin; audited)', params: uuidParams('id'), body: { ...reasonBody, required: [] } },
  }, async (req) => act(req, { action: 'hq.user_unlock', verb: 'Unlocked', self: true }, async (c, u) => {
    await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [u.id]);
    const pins = await c.query('UPDATE memberships SET pin_failed = 0, pin_locked_until = NULL WHERE user_id = $1 AND (pin_failed > 0 OR pin_locked_until IS NOT NULL)', [u.id]);
    return { meta: { wasLocked: Boolean(u.locked), pinsCleared: pins.rowCount } };
  }));

  app.post('/api/hq/users/:id/revoke-sessions', {
    config: hq,
    schema: { tags, summary: 'Sign the person out of every device (HQ admin; audited)', params: uuidParams('id'), body: reasonBody },
  }, async (req) => act(req, { action: 'hq.user_revoke_sessions', verb: 'Signed out everywhere' }, async (c, u) => {
    const r = await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
    return { meta: { sessions: r.rowCount }, out: { revoked: r.rowCount } };
  }));

  app.post('/api/hq/users/:id/force-reset', {
    config: hq,
    schema: { tags, summary: 'Clear the password, sign out everywhere and email a reset link (HQ admin; audited)', params: uuidParams('id'), body: reasonBody },
  }, async (req) => act(req, { action: 'hq.user_force_reset', verb: 'Forced a password reset for' }, async (c, u) => {
    if (!u.email) throw new ApiError(409, 'no_email', 'This person signs in with a PIN only. Reset the PIN from the company\'s Employees screen.');
    if (u.status !== 'active') throw new ApiError(409, 'user_disabled', 'This account is disabled.');
    await c.query('UPDATE users SET password_hash = NULL, password_changed_at = now(), failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [u.id]);
    const r = await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
    await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [u.id]);
    const token = randomToken('ftr_');
    await c.query("INSERT INTO password_resets (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, 'reset', now() + make_interval(secs => $3))", [u.id, sha256(token), FORCED_RESET_TTL_S]);
    await email.send(c, forcedResetEmail({ to: u.email, link: `${config.publicOrigin}/#/reset-password?token=${encodeURIComponent(token)}` }));
    return { meta: { sessions: r.rowCount }, out: { revoked: r.rowCount, emailed: true } };
  }));

  // ---- audit log ------------------------------------------------------------------

  app.post('/api/hq/audit/search', {
    config: hq,
    schema: {
      tags, summary: 'Audit events: one chain (platform or a company) or HQ actions everywhere; filters in the body',
      body: {
        type: 'object', required: ['scope'], additionalProperties: false,
        properties: {
          scope: { type: 'string', pattern: '^(platform|hq|[0-9a-f-]{36})$' },
          actor: { type: 'string', maxLength: 120 },
          action: { type: 'string', maxLength: 100 },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          cursor: { type: 'string', pattern: '^\\d{1,18}$' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    const tenantId = b.scope === 'platform' || b.scope === 'hq' ? null : b.scope;
    return db.withHq(async (c) => {
      let tenantName = null;
      if (tenantId) {
        const t = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0];
        tenantName = t?.name ?? null;
        if (!t && !(await c.query('SELECT 1 FROM audit_events WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows.length) throw notFound('No such company.');
      }
      const where = [];
      const params = [];
      const p = (v) => { params.push(v); return `$${params.length}`; };
      if (b.scope === 'platform') where.push('e.tenant_id IS NULL');
      else if (b.scope === 'hq') where.push("e.actor_type = 'hq'");
      else where.push(`e.tenant_id = ${p(tenantId)}`);
      if (b.actor?.trim()) {
        const term = b.actor.trim().toLowerCase();
        where.push(`(lower(e.actor_label) LIKE ${p(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)} OR e.actor_id = ${p(term)} OR e.actor_type = ${p(term)})`);
      }
      if (b.action?.trim()) where.push(`e.action LIKE ${p(`${b.action.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
      if (b.from) where.push(`e.at >= ${p(b.from)}::timestamptz`);
      if (b.to) where.push(`e.at < ${p(b.to)}::timestamptz`);
      if (b.cursor) where.push(`e.seq < ${p(b.cursor)}::bigint`);
      const { rows } = await c.query(
        `SELECT e.seq, e.at, e.tenant_id, t.name AS tenant_name, e.actor_type, e.actor_id, e.actor_label, e.action, e.collection, e.record_id,
                e.summary, e.ip, e.request_id
           FROM audit_events e LEFT JOIN tenants t ON t.id = e.tenant_id
          WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT ${p(b.limit + 1)}`, params);
      const more = rows.length > b.limit;
      const page = rows.slice(0, b.limit);
      // Reading a company's own log is a read of its data: it shows in that company's chain.
      if (tenantId && tenantName && !b.cursor) {
        await hqAudit(c, req, tenantId, { action: 'hq.audit_view', collection: 'audit_events', summary: 'HQ viewed the audit log' });
      } else if (!tenantId && !b.cursor) {
        await hqAudit(c, req, null, { action: 'hq.audit_view', collection: 'audit_events', summary: `Viewed the ${b.scope === 'hq' ? 'HQ actions' : 'platform'} audit log` });
      }
      const head = tenantId || b.scope === 'platform' ? (await c.query('SELECT * FROM audit_verify_chain($1)', [tenantId])).rows[0] : null;
      return {
        scope: b.scope, tenantName,
        verification: head ? { ok: head.ok, checked: head.checked, firstBadSeq: head.first_bad_seq } : null,
        data: page.map((e) => ({
          seq: e.seq, at: iso(e.at), tenantId: e.tenant_id, tenantName: e.tenant_name, actorType: e.actor_type, actorId: e.actor_id, actor: e.actor_label,
          action: e.action, collection: e.collection, recordId: e.record_id, summary: e.summary, ip: e.ip, requestId: e.request_id,
        })),
        cursor: more ? String(page[page.length - 1].seq) : null,
        more,
      };
    });
  });

  app.post('/api/hq/audit/verify-all', { config: hq, schema: { tags, summary: 'Verify every audit hash chain (platform and each company)' } }, async (req) => {
    return db.withHq(async (c) => {
      const chains = (await c.query(
        `SELECT DISTINCT e.tenant_id, t.name FROM audit_events e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY t.name NULLS FIRST`)).rows;
      const out = [];
      for (const ch of chains) {
        const r = (await c.query('SELECT * FROM audit_verify_chain($1)', [ch.tenant_id])).rows[0];
        out.push({ tenantId: ch.tenant_id, name: ch.tenant_id ? (ch.name || 'deleted company') : 'Platform', ok: r.ok, checked: r.checked, firstBadSeq: r.first_bad_seq });
      }
      const broken = out.filter((x) => !x.ok);
      await hqAudit(c, req, null, {
        action: 'hq.audit_verify_all', collection: 'audit_events',
        summary: `Verified ${out.length} audit chains: ${broken.length ? `${broken.length} BROKEN` : 'all intact'}`, meta: { chains: out.length, broken: broken.length },
      });
      return { ok: broken.length === 0, chains: out };
    });
  });
}
