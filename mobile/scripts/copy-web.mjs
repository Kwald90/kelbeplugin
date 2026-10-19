// Copy the PWA (../electrical-app) into www/, the folder Capacitor bundles into the iOS app.
// Run by `npm run sync` before `cap sync ios`.
//
// Left out:
//  - tests/ (Node tests, not part of the app) and README.md
//  - sw.js: WKWebView does not run service workers for capacitor:// pages, and the app bundle is
//    already offline. app.js registers ./sw.js inside a .catch(), so a missing worker is harmless.
//  - dotfiles (.DS_Store, editor folders)
// The copy stops if it meets anything that looks like a secret (.env, private keys): nothing like
// that may ship inside the app bundle (data leakage rule, docs/BUILD-PLAN.md).
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'electrical-app');
const out = join(here, '..', 'www');

const SKIP_TOP = new Set(['tests', 'sw.js', 'README.md']);
const SECRET = /(^|[\\/])(\.env(\..*)?|.*\.(pem|p8|p12|key|mobileprovision|cer))$|secret/i;

if (!existsSync(join(src, 'index.html'))) {
  console.error(`copy-web: no index.html in ${src}`);
  process.exit(1);
}

const skipped = [];
rmSync(out, { recursive: true, force: true });
cpSync(src, out, {
  recursive: true,
  filter: (p) => {
    const rel = relative(src, p);
    if (!rel) return true;
    const parts = rel.split(sep);
    if (SKIP_TOP.has(parts[0]) || parts.some((s) => s.startsWith('.'))) { skipped.push(rel); return false; }
    if (SECRET.test(rel)) throw new Error(`copy-web: refusing to bundle ${rel}: it looks like a secret`);
    return true;
  },
});

let files = 0, bytes = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p); else { files++; bytes += s.size; }
  }
})(out);
console.log(`copy-web: ${files} files (${(bytes / 1024).toFixed(0)} KB) -> ${relative(process.cwd(), out) || out}; left out: ${skipped.join(', ') || 'nothing'}`);
