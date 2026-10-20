// Module switches, billing modes and material requests, end to end: embedded Postgres 17 + the
// API (in-process, so it can be stopped for the offline step) + a static server that proxies
// /api/ like nginx + headless Chrome over CDP, two people in separate browser contexts:
//   owner on an iPad (1180 x 820): turns Stock, the price book and Invoices off (they vanish from
//     the rail, the wheel, the dashboard, a job's tabs and buttons, and their routes) and back on;
//     a time & material job builds an invoice from approved time and material used; a fixed job
//     shows estimate vs actual; receives the crew's material list in the bell and on the page.
//   electrician on a phone (390 x 844): files 3 material requests offline (one from the price
//     book), they sync when the API is back, and "Send now" delivers one combined list.
//
//   cd server && npm ci
//   node electrical-app/tests/e2e/modules.e2e.mjs [scratch dir]
// CHROME_PATH overrides the Chrome binary. Not part of `node --test electrical-app/tests/*.test.mjs`.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-wp-e2e-'));
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
const wheelLabels = (p) => p.evaluate('[...document.querySelectorAll(".wheel .wheel-item")].map((b) => b.textContent.trim())');
const toggleSwitch = (p, id) => p.evaluate(`(() => { const i = document.querySelector('[data-switch="${id}"] input.switch'); if (!i) throw new Error('no switch ${id}'); i.click(); return i.checked; })()`);
const serverSettings = async () => (await superDb.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tg])).rows[0]?.data || null;
try {
  const own = await openPage('owner-ipad', { width: 1180, height: 820, mobile: false, touch: true });
  const sam = await openPage('sam-phone', { width: 390, height: 844, mobile: true });
  pages.push(own, sam);
  let tmJobId = null, fixedJobId = null;

  await step('owner signs in on the iPad (two-step sign-in set up)', async () => {
    await signInOwner(own, people.owner);
    return `plan ${await own.evaluate('kelbe.session.me.entitlements.plan')}, ${await own.evaluate('document.querySelectorAll(".rail .rail-btn[data-mod]").length')} rail buttons`;
  });

  await step('a new company starts with the recommended set; Everything turns the rest on', async () => {
    const core = await own.evaluate('({ inv: !!document.querySelector(\'.rail [data-mod="inventory"]\'), leads: !!document.querySelector(\'.rail [data-mod="leads"]\'), invoices: !!document.querySelector(\'.rail [data-mod="invoices"]\') })');
    if (core.leads || !core.invoices || !core.inv) throw new Error(`core set wrong: ${J(core)}`);
    await own.goto('/#/settings?section=modules');
    await own.waitFor('!!document.querySelector("#modules .mod-preset")', 'modules card');
    await own.shot('m01-modules-core');
    await own.evaluate('kelbe.store.saveSettings({ materialRequests: { sendAt: "15:00", emailTo: "orders@tgelectrical.test" } }); true');
    await own.evaluate('document.querySelector(\'.mod-preset[data-preset="all"]\').click(); true');
    await own.waitFor('!!document.querySelector(\'.rail [data-mod="leads"]\')', 'leads in the rail');
    await synced(own);
    const s = await serverSettings();
    if (!s?.modules || Object.values(s.modules).some((v) => v !== true)) throw new Error(`server modules: ${J(s?.modules)}`);
    return `core hid leads; Everything saved ${Object.keys(s.modules).length} switches on the server`;
  });

  await step('turn Stock, Price book and Invoices off: they vanish everywhere', async () => {
    await own.goto('/#/settings?section=modules');
    await own.waitFor('!!document.querySelector(\'[data-switch="invoices"] input.switch\')', 'switches');
    for (const id of ['inventory', 'pricebook', 'invoices']) {
      await toggleSwitch(own, id);
      await own.waitFor(`!document.querySelector('[data-switch="${id}"] input.switch')?.checked`, `${id} off`);
    }
    await own.shot('m02-switches-off');
    const rail = { inventory: await railHas(own, 'inventory'), invoices: await railHas(own, 'invoices'), estimates: await railHas(own, 'estimates') };
    if (rail.inventory || rail.invoices || !rail.estimates) throw new Error(`rail: ${J(rail)}`);
    const wheel = await wheelLabels(own);
    if (wheel.includes('Invoice')) throw new Error(`wheel: ${wheel}`);
    await own.goto('/#/dashboard');
    await own.waitFor('!!document.querySelector("main h1")', 'dashboard');
    const dash = await own.text();
    if (/Owed to you|Unbilled T&M|Low stock/.test(dash)) throw new Error('dashboard still shows invoices or stock');
    const links = await own.evaluate('[...document.querySelectorAll("main a[href]")].map((a) => a.getAttribute("href")).filter((h) => /^#\\/(invoices|inventory)/.test(h))');
    if (links.length) throw new Error(`links left: ${links}`);
    // a job: no invoice tab content, no New invoice button
    const jobId = await own.evaluate('kelbe.store.list("jobs").find((j) => j.number === "J-1001").id');
    await own.goto(`/#/jobs/${jobId}?tab=money`);
    await own.waitFor('!!document.querySelector(".ops-tabs-row")', 'job page');
    const job = await own.evaluate('({ tabs: [...document.querySelectorAll(".ops-tabs-row [role=tab]")].map((t) => t.textContent), body: document.querySelector("main").innerText })');
    if (job.tabs.some((t) => /invoice/i.test(t)) || /New invoice|Build invoice/.test(job.body)) throw new Error(`job page: ${J(job.tabs)}`);
    await own.shot('m03-job-no-invoices');
    // the routes themselves
    await own.goto('/#/invoices');
    await own.waitFor('/is turned off/.test(document.querySelector("main").innerText)', 'turned-off page');
    // the bell: nothing that links into invoices or stock
    const bell = await own.evaluate('import("/js/modules/notifications.js").then((m) => m.items().filter((i) => /^#\\/(invoices|inventory)/.test(i.link || "")).length)');
    if (bell) throw new Error(`${bell} bell items still link to turned-off modules`);
    // the server refuses writes into invoices, keeps reads
    await synced(own);
    const s = await serverSettings();
    if (s.modules.invoices !== false || s.modules.inventory !== false) throw new Error(J(s.modules));
    const w = await own.evaluate(`kelbe.store.add("invoices", { number: "INV-X", jobId: ${J(jobId)}, status: "draft", lines: [] }).id`);
    await own.evaluate('kelbe.sync.syncNow().then(() => true)');
    await own.waitFor('kelbe.sync.status().rejected >= 1', 'the server rejects the invoice');
    const rejected = await own.evaluate('JSON.stringify(kelbe.store.queue.filter((q) => q.state === "rejected").map((q) => q.error?.code || q.error))');
    if (!rejected.includes('module_turned_off')) throw new Error(`rejected: ${rejected}`);
    await own.evaluate(`(() => { for (const q of kelbe.store.queue.filter((q) => q.state === "rejected")) kelbe.store.dropQueue(q.mid); kelbe.store.applyRemote("invoices", ${J(w)}, null, null); return true; })()`);
    const count = (await superDb.query('SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1', [tg])).rows[0].n;
    return `rail, wheel, dashboard, job tabs, routes and bell clear; server refused the write (module_turned_off); ${count} invoices kept`;
  });

  await step('turn them back on: they come back', async () => {
    await own.goto('/#/settings?section=modules');
    await own.waitFor('!!document.querySelector(\'[data-switch="invoices"] input.switch\')', 'switches');
    for (const id of ['inventory', 'pricebook', 'invoices']) {
      await toggleSwitch(own, id);
      await own.waitFor(`document.querySelector('[data-switch="${id}"] input.switch')?.checked`, `${id} on`);
    }
    if (!(await railHas(own, 'inventory')) || !(await railHas(own, 'invoices'))) throw new Error('rail did not come back');
    if (!(await wheelLabels(own)).includes('Invoice')) throw new Error('wheel did not come back');
    await own.goto('/#/invoices');
    await own.waitFor('document.querySelector("main h1")?.textContent === "Invoices"', 'invoices list');
    await synced(own);
    return `back: ${(await own.evaluate('document.querySelectorAll("main tbody tr").length'))} invoices listed`;
  });

  await step('a time & material job builds an invoice from approved time and material used', async () => {
    await own.goto('/#/jobs?new=1');
    await own.waitFor('!!document.querySelector("[role=dialog] input[name=billingModeChoice]")', 'new job sheet');
    await own.fill('[role=dialog] input[name=title]', 'E2E service call (T&M)');
    await own.evaluate('document.querySelector(\'[role=dialog] input[name=billingModeChoice][value="tm"]\').click(); true');
    await own.evaluate('(() => { const l = [...document.querySelectorAll("[role=dialog] .ops-chip-check")].find((x) => x.textContent.includes("Sam Sparks")); l.querySelector("input").click(); return true; })()');
    await own.shot('m04-new-tm-job');
    await own.click('Create job', '[role=dialog]');
    await own.waitFor('location.hash.startsWith("#/jobs/") && !!document.querySelector("[data-tm]")', 'T&M job page');
    tmJobId = await own.evaluate('location.hash.split("/")[2].split("?")[0]');
    if ((await own.evaluate(`kelbe.store.get("jobs", ${J(tmJobId)}).billingMode`)) !== 'tm') throw new Error('not saved as T&M');
    // A day's work: 6 h approved, 1 h travel, 2 h not approved yet; 10 receptacles from the van.
    const d = await own.evaluate('(() => { const x = new Date(); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); })()');
    await own.evaluate(`(() => {
      const s = kelbe.store, job = ${J(tmJobId)}, at = (h) => new Date(${J(d)} + "T" + String(h).padStart(2, "0") + ":00:00").toISOString();
      s.add("timeEntries", { employeeId: "emp-sam", jobId: job, clockIn: at(8), clockOut: at(14), breakMins: 0, approved: true, note: "" });
      s.add("timeEntries", { employeeId: "emp-sam", jobId: job, clockIn: at(7), clockOut: at(8), breakMins: 0, approved: true, travel: true, note: "" });
      s.add("timeEntries", { employeeId: "emp-sam", jobId: job, clockIn: at(14), clockOut: at(16), breakMins: 0, approved: false, note: "" });
      const van = s.add("locations", { name: "Van 2", kind: "van" });
      const item = s.list("items").find((i) => i.sku === "DEV-REC-15");
      s.update("items", item.id, { stock: { [van.id]: 30 } });
      s.add("stockMoves", { itemId: item.id, fromLocationId: van.id, toLocationId: null, qty: 10, jobId: job, date: ${J(d)}, note: "" });
      return true; })()`);
    await own.waitFor('Number(document.querySelector("[data-unbilled]")?.dataset.unbilled) > 0', 'unbilled T&M shown');
    const card = await own.evaluate('document.querySelector("[data-tm]").innerText');
    await own.shot('m05-tm-unbilled');
    await own.click('Build invoice from time & material', 'main');
    await own.waitFor('!!document.querySelector("[role=dialog] input[name=from]")', 'build sheet');
    await own.fill('[role=dialog] input[name=from]', d);
    await own.waitFor('document.querySelectorAll("[role=dialog] tbody tr").length === 3', 'invoice preview: labour, travel, material');
    await own.shot('m06-tm-preview');
    await own.click('Create invoice', '[role=dialog]');
    await own.waitFor('location.hash.startsWith("#/invoices/") && !!document.querySelector("[data-tm-invoice]")', 'the new invoice');
    const invId = await own.evaluate('location.hash.split("/")[2]');
    const inv = await own.evaluate(`kelbe.store.get("invoices", ${J(invId)})`);
    const labour = inv.lines.filter((l) => l.kind === 'labour');
    const mats = inv.lines.filter((l) => l.kind === 'material');
    if (labour.length !== 2 || labour[0].qty !== 6 || labour[1].qty !== 1 || !/^Travel/.test(labour[1].description)) throw new Error(`labour: ${J(labour)}`);
    if (mats.length !== 1 || mats[0].qty !== 10 || mats[0].unitCents !== Math.round(245 * 1.2)) throw new Error(`material: ${J(mats)}`);
    if (!inv.taxes?.length || inv.tm?.timeEntryIds?.length !== 2 || inv.tm?.stockMoveIds?.length !== 1) throw new Error(`tm: ${J({ taxes: inv.taxes, tm: inv.tm })}`);
    await own.shot('m07-tm-invoice');
    await synced(own);
    const srv = (await superDb.query('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, invId])).rows[0]?.data;
    if (!srv || srv.billingMode !== 'tm') throw new Error('invoice not on the server');
    // Billed once: the job now has nothing unbilled but the entry waiting for approval.
    await own.goto(`/#/jobs/${tmJobId}`);
    await own.waitFor('document.querySelector("[data-unbilled]")?.dataset.unbilled === "0"', 'nothing left to bill');
    return `${card.split('\n').slice(0, 2).join(' | ')} → ${inv.number}: ${inv.lines.map((l) => `${l.description} x${l.qty}`).join('; ')}; taxes ${inv.taxes.map((t) => `${t.label} ${t.pct}%`).join(' + ')}`;
  });

  await step('a fixed-price job shows estimate vs actual, and offers no T&M billing', async () => {
    await own.goto('/#/jobs?new=1');
    await own.waitFor('!!document.querySelector("[role=dialog] input[name=billingModeChoice]")', 'new job sheet');
    await own.fill('[role=dialog] input[name=title]', 'E2E basement rewire (fixed)');
    await own.evaluate('document.querySelector(\'[role=dialog] input[name=billingModeChoice][value="fixed"]\').click(); true');
    await own.click('Create job', '[role=dialog]');
    await own.waitFor('location.hash.startsWith("#/jobs/") && !!document.querySelector("[data-eva]")', 'fixed job page');
    fixedJobId = await own.evaluate('location.hash.split("/")[2].split("?")[0]');
    await own.evaluate(`(() => {
      const s = kelbe.store, job = ${J(fixedJobId)};
      const item = s.list("items").find((i) => i.sku === "DEV-REC-15");
      s.add("estimates", { number: "E-E2E", jobId: job, status: "accepted", title: "Basement", markupPct: 0, taxes: [], lines: [
        { itemId: item.id, description: item.name, qty: 20, unitCents: 1200, labourHours: 0.5, kind: "material" },
        { itemId: null, description: "Labour", qty: 4, unitCents: 9500, labourHours: 0, kind: "labour" } ] });
      const at = (h) => { const x = new Date(); x.setDate(x.getDate() - 1); x.setHours(h, 0, 0, 0); return x.toISOString(); };
      s.add("timeEntries", { employeeId: "emp-sam", jobId: job, clockIn: at(8), clockOut: at(17), breakMins: 0, approved: true, note: "" });
      return true; })()`);
    await own.waitFor('!!document.querySelector("[data-eva] [data-margin]") && /14\\.0 h/.test(document.querySelector("[data-eva]").innerText)', 'estimate vs actual');
    const eva = await own.evaluate('document.querySelector("[data-eva]").innerText');
    if (/Build invoice/.test(await own.evaluate('document.querySelector("main").innerText'))) throw new Error('a fixed job offers T&M billing');
    await own.shot('m08-fixed-eva');
    return eva.replace(/\s+/g, ' ');
  });

  await step('the electrician files 3 material requests on the phone while offline', async () => {
    await sam.goto('/');
    await sam.waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
    await sam.evaluate('localStorage.setItem("ft.units", "metric"); true');
    await sam.fill('input[name=email]', people.sam.email);
    await sam.fill('input[name=password]', people.sam.password);
    await sam.click('Sign in', '.gate');
    await sam.waitFor('!!document.querySelector(".rail") && !!window.kelbe?.sync', 'the app shell');
    await sam.waitFor('kelbe.sync.status().state === "synced" && kelbe.sync.status().pulledOnce', 'first sync', 30000);
    // The wheel offers it to the crew.
    if (!(await wheelLabels(sam)).includes('Material')) throw new Error('no Material on the wheel');
    await sam.goto('/#/materials?new=1');
    await sam.waitFor('!!document.querySelector("main input[name=what]")', 'request form');
    await apiDown();
    sam.offlineFrom = sam.consoleLines.length;
    const add = async (what, qty, unit, { pick = false, urgent = false } = {}) => {
      await sam.fill('main input[name=what]', what);
      if (pick) {
        await sam.waitFor('!!document.querySelector("main .mr-pick")', 'price-book suggestion');
        await sam.evaluate('document.querySelector("main .mr-pick").click(); true');
      }
      await sam.fill('main input[name=qty]', qty);
      if (unit) await sam.fill('main input[name=unit]', unit);
      await sam.fill(`main select[name=jobId]`, tmJobId);
      if (urgent) await sam.evaluate('document.querySelector("main input[name=urgent]").click(); true');
      await sam.click('Add request', 'main');
      await sleep(150);
    };
    await add('receptacle', '50', '', { pick: true });
    await add('3/4 EMT', '20', 'sticks', { urgent: true });
    await add('PVC 1in', '3', 'lengths');
    await sam.shot('m09-requests-offline');
    const n = await sam.evaluate('kelbe.store.count("materialRequests", (r) => r.status === "requested")');
    const waiting = await sam.evaluate('kelbe.sync.syncNow().catch(() => null).then(() => kelbe.sync.status().waiting)');
    if (n !== 3 || waiting < 3) throw new Error(`requests ${n}, waiting ${waiting}`);
    const priced = await sam.evaluate('document.querySelector("main").innerText');
    if (/\$\d/.test(priced)) throw new Error('a price is on the crew screen');
    return `3 requests on the phone, ${waiting} changes waiting to sync, no prices shown`;
  });

  await step('back online they sync, and Send now delivers one combined list to the office', async () => {
    await apiUp();
    sam.offlineTo = sam.consoleLines.length;
    await synced(sam);
    const rows = (await superDb.query("SELECT data FROM material_requests WHERE tenant_id = $1 AND data->>'employeeId' = 'emp-sam'", [tg])).rows.map((r) => r.data);
    if (rows.length !== 3 || rows.some((r) => r.costCents !== undefined)) throw new Error(`server rows: ${J(rows)}`);
    await sam.goto('/#/materials');
    await sam.waitFor('/3 waiting to go to the office/.test(document.querySelector("main").innerText)', 'waiting count');
    await sam.click('Send now (urgent)', 'main');
    await sam.waitFor('/Sent 3 requests for 1 job/.test(document.querySelector(".toasts")?.innerText || "")', 'sent toast');
    await sam.shot('m10-sent');
    const sent = (await superDb.query("SELECT data->>'status' AS s, data->>'batchId' AS b FROM material_requests WHERE tenant_id = $1 AND data->>'employeeId' = 'emp-sam'", [tg])).rows;
    if (sent.some((r) => r.s !== 'sent') || new Set(sent.map((r) => r.b)).size !== 1) throw new Error(J(sent));
    const mail = (await superDb.query("SELECT subject, text_body FROM email_outbox WHERE tenant_id = $1 AND template = 'material-requests'", [tg])).rows;
    // The office's bell (owner) and the page, grouped by job.
    await own.evaluate('import("/js/modules/notifications.js").then((m) => m.refresh()).then(() => true)');
    const bell = await own.evaluate('import("/js/modules/notifications.js").then((m) => m.items().filter((i) => i.kind === "materials").map((i) => i.title))');
    if (bell.length !== 1 || !/3 material requests for 1 job \(1 urgent\)/.test(bell[0])) throw new Error(`bell: ${J(bell)}`);
    await synced(own);
    await own.goto('/#/materials');
    await own.click('To order 3', 'main');
    await own.waitFor('document.querySelectorAll("main .mr-job .mr-row").length === 3', 'the list on the office page');
    const page = await own.evaluate('document.querySelector("main .mr-job").innerText');
    if (!/E2E service call/.test(page) || !/You have 30 in Van 2/.test(page)) throw new Error(page);
    await own.shot('m11-office-list');
    return `bell: "${bell[0]}"; ${mail.length ? `email "${mail[0].subject}"` : 'no email address set, bell and page only'}; page shows stock hint`;
  });
} catch {
  exitCode = 1;
} finally {
  const all = [];
  for (const p of pages) {
    const lines = p.consoleLines.map((l, i) => ({ l, i }));
    // Network failures while the API was deliberately down are expected; anything else counts.
    const errs = lines.filter(({ l, i }) => /^\[(error|exception|assert)\]/.test(l)
      || (/^\[log:error\]/.test(l) && !(p.offlineFrom != null && i >= p.offlineFrom && i <= (p.offlineTo ?? Infinity) && /Failed to load resource|ERR_/.test(l))
        && !/api\/v1\/(me|auth\/providers)/.test(l) && !(/Failed to load resource.*403/.test(l))));
    all.push(...errs.map(({ l }) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'modules-e2e-results.json'), J({ results, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
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
