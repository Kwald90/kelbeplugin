// The generic secret routes refuse the QuickBooks token names (docs/integrations/quickbooks.md 2.3,
// 3.7, 10.2): an owner's PUT and DELETE of qbo.refresh_token, qbo.access_token and qbo.realm_id get
// 400 and change nothing, there is no route that reads one, and listings never show them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp } from './support/app.js';
import { getSecret, setSecret } from '../src/services/secrets.js';

const NAMES = ['qbo.refresh_token', 'qbo.access_token', 'qbo.realm_id'];
const VALUES = { 'qbo.refresh_token': 'refresh-value-0001', 'qbo.access_token': 'access-value-0002', 'qbo.realm_id': '4620816365999999' };
let t, app, A;

before(async () => {
  if (skip) return;
  t = await createTestDatabase('qbosecrets');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Secret Electric');
  await t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
    for (const n of NAMES) await setSecret(tx, app.sealer, n, VALUES[n], 'test', { internal: true });
  });
});
after(async () => { await app?.close(); await t?.close(); });

const stored = () => t.db.withTenant({ tenantId: A.tenantId }, async (tx) => {
  const out = {};
  for (const n of NAMES) out[n] = await getSecret(tx, app.sealer, n, { internal: true });
  return out;
});

test('PUT and DELETE /api/v1/secrets/<qbo name> as an owner: 400, nothing stored or deleted', { skip }, async () => {
  for (const n of NAMES) {
    const put = await call(app, { method: 'PUT', url: `/api/v1/secrets/${n}`, token: A.token, body: { value: 'attacker-chosen' } });
    assert.equal(put.status, 400, n);
    assert.equal(put.body.error.message, 'Unknown secret name.');
    const del = await call(app, { method: 'DELETE', url: `/api/v1/secrets/${n}`, token: A.token });
    assert.equal(del.status, 400, n);
  }
  assert.deepEqual(await stored(), VALUES);
});

test('no route reads a secret by name, and the listing never shows QuickBooks names or values', { skip }, async () => {
  for (const n of NAMES) {
    const get = await call(app, { method: 'GET', url: `/api/v1/secrets/${n}`, token: A.token });
    assert.ok(get.status === 400 || get.status === 404, `${n}: ${get.status}`);
    for (const v of Object.values(VALUES)) assert.ok(!get.raw.body.includes(v));
  }
  const list = await call(app, { method: 'GET', url: '/api/v1/secrets', token: A.token });
  assert.equal(list.status, 200);
  assert.ok(!list.body.data.some((s) => s.name.startsWith('qbo.')));
  const integrations = await call(app, { method: 'GET', url: '/api/v1/integrations', token: A.token });
  for (const v of Object.values(VALUES)) {
    assert.ok(!list.raw.body.includes(v));
    assert.ok(!integrations.raw.body.includes(v));
  }
  assert.ok(!integrations.raw.body.includes('qbo.'));
});
