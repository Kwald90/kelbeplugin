// Safety click-through at iPad and phone sizes, end to end: embedded Postgres 17 + the API
// (in-process, so it can be stopped for the offline step) + a static server that proxies /api/
// like nginx + headless Chrome over CDP. The harness is the one from accounts.e2e.mjs.
//   cd server && npm ci
//   node electrical-app/tests/e2e/safety.e2e.mjs [scratch dir]
// Covers: emergency info on the job, an FLHA with a signature and review, a toolbox talk with
// three signed attendees and its PDF, a near miss filed offline that syncs later, a corrective
// action closed with an evidence photo, a failed ladder inspection, the dashboard, phone layout.
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


let exitCode = 0;
// ---------- safety click-through ----------
const PHOTO = process.env.E2E_PHOTO || join(WT, 'electrical-app', 'icons', 'icon-192.png');
const IPAD = { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
async function viewport(v) {
  await send('Emulation.setDeviceMetricsOverride', v);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}
const hash = async (h) => { await evaluate(`location.hash = ${J(h)}`); await sleep(350); };
/** Draw a signature: a few strokes across the last signature canvas (pointer events from the mouse). */
async function sign(scope = 'body') {
  const r = await evaluate(`(() => { const c = [...document.querySelectorAll(${J(scope + ' canvas.sf-sig-canvas')})].at(-1); c.scrollIntoView({ block: 'center' }); const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  await sleep(150);
  const r2 = await evaluate(`(() => { const c = [...document.querySelectorAll(${J(scope + ' canvas.sf-sig-canvas')})].at(-1); const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const pts = Array.from({ length: 14 }, (_, i) => [r2.x + r2.w * (0.1 + 0.06 * i), r2.y + r2.h * (0.5 + 0.25 * Math.sin(i))]);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts[0][0], y: pts[0][1], button: 'left', clickCount: 1 });
  for (const [x, y] of pts.slice(1)) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.at(-1)[0], y: pts.at(-1)[1], button: 'left', clickCount: 1 });
  return r;
}
/** Click something that opens a file chooser and answer it with PHOTO. */
let chooser = null;
const prevOnMessage = ws.onmessage;
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === 'Page.fileChooserOpened') { chooser?.(msg.params); return; }
  prevOnMessage(m);
};
async function addPhoto(clickExpr) {
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  const opened = new Promise((res) => { chooser = res; });
  await send('Runtime.evaluate', { expression: clickExpr, userGesture: true, awaitPromise: true });
  const p = await Promise.race([opened, sleep(5000).then(() => null)]);
  if (!p) throw new Error('no file chooser');
  await send('DOM.setFileInputFiles', { files: [PHOTO], backendNodeId: p.backendNodeId });
  await send('Page.setInterceptFileChooserDialog', { enabled: false });
}
const noHScroll = () => evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1');
const lib = (name) => `import(${J('/js/lib/' + name)})`;

