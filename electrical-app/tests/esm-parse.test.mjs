// The browser loads every file under electrical-app/js as an ES module. A syntax error there
// white-screens the whole app at boot ("Loading Fishtape..." forever). `node --test` only parses
// the modules a test imports, and check-csp does not parse at all, so a syntax error in an
// un-imported module (e.g. a missing paren in modules/sops.js) can pass CI and still break the app.
// This test ES-module-parses every app module so that can never ship again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const files = readdirSync(JS, { recursive: true })
  .map((f) => String(f).split('\\').join('/'))
  .filter((f) => f.endsWith('.js'));

test('every app module parses as an ES module (would white-screen the app otherwise)', () => {
  assert.ok(files.length > 50, `found ${files.length} module files`);
  const tmp = join(mkdtempSync(join(tmpdir(), 'esm-')), 'm.mjs');
  const broken = [];
  for (const rel of files) {
    copyFileSync(join(JS, rel), tmp);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      broken.push(`js/${rel}: ${String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || 'parse error'}`);
    }
  }
  assert.deepEqual(broken, [], `these modules do not parse as ES modules:\n${broken.join('\n')}`);
});
