// The server image gets electrical-app/js files only through the .dockerignore allow-list
// (server/Dockerfile copies electrical-app/js/ from a context that holds nothing else). Every
// PWA file the server imports, directly or through another import, must be on that list, or the
// image crashes at start with ERR_MODULE_NOT_FOUND while every test here passes (v0.6.0 rollback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rel = (f) => relative(ROOT, f).split(sep).join('/');

function importClosure() {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]);
      if (/\.(m?js|json)$/.test(target)) visit(target);
    }
  };
  for (const f of readdirSync(join(ROOT, 'server/src'), { recursive: true })) {
    if (String(f).endsWith('.js')) visit(join(ROOT, 'server/src', String(f)));
  }
  return [...seen].map(rel).filter((f) => f.startsWith('electrical-app/'));
}

function allowList() {
  return readFileSync(join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/)
    .filter((l) => l.startsWith('!')).map((l) => l.slice(1).trim());
}

test('every PWA file the server imports is in the Docker build context', () => {
  const allowed = allowList();
  const inContext = (f) => allowed.some((a) => (a.endsWith('/') ? f.startsWith(a) : f === a));
  const needed = importClosure();
  assert.ok(needed.length > 5, `found ${needed.length} imported PWA files`);
  const missing = needed.filter((f) => !inContext(f));
  assert.deepEqual(missing, [], `add these to .dockerignore as !<path>: ${missing.join(', ')}`);
});

test('the Dockerfile copies electrical-app/js from the context', () => {
  assert.match(readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8'), /^COPY electrical-app\/js\/ \/app\/electrical-app\/js\/$/m);
});
