// Accounts and sync, end to end (workstream G): embedded Postgres 17 + the API (in-process,
// so it can be stopped and started) + a static server that proxies /api/ like nginx +
// headless Chrome driven over CDP (no Docker, no Playwright).
//   cd server && npm ci            (embedded-postgres, pg, otplib come from server/node_modules)
//   node electrical-app/tests/e2e/accounts.e2e.mjs [scratch dir]
// CHROME_PATH overrides the Chrome binary; E2E_SW serves another sw.js. Not part of
// `node --test electrical-app/tests/*.test.mjs` (it needs Chrome and starts a database).
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
  else if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
await send('Page.enable');

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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

const CLIENT = `E2E Offline Client ${Date.now().toString(36)}`;
const tenantId = async (name) => (await superDb.query('SELECT id FROM tenants WHERE name = $1', [name])).rows[0].id;
const onServer = async (tenant) => (await superDb.query("SELECT id, version FROM clients WHERE tenant_id = $1 AND data->>'name' = $2 AND deleted_at IS NULL", [tenant, CLIENT])).rows;

let exitCode = 0;
try {
  await step('reset link: token is taken out of the address bar', async () => {
    await goto('/#/reset-password?token=e2e-not-a-real-token');
    await waitFor('document.querySelector(".gate h1")?.textContent === "Set a new password"', 'reset screen');
    const hash = await evaluate('location.hash');
    if (hash !== '#/reset-password') throw new Error(`hash is ${hash}`);
    await fill('.gate input[autocomplete=new-password]', 'a long enough password');
    await evaluate('document.querySelectorAll(".gate input[autocomplete=new-password]")[1].value = "a long enough password"');
    await click('Set password', '.gate');
    await waitFor('document.querySelector(".gate-note.danger")?.textContent.includes("expired")', 'invalid token message');
    return `hash after load: ${hash}`;
  });

  await step('not signed in + server reachable: sign-in screen with providers and a labelled demo option', async () => {
    await goto('/');
    await waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
    const t = await text();
    for (const s of ['Sign in', 'Forgot password?', 'Try the demo on this device', 'never syncs']) if (!t.includes(s)) throw new Error(`missing "${s}"`);
    return 'form, forgot link, demo option present';
  });

  await step('demo mode: local-only, seeded, never syncs; back to sign-in', async () => {
    await click('Try the demo on this device', '.gate');
    await waitFor('!!document.querySelector(".demo-chip") && kelbe.store.scope?.kind === "demo"', 'demo shell');
    const n = await evaluate('kelbe.store.count("clients")');
    const s = await evaluate('kelbe.sync === null && kelbe.store.dbName');
    if (!n || s !== 'kelbe-circuit') throw new Error(`clients ${n}, sync/db ${s}`);
    await evaluate('location.hash = "#/account"');
    await click('Sign in to your company', 'main');
    await waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
    await waitFor('document.body.innerText.includes("Continue the demo on this device")', 'demo button mentioning existing demo data', 5000);
    return `${n} demo clients in ${s}; no sync engine`;
  });

  await step('sign in as seeded owner (TG Electrical) + MFA enrolment (QR, key, recovery codes)', async () => {
    await signIn('owner@tgelectrical.test', { enrol: true });
    const me = await evaluate('({ t: kelbe.session.me.tenant.name, r: kelbe.session.me.tenant.role, plan: kelbe.session.me.entitlements.plan, db: kelbe.store.dbName, clients: kelbe.store.list("clients").map((c) => c.name) })');
    if (me.t !== 'TG Electrical' || me.r !== 'owner') throw new Error(JSON.stringify(me));
    if (!me.clients.some((c) => c.includes('Dental Clinic'))) throw new Error('server seed clients not pulled: ' + me.clients);
    const ls = await evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))');
    if (/fts_|ftd_|owner@|Dental|password/i.test(ls)) throw new Error('sensitive data in localStorage: ' + ls);
    const url = await evaluate('location.href');
    return `${me.t}/${me.r}, plan ${me.plan}, db ${me.db}, pulled ${me.clients.length} clients; localStorage ${ls}; url ${url}`;
  });

  const tg = await tenantId('TG Electrical');

  await step('API down: create a client through the UI; it waits in the queue', async () => {
    await apiDown();
    await evaluate('location.hash = "#/clients"');
    await click('Add client', 'main');
    await waitFor('!!document.querySelector("[role=dialog] input[name=name]")', 'client sheet');
    await fill('[role=dialog] input[name=name]', CLIENT);
    await click('Add client', '[role=dialog]');
    await waitFor(`kelbe.store.list("clients").some((c) => c.name === ${J(CLIENT)})`, 'client saved locally');
    await waitFor('kelbe.sync.status().state === "offline" && kelbe.sync.status().waiting === 1', 'offline with 1 waiting', 30000);
    const tip = await evaluate('document.querySelector(".sync-btn").getAttribute("aria-label")');
    const banner = await evaluate('document.querySelector(".net-banner")?.innerText || ""');
    if ((await onServer(tg)).length) throw new Error('reached the server while it was down?');
    return `rail: "${tip}"; banner: "${banner}"`;
  });

  await step('reload while the API is down: offline mode from cached data, quiet banner', async () => {
    await goto('/');
    await waitFor('!!document.querySelector(".rail") && kelbe.session.online === false', 'offline shell');
    await waitFor(`kelbe.store.list("clients").some((c) => c.name === ${J(CLIENT)})`, 'client still on the device');
    await waitFor('!!document.querySelector(".net-banner")', 'offline banner');
    return await evaluate('document.querySelector(".net-banner").innerText');
  });

  await step('API back: the queued client syncs to the server', async () => {
    await apiUp();
    await evaluate('document.querySelector(".sync-btn").click()');
    await click('Sync now', '[role=dialog]');
    await waitFor('kelbe.sync.status().state === "synced" && kelbe.sync.status().waiting === 0', 'synced, nothing waiting', 30000);
    const rows = await onServer(tg);
    if (rows.length !== 1) throw new Error(`server has ${rows.length} copies`);
    const v = await evaluate(`kelbe.store.version("clients", ${J(rows[0].id)})`);
    await waitFor('!document.querySelector(".net-banner")', 'banner gone');
    return `server row ${rows[0].id} v${rows[0].version}; device knows v${v}`;
  });

  const alpha = await tenantId('Test Co Alpha');
  const tgOwner = (await superDb.query("SELECT id FROM users WHERE email = 'owner@tgelectrical.test'")).rows[0].id;

  await step('switch to another company (Test Co Alpha, Starter plan): the client is not there; plan locks show', async () => {
    await superDb.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [alpha, tgOwner]);
    await superDb.query("UPDATE tenants SET plan = 'starter' WHERE id = $1", [alpha]);
    await goto('/#/account');
    await waitFor('document.body.innerText.includes("Test Co Alpha")', 'company switcher');
    await click('Switch', 'main');
    await waitFor('kelbe.session?.me?.tenant?.name === "Test Co Alpha" && kelbe.sync?.status().pulledOnce', 'Alpha loaded', 30000);
    await evaluate('location.hash = "#/clients"');
    await waitFor('document.querySelector("main h1")?.textContent === "Clients"', 'clients page');
    const visible = await evaluate(`document.body.innerText.includes(${J(CLIENT)}) || kelbe.store.list("clients").some((c) => c.name === ${J(CLIENT)})`);
    if (visible) throw new Error('TG client visible in Alpha!');
    const alphaClients = await evaluate('kelbe.store.list("clients").map((c) => c.name)');
    const locked = await evaluate('[...document.querySelectorAll(".rail-btn.locked")].map((a) => a.dataset.mod)');
    if (!locked.includes('drawings')) throw new Error('drawings not locked on Starter: ' + locked);
    await evaluate('location.hash = "#/drawings"');
    await waitFor('document.querySelector(".upgrade-card")?.innerText.includes("Plans & drawings is part of Pro")', 'upgrade card');
    const link = await evaluate('document.querySelector(".upgrade-card a.btn")?.getAttribute("href")');
    const dbs = await evaluate(`indexedDB.databases().then((d) => d.map((x) => x.name).filter((n) => n.startsWith("fishtape:${tgOwner}:")))`);
    if (dbs.length !== 2) throw new Error('expected two company databases: ' + dbs);
    return `Alpha clients: ${alphaClients.join(' | ')}; locked: ${locked.join(', ')}; upgrade link ${link}; dbs ${dbs.length}`;
  });

  await step('switch back to TG Electrical: the client is there again', async () => {
    await evaluate('location.hash = "#/account"');
    await waitFor('document.body.innerText.includes("TG Electrical")', 'switcher');
    await click('Switch', 'main');
    await waitFor('kelbe.session?.me?.tenant?.name === "TG Electrical" && !!kelbe.sync', 'TG loaded', 30000);
    await evaluate('location.hash = "#/clients"');
    await waitFor(`document.body.innerText.includes(${J(CLIENT)})`, 'client listed');
    return 'listed on the Clients page';
  });

  await step('a change made elsewhere arrives by pull and redraws the open screen', async () => {
    const [row] = await onServer(tg);
    const p = { ...(await superDb.query('SELECT data FROM clients WHERE tenant_id = $1 AND id = $2', [tg, row.id])).rows[0].data, phone: '(705) 555-0199', updatedAt: new Date().toISOString() };
    // Through the API as another session of the same owner (a second device).
    const login = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fishtape': '1' }, body: J({ email: 'owner@tgelectrical.test', password: creds['owner@tgelectrical.test'], mode: 'bearer' }) }).then((r) => r.json());
    const verify = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/mfa/verify`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: J({ code: await secrets['owner@tgelectrical.test']() }) });
    if (!verify.ok) throw new Error('second device MFA failed ' + verify.status);
    const patch = await fetch(`http://127.0.0.1:${apiPort}/api/v1/clients/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: J({ phone: p.phone }) });
    if (!patch.ok) throw new Error('PATCH failed ' + patch.status);
    await evaluate('kelbe.sync.syncNow()');
    await waitFor(`kelbe.store.get("clients", ${J(row.id)})?.phone === "(705) 555-0199"`, 'pulled change', 15000);
    await waitFor('document.body.innerText.includes("(705) 555-0199")', 'Clients page redrawn');
    return 'phone updated on screen';
  });

  await step('sign out on a personal device wipes this user\'s company databases', async () => {
    await evaluate('location.hash = "#/account"');
    await waitFor('!!document.querySelector("main .page-head")', 'account page');
    let planted = 'n/a';
    for (let i = 0; i < 5 && planted !== true; i++) {
      planted = await evaluate('caches.open("e2e-sentinel").then((c) => c.put("/e2e-sentinel", new Response("x"))).then(() => true, (e) => String(e))');
      if (planted !== true) await sleep(500);
    }
    const before = await evaluate('caches.keys().then((k) => k.join(","), (e) => String(e))');
    await click('Sign out', 'main .page-head');
    await waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
    const sentinel = await evaluate('caches.has("e2e-sentinel").then((x) => x, (e) => String(e))');
    if (planted === true && sentinel !== false) throw new Error('Cache Storage not cleared');
    const cacheNote = planted === true ? `Cache Storage cleared (had: ${before}; sentinel gone)` : `Cache Storage not testable in this headless profile (${planted})`;
    const dbs = await evaluate(`indexedDB.databases().then((d) => d.map((x) => x.name))`);
    if (dbs.some((n) => n.startsWith(`fishtape:${tgOwner}:`))) throw new Error('company data left behind: ' + dbs);
    const pointer = await evaluate('localStorage.getItem("ft.session")');
    if (pointer) throw new Error('pointer left: ' + pointer);
    return `databases now: ${dbs.join(', ')}; ${cacheNote}`;
  });

  await step('sign in as another company (owner@alpha.test): the TG client is not visible', async () => {
    await signIn('owner@alpha.test', { enrol: true });
    const t = await evaluate('kelbe.session.me.tenant.name');
    await evaluate('location.hash = "#/clients"');
    await waitFor('document.querySelector("main h1")?.textContent === "Clients"', 'clients page');
    const visible = await evaluate(`document.body.innerText.includes(${J(CLIENT)}) || kelbe.store.list("clients").some((c) => c.name === ${J(CLIENT)})`);
    if (t !== 'Test Co Alpha' || visible) throw new Error(`tenant ${t}, visible ${visible}`);
    const api403 = await evaluate(`fetch("/api/v1/clients/${(await onServer(tg))[0].id}").then((r) => r.status)`);
    if (api403 !== 404) throw new Error('cross-tenant GET returned ' + api403);
    await evaluate('location.hash = "#/account"');
    await waitFor('!!document.querySelector("main .page-head")', 'account page');
    await click('Sign out', 'main .page-head');
    await waitFor('!!document.querySelector(".gate input[name=email]")', 'sign-in form');
    return `${t}: not in the list, GET by id answers ${api403}`;
  });

  await step('switch back: sign in again as TG owner (MFA code), the client comes back from the server', async () => {
    await signIn('owner@tgelectrical.test', { enrol: false });
    await waitFor(`kelbe.store.list("clients").some((c) => c.name === ${J(CLIENT)})`, 'client re-downloaded');
    // Units chosen on the Account page go to the profile (PATCH /api/v1/me/prefs).
    await evaluate('location.hash = "#/account"');
    await waitFor('[...document.querySelectorAll("main [role=tab]")].some((b) => b.textContent === "Imperial (ft, in)")', 'units tabs');
    await evaluate('[...document.querySelectorAll("main [role=tab]")].find((b) => b.textContent === "Imperial (ft, in)").click()');
    const end = Date.now() + 10000;
    let prefs = null;
    while (Date.now() < end) { prefs = (await superDb.query("SELECT prefs FROM users WHERE email = 'owner@tgelectrical.test'")).rows[0].prefs; if (prefs.units === 'imperial') break; await sleep(200); }
    if (prefs.units !== 'imperial') throw new Error('prefs not saved: ' + JSON.stringify(prefs));
    const local = await evaluate('localStorage.getItem("ft.units")');
    return `pulled into a fresh database; profile prefs ${JSON.stringify(prefs)}, local cache ${local}`;
  });

  await step('shared iPad: register, set a PIN, hand over, crew PIN sign-in (role capped), data kept', async () => {
    await evaluate('location.hash = "#/account"');
    await waitFor('document.body.innerText.includes("Use this iPad for crew sign-in")', 'shared iPad card');
    await click('Use this iPad for crew sign-in', 'main');
    await waitFor('!!document.querySelector("[role=dialog] input.input")', 'name prompt');
    await fill('[role=dialog] input.input', 'E2E iPad');
    await click('Register', '[role=dialog]');
    await waitFor('document.body.innerText.includes("Hand over to crew") && document.body.innerText.includes("No PIN")', 'registered + crew list');
    await click('Set PIN', 'main');
    await waitFor('document.querySelectorAll("[role=dialog] input[type=password]").length === 2', 'PIN dialog');
    await evaluate('[...document.querySelectorAll("[role=dialog] input[type=password]")].forEach((i) => { i.value = "4826"; })');
    await click('Save PIN', '[role=dialog]');
    await waitFor('document.body.innerText.includes("PIN set")', 'PIN saved');
    await click('Hand over to crew', 'main');
    await waitFor('!!document.querySelector(".crew-tile")', 'crew picker', 30000);
    const dbs = await evaluate(`indexedDB.databases().then((d) => d.map((x) => x.name).filter((n) => n.startsWith("fishtape:${tgOwner}:")))`);
    if (dbs.length !== 1) throw new Error('shared iPad should keep the data: ' + dbs);
    await evaluate('document.querySelector(".crew-tile").click()');
    await waitFor('!!document.querySelector(".pin-pad")', 'PIN pad');
    await evaluate('for (const d of "4826") [...document.querySelectorAll(".pin-key")].find((k) => k.textContent === d).click(); document.querySelector(".pin-key.ok").click()');
    await waitFor('kelbe.session?.me?.session?.kind === "crew" && !!kelbe.sync', 'crew session', 30000);
    const role = await evaluate('kelbe.session.me.tenant.role');
    const has = await evaluate(`kelbe.store.list("clients").some((c) => c.name === ${J(CLIENT)})`);
    const settingsVisible = await evaluate('!!document.querySelector(".rail [data-mod=settings]")');
    if (role !== 'foreman' || settingsVisible) throw new Error(`role ${role}, settings in rail ${settingsVisible}`);
    await evaluate('location.hash = "#/account"');
    await waitFor('!!document.querySelector("main .page-head")', 'account page');
    await click('Done: hand back the iPad', 'main .page-head');
    await waitFor('!!document.querySelector(".crew-tile")', 'back to crew picker', 30000);
    const after = await evaluate(`indexedDB.databases().then((d) => d.map((x) => x.name).filter((n) => n.startsWith("fishtape:${tgOwner}:")).length)`);
    return `crew role ${role}; device kept data (${dbs.length} db before, ${after} after); client already on device: ${has}`;
  });

  await step('prefs follow the profile: units saved to /me', async () => {
    const r = await superDb.query("SELECT prefs FROM users WHERE email = 'owner@tgelectrical.test'");
    return JSON.stringify(r.rows[0].prefs);
  });
} catch {
  exitCode = 1;
} finally {
  const errors = consoleLines.filter((l) => /exception|\[error\]/.test(l));
  writeFileSync(join(SCRATCH, 'e2e-results.json'), JSON.stringify({ results, console: consoleLines.slice(-80) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`browser console errors: ${errors.length}`);
  for (const e of errors.slice(0, 15)) console.log('   ', e.slice(0, 300));
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
