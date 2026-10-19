// /api/v1/auth/*: signup, login, logout, MFA, passwords, OIDC, tenant switching, /me.
import { ApiError, badRequest, forbidden, notFound } from '../../errors.js';
import { BRAND } from '../../brand.js';
import { sha256 } from '../../lib/crypto.js';
import { issuePasswordLink } from '../../services/resets.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { EMAIL_RE, PROVINCES, createTenantWithOwner, isSignupOpen, normaliseEmail, pickTenant, userMemberships } from '../../services/tenants.js';
import { burnTime, hashSecret, passwordProblem, verifySecret } from '../../auth/passwords.js';
import { createSession, lookupSession, mfaState, revokeSession, revokeUserSessions, sessionRowById } from '../../auth/sessions.js';
import { confirmTotp, newRecoveryCodes, remainingRecoveryCodes, startTotpEnrolment, useRecoveryCode, verifyTotp } from '../../auth/mfa.js';
import { capCrewRole, permsForRole } from '../../auth/permissions.js';
import { pkce } from '../../auth/oidc.js';
import { authLimit, clearSessionCookie, setSessionCookie } from '../util.js';

const OIDC_COOKIE = 'ft_oidc';

const modeSchema = { type: 'string', enum: ['cookie', 'bearer'] };
const email = { type: 'string', minLength: 3, maxLength: 254 };
const password = { type: 'string', minLength: 1, maxLength: 256 };

