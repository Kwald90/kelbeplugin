// Company administration: members and roles, crew PINs, shared devices and crew
// sign-in, API keys, tenant secrets.
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { COLLECTIONS } from '../../collections.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { EMAIL_RE, normaliseEmail } from '../../services/tenants.js';
import { ROLE_NAMES, ADMIN_ROLES } from '../../auth/permissions.js';
import { validScopes } from '../../auth/access.js';
import { createApiKey, publicKey } from '../../auth/apikeys.js';
import { registerDevice, revokeDevice } from '../../auth/devices.js';
import { hashSecret, pinProblem, verifySecret } from '../../auth/passwords.js';
import { DEVICE_COOKIE, createSession, cookieOptions } from '../../auth/sessions.js';
import { issuePasswordLink } from '../../services/resets.js';
import { pointsRecordedByOthers } from '../../services/location.js';
import { deleteSecret, isSecretName, listSecrets, setSecret } from '../../services/secrets.js';
import { authLimit, setSessionCookie, tenantCtx } from '../util.js';

const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

/** Linking a member to an employee record whose location points another account recorded. */
async function refuseLocationHandover(tx, employeeId, userId) {
  if (await pointsRecordedByOthers(tx, employeeId, userId)) {
    throw conflict('That employee record holds location history recorded by another person, which only they can see. Link it again once retention has removed it.');
  }
}
const SCOPES = validScopes(COLLECTIONS);

const memberView = (m) => ({
  id: m.id, userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role, status: m.status,
  employeeId: m.employee_id, hasPin: Boolean(m.pin_hash), createdAt: m.created_at, lastUsedAt: m.last_used_at,
});

