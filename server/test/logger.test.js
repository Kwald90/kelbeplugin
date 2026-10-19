// Secret-looking query values never reach the logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl } from '../src/logger.js';

test('redactUrl hides tokens, codes and webhook verify tokens', () => {
  assert.equal(redactUrl('/api/v1/webhooks/facebook/t1?hub.mode=subscribe&hub.verify_token=abc123&hub.challenge=42'),
    '/api/v1/webhooks/facebook/t1?hub.mode=subscribe&hub.verify_token=[REDACTED]&hub.challenge=42');
  assert.equal(redactUrl('/cb?code=xyz&state=s1'), '/cb?code=[REDACTED]&state=[REDACTED]');
  assert.equal(redactUrl('/x?signature=deadbeef&page=2'), '/x?signature=[REDACTED]&page=2');
  assert.equal(redactUrl('/api/v1/jobs?limit=50'), '/api/v1/jobs?limit=50');
});
