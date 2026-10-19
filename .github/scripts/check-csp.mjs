#!/usr/bin/env node
// CSP guard (run by CI, or locally: node .github/scripts/check-csp.mjs).
//
// 1. Staging and production send the same Content-Security-Policy and Permissions-Policy.
// 2. The CSP keeps its baseline: no 'unsafe-inline'/'unsafe-eval' for scripts, no wildcards,
//    object-src 'none', base-uri, frame-ancestors, default-src 'self'.
// 3. Every inline thing in the app's HTML is allowed by a hash: <script> blocks, <style> blocks,
//    style="..." attributes. Inline event handlers and javascript: URLs are refused outright.
// 4. App JavaScript doesn't use what the CSP blocks: eval / new Function / string timers,
//    setAttribute('style', ...), string `style:` props for h() (ui.js turns those into a style
//    attribute), and HTML strings with style=/on*= handed to innerHTML.
//    Add `csp-ok` in a comment on the line to accept a reviewed exception.
// 5. Lists external origins referenced from app JS and whether the CSP allows them.
//
// When index.html's inline boot style changes, update the sha256 in both security-headers files.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const HEADER_FILES = ['deploy/staging/security-headers.conf', 'deploy/production/nginx/security-headers.conf'];
const APP_DIRS = ['electrical-app', 'hq'];
let errors = 0;
let warnings = 0;

const rel = (p) => relative(root, p).replaceAll('\\', '/');
const error = (file, line, msg) => { errors++; console.log(`::error file=${file}${line ? `,line=${line}` : ''}::${msg}`); };
const warn = (file, line, msg) => { warnings++; console.log(`::warning file=${file}${line ? `,line=${line}` : ''}::${msg}`); };
const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// ---- 1. header files agree ----
function header(file, name) {
  const text = readFileSync(join(root, file), 'utf8');
  const m = text.match(new RegExp(`add_header\\s+${name}\\s+"([^"]+)"`));
  if (!m) { error(file, 0, `no ${name} header found`); return ''; }
  return m[1];
}
const csps = HEADER_FILES.map((f) => header(f, 'Content-Security-Policy'));
const pps = HEADER_FILES.map((f) => header(f, 'Permissions-Policy'));
if (csps[0] !== csps[1]) error(HEADER_FILES[1], 0, `Content-Security-Policy differs from ${HEADER_FILES[0]}`);
if (pps[0] !== pps[1]) error(HEADER_FILES[1], 0, `Permissions-Policy differs from ${HEADER_FILES[0]}`);
const cspText = csps[0];

const csp = new Map();
for (const part of cspText.split(';')) {
  const [name, ...values] = part.trim().split(/\s+/);
  if (name) csp.set(name.toLowerCase(), values);
}
const directive = (name, ...fallbacks) => {
  for (const n of [name, ...fallbacks, 'default-src']) if (csp.has(n)) return csp.get(n);
  return [];
};

// ---- 2. baseline ----
const F = HEADER_FILES[0];
const scriptSrc = directive('script-src');
if (!(csp.get('default-src') || []).includes("'self'")) error(F, 0, "default-src must be 'self'");
if (scriptSrc.includes("'unsafe-inline'")) error(F, 0, "script-src must not allow 'unsafe-inline'");
for (const [name, values] of csp) {
  if (values.includes("'unsafe-eval'")) error(F, 0, `${name} must not allow 'unsafe-eval'`);
  if (['script-src', 'script-src-elem', 'connect-src', 'default-src', 'worker-src'].includes(name)) {
    for (const v of values) {
      if (v === '*' || v === 'https:' || v === 'http:' || v === 'data:') error(F, 0, `${name} must not allow the wildcard source ${v}`);
    }
  }
}
for (const [name, want] of [['object-src', "'none'"], ['base-uri', null], ['frame-ancestors', null], ['form-action', null]]) {
  if (!csp.has(name)) error(F, 0, `CSP is missing ${name}`);
  else if (want && !csp.get(name).includes(want)) error(F, 0, `${name} must be ${want}`);
}
if ((csp.get('style-src') || []).includes("'unsafe-inline'")) warn(F, 0, "style-src allows 'unsafe-inline'; the app doesn't need it");