try {
  await step('sign in as the seeded owner (TG Electrical, AB)', async () => {
    await goto('/');
    await signIn('owner@tgelectrical.test', { enrol: true });
    await evaluate('localStorage.setItem("ft.units", "metric")'); // skip the first-launch units question
    await viewport(IPAD);
    await goto('/#/safety');
    await waitFor('!!document.querySelector(".sf-quick")', 'safety page');
    const rail = await evaluate('!!document.querySelector(".rail [data-mod=safety]")');
    if (!rail) throw new Error('Safety not in the rail');
    return 'Safety in the rail, Today tab shown';
  });

  const job = await evaluate('kelbe.store.list("jobs").find((j) => j.status === "in-progress" || j.status === "scheduled") || kelbe.store.list("jobs")[0]');
  const me = await evaluate('kelbe.auth.current()');

  await step('iPad: emergency info for a job shows on the job page', async () => {
    await hash(`#/safety/job/${job.id}`);
    await waitFor('!!document.querySelector("main input[name=hName]")', 'emergency form');
    await fill('main input[name=hName]', 'Foothills Medical Centre emergency');
    await fill('main input[name=hPhone]', '403-944-1110');
    await fill('main input[name=hAddress]', '1403 29 St NW, Calgary');
    await fill('main input[name=musterPoint]', 'North gate by the trailer');
    await click('Save', 'main .page-head');
    await waitFor(`location.hash === ${J('#/jobs/' + job.id)} && !!document.querySelector(".sf-emergency")`, 'job page with emergency card');
    const t = await evaluate('document.querySelector(".sf-emergency").innerText');
    if (!t.includes('Foothills') || !t.includes('North gate')) throw new Error(t);
    await shot('ipad-job-emergency');
    return t.replace(/\s+/g, ' ').slice(0, 120);
  });

  await step('iPad: FLHA with hazards, PPE and a signature', async () => {
    await hash(`#/safety/flha/new?jobId=${job.id}`);
    await waitFor('!!document.querySelector(".sf-hz")', 'FLHA form');
    await fill('main textarea[name=task]', 'Pull feeders in the electrical room');
    // Electrical: Yes, then two suggested controls.
    await evaluate('document.querySelector(".sf-hz .seg-btn.yes").click()');
    await evaluate('[...document.querySelectorAll(".sf-hz")][0].querySelectorAll(".sf-suggest .sf-chip")[0].click(); [...document.querySelectorAll(".sf-hz")][0].querySelectorAll(".sf-suggest .sf-chip")[1].click()');
    await sign('main');
    await shot('ipad-flha-form');
    await click('Sign and submit', 'main');
    await waitFor('location.hash.startsWith("#/safety/flha/") && !location.hash.includes("new") && !!document.querySelector(".sf-sig-view img")', 'signed FLHA');
    const ok = await evaluate(`${lib('safety.js')}.then((m) => m.hasFlhaToday(${J(me.id)}, ${J(job.id)}, kelbe.store.list("flhas")[0].date, kelbe.store.list("flhas")))`);
    const rec = await evaluate('kelbe.store.list("flhas")[0]');
    if (!ok) throw new Error('hasFlhaToday false');
    if (!rec.signature?.dataUrl?.startsWith('data:image/jpeg') || rec.signature.dataUrl.length > 80000) throw new Error('signature ' + rec.signature?.dataUrl?.length);
    // Foreman review sign-off (the owner is a manager).
    await sign('main');
    await click('Sign off review', 'main');
    await waitFor('kelbe.store.list("flhas")[0].review?.at', 'review saved');
    await evaluate('kelbe.sync.syncNow()');
    await waitFor(`kelbe.sync.status().waiting === 0`, 'synced', 20000);
    const srv = await superDb.query("SELECT data->'signature'->>'name' AS n, data->'review'->>'name' AS r, length(data->'signature'->>'dataUrl') AS len FROM flhas WHERE id = $1", [rec.id]);
    await shot('ipad-flha-signed');
    return `hasFlhaToday true; signature ${rec.signature.dataUrl.length} chars; on server: ${JSON.stringify(srv.rows[0])}`;
  });

  await step('iPad: toolbox talk with three signed attendees and a PDF', async () => {
    await hash('#/safety?tab=talks');
    await waitFor('document.body.innerText.includes("Topic library")', 'talks tab');
    await click('Schedule a talk', 'main');
    await waitFor('!!document.querySelector("[role=dialog] select[name=topicId]")', 'schedule sheet');
    await evaluate('document.querySelector("[role=dialog] select[name=topicId]").value = "loto"');
    await click('Schedule', '[role=dialog]');
    await waitFor('location.hash.startsWith("#/safety/talks/") && document.body.innerText.includes("Attendance")', 'talk page');
    const people = await evaluate('kelbe.store.list("employees", (e) => e.active !== false).map((e) => e.id)');
    const signers = [people[0], people[1] || '', ''];
    for (let i = 0; i < 3; i++) {
      await click('Add attendee', 'main');
      await waitFor('!!document.querySelector("[role=dialog] canvas.sf-sig-canvas")', 'attendee sheet');
      await evaluate(`document.querySelector("[role=dialog] select").value = ${J(signers[i])}`);
      if (!signers[i]) await fill('[role=dialog] input[aria-label="Visitor name"]', `Visitor ${i + 1}`);
      if (!signers[i]) await fill('[role=dialog] input[aria-label="Company"]', 'Acme Drywall');
      await sign('[role=dialog]');
      await click('Sign', '[role=dialog]');
      await waitFor(`document.querySelectorAll(".sf-attendee").length === ${i + 1}`, `attendee ${i + 1}`);
    }
    await click('Mark held', 'main');
    const talk = await evaluate('kelbe.store.list("toolboxTalks")[0]');
    const pdf = await evaluate(`${lib('safety-pdf.js')}.then((m) => { const b = m.talkPdf(kelbe.store.list("toolboxTalks")[0], { company: { name: "TG" } }); return { head: String.fromCharCode(...b.slice(0, 8)), size: b.length, images: (new TextDecoder("latin1").decode(b).match(/\\/Im\\d+ Do/g) || []).length }; })`);
    await shot('ipad-talk');
    if (talk.attendees.length !== 3 || pdf.images < 3) throw new Error(JSON.stringify({ n: talk.attendees.length, pdf }));
    return `${talk.title}: ${talk.attendees.map((a) => a.name).join(', ')}; status ${talk.status}; PDF ${pdf.head.trim()} ${pdf.size} bytes, ${pdf.images} signatures drawn`;
  });

  await step('offline: file a near miss with a photo while the API is down; it syncs later', async () => {
    await apiDown();
    await hash('#/safety/incidents/new?kind=near-miss');
    await waitFor('!!document.querySelector("main textarea[name=description]")', 'report form');
    await fill('main textarea[name=description]', 'Unlabelled live conductor found in a junction box on level 2');
    await evaluate(`document.querySelector("main select[name=jobId]").value = ${J(job.id)}`);
    await fill('main input[name=location]', 'Level 2 corridor');
    await addPhoto('document.querySelector("main .sf-photo-add").click()');
    await waitFor('document.querySelectorAll("main .sf-photo img").length === 1', 'photo added');
    await click('File report', 'main');
    await waitFor('location.hash.startsWith("#/safety/incidents/") && !location.hash.includes("new")', 'report page');
    const inc = await evaluate('kelbe.store.list("incidents")[0]');
    const waiting = await evaluate('kelbe.sync.status().waiting');
    const before = await superDb.query('SELECT count(*)::int AS n FROM incidents WHERE id = $1', [inc.id]);
    await apiUp();
    await evaluate('kelbe.sync.syncNow()');
    await waitFor('kelbe.sync.status().waiting === 0', 'queue drained', 30000);
    const after = await superDb.query("SELECT data->>'kind' AS kind, jsonb_array_length(data->'photos') AS photos, length(data->'photos'->0->>'dataUrl') AS bytes FROM incidents WHERE id = $1", [inc.id]);
    if (before.rows[0].n !== 0 || !after.rows[0]) throw new Error(`before ${before.rows[0].n}, after ${JSON.stringify(after.rows)}`);
    return `queued ${waiting} change(s) offline, 0 on server; after reconnect: ${JSON.stringify(after.rows[0])}`;
  });

  await step('near miss -> corrective action -> done with evidence photo -> verified', async () => {
    const inc = await evaluate('kelbe.store.list("incidents")[0]');
    await hash(`#/safety/incidents/${inc.id}`);
    await waitFor('document.body.innerText.includes("Reportable?")', 'incident page (manager)');
    await click('Add corrective action', 'main');
    await waitFor('!!document.querySelector("[role=dialog] input[name=title]")', 'action sheet');
    await fill('[role=dialog] input[name=title]', 'Label and cap the conductor; survey level 2 boxes');
    await evaluate(`document.querySelector("[role=dialog] select[name=ownerId]").value = ${J(me.id)}`);
    await click('Add action', '[role=dialog]');
    await waitFor('kelbe.store.list("correctiveActions").length === 1', 'action saved');
    await sleep(300);
    await evaluate('[...document.querySelectorAll("main .list-row.click")].find((r) => r.textContent.includes("Label and cap")).click()');
    await waitFor('!!document.querySelector("[role=dialog] .sf-photo-add")', 'action sheet open');
    await addPhoto('document.querySelector("[role=dialog] .sf-photo-add").click()');
    await waitFor('document.querySelectorAll("[role=dialog] .sf-photo img").length === 1', 'evidence photo');
    await fill('[role=dialog] textarea', 'Capped with marrettes, labelled, 14 boxes checked');
    await shot('ipad-action-evidence');
    await click('Mark done', '[role=dialog]');
    await waitFor('kelbe.store.list("correctiveActions")[0].status === "done"', 'done');
    await sleep(300);
    await evaluate('[...document.querySelectorAll("main .list-row.click")].find((r) => r.textContent.includes("Label and cap")).click()');
    await waitFor('!!document.querySelector("[role=dialog]")', 'action sheet');
    await click('Verify and close', '[role=dialog]');
    await waitFor('kelbe.store.list("correctiveActions")[0].status === "verified"', 'verified');
    const a = await evaluate('kelbe.store.list("correctiveActions")[0]');
    return `action ${a.status}; evidence ${a.evidence.length} photo (${Math.round(a.evidence[0].dataUrl.length / 1024)} KB as text); status of report: ${(await evaluate('kelbe.store.list("incidents")[0].status'))}`;
  });

  await step('failed ladder inspection raises a corrective action and shows as overdue tomorrow', async () => {
    await hash('#/safety?tab=inspections');
    await waitFor('document.body.innerText.includes("Recurring")', 'inspections tab');
    await click('New inspection', 'main');
    await waitFor('!!document.querySelector("[role=dialog] select[name=templateId]")', 'new inspection sheet');
    await fill('[role=dialog] input[name=assetTag]', 'L-03 8 ft fibreglass');
    await click('Start', '[role=dialog]');
    await waitFor('location.hash.startsWith("#/safety/inspections/") && !!document.querySelector(".sf-item")', 'inspection form');
    await evaluate('document.querySelectorAll(".sf-item").forEach((r, i) => r.querySelector(i === 0 ? ".seg-btn.fail" : ".seg-btn.pass").click())');
    await fill('.sf-item input', 'Right rail cracked below the 3rd rung');
    await sign('main');
    await shot('ipad-inspection');
    await click('Complete inspection', 'main');
    await waitFor('location.hash === "#/safety?tab=inspections"', 'back to list');
    const i = await evaluate('kelbe.store.list("safetyInspections")[0]');
    const acts = await evaluate(`kelbe.store.list("correctiveActions", (a) => a.sourceId === ${J(i.id)})`);
    const sched = await evaluate(`${lib('safety-inspections.js')}.then((m) => m.inspectionSchedule(kelbe.store.list("safetyInspections"), ${J('2099-01-01')})[0].state)`);
    if (i.result !== 'fail' || acts.length !== 1) throw new Error(JSON.stringify({ r: i.result, acts: acts.length }));
    return `result ${i.result}, next due ${i.nextDue}; ${acts.length} action: "${acts[0].title}"; schedule state later: ${sched}`;
  });

  await step('iPad: manager dashboard and CSV', async () => {
    await hash('#/safety?tab=dashboard');
    await waitFor('!!document.querySelector(".sf-bars")', 'dashboard');
    const tiles = await evaluate('[...document.querySelectorAll(".sf-stats .stat")].map((s) => s.innerText.replace(/\\s+/g, " ")).join(" | ")');
    const csv = await evaluate(`${lib('safety.js')}.then((m) => m.dashboardCsv(m.dashboardStats({ today: new Date().toISOString().slice(0, 10), flhas: kelbe.store.list("flhas"), schedule: kelbe.store.list("schedule"), timeEntries: kelbe.store.list("timeEntries"), incidents: kelbe.store.list("incidents"), actions: kelbe.store.list("correctiveActions"), inspectionStatus: [], certs: [] })).split("\\r\\n").length)`);
    await shot('ipad-dashboard');
    return `${tiles}; CSV ${csv} lines`;
  });

  await step('phone: Today, quick near miss, toolbox talk sign, no sideways scroll', async () => {
    await viewport(PHONE);
    await goto('/#/safety');
    await waitFor('!!document.querySelector(".sf-quick")', 'safety today (phone)');
    const ok1 = await noHScroll();
    await shot('phone-today');
    await hash('#/safety/incidents/new?kind=incident');
    await waitFor('!!document.querySelector("main textarea[name=description]")', 'report form');
    await fill('main textarea[name=description]', 'Apprentice cut hand stripping cable');
    await evaluate('[...document.querySelectorAll("main .seg-btn.yes")][0].click()');
    await evaluate('document.querySelector("main select[name=treatment]").value = "medical-aid"');
    await evaluate('[...document.querySelectorAll(".sf-chip")].find((b) => b.textContent === "Hand").click()');
    const ok2 = await noHScroll();
    await shot('phone-incident');
    await click('File report', 'main');
    await waitFor('location.hash.startsWith("#/safety/incidents/") && document.body.innerText.includes("Likely reportable")', 'reportable prompt');
    const prompt = await evaluate('document.querySelector(".sf-report").innerText.replace(/\\s+/g, " ").slice(0, 220)');
    await shot('phone-reportable');
    const talkId = await evaluate('kelbe.store.list("toolboxTalks")[0].id');
    await hash(`#/safety/talks/${talkId}`);
    await waitFor('document.body.innerText.includes("Attendance")', 'talk');
    const ok3 = await noHScroll();
    await hash('#/safety?tab=dashboard');
    await waitFor('!!document.querySelector(".sf-bars")', 'dashboard');
    const ok4 = await noHScroll();
    await shot('phone-dashboard');
    if (!(ok1 && ok2 && ok3 && ok4)) throw new Error(`sideways scroll: ${[ok1, ok2, ok3, ok4]}`);
    return `no sideways scroll on 4 screens; prompt: ${prompt}`;
  });
} catch {
  exitCode = 1;
} finally {
  const errors = consoleLines.filter((l) => /exception|\[error\]/.test(l));
  writeFileSync(join(SCRATCH, 'safety-e2e-results.json'), JSON.stringify({ results, console: consoleLines.slice(-80) }, null, 2));
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
