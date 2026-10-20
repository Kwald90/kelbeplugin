// Work plans and My day, end to end: embedded Postgres 17 + the API (in-process, so it can be
// stopped for the offline step) + a static server that proxies /api/ like nginx + headless
// Chrome over CDP, with two people in separate browser contexts:
//   foreman on an iPad (1180 x 820): plan a 35-working-day job, spread 400 boxes over 10 days,
//     add a photo-required task, drag a task on the board, Move… from the task list, publish
//     tomorrow then today, run the morning meeting (Got it, add a task live), read the KPIs.
//   electrician on a phone (390 x 844): lands on My day, finishes the photo task through the
//     camera input (a generated image), finishes another task offline and it syncs later,
//     marks one blocked. KPIs, the dashboard and the server all agree; the console stays clean.
//
//   cd server && npm ci
//   node electrical-app/tests/e2e/workplan.e2e.mjs [scratch dir]
// CHROME_PATH overrides the Chrome binary. Not part of `node --test electrical-app/tests/*.test.mjs`.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-wp-e2e-'));
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

/** A real PNG (solid colour with a stripe), so the camera input gets a decodable image. */
function makePng(path, w = 160, hgt = 120) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const stripe = Math.abs(x - y) < 6; raw[o] = stripe ? 245 : 31; raw[o + 1] = stripe ? 179 : 95; raw[o + 2] = stripe ? 1 : 184; }
  }
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return path;
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

// Crew for TG Electrical: the seeded foreman signs in; an electrician is added.
const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;
const foremanEmp = (await superDb.query("SELECT id FROM employees WHERE tenant_id = $1 AND data->>'role' = 'foreman'", [tg])).rows[0].id;
await superDb.query("INSERT INTO employees (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'emp-wes', $2, 'system:e2e', 'system:e2e')",
  [tg, { name: 'Wes Wire', role: 'electrician', active: true, color: '#7a3fb0', email: '', phone: '', rateCents: 4400 }]);
const people = {};
for (const [key, role, emp, name] of [['foreman', 'foreman', foremanEmp, 'Fran Foreman'], ['wes', 'electrician', 'emp-wes', 'Wes Wire']]) {
  const email = `${key}@tgelectrical.test`;
  const password = `pw-${randomBytes(10).toString('hex')}`;
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING id', [email, name, await hashSecret(password)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [tg, u.rows[0].id, role, emp]);
  people[key] = { email, password, emp };
}
log('seeded TG Electrical with a foreman and an electrician');

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
const serverTasks = async (where = 'TRUE', params = []) => (await superDb.query(`SELECT id, data FROM work_tasks WHERE tenant_id = $1 AND deleted_at IS NULL AND ${where}`, [tg, ...params])).rows.map((r) => ({ ...r.data, id: r.id }));

