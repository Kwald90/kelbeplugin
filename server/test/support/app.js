// Builds the API against a test database and drives it through fastify.inject().
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { generate } from 'otplib';
import { readConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { createTenantWithOwner } from '../../src/services/tenants.js';
import { hashSecret } from '../../src/auth/passwords.js';

export const ORIGIN = 'https://app.fishtape.test';

export function testConfig(env = {}) {
  return readConfig({
    APP_ENV: 'test',
    SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: ORIGIN,
    LOG_LEVEL: 'info',
    RATE_LIMIT: 'off',
    ...env,
  });
}

/** Capture structured log lines in memory. */
export function logCapture() {
  const lines = [];
  const stream = new Writable({ write(chunk, enc, cb) { lines.push(chunk.toString()); cb(); } });
  return { stream, lines, text: () => lines.join('') };
}

export async function startApp(t, { env = {}, oidcProviders = {}, ...rest } = {}) {
  const config = testConfig(env);
  const logs = logCapture();
  const app = await buildApp({ config, db: t.db, oidcProviders, logStream: logs.stream, ...rest });
  await app.ready();
  return { app, config, logs };
}

/**
 * Inject a request. `token` → Bearer; `cookie` → ft_session cookie (adds X-Fishtape: 1
 * on writes unless csrf: false).
 */
export async function call(app, { method = 'GET', url, token, cookie, body, headers = {}, csrf = true }) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = `ft_session=${cookie}`;
  if (!token && csrf && method !== 'GET' && h['x-fishtape'] === undefined) h['x-fishtape'] = '1';
  const res = await app.inject({ method, url, headers: h, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.statusCode, body: json, headers: res.headers, cookies: res.cookies, raw: res };
}

/** TOTP codes for a secret, each on a later 30 s step so replay protection never trips. */
export function totpFor(secret) {
  let step = Math.floor(Date.now() / 30000) - 1;
  return async () => {
    step = Math.max(step + 1, Math.floor(Date.now() / 30000) - 1);
    return generate({ secret, epoch: step * 30 });
  };
}

/** Sign in with email/password (bearer mode), passing MFA when needed. */
export async function login(app, email, password, { totp, tenantId } = {}) {
  const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer', ...(tenantId ? { tenantId } : {}) } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  const token = r.body.token;
  if (r.body.mfa === 'verify') {
    const v = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/verify', token, body: { code: await totp() } });
    if (v.status !== 200) throw new Error(`mfa verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  }
  return { token, body: r.body };
}

/** Enrol TOTP on a session; returns a code generator and the recovery codes. */
export async function enrolTotp(app, token) {
  const e = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/totp/enrol', token });
  if (e.status !== 200) throw new Error(`enrol failed: ${e.status} ${JSON.stringify(e.body)}`);
  const totp = totpFor(e.body.secret);
  const c = await call(app, { method: 'POST', url: '/api/v1/auth/mfa/totp/confirm', token, body: { code: await totp() } });
  if (c.status !== 200) throw new Error(`confirm failed: ${c.status} ${JSON.stringify(c.body)}`);
  return { totp, recoveryCodes: c.body.recoveryCodes, secret: e.body.secret };
}

let n = 0;
/**
 * A tenant with an owner who has MFA set up and a live bearer session.
 * @returns {Promise<{ tenantId: string, userId: string, email: string, password: string, token: string, totp: Function }>}
 */
export async function ownerTenant(t, app, name) {
  n++;
  const email = `owner${n}-${randomBytes(3).toString('hex')}@example.test`;
  const password = `pw-${randomBytes(12).toString('hex')}`;
  const { tenant, userId } = await createTenantWithOwner(t.db, { name, owner: { email, password, displayName: `${name} Owner` } });
  const first = await login(app, email, password);
  const { totp } = await enrolTotp(app, first.token);
  return { tenantId: tenant.id, userId, email, password, token: first.token, totp };
}

/**
 * Add a member straight in the database (set-up only) and sign them in.
 * @returns {Promise<{ userId: string, membershipId: string, email: string, password: string, token: string|null }>}
 */
export async function addMember(t, app, tenantId, { role, employeeId = null, signIn = true }) {
  n++;
  const email = `${role}${n}-${randomBytes(3).toString('hex')}@example.test`;
  const password = `pw-${randomBytes(12).toString('hex')}`;
  const u = await t.superPool.query(
    'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, `${role} ${n}`, await hashSecret(password)]);
  const m = await t.superPool.query(
    'INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4) RETURNING id', [tenantId, u.rows[0].id, role, employeeId]);
  let token = null;
  if (signIn) {
    if (['owner', 'admin'].includes(role)) throw new Error('use ownerTenant-style MFA for owner/admin');
    token = (await login(app, email, password, { tenantId })).token;
  }
  return { userId: u.rows[0].id, membershipId: m.rows[0].id, email, password, token };
}

/** Create an API key as an owner. */
export async function apiKey(app, ownerToken, scopes, name = 'test key') {
  const r = await call(app, { method: 'POST', url: '/api/v1/api-keys', token: ownerToken, body: { name, scopes } });
  if (r.status !== 201) throw new Error(`api key failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.key;
}
