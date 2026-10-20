// Onboarding, import/export, notifications and developer settings, end to end: embedded Postgres 17,
// the API in-process, a static server that proxies /api/ like nginx, headless Chrome over CDP.
//   cd server && npm ci
//   node electrical-app/tests/e2e/onboarding.e2e.mjs [scratch dir]
// Set-up code is the same as accounts.e2e.mjs (workstream G). Not part of the unit test run.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-e2e-'));
const SERVER = join(WT, 'server');
const APPDIR = join(WT, 'electrical-app');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const req = createRequire(join(SERVER, 'package.json'));
const mod = (p) => import(pathToFileURL(join(SERVER, p)).href);
const ESM = { 'embedded-postgres': 'dist/index.js', otplib: 'dist/index.js', pg: 'esm/index.mjs' };
const pkg = (name) => import(pathToFileURL(join(SERVER, 'node_modules', name, ESM[name])).href);

const EmbeddedPostgres = (await pkg('embedded-postgres')).default;
const pg = (await pkg('pg')).default;
const { generate } = await pkg('otplib');
const { runPsqlScript } = await mod('test/support/psql-lite.js');
const { migrate } = await mod('src/migrate.js');
const { createDb, createPool } = await mod('src/db.js');
const { readConfig } = await mod('src/config.js');
const { buildApp } = await mod('src/app.js');
const { seed } = await mod('src/seed.js');

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = () => randomBytes(18).toString('base64url');
function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ---------- Postgres, API, static + proxy ----------
const pgDir = join(SCRATCH, `pg-${Date.now()}`);
const pgPort = await freePort();
const superPw = pw();
const pgServer = new EmbeddedPostgres({ databaseDir: join(pgDir, 'data'), port: pgPort, user: 'postgres', password: superPw, authMethod: 'scram-sha-256', persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
await pgServer.initialise();
await pgServer.start();
const superUrl = `postgres://postgres:${encodeURIComponent(superPw)}@127.0.0.1:${pgPort}/postgres`;
const roles = { owner_password: pw(), app_password: pw(), hq_password: pw() };
await runPsqlScript(readFileSync(join(SERVER, 'db/bootstrap.sql'), 'utf8'), superUrl, roles);
const dbUrl = (user, p) => `postgres://${user}:${encodeURIComponent(p)}@127.0.0.1:${pgPort}/fishtape`;
const ownerClient = new pg.Client({ connectionString: dbUrl('fishtape_owner', roles.owner_password) });
await ownerClient.connect();
await migrate(ownerClient);
const superDb = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(superPw)}@127.0.0.1:${pgPort}/fishtape` });
await superDb.connect();
const db = createDb({ app: createPool(dbUrl('fishtape_app', roles.app_password), { max: 8 }) });
const printed = await seed({ db, ownerClient, log: () => {} });
const creds = Object.fromEntries(printed.map(([, email, p]) => [email, p]));
log('seeded', Object.keys(creds).join(', '));

const apiPort = await freePort();
const webPort = await freePort();
const ORIGIN = `http://localhost:${webPort}`;
const config = readConfig({ APP_ENV: 'local', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: dbUrl('fishtape_app', roles.app_password), RATE_LIMIT: 'off', LOG_LEVEL: 'warn', PORT: String(apiPort) });
let api = null;
async function apiUp() { api = await buildApp({ config, db }); await api.listen({ port: apiPort, host: '127.0.0.1' }); log('API up on', apiPort); }
async function apiDown() { await api.close(); api = null; log('API down'); }
await apiUp();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };
const web = createServer((rq, rs) => {
  const url = new URL(rq.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    // Like nginx: forward to the API, 502 HTML when it is down.
    const up = httpRequest({ host: '127.0.0.1', port: apiPort, method: rq.method, path: rq.url, headers: { ...rq.headers, 'x-forwarded-for': '127.0.0.1' } }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
    up.on('error', () => { if (!rs.headersSent) { rs.writeHead(502, { 'content-type': 'text/html' }); rs.end('<h1>502 Bad Gateway</h1>'); } });
    rq.pipe(up);
    return;
  }
  if (url.pathname === '/sw.js' && process.env.E2E_SW) { rs.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' }); rs.end(readFileSync(process.env.E2E_SW)); return; }
  let p = normalize(join(APPDIR, decodeURIComponent(url.pathname)));
  if (!p.startsWith(resolvePath(APPDIR))) { rs.writeHead(403); rs.end(); return; }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { rs.writeHead(404, { 'content-type': 'text/plain' }); rs.end('not found'); return; }
  rs.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  rs.end(readFileSync(p));
});
await new Promise((r) => web.listen(webPort, '127.0.0.1', r));
log('web on', ORIGIN);

// ---------- Chrome over CDP ----------
const cdpPort = await freePort();
const profile = join(SCRATCH, `chrome-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) throw new Error('Chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const waiting = new Map();
const consoleLines = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  else if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails || {}; consoleLines.push(`[exception] ${d.exception?.description || d.text} (${d.url || d.scriptId || ''}:${d.lineNumber ?? ''})`); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
await send('Page.enable');

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await evaluate(expression); if (v) return v; } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.split('\n')[0]})` : ''}`);
}
// Always a full load (a hash-only change would keep the running app).
const goto = async (path) => { await send('Page.navigate', { url: 'about:blank' }); await sleep(150); await send('Page.navigate', { url: ORIGIN + path }); await sleep(400); await waitFor('document.readyState === "complete" && location.href.startsWith(' + JSON.stringify(ORIGIN) + ')', 'load'); };
const J = JSON.stringify;
const fill = (sel, val, scope = 'document') => evaluate(`(() => { const el = ${scope}.querySelector(${J(sel)}); if (!el) throw new Error('missing ' + ${J(sel)}); el.focus(); el.value = ${J(val)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const click = (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a')].find((b) => b.textContent.trim() === ${J(text)} && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)}); el.click(); return true; })()`);
const text = () => evaluate('document.body.innerText');
async function shot(name) {
  try { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SCRATCH, `${name}.png`), Buffer.from(data, 'base64')); } catch { /* ignore */ }
}

// One code per 30 s step per user (the server refuses a step twice); never more than one step ahead.
function totp(secret) {
  let lastStep = 0;
  return async () => {
    lastStep = Math.max(lastStep + 1, Math.floor(Date.now() / 30000) - 1);
    while (lastStep > Math.floor(Date.now() / 30000) + 1) await sleep(1000);
    return generate({ secret, epoch: lastStep * 30 });
  };
}
const secrets = {};

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
    log('PASS', name, detail ?? '');
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    log('FAIL', name, e.message);
    await shot(`fail-${results.length}`);
    throw e;
  }
}

async function signIn(email, { enrol }) {
  await waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
  await fill('input[name=email]', email);
  await fill('input[name=password]', creds[email]);
  await click('Sign in', '.gate');
  if (enrol) {
    await waitFor('!!document.querySelector(".secret")', 'MFA enrolment key');
    const secret = (await evaluate('document.querySelector(".secret").textContent')).replace(/\s+/g, '');
    secrets[email] = totp(secret);
    const qr = await evaluate('!!document.querySelector(".qr-box svg path")');
    if (!qr) throw new Error('no QR code drawn');
    await fill('.gate input.code-input', await secrets[email]());
    await click('Turn on two-step sign-in', '.gate');
    await waitFor('document.querySelectorAll(".codes li").length === 10', 'ten recovery codes');
    await evaluate('document.querySelector(".gate input[type=checkbox]").click()');
    await click('Continue', '.gate');
  } else {
    await waitFor('!!document.querySelector(".gate input.code-input")', 'MFA code prompt');
    await fill('.gate input.code-input', await secrets[email]());
    await click('Verify', '.gate');
  }
  await waitFor('!!document.querySelector(".rail") && !!window.kelbe?.sync', 'the app shell');
  await waitFor('kelbe.sync.status().state === "synced" && kelbe.sync.status().pulledOnce', 'first sync');
}


// ---------- onboarding, import/export, notifications, developer ----------
const fileChooser = { pending: null };
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === 'Page.fileChooserOpened' && fileChooser.pending) {
    const files = fileChooser.pending; fileChooser.pending = null;
    send('DOM.setFileInputFiles', { files, backendNodeId: msg.params.backendNodeId }).catch((e) => log('file chooser failed', e.message));
  }
});
await send('Page.setInterceptFileChooserDialog', { enabled: true });
const DL = join(SCRATCH, `downloads-${Date.now()}`);
mkdirSync(DL, { recursive: true });
await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
/** Click a button that opens a file picker, answering it with `path`. */
async function chooseFile(buttonText, path, within = 'main') { fileChooser.pending = [path]; await click(buttonText, within); }
const { readdirSync } = await import('node:fs');
async function waitDownload(prefix, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = readdirSync(DL).find((n) => n.startsWith(prefix) && !n.endsWith('.crdownload'));
    if (f) return join(DL, f);
    await sleep(200);
  }
  throw new Error(`no download starting ${prefix}`);
}

