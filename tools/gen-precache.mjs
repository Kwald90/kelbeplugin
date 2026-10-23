// Generates electrical-app/precache-manifest.json: every asset the PWA needs to run offline, so a
// fresh iPad has every screen (and the PDF engine and setup guides) available after its first sync,
// not just the screens someone happened to open online. sw.js fetches this list on install.
//
//   node tools/gen-precache.mjs            # rewrite the manifest
//   node tools/gen-precache.mjs --check    # exit 1 if the committed manifest is stale (CI)
//
// The manifest is checked in and guarded by electrical-app/tests/precache.test.mjs, so adding a
// screen without regenerating fails the tests.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'electrical-app');
const MANIFEST = join(APP, 'precache-manifest.json');

// Directories and files that must never be precached: the worker itself and the manifest (served
// fresh, not from cache), tests (never shipped to the field), and editor/VCS noise.
const SKIP_DIRS = new Set(['tests']);
const SKIP_FILES = new Set(['sw.js', 'precache-manifest.json', '.DS_Store', 'README.md']);
// Extensions worth caching: code, styles, the page, icons/images, fonts, the webmanifest, and the
// setup guides (Markdown) the integrations screens render offline.
const KEEP = /\.(m?js|css|html|json|webmanifest|svg|png|jpg|jpeg|webp|ico|woff2?|md)$/i;

/** Pure: the sorted list of './'-relative URLs to precache, given the electrical-app root. */
export function buildManifest(root = APP) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split('\\').join('/');
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(rel)) walk(full);
      } else if (KEEP.test(name) && !SKIP_FILES.has(name)) {
        out.push(`./${rel}`);
      }
    }
  };
  walk(root);
  // './' (the app root) resolves to index.html; the fetch handler also falls back to it offline.
  out.push('./');
  return out.sort();
}

const text = (list) => `${JSON.stringify(list, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const list = buildManifest();
  if (process.argv.includes('--check')) {
    const current = readFileSync(MANIFEST, 'utf8');
    if (current !== text(list)) {
      console.error(`precache-manifest.json is stale: run node tools/gen-precache.mjs (${list.length} entries expected)`);
      process.exit(1);
    }
    console.log(`precache-manifest.json is up to date (${list.length} entries).`);
  } else {
    writeFileSync(MANIFEST, text(list));
    console.log(`wrote ${list.length} entries to electrical-app/precache-manifest.json`);
  }
}
