// Collaborative drawings, end to end: embedded Postgres 17 + the API (in-process, so it can be
// stopped for the offline step) + a static server that proxies /api/ like nginx + headless
// Chrome over CDP, with two people in separate browser contexts:
//   office (Olive) on an iPad (1180 x 820): opens the customer's drawing set from the job (one set
//     per customer), places what was quoted, deletes a junction box while offline, reads the
//     history ("Jackson added 4 duplex receptacles ..."), taps it to zoom, shows who drew what,
//     reads the cost impact against the estimate and creates a change order in one tap.
//   crew (Jackson, electrician) on a phone (390 x 844): opens the same set from the job, adds 4
//     receptacles while offline; both devices' edits survive the sync. Jackson never sees a
//     price: not on the job, the takeoff, the symbols, the Changes panel or in what syncs down.
// Both consoles stay clean.
//
//   cd server && npm ci
//   node electrical-app/tests/e2e/drawings-collab.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-dw-e2e-'));
mkdirSync(SCRATCH, { recursive: true });
const SERVER = join(WT, 'server');
const APPDIR = join(WT, 'electrical-app');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const mod = (p) => import(pathToFileURL(join(SERVER, p)).href);
const ESM = { 'embedded-postgres': 'dist/index.js', pg: 'esm/index.mjs' };
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

