// Tenant secrets: sealing, tenant/name binding and what listSecrets reveals.
// Uses an in-memory stand-in for TenantTx; RLS on tenant_secrets is covered by isolation.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSealer } from '../src/lib/crypto.js';
import { setSecret, getSecret, deleteSecret, listSecrets, hintFor, isSecretName } from '../src/services/secrets.js';

const sealer = createSealer(randomBytes(32).toString('base64'));
const table = new Map(); // `${tenant}|${name}` -> { value_enc, updated_at }

function fakeTx(tenantId) {
  return {
    tenantId,
    async query(sql, params) {
      if (sql.startsWith('INSERT')) { table.set(`${params[0]}|${params[1]}`, { value_enc: params[2], updated_at: new Date() }); return { rows: [], rowCount: 1 }; }
      if (sql.startsWith('DELETE')) { const k = `${params[0]}|${params[1]}`; const had = table.delete(k); return { rows: [], rowCount: had ? 1 : 0 }; }
      if (sql.includes('WHERE tenant_id = $1 AND name = $2')) { const r = table.get(`${params[0]}|${params[1]}`); return { rows: r ? [r] : [] }; }
      const rows = [...table].filter(([k]) => k.startsWith(params[0] + '|')).map(([k, r]) => ({ name: k.split('|')[1], ...r }));
      return { rows };
    },
  };
}

test('a secret round-trips for its own company', async () => {
  const a = fakeTx(randomUUID());
  await setSecret(a, sealer, 'stripe.secret_key', 'sk_test_1234567890abcd');
  assert.equal(await getSecret(a, sealer, 'stripe.secret_key'), 'sk_test_1234567890abcd');
  assert.equal(await getSecret(a, sealer, 'resend.api_key'), null);
});

test('a sealed value copied to another company or name does not open', async () => {
  const a = fakeTx(randomUUID());
  const b = fakeTx(randomUUID());
  await setSecret(a, sealer, 'twilio.auth_token', 'token-of-company-a');
  const sealed = table.get(`${a.tenantId}|twilio.auth_token`);
  table.set(`${b.tenantId}|twilio.auth_token`, sealed);
  assert.equal(await getSecret(b, sealer, 'twilio.auth_token'), null);
  table.set(`${a.tenantId}|resend.api_key`, sealed);
  assert.equal(await getSecret(a, sealer, 'resend.api_key'), null);
});

test('listSecrets shows hints, never values', async () => {
  const t = fakeTx(randomUUID());
  await setSecret(t, sealer, 'anthropic.api_key', 'sk-ant-api03-supersecretvalue-WXYZ');
  await setSecret(t, sealer, 'resend.from', 'office@example.com');
  const list = await listSecrets(t, sealer);
  const json = JSON.stringify(list);
  assert.ok(!json.includes('supersecretvalue'));
  assert.equal(list.find((s) => s.name === 'anthropic.api_key').hint, '…WXYZ');
  assert.equal(list.find((s) => s.name === 'resend.from').hint, 'office@example.com');
});

test('unknown names and empty values are refused; delete works', async () => {
  const t = fakeTx(randomUUID());
  await assert.rejects(setSecret(t, sealer, 'aws.root_key', 'x'));
  await assert.rejects(setSecret(t, sealer, 'stripe.secret_key', '   '));
  await setSecret(t, sealer, 'stripe.secret_key', 'sk_test_abc');
  assert.equal(await deleteSecret(t, 'stripe.secret_key'), true);
  assert.equal(await getSecret(t, sealer, 'stripe.secret_key'), null);
  assert.equal(isSecretName('stripe.secret_key'), true);
  assert.equal(hintFor('stripe.secret_key', 'short'), '…');
});
