// Purchasing end to end (docs/integrations/quickbooks.md 11.5, W5): embedded Postgres 17 + the
// API (in-process) + a static server that proxies /api/ like nginx + headless Chrome over CDP:
//   owner on an iPad (1180 x 820): turns Purchasing on (Settings → Modules), adds a supplier, makes
//     a purchase order from two of the crew's material requests (they become "ordered"), enters the
//     supplier's bill for it with a photo of the bill (the "doesn't add up" warning until the total
//     matches), and records a supplier refund as a negative receipt.
//   electrician on a phone (390 x 844): no Purchasing in the rail, "No access" on the route, and not
//     one supplier, bill or purchase order on the device.
// Without QuickBooks: nothing here needs it.
//
//   cd server && npm ci
//   node electrical-app/tests/e2e/purchasing.e2e.mjs [scratch dir]
// CHROME_PATH overrides the Chrome binary; E2E_PHOTO the photo of the bill. Needs the purchasing
// module registered in js/modules/index.js. Not part of `node --test electrical-app/tests/*.test.mjs`.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-pu-e2e-'));
mkdirSync(SCRATCH, { recursive: true });
const SERVER = join(WT, 'server');
const APPDIR = join(WT, 'electrical-app');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const mod = (p) => import(pathToFileURL(join(SERVER, p)).href);
const ESM = { 'embedded-postgres': 'dist/index.js', otplib: 'dist/index.js', pg: 'esm/index.mjs' };
const pkg = (name) => import(pathToFileURL(join(SERVER, 'node_modules', name, ESM[name])).href);

const EmbeddedPostgres = (await pkg('embedded-postgres')).default;
const pg = (await pkg('pg')).default;
const { runPsqlScript } = await mod('test/support/psql-lite.js');
const { migrate } = await mod('src/migrate.js');
const { createDb, createPool } = await mod('src/db.js');
const { readConfig } = await mod('src/config.js');
const { buildApp } = await mod('src/app.js');
const { seed } = await mod('src/seed.js');
const { hashSecret } = await mod('src/auth/passwords.js');
const { createRecords } = await mod('src/services/records.js');
const { createValidator } = await mod('src/schemas.js');
const { systemPrincipal, systemWho } = await mod('src/integrations/state.js');

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = () => randomBytes(18).toString('base64url');
const J = JSON.stringify;
function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const { generate } = await pkg('otplib');

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
await seed({ db, ownerClient, log: () => {} });

// TG Electrical (Manitoba for this run): the owner signs in with a known password (two-step
// sign-in is set up on first sign-in); an electrician is added.
const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;
await superDb.query("UPDATE tenants SET province = 'MB' WHERE id = $1", [tg]).catch(() => {});
await superDb.query("INSERT INTO employees (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'emp-sam', $2, 'system:e2e', 'system:e2e')",
  [tg, { name: 'Sam Sparks', role: 'electrician', active: true, color: '#7a3fb0', email: '', phone: '', rateCents: 4200 }]);
const people = {};
{
  const password = `pw-${randomBytes(10).toString('hex')}`;
  await superDb.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE email = $1', ['owner@tgelectrical.test', await hashSecret(password)]);
  people.owner = { email: 'owner@tgelectrical.test', password };
  const email = 'sam@tgelectrical.test';
  const pw2 = `pw-${randomBytes(10).toString('hex')}`;
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING id', [email, 'Sam Sparks', await hashSecret(pw2)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [tg, u.rows[0].id, 'electrician', 'emp-sam']);
  people.sam = { email, password: pw2, emp: 'emp-sam' };
}
log('seeded TG Electrical with an owner and an electrician');

// A QuickBooks pull, as the server would write it (system:qbo), without a QuickBooks connection.
const records = createRecords({ validator: createValidator() });
const qboP = systemPrincipal(tg, 'qbo', 'QuickBooks sync');
const asQbo = (fn) => db.withTenant({ tenantId: tg }, (tx) => fn(tx, qboP, systemWho(qboP)), { write: true });