// ---- 3. HTML ----
const htmlFiles = APP_DIRS.flatMap((d) => walk(join(root, d))).filter((p) => p.endsWith('.html'));
const scriptHashes = new Set(directive('script-src-elem', 'script-src'));
const styleElemHashes = new Set(directive('style-src-elem', 'style-src'));
const styleAttr = directive('style-src-attr', 'style-src');
const styleAttrHashes = new Set(styleAttr);
const unsafeHashes = styleAttr.includes("'unsafe-hashes'");
for (const p of htmlFiles) {
  const file = rel(p);
  const html = readFileSync(p, 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    if (!m[2].trim() && !/type\s*=\s*["']?importmap/i.test(m[1])) continue;
    const h = sha256(m[2]);
    if (!scriptHashes.has(h)) error(file, lineOf(html, m.index), `inline <script> is blocked by the CSP; add ${h} to script-src or move it to a .js file`);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const h = sha256(m[1]);
    if (!styleElemHashes.has(h)) error(file, lineOf(html, m.index), `inline <style> is blocked by the CSP; add ${h} to style-src or move it to a .css file`);
  }
  for (const m of html.matchAll(/<[a-z][^>]*?\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const value = decode(m[2] ?? m[3] ?? '');
    const h = sha256(value);
    if (!(unsafeHashes && styleAttrHashes.has(h))) {
      error(file, lineOf(html, m.index), `style attribute is blocked by the CSP; add 'unsafe-hashes' ${h} to style-src-attr in both security-headers files, or move it to CSS`);
    }
  }
  for (const m of html.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)) {
    error(file, lineOf(html, m.index), `inline event handler ${m[1]}= is blocked by the CSP; use addEventListener`);
  }
  for (const m of html.matchAll(/(?:href|src|action)\s*=\s*["']\s*javascript:/gi)) {
    error(file, lineOf(html, m.index), 'javascript: URLs are blocked by the CSP');
  }
}

// ---- 4 + 5. JavaScript ----
const allowedByCsp = (url) => [...csp.entries()].some(([name, values]) =>
  /-src(-elem)?$/.test(name) && values.some((v) => v.startsWith('http') && (url === v || url.startsWith(v.endsWith('/') ? v : v + '/'))));
const jsFiles = APP_DIRS.flatMap((d) => walk(join(root, d))).filter((p) => /\.(m?js)$/.test(p) && !/[\\/]tests?[\\/]/.test(p));
const INTL_STYLES = new Set(['currency', 'decimal', 'percent', 'unit', 'long', 'short', 'narrow', 'numeric', '2-digit']);
const origins = new Map();
for (const p of jsFiles) {
  const file = rel(p);
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/csp-ok/.test(line)) return;
    const code = line.replace(/^\s*\/\/.*$/, '');
    const n = i + 1;
    if (/(^|[^.\w])eval\s*\(/.test(code)) error(file, n, 'eval() is blocked by the CSP');
    if (/new\s+Function\s*\(/.test(code)) error(file, n, 'new Function() is blocked by the CSP');
    if (/set(Timeout|Interval)\s*\(\s*['"`]/.test(code)) error(file, n, 'string timers are blocked by the CSP; pass a function');
    if (/setAttribute\s*\(\s*['"]style['"]/.test(code)) error(file, n, "setAttribute('style', ...) is blocked by the CSP; use el.style.x = ... or h(tag, { style: {...} })");
    for (const m of code.matchAll(/\bstyle\s*:\s*(['"`])([^'"`]*)\1/g)) {
      if (!INTL_STYLES.has(m[2])) error(file, n, "string style for h() becomes a style attribute, which the CSP blocks; pass an object: style: { ... }");
    }
    // Markup built as strings (HTML or SVG for innerHTML), wherever it is built: a style="..."
    // attribute, an inline on*= handler or a <script> in it is blocked once inserted.
    if (/\sstyle=(?:["'`]|\\["']|\$\{)/.test(code)) {
      error(file, n, 'markup string with a style="..." attribute: blocked by the CSP once inserted (style-src-attr). Use a class, an SVG presentation attribute (e.g. stroke-width="2"), or set el.style after inserting');
    }
    if (/\son[a-z]+=(?:["'`]|\\["']|\$\{)/i.test(code)) error(file, n, 'markup string with an inline on*= handler: blocked by the CSP; use addEventListener');
    if (/<script[\s>]/i.test(code) && /['"`]/.test(code)) error(file, n, 'markup string with <script>: blocked by the CSP');
    const loads = /(fetch|importScripts|import|new\s+(Worker|SharedWorker|EventSource|WebSocket))\s*\(|\.src\s*=|\bsrc\s*:/.test(code);
    for (const m of code.matchAll(/\b(https?):\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[^\s'"`)]*)?/gi)) {
      if (m[2] === 'www.w3.org') continue;
      const key = `${m[1]}://${m[2]}`;
      if (!origins.has(key)) origins.set(key, { file, line: n, url: m[0] });
      if (loads && !allowedByCsp(m[0])) error(file, n, `${m[0]} is loaded here but not allowed by the CSP; add it to both security-headers files`);
    }
  });
}

if (origins.size) {
  console.log('External origins referenced from app JavaScript:');
  for (const [origin, { file, line, url }] of origins) {
    const ok = allowedByCsp(url);
    console.log(`  ${ok ? 'allowed by CSP' : 'not in CSP    '}  ${origin}  (${file}:${line})`);
  }
  console.log('  (Links the user navigates to, like maps.apple.com, need no CSP entry. Anything fetched,');
  console.log('   loaded as a script/style/image or used as a worker must be allowed in both header files.)');
}

console.log(`\ncheck-csp: ${htmlFiles.length} HTML and ${jsFiles.length} JS files checked; ${errors} error(s), ${warnings} warning(s).`);
process.exit(errors ? 1 : 0);
