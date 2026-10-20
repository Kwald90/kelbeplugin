// Location while clocked in, end to end: embedded Postgres 17 + the API + a static server that
// proxies /api/ like nginx + headless Chrome over CDP with mocked geolocation
// (Emulation.setGeolocationOverride). NRCan's tile and address services are answered by the test
// (Fetch interception), so nothing leaves the machine.
//   foreman on an iPad (1180 x 820): sets two job sites (address lookup, then a pin on the map).
//   Jackson on a phone (390 x 844): sees the location notice once, clocks in at the first site
//     (the job is picked from where he is), leaves (Start travel is suggested), arrives at the
//     second site (Start work here), clocks out: two work entries and one travel entry billed to
//     the second job. Clocks in again 4.2 km from the job: no notice this time, flagged. Sees his
//     own location records.
//   foreman: reviews the flag, opens the week, approves everyone, exports the payroll CSVs, and
//     the dashboard shows hours this week by person (work / travel). Console stays clean.
//
//   cd server && npm ci
//   node electrical-app/tests/e2e/location.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-loc-e2e-'));
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
/** A small solid PNG: stands in for a map tile. */
function tilePng(w = 256, hgt = 256) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 226; raw[o + 1] = 231; raw[o + 2] = 222; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = tilePng().toString('base64');