// TG Electrical: an office person and an electrician sign in. The seeded job J-1001 gets an
// accepted estimate (2 receptacles, 1 junction box) and the price book a junction box.
const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;
const ins = (table, id, data) => superDb.query(`INSERT INTO ${table} (tenant_id, id, data, created_by, updated_by) VALUES ($1, $2, $3, 'system:e2e', 'system:e2e')`, [tg, id, data]);
await ins('employees', 'emp-olive', { name: 'Olive Office', role: 'office', active: true, color: '#1f5fb8', email: '', phone: '', rateCents: 3800 });
await ins('employees', 'emp-jackson', { name: 'Jackson Reid', role: 'electrician', active: true, color: '#c25e00', email: '', phone: '', rateCents: 4400 });
const recItem = (await superDb.query("SELECT id, data FROM items WHERE tenant_id = $1 AND data->>'symbol' = 'receptacle'", [tg])).rows[0];
await ins('items', 'item-jb', { sku: 'BOX-JB-4', name: 'Junction box 4" square, installed', category: 'Boxes', unit: 'ea', costCents: 310, priceCents: 900, labourHours: 0.3, reorderPoint: 10, stock: {}, symbol: 'junction' });
const job = (await superDb.query("SELECT id, data FROM jobs WHERE tenant_id = $1 AND data->>'number' = 'J-1001'", [tg])).rows[0];
const client = (await superDb.query('SELECT id, data FROM clients WHERE tenant_id = $1 AND id = $2', [tg, job.data.clientId])).rows[0];
await ins('estimates', 'est-e2e', {
  number: 'E-2009', clientId: client.id, jobId: job.id, title: 'Operatory buildout', status: 'accepted', labourRateCents: 9500, markupPct: 10, taxPct: 5,
  lines: [
    { itemId: recItem.id, description: recItem.data.name, qty: 2, unitCents: recItem.data.priceCents, labourHours: recItem.data.labourHours, kind: 'material' },
    { itemId: 'item-jb', description: 'Junction box 4" square, installed', qty: 1, unitCents: 900, labourHours: 0.3, kind: 'material' },
  ],
  notes: '', validUntil: '2026-12-31', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
await superDb.query("UPDATE jobs SET data = jsonb_set(data, '{estimateId}', '\"est-e2e\"') WHERE tenant_id = $1 AND id = $2", [tg, job.id]);
// the company's real rates live on the server; crew devices must never receive them
if (!(await superDb.query("SELECT 1 FROM settings WHERE tenant_id = $1 AND id = 'settings'", [tg])).rows[0]) {
  await ins('settings', 'settings', { company: { name: 'TG Electrical', province: 'AB', phone: '', email: '', address: '', licenceNo: '' }, codeBook: 'CEC-2024', tax: { mode: 'province', treatment: null, custom: [] },
    taxPct: 5, labourRateCents: 11000, markupPct: 15, units: 'metric', currency: 'CAD', nextNumbers: { job: 1003, estimate: 2010, invoice: 3001 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}
const people = {};
for (const [key, role, emp, name] of [['olive', 'office', 'emp-olive', 'Olive Office'], ['jackson', 'electrician', 'emp-jackson', 'Jackson Reid']]) {
  const email = `${key}@tgelectrical.test`;
  const password = `pw-${randomBytes(10).toString('hex')}`;
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING id', [email, name, await hashSecret(password)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [tg, u.rows[0].id, role, emp]);
  people[key] = { email, password, emp };
}
log(`seeded TG Electrical: ${job.data.number} for ${client.data.name}, estimate E-2009, office + electrician`);

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

const serverDrawing = async (id) => { const r = (await superDb.query('SELECT id, data, version FROM drawings WHERE tenant_id = $1 AND id = $2', [tg, id])).rows[0]; return r ? { ...r.data, id: r.id, version: r.version } : null; };
const serverJob = async () => (await superDb.query('SELECT data FROM jobs WHERE tenant_id = $1 AND id = $2', [tg, job.id])).rows[0].data;

/** Screen point of a world point on the open canvas. */
const screenOf = (p, wx, wy) => p.evaluate(`(() => { const r = document.querySelector('.cv-canvas').getBoundingClientRect(); const v = kelbeCanvas.st.view; return { x: r.left + ${wx} * v.zoom + v.x, y: r.top + ${wy} * v.zoom + v.y }; })()`);
/** World point at a fraction of the visible canvas (so taps land on screen whatever the zoom). */
const worldAt = (p, fx, fy) => p.evaluate(`(() => { const r = document.querySelector('.cv-canvas').getBoundingClientRect(); const v = kelbeCanvas.st.view; return [(r.width * ${fx} - v.x) / v.zoom, (r.height * ${fy} - v.y) / v.zoom]; })()`);
async function tap(p, x, y) {
  if (p.touchInput) { await p.touch('touchStart', x, y); await sleep(30); await p.touch('touchEnd', x, y); }
  else { await p.mouse('mouseMoved', x, y); await p.mouse('mousePressed', x, y); await p.mouse('mouseReleased', x, y); }
  await sleep(60);
}
/** Place symbols with the Symbols sheet and taps on the plan, like a person would. */
async function placeSymbols(p, symbol, fracs) {
  await p.click('Place a symbol');
  await p.waitFor(`!!document.querySelector('.cv-symbol[data-symbol="${symbol}"]')`, 'symbols sheet');
  await p.evaluate(`document.querySelector('.cv-symbol[data-symbol="${symbol}"]').click(); true`);
  await p.waitFor('kelbeCanvas.st.placing === ' + J(symbol) + ' && !document.querySelector(".sheet")', 'placing mode');
  const before = await p.evaluate('kelbeCanvas.d.objects.length');
  for (const [fx, fy] of fracs) {
    const [wx, wy] = await worldAt(p, fx, fy);
    const s = await screenOf(p, wx, wy);
    await tap(p, s.x, s.y);
  }
  await p.waitFor(`kelbeCanvas.d.objects.length === ${before + fracs.length}`, `${fracs.length} ${symbol} placed`);
  await p.click('Done', '.cv-ctx');
  await p.evaluate('kelbeCanvas.save(); true');
}
const noMoney = (text) => !/\$\s?\d|CA\$|\d+\.\d\d\s?\$/.test(text);

const pages = [];
let exitCode = 0;
try {
  const olive = await openPage('office-ipad', { width: 1180, height: 820, mobile: false, touch: true });
  const jack = await openPage('crew-phone', { width: 390, height: 844, mobile: true });
  jack.touchInput = true;
  pages.push(olive, jack);
  let drawingId = null;
  let junctionId = null;

  await step('office signs in on the iPad and opens the customer\'s drawings from the job', async () => {
    await signIn(olive, people.olive);
    await olive.evaluate(`location.hash = "#/jobs/${job.id}?tab=drawings"`);
    await olive.waitFor('!!document.querySelector(\'a[href^="#/drawings/customer"]\')', 'Open drawings button');
    const label = await olive.evaluate('document.querySelector(\'a[href^="#/drawings/customer"]\').textContent.trim()');
    await olive.evaluate('document.querySelector(\'a[href^="#/drawings/customer"]\').click(); true');
    await olive.waitFor('!!window.kelbeCanvas && /^#\\/drawings\\/[^/?]+$/.test(location.hash) && !location.hash.includes("customer")', 'the editor');
    drawingId = await olive.evaluate('location.hash.split("/")[2]');
    const d = await olive.evaluate('({ ps: kelbeCanvas.d.planSet, clientId: kelbeCanvas.d.clientId, jobId: kelbeCanvas.d.jobId, name: kelbeCanvas.d.name })');
    if (!d.ps?.customer || d.clientId !== client.id || d.jobId !== job.id) throw new Error(J(d));
    return `"${label}" made ${d.name} (set ${d.ps.id}, ${d.ps.label})`;
  });

  await step('office places what was quoted: 2 receptacles and a junction box (no cost impact yet)', async () => {
    await placeSymbols(olive, 'receptacle', [[0.35, 0.45], [0.45, 0.45]]);
    await placeSymbols(olive, 'junction', [[0.55, 0.45]]);
    junctionId = await olive.evaluate('kelbeCanvas.d.objects.find((o) => o.symbol === "junction").id');
    const stamped = await olive.evaluate('kelbeCanvas.d.objects.map((o) => o.by?.name + "@" + (o.at ? "t" : "-"))');
    if (!stamped.every((x) => x === 'Olive Office@t')) throw new Error(J(stamped));
    // As if placed in an earlier session (an hour ago): a delete in the same session would just
    // cancel the add, which is right for a slip but not the story this test tells.
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    await olive.evaluate(`(() => { const c = kelbeCanvas; c.d.history = c.d.history.map((e) => ({ ...e, at: ${J(hourAgo)}, until: ${J(hourAgo)} })); c.save(); return true; })()`);
    await synced(olive);
    const s = await serverDrawing(drawingId);
    if (s?.objects?.length !== 3 || !s.history?.length) throw new Error('server: ' + J({ n: s?.objects?.length, h: s?.history }));
    await olive.click('Changes and who drew what');
    await olive.waitFor('!!document.querySelector(".cv-changes:not([hidden])")', 'changes panel');
    await olive.click('Cost impact', '.cv-changes');
    await olive.waitFor('document.querySelector(".cv-changes-body").innerText.includes("match the estimate")', 'no difference yet');
    await olive.click('Close changes');
    return `stamped ${stamped.length} items as Olive; server v${s.version} has ${s.objects.length} objects and ${s.history.length} history entry`;
  });

  await step('the electrician signs in on the phone; the job shows no money and opens the same set', async () => {
    await signIn(jack, people.jackson);
    await jack.evaluate(`location.hash = "#/jobs/${job.id}"`);
    await jack.waitFor('document.querySelector("main h1")?.textContent.includes("J-1001")', 'job page');
    const overview = await jack.text();
    if (!noMoney(overview)) throw new Error('money on the crew job page: ' + overview.slice(0, 400));
    const tabs = await jack.evaluate('[...document.querySelectorAll("main [role=tab]")].map((t) => t.textContent.trim())');
    if (tabs.some((t) => /Estimates/.test(t))) throw new Error(J(tabs));
    await jack.click('Drawings', 'main');
    await jack.waitFor('!!document.querySelector(\'a[href^="#/drawings/customer"]\')', 'drawings tab');
    if (!noMoney(await jack.text())) throw new Error('money on the drawings tab');
    await jack.evaluate('document.querySelector(\'a[href^="#/drawings/customer"]\').click(); true');
    await jack.waitFor('!!window.kelbeCanvas && !location.hash.includes("customer")', 'the editor');
    const opened = await jack.evaluate('location.hash.split("/")[2]');
    if (opened !== drawingId) throw new Error(`opened ${opened}, expected the customer's set ${drawingId}`);
    const items = await jack.evaluate('kelbe.store.list("items").map((i) => Object.keys(i).filter((k) => /Cents$/.test(k)))');
    if (items.flat().length) throw new Error('price fields synced to crew: ' + J(items));
    const settings = await jack.evaluate('Object.keys(kelbe.store.settings()).filter((k) => /labourRate|markup/.test(k))');
    if (settings.length) throw new Error('settings money synced to crew: ' + J(settings));
    return `same drawing ${opened.slice(0, 8)}; tabs: ${tabs.join(', ')}; no price fields on the phone`;
  });

  await step('two devices offline: Jackson adds 4 receptacles, Olive deletes the junction box; both survive the sync', async () => {
    await apiDown();
    for (const p of pages) p.offlineFrom = p.consoleLines.length;
    await placeSymbols(jack, 'receptacle', [[0.2, 0.3], [0.4, 0.3], [0.6, 0.3], [0.8, 0.3]]);
    // Olive: select the junction box and delete it
    await olive.click('Select');
    const jb = await olive.evaluate(`(() => { const o = kelbeCanvas.d.objects.find((x) => x.id === ${J(junctionId)}); return [o.x, o.y]; })()`);
    const s = await screenOf(olive, jb[0], jb[1]);
    await tap(olive, s.x, s.y);
    await olive.waitFor('kelbeCanvas.st.selection.length === 1', 'junction box selected');
    const info = await olive.evaluate('document.querySelector(".cv-ctx .cv-attr")?.textContent || ""');
    if (!/Added by Olive/.test(info)) throw new Error('selection label: ' + info);
    await olive.click('Delete (Del)', '.cv-ctx');
    await olive.evaluate('kelbeCanvas.save(); true');
    for (const p of pages) await p.evaluate('kelbe.sync.syncNow().catch(() => {})');
    await jack.waitFor('kelbe.sync.status().waiting >= 1', 'Jackson\'s change waiting', 30000);
    await olive.waitFor('kelbe.sync.status().waiting >= 1', 'Olive\'s change waiting', 30000);
    const mid = await serverDrawing(drawingId);
    if (mid.objects.length !== 3) throw new Error('reached the server while it was down?');
    await jack.shot('01-crew-offline-adds');
    await apiUp();
    for (const p of pages) p.offlineTo = p.consoleLines.length;
    await synced(olive);
    await synced(jack);
    await synced(olive);
    await synced(jack);
    const srv = await serverDrawing(drawingId);
    const counts = srv.objects.reduce((m, o) => ({ ...m, [o.symbol]: (m[o.symbol] || 0) + 1 }), {});
    if (counts.receptacle !== 6 || counts.junction) throw new Error('server: ' + J(counts));
    const want = 'kelbeCanvas.d.objects.filter((o) => o.symbol === "receptacle").length === 6 && !kelbeCanvas.d.objects.some((o) => o.symbol === "junction")';
    await olive.waitFor(want, 'Olive\'s open drawing shows Jackson\'s receptacles', 30000);
    await jack.waitFor(want, 'Jackson\'s open drawing loses the junction box', 30000);
    const byJack = srv.objects.filter((o) => o.by?.name === 'Jackson Reid').length;
    if (byJack !== 4 || !srv.tombstones?.[junctionId]) throw new Error(J({ byJack, t: srv.tombstones }));
    await olive.shot('02-office-merged');
    return `server v${srv.version}: ${J(counts)}, 4 by Jackson, the junction box tombstoned by ${srv.tombstones[junctionId].by}; both screens agree`;
  });

  await step('office reads the history in plain words and taps an entry to zoom to it', async () => {
    await olive.click('Changes and who drew what');
    await olive.click('History', '.cv-changes');
    await olive.waitFor('[...document.querySelectorAll(".cv-change-text")].some((x) => /^Jackson added 4 duplex receptacles on sheet Sheet 1$/.test(x.textContent))', 'Jackson\'s entry');
    const lines = await olive.evaluate('[...document.querySelectorAll(".cv-change")].map((x) => x.innerText.replace(/\\s+/g, " ").trim())');
    if (!lines.some((l) => /^Olive deleted 1 junction box on sheet Sheet 1 today/.test(l))) throw new Error(J(lines));
    const days = await olive.evaluate('[...document.querySelectorAll(".cv-changes-day")].map((x) => x.textContent)');
    const people = await olive.evaluate('[...document.querySelectorAll(".cv-changes-who strong")].map((x) => x.textContent)');
    await olive.evaluate('kelbeCanvas.fit(); true');
    const v0 = await olive.evaluate('JSON.stringify(kelbeCanvas.st.view)');
    await olive.evaluate('[...document.querySelectorAll(".cv-change")].find((x) => x.textContent.startsWith("Jackson")).click(); true');
    await olive.waitFor(`JSON.stringify(kelbeCanvas.st.view) !== ${J(v0)} && !!document.querySelector(".cv-change.on")`, 'zoomed to the change');
    await olive.shot('03-history-zoom');
    return `${days.join(', ')} · people: ${people.join(', ')} · ${lines.join(' | ')}`;
  });

  await step('who drew what: tint by author, filter by person and date', async () => {
    await olive.click('Who drew what', '.cv-changes');
    await olive.waitFor('!!document.querySelector(".cv-author")', 'authors');
    const authorsList = await olive.evaluate('[...document.querySelectorAll(".cv-author")].map((x) => x.querySelector(".title").textContent + ":" + x.querySelector(".cv-author-n").textContent)');
    if (!authorsList.includes('Jackson Reid:4') || !authorsList.includes('Olive Office:2')) throw new Error(J(authorsList));
    await olive.evaluate('[...document.querySelectorAll(".cv-author")].find((x) => x.textContent.includes("Jackson")).click(); true');
    await olive.waitFor('kelbeCanvas.collab.view.show && !!kelbeCanvas.collab.view.who && !document.querySelector(".cv-attr-chip").hidden', 'filtered to Jackson');
    await olive.fill('.cv-changes-selects select[aria-label="Date"]', 'today');
    const chip = await olive.evaluate('document.querySelector(".cv-attr-chip").innerText.trim()');
    await olive.shot('04-who-drew-what');
    await olive.evaluate('kelbeCanvas.collab.setShow(false); true');
    return `authors ${authorsList.join(', ')}; chip "${chip}"`;
  });

  let co = null;
  await step('office sees the cost impact and creates a change order in one tap', async () => {
    await olive.click('Cost impact', '.cv-changes');
    await olive.waitFor('!!document.querySelector(".cv-cost-line")', 'cost lines');
    const text = await olive.evaluate('document.querySelector(".cv-changes-body").innerText');
    if (!/\+4 duplex receptacles/.test(text) || !/−1 junction box/.test(text) || !/\$/.test(text) || !/added by Jackson/.test(text)) throw new Error(text);
    await olive.shot('05-cost-impact');
    await olive.click('Create change order', '.cv-changes');
    const end = Date.now() + 15000;
    while (Date.now() < end && !co) { co = (await serverJob()).changeOrders?.find((c) => c.source === 'drawing') || null; if (!co) { await olive.evaluate('kelbe.sync.syncNow().catch(() => {})'); await sleep(400); } }
    if (!co) throw new Error('no change order on the server');
    if (co.status !== 'pending' || !co.lines?.some((l) => l.symbol === 'receptacle' && l.qty === 4) || !/Jackson Reid/.test(co.note) || co.amountCents <= 0) throw new Error(J(co));
    await olive.waitFor('document.querySelector(".cv-changes-body").innerText.includes("match the estimate")', 'nothing left to price');
    return `"${co.title}" ${co.amountCents} cents pending; note: ${co.note}; ${text.split('\n').filter((l) => /Change|Material|Labour/.test(l)).join(' / ')}`;
  });

  await step('the electrician never sees prices: job, change orders, takeoff, symbols, Changes panel, API', async () => {
    await synced(jack);
    await jack.waitFor('(kelbe.store.get("jobs", ' + J(job.id) + ').changeOrders || []).some((c) => c.source === "drawing")', 'the change order synced down');
    const jobRec = await jack.evaluate(`kelbe.store.get("jobs", ${J(job.id)})`);
    if (/Cents"/.test(J(jobRec))) throw new Error('job money on the phone: ' + J(jobRec.changeOrders));
    // Changes panel: history yes, cost impact no
    await jack.click('Changes and who drew what');
    await jack.waitFor('!!document.querySelector(".cv-changes:not([hidden])")', 'panel');
    const tabs = await jack.evaluate('[...document.querySelectorAll(".cv-changes [role=tab]")].map((t) => t.textContent)');
    if (tabs.includes('Cost impact')) throw new Error(J(tabs));
    const hist = await jack.evaluate('document.querySelector(".cv-changes-body").innerText');
    if (!/Jackson added 4 duplex receptacles/.test(hist) || !noMoney(hist)) throw new Error(hist);
    await jack.shot('06-crew-history');
    await jack.click('Close changes');
    // takeoff and symbols (More → Takeoff on a phone)
    await jack.click('More');
    await jack.waitFor('!!document.querySelector(".sheet")', 'more sheet');
    await jack.evaluate('[...document.querySelectorAll(".sheet .list-row")].find((x) => x.textContent.startsWith("Takeoff")).click(); true');
    await jack.waitFor('!!document.querySelector(".sheet") && document.querySelector(".sheet").innerText.includes("Count")', 'takeoff');
    const takeoff = await jack.evaluate('document.querySelector(".sheet").innerText');
    if (!noMoney(takeoff) || /Create estimate|Price-book value/.test(takeoff)) throw new Error(takeoff);
    await jack.evaluate('document.querySelector(".sheet [aria-label=Close]")?.click(); true');
    await sleep(300);
    await jack.click('Place a symbol');
    await jack.waitFor('!!document.querySelector(".cv-symbol")', 'symbols');
    const symbols = await jack.evaluate('document.querySelector(".sheet").innerText');
    if (!noMoney(symbols)) throw new Error('prices on symbols: ' + symbols.slice(0, 200));
    await jack.evaluate('document.querySelector(".sheet [aria-label=Close]")?.click(); true');
    await sleep(300);
    // the API answers the cost impact without prices for crew
    const api = await jack.evaluate(`fetch("/api/v1/drawings/${drawingId}/cost-impact", { headers: { "x-fishtape": "1" } }).then((r) => r.json())`);
    if (api.prices !== false || /Cents|markup|labourHours/.test(J(api))) throw new Error(J(api));
    // the job's change orders tab
    await jack.evaluate(`location.hash = "#/jobs/${job.id}?tab=changes"`);
    await jack.waitFor('document.querySelector("main")?.innerText.includes("Drawing changes")', 'change orders tab');
    const changes = await jack.evaluate('document.querySelector("main").innerText');
    if (!noMoney(changes)) throw new Error('money on the crew change orders tab: ' + changes.slice(0, 500));
    await jack.shot('07-crew-change-orders');
    return `panel tabs: ${tabs.join(', ')}; API prices: ${api.prices}; change order visible without an amount`;
  });

  await step('the office sees the change order with its amount and who added the items', async () => {
    await olive.evaluate(`location.hash = "#/jobs/${job.id}?tab=changes"`);
    await olive.waitFor('document.querySelector("main")?.innerText.includes("Drawing changes")', 'job change orders');
    const t = await olive.evaluate('document.querySelector("main").innerText');
    if (!/\$/.test(t) || !/added by Jackson Reid/.test(t) || !/From drawings/.test(t)) throw new Error(t.slice(0, 600));
    await olive.shot('08-office-change-orders');
    // the drawing card says who edited last
    await olive.evaluate(`location.hash = "#/jobs/${job.id}?tab=drawings"`);
    await olive.waitFor('/Edited by (Olive|Jackson)/.test(document.querySelector("main").innerText)', 'last edited by on the card');
    return (t.match(/Drawing changes[^\n]*/) || [''])[0];
  });

  await step('phone and iPad layouts: no sideways scroll, panel fits', async () => {
    const out = [];
    for (const p of pages) {
      await p.evaluate(`location.hash = "#/drawings/${drawingId}"`);
      await p.waitFor('!!window.kelbeCanvas', 'editor');
      await p.click('Changes and who drew what');
      await p.waitFor('!!document.querySelector(".cv-changes:not([hidden])")', 'panel');
      const m = await p.evaluate('(() => { const r = document.querySelector(".cv-changes").getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: innerWidth, l: r.left, r: r.right, b: r.bottom, ih: innerHeight }; })()');
      if (m.sw > m.iw + 1 || m.l < 0 || m.r > m.iw + 1 || m.b > m.ih + 1) throw new Error(`${p.name}: ${J(m)}`);
      await p.shot(`09-layout-${p.name}`);
      out.push(`${p.name} ${m.iw}px: panel ${Math.round(m.l)}–${Math.round(m.r)}`);
    }
    // the gallery card for the customer's set says who edited last
    await jack.evaluate(`location.hash = "#/drawings?clientId=${client.id}"`);
    await jack.waitFor('/Edited by/.test(document.querySelector("main").innerText)', 'gallery card');
    const sw = await jack.evaluate('document.documentElement.scrollWidth <= innerWidth + 1');
    if (!sw) throw new Error('gallery scrolls sideways on the phone');
    await jack.shot('10-crew-gallery');
    return out.join('; ');
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
        && !/api\/v1\/(me|auth\/providers)/.test(l)));
    all.push(...errs.map(({ l }) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'drawings-collab-e2e-results.json'), J({ results, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
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