/** @param {import('fastify').FastifyInstance} app */
export default async function adminRoutes(app, { config, db, email }) {
  /** Run fn in the principal's tenant and append an audit event. */
  const audited = (req, fn, event) => db.withTenant(tenantCtx(req.principal), async (tx) => {
    const out = await fn(tx);
    const e = typeof event === 'function' ? event(out) : event;
    await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, request: requestFacts(req), ...e });
    return out;
  }, { write: true });

  async function loadMember(q, tenantId, id) {
    const { rows } = await q.query(
      `SELECT m.*, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.tenant_id = $2`, [id, tenantId]);
    if (!rows[0]) throw notFound('No such member.');
    return rows[0];
  }

  async function activeOwners(q, tenantId) {
    const { rows } = await q.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'", [tenantId]);
    return rows[0].n;
  }

  // ---- members ------------------------------------------------------------

  app.get('/api/v1/members', { config: { auth: 'manager' }, schema: { tags: ['members'], summary: 'Members of the company' } }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.*, u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY u.display_name`, [req.principal.tenantId]);
    return { data: rows.map(memberView) };
  });

  app.post('/api/v1/members', {
    config: { auth: 'admin' },
    schema: {
      tags: ['members'], summary: 'Add a member. With an email, an invite to set a password is sent; without, the member is PIN-only (crew on a shared device).',
      body: {
        type: 'object', required: ['name', 'role'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, email: { type: 'string', maxLength: 254 }, role: { type: 'string', enum: ROLE_NAMES }, employeeId: { type: 'string', maxLength: 128 } },
      },
    },
  }, async (req, reply) => {
    const p = req.principal;
    const b = req.body;
    if (b.role === 'owner' && p.role !== 'owner') throw forbidden('Only an owner can add another owner.');
    const addr = b.email ? normaliseEmail(b.email) : null;
    if (addr && !EMAIL_RE.test(addr)) throw badRequest('That email address does not look right.');
    let invite = null;
    const member = await audited(req, async (tx) => {
      let userId = null;
      if (addr) userId = (await tx.query('SELECT id FROM users WHERE email = $1', [addr])).rows[0]?.id || null;
      if (!userId) {
        const u = await tx.query('INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id', [addr, b.name]);
        userId = u.rows[0].id;
        if (addr) invite = { userId, addr };
      }
      const dup = await tx.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tx.tenantId, userId]);
      if (dup.rows.length) throw conflict('That person is already a member.');
      if (b.employeeId) {
        const taken = await tx.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND employee_id = $2', [tx.tenantId, b.employeeId]);
        if (taken.rows.length) throw conflict('That employee record is already linked to another member.');
        await refuseLocationHandover(tx, b.employeeId, userId);
      }
      const { rows } = await tx.query(
        `INSERT INTO memberships (tenant_id, user_id, role, employee_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tx.tenantId, userId, b.role, b.employeeId || null, invite ? 'invited' : 'active']);
      if (invite) await issuePasswordLink(tx, { config, email }, { userId, to: addr, invite: true });
      return loadMember(tx, tx.tenantId, rows[0].id);
    }, (m) => ({ action: 'member.add', collection: 'memberships', recordId: m.id, summary: `${m.display_name} added as ${m.role}` }));
    reply.code(201);
    return memberView(member);
  });

  app.patch('/api/v1/members/:id', {
    config: { auth: 'admin' },
    schema: {
      tags: ['members'], summary: 'Change a member\'s role, employee link or status', params: uuidParam,
      body: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', enum: ROLE_NAMES }, employeeId: { type: ['string', 'null'], maxLength: 128 }, status: { type: 'string', enum: ['active', 'disabled'] } } },
    },
  }, async (req) => {
    const p = req.principal;
    const b = req.body || {};
    const m = await audited(req, async (tx) => {
      const cur = await loadMember(tx, tx.tenantId, req.params.id);
      const touchesOwner = cur.role === 'owner' || b.role === 'owner';
      if (touchesOwner && p.role !== 'owner') throw forbidden('Only an owner can change an owner, or make someone an owner.');
      const losingOwner = cur.role === 'owner' && cur.status === 'active' && ((b.role && b.role !== 'owner') || b.status === 'disabled');
      if (losingOwner && (await activeOwners(tx, tx.tenantId)) <= 1) throw conflict('A company needs at least one active owner.');
      if (b.employeeId) {
        const taken = await tx.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND employee_id = $2 AND id <> $3', [tx.tenantId, b.employeeId, cur.id]);
        if (taken.rows.length) throw conflict('That employee record is already linked to another member.');
        if (b.employeeId !== cur.employee_id) await refuseLocationHandover(tx, b.employeeId, cur.user_id);
      }
      await tx.query(
        `UPDATE memberships SET role = COALESCE($3, role), employee_id = CASE WHEN $4 THEN $5 ELSE employee_id END,
                status = COALESCE($6, status), updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [cur.id, tx.tenantId, b.role ?? null, 'employeeId' in b, b.employeeId ?? null, b.status ?? null]);
      if (b.status === 'disabled') {
        await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL', [cur.user_id, tx.tenantId]);
      }
      return loadMember(tx, tx.tenantId, cur.id);
    }, (m) => ({ action: 'member.update', collection: 'memberships', recordId: m.id, summary: `${m.display_name}: ${m.role}, ${m.status}`, meta: { changes: Object.keys(b) } }));
    return memberView(m);
  });

  app.put('/api/v1/members/:id/pin', {
    config: { auth: 'tenant', apiKey: false, rateLimit: authLimit(config) },
    schema: { tags: ['members'], summary: 'Set a crew PIN (managers for anyone, members for themselves)', params: uuidParam, body: { type: 'object', required: ['pin'], additionalProperties: false, properties: { pin: { type: 'string', maxLength: 8 } } } },
  }, async (req, reply) => {
    const p = req.principal;
    if (p.crew) throw forbidden('Crew sessions cannot change PINs.');
    const problem = pinProblem(req.body.pin);
    if (problem) throw new ApiError(400, 'weak_pin', problem);
    const hashed = await hashSecret(req.body.pin);
    await audited(req, async (tx) => {
      const m = await loadMember(tx, tx.tenantId, req.params.id);
      if (!p.isManager && m.user_id !== p.userId) throw forbidden('You can only set your own PIN.');
      if (ADMIN_ROLES.includes(m.role) && !ADMIN_ROLES.includes(p.role) && m.user_id !== p.userId) throw forbidden('Only an owner or admin can set an owner/admin PIN.');
      await tx.query('UPDATE memberships SET pin_hash = $3, pin_failed = 0, pin_locked_until = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2', [m.id, tx.tenantId, hashed]);
      return m;
    }, (m) => ({ action: 'member.pin_set', collection: 'memberships', recordId: m.id, summary: `PIN set for ${m.display_name}` }));
    reply.code(204);
  });

  app.delete('/api/v1/members/:id', {
    config: { auth: 'admin' },
    schema: { tags: ['members'], summary: 'Remove a member from the company (signs them out here)', params: uuidParam },
  }, async (req, reply) => {
    const p = req.principal;
    await audited(req, async (tx) => {
      const m = await loadMember(tx, tx.tenantId, req.params.id);
      if (m.role === 'owner' && p.role !== 'owner') throw forbidden('Only an owner can remove an owner.');
      if (m.role === 'owner' && m.status === 'active' && (await activeOwners(tx, tx.tenantId)) <= 1) throw conflict('A company needs at least one active owner.');
      await tx.query('DELETE FROM memberships WHERE id = $1 AND tenant_id = $2', [m.id, tx.tenantId]);
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL', [m.user_id, tx.tenantId]);
      return m;
    }, (m) => ({ action: 'member.remove', collection: 'memberships', recordId: m.id, summary: `${m.display_name} removed` }));
    reply.code(204);
  });

  // ---- shared devices + crew sign-in -------------------------------------

  app.post('/api/v1/devices', {
    config: { auth: 'manager' },
    schema: {
      tags: ['devices'], summary: 'Register this device for crew PIN sign-in. The device token is returned once (and set as the ft_device cookie for browsers).',
      body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } },
    },
  }, async (req, reply) => {
    const p = req.principal;
    const out = await audited(req, (tx) => registerDevice(tx, { tenantId: tx.tenantId, name: req.body.name, createdBy: p.userId }),
      (o) => ({ action: 'device.register', collection: 'devices', recordId: o.device.id, summary: `Device ${o.device.name} registered` }));
    if (req.auth.via === 'cookie') reply.setCookie(DEVICE_COOKIE, out.token, cookieOptions(config, 400 * 24 * 3600, '/api/v1/devices'));
    reply.code(201);
    return { device: out.device, deviceToken: out.token };
  });

  app.get('/api/v1/devices', { config: { auth: 'manager' }, schema: { tags: ['devices'], summary: 'Registered devices' } }, async (req) => {
    const { rows } = await db.query(
      'SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE tenant_id = $1 ORDER BY created_at DESC', [req.principal.tenantId]);
    return { data: rows.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at })) };
  });

  app.delete('/api/v1/devices/:id', { config: { auth: 'manager' }, schema: { tags: ['devices'], summary: 'Revoke a device and its crew sessions', params: uuidParam } }, async (req, reply) => {
    const ok = await audited(req, (tx) => revokeDevice(tx, tx.tenantId, req.params.id),
      { action: 'device.revoke', collection: 'devices', recordId: req.params.id, summary: 'Device revoked' });
    if (!ok) throw notFound('No such device.');
    reply.code(204);
  });

  app.get('/api/v1/devices/crew', {
    config: { auth: 'device' },
    schema: { tags: ['devices'], summary: 'Crew who can sign in on this device (device token in X-Fishtape-Device, the ft_device cookie, or Bearer)' },
  }, async (req) => {
    const d = req.auth.device;
    const { rows } = await db.query(
      `SELECT m.id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.status = 'active' AND m.pin_hash IS NOT NULL AND u.status = 'active' ORDER BY u.display_name`, [d.tenant_id]);
    return { company: d.tenant_name, crew: rows.map((r) => ({ membershipId: r.id, name: r.display_name, role: r.role })) };
  });

  app.post('/api/v1/devices/crew/sign-in', {
    config: { auth: 'device', rateLimit: authLimit(config) },
    schema: {
      tags: ['devices'], summary: 'Crew PIN sign-in on a registered device; returns a short crew session limited to this device',
      body: { type: 'object', required: ['membershipId', 'pin'], additionalProperties: false, properties: { membershipId: { type: 'string', format: 'uuid' }, pin: { type: 'string', maxLength: 8 }, mode: { type: 'string', enum: ['cookie', 'bearer'] } } },
    },
  }, async (req, reply) => {
    const d = req.auth.device;
    const L = config.lockout;
    if (d.locked) throw new ApiError(423, 'device_locked', 'Too many wrong PINs on this device. Try again later or ask a manager.');
    const { rows } = await db.query(
      `SELECT m.*, u.display_name, u.status AS user_status, (m.pin_locked_until IS NOT NULL AND m.pin_locked_until > now()) AS locked
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.tenant_id = $2`, [req.body.membershipId, d.tenant_id]);
    const m = rows[0];
    const audit = (action, summary, userId) => db.withTenant({ tenantId: d.tenant_id, userId }, (tx) => appendAudit(tx, tx.tenantId, {
      actor: { type: 'user', id: userId, label: m?.display_name || null }, action, collection: 'devices', recordId: d.id, summary, request: requestFacts(req),
    }), { write: true });
    const deviceFail = () => db.query(
      `UPDATE devices SET failed_pins = CASE WHEN failed_pins + 1 >= $2 THEN 0 ELSE failed_pins + 1 END,
              locked_until = CASE WHEN failed_pins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
      [d.id, L.maxDevicePinFailures, L.pinLockMinutes]);
    if (!m || m.status !== 'active' || m.user_status !== 'active' || !m.pin_hash) {
      await deviceFail();
      throw new ApiError(401, 'invalid_pin', 'Wrong name or PIN.');
    }
    if (m.locked) {
      await audit('auth.pin_locked', `PIN sign-in refused for ${m.display_name}: locked`, m.user_id);
      throw new ApiError(423, 'pin_locked', `Too many wrong PINs. Try again in ${L.pinLockMinutes} minutes.`);
    }
    if (!(await verifySecret(m.pin_hash, req.body.pin))) {
      const lock = m.pin_failed + 1 >= L.maxFailedPins;
      await db.query(
        `UPDATE memberships SET pin_failed = $2, pin_locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE pin_locked_until END WHERE id = $1`,
        [m.id, lock ? 0 : m.pin_failed + 1, lock, L.pinLockMinutes]);
      await deviceFail();
      await audit('auth.pin_failed', `Wrong PIN for ${m.display_name}${lock ? ' (locked)' : ''}`, m.user_id);
      throw new ApiError(401, 'invalid_pin', 'Wrong name or PIN.');
    }
    await db.query('UPDATE memberships SET pin_failed = 0, pin_locked_until = NULL, last_used_at = now() WHERE id = $1', [m.id]);
    await db.query('UPDATE devices SET failed_pins = 0 WHERE id = $1', [d.id]);
    const s = await createSession(db, {
      userId: m.user_id, tenantId: d.tenant_id, kind: 'crew', deviceId: d.id, authMethod: 'pin', mfaVerified: false,
      ttlS: config.session.crewTtlS, idleS: config.session.crewIdleS, request: requestFacts(req),
    });
    await audit('auth.pin_login', `${m.display_name} signed in on ${d.name}`, m.user_id);
    if (req.body.mode !== 'bearer') setSessionCookie(reply, config, s.token, config.session.crewTtlS);
    return { expiresAt: s.expiresAt, ...(req.body.mode === 'bearer' ? { token: s.token } : {}), name: m.display_name, role: m.role };
  });

  // ---- API keys -----------------------------------------------------------

  app.get('/api/v1/api-keys', { config: { auth: 'admin' }, schema: { tags: ['api-keys'], summary: 'API keys (never the secret)' } }, async (req) => {
    const { rows } = await db.query('SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC', [req.principal.tenantId]);
    return { data: rows.map(publicKey) };
  });

  app.post('/api/v1/api-keys', {
    config: { auth: 'admin' },
    schema: {
      tags: ['api-keys'], summary: 'Create an API key; the key is returned once',
      description: `Scopes: <collection>:read, <collection>:write (implies read), *:read, *:write. Collections: ${COLLECTIONS.join(', ')}.`,
      body: {
        type: 'object', required: ['name', 'scopes'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, scopes: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 60 } }, expiresAt: { type: 'string', format: 'date-time' } },
      },
    },
  }, async (req, reply) => {
    const bad = req.body.scopes.filter((s) => !SCOPES.has(s));
    if (bad.length) throw badRequest('Unknown scope. Use <collection>:read, <collection>:write, *:read or *:write.');
    if (req.body.expiresAt && Date.parse(req.body.expiresAt) <= Date.now()) throw badRequest('expiresAt must be in the future.');
    const out = await audited(req, (tx) => createApiKey(tx, config, {
      tenantId: tx.tenantId, name: req.body.name, scopes: [...new Set(req.body.scopes)], createdBy: req.principal.userId, expiresAt: req.body.expiresAt,
    }), (o) => ({ action: 'api_key.create', collection: 'api_keys', recordId: o.apiKey.id, summary: `API key ${o.apiKey.name} (${o.apiKey.prefix}…) created`, meta: { scopes: o.apiKey.scopes } }));
    reply.code(201);
    return out;
  });

  app.delete('/api/v1/api-keys/:id', { config: { auth: 'admin' }, schema: { tags: ['api-keys'], summary: 'Revoke an API key', params: uuidParam } }, async (req, reply) => {
    const n = await audited(req, async (tx) => (await tx.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL', [req.params.id, tx.tenantId])).rowCount,
    { action: 'api_key.revoke', collection: 'api_keys', recordId: req.params.id, summary: 'API key revoked' });
    if (!n) throw notFound('No such API key.');
    reply.code(204);
  });

  // ---- tenant secrets (Stripe, Resend, Twilio, AI keys...) -----------------
  // One code path for company keys: services/secrets.js (fixed names, envelope encryption bound
  // to the company and name, hints only on the way out). The Integrations screen uses these too.

  const secretName = { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$' } } };
  const knownSecret = (name) => { if (!isSecretName(name)) throw badRequest('Unknown secret name.'); };

  app.get('/api/v1/secrets', { config: { auth: 'admin' }, schema: { tags: ['secrets'], summary: 'Stored secrets: names and hints, never values' } }, async (req) => {
    const rows = await db.withTenant(tenantCtx(req.principal), (tx) => listSecrets(tx, app.sealer));
    return { data: rows };
  });

  app.put('/api/v1/secrets/:name', {
    config: { auth: 'admin' },
    schema: { tags: ['secrets'], summary: 'Store or replace a secret (envelope-encrypted)', params: secretName, body: { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: 'string', minLength: 1, maxLength: 4096 } } } },
  }, async (req, reply) => {
    knownSecret(req.params.name);
    await audited(req, (tx) => setSecret(tx, app.sealer, req.params.name, req.body.value, `user:${req.principal.userId}`),
      { action: 'secret.put', collection: 'tenant_secrets', recordId: req.params.name, summary: `Secret ${req.params.name} saved` });
    reply.code(204);
  });

  app.delete('/api/v1/secrets/:name', { config: { auth: 'admin' }, schema: { tags: ['secrets'], summary: 'Delete a secret', params: secretName } }, async (req, reply) => {
    knownSecret(req.params.name);
    const removed = await audited(req, (tx) => deleteSecret(tx, req.params.name),
      { action: 'secret.delete', collection: 'tenant_secrets', recordId: req.params.name, summary: `Secret ${req.params.name} deleted` });
    if (!removed) throw notFound('No such secret.');
    reply.code(204);
  });

}