const apiPort = await freePort();
const webPort = await freePort();
const ORIGIN = `http://localhost:${webPort}`;
const config = readConfig({ APP_ENV: 'local', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: dbUrl('fishtape_app', roles.app_password), RATE_LIMIT: 'off', LOG_LEVEL: 'warn', PORT: String(apiPort) });
let api = null;
async function apiUp() { api = await buildApp({ config, db }); await api.listen({ port: apiPort, host: '127.0.0.1' }); log('API up'); }
async function apiDown() { await api.close(); api = null; log('API down'); }
await apiUp();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };
const web = createServer((rq, rs) => {
  const url = new URL(rq.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    const up = httpRequest({ host: '127.0.0.1', port: apiPort, method: rq.method, path: rq.url, headers: { ...rq.headers, 'x-forwarded-for': '127.0.0.1' } }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
    up.on('error', () => { if (!rs.headersSent) { rs.writeHead(502, { 'content-type': 'text/html' }); rs.end('<h1>502 Bad Gateway</h1>'); } });
    rq.pipe(up);
    return;
  }
  let p = normalize(join(APPDIR, decodeURIComponent(url.pathname)));
  if (!p.startsWith(resolvePath(APPDIR))) { rs.writeHead(403); rs.end(); return; }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { rs.writeHead(404, { 'content-type': 'text/plain' }); rs.end('not found'); return; }
  rs.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  rs.end(readFileSync(p));
});
await new Promise((r) => web.listen(webPort, '127.0.0.1', r));

// ---------- Chrome over CDP: one browser, two contexts ----------
const cdpPort = await freePort();
const profile = join(SCRATCH, `chrome-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let version = null;
for (let i = 0; i < 100 && !version; i++) { await sleep(200); try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { /* not up yet */ } }
if (!version) throw new Error('Chrome did not start');
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const waiting = new Map();
const listeners = new Set();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else for (const fn of listeners) fn(msg);
};
const browserSend = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(J({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });

async function openPage(name, { width, height, mobile, touch = mobile }) {
  const { browserContextId } = await browserSend('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await browserSend('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browserSend(m, p, sessionId);
  const consoleLines = [];
  const chooser = [];
  listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    else if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    else if (msg.method === 'Log.entryAdded') consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    else if (msg.method === 'Page.fileChooserOpened') chooser.push(msg.params);
  });
  for (const m of ['Runtime.enable', 'Page.enable', 'Log.enable', 'DOM.enable']) await send(m);
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const downloads = join(SCRATCH, `downloads-${name}`);
  mkdirSync(downloads, { recursive: true });
  await browserSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId });
  // userGesture: a tap in the real app; needed where the page opens the camera (file input).
  const evaluate = async (expression, { gesture = false } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, what, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try { const v = await evaluate(expression); if (v) return v; } catch (e) { last = e.message; }
      await sleep(150);
    }
    throw new Error(`${name}: timed out waiting for ${what}${last ? ` (${last.split('\n')[0]})` : ''}`);
  };
  return {
    name, send, evaluate, waitFor, consoleLines, chooser, downloads,
    async goto(path) { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); await waitFor(`document.readyState === "complete" && location.href.startsWith(${J(ORIGIN)})`, 'load'); },
    fill: (sel, val, scope = 'document') => evaluate(`(() => { const roots = [...${scope}.querySelectorAll(${J(sel)})]; const el = roots.at(-1); if (!el) throw new Error('missing ' + ${J(sel)}); el.focus(); if (el.type === 'checkbox') el.checked = ${J(Boolean(val))}; else el.value = ${J(String(val))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    click: (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a, [role=button], [role=tab]')].find((b) => (b.textContent.trim() === ${J(text)} || b.getAttribute('aria-label') === ${J(text)}) && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)} + ' in ' + ${J(within)}); el.click(); return true; })()`),
    text: () => evaluate('document.body.innerText'),
    async shot(file) { try { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SCRATCH, `${file}.png`), Buffer.from(data, 'base64')); } catch { /* ignore */ } },
    async mouse(type, x, y) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }); },
    async touch(type, x, y) { await send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] }); },
  };
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
    log('PASS', name, detail ?? '');
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    log('FAIL', name, e.message);
    for (const p of pages) await p.shot(`fail-${results.length}-${p.name}`);
    throw e;
  }
}

