// Process role (ACC-06). FISHTAPE_API_MODE=hq must run an HQ-only process: the tenant/app data
// routes are not registered at all, so hq-api answers 404 for them from the app itself — defence in
// depth behind the nginx 404 routing. The default ('full') registers everything, unchanged.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { startApp, call } from './support/app.js';

let t, full, hq;

// Tenant/app routes, each authed, from three different route modules (me, records, sync). With no
// token a registered route answers 401 (auth); an unregistered one answers 404 (not_found). So 404
// here means "not mounted", not "forbidden".
const TENANT_ROUTES = [
  { method: 'GET', url: '/api/v1/me' },
  { method: 'GET', url: '/api/v1/clients' },
  { method: 'POST', url: '/api/v1/sync/push', body: { mutations: [] } },
];

before(async () => {
  if (skip) return;
  t = await createTestDatabase('api-mode');
  ({ app: full } = await startApp(t)); // default: FISHTAPE_API_MODE unset = 'full'
  ({ app: hq } = await startApp(t, { env: { FISHTAPE_API_MODE: 'hq' } }));
});
after(async () => { await full?.close(); await hq?.close(); await t?.close(); });

describe('HQ-only API mode (ACC-06)', { skip }, () => {
  test('full mode registers the tenant routes (auth required, never 404)', async () => {
    for (const r of TENANT_ROUTES) {
      const res = await call(full, r);
      assert.notEqual(res.status, 404, `${r.method} ${r.url} should be registered in full mode (got ${res.status})`);
      assert.equal(res.status, 401, `${r.method} ${r.url} should require auth in full mode (got ${res.status})`);
    }
  });

  test('hq mode does not register the tenant routes (404 not_found)', async () => {
    for (const r of TENANT_ROUTES) {
      const res = await call(hq, r);
      assert.equal(res.status, 404, `${r.method} ${r.url} should be absent in hq mode (got ${res.status})`);
      assert.equal(res.body?.error?.code, 'not_found', `${r.url} should 404 with not_found`);
    }
  });

  test('hq mode still serves health, sign-in and the HQ surface', async () => {
    const health = await call(hq, { url: '/api/healthz' });
    assert.equal(health.status, 200, 'public health must work in hq mode');

    // Sign-in is shared (HQ staff sign in here too): present, so not 404.
    const login = await call(hq, { method: 'POST', url: '/api/v1/auth/login', body: { email: 'nobody@example.test', password: 'wrong' } });
    assert.notEqual(login.status, 404, 'auth/login must be registered in hq mode');

    // An HQ data route (auth: hq) is registered, so unauthenticated it is 401, not 404.
    const hqRoute = await call(hq, { url: '/api/hq/tenants' });
    assert.notEqual(hqRoute.status, 404, '/api/hq/tenants must be registered in hq mode');
    assert.equal(hqRoute.status, 401, `/api/hq/tenants should require hq auth (got ${hqRoute.status})`);
  });

  test('full mode also serves the HQ surface (single-process default unchanged)', async () => {
    const hqRoute = await call(full, { url: '/api/hq/tenants' });
    assert.notEqual(hqRoute.status, 404, '/api/hq/tenants should be registered in full mode');
  });

  test('an invalid FISHTAPE_API_MODE is rejected at config time', async () => {
    await assert.rejects(startApp(t, { env: { FISHTAPE_API_MODE: 'bogus' } }), /FISHTAPE_API_MODE/);
  });
});
