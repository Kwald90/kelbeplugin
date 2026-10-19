// Copy the PWA (../electrical-app) into www/, the folder Capacitor bundles into the iOS app, and
// write www/config.js with the API origin for this build (web-config.mjs: FISHTAPE_ENV,
// FISHTAPE_API_ORIGIN). Run by `npm run sync` before `cap sync ios`.
//
// Left out:
//  - tests/ (Node tests, not part of the app) and README.md
//  - sw.js: WKWebView does not run service workers for capacitor:// pages, and the app bundle is
//    already offline. app.js registers ./sw.js inside a .catch(), so a missing worker is harmless.
//  - dotfiles (.DS_Store, editor folders)
// The copy stops if it meets anything that looks like a secret (.env, private keys): nothing like
// that may ship inside the app bundle (data leakage rule, docs/BUILD-PLAN.md).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, configScript, withConfigScript } from './web-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'electrical-app');
const out = join(here, '..', 'www');

const SKIP_TOP = new Set(['tests', 'sw.js', 'README.md']);
const SECRET = /(^|[\\/])(\.env(\..*)?|.*\.(pem|p8|p12|key|mobileprovision|cer))$|secret/i;

function main() {
  if (!existsSync(join(src, 'index.html'))) throw new Error(`no index.html in ${src}`);
  if (existsSync(join(src, 'config.js'))) throw new Error('electrical-app/config.js exists; the iOS build writes its own');
  const config = buildConfig();

  const skipped = [];
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (SKIP_TOP.has(parts[0]) || parts.some((s) => s.startsWith('.'))) { skipped.push(rel); return false; }
      if (SECRET.test(rel)) throw new Error(`refusing to bundle ${rel}: it looks like a secret`);
      return true;
    },
  });
  writeFileSync(join(out, 'config.js'), configScript(config));
  writeFileSync(join(out, 'index.html'), withConfigScript(readFileSync(join(out, 'index.html'), 'utf8')));

  let files = 0, bytes = 0;
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p); else { files++; bytes += s.size; }
    }
  })(out);
  console.log(`copy-web: ${files} files (${(bytes / 1024).toFixed(0)} KB) -> ${relative(process.cwd(), out) || out}; ` +
    `API ${config.apiOrigin} (${config.env}); left out: ${skipped.join(', ') || 'nothing'}`);
}

try { main(); } catch (e) { console.error(`copy-web: ${e.message}`); process.exit(1); }
