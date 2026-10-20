// HQ and billing test helpers: an app with HQ/billing settings injected (no env, no
// network), and signed-in HQ staff with TOTP set up.
import { randomBytes } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { hashSecret } from '../../src/auth/passwords.js';
import { call, enrolTotp, logCapture, testConfig } from './app.js';
import { fakeStripe } from './fake-stripe.js';

export const WEBHOOK_SECRET = 'whsec_fishtape_test_secret';
export const NOTIFY_EMAIL = 'sales@fishtape.test';

/**
 * @param {object} t test database
 * @param {{ env?: object, hq?: object, billing?: object, signup?: object, stripe?: object }} [o]
 */
export async function startHqApp(t, { env = {}, hq = {}, billing = {}, signup = {}, stripe = fakeStripe() } = {}) {
  const config = testConfig(env);
  config.hq = { notifyEmail: NOTIFY_EMAIL, tlsCheck: false, ...hq };
  config.billing = { stripe, webhookSecret: WEBHOOK_SECRET, graceDays: 7, ...billing };
  config.signup = signup;
  const logs = logCapture();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logs.stream });
  await app.ready();
  return { app, config, logs, stripe };
}

let n = 0;
/** An HQ staff member (hq_admin or hq_staff) with TOTP enrolled and a verified bearer session. */
export async function hqUser(t, app, role = 'hq_admin') {
  n++;
  const email = `${role.replace('_', '-')}${n}-${randomBytes(3).toString('hex')}@fishtape.test`;
  const password = `hq-${randomBytes(12).toString('hex')}`;
  const { rows } = await t.superPool.query(
    'INSERT INTO users (email, display_name, password_hash, platform_role) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, `HQ ${role} ${n}`, await hashSecret(password), role]);
  const r = await call(app, { method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer' } });
  const { totp } = await enrolTotp(app, r.body.token);
  return { userId: rows[0].id, email, password, token: r.body.token, totp };
}