// Site A (J-1001, found by address) in Winnipeg; points around it in metres.
const A = { lat: 49.8951, lng: -97.1384 };
const offset = (p, northM, eastM = 0) => ({ lat: p.lat + northM / 111_195, lng: p.lng + eastM / (111_195 * Math.cos((p.lat * Math.PI) / 180)) });
const GEOCODE_ANSWER = [{ key: 'locate', name: '42 Harbour Street, Winnipeg, Manitoba', province: 'Manitoba', category: 'Street', lat: A.lat, lng: A.lng, bbox: null, tag: [] }];

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
ownerClient.on('error', () => {}); // the embedded server stops at the end
await migrate(ownerClient);
const superDb = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(superPw)}@127.0.0.1:${pgPort}/fishtape` });
await superDb.connect();
superDb.on('error', () => {});
const db = createDb({ app: createPool(dbUrl('fishtape_app', roles.app_password), { max: 8 }) });
await seed({ db, ownerClient, log: () => {} });

// TG Electrical in Manitoba; a foreman signs in, and Jackson (electrician) is added.
const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;
const foremanEmp = (await superDb.query("SELECT id FROM employees WHERE tenant_id = $1 AND data->>'role' = 'foreman'", [tg])).rows[0].id;
await superDb.query("UPDATE employees SET data = data || '{\"payrollId\": \"F-01\"}' WHERE tenant_id = $1 AND id = $2", [tg, foremanEmp]);
await superDb.query("INSERT INTO employees (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'emp-jack', $2, 'system:e2e', 'system:e2e')",
  [tg, { name: 'Jackson Pike', role: 'electrician', active: true, color: '#7a3fb0', email: '', phone: '', rateCents: 4400, payrollId: '1042' }]);
const settingsRow = (await superDb.query("SELECT 1 FROM settings WHERE tenant_id = $1 AND id = 'settings'", [tg])).rows.length;
if (settingsRow) await superDb.query("UPDATE settings SET data = jsonb_set(data, '{company,province}', '\"MB\"') || '{\"payroll\": {\"otRule\": \"MB\", \"weekStartsOn\": 1, \"format\": \"wagepoint\"}}' WHERE tenant_id = $1 AND id = 'settings'", [tg]);
else await superDb.query("INSERT INTO settings (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'settings', $2, 'system:e2e', 'system:e2e')", [tg, { company: { name: 'TG Electrical', province: 'MB' }, payroll: { otRule: 'MB', weekStartsOn: 1, format: 'wagepoint' }, currency: 'CAD', nextNumbers: { job: 1003, estimate: 2001, invoice: 3001 } }]);
const jobIds = Object.fromEntries((await superDb.query("SELECT id, data->>'number' AS n FROM jobs WHERE tenant_id = $1", [tg])).rows.map((r) => [r.n, r.id]));
const people = {};
for (const [key, role, emp, name] of [['foreman', 'foreman', foremanEmp, 'Fran Foreman'], ['jack', 'electrician', 'emp-jack', 'Jackson Pike']]) {
  const email = `${key}@tgelectrical.test`;
  const password = `pw-${randomBytes(10).toString('hex')}`;
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING id', [email, name, await hashSecret(password)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [tg, u.rows[0].id, role, emp]);
  people[key] = { email, password, emp };
}
log('seeded TG Electrical (MB) with a foreman and Jackson');

const apiPort = await freePort();
const webPort = await freePort();
const ORIGIN = `http://localhost:${webPort}`;
const config = readConfig({ APP_ENV: 'local', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: dbUrl('fishtape_app', roles.app_password), RATE_LIMIT: 'off', LOG_LEVEL: 'warn', PORT: String(apiPort) });
const api = await buildApp({ config, db });
await api.listen({ port: apiPort, host: '127.0.0.1' });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };
const web = createServer((rq, rs) => {
  const url = new URL(rq.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    const up = httpRequest({ host: '127.0.0.1', port: apiPort, method: rq.method, path: rq.url, headers: { ...rq.headers, 'x-forwarded-for': '127.0.0.1' } }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
    up.on('error', () => { if (!rs.headersSent) { rs.writeHead(502); rs.end(); } });
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

// ---------- Chrome over CDP ----------
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
const outside = { geocode: 0, tiles: 0 };

async function openPage(name, { width, height, mobile }) {
  const { browserContextId } = await browserSend('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await browserSend('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browserSend(m, p, sessionId);
  const consoleLines = [];
  listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    else if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    else if (msg.method === 'Log.entryAdded') consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    else if (msg.method === 'Fetch.requestPaused') {
      // NRCan's services, answered locally: the address lookup and the map tiles.
      const { requestId, request } = msg.params;
      const geo = request.url.startsWith('https://geolocator.api.geo.ca/');
      if (geo) outside.geocode++; else outside.tiles++;
      const body = geo ? Buffer.from(J(GEOCODE_ANSWER)).toString('base64') : TILE;
      send('Fetch.fulfillRequest', { requestId, responseCode: 200, body,
        responseHeaders: [{ name: 'content-type', value: geo ? 'application/json' : 'image/png' }, { name: 'access-control-allow-origin', value: '*' }] }).catch(() => {});
    }
  });
  for (const m of ['Runtime.enable', 'Page.enable', 'Log.enable']) await send(m);
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://geolocator.api.geo.ca/*' }, { urlPattern: 'https://maps-cartes.services.geo.ca/*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await browserSend('Browser.grantPermissions', { permissions: ['geolocation'], origin: ORIGIN, browserContextId });
  const downloads = join(SCRATCH, `downloads-${name}`);
  mkdirSync(downloads, { recursive: true });
  await browserSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
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
    name, send, evaluate, waitFor, consoleLines, downloads,
    async goto(path) { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); await waitFor(`document.readyState === "complete" && location.href.startsWith(${J(ORIGIN)})`, 'load'); },
    fill: (sel, val) => evaluate(`(() => { const el = [...document.querySelectorAll(${J(sel)})].at(-1); if (!el) throw new Error('missing ' + ${J(sel)}); el.value = ${J(String(val))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    click: (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a, [role=button], [role=tab]')].find((b) => (b.textContent.trim() === ${J(text)} || b.getAttribute('aria-label') === ${J(text)}) && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)} + ' in ' + ${J(within)}); el.click(); return true; })()`),
    at: (p, accuracy = 12) => send('Emulation.setGeolocationOverride', { latitude: p.lat, longitude: p.lng, accuracy }),
    async shot(file) { try { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SCRATCH, `${file}.png`), Buffer.from(data, 'base64')); } catch { /* ignore */ } },
    async mouse(type, x, y) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }); },
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
  await p.waitFor('!!document.querySelector(".rail") && !!window.kelbe?.sync && !!window.kelbe?.tracker', 'the app shell');
  await p.waitFor('kelbe.sync.status().state === "synced" && kelbe.sync.status().pulledOnce', 'first sync', 30000);
}
const synced = (p) => p.waitFor('kelbe.sync.syncNow().then(() => kelbe.sync.status().waiting === 0 && kelbe.sync.status().state === "synced")', 'synced', 30000);
const entriesOf = async (emp) => (await superDb.query("SELECT id, data FROM time_entries WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'employeeId' = $2 ORDER BY data->>'clockIn'", [tg, emp])).rows.map((r) => ({ ...r.data, id: r.id }));
const dialogOpen = (title) => `!!document.querySelector('[role=dialog][aria-label=${J(title)}]')`;
const CONSENT = 'Location while you are clocked in';
const csvIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.csv') && !f.endsWith('.crdownload'));

