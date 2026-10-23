// The offline precache manifest must list every shippable asset and stay in step with the files on
// disk, so a fresh iPad has every screen offline after its first sync. If this fails, run
// node tools/gen-precache.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../../tools/gen-precache.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const committed = JSON.parse(readFileSync(join(APP, 'precache-manifest.json'), 'utf8'));
const expected = buildManifest(APP);

test('precache-manifest.json is up to date with the files on disk', () => {
  assert.deepEqual(committed, expected, 'run node tools/gen-precache.mjs');
});

test('the manifest covers every screen, both CSS and JS modules, the guides and the PDF engine', () => {
  const has = (p) => committed.includes(p);
  assert.ok(has('./') && has('./index.html') && has('./manifest.webmanifest'), 'app shell');
  assert.ok(has('./js/app.js') && has('./js/modules/index.js'), 'app entry and module registry');
  // a representative screen, its stylesheet, a lazy-imported helper, a guide and the PDF viewer
  for (const p of ['./js/modules/estimates.js', './css/quickbooks.css', './js/lib/shift-tracker.js',
    './guides/quickbooks.md', './vendor/pdfjs-4.10.38/pdf.min.mjs']) {
    assert.ok(has(p), `missing ${p}`);
  }
  // never precache the worker itself, the manifest, or tests
  assert.ok(!committed.some((p) => p === './sw.js' || p === './precache-manifest.json' || p.startsWith('./tests/')), 'excludes sw/manifest/tests');
});