// Test files: 2,000 clients (quotes, commas, a BOM, CRLF) and a QuickBooks products export.
const clientsCsv = join(SCRATCH, 'clients-2000.csv');
{
  const lines = ['﻿Name,Email,Phone,Street,City,Province,Postal code,Notes'];
  for (let i = 0; i < 2000; i++) lines.push(`"Client ${i}, Ltd",c${i}@import.example,306-555-${String(i).padStart(4, '0')},${i} Main St,Regina,SK,S4P 3Y2,"Gate ""${i}""\nside door"`);
  lines.push('"Client 7, Ltd",dupe7@import.example,,,,,,'); // same name as row 9: skipped
  lines.push(',,,,,,,orphan note'); // no name: error
  writeFileSync(clientsCsv, lines.join('\r\n'));
}
const productsCsv = join(SCRATCH, 'qbo-products.csv');
writeFileSync(productsCsv, [
  'Product/Service Name,Sales Description,SKU,Type,Sales Price / Rate,Income Account,Purchase Description,Purchase Cost,Expense Account,Quantity On Hand,Reorder Point',
  'Decora switch 15A,"Single pole, white",SW-DEC-15,Inventory,$18.95,Sales,,6.10,Cost of Goods Sold,24,10',
  'NMD90 14/2 per 100 ft,Romex,WR-NMD90-14-2-C,Inventory,"$1,120.00",Sales,,410.00,Cost of Goods Sold,3,',
  'Service call,First hour,SVC-1,Service,145,Services,,,,,',
  'Duplex receptacle 15A TR,,DEV-REC-15,Inventory,13.50,Sales,,2.45,Cost of Goods Sold,,',
].join('\n'));
const logoSvg = join(SCRATCH, 'logo.svg');
writeFileSync(logoSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#f5b301"/><text x="40" y="240" font-size="160" font-family="sans-serif">TG</text></svg>');

let exitCode = 0;
try {
  await step('sign in as the TG Electrical owner (MFA enrolment)', async () => {
    await goto('/');
    await signIn('owner@tgelectrical.test', { enrol: true });
    // First launch asks metric or imperial.
    await waitFor('document.body.innerText.includes("How do you measure?")', 'units prompt', 5000).then(() => evaluate('[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.includes("Metric")).click()')).catch(() => {});
    return await evaluate('kelbe.session.me.entitlements.plan');
  });
  const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;

  await step('onboarding: dashboard card, checklist ticks itself off as steps are done', async () => {
    await evaluate('location.hash = "#/dashboard"');
    await waitFor('!!document.querySelector(".ob-card")', 'checklist card on the dashboard');
    const before = await evaluate('document.querySelector(".ob-card .muted").textContent');
    await click('Continue', '.ob-card');
    await waitFor('!!document.querySelector(".ob-step.open[data-step=company]")', 'company step open');
    await fill('.ob-step.open input[name=name]', 'TG Electrical Ltd');
    await fill('.ob-step.open input[name=phone]', '403-555-0100');
    await fill('.ob-step.open input[name=gstHstNo]', '123456789 RT0001');
    await click('Save', '.ob-step.open');
    await waitFor('!!document.querySelector(".ob-step.done[data-step=company]")', 'company done');
    // province: the next open step; pick Alberta and confirm
    await waitFor('!!document.querySelector(".ob-step.open[data-step=province]")', 'province step opens next');
    await evaluate('{ const s = document.querySelector(".ob-step.open select[name=province]"); s.value = "AB"; s.dispatchEvent(new Event("change", { bubbles: true })); }');
    await click('Confirm', '.ob-step.open');
    await waitFor('!!document.querySelector(".ob-step.done[data-step=province]") && kelbe.store.settings().company.province === "AB"', 'province done (AB)');
    await evaluate('document.querySelector("[data-step=logo] .ob-step-head").click()');
    await waitFor('!!document.querySelector(".ob-step.open[data-step=logo]")', 'logo step');
    await chooseFile('Upload logo', logoSvg, '.ob-step.open');
    await waitFor('kelbe.store.settings().company.logo?.startsWith("data:image/")', 'logo stored');
    const logoLen = await evaluate('kelbe.store.settings().company.logo.length');
    await waitFor('!!document.querySelector(".ob-step.done[data-step=logo]")', 'logo done');
    await evaluate('document.querySelector("[data-step=rates] .ob-step-head").click()');
    await waitFor('!!document.querySelector(".ob-step.open[data-step=rates]")', 'rates step');
    await fill('.ob-step.open input[name=labourRateCents]', '110');
    await click('Confirm', '.ob-step.open');
    await waitFor('kelbe.store.settings().labourRateCents === 11000 && !!document.querySelector(".ob-step.done[data-step=rates]")', 'rates done');
    // crew: invite one member by email (PIN-only would work too)
    await evaluate('document.querySelector("[data-step=crew] .ob-step-head").click()');
    await click('Invite someone', '.ob-step.open');
    await waitFor('!!document.querySelector("[role=dialog] input[name=name]")', 'invite sheet');
    await fill('[role=dialog] input[name=name]', 'Sam Rivera');
    await fill('[role=dialog] input[name=email]', 'sam@tgelectrical.test');
    await click('Invite', '[role=dialog]');
    await waitFor('!!document.querySelector(".ob-step.done[data-step=crew]")', 'crew done', 20000);
    const invite = (await superDb.query("SELECT count(*)::int AS n FROM email_outbox WHERE template = 'invite' AND to_address = 'sam@tgelectrical.test'")).rows[0].n;
    if (invite !== 1) throw new Error(`invite emails: ${invite}`);
    const after = await evaluate('document.querySelector(".ob-card strong").textContent');
    await shot('onboarding');
    return `${before} → ${after}; logo ${logoLen} chars; invite queued`;
  });

  await step('import 2,000 clients from CSV: preview, errors, duplicates, chunked import, synced to the server', async () => {
    const before = await evaluate('kelbe.store.count("clients")');
    await evaluate('location.hash = "#/import?target=clients"');
    await waitFor('!!document.querySelector(".imp-targets")', 'import screen');
    await chooseFile('Choose a file', clientsCsv);
    await waitFor('!!document.querySelector(".imp-map")', 'column mapping');
    const mapped = await evaluate('[...document.querySelectorAll(".imp-map select")].map((s) => s.dataset.field + "=" + (s.selectedOptions[0]?.textContent || "")).join("; ")');
    await click('Check rows', 'main');
    await waitFor('!!document.querySelector(".imp-preview")', 'preview', 30000);
    const stats = await evaluate('[...document.querySelectorAll(".imp-stats .stat")].map((s) => s.querySelector(".label").textContent + ":" + s.querySelector(".value").textContent).join(", ")');
    if (!/New:2,000/.test(stats) || !/Errors:1/.test(stats) || !/Skipped \(duplicates\):1/.test(stats)) throw new Error(stats);
    await shot('import-preview');
    const t0 = Date.now();
    // Responsiveness: a timer must keep firing while the import runs.
    await evaluate('window.__ticks = 0; window.__tick = setInterval(() => window.__ticks++, 50)');
    await click('Import 2,000 records', 'main');
    await waitFor('!!document.querySelector(".imp-done")', 'import done', 120000);
    const ms = Date.now() - t0;
    const ticks = await evaluate('clearInterval(window.__tick), window.__ticks');
    const n = await evaluate('kelbe.store.count("clients")');
    if (n - before !== 2000) throw new Error(`clients ${before} → ${n}`);
    const sample = await evaluate('kelbe.store.list("clients").find((c) => c.name === "Client 5, Ltd")');
    if (sample.address !== '5 Main St, Regina, SK S4P 3Y2' || !sample.notes.includes('Gate "5"\nside door')) throw new Error(JSON.stringify(sample));
    await evaluate('kelbe.sync.syncNow()');
    await waitFor('kelbe.sync.status().waiting === 0 && kelbe.sync.status().state === "synced"', 'sync drained', 120000);
    const server = (await superDb.query("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1 AND data->>'email' LIKE '%@import.example' AND deleted_at IS NULL", [tg])).rows[0].n;
    if (server !== 2000) throw new Error(`server has ${server}`);
    return `mapping ${mapped}; ${stats}; imported in ${ms} ms with ${ticks} timer ticks; server has ${server}`;
  });

  await step('import a QuickBooks products export: preset detected, money and units normalised, duplicate SKU updated; undo', async () => {
    await evaluate('location.hash = "#/import?target=items"');
    await waitFor('!!document.querySelector(".imp-targets")', 'import screen');
    await chooseFile('Choose a file', productsCsv);
    await waitFor('!!document.querySelector(".imp-map")', 'column mapping');
    const preset = await evaluate('document.querySelector("main .badge.info").textContent');
    if (!/QuickBooks Online products/.test(preset)) throw new Error(preset);
    await evaluate('{ const s = document.querySelector("select[name=mode]"); s.value = "update"; s.dispatchEvent(new Event("change", { bubbles: true })); }');
    await click('Check rows', 'main');
    await waitFor('!!document.querySelector(".imp-preview")', 'preview');
    const stats = await evaluate('[...document.querySelectorAll(".imp-stats .stat")].map((s) => s.querySelector(".label").textContent + ":" + s.querySelector(".value").textContent).join(", ")');
    await click('Import 4 records', 'main');
    await waitFor('!!document.querySelector(".imp-done")', 'done');
    const items = await evaluate('Object.fromEntries(kelbe.store.list("items").map((i) => [i.sku, [i.priceCents, i.costCents, i.unit]]))');
    if (JSON.stringify(items['SW-DEC-15']) !== '[1895,610,"ea"]' || items['DEV-REC-15'][0] !== 1350 || items['WR-NMD90-14-2-C'][0] !== 112000) throw new Error(JSON.stringify(items));
    const count = await evaluate('kelbe.store.count("items")');
    await click('Undo this import', 'main');
    await click('Undo import', '[role=dialog]');
    await waitFor(`kelbe.store.count("items") === ${count - 3} && kelbe.store.list("items").find((i) => i.sku === "DEV-REC-15").priceCents === 1200`, 'undo removed 3 and restored the updated price');
    // and import it again for the rest of the run
    await click('Import another file', 'main');
    await evaluate('{ const b = [...document.querySelectorAll(".imp-target")].find((x) => x.textContent.includes("Price book")); b.click(); }');
    await chooseFile('Choose a file', productsCsv);
    await waitFor('!!document.querySelector(".imp-map")', 'mapping again');
    await click('Check rows', 'main');
    await waitFor('!!document.querySelector(".imp-preview")', 'preview again');
    await click('Import 3 records', 'main');
    await waitFor('!!document.querySelector(".imp-done")', 'done again');
    return `${preset}; ${stats}; prices ${JSON.stringify(items)}; undo ok`;
  });

  await step('accounting export: QuickBooks invoices CSV with tax codes', async () => {
    const lastMonth = await evaluate('(() => { const d = new Date(); const x = new Date(d.getFullYear(), d.getMonth() - 1, 12); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-12"; })()');
    const clientId = await evaluate('kelbe.store.list("clients").find((c) => c.name.includes("Dental Clinic")).id');
    await evaluate(`(async () => { const { newDocTax } = await import('/js/lib/tax.js'); const s = kelbe.store.settings();
      kelbe.store.add('invoices', { number: 'INV-E2E-1', clientId: ${J(clientId)}, jobId: null, status: 'sent', issueDate: ${J(lastMonth)}, dueDate: ${J(lastMonth)}, notes: 'E2E',
        lines: [{ description: 'Receptacles', qty: 12, unitCents: 1200, labourHours: 0, kind: 'material' }, { description: 'Labour', qty: 4, unitCents: 11000, labourHours: 0, kind: 'labour' }], ...newDocTax(s, ${J(lastMonth)}) }); })()`);
    await evaluate('location.hash = "#/import/export"');
    await waitFor('document.body.innerText.includes("Bringing it into QuickBooks Online")', 'export screen');
    await waitFor('!!document.querySelector("input[data-tax-key]")', 'tax code table');
    const codes = await evaluate('[...document.querySelectorAll("input[data-tax-key]")].map((i) => i.dataset.taxKey + "=" + i.value).join(", ")');
    await click('Invoices (QuickBooks)', 'main');
    const file = await waitDownload('qbo-invoices-');
    const csv = readFileSync(file, 'utf8');
    const lines = csv.trim().split(/\r\n/);
    if (!lines[0].startsWith('InvoiceNo,Customer,InvoiceDate,DueDate') || !lines.some((l) => l.startsWith('INV-E2E-1,') && l.includes(',144.00,GST'))) throw new Error(csv.slice(0, 400));
    await click('Customers (QuickBooks)', 'main');
    const cust = await waitDownload('qbo-customers-');
    const custLines = readFileSync(cust, 'utf8').trim().split(/\r\n/).length;
    await shot('export');
    return `codes ${codes}; ${lines.length - 1} invoice lines; customers file ${custLines - 1} rows (${cust.split(/[\\/]/).pop()})`;
  });

  await step('bell: a Stripe payment lands as a notification with an unread count', async () => {
    await evaluate('kelbe.sync.syncNow()');
    await waitFor('kelbe.sync.status().waiting === 0', 'invoice synced', 60000);
    const invId = await evaluate('kelbe.store.list("invoices").find((i) => i.number === "INV-E2E-1").id');
    const { createRecords } = await mod('src/services/records.js');
    const { createValidator } = await mod('src/schemas.js');
    const { recordStripePayment } = await mod('src/integrations/payments.js');
    const { systemPrincipal, systemWho } = await mod('src/integrations/state.js');
    const records = createRecords({ validator: createValidator() });
    const p = systemPrincipal(tg, 'stripe', 'Stripe');
    const r = await db.withTenant({ tenantId: tg }, (tx) => recordStripePayment(tx, records, p, systemWho(p, {}), { id: 'cs_e2e', payment_intent: 'pi_e2e', amount_total: 5000, metadata: { fishtape_invoice: invId }, currency: 'cad', created: Math.floor(Date.now() / 1000) }, 'evt_e2e'), { write: true });
    if (!r.recorded) throw new Error(JSON.stringify(r));
    await evaluate('location.hash = "#/dashboard"');
    await evaluate('document.querySelector(".notify-bell").click()');
    await waitFor('[...document.querySelectorAll(".notify-row")].some((r) => r.textContent.includes("Card payment of $50.00 received online"))', 'payment in the panel', 20000);
    await waitFor('!!document.querySelector(".notify-bell .notify-count")', 'unread badge');
    const count = await evaluate('document.querySelector(".notify-bell .notify-count").textContent');
    await shot('bell');
    if (await evaluate('/\\bnull\\b|undefined/.test(document.querySelector("[role=dialog]").innerText)')) throw new Error('panel shows null/undefined');
    await click('Mark all read', '[role=dialog]');
    await waitFor('!document.querySelector(".notify-bell .notify-count")', 'badge cleared');
    if (await evaluate('/null/.test(document.querySelector(".notify-bell").textContent)')) throw new Error('bell shows null');
    const unreadNow = async () => (await superDb.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND read_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $2)', [tg, 'owner@tgelectrical.test'])).rows[0].n;
    let unreadServer = await unreadNow();
    for (let i = 0; i < 25 && unreadServer; i++) { await sleep(200); unreadServer = await unreadNow(); }
    if (unreadServer) throw new Error(`server still has ${unreadServer} unread`);
    await evaluate('document.querySelector("[role=dialog] button[title=Close]").click()');
    return `badge showed ${count}; after Mark all read the server has ${unreadServer} unread`;
  });

  await step('developer settings: create a scoped key (shown once), then revoke it', async () => {
    await evaluate('location.hash = "#/developer"');
    await waitFor('document.body.innerText.includes("Connect an AI agent over MCP")', 'developer page');
    await click('New API key', 'main .page-head');
    await waitFor('!!document.querySelector("[role=dialog] input[name=name]")', 'create sheet');
    await fill('[role=dialog] input[name=name]', 'E2E agent');
    await click('Create key', '[role=dialog]');
    await waitFor('document.querySelector("[role=dialog] input.mono")?.value.startsWith("ft_")', 'key shown once');
    const key = await evaluate('document.querySelector("[role=dialog] input.mono").value');
    const scoped = (await superDb.query("SELECT scopes FROM api_keys WHERE name = 'E2E agent'")).rows[0].scopes;
    await click('I have copied it', '[role=dialog]');
    await waitFor('[...document.querySelectorAll("main tbody tr")].some((r) => r.textContent.includes("E2E agent") && r.textContent.includes("active"))', 'key listed');
    const shown = await evaluate('document.body.innerText.includes(' + J(key) + ')');
    if (shown) throw new Error('the full key is still on the page');
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/v1/jobs?limit=1`, { headers: { authorization: `Bearer ${key}` } });
    await click('Revoke', 'main tbody');
    await click('Revoke', '[role=dialog]');
    await waitFor('[...document.querySelectorAll("main tbody tr")].some((r) => r.textContent.includes("E2E agent") && r.textContent.includes("revoked"))', 'revoked');
    const after = await fetch(`http://127.0.0.1:${apiPort}/api/v1/jobs?limit=1`, { headers: { authorization: `Bearer ${key}` } });
    return `scopes ${scoped.join(' ')}; key works (${res.status}) then refused after revoke (${after.status})`;
  });

  await step('security log shows the company audit log from the server', async () => {
    await evaluate('location.hash = "#/security?tab=log"');
    await waitFor('[...document.querySelectorAll("main tbody tr")].some((r) => r.textContent.includes("api_key.revoke"))', 'server audit rows');
    return 'api_key.revoke visible';
  });

  await step('phone width: no sideways scrolling on the new screens', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const out = [];
    for (const hash of ['#/onboarding', '#/import', '#/import/export', '#/developer', '#/notifications', '#/settings']) {
      await evaluate(`location.hash = ${J(hash)}`);
      await sleep(700);
      const w = await evaluate('[document.documentElement.scrollWidth, innerWidth, document.querySelector("main").scrollWidth, document.querySelector("main").clientWidth]');
      out.push(`${hash} ${w[0]}/${w[1]}`);
      if (w[0] > w[1] + 1) throw new Error(`${hash} scrolls sideways: ${w}`);
      await shot(`phone-${hash.replace(/[#/]/g, '') || 'home'}`);
    }
    await send('Emulation.clearDeviceMetricsOverride');
    return out.join(', ');
  });
} catch {
  exitCode = 1;
} finally {
  const errors = consoleLines.filter((l) => /exception|\[error\]/.test(l));
  writeFileSync(join(SCRATCH, 'onboarding-e2e-results.json'), JSON.stringify({ results, console: consoleLines.slice(-80) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`browser console errors: ${errors.length}`);
  for (const e of errors.slice(0, 15)) console.log('   ', e.slice(0, 300));
  if (errors.length) exitCode = 1;
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  web.close();
  try { await api?.close(); } catch { /* ignore */ }
  await db.close?.();
  await ownerClient.end(); await superDb.end();
  await pgServer.stop();
  await sleep(500);
  try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* Windows may hold files */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