const pages = [];
let exitCode = 0;
let B = null; // site B (J-1002): wherever the foreman drops the pin
try {
  const fore = await openPage('foreman-ipad', { width: 1180, height: 820, mobile: false });
  const jack = await openPage('jackson-phone', { width: 390, height: 844, mobile: true });
  pages.push(fore, jack);

  await step('foreman sets J-1001\'s site from its address', async () => {
    await signIn(fore, people.foreman);
    await fore.evaluate(`location.hash = "#/jobs/${jobIds['J-1001']}"`);
    await fore.waitFor('!!document.querySelector(".loc-site .mm")', 'site card with a map');
    await fore.click('Find address', '.loc-site');
    await fore.waitFor(`kelbe.store.get("jobs", ${J(jobIds['J-1001'])}).site?.source === "geocode"`, 'site saved');
    const s = await fore.evaluate(`kelbe.store.get("jobs", ${J(jobIds['J-1001'])}).site`);
    if (Math.abs(s.lat - A.lat) > 1e-6 || s.radiusM !== 150) throw new Error(J(s));
    await fore.waitFor('document.querySelectorAll(".loc-site .mm-tile").length > 0 && document.querySelector(".loc-site .mm-radius")', 'tiles and the radius circle');
    await fore.shot('01-site-geocoded');
    return `${s.label} (${s.lat}, ${s.lng}), radius ${s.radiusM} m; NRCan lookups answered locally: ${outside.geocode}`;
  });

  await step('foreman drops a pin for J-1002 about 4 km away', async () => {
    await fore.evaluate(`location.hash = "#/jobs/${jobIds['J-1002']}"`);
    await fore.waitFor('!!document.querySelector(".loc-site .mm") && /No site location yet/.test(document.querySelector(".loc-site").innerText)', 'empty site card');
    const box = await fore.evaluate('(() => { const m = document.querySelector(".loc-site .mm"); m.scrollIntoView({ block: "center" }); const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await sleep(200);
    await fore.mouse('mouseMoved', box.x, box.y - 88);
    await fore.mouse('mousePressed', box.x, box.y - 88);
    await fore.mouse('mouseReleased', box.x, box.y - 88);
    await fore.waitFor(`kelbe.store.get("jobs", ${J(jobIds['J-1002'])}).site?.source === "pin"`, 'pin saved');
    B = await fore.evaluate(`kelbe.store.get("jobs", ${J(jobIds['J-1002'])}).site`);
    const km = (Math.hypot((B.lat - A.lat) * 111.195, (B.lng - A.lng) * 111.195 * Math.cos(A.lat * Math.PI / 180))).toFixed(1);
    if (km < 3 || km > 6) throw new Error(`pin ${km} km away`);
    await synced(fore);
    await fore.shot('02-site-pin');
    return `J-1002 pin at (${B.lat}, ${B.lng}), ${km} km from J-1001`;
  });

  await step('Jackson sees the location notice once and clocks in at J-1001 (job picked from where he is)', async () => {
    await jack.at(offset(A, 40, -20), 8);
    await signIn(jack, people.jack);
    await jack.waitFor(`!!kelbe.store.get("jobs", ${J(jobIds['J-1002'])})?.site`, 'job sites synced to the phone');
    await jack.evaluate('location.hash = "#/time"');
    await jack.waitFor('!!document.querySelector(".ops-clock")', 'the clock');
    await jack.fill('select[name=clockJob]', '');
    await jack.click('Clock in', '.ops-clock');
    await jack.waitFor(dialogOpen(CONSENT), 'the notice');
    const notice = await jack.evaluate(`document.querySelector('[role=dialog][aria-label=${J(CONSENT)}]').innerText`);
    if (!/only while you are clocked in/i.test(notice) || !/deleted after 90 days/.test(notice) || !/Live crew map is off/.test(notice)) throw new Error(notice.slice(0, 400));
    await jack.shot('03-notice');
    await jack.click('Allow while clocked in', '[role=dialog]');
    await jack.waitFor(`(() => { const e = kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && !t.clockOut)[0]; return e && e.siteCheck?.inside && e.jobId === ${J(jobIds['J-1001'])}; })()`, 'clocked in to J-1001 from location');
    await jack.waitFor('/at the site/.test(document.querySelector(".ops-clock").innerText)', 'at-the-site badge');
    await jack.shot('04-clocked-in');
    const consents = await jack.evaluate('kelbe.store.list("locationConsents").map((c) => c.choice + " v" + c.policyVersion)');
    return `notice shown, consent ${consents.join(', ')}; entry on J-1001, at the site`;
  });

  await step('leaving the site suggests travel; arriving at J-1002 suggests work there', async () => {
    await sleep(1100);
    await jack.at(offset(A, 900), 15);
    await jack.evaluate('kelbe.tracker.checkNow().then(() => true)');
    await jack.waitFor('/You left J-1001/.test(document.querySelector(".loc-suggest")?.innerText || "")', 'the "you left" suggestion');
    await jack.shot('05-left-site');
    await jack.click('Start travel', '.loc-suggest');
    await jack.waitFor('kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && !t.clockOut && t.kind === "travel").length === 1', 'travelling');
    await jack.waitFor('document.querySelector(".ops-clock")?.dataset.state === "travel"', 'the clock shows travel');
    await sleep(1100);
    await jack.at(offset(B, -30, 10), 10);
    await jack.evaluate('kelbe.tracker.checkNow().then(() => true)');
    await jack.waitFor('/You\'re at J-1002/.test(document.querySelector(".loc-suggest")?.innerText || "")', 'the arrival suggestion');
    await jack.shot('06-arrived');
    await jack.click('Start work here', '.loc-suggest');
    await jack.waitFor(`kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && !t.clockOut && t.kind === "work" && t.jobId === ${J(jobIds['J-1002'])}).length === 1`, 'working at J-1002');
    await sleep(1100);
    await jack.click('Clock out', '.ops-clock');
    await jack.waitFor('!kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && !t.clockOut).length', 'clocked out');
    await synced(jack);
    const rows = await entriesOf('emp-jack');
    const shape = rows.map((r) => `${r.kind}:${r.jobId === jobIds['J-1001'] ? 'J-1001' : r.jobId === jobIds['J-1002'] ? 'J-1002' : r.jobId}`);
    if (J(shape) !== J(['work:J-1001', 'travel:J-1002', 'work:J-1002'])) throw new Error(J(shape));
    if (rows[1].travelFromJobId !== jobIds['J-1001']) throw new Error('travel should come from J-1001');
    for (let i = 1; i < rows.length; i++) if (rows[i].clockIn !== rows[i - 1].clockOut) throw new Error('gap or overlap between parts');
    const pts = (await jack.evaluate('kelbe.store.list("locationPoints").map((p) => p.source)')).sort();
    return `server has ${shape.join(' → ')}, back to back; points on the phone: ${pts.join(', ')}`;
  });

  await step('clocking in 4.2 km from the job is flagged, and the notice is not shown again', async () => {
    await jack.at(offset(A, -4200), 9);
    await jack.waitFor('!!document.querySelector("select[name=clockJob]")', 'the clock, off');
    await jack.fill('select[name=clockJob]', jobIds['J-1001']);
    await jack.click('Clock in', '.ops-clock');
    await jack.waitFor('kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && !t.clockOut && t.flag).length === 1', 'flagged entry');
    if (await jack.evaluate(dialogOpen(CONSENT))) throw new Error('the notice came back');
    await jack.waitFor('/4\\.2 km from the job site/.test(document.querySelector(".ops-clock").innerText)', 'the flag on the clock');
    await jack.shot('07-off-site');
    await sleep(800);
    await jack.click('Clock out', '.ops-clock');
    await jack.waitFor('!kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && !t.clockOut).length', 'clocked out again');
    // A full Monday on J-1001 this week, so the timesheet and payroll have real hours (10 h: 2 h overtime in Manitoba).
    await jack.evaluate(`(() => { const d = new Date(); const dow = (d.getDay() + 6) % 7; const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow, 7, 0); const e = new Date(m.getTime() + 10 * 3600e3);
      kelbe.store.add("timeEntries", { employeeId: "emp-jack", jobId: ${J(jobIds['J-1001'])}, kind: "work", clockIn: m.toISOString(), clockOut: e.toISOString(), breakMins: 0, approved: false, source: "manual", note: "" }); return true; })()`);
    await synced(jack);
    const consents = (await superDb.query('SELECT count(*)::int AS n FROM location_consents WHERE tenant_id = $1', [tg])).rows[0].n;
    const flag = (await entriesOf('emp-jack')).find((e) => e.flag)?.flag;
    return `flag "${flag.text}"; consent records on the server: ${consents}`;
  });

  await step('Jackson sees his own location records, on a phone-width page', async () => {
    await jack.evaluate('location.hash = "#/time/location"');
    await jack.waitFor('/Your location records/.test(document.querySelector("main").innerText) && document.querySelectorAll(".loc-day .list-row").length >= 6', 'my location list');
    const txt = await jack.evaluate('document.querySelector("main").innerText');
    if (!/Allowed while you are clocked in/.test(txt) || !/Only you can see these/.test(txt)) throw new Error(txt.slice(0, 300));
    const listed = await jack.evaluate('document.querySelectorAll(".loc-day .list-row").length');
    for (const hash of ['#/time/location', '#/time', '#/time/week']) {
      await jack.evaluate(`location.hash = ${J(hash)}`);
      await sleep(400);
      const over = await jack.evaluate('document.documentElement.scrollWidth - window.innerWidth');
      if (over > 1) throw new Error(`${hash} scrolls sideways by ${over}px at 390 px`);
    }
    await jack.shot('08-my-week-phone');
    const serverPoints = (await superDb.query('SELECT count(*)::int AS n FROM location_points WHERE tenant_id = $1', [tg])).rows[0].n;
    return `${listed} records listed; ${serverPoints} on the server; no sideways scroll at 390 px`;
  });

  await step('foreman reviews the off-site clock-in', async () => {
    await synced(fore);
    await fore.evaluate('location.hash = "#/time"');
    await fore.waitFor('/Off-site clock-ins to review \\(1\\)/.test(document.querySelector("main").innerText)', 'review list');
    await fore.shot('09-review');
    await fore.click('Reviewed', 'main');
    await fore.waitFor(dialogOpen('Review off-site clock-in'), 'review dialog');
    await fore.fill('[role=dialog] input', 'Picked up wire at the supply house first');
    await fore.click('Mark reviewed', '[role=dialog]');
    await fore.waitFor('!/Off-site clock-ins to review/.test(document.querySelector("main").innerText)', 'nothing left to review');
    await synced(fore);
    const flag = (await entriesOf('emp-jack')).find((e) => e.flag)?.flag;
    if (!flag?.reviewedAt || flag.reviewedBy !== foremanEmp) throw new Error(J(flag));
    return `reviewed: "${flag.reviewNote}"`;
  });

  await step('the week: work and travel per person, approve everyone in one tap', async () => {
    await fore.evaluate('location.hash = "#/time/week"');
    await fore.waitFor('!!document.querySelector(".time-crew tr[data-emp=emp-jack]")', 'crew week');
    const row = await fore.evaluate('document.querySelector(".time-crew tr[data-emp=emp-jack]").innerText.replace(/\\s+/g, " ")');
    await fore.shot('10-week');
    await fore.click(await fore.evaluate('[...document.querySelectorAll("main button")].find((b) => /^Approve week for everyone/.test(b.textContent.trim())).textContent.trim()'), 'main');
    await fore.waitFor('kelbe.store.list("timeEntries", (t) => t.employeeId === "emp-jack" && t.clockOut).every((t) => t.approved)', 'approved');
    await synced(fore);
    const server = await entriesOf('emp-jack');
    if (!server.every((e) => e.approved && e.approvedBy === foremanEmp)) throw new Error('not approved on the server');
    await fore.evaluate('location.hash = "#/time/week?who=emp-jack"');
    await fore.evaluate('(() => { const s = document.querySelector("select[name=who]"); s.value = "emp-jack"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    await fore.waitFor('/overtime/i.test(document.querySelector(".time-stats")?.innerText || "")', 'Jackson\'s sheet');
    const stats = await fore.evaluate('document.querySelector(".time-stats").innerText.replace(/\\s+/g, " ")');
    if (!/overtime 2\.\d\d/i.test(stats)) throw new Error(stats);
    await fore.shot('11-jackson-week');
    return `${row} | ${stats}`;
  });

  await step('payroll CSVs: Wagepoint, QuickBooks entry sheet, generic', async () => {
    await fore.evaluate('location.hash = "#/time/week"');
    await fore.evaluate('(() => { const s = document.querySelector("select[name=who]"); s.value = "all"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    await fore.waitFor('!!document.querySelector("select[name=payrollFormat]")', 'export controls');
    const files = {};
    for (const f of ['wagepoint', 'qbo', 'generic']) {
      const before = new Set(csvIn(fore.downloads));
      await fore.fill('select[name=payrollFormat]', f);
      await fore.click('Export CSV', 'main');
      await sleep(300);
      if (await fore.evaluate('!!document.querySelector("[role=dialog]")')) await fore.click('OK', '[role=dialog]');
      const end = Date.now() + 10000;
      let name;
      while (!name && Date.now() < end) { name = csvIn(fore.downloads).find((x) => !before.has(x)); if (!name) await sleep(200); }
      if (!name) throw new Error(`no ${f} file`);
      files[f] = readFileSync(join(fore.downloads, name), 'utf8');
    }
    const wp = files.wagepoint.split('\r\n');
    if (wp[0] !== 'Employee ID,Employee Name,Job ID,Job Name,Regular Hours,Overtime Hours,Double Time Hours') throw new Error(wp[0]);
    if (!wp.some((l) => /^1042,Jackson Pike,J-1001,Operatory buildout,8(\.\d+)?,2(\.\d+)?,0$/.test(l))) throw new Error(files.wagepoint);
    if (!wp.some((l) => l.startsWith('1042,Jackson Pike,J-1002,'))) throw new Error('no J-1002 row');
    const gen = files.generic.split('\r\n');
    if (!gen[0].startsWith('employee_id,employee_name,period_start,period_end,work_date,job_code')) throw new Error(gen[0]);
    if (!gen.some((l) => /,J-1002,Panel upgrade 100A to 200A,[^,]*,travel,/.test(l))) throw new Error('no travel row in the generic file');
    if (!files.qbo.startsWith('Employee,Employee ID,Date,Customer,Job,Type,Regular hours,Overtime hours')) throw new Error(files.qbo.slice(0, 120));
    writeFileSync(join(SCRATCH, 'payroll-generic.csv'), files.generic);
    return `wagepoint ${wp.length - 2} rows, qbo ${files.qbo.split('\r\n').length - 2}, generic ${gen.length - 2}; e.g. ${wp.find((l) => l.startsWith('1042,Jackson Pike,J-1001'))}`;
  });

  await step('dashboard tile: hours this week by person (work / travel)', async () => {
    await fore.evaluate('location.hash = "#/dashboard"');
    await fore.waitFor('/Hours this week by person/.test(document.querySelector(".time-tile")?.innerText || "")', 'the tile');
    const tile = await fore.evaluate('document.querySelector(".time-tile").innerText.replace(/\\s+/g, " ")');
    if (!/Jackson/.test(tile)) throw new Error(tile);
    await fore.shot('12-dashboard');
    return tile;
  });

  await step('the server keeps raw points to their owner and the live map off', async () => {
    fore.probeFrom = fore.consoleLines.length; // Chrome logs the 403 below as a failed load
    const live = await fore.evaluate('fetch("/api/v1/location/live").then((r) => r.status)');
    const others = await fore.evaluate('fetch("/api/v1/locationPoints?limit=100").then((r) => r.json()).then((b) => b.data.filter((p) => p.employeeId === "emp-jack").length)');
    if (live !== 403 || others !== 0) throw new Error(J({ live, others }));
    return `live map ${live} (off by default); Jackson's points visible to the foreman: ${others}; tiles served locally: ${outside.tiles}`;
  });
} catch {
  exitCode = 1;
} finally {
  const all = [];
  for (const p of pages) {
    const errs = p.consoleLines.map((l, i) => ({ l, i })).filter(({ l, i }) => /^\[(error|exception|assert|warning)\]/.test(l)
      || (/^\[log:(error|warning)\]/.test(l) && !(p.probeFrom != null && i >= p.probeFrom && /Failed to load resource/.test(l)) && !/api\/v1\/(me|auth\/providers)/.test(l)));
    all.push(...errs.map(({ l }) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'location-e2e-results.json'), J({ results, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`browser console errors and warnings: ${all.length}`);
  for (const e of all.slice(0, 20)) console.log('   ', e.slice(0, 300));
  if (all.length) exitCode = 1;
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  web.close();
  try { await api.close(); } catch { /* ignore */ }
  await db.close?.();
  await ownerClient.end(); await superDb.end();
  await pgServer.stop();
  await sleep(500);
  try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* Windows may hold files */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
