// The server image gets electrical-app/js files only through the .dockerignore allow-list
// (server/Dockerfile copies electrical-app/js/ from a context that holds nothing else). Every
// PWA file the server imports, directly or through another import, must be on that list, or the
// image crashes at start with ERR_MODULE_NOT_FOUND while every test here passes (v0.6.0 rollback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rel = (root, f) => relative(root, f).split(sep).join('/');

function importClosure(root = ROOT) {
  const seen = new Set();
  const files = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') assert.fail(`missing relative dependency: ${rel(root, file)}`);
      if (error.code !== 'EISDIR') throw error;
      for (const child of readdirSync(file, { recursive: true })) {
        if (/\.(m?js|json)$/.test(String(child))) visit(join(file, String(child)));
      }
      return;
    }
    files.add(file);
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]);
      if (/\.(m?js|json)$/.test(target)) visit(target);
    }
    // Schemas are loaded from a URL rather than imported as modules. Keep this check when
    // replacing the old workflow grep, which happened to see those URLs too.
    for (const m of src.matchAll(/\bnew\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
      const target = resolve(dirname(file), m[1]);
      if (rel(root, target).startsWith('electrical-app/')) visit(target);
    }
  };
  for (const f of readdirSync(join(root, 'server/src'), { recursive: true })) {
    if (String(f).endsWith('.js')) visit(join(root, 'server/src', String(f)));
  }
  return [...files].map((f) => rel(root, f)).filter((f) => f.startsWith('electrical-app/')).sort();
}

function allowList(root = ROOT) {
  return readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/)
    .filter((l) => l.startsWith('!')).map((l) => l.slice(1).trim());
}

function missingFromContext(root = ROOT) {
  const allowed = allowList(root);
  const inContext = (f) => allowed.some((a) => (a.endsWith('/') ? f.startsWith(a) : f === a));
  return importClosure(root).filter((f) => !inContext(f));
}

test('every PWA file the server imports or loads by URL is in the Docker build context', () => {
  const needed = importClosure();
  assert.ok(needed.length > 5, `found ${needed.length} imported PWA files`);
  assert.ok(needed.includes('electrical-app/js/schema/jobs.json'), 'shared schemas loaded by URL are included');
  const missing = missingFromContext();
  assert.deepEqual(missing, [], `add these to .dockerignore as !<path>: ${missing.join(', ')}`);
});

test('the Dockerfile copies electrical-app/js from the context', () => {
  assert.match(readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8'), /^COPY electrical-app\/js\/ \/app\/electrical-app\/js\/$/m);
});

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'fishtape-docker-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

test('a missing transitive dependency fails even when the direct import is allowed', (t) => {
  const root = fixture(t, {
    '.dockerignore': '*\n!electrical-app/js/lib/direct.js\n',
    'server/src/index.js': "import '../../electrical-app/js/lib/direct.js';",
    'electrical-app/js/lib/direct.js': "export { value } from './transitive.js';",
    'electrical-app/js/lib/transitive.js': "export const value = 1; import('./dynamic.js');",
    'electrical-app/js/lib/dynamic.js': "import './direct.js';", // cycles terminate
  });
  assert.deepEqual(missingFromContext(root), ['electrical-app/js/lib/dynamic.js', 'electrical-app/js/lib/transitive.js']);
  writeFileSync(join(root, '.dockerignore'), '*\n!electrical-app/js/lib/\n');
  assert.deepEqual(missingFromContext(root), []);
});

test('schema directories loaded by URL need their own allow-list entry', (t) => {
  const root = fixture(t, {
    '.dockerignore': '*\n!electrical-app/js/lib/\n',
    'server/src/index.js': "const schema = new URL('../../electrical-app/js/schema/', import.meta.url);",
    'electrical-app/js/schema/jobs.json': '{}',
  });
  assert.deepEqual(missingFromContext(root), ['electrical-app/js/schema/jobs.json']);
  writeFileSync(join(root, '.dockerignore'), '*\n!electrical-app/js/schema/\n');
  assert.deepEqual(missingFromContext(root), []);
});

test('a relative import missing from the source tree is not silently skipped', (t) => {
  const root = fixture(t, {
    'server/src/index.js': "import '../../electrical-app/js/lib/missing.js';",
  });
  assert.throws(() => importClosure(root), /missing relative dependency: electrical-app\/js\/lib\/missing.js/);
});

test('a prose reference to importers.js is not a runtime dependency', (t) => {
  const root = fixture(t, {
    '.dockerignore': '*\n',
    'server/src/index.js': '// The normalizers are copies of electrical-app/js/lib/importers.js (a parity test keeps them equal).',
  });
  assert.deepEqual(missingFromContext(root), []);
});