/** @param {import('fastify').FastifyInstance} app */
export default async function authRoutes(app, { config, db, email: mailer, oidcProviders }) {
  const sessionTtl = (kind) => (kind === 'crew' ? config.session.crewTtlS : config.session.webTtlS);
  const sessionIdle = (kind) => (kind === 'crew' ? config.session.crewIdleS : config.session.webIdleS);

  /** Start a session and answer the way the client asked (cookie or bearer token). */
  async function startSession(req, reply, { userId, tenantId, mode, authMethod, mfaVerified = false, status = 200 }) {
    const kind = mode === 'bearer' ? 'bearer' : 'web';
    const s = await createSession(db, {
      userId, tenantId, kind, authMethod, mfaVerified, ttlS: sessionTtl(kind), idleS: sessionIdle(kind), request: requestFacts(req),
    });
    if (tenantId) await db.query('UPDATE memberships SET last_used_at = now() WHERE user_id = $1 AND tenant_id = $2', [userId, tenantId]);
    const { row } = await lookupSession(db, s.token);
    if (kind === 'web') setSessionCookie(reply, config, s.token, sessionTtl(kind));
    const state = mfaState(row);
    reply.code(status);
    return {
      mfa: state === 'ok' ? null : state,
      expiresAt: s.expiresAt,
      ...(kind === 'bearer' ? { token: s.token } : {}),
      me: await meBody(row),
    };
  }

  async function meBody(row) {
    const memberships = await userMemberships(db, row.user_id);
    const role = row.membership_status === 'active' ? (row.kind === 'crew' ? capCrewRole(row.role) : row.role) : null;
    const state = mfaState(row);
    return {
      user: { id: row.user_id, email: row.email, displayName: row.display_name, platformRole: row.platform_role || null },
      session: { kind: row.kind, expiresAt: row.expires_at, mfa: state === 'ok' ? null : state, mfaEnrolled: row.mfa_enrolled },
      tenant: row.tenant_id && role ? {
        id: row.tenant_id, name: row.tenant_name, status: row.tenant_status, role, employeeId: row.employee_id || null,
        perms: [...permsForRole(role)],
      } : null,
      memberships: memberships.map((m) => ({ tenantId: m.tenant_id, tenantName: m.tenant_name, role: m.role, status: m.status, tenantStatus: m.tenant_status })),
    };
  }

  function audit(q, tenantId, req, action, actor, extra = {}) {
    return appendAudit(q, tenantId, { actor, action, request: requestFacts(req), ...extra });
  }

  /** Platform-level audit (no tenant). */
  const platformAudit = (req, action, actor, extra) => db.tx((c) => audit(c, null, req, action, actor, extra));

  /** Audit in the user's tenant chain when they have one, else the platform chain. */
  async function userAudit(req, tenantId, action, actor, extra) {
    if (tenantId) return db.withTenant({ tenantId, userId: actor.id }, (tx) => audit(tx, tenantId, req, action, actor, extra), { write: true });
    return platformAudit(req, action, actor, extra);
  }

  // ---- providers / signup -------------------------------------------------

  app.get('/api/v1/auth/providers', { config: { auth: 'public' }, schema: { tags: ['auth'], summary: 'Sign-in options' } }, async () => ({
    password: true,
    google: Boolean(oidcProviders.google),
    microsoft: Boolean(oidcProviders.microsoft),
    signupOpen: await isSignupOpen(db),
  }));

  app.post('/api/v1/auth/signup', {
    config: { auth: 'public', rateLimit: authLimit(config) },
    schema: {
      tags: ['auth'], summary: 'Create a company and its owner (only while signup_open is on)',
      body: {
        type: 'object', required: ['email', 'password', 'name', 'companyName'], additionalProperties: false,
        properties: { email, password, name: { type: 'string', minLength: 1, maxLength: 200 }, companyName: { type: 'string', minLength: 1, maxLength: 200 }, province: { type: 'string', enum: PROVINCES }, mode: modeSchema },
      },
    },
  }, async (req, reply) => {
    if (!(await isSignupOpen(db))) throw new ApiError(403, 'signup_closed', 'New sign-ups are closed. Ask us for an invite.');
    const b = req.body;
    const addr = normaliseEmail(b.email);
    if (!EMAIL_RE.test(addr)) throw badRequest('That email address does not look right.');
    const problem = passwordProblem(b.password, addr);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    const { tenant, userId } = await createTenantWithOwner(db, {
      name: b.companyName, province: b.province || null, owner: { email: addr, password: b.password, displayName: b.name }, request: requestFacts(req),
    });
    const body = await startSession(req, reply, { userId, tenantId: tenant.id, mode: b.mode, authMethod: 'signup', status: 201 });
    return { ...body, tenant };
  });

  // ---- login / logout -----------------------------------------------------

  app.post('/api/v1/auth/login', {
    config: { auth: 'public', rateLimit: authLimit(config) },
    schema: {
      tags: ['auth'], summary: 'Sign in with email and password',
      body: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email, password, tenantId: { type: 'string', format: 'uuid' }, mode: modeSchema } },
    },
  }, async (req, reply) => {
    const addr = normaliseEmail(req.body.email);
    const { rows } = await db.query(
      `SELECT id, email, password_hash, status, failed_logins, (locked_until IS NOT NULL AND locked_until > now()) AS locked
         FROM users WHERE email = $1`, [addr]);
    const u = rows[0];
    const failed = async (reason, userId = null) => {
      await platformAudit(req, 'auth.login_failed', { type: 'user', id: userId, label: addr }, { summary: `Failed sign-in for ${addr}`, meta: { reason } });
    };
    if (!u || !u.password_hash || u.status !== 'active') {
      await burnTime(req.body.password);
      await failed('unknown_or_disabled');
      throw new ApiError(401, 'invalid_credentials', 'Email or password is wrong.');
    }
    if (u.locked) {
      await failed('locked', u.id);
      throw new ApiError(423, 'account_locked', `Too many failed attempts. Try again in ${config.lockout.lockMinutes} minutes or reset your password.`);
    }
    if (!(await verifySecret(u.password_hash, req.body.password))) {
      const n = u.failed_logins + 1;
      const lock = n >= config.lockout.maxFailedLogins;
      await db.query(
        `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
        [u.id, lock ? 0 : n, lock, config.lockout.lockMinutes]);
      await failed(lock ? 'bad_password_locked' : 'bad_password', u.id);
      throw new ApiError(401, 'invalid_credentials', 'Email or password is wrong.');
    }
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
    const tenantId = await pickTenant(db, u.id, req.body.tenantId || null);
    if (req.body.tenantId && !tenantId) throw forbidden('You are not an active member of that company.');
    await userAudit(req, tenantId, 'auth.login', { type: 'user', id: u.id, label: addr }, { summary: `${addr} signed in`, meta: { method: 'password' } });
    return startSession(req, reply, { userId: u.id, tenantId, mode: req.body.mode, authMethod: 'password' });
  });

  app.post('/api/v1/auth/logout', { config: { auth: 'session' }, schema: { tags: ['auth'], summary: 'Sign out this session' } }, async (req, reply) => {
    const s = req.auth.session;
    await revokeSession(db, s.session_id);
    clearSessionCookie(reply, config);
    await userAudit(req, s.tenant_id, 'auth.logout', { type: 'user', id: s.user_id, label: s.email }, { summary: 'Signed out' });
    reply.code(204);
  });

  // GET /api/v1/me lives in me.js (adds plan entitlements and preferences).

  app.post('/api/v1/auth/switch-tenant', {
    config: { auth: 'user' },
    schema: { tags: ['auth'], summary: 'Switch the active company', body: { type: 'object', required: ['tenantId'], additionalProperties: false, properties: { tenantId: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    const s = req.auth.session;
    const tenantId = await pickTenant(db, s.user_id, req.body.tenantId);
    if (!tenantId) throw forbidden('You are not an active member of that company.');
    await db.query('UPDATE sessions SET tenant_id = $2 WHERE id = $1', [s.session_id, tenantId]);
    await db.query('UPDATE memberships SET last_used_at = now() WHERE user_id = $1 AND tenant_id = $2', [s.user_id, tenantId]);
    await userAudit(req, tenantId, 'auth.switch_tenant', { type: 'user', id: s.user_id, label: s.email }, { summary: 'Switched company' });
    return meBody(await sessionRowById(db, s.session_id));
  });

  app.post('/api/v1/tenants', {
    config: { auth: 'user', rateLimit: authLimit(config) },
    schema: {
      tags: ['auth'], summary: 'Create another company with you as owner (only while signup_open is on)',
      body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, province: { type: 'string', enum: PROVINCES } } },
    },
  }, async (req, reply) => {
    if (!(await isSignupOpen(db))) throw new ApiError(403, 'signup_closed', 'New companies are created by Fishtape HQ for now.');
    const s = req.auth.session;
    const { tenant } = await createTenantWithOwner(db, { name: req.body.name, province: req.body.province || null, userId: s.user_id, request: requestFacts(req) });
    await db.query('UPDATE sessions SET tenant_id = $2 WHERE id = $1', [s.session_id, tenant.id]);
    reply.code(201);
    return { tenant };
  });

  // ---- MFA ----------------------------------------------------------------

  app.post('/api/v1/auth/mfa/totp/enrol', { config: { auth: 'session', rateLimit: authLimit(config) }, schema: { tags: ['auth'], summary: 'Start TOTP enrolment: returns the secret and otpauth:// URI once' } }, async (req) => {
    const s = req.auth.session;
    if (s.kind === 'crew') throw forbidden('Crew sessions cannot enrol MFA.');
    if (mfaState(s) === 'verify') throw new ApiError(403, 'mfa_required', 'Verify your current authenticator first.', { mfa: 'verify' });
    return db.tx((c) => startTotpEnrolment(c, app.sealer, { id: s.user_id, email: s.email, display_name: s.display_name }, BRAND.name));
  });

  app.post('/api/v1/auth/mfa/totp/confirm', {
    config: { auth: 'session', rateLimit: authLimit(config) },
    schema: { tags: ['auth'], summary: 'Confirm TOTP enrolment with a code; returns recovery codes once', body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req) => {
    const s = req.auth.session;
    if (s.kind === 'crew') throw forbidden('Crew sessions cannot enrol MFA.');
    if (mfaState(s) === 'verify') throw new ApiError(403, 'mfa_required', 'Verify your current authenticator first.', { mfa: 'verify' });
    const codes = await db.tx(async (c) => {
      if (!(await confirmTotp(c, app.sealer, s.user_id, req.body.code))) return null;
      await c.query('UPDATE sessions SET mfa_verified_at = now(), mfa_failed = 0 WHERE id = $1', [s.session_id]);
      return newRecoveryCodes(c, s.user_id);
    });
    if (!codes) throw new ApiError(400, 'invalid_code', 'That code did not match. Check the time on your phone and try again.');
    await userAudit(req, s.tenant_id, 'auth.mfa_enrolled', { type: 'user', id: s.user_id, label: s.email }, { summary: 'Two-step sign-in turned on' });
    return { recoveryCodes: codes };
  });

  app.post('/api/v1/auth/mfa/verify', {
    config: { auth: 'session', rateLimit: authLimit(config) },
    schema: {
      tags: ['auth'], summary: 'Verify this session with a TOTP code or a recovery code',
      body: { type: 'object', additionalProperties: false, properties: { code: { type: 'string', maxLength: 10 }, recoveryCode: { type: 'string', maxLength: 20 } } },
    },
  }, async (req) => {
    const s = req.auth.session;
    if (mfaState(s) !== 'verify') return { ok: true };
    const { code, recoveryCode } = req.body || {};
    const ok = await db.tx(async (c) => {
      const good = recoveryCode ? await useRecoveryCode(c, s.user_id, recoveryCode) : await verifyTotp(c, app.sealer, s.user_id, code);
      if (good) await c.query('UPDATE sessions SET mfa_verified_at = now(), mfa_failed = 0 WHERE id = $1', [s.session_id]);
      else await c.query(
        `UPDATE sessions SET mfa_failed = mfa_failed + 1, revoked_at = CASE WHEN mfa_failed + 1 >= $2 THEN now() ELSE revoked_at END WHERE id = $1`,
        [s.session_id, config.lockout.maxMfaFailures]);
      return good;
    });
    const actor = { type: 'user', id: s.user_id, label: s.email };
    if (!ok) {
      await userAudit(req, s.tenant_id, 'auth.mfa_failed', actor, { summary: 'Wrong two-step code' });
      if (s.mfa_failed + 1 >= config.lockout.maxMfaFailures) throw new ApiError(401, 'session_revoked', 'Too many wrong codes. Sign in again.');
      throw new ApiError(400, 'invalid_code', 'That code did not match.');
    }
    await userAudit(req, s.tenant_id, 'auth.mfa_verified', actor, { summary: recoveryCode ? 'Signed in with a recovery code' : 'Two-step code accepted' });
    return { ok: true, ...(recoveryCode ? { recoveryCodesLeft: await remainingRecoveryCodes(db, s.user_id) } : {}) };
  });

  app.post('/api/v1/auth/mfa/recovery-codes', { config: { auth: 'user', rateLimit: authLimit(config) }, schema: { tags: ['auth'], summary: 'Replace recovery codes (shown once)' } }, async (req) => {
    const s = req.auth.session;
    if (!s.mfa_enrolled) throw new ApiError(409, 'mfa_not_enrolled', 'Turn on two-step sign-in first.');
    const codes = await db.tx((c) => newRecoveryCodes(c, s.user_id));
    await userAudit(req, s.tenant_id, 'auth.recovery_codes', { type: 'user', id: s.user_id, label: s.email }, { summary: 'Recovery codes replaced' });
    return { recoveryCodes: codes };
  });

  // ---- passwords ----------------------------------------------------------

  app.post('/api/v1/auth/password/change', {
    config: { auth: 'user', rateLimit: authLimit(config) },
    schema: { tags: ['auth'], summary: 'Change password (signs out your other sessions)', body: { type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false, properties: { currentPassword: password, newPassword: password } } },
  }, async (req) => {
    const s = req.auth.session;
    const { rows } = await db.query('SELECT password_hash, email FROM users WHERE id = $1', [s.user_id]);
    if (!(await verifySecret(rows[0]?.password_hash, req.body.currentPassword))) throw new ApiError(401, 'invalid_credentials', 'Your current password is wrong.');
    const problem = passwordProblem(req.body.newPassword, rows[0].email);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    const hashed = await hashSecret(req.body.newPassword);
    await db.tx(async (c) => {
      await c.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [s.user_id, hashed]);
      await revokeUserSessions(c, s.user_id, s.session_id);
    });
    await userAudit(req, s.tenant_id, 'auth.password_changed', { type: 'user', id: s.user_id, label: s.email }, { summary: 'Password changed' });
    return { ok: true };
  });

  app.post('/api/v1/auth/password/forgot', {
    config: { auth: 'public', rateLimit: authLimit(config, Math.max(1, Math.floor(config.rateLimit.authPerMinute / 2))) },
    schema: { tags: ['auth'], summary: 'Email a reset link (always answers 202)', body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email } } },
  }, async (req, reply) => {
    const addr = normaliseEmail(req.body.email);
    const { rows } = await db.query("SELECT id FROM users WHERE email = $1 AND status = 'active'", [addr]);
    if (rows[0]) await issueReset(req, rows[0].id, addr);
    reply.code(202);
    return { ok: true };
  });

  async function issueReset(req, userId, to) {
    await db.tx((c) => issuePasswordLink(c, { config, email: mailer }, { userId, to }));
    await platformAudit(req, 'auth.password_reset_requested', { type: 'user', id: userId, label: to }, { summary: `Reset link sent to ${to}` });
  }

  app.post('/api/v1/auth/password/reset', {
    config: { auth: 'public', rateLimit: authLimit(config) },
    schema: { tags: ['auth'], summary: 'Set a new password with a reset or invite token (signs out every session)', body: { type: 'object', required: ['token', 'newPassword'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 200 }, newPassword: password } } },
  }, async (req) => {
    const { rows } = await db.query(
      `SELECT r.id, r.user_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active'`, [sha256(req.body.token)]);
    const r = rows[0];
    if (!r) throw new ApiError(400, 'invalid_token', 'This link has expired or was already used. Ask for a new one.');
    const problem = passwordProblem(req.body.newPassword, r.email);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    const hashed = await hashSecret(req.body.newPassword);
    await db.tx(async (c) => {
      const used = await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL', [r.id]);
      if (used.rowCount !== 1) throw new ApiError(400, 'invalid_token', 'This link was already used.');
      await c.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL,
                email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`, [r.user_id, hashed]);
      await c.query("UPDATE memberships SET status = 'active', updated_at = now() WHERE user_id = $1 AND status = 'invited'", [r.user_id]);
      await revokeUserSessions(c, r.user_id);
    });
    await platformAudit(req, 'auth.password_reset', { type: 'user', id: r.user_id, label: r.email }, { summary: 'Password set from an emailed link' });
    return { ok: true };
  });

  // ---- OIDC (Google, Microsoft) ------------------------------------------

  const providerParam = { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: ['google', 'microsoft'] } } };
  const redirectUri = (provider) => `${config.publicOrigin}/api/v1/auth/oidc/${provider}/callback`;
  const appUrl = (hash) => `${config.publicOrigin}/#/${hash}`;

  app.get('/api/v1/auth/oidc/:provider/start', {
    config: { auth: 'public', rateLimit: authLimit(config) },
    schema: { tags: ['auth'], summary: 'Redirect to Google or Microsoft sign-in (add ?link=1 while signed in to link the account)', params: providerParam, querystring: { type: 'object', properties: { link: { type: 'string' } } } },
  }, async (req, reply) => {
    const provider = oidcProviders[req.params.provider];
    if (!provider) throw notFound('This sign-in provider is not set up.');
    let linkUserId = null;
    if (req.query.link) {
      const s = req.auth.session;
      if (!s || mfaState(s) !== 'ok') throw new ApiError(401, 'unauthenticated', 'Sign in first to link an account.');
      linkUserId = s.user_id;
    }
    const verifier = pkce.verifier();
    const st = { p: req.params.provider, s: pkce.state(), n: pkce.nonce(), v: verifier, l: linkUserId, exp: Date.now() + 600_000 };
    reply.setCookie(OIDC_COOKIE, app.sealer.seal('oidc-state', JSON.stringify(st)), { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/api/v1/auth/oidc', maxAge: 600 });
    const url = await provider.authorizationUrl({ redirectUri: redirectUri(req.params.provider), state: st.s, nonce: st.n, codeChallenge: await pkce.challenge(verifier) });
    return reply.redirect(url, 302);
  });

  app.get('/api/v1/auth/oidc/:provider/callback', {
    config: { auth: 'public', rateLimit: authLimit(config) },
    schema: { tags: ['auth'], summary: 'OIDC redirect target; signs in and returns to the app', params: providerParam },
  }, async (req, reply) => {
    const fail = (code) => reply.redirect(appUrl(`sign-in?error=${code}`), 302);
    const name = req.params.provider;
    const provider = oidcProviders[name];
    if (!provider) return fail('provider_disabled');
    const raw = req.cookies?.[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: '/api/v1/auth/oidc' });
    const st = raw ? JSON.parse(app.sealer.open('oidc-state', raw) || 'null') : null;
    if (!st || st.p !== name || st.exp < Date.now()) return fail('expired');
    let claims;
    try {
      claims = await provider.callback({ currentUrl: `${config.publicOrigin}${req.url}`, state: st.s, nonce: st.n, codeVerifier: st.v });
    } catch (e) {
      req.log.warn({ err: { message: e.message } }, 'oidc callback failed');
      return fail('provider_error');
    }
    const actorFor = (id) => ({ type: 'user', id, label: claims.email || `${name}:${claims.subject}` });
    const ident = await db.query('SELECT user_id FROM oauth_identities WHERE provider = $1 AND subject = $2', [name, claims.subject]);
    let userId = ident.rows[0]?.user_id || null;

    if (st.l) {
      // Linking from a signed-in session.
      if (userId && userId !== st.l) return fail('already_linked');
      if (!userId) {
        await db.query('INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)', [st.l, name, claims.subject, claims.email]);
        await platformAudit(req, 'auth.oidc_linked', actorFor(st.l), { summary: `${name} account linked` });
      }
      return reply.redirect(appUrl('settings?linked=' + name), 302);
    }

    if (!userId && claims.email && claims.emailVerified) {
      // Google-verified email that matches an existing account: link it.
      const u = await db.query("SELECT id FROM users WHERE email = $1 AND status = 'active'", [claims.email]);
      if (u.rows[0]) {
        userId = u.rows[0].id;
        await db.query('INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)', [userId, name, claims.subject, claims.email]);
        await platformAudit(req, 'auth.oidc_linked', actorFor(userId), { summary: `${name} account linked by verified email` });
      }
    }
    if (!userId) {
      if (!claims.email || !claims.emailVerified || !(await isSignupOpen(db))) return fail('no_account');
      const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [claims.email]);
      if (exists.rows.length) return fail('no_account');
      const created = await db.query(
        'INSERT INTO users (email, email_verified_at, display_name) VALUES ($1, now(), $2) RETURNING id', [claims.email, (claims.name || claims.email).slice(0, 200)]);
      userId = created.rows[0].id;
      await db.query('INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES ($1, $2, $3, $4)', [userId, name, claims.subject, claims.email]);
    }
    const st2 = await db.query('SELECT status FROM users WHERE id = $1', [userId]);
    if (st2.rows[0]?.status !== 'active') return fail('disabled');
    await db.query('UPDATE oauth_identities SET last_login_at = now() WHERE provider = $1 AND subject = $2', [name, claims.subject]);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    const tenantId = await pickTenant(db, userId, null);
    await userAudit(req, tenantId, 'auth.login', actorFor(userId), { summary: `Signed in with ${name}`, meta: { method: `oidc:${name}` } });
    const body = await startSession(req, reply, { userId, tenantId, mode: 'cookie', authMethod: `oidc:${name}` });
    return reply.redirect(appUrl(body.mfa ? `sign-in?mfa=${body.mfa}` : ''), 302);
  });
}
