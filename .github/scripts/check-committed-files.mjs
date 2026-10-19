#!/usr/bin/env node
// Fail if git tracks a file that must never be committed: real .env files (anything .env* except
// .env.example), private keys and keystores, age identities, database dumps, encrypted backups,
// or credential files. Also scans tracked text files for private-key blocks and age identities.
// gitleaks (security.yml) covers secret *values* across history; this covers *files* in the tree.
// Run locally: node .github/scripts/check-committed-files.mjs
// Pre-commit use: git diff --cached --name-only | node .github/scripts/check-committed-files.mjs --stdin
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const fromStdin = process.argv.includes('--stdin');
const root = fromStdin ? process.cwd() : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = fromStdin
  ? readFileSync(0, 'utf8').split(/\r?\n/).map((s) => s.trim().replaceAll('\\', '/')).filter(Boolean)
  : execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

const FORBIDDEN = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/i, 'environment file (only .env.example may be committed)'],
  [/(^|\/)[^/]*\.env$/i, 'environment file'],
  [/(^|\/)(id_(rsa|dsa|ecdsa|ed25519))$/, 'SSH private key'],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i, 'key, certificate bundle or keystore'],
  [/(^|\/)(age-identity[^/]*|[^/]*backup[^/]*\.key)$/i, 'age identity'],
  [/\.(dump|dump\.age|sql\.gz|sql\.bz2|sqlite3?|db|bak)$/i, 'database dump, backup or database file'],
  [/(^|\/)(backup\.conf|backup-recipients\.txt|\.htpasswd|\.netrc|\.npmrc|\.pgpass|credentials(\.json)?|secrets?\.(json|ya?ml|txt))$/i, 'credentials or local config'],
  [/(^|\/)terraform\.tfstate(\.backup)?$/i, 'infrastructure state'],
];
const CONTENT = [
  [/-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/, 'private key block'],
  [/AGE-SECRET-KEY-1[0-9A-Z]{58}/, 'age secret key'],
];

let failures = 0;
const fail = (file, msg) => { failures++; console.log(`::error file=${file}::${msg} is tracked in git. Remove it (git rm --cached), rotate anything it contained, and check .gitignore.`); };

for (const f of files) {
  for (const [re, what] of FORBIDDEN) if (re.test(f)) { fail(f, what); break; }
  let size = 0;
  try { size = statSync(`${root}/${f}`).size; } catch { continue; }
  if (size === 0 || size > 2_000_000) continue;
  const text = readFileSync(`${root}/${f}`).toString('latin1');
  if (text.includes('\0')) continue; // binary
  for (const [re, what] of CONTENT) if (re.test(text)) { fail(f, what); break; }
}
console.log(`check-committed-files: ${files.length} tracked files checked, ${failures} problem(s).`);
process.exit(failures ? 1 : 0);
