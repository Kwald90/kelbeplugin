// `npm run lint`: syntax-check every JS file (node --check) and make sure the committed
// collections migration still matches its generator. No third-party linter needed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUT, generate } from './gen-collections-sql.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

let failed = 0;
const files = ['src', 'scripts', 'test'].flatMap((d) => walk(join(ROOT, d)));
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; process.stderr.write(r.stderr); }
}
const norm = (s) => s.replace(/\r\n/g, '\n');
if (norm(readFileSync(OUT, 'utf8')) !== norm(generate())) {
  failed++;
  console.error('migrations/0003_collections.sql does not match scripts/gen-collections-sql.js output');
}
console.log(`${files.length} files checked, ${failed} problem(s)`);
process.exit(failed ? 1 : 0);