async function signIn(p, who) {
  await p.goto('/');
  await p.waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
  await p.evaluate('localStorage.setItem("ft.units", "metric"); true');
  await p.fill('input[name=email]', who.email);
  await p.fill('input[name=password]', who.password);
  await p.click('Sign in', '.gate');
  await p.waitFor('!!document.querySelector(".rail") && !!window.kelbe?.sync', 'the app shell');
  await p.waitFor('kelbe.sync.status().state === "synced" && kelbe.sync.status().pulledOnce', 'first sync', 30000);
}
const synced = (p) => p.waitFor('kelbe.sync.syncNow().then(() => kelbe.sync.status().waiting === 0 && kelbe.sync.status().state === "synced")', 'synced', 30000);
// One code per 30 s step (the server refuses a step twice); never more than one step ahead.
function totp(secret) {
  let lastStep = 0;
  return async () => {
    lastStep = Math.max(lastStep + 1, Math.floor(Date.now() / 30000) - 1);
    while (lastStep > Math.floor(Date.now() / 30000) + 1) await sleep(1000);
    return generate({ secret, epoch: lastStep * 30 });
  };
}

async function signInOwner(p, who) {
  await p.goto('/');
  await p.waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
  await p.evaluate('localStorage.setItem("ft.units", "metric"); true');
  await p.fill('input[name=email]', who.email);
  await p.fill('input[name=password]', who.password);
  await p.click('Sign in', '.gate');
  await p.waitFor('!!document.querySelector(".secret")', 'MFA enrolment key');
  const secret = (await p.evaluate('document.querySelector(".secret").textContent')).replace(/\s+/g, '');
  who.totp = totp(secret);
  await p.fill('.gate input.code-input', await who.totp());
  await p.click('Turn on two-step sign-in', '.gate');
  await p.waitFor('document.querySelectorAll(".codes li").length === 10', 'recovery codes');
  await p.evaluate('document.querySelector(".gate input[type=checkbox]").click(); true');
  await p.click('Continue', '.gate');
  await p.waitFor('!!document.querySelector(".rail") && !!window.kelbe?.sync', 'the app shell');
  await p.waitFor('kelbe.sync.status().state === "synced" && kelbe.sync.status().pulledOnce', 'first sync', 30000);
}

