// Fishtape's own email: the worker drains email_outbox through Resend (mocked here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { drainPlatformEmail, MAX_ATTEMPTS } from '../src/services/platform-email.js';
import { ProviderError } from '../src/integrations/http.js';

let t;
const cfg = { apiKey: 're_test_key', from: 'Fishtape <no-reply@example.com>' };
const queue = (to, subject = 'Reset your password') => t.superPool.query(
  "INSERT INTO email_outbox (to_address, subject, text_body) VALUES ($1, $2, 'body') RETURNING id", [to, subject]).then((r) => r.rows[0].id);
const row = async (id) => (await t.superPool.query('SELECT status, attempts, last_error, sent_at FROM email_outbox WHERE id = $1', [id])).rows[0];

before(async () => { if (!skip) t = await createTestDatabase('platform_email'); });
after(async () => { await t?.close(); });

test('without RESEND_API_KEY / EMAIL_FROM nothing is sent and the queue waits', { skip }, async () => {
  const id = await queue('a@example.com');
  let calls = 0;
  const r = await drainPlatformEmail(t.db, { cfg: { apiKey: '', from: '' }, send: async () => { calls++; } });
  assert.deepEqual(r, { skipped: 'not_configured' });
  assert.equal(calls, 0);
  assert.equal((await row(id)).status, 'queued');
  await t.superPool.query('DELETE FROM email_outbox');
});

test('queued messages are sent once, with the row id as the idempotency key', { skip }, async () => {
  const ids = [await queue('a@example.com'), await queue('b@example.com')];
  const sent = [];
  const r = await drainPlatformEmail(t.db, { cfg, send: async (m) => { sent.push(m); return { id: 'x' }; } });
  assert.equal(r.sent, 2);
  assert.deepEqual(sent.map((m) => m.idempotencyKey).sort(), ids.map((id) => `platform-email:${id}`).sort());
  assert.equal(sent[0].apiKey, cfg.apiKey);
  for (const id of ids) assert.equal((await row(id)).status, 'sent');
  assert.equal((await drainPlatformEmail(t.db, { cfg, send: async () => assert.fail('sent twice') })).sent, 0);
  await t.superPool.query('DELETE FROM email_outbox');
});

test('retryable errors stay queued until MAX_ATTEMPTS; permanent errors fail at once', { skip }, async () => {
  const retry = await queue('r@example.com');
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await drainPlatformEmail(t.db, { cfg, send: async () => { throw new ProviderError('resend', 'Resend is rate limiting.', { retry: true }); } });
    const r = await row(retry);
    assert.equal(r.status, 'queued');
    assert.equal(r.attempts, i);
  }
  await drainPlatformEmail(t.db, { cfg, send: async () => { throw new ProviderError('resend', 'Resend is rate limiting.', { retry: true }); } });
  assert.equal((await row(retry)).status, 'failed');

  const bad = await queue('x@example.com');
  await drainPlatformEmail(t.db, { cfg, send: async () => { throw new ProviderError('resend', 'Resend refused the key.', { kind: 'auth' }); } });
  const b = await row(bad);
  assert.equal(b.status, 'failed');
  assert.equal(b.attempts, 1);
  assert.ok(!b.last_error.includes('x@example.com'), 'the address is not stored in the error');
  await t.superPool.query('DELETE FROM email_outbox');
});