const pages = [];
let exitCode = 0;
const png = makePng(join(SCRATCH, 'evidence.png'));
try {
  const fore = await openPage('foreman-ipad', { width: 1180, height: 820, mobile: false, touch: true });
  const wes = await openPage('wes-phone', { width: 390, height: 844, mobile: true });
  pages.push(fore, wes);
  const today = await fore.evaluate('(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })()');
  const weekend = [0, 6].includes(new Date(`${today}T12:00:00`).getDay());
  let planId = null;
  let draggedId = null;

  await step('foreman signs in on the iPad', async () => {
    await signIn(fore, people.foreman);
    const me = await fore.evaluate('({ role: kelbe.session.me.tenant.role, perms: kelbe.session.me.tenant.perms, plan: kelbe.session.me.entitlements.plan })');
    if (!me.perms.includes('workplan') || !me.perms.includes('kpis')) throw new Error(J(me));
    const hash = await fore.evaluate('location.hash');
    return `role ${me.role}, plan ${me.plan}, landed on ${hash}`;
  });

  await step('plan a 35-working-day job (weekends and holidays skipped)', async () => {
    await fore.evaluate('location.hash = "#/workplan"');
    await fore.waitFor('document.querySelector("main h1")?.textContent === "Work plans"', 'plans page');
    await fore.click('New plan', 'main');
    await fore.waitFor('!!document.querySelector("[role=dialog] select[name=jobId]")', 'new plan sheet');
    await fore.fill('[role=dialog] input[name=name]', 'E2E 35-day build');
    await fore.fill('[role=dialog] input[name=startDate]', today);
    await fore.fill('[role=dialog] input[name=workingDays]', '35');
    if (weekend) await fore.fill('[role=dialog] input[name=skipWeekends]', false);
    await fore.evaluate('(() => { const b = document.querySelector(\'[role=dialog] [data-crew="emp-wes"]\'); if (!b.checked) b.click(); return true; })()');
    const hint = await fore.evaluate('document.querySelector("[role=dialog] .wp-preview-line").innerText');
    await fore.click('Create plan', '[role=dialog]');
    await fore.waitFor('location.hash.startsWith("#/workplan/") && !!document.querySelector(".wp-board")', 'plan board');
    planId = await fore.evaluate('location.hash.split("/")[2].split("?")[0]');
    const sub = await fore.evaluate('document.querySelector("main .page-head .sub").textContent');
    if (!sub.includes('35 working days')) throw new Error(sub);
    await fore.shot('01-plan-created');
    return `${hint} | ${sub}`;
  });

  await step('spread 400 boxes over 10 days for the crew (capacity checked)', async () => {
    await fore.click('Spread', 'main .page-head');
    await fore.waitFor('!!document.querySelector("[role=dialog] input[name=totalQty]")', 'spread sheet');
    await fore.fill('[role=dialog] input[name=title]', 'Mount device boxes');
    await fore.fill('[role=dialog] input[name=taskType]', 'Boxes');
    await fore.fill('[role=dialog] input[name=totalQty]', '400');
    await fore.fill('[role=dialog] input[name=unit]', 'boxes');
    await fore.fill('[role=dialog] input[name=ratePerHour]', '8');
    await fore.fill('[role=dialog] select[name=from]', today);
    await fore.fill('[role=dialog] input[name=days]', '10');
    const preview = await fore.evaluate('document.querySelector("[role=dialog] .wp-preview-line").innerText');
    if (!/20 tasks/.test(preview) || !/20 boxes/.test(preview) || !/2\.5 h/.test(preview)) throw new Error(preview);
    await fore.click('Create tasks', '[role=dialog]');
    await fore.waitFor(`kelbe.store.count("workTasks", (t) => t.planId === ${J(planId)}) === 20`, '20 tasks');
    const drafts = await fore.evaluate(`kelbe.store.list("workTasks", (t) => t.planId === ${J(planId)}).every((t) => t.status === "draft" && t.qty === 20 && t.estHours === 2.5)`);
    if (!drafts) throw new Error('not 20 drafts of 20 boxes / 2.5 h');
    return preview.replace(/\s+/g, ' ');
  });

  await step('add a photo-required task for Wes today', async () => {
    await fore.click('Add task', 'main .page-head');
    await fore.waitFor('!!document.querySelector("[role=dialog] input[name=title]")', 'task sheet');
    await fore.fill('[role=dialog] input[name=title]', 'Bond the panel and photograph it');
    await fore.evaluate('(() => { const l = [...document.querySelectorAll("[role=dialog] .ops-chip-check")].find((x) => x.textContent.includes("Wes Wire")); l.querySelector("input").click(); return true; })()');
    await fore.fill('[role=dialog] select[name=date]', today);
    await fore.fill('[role=dialog] input[name=estHours]', '1.5');
    await fore.fill('[role=dialog] input[name=taskType]', 'Bonding');
    await fore.fill('[role=dialog] input[name=requiresPhoto]', true);
    await fore.click('Add task', '[role=dialog]');
    await fore.waitFor(`kelbe.store.list("workTasks").some((t) => t.title === "Bond the panel and photograph it" && t.employeeId === "emp-wes" && t.requiresPhoto && t.date === ${J(today)})`, 'photo task');
    await sleep(300);
    const cap = await fore.evaluate('document.querySelector(".wp-warn")?.innerText || "no capacity warning"');
    return cap;
  });

  await step('drag a task to another day and person on the board with a finger (touch), then with a mouse', async () => {
    const tasks = await fore.evaluate(`kelbe.store.list("workTasks", (t) => t.planId === ${J(planId)} && t.title === "Mount device boxes").map((t) => ({ id: t.id, date: t.date, emp: t.employeeId }))`);
    const days = [...new Set(tasks.map((t) => t.date))].sort();
    const src = tasks.find((t) => t.emp === 'emp-wes' && t.date === days[1]);
    const box = await fore.evaluate(`(() => { const c = document.querySelector('.wp-chip[data-task="${src.id}"]'); c.scrollIntoView({ block: 'center', inline: 'center' }); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const dest = await fore.evaluate(`(() => { const c = document.querySelector('.wp-cell[data-date="${days[2]}"][data-emp="${foremanEmp}"]'); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height - 20 }; })()`);
    await fore.touch('touchStart', box.x, box.y);
    for (let i = 1; i <= 12; i++) await fore.touch('touchMove', box.x + ((dest.x - box.x) * i) / 12, box.y + ((dest.y - box.y) * i) / 12);
    await fore.shot('02-dragging');
    await fore.touch('touchEnd', dest.x, dest.y);
    await fore.waitFor(`(() => { const t = kelbe.store.get("workTasks", ${J(src.id)}); return t.date === ${J(days[2])} && t.employeeId === ${J(foremanEmp)}; })()`, 'task moved by touch');
    draggedId = src.id;
    await sleep(300); // the board redraws after a move
    // A mouse drag of another of Wes's tasks, two days later.
    const src2 = tasks.find((t) => t.emp === 'emp-wes' && t.date === days[3]);
    const b2 = await fore.evaluate(`(() => { const c = document.querySelector('.wp-chip[data-task="${src2.id}"]'); c.scrollIntoView({ block: 'center', inline: 'center' }); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const d2 = await fore.evaluate(`(() => { const c = document.querySelector('.wp-cell[data-date="${days[4]}"][data-emp="emp-wes"]'); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height - 20 }; })()`);
    await fore.mouse('mouseMoved', b2.x, b2.y);
    await fore.mouse('mousePressed', b2.x, b2.y);
    for (let i = 1; i <= 10; i++) await fore.mouse('mouseMoved', b2.x + ((d2.x - b2.x) * i) / 10, b2.y + ((d2.y - b2.y) * i) / 10);
    await fore.mouse('mouseReleased', d2.x, d2.y);
    await fore.waitFor(`kelbe.store.get("workTasks", ${J(src2.id)}).date === ${J(days[4])}`, 'task moved by mouse');
    return `${src.id.slice(0, 8)}: Wes ${days[1]} → foreman ${days[2]}`;
  });

  await step('Move… (no drag) from the task list puts it back', async () => {
    await fore.click('Tasks', 'main');
    await fore.waitFor('!!document.querySelector(".wp-daygroup")', 'task list');
    const target = { id: draggedId };
    await fore.evaluate(`(() => { const b = document.querySelector('.wp-daygroup .list-row[data-task="${draggedId}"] button[title^="Move"]'); b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
    await fore.waitFor('!!document.querySelector("[role=dialog] select[name=employeeId]")', 'move sheet');
    const day2 = (await fore.evaluate(`[...document.querySelectorAll('[role=dialog] select[name=date] option')].map((o) => o.value)`)).find((d) => d > today);
    await fore.fill('[role=dialog] select[name=employeeId]', 'emp-wes');
    await fore.fill('[role=dialog] select[name=date]', day2);
    await fore.click('Move', '[role=dialog]');
    await fore.waitFor(`(() => { const t = kelbe.store.get("workTasks", ${J(target.id)}); return t.employeeId === "emp-wes" && t.date === ${J(day2)}; })()`, 'moved back');
    await fore.click('Board', 'main');
    return `task ${target.id.slice(0, 8)} → Wes ${day2}`;
  });

  await step('publish tomorrow the day before, then today in the morning', async () => {
    await fore.waitFor('[...document.querySelectorAll("main .page-head button")].some((b) => b.textContent.trim() === "Publish tomorrow")', 'Publish tomorrow button');
    await fore.click('Publish tomorrow', 'main .page-head');
    await fore.waitFor('[...document.querySelectorAll("main .page-head button")].some((b) => b.textContent.trim() === "Publish today")', 'Publish today button');
    await fore.click('Publish today', 'main .page-head');
    await synced(fore);
    const out = await serverTasks("data->>'status' <> 'draft'");
    const days = [...new Set(out.map((t) => t.date))].sort();
    if (days.length !== 2 || days[0] !== today) throw new Error('published days on server: ' + days);
    const plan = (await superDb.query('SELECT data FROM work_plans WHERE id = $1', [planId])).rows[0].data;
    await fore.shot('03-published');
    return `${out.length} tasks out on the server for ${days.join(' and ')}; plan.published = ${Object.keys(plan.published).join(', ')}`;
  });

  await step('daily meeting mode: full screen by worker, "Got it" logged, a task added live', async () => {
    await fore.click('Meeting', 'main .page-head');
    await fore.waitFor('!!document.querySelector(".wp-meeting [data-emp=emp-wes]")', 'meeting cards');
    await fore.shot('04-meeting');
    await fore.click('Got it', '.wp-meeting [data-emp=emp-wes]');
    await fore.waitFor('document.querySelector(".wp-meeting [data-emp=emp-wes] .wp-gotit")?.innerText.includes("Got it")', 'acknowledged');
    await fore.click('Add task', '.wp-meeting [data-emp=emp-wes]');
    await fore.waitFor('!!document.querySelector("[role=dialog] input[name=title]")', 'quick task sheet');
    await fore.fill('[role=dialog] input[name=title]', 'Clean up the electrical room');
    await fore.fill('[role=dialog] input[name=estHours]', '0.5');
    await fore.click('Add task', '[role=dialog]');
    await fore.waitFor('document.querySelector(".wp-meeting [data-emp=emp-wes]")?.innerText.includes("Clean up the electrical room")', 'live task on the card');
    await fore.click('End meeting', '.wp-meeting');
    await fore.waitFor('!document.querySelector(".wp-meeting")', 'meeting closed');
    await synced(fore);
    const hud = (await superDb.query('SELECT data FROM huddles WHERE tenant_id = $1', [tg])).rows[0]?.data;
    const acked = await serverTasks("data->>'employeeId' = 'emp-wes' AND data->>'date' = $2 AND data->>'ackVia' = 'meeting'", [today]);
    const late = (await serverTasks("data->>'title' = 'Clean up the electrical room'"))[0];
    if (!hud?.attendees?.some((a) => a.employeeId === 'emp-wes') || !hud.endedAt) throw new Error('huddle not logged: ' + J(hud));
    if (!late || late.status !== 'todo' || !late.lateAdd) throw new Error('late task: ' + J(late));
    return `huddle ${hud.startedAt.slice(11, 16)}–${hud.endedAt.slice(11, 16)}, Wes acked ${acked.length} task(s); late add is ${late.status} with lateAdd`;
  });

  await step('Wes signs in on a phone and lands on My day: only his published tasks, "new" badge', async () => {
    await signIn(wes, people.wes);
    await wes.waitFor('location.hash === "#/today" && !!document.querySelector(".wp-card")', 'My day');
    const local = await wes.evaluate('kelbe.store.list("workTasks").map((t) => ({ e: t.employeeId, s: t.status, d: t.date, title: t.title, n: t.lateAdd && !t.seenAt }))');
    if (local.some((t) => t.e !== 'emp-wes' || t.s === 'draft')) throw new Error('foreign or draft task on the phone: ' + J(local));
    if (await wes.evaluate('kelbe.store.count("workPlans")')) throw new Error('plans synced to a worker');
    const badge = await wes.evaluate('[...document.querySelectorAll(".wp-card.is-new")].map((c) => c.querySelector(".wp-card-title").textContent)');
    if (!badge.includes('Clean up the electrical room')) throw new Error('no new badge: ' + J(badge));
    await wes.shot('05-my-day-phone');
    return `${local.length} tasks on the phone (today ${local.filter((t) => t.d === today).length}); new: ${badge.join(', ')}`;
  });

  await step('finishing the photo-required task forces the camera; the downscaled JPEG is stored and synced', async () => {
    const id = await wes.evaluate('kelbe.store.list("workTasks").find((t) => t.title === "Bond the panel and photograph it").id');
    wes.chooser.length = 0;
    await wes.evaluate(`(() => { const card = document.querySelector('.wp-card[data-task="${id}"]'); [...card.querySelectorAll('.wp-actions button')].find((b) => b.textContent.trim() === 'Done').click(); return true; })()`, { gesture: true });
    const end = Date.now() + 10000;
    while (!wes.chooser.length && Date.now() < end) await sleep(100);
    if (!wes.chooser.length) throw new Error('the camera (file chooser) did not open');
    const accept = await wes.evaluate('document.querySelector("input.wp-file")?.getAttribute("capture") + " " + document.querySelector("input.wp-file")?.accept');
    await wes.send('DOM.setFileInputFiles', { files: [png], backendNodeId: wes.chooser[0].backendNodeId });
    await wes.waitFor('!!document.querySelector("[role=dialog] input[name=actualHours]")', 'finish sheet');
    await wes.fill('[role=dialog] input[name=actualHours]', '1.25');
    await wes.click('Mark done', '[role=dialog]');
    await wes.waitFor(`kelbe.store.get("workTasks", ${J(id)}).status === "done"`, 'done locally');
    await synced(wes);
    const row = (await serverTasks('id = $2', [id]))[0];
    if (row.status !== 'done' || !row.photos?.[0]?.dataUrl?.startsWith('data:image/jpeg;base64,')) throw new Error('server row: ' + J({ s: row.status, p: row.photos?.length }));
    const bytes = Math.floor((row.photos[0].dataUrl.length * 3) / 4);
    await wes.shot('06-photo-done');
    return `camera input (${accept}); server: done with a ${row.photos[0].width}x${row.photos[0].height} JPEG (~${Math.round(bytes / 1024)} KB), ${row.actualHours} h`;
  });

  await step('offline: finish a task with the API down; it syncs when the server is back', async () => {
    const id = await wes.evaluate(`kelbe.store.list("workTasks").find((t) => t.title === "Mount device boxes" && t.date === ${J(today)}).id`);
    await apiDown();
    wes.offlineFrom = wes.consoleLines.length;
    await wes.evaluate(`(() => { const card = document.querySelector('.wp-card[data-task="${id}"]'); [...card.querySelectorAll('.wp-actions button')].find((b) => b.textContent.trim() === 'Done').click(); return true; })()`);
    await wes.waitFor('!!document.querySelector("[role=dialog] input[name=qtyDone]")', 'finish sheet');
    await wes.fill('[role=dialog] input[name=qtyDone]', '18');
    await wes.fill('[role=dialog] input[name=actualHours]', '2.75');
    await wes.click('Mark done', '[role=dialog]');
    await wes.waitFor(`kelbe.store.get("workTasks", ${J(id)}).status === "done"`, 'done on the phone');
    await wes.evaluate('kelbe.sync.syncNow().catch(() => {})');
    await wes.waitFor('kelbe.sync.status().state === "offline" && kelbe.sync.status().waiting >= 1', 'offline with changes waiting', 30000);
    const line = await wes.evaluate('document.querySelector(".wp-syncline")?.innerText || ""');
    if ((await serverTasks('id = $2', [id]))[0].status === 'done') throw new Error('reached the server while it was down?');
    await wes.shot('07-offline');
    await apiUp();
    wes.offlineTo = wes.consoleLines.length;
    await synced(wes);
    const row = (await serverTasks('id = $2', [id]))[0];
    if (row.status !== 'done' || row.qtyDone !== 18) throw new Error('server row: ' + J(row));
    return `while offline: "${line}"; after: server has done, 18 boxes, ${row.actualHours} h`;
  });

  await step('blocked with a reason: the foreman sees it', async () => {
    const id = await wes.evaluate('kelbe.store.list("workTasks").find((t) => t.title === "Clean up the electrical room").id');
    await wes.evaluate(`(() => { const card = document.querySelector('.wp-card[data-task="${id}"]'); [...card.querySelectorAll('.wp-actions button')].find((b) => b.textContent.trim() === 'Blocked').click(); return true; })()`);
    await wes.waitFor('!!document.querySelector("[role=dialog] .wp-reasons")', 'reasons');
    await wes.click('No access to the area', '[role=dialog]');
    await wes.fill('[role=dialog] textarea', 'Room is locked, waiting on the GC for a key');
    await wes.click('Mark blocked', '[role=dialog]');
    await synced(wes);
    await synced(fore);
    await fore.evaluate(`kelbe.nav("#/workplan/${planId}")`);
    await fore.waitFor('document.querySelector(".wp-alert")?.innerText.includes("No access to the area")', 'blocked alert on the plan');
    return await fore.evaluate('document.querySelector(".wp-alert").innerText');
  });

  await step('KPIs update: done, on time, hours, boxes per hour, evidence, blocked; CSV export', async () => {
    await fore.click('Progress & KPIs', 'main');
    await fore.waitFor('!!document.querySelector(".wp-kpi-host table")', 'KPI table');
    const row = await fore.evaluate('[...document.querySelectorAll(".wp-kpi-host table tbody tr")].find((r) => r.innerText.includes("Wes Wire"))?.innerText');
    if (!row || !/2\/\d+/.test(row) || !row.includes('100% of 1') || !row.includes('boxes/h')) throw new Error('Wes row: ' + row);
    const prog = await fore.evaluate('[...document.querySelectorAll(".wp-kpi-host .stat")].map((s) => s.innerText.replace(/\\s+/g, " ")).join(" | ")');
    const note = await fore.evaluate('document.querySelector(".wp-note-card").innerText');
    await fore.shot('08-kpis');
    await fore.click('KPIs CSV', '.wp-kpi-host');
    const end = Date.now() + 10000;
    let csv = null;
    while (Date.now() < end && !csv) { const f = readdirSync(fore.downloads).find((x) => x.endsWith('.csv')); if (f) csv = readFileSync(join(fore.downloads, f), 'utf8'); else await sleep(200); }
    if (!csv || !csv.includes('Wes Wire') || !csv.startsWith('Worker,')) throw new Error('CSV: ' + String(csv).slice(0, 200));
    const k = await fore.evaluate(`fetch("/api/v1/kpis?from=${today}&to=${today}&planId=${planId}").then((r) => r.json())`);
    const w = k.workers.find((x) => x.employeeId === 'emp-wes');
    if (w.completed !== 2 || w.evidencePct !== 100 || !w.blockedTasks) throw new Error('API KPIs: ' + J(w));
    return `Wes: ${row.replace(/\s+/g, ' ')} | ${prog} | note: "${note.slice(0, 60)}…" | CSV ${csv.split('\r\n').length} lines | API agrees (${w.completed} done, ${w.byType.map((b) => `${b.perHour} ${b.unit}/h`).join(', ')})`;
  });

  await step('dashboard tiles for the foreman', async () => {
    await fore.evaluate('kelbe.nav("#/dashboard")');
    await fore.waitFor('/blocked now/i.test(document.querySelector(".wp-dash")?.innerText || "") && document.querySelector(".wp-dash .list")?.innerText.includes("No access to the area")', 'tiles with the blocked task');
    await fore.shot('09-dashboard');
    return (await fore.evaluate('document.querySelector(".wp-dash .grid").innerText')).replace(/\s+/g, ' ');
  });

  await step('the server refuses Wes anything outside his own tasks', async () => {
    wes.probeFrom = wes.consoleLines.length; // Chrome logs the refusals below as failed loads
    const other = (await serverTasks("data->>'employeeId' <> 'emp-wes'"))[0];
    const r = await wes.evaluate(`fetch("/api/v1/workTasks/${other.id}").then((r) => r.status)`);
    const p = await wes.evaluate(`fetch("/api/v1/workTasks/${other.id}", { method: "PATCH", headers: { "content-type": "application/json", "x-fishtape": "1" }, body: JSON.stringify({ status: "done" }) }).then((r) => r.status)`);
    const plans = await wes.evaluate('fetch("/api/v1/workPlans").then((r) => r.status)');
    const kpis = await wes.evaluate(`fetch("/api/v1/kpis?from=${today}&to=${today}").then((r) => r.status)`);
    if (r !== 404 || p !== 404 || plans !== 403 || kpis !== 403) throw new Error(J({ r, p, plans, kpis }));
    return `GET other's task ${r}, PATCH ${p}, plans ${plans}, KPIs ${kpis}`;
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
        && !(p.probeFrom != null && i >= p.probeFrom && /Failed to load resource/.test(l)) && !/api\/v1\/(me|auth\/providers)/.test(l)));
    all.push(...errs.map(({ l }) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'workplan-e2e-results.json'), J({ results, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
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
