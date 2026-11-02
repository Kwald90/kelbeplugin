// Platform keys (routes/hq-platform-keys.js + services/platform-secrets.js): Fishtape's own
// SendGrid/Stripe keys, set by an HQ admin. HQ staff look, HQ admins change; the value is stored
// envelope-encrypted and is never returned by the API; a set key overlays the matching env var;
// every change is in the platform audit chain.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, logCapture, ownerTenant, testConfig } from './support/app.js';
import { hqUser, NOTIFY_EMAIL } from './support/hq.js';
import { fakeStripe } from './support/fake-stripe.js';
import { buildApp } from '../src/app.js';
import { loadPlatformSecretsMap, overlayPlatformSecrets } from '../src/services/platform-secrets.js';

let t, app, owner, admin, staff;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('platformkeys');
  const config = testConfig();
  config.hq = { notifyEmail: NOTIFY_EMAIL, tlsCheck: false };
  config.billing = { stripe: fakeStripe(), webhookSecret: 'whsec_fishtape_test_secret', graceDays: 7 };
  config.signup = {};
  app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: logCapture().stream });
  await app.ready();
  owner = await ownerTenant(t, app, 'Alpha Wiring');
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
});
after(async () => { await app?.close(); await t?.close(); });

const hq = (token, url, opts = {}) => call(app, { url, token, ...opts });
const put = (token, name, value) => hq(token, `/api/hq/platform-keys/${name}`, { method: 'PUT', body: { value } });
const del = (token, name) => hq(token, `/api/hq/platform-keys/${name}`, { method: 'DELETE' });
const key = (body, name) => body.keys.find((k) => k.name === name);
const audit = async (action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id IS NULL AND action = $1 ORDER BY seq', [action])).rows;

describe('HQ platform keys', { skip }, () => {
  test('HQ only: anonymous and owners are refused; staff read but cannot change; admins change', async () => {
    assert.equal((await call(app, { url: '/api/hq/platform-keys' })).status, 401);
    assert.equal((await hq(owner.token, '/api/hq/platform-keys')).status, 403);
    const r = await hq(staff.token, '/api/hq/platform-keys');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.keys) && r.body.keys.some((k) => k.name === 'sendgrid.api_key'));
    assert.equal((await put(staff.token, 'sendgrid.api_key', 'SG.staff')).status, 403, 'staff cannot set');
  });

  test('set, replace and remove a secret key; the value is never returned, only a hint', async () => {
    const set = await put(admin.token, 'sendgrid.api_key', 'SG.secret-value-1234');
    assert.equal(set.status, 200);
    const k = key(set.body, 'sendgrid.api_key');
    assert.equal(k.set, true);
    assert.equal(k.hint, '…1234', 'only the last four characters are shown');
    assert.equal(JSON.stringify(set.body).includes('secret-value'), false, 'the plaintext key is never in a response');

    const back = await put(admin.token, 'sendgrid.api_key', 'SG.replaced-5678');
    assert.equal(key(back.body, 'sendgrid.api_key').hint, '…5678');

    const gone = await del(admin.token, 'sendgrid.api_key');
    assert.equal(gone.status, 200);
    assert.equal(key(gone.body, 'sendgrid.api_key').set, false);
  });

  test('a plain setting (From address) is shown in full', async () => {
    const r = await put(admin.token, 'email.from', 'Fishtape <no-reply@fishtapehq.com>');
    const k = key(r.body, 'email.from');
    assert.equal(k.set, true);
    assert.equal(k.plain, true);
    assert.equal(k.hint, 'Fishtape <no-reply@fishtapehq.com>');
    await del(admin.token, 'email.from');
  });

  test('unknown keys are refused; an empty value is rejected', async () => {
    assert.equal((await put(admin.token, 'nope.whatever', 'x')).status, 404);
    assert.equal((await del(admin.token, 'nope.whatever')).status, 404);
    assert.equal((await put(admin.token, 'sendgrid.api_key', '')).status, 400);
  });

  test('a set key overlays the matching environment variable (DB over env)', async () => {
    await put(admin.token, 'stripe.secret_key', 'sk_test_overlay_me');
    const map = await loadPlatformSecretsMap(t.db, app.sealer);
    assert.equal(map['stripe.secret_key'], 'sk_test_overlay_me');
    const env = { STRIPE_SECRET_KEY: 'sk_from_env' };
    await overlayPlatformSecrets(t.db, app.sealer, env);
    assert.equal(env.STRIPE_SECRET_KEY, 'sk_test_overlay_me', 'the HQ value wins over the env value');
    await del(admin.token, 'stripe.secret_key');
  });

  test('every change is in the platform audit chain', async () => {
    await put(admin.token, 'sendgrid.api_key', 'SG.audit-9999');
    const rows = await audit('hq.platform_key_set');
    assert.ok(rows.length >= 1);
    assert.equal(rows.at(-1).record_id, 'sendgrid.api_key');
    assert.equal(JSON.stringify(rows).includes('audit-9999'), false, 'the value is not in the audit record');
    await del(admin.token, 'sendgrid.api_key');
  });
});
