#!/usr/bin/env node
// Exact historical fixture ignores must not hide new credentials, even in the same test file.
// Run after installing a verified gitleaks binary: node .github/scripts/check-gitleaks-fixtures.mjs
// GITLEAKS_PATH overrides PATH. All positive samples are generated in a disposable local repo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ignore = readFileSync(join(root, '.gitleaksignore'), 'utf8');
const entries = ignore.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
assert.ok(entries.length, 'Historical fixture fingerprints must be explicit');
assert.equal(new Set(entries).size, entries.length, 'Duplicate fixture fingerprints');
for (const entry of entries) {
  assert.match(entry, /^[a-f0-9]{40}:(?:server\/test\/[a-z0-9-]+\.test\.js|electrical-app\/tests\/[a-z0-9-]+\.test\.mjs):(?:generic-api-key|stripe-access-token):[1-9][0-9]*$/, 'Only exact reviewed test fingerprints are permitted');
}
const scratch = mkdtempSync(join(tmpdir(), 'fishtape-gitleaks-regression-'));
const run = (cmd, args) => spawnSync(cmd, args, { cwd: scratch, encoding: 'utf8', windowsHide: true, timeout: 60000 });
const git = (...args) => {
  const result = run('git', args);
  // Never include subprocess output: it may contain generated test credentials.
  assert.equal(result.status, 0, 'Temporary git fixture command failed: ' + args[0]);
};
const put = (path, body) => { const full = join(scratch, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body); };
// Start with a letter so random leading punctuation cannot miss a credential boundary.
const secret = () => 'R' + randomBytes(32).toString('base64url');
try {
  git('init', '--quiet');
  writeFileSync(join(scratch, '.gitleaksignore'), ignore);
  // Same path as an ignored finding, different commit and different literal.
  put('server/test/qbo-r1.test.js', `const owner = { password: '${secret()}' };\n`);
  // Same Stripe test path with a new synthetic credential; no broad fixture-path suppression.
  put('server/test/integrations-unit.test.js', `const apiKey = '${['sk', 'test', randomBytes(16).toString('hex')].join('_')}';\n`);
  // A production path must remain protected too.
  put('server/src/config-fixture.js', `const apiKey = '${['ft', 'test', secret()].join('_')}';\n`);
  git('add', '.');
  git('-c', 'user.name=Scanner regression', '-c', 'user.email=scanner@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic scanner regression');
  const report = join(scratch, 'redacted-report.json');
  const result = run(process.env.GITLEAKS_PATH || 'gitleaks', ['git', '--config', join(root, '.gitleaks.toml'), '--redact', '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report, '.']);
  assert.equal(result.status, 1, 'Synthetic secrets must fail scanning; install gitleaks or set GITLEAKS_PATH if unavailable');
  const findings = JSON.parse(readFileSync(report, 'utf8'));
  for (const [file, rule] of [
    ['server/test/qbo-r1.test.js', 'generic-api-key'],
    ['server/test/integrations-unit.test.js', 'stripe-access-token'],
    ['server/src/config-fixture.js', 'fishtape-api-key'],
  ]) {
    assert.ok(findings.some(f => f.File.replaceAll('\\', '/') === file && f.RuleID === rule), `Expected detection: ${file} (${rule})`);
  }
  assert.ok(findings.every(f => f.Secret === 'REDACTED'), 'Regression report must be redacted');
  console.log(`gitleaks fixture regression: ${entries.length} exact historical fingerprints; all 3 new synthetic credentials detected.`);
} finally {
  const target = resolve(scratch), parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('fishtape-gitleaks-regression-')) throw new Error('Refusing to remove an unexpected temporary path');
  rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