const pages = [];
let exitCode = 0;
const railHas = (p, id) => p.evaluate(`!!document.querySelector('.rail [data-mod="${id}"]')`);
const toggleSwitch = (p, id) => p.evaluate(`(() => { const i = document.querySelector('[data-switch="${id}"] input.switch'); if (!i) throw new Error('no switch ${id}'); i.click(); return i.checked; })()`);
const serverSettings = async () => (await superDb.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tg])).rows[0]?.data || null;
const PHOTO = process.env.E2E_PHOTO || join(WT, 'electrical-app', 'icons', 'icon-192.png');
const row = async (sql, args = []) => (await superDb.query(sql, args)).rows;
const mainText = (p) => p.evaluate('document.querySelector("main").innerText');
/** Pick an option of a <select> (the last one matching `sel`) by its visible label. */
const pickOption = (p, sel, label) => p.evaluate(`(() => {
  const s = [...document.querySelectorAll(${J(sel)})].at(-1); if (!s) throw new Error('no select ' + ${J(sel)});
  const o = [...s.options].find((x) => x.textContent.trim() === ${J(label)}); if (!o) throw new Error('no option ' + ${J(label)} + ': ' + [...s.options].map((x) => x.textContent).join('|'));
  s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
/** Click the button (last match in `within`) whose label starts with `prefix`; returns its label. */
const clickPrefix = (p, prefix, within = 'main') => p.evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${J(prefix)}) && !x.disabled); if (!b) throw new Error('no button starting ' + ${J(prefix)}); const t = b.textContent.trim(); b.click(); return t; })()`);
/** Tap a button that opens the camera or a file picker, and answer it with PHOTO. */
async function answerChooser(p, buttonText, within = 'main') {
  p.chooser.length = 0;
  await p.evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === ${J(buttonText)}); if (!b) throw new Error('no button ' + ${J(buttonText)}); b.click(); return true; })()`, { gesture: true });
  for (let i = 0; i < 50 && !p.chooser.length; i++) await sleep(100);
  if (!p.chooser.length) throw new Error('no file chooser opened');
  await p.send('DOM.setFileInputFiles', { files: [PHOTO], backendNodeId: p.chooser[0].backendNodeId });
}
try {
  // Pro, so the plan has purchasing whatever plans.js says about trials.
  await superDb.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [tg]);
  const own = await openPage('owner-ipad', { width: 1180, height: 820, mobile: false, touch: true });
  const sam = await openPage('sam-phone', { width: 390, height: 844, mobile: true });
  pages.push(own, sam);
  let poId = null, billId = null, billTotal = 0;

  await step('owner signs in and turns Purchasing on in Settings → Modules', async () => {
    await signInOwner(own, people.owner);
    if (await railHas(own, 'purchasing')) throw new Error('Purchasing is on before the switch (it is not in the recommended set)');
    await own.goto('/#/settings?section=modules');
    await own.waitFor('!!document.querySelector(\'[data-switch="purchasing"] input.switch\')', 'the Purchasing switch');
    await toggleSwitch(own, 'purchasing');
    await own.waitFor('!!document.querySelector(\'.rail [data-mod="purchasing"]\')', 'Purchasing in the rail');
    await synced(own);
    const s = await serverSettings();
    if (s?.modules?.purchasing !== true) throw new Error(`server modules: ${J(s?.modules)}`);
    await own.shot('p01-switch-on');
    return 'switch saved on the server; Purchasing in the rail';
  });

  await step('add a supplier', async () => {
    await own.goto('/#/purchasing/vendors');
    await own.waitFor('/No suppliers yet/.test(document.querySelector("main").innerText)', 'empty supplier list');
    await own.click('New supplier', 'main .page-head');
    await own.waitFor('!!document.querySelector("[role=dialog] input[name=name]")', 'supplier sheet');
    await own.fill('[role=dialog] input[name=name]', 'Nedco Winnipeg');
    await own.fill('[role=dialog] input[name=email]', 'orders@nedco.example');
    await own.fill('[role=dialog] input[name=accountNumber]', 'TG-4410');
    await own.fill('[role=dialog] input[name=terms]', 'Net 30');
    await own.click('Add supplier', '[role=dialog]');
    await own.waitFor('location.hash.startsWith("#/purchasing/vendors/") && /Nedco Winnipeg/.test(document.querySelector("main h1")?.textContent || "")', 'the supplier page');
    await synced(own);
    const v = await row("SELECT data FROM vendors WHERE tenant_id = $1 AND deleted_at IS NULL", [tg]);
    if (v.length !== 1 || v[0].data.accountNumber !== 'TG-4410' || v[0].data.active !== true) throw new Error(J(v));
    await own.shot('p02-supplier');
    return `${v[0].data.name}, terms ${v[0].data.terms}`;
  });

  await step('make a purchase order from two material requests: they become ordered', async () => {
    const jobId = await own.evaluate('kelbe.store.list("jobs").find((j) => j.number === "J-1001").id');
    const item = await own.evaluate('kelbe.store.list("items").find((i) => i.sku === "DEV-REC-15").id');
    await own.evaluate(`(() => {
      const s = kelbe.store, at = new Date().toISOString();
      s.add("materialRequests", { id: "mr-e2e-1", jobId: ${J(jobId)}, itemId: ${J(item)}, description: "Receptacle", qty: 40, unit: "ea", status: "sent", sentAt: at, employeeId: "emp-sam", urgent: false, note: "" });
      s.add("materialRequests", { id: "mr-e2e-2", jobId: ${J(jobId)}, description: "3/4 EMT", qty: 20, unit: "sticks", status: "sent", sentAt: at, employeeId: "emp-sam", urgent: false, note: "" });
      return true; })()`);
    await synced(own);
    await own.goto('/#/materials');
    await own.click('To order 2', 'main');
    await own.waitFor('document.querySelectorAll("main .mr-job .mr-row").length === 2', 'two requests to order');
    await own.click('Create purchase order', 'main');
    await own.waitFor('!!document.querySelector("[role=dialog] select[name=vendorAll]")', 'purchase order sheet');
    await pickOption(own, '[role=dialog] select[name=vendorAll]', 'Nedco Winnipeg');
    await own.shot('p03-po-sheet');
    await own.click('Create purchase order', '[role=dialog]');
    await own.waitFor('location.hash.startsWith("#/purchasing/orders/") && /PO-5001/.test(document.querySelector("main h1")?.textContent || "")', 'the new PO');
    poId = await own.evaluate('location.hash.split("/")[3].split("?")[0]');
    await synced(own);
    const po = (await row('SELECT data FROM purchase_orders WHERE tenant_id = $1 AND id = $2', [tg, poId]))[0]?.data;
    if (!po || po.status !== 'open' || po.lines.length !== 2 || po.jobId !== jobId) throw new Error(J(po));
    const covered = po.lines.flatMap((l) => l.materialRequestIds).sort();
    if (J(covered) !== J(['mr-e2e-1', 'mr-e2e-2'])) throw new Error(`covers ${J(covered)}`);
    if (po.lines.find((l) => l.itemId === item)?.unitCents !== 245) throw new Error('the receptacle line has no cost from the price book');
    const reqs = await row("SELECT data->>'status' AS s, data->>'orderedAt' AS at FROM material_requests WHERE tenant_id = $1 AND id IN ('mr-e2e-1', 'mr-e2e-2')", [tg]);
    if (reqs.length !== 2 || reqs.some((r) => r.s !== 'ordered' || !r.at)) throw new Error(`requests: ${J(reqs)}`);
    await own.click('Mark sent', 'main');
    await own.waitFor('/Sent/.test(document.querySelector("main aside")?.innerText || "")', 'sent');
    if (/\b(null|undefined|NaN)\b/.test(await mainText(own))) throw new Error('stray text on the PO page');
    await own.shot('p04-po');
    return `${po.number}: ${po.lines.map((l) => `${l.qty} ${l.unit} ${l.description}`).join('; ')}; requests ordered`;
  });

  await step('enter the supplier’s bill for the PO, with a photo; it must add up', async () => {
    await own.click('Enter bill', 'main aside');
    await own.waitFor('location.hash.startsWith("#/purchasing/bills/") && document.querySelectorAll("main .pu-line").length === 2', 'the bill from the PO');
    billId = await own.evaluate('location.hash.split("/")[3].split("?")[0]');
    await own.fill('main input[name=number]', 'INV-88213');
    // The lines are 40 x $2.45 + 20 sticks at $0 (the PO had no cost for them): type the EMT cost from the bill.
    await own.evaluate('(() => { const row = [...document.querySelectorAll("main .pu-line")].find((r) => /EMT/.test(r.querySelector("input[name=description]").value)); const i = row.querySelector("input[name=unitCents]"); i.value = "10.00"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    // Then the taxes for the bill's province, worked out on $298.00 (the bill's own printed figures win).
    const province = await own.evaluate('document.querySelector("main select[name=taxProvince]").value');
    await clickPrefix(own, 'Work out (');
    await own.waitFor('document.querySelectorAll("main .pu-tax-row").length >= 1', `the ${province} taxes`);
    const expectTax = await own.evaluate(`import("/js/lib/purchasing.js").then((m) => m.suggestTaxes(${J(province)}, document.querySelector("main input[name=date]").value, 29800))`);
    await own.fill('main input[name=totalCents]', '300.00');
    await own.waitFor('!!document.querySelector("main [data-mismatch]")', 'the doesn’t-add-up warning');
    const warn = await own.evaluate('document.querySelector("main [data-mismatch]").innerText');
    await own.shot('p05-bill-mismatch');
    // The lines come to $298.00 plus the province's taxes on them: use the computed total.
    const used = await clickPrefix(own, 'Use $');
    await own.waitFor('!document.querySelector("main [data-mismatch]")', 'the warning gone');
    await answerChooser(own, 'Take photo');
    await own.waitFor('!!document.querySelector("main .pu-receipt img")', 'the photo of the bill');
    await own.click('Enter bill', 'main aside');
    await own.waitFor('/To pay/.test(document.querySelector("main aside")?.innerText || "")', 'entered');
    const page = await mainText(own);
    if (/\b(null|undefined|NaN)\b/.test(page)) throw new Error(`stray text on the bill page: ${page.match(/.{0,40}\b(null|undefined|NaN)\b.{0,40}/)[0]}`);
    if (!/Bill INV-88213/.test(await own.evaluate('document.querySelector("main h1").textContent'))) throw new Error('the title did not follow the number');
    await synced(own);
    const b = (await row('SELECT data, vendor_id, purchase_order_id, status FROM bills WHERE tenant_id = $1 AND id = $2', [tg, billId]))[0];
    if (!b || b.status !== 'open' || b.purchase_order_id !== poId || !b.vendor_id) throw new Error(J({ ...b, data: undefined }));
    if (!/^data:image\/jpeg;base64,/.test(b.data.receipt?.dataUrl || '')) throw new Error('no JPEG receipt on the server');
    const linesCents = b.data.lines.reduce((t, l) => t + l.amountCents, 0);
    const taxCents = b.data.taxes.reduce((t, x) => t + x.cents, 0);
    if (linesCents !== 29800 || J(b.data.taxes.map((x) => [x.id, x.cents])) !== J(expectTax.map((x) => [x.id, x.cents])) || !taxCents || b.data.totalCents !== linesCents + taxCents
      || b.data.lines.some((l) => l.poLine?.purchaseOrderId !== poId)) throw new Error(J({ total: b.data.totalCents, taxes: b.data.taxes, lines: b.data.lines }));
    billTotal = b.data.totalCents;
    if (b.data.dueDate <= b.data.date) throw new Error('Net 30 should set the due date');
    await own.shot('p06-bill-entered');
    return `warning "${warn.split('\n')[0]}"; "${used}"; ${province} taxes ${b.data.taxes.map((x) => `${x.id} ${x.cents}`).join(' + ')}; bill ${b.data.number} $${b.data.totalCents / 100}, photo ${Math.round(b.data.receipt.dataUrl.length / 1024)} KB, due ${b.data.dueDate}`;
  });

  await step('a supplier refund is a receipt with negative amounts', async () => {
    await own.goto('/#/purchasing/bills/new?kind=receipt');
    await own.waitFor('location.hash.startsWith("#/purchasing/bills/") && !location.hash.includes("new") && !!document.querySelector("main select[name=kind]")', 'a new receipt');
    const id = await own.evaluate('location.hash.split("/")[3].split("?")[0]');
    await pickOption(own, 'main select[name=vendorId]', 'Nedco Winnipeg');
    await own.click('Add line', 'main');
    await own.fill('main .pu-line input[name=description]', 'Returned breakers');
    await own.fill('main .pu-line input[name=unitCents]', '15.00');
    await own.fill('main .pu-line input[name=qty]', '2');
    await own.evaluate('document.querySelector("main input[name=refund]").click(); true');
    await own.click('Save receipt', 'main aside');
    await own.waitFor('/Paid/.test(document.querySelector("main aside")?.innerText || "")', 'saved');
    await synced(own);
    const r = (await row('SELECT data FROM bills WHERE tenant_id = $1 AND id = $2', [tg, id]))[0]?.data;
    if (!r || r.kind !== 'receipt' || r.status !== 'paid' || r.lines[0].amountCents !== -3000 || r.lines[0].unitCents !== -1500) throw new Error(J(r));
    await own.goto('/#/purchasing');
    await own.waitFor('/Refund/.test(document.querySelector("main table")?.innerText || "")', 'the refund in the list');
    const list = await mainText(own);
    const toPay = `$${Math.round(billTotal / 100).toLocaleString('en-CA')}`;
    // Stat labels are upper-cased by CSS, which innerText reports.
    if (!list.replace(/\s+/g, ' ').toLowerCase().includes(`to pay ${toPay}`)) throw new Error(`summary (want ${toPay}): ${list.slice(0, 200)}`);
    await own.shot('p07-list');
    return `refund stored as -$30.00; the list shows ${toPay} to pay`;
  });

  await step('a status that changes while the bill is open is not written back', async () => {
    // A QuickBooks pull marks the bill paid on the server while the office has it open; the device
    // takes it, then the notes are typed into. The editor must send only the notes, never its old
    // 'open' status (a whole-record save would put 'open' back over the pulled 'paid').
    await own.goto(`/#/purchasing/bills/${billId}`);
    await own.waitFor('!!document.querySelector("main textarea[name=notes]")', 'the bill');
    await asQbo((tx, pr, who) => records.patchRecord(tx, pr, 'bills', billId, { status: 'paid' }, {}, who));
    await synced(own);
    await own.waitFor('/Paid/.test(document.querySelector("main aside")?.innerText || "")', 'the pulled status on screen');
    await own.fill('main textarea[name=notes]', 'Paid by cheque 1043');
    await sleep(700);
    const local = await own.evaluate(`(() => { const s = kelbe.store; return { status: s.get("bills", ${J(billId)}).status, fields: s.queue.filter((e) => e.id === ${J(billId)}).map((e) => e.fields) }; })()`);
    if (local.status !== 'paid' || !local.fields.length || local.fields.some((f) => !f || f.includes('status'))) throw new Error(J(local));
    await synced(own);
    const b = (await row('SELECT data, status FROM bills WHERE tenant_id = $1 AND id = $2', [tg, billId]))[0];
    if (b.data.notes !== 'Paid by cheque 1043' || b.status !== 'paid') throw new Error(J({ notes: b.data.notes, status: b.status }));
    // Back to open on both sides for the steps after.
    await asQbo((tx, pr, who) => records.patchRecord(tx, pr, 'bills', billId, { status: 'open' }, {}, who));
    await synced(own);
    return `only ${J(local.fields)} went to the server; the pulled ${b.status} stayed`;
  });

  await step('the electrician sees no purchasing at all', async () => {
    await signIn(sam, people.sam);
    if (await railHas(sam, 'purchasing')) throw new Error('Purchasing in the crew rail');
    await sam.goto('/#/purchasing');
    await sam.waitFor('/No access/.test(document.querySelector("main")?.innerText || "")', 'No access');
    const counts = await sam.evaluate('({ v: kelbe.store.count("vendors"), b: kelbe.store.count("bills"), p: kelbe.store.count("purchaseOrders") })');
    if (counts.v || counts.b || counts.p) throw new Error(`on the phone: ${J(counts)}`);
    await sam.goto('/#/materials');
    await sam.waitFor('!!document.querySelector("main input[name=what]")', 'material requests');
    if (/PO-5001|\$\d/.test(await mainText(sam))) throw new Error('a PO number or a price is on the crew screen');
    await sam.shot('p08-crew');
    return 'no rail button, No access, nothing synced to the phone';
  });
} catch {
  exitCode = 1;
} finally {
  const all = [];
  for (const p of pages) {
    const errs = p.consoleLines.filter((l) => /^\[(error|exception|assert)\]/.test(l)
      || (/^\[log:error\]/.test(l) && !/api\/v1\/(me|auth\/providers)/.test(l) && !/Failed to load resource.*403/.test(l)));
    all.push(...errs.map((l) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'purchasing-e2e-results.json'), J({ results, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`browser console errors: ${all.length}`);
  for (const e of all.slice(0, 20)) console.log('   ', e.slice(0, 300));
  if (all.length) exitCode = 1;
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
