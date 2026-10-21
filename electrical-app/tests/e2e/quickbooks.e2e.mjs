// QuickBooks end to end (docs/integrations/quickbooks.md 11.5): embedded Postgres 17 + the real API
// (in-process, every /api/v1/qbo route) + the real QuickBooks worker jobs running in-process (the
// dispatcher, qbo_sync, qbo_reference_refresh, qbo_setup_scan, qbo_setup_apply, qbo_cdc, qbo_check)
// + a static server that proxies /api/ like nginx + the fake QuickBooks (server/test/support/fake-qbo.js)
// in HTTP mode + headless Chrome over CDP. Nothing answers for the server: QuickBooks-side changes are
// made in the fake and arrive by a signed webhook, exactly as Intuit's would.
//
//   owner on a desktop (1280 x 800): connects (ticket, interstitial, consent, callback), walks the
//     wizard (settings with a practice week, tax codes with the old 8% code refused, matching, the
//     Review step refusing Apply until every difference has a side), applies; practice mode shows the
//     "would change" list and writes nothing; goes live; on the mappings screen an option typed in
//     survives a code change and is saved; resolves a conflict; picks "Why no tax?"; sees a
//     settlement payment read-only; enters a supplier bill that gets its QuickBooks badge and no
//     Mark paid.
//   office user on a phone (390 x 844, no two-step sign-in): reads the status, gets mfa_required on
//     Sync now; sends an invoice and its badge reaches "In QuickBooks"; a QuickBooks-side change
//     arrives by signed webhook and shows on the invoice; a change pulled while the invoice is open
//     is not written back by the next keystroke; the practice switch is an owner's.
//   foreman on a phone: no QuickBooks in the rail, "No access", no badges, 403 from /api/v1/qbo/status.
//   Release 1 (r1-get-paid.md 12.2): a holdback invoice and its release, a deposit, a credit note and an
//     RST recoverable bill go through the fake QuickBooks; a credit memo applied to one invoice comes back
//     as a credit note and its application; a QuickBooks edit of an invoice in a closed month goes to
//     review and the owner keeps it as a noted difference (with the note) on the conflict screen.
//   layout: the overview, the wizard's Review step, mappings, a conflict, an invoice with its badge and
//     a purchasing bill at 390 px and 1280 px, with no sideways scroll (screenshots in the scratch dir).
//
//   cd server && npm install
//   node electrical-app/tests/e2e/quickbooks.e2e.mjs [scratch dir]
// CHROME_PATH overrides the Chrome binary. Not part of `node --test electrical-app/tests/*.test.mjs`.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, extname, normalize, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-qbo-e2e-'));
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
const { createSealer } = await mod('src/lib/crypto.js');
const { createRecords } = await mod('src/services/records.js');
const { createValidator } = await mod('src/schemas.js');
const { systemPrincipal, systemWho } = await mod('src/integrations/state.js');
const { runOnce, QBO_KIND_PATTERN } = await mod('src/services/queue.js');
const { createQboHandlers, dispatch } = await mod('src/qbo/jobs.js');
const { createFakeQbo } = await mod('test/support/fake-qbo.js');

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

// ---------- Postgres, fake QuickBooks, API, worker, static + proxy ----------
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
const db = createDb({ app: createPool(dbUrl('fishtape_app', roles.app_password), { max: 12 }) });
await seed({ db, ownerClient, log: () => {} });

const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;
await superDb.query("UPDATE tenants SET province = 'MB', plan = 'pro' WHERE id = $1", [tg]).catch(() => superDb.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [tg]));
await superDb.query("INSERT INTO employees (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'emp-fred', $2, 'system:e2e', 'system:e2e')",
  [tg, { name: 'Fred Foreman', role: 'foreman', active: true, color: '#1d7044', email: '', phone: '', rateCents: 5200 }]);
const people = {};
async function addUser(key, email, name, role, employeeId = null) {
  const password = `pw-${randomBytes(10).toString('hex')}`;
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash, password_changed_at) VALUES ($1, $2, $3, now()) RETURNING id', [email, name, await hashSecret(password)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [tg, u.rows[0].id, role, employeeId]);
  people[key] = { email, password, userId: u.rows[0].id };
}
{
  const password = `pw-${randomBytes(10).toString('hex')}`;
  await superDb.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE email = $1', ['owner@tgelectrical.test', await hashSecret(password)]);
  people.owner = { email: 'owner@tgelectrical.test', password };
  await addUser('office', 'olive@tgelectrical.test', 'Olive Office', 'office');
  await addUser('fred', 'fred@tgelectrical.test', 'Fred Foreman', 'foreman', 'emp-fred');
}

const fake = createFakeQbo();
const REALM = '9130350000000771';
fake.addCompany(REALM, { name: 'TG Electrical Ltd.' });
const fakeHttp = await fake.listen();
const S = fake.seed(REALM);
const VERIFIER = `verifier-${randomBytes(8).toString('hex')}`;
const MASTER = randomBytes(32).toString('base64');

const apiPort = await freePort();
const webPort = await freePort();
const ORIGIN = `http://localhost:${webPort}`;
const config = readConfig({
  APP_ENV: 'local', PUBLIC_ORIGIN: ORIGIN, DATABASE_URL: dbUrl('fishtape_app', roles.app_password), RATE_LIMIT: 'off', LOG_LEVEL: 'warn', PORT: String(apiPort),
  SECRETS_MASTER_KEY: MASTER, QBO_ENVIRONMENT: 'sandbox', QBO_CLIENT_ID: fake.app.clientId, QBO_CLIENT_SECRET: fake.app.clientSecret,
  QBO_WEBHOOK_VERIFIER: VERIFIER, QBO_API_BASE: fakeHttp.apiBase, QBO_OAUTH_BASE: fakeHttp.oauthBase,
});
const sealer = createSealer(config.secretsMasterKey);
const records = createRecords({ validator: createValidator(), config });
const setupP = systemPrincipal(tg, 'e2e', 'E2E set-up');
const asSetup = (fn) => db.withTenant({ tenantId: tg }, (tx) => fn(tx, setupP, systemWho(setupP)), { write: true });

// What QuickBooks already holds before Fishtape connects (6.3): the clinic by its email (with a phone
// and an address that differ), the residence by its name only, a QuickBooks-only customer with an open
// invoice, and the clinic's October invoice keyed in by hand under QuickBooks' own number.
const tgClients = (await superDb.query("SELECT id, data FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL", [tg])).rows;
const clinic = tgClients.find((c) => /Dental Clinic$/.test(c.data.name));
const residence = tgClients.find((c) => /Residence$/.test(c.data.name));
const labourLine = (amount, code = S.taxCodes.gstPst.Id) => ({ DetailType: 'SalesItemLineDetail', Amount: amount, SalesItemLineDetail: { ItemRef: { value: S.items.labour.Id }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: code } } });
const qClinic = fake.create(REALM, 'Customer', { DisplayName: clinic.data.name, CompanyName: clinic.data.name, PrimaryEmailAddr: { Address: clinic.data.email }, PrimaryPhone: { FreeFormNumber: '204-555-0199' }, BillAddr: { Line1: '42 Harbour Street', City: 'Winnipeg', CountrySubDivisionCode: 'MB', PostalCode: 'R3C 1A1' } });
fake.create(REALM, 'Customer', { DisplayName: residence.data.name });
const qPrairie = fake.create(REALM, 'Customer', { DisplayName: 'Prairie Co-op', CompanyName: 'Prairie Co-op Ltd', PrimaryEmailAddr: { Address: 'ap@prairie.example' } });
fake.create(REALM, 'Invoice', { CustomerRef: { value: qPrairie.Id }, DocNumber: '1040', TxnDate: '2026-10-01', DueDate: '2026-10-31', Line: [labourLine(300)] });
fake.create(REALM, 'Invoice', { CustomerRef: { value: qClinic.Id }, DocNumber: '1043', TxnDate: '2026-10-03', DueDate: '2026-11-02', Line: [labourLine(1000)] });
const MB_TAXES = [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }, { id: 'RST', label: 'RST', pct: 7, applies: { material: true, labour: true, other: true } }];
await asSetup((tx, p, who) => records.createRecord(tx, p, 'invoices', {
  id: 'inv-rekeyed', number: 'INV-2990', clientId: clinic.id, status: 'sent', issueDate: '2026-10-02', dueDate: '2026-11-01',
  lines: [{ description: 'Operatory rough-in', qty: 1, unitCents: 100000, kind: 'labour', labourHours: 0 }], taxProvince: 'MB', taxTreatment: 'pst-all', taxes: MB_TAXES, taxPct: 12, notes: '',
}, who));
log('seeded TG Electrical (Manitoba, Pro) with an owner, an office user and a foreman; QuickBooks holds 3 customers and 2 invoices');

let api = null;
api = await buildApp({ config, db });
await api.listen({ port: apiPort, host: '127.0.0.1' });
log('API up');

// The QuickBooks worker pool (worker.js), in this process: the jobs it claims are the real handlers.
// Debounces (20 s outbox, continuations) are brought forward so the run does not wait on timers.
const qboHandlers = createQboHandlers({ sealer, config, records, workerId: 'e2e-worker' });
const quiet = { info: () => {}, error: (m) => log('job error', m) };
const worker = { held: false, stop: false, busy: false, runs: [], failed: [] };
// Only the short timers (the 20 s debounce, 30 s continuations); longer waits, such as practice
// mode's hourly look at a row or a retry's backoff, stay as the server set them.
async function hurry() {
  await superDb.query("UPDATE jobs_queue SET run_at = now() WHERE status = 'queued' AND kind LIKE 'qbo\\_%' AND kind <> 'qbo_dispatch' AND attempts = 0 AND run_at > now() AND run_at <= now() + interval '35 seconds'");
  await superDb.query("UPDATE qbo_outbox SET not_before = now() WHERE not_before > now() AND not_before <= now() + interval '25 seconds'");
}
const workerDone = (async () => {
  let lastDispatch = 0;
  while (!worker.stop) {
    if (worker.held) { await sleep(100); continue; }
    worker.busy = true;
    try {
      if (Date.now() - lastDispatch > 800) { lastDispatch = Date.now(); await hurry(); await dispatch(db); }
      const r = await runOnce(db, { workerId: 'e2e-worker', handlers: qboHandlers, kinds: [QBO_KIND_PATTERN], log: quiet });
      if (r) {
        worker.runs.push({ kind: r.kind, outcome: r.outcome, error: r.error || null });
        if (r.outcome !== 'done') { worker.failed.push(r); log('job', r.kind, r.outcome, r.error || ''); }
        worker.busy = false;
        continue;
      }
    } catch (e) {
      if (!worker.stop) log('worker error', e.message);
    }
    worker.busy = false;
    await sleep(120);
  }
})();
/** Wait until the QuickBooks queue has nothing due and the worker is idle (twice in a row). */
async function drain(what = 'the QuickBooks jobs', ms = 45000) {
  const end = Date.now() + ms;
  let quietTimes = 0;
  while (Date.now() < end) {
    await hurry();
    await dispatch(db);
    const n = (await superDb.query("SELECT count(*)::int AS n FROM jobs_queue WHERE kind LIKE 'qbo\\_%' AND kind <> 'qbo_dispatch' AND status IN ('queued', 'running') AND run_at <= now() + interval '2 seconds'")).rows[0].n;
    if (!n && !worker.busy) { if (++quietTimes >= 3) return; } else quietTimes = 0;
    await sleep(200);
  }
  const conn = (await superDb.query('SELECT state, setup, dirty_at, last_pull_at, cdc_cursor, lease_until FROM qbo_connections WHERE tenant_id = $1', [tg])).rows[0];
  const due = (await superDb.query("SELECT kind, payload, run_at FROM jobs_queue WHERE kind LIKE 'qbo\\_%' AND status IN ('queued', 'running') ORDER BY run_at LIMIT 5")).rows;
  const outbox = (await superDb.query('SELECT collection, record_id, not_before, actor_type FROM qbo_outbox WHERE tenant_id = $1 LIMIT 5', [tg])).rows;
  const inbox = (await superDb.query('SELECT count(*)::int AS n FROM qbo_inbox WHERE tenant_id = $1 AND processed_at IS NULL', [tg])).rows[0].n;
  throw new Error(`timed out waiting for ${what}: ${J({ conn, due, outbox, inbox, last: worker.runs.slice(-4) })}`);
}

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

async function openPage(name, { width, height, mobile, touch = mobile }) {
  const { browserContextId } = await browserSend('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await browserSend('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browserSend(m, p, sessionId);
  const consoleLines = [];
  /** Every /api/v1/qbo request this page made: { method, path, body }. */
  const qboCalls = [];
  listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    else if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    else if (msg.method === 'Log.entryAdded') consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    else if (msg.method === 'Network.requestWillBeSent') {
      const u = new URL(msg.params.request.url);
      if (u.pathname.startsWith('/api/v1/qbo/')) {
        let body = null;
        try { body = msg.params.request.postData ? JSON.parse(msg.params.request.postData) : null; } catch { body = msg.params.request.postData; }
        qboCalls.push({ method: msg.params.request.method, path: u.pathname, search: u.search, body });
      }
    }
  });
  for (const m of ['Runtime.enable', 'Page.enable', 'Log.enable', 'DOM.enable', 'Network.enable']) await send(m);
  const metrics = { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile };
  await send('Emulation.setDeviceMetricsOverride', metrics);
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
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
  const page = {
    name, send, evaluate, waitFor, consoleLines, qboCalls, width, height, mobile,
    async goto(path) { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); await waitFor(`document.readyState === "complete" && location.href.startsWith(${J(ORIGIN)})`, 'load'); },
    fill: (sel, val, scope = 'document') => evaluate(`(() => { const el = [...${scope}.querySelectorAll(${J(sel)})].at(-1); if (!el) throw new Error('missing ' + ${J(sel)}); el.focus(); if (el.type === 'checkbox') el.checked = ${J(Boolean(val))}; else el.value = ${J(String(val))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    click: (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a, [role=button], [role=tab]')].find((b) => (b.textContent.trim() === ${J(text)} || b.getAttribute('aria-label') === ${J(text)}) && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)} + ' in ' + ${J(within)}); el.click(); return true; })()`),
    text: () => evaluate('document.body.innerText'),
    async shot(file, { full = false } = {}) {
      try {
        // The app scrolls inside <main>, so a whole screen is shot by making the viewport as tall as it.
        let tall = null;
        if (full) {
          const h = await evaluate('(() => { const m = document.querySelector("main"); return Math.min(5000, Math.ceil(Math.max(window.innerHeight, m ? m.getBoundingClientRect().top + m.scrollHeight + 120 : 0, document.documentElement.scrollHeight))); })()');
          if (h > page.height) { tall = h; await send('Emulation.setDeviceMetricsOverride', { width: page.width, height: h, deviceScaleFactor: page.mobile ? 2 : 1, mobile: page.mobile }); await sleep(300); }
        }
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        if (tall) await send('Emulation.setDeviceMetricsOverride', { width: page.width, height: page.height, deviceScaleFactor: page.mobile ? 2 : 1, mobile: page.mobile });
        writeFileSync(join(SCRATCH, `${file}.png`), Buffer.from(data, 'base64'));
        shots.push(join(SCRATCH, `${file}.png`));
      } catch { /* ignore */ }
    },
    /** Change the viewport (a phone and a desktop in one session) and wait for the layout to follow. */
    async resize(w, h, m) { Object.assign(page, { width: w, height: h, mobile: m }); await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: m ? 2 : 1, mobile: m }); await sleep(400); },
    async restore() { Object.assign(page, { width, height, mobile }); await send('Emulation.setDeviceMetricsOverride', metrics); await sleep(400); },
  };
  return page;
}
const shots = [];

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
function totp(secret) {
  let lastStep = 0;
  return async () => {
    lastStep = Math.max(lastStep + 1, Math.floor(Date.now() / 30000) - 1);
    while (lastStep > Math.floor(Date.now() / 30000) + 1) await sleep(1000);
    return generate({ secret, epoch: lastStep * 30 });
  };
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
const synced = (p) => p.waitFor('kelbe.sync.syncNow().then(() => kelbe.sync.status().waiting === 0 && kelbe.sync.status().state === "synced")', 'synced', 30000);
const mainText = (p) => p.evaluate('document.querySelector("main").innerText');
const railHas = (p, id) => p.evaluate(`!!document.querySelector('.rail [data-mod="${id}"]')`);
const row = async (sql, args = []) => (await superDb.query(sql, args)).rows;
const clearBadges = (p) => p.evaluate('import("/js/lib/qbo-ui.js").then((m) => { m.qboStatusCache.clear(); return true; })');
const noSideScroll = async (p, where) => {
  const r = await p.evaluate(`(() => {
    const main = document.querySelector('main');
    const sw = Math.max(document.documentElement.scrollWidth, main ? main.scrollWidth - main.clientWidth + window.innerWidth : 0), w = window.innerWidth;
    // Anything wider than the screen that is not inside a scroller of its own (tables scroll inside .table-wrap).
    const cut = [...document.querySelectorAll('main *')].filter((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || b.right <= w + 1) return false;
      for (let p = el.parentElement; p && p !== main && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; }
      return true;
    }).slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '') + ' ' + Math.round(el.getBoundingClientRect().right));
    return { sw, w, cut };
  })()`);
  if (r.sw > r.w + 1 || r.cut.length) throw new Error(`${p.name}: ${where} scrolls sideways or is cut off (${r.sw} > ${r.w}; ${r.cut.join(', ')})`);
};
const pickOption = (p, sel, label) => p.evaluate(`(() => {
  const s = [...document.querySelectorAll(${J(sel)})].at(-1); if (!s) throw new Error('no select ' + ${J(sel)});
  const o = [...s.options].find((x) => x.textContent.trim().startsWith(${J(label)})); if (!o) throw new Error('no option ' + ${J(label)} + ': ' + [...s.options].map((x) => x.textContent).join('|'));
  s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const clickConfirm = (p, label) => p.click(label, '[role=dialog]');
/** In-app navigation that redraws even when the hash is already the same (Page.navigate would not). */
const go = (p, hash) => p.evaluate(`kelbe.nav(${J(hash)}); true`).then(() => sleep(250));
const mapping = async (kind, key) => (await row('SELECT value FROM qbo_mappings WHERE tenant_id = $1 AND kind = $2 AND key = $3', [tg, kind, key]))[0]?.value ?? null;
const link = async (collection, id) => (await row("SELECT * FROM qbo_links WHERE tenant_id = $1 AND collection = $2 AND record_id = $3 AND role = 'main'", [tg, collection, id]))[0] || null;
/** A QuickBooks-side change reaches Fishtape the way Intuit sends it: a signed webhook, then a pass. */
async function webhook() {
  const { raw, signature, events } = fake.signedWebhook(REALM, VERIFIER);
  const r = await fetch(`${ORIGIN}/api/v1/webhooks/qbo`, { method: 'POST', headers: { 'content-type': 'application/json', 'intuit-signature': signature }, body: raw });
  if (r.status !== 200) throw new Error(`signed webhook answered ${r.status}`);
  return events.length;
}
const shotBoth = async (p, file, where) => {
  await noSideScroll(p, where);
  await p.shot(`${file}-${p.width}`, { full: true });
};
/** The same screen at 390 px and 1280 px on one page: no sideways scroll at either width. */
async function bothWidths(p, file, where, ready) {
  const mobile = p.width < 600;
  for (const [w, h, m] of mobile ? [[390, 844, true], [1280, 800, false]] : [[1280, 800, false], [390, 844, true]]) {
    await p.resize(w, h, m);
    if (ready) await p.waitFor(ready, `${where} at ${w}`);
    await sleep(300);
    await shotBoth(p, file, `${where} at ${w} px`);
  }
  await p.restore();
}

const pages = [];
let exitCode = 0;
try {
  const own = await openPage('owner-desktop', { width: 1280, height: 800, mobile: false });
  const olive = await openPage('office-phone', { width: 390, height: 844, mobile: true });
  const fred = await openPage('foreman-phone', { width: 390, height: 844, mobile: true });
  pages.push(own, olive, fred);
  let invId = null;

  await step('owner: QuickBooks in the rail, the connect card, the Integrations card and the Settings link', async () => {
    await signInOwner(own, people.owner);
    if (!(await railHas(own, 'quickbooks'))) throw new Error('no QuickBooks in the owner rail');
    await own.goto('/#/quickbooks');
    await own.waitFor('document.querySelector("[data-qbo-kind]")?.dataset.qboKind === "not_connected"', 'the not-connected card');
    const t = await mainText(own);
    for (const s of ['Connect to QuickBooks', 'What syncs', "Fishtape's assistant can read your Fishtape records", 'QuickBooks and Intuit are trademarks of Intuit Inc.']) if (!t.includes(s)) throw new Error(`missing "${s}"`);
    await own.goto('/#/integrations');
    await own.waitFor('!!document.querySelector("[data-provider=quickbooks] a[href=\'#/quickbooks\']")', 'the QuickBooks card');
    await own.goto('/#/settings');
    await own.waitFor('!!document.querySelector("main a[href=\'#/quickbooks\']")', 'the Settings link');
    await own.shot('q01-not-connected');
    return 'connect card, AI disclosure, trademark line, Integrations card and Settings link';
  });

  await step('owner connects: ticket, interstitial, Intuit consent (fake), callback, back on the overview', async () => {
    await own.goto('/#/quickbooks');
    await own.waitFor('!!document.querySelector("[data-qbo-kind=not_connected]")', 'the card');
    await own.click('Connect to QuickBooks', 'main');
    await own.waitFor('location.pathname === "/api/v1/qbo/oauth/start" && /TG Electrical/.test(document.body.innerText)', 'the interstitial naming the company');
    const inter = await own.text();
    if (!inter.includes(people.owner.email)) throw new Error('the interstitial does not name the requester');
    await own.shot('q02-interstitial');
    await own.evaluate('document.querySelector("form button[type=submit]").click(); true');
    await own.waitFor('location.hash.startsWith("#/quickbooks") && !!document.querySelector("[data-qbo-kind=setup]")', 'back in Fishtape, setup', 30000);
    const t = await mainText(own);
    if (!/QuickBooks is connected/.test(t)) throw new Error('no connected banner');
    if (/connect=/.test(await own.evaluate('location.hash'))) throw new Error('the result stayed in the address bar');
    const c = (await row('SELECT state FROM qbo_connections WHERE tenant_id = $1', [tg]))[0];
    if (c?.state !== 'setup') throw new Error(`connection ${J(c)}`);
    await drain('the first reference read');
    const refs = (await row('SELECT count(*)::int AS n FROM qbo_reference WHERE tenant_id = $1', [tg]))[0].n;
    if (!refs) throw new Error('the reference lists were not read');
    await own.shot('q03-connected');
    return `qbo_connections.state = setup; ${refs} reference rows read by the worker`;
  });

  await step('wizard: settings with a practice week; the payroll question is required', async () => {
    await own.click('Continue setup', 'main');
    await own.waitFor('location.hash.startsWith("#/quickbooks/setup") && !!document.querySelector("main select[name=timeOwner]")', 'the settings step');
    await own.click('Next', 'main');
    await own.waitFor('/Say which system holds payroll hours/.test(document.querySelector("main").innerText)', 'the payroll question refused empty');
    await pickOption(own, 'main select[name=timeOwner]', 'Fishtape');
    await own.fill('main input[name=timeLockedThrough]', '2026-09-30');
    await own.fill('main input[name=taxFiledThrough]', '2026-09-30');
    await own.fill('main input[name=practice]', true);
    await own.click('Next', 'main');
    await own.waitFor('/step=mappings/.test(location.hash) && !!document.querySelector("main [data-map]")', 'the mappings step');
    const [owner, mode] = [await mapping('option', 'timeOwner'), await mapping('option', 'writeMode')];
    if (owner !== 'fishtape' || mode !== 'shadow') throw new Error(J({ owner, mode }));
    const n = (await row("SELECT count(*)::int AS n FROM qbo_mappings WHERE tenant_id = $1 AND kind = 'option'", [tg]))[0].n;
    return `options saved on the server: ${n}, writeMode shadow`;
  });

  await step('wizard: tax codes by rates (the old 8% code refused), products and accounts; Next waits for the required ones', async () => {
    const opt = await own.evaluate(`(() => { const s = document.querySelector('main [data-map="taxCode.GST+RST|MB"] select'); return [...s.options].map((o) => ({ t: o.textContent, d: o.disabled, sel: o.selected })); })()`);
    const old = opt.find((o) => /8% \(old\)/.test(o.t));
    if (!old?.d || !/does not fit/.test(old.t)) throw new Error(`the 8% code is offered: ${J(opt)}`);
    if (!opt.find((o) => o.sel && /GST\/PST MB · 5% \+ 7%/.test(o.t))) throw new Error(`no 5% + 7% suggestion: ${J(opt)}`);
    const nextDisabled = await own.evaluate('[...document.querySelectorAll("main .qbo-wizard-foot button")].at(-1).disabled');
    if (!nextDisabled) throw new Error('Next is on with required mappings missing');
    const required = await own.evaluate('[...document.querySelectorAll("main [data-map]")].filter((el) => el.closest("[data-required], .qbo-required")).map((el) => el.dataset.map)');
    const picks = { 'item.material': 'Materials', 'item.labour': 'Labour', 'item.other': 'Materials', 'account.income.default': 'Sales', 'account.expense.default': 'Job Materials' };
    for (const [k, label] of Object.entries(picks)) if (await own.evaluate(`!!document.querySelector('main [data-map="${k}"] select')`)) await pickOption(own, `main [data-map="${k}"] select`, label);
    await own.click('Save', 'main');
    await own.waitFor('![...document.querySelectorAll("main .qbo-wizard-foot button")].at(-1).disabled', 'Next on after saving', 30000);
    const [gstPst, labour] = [await mapping('taxCode', 'GST+RST|MB'), await mapping('item', 'labour')];
    if (gstPst !== S.taxCodes.gstPst.Id || labour !== S.items.labour.Id) throw new Error(J({ gstPst, labour }));
    await own.shot('q04-mappings');
    await bothWidths(own, 'shot-mappings', 'the mappings step', '!!document.querySelector("main [data-map]")');
    await own.click('Next', 'main');
    await own.waitFor('/step=match/.test(location.hash)', 'the match step');
    return `GST + Manitoba RST -> GST/PST MB (5% + 7%); required: ${required.join(', ') || '(listed at the top)'}`;
  });

  await step('wizard: read QuickBooks and match (possible duplicates filter)', async () => {
    await own.waitFor('!!document.querySelector("main .qbo-scan button")', 'the read button');
    await own.click('Read QuickBooks', 'main');
    await drain('the scan');
    await own.waitFor('document.querySelectorAll("main table tbody tr").length >= 3', 'the customer candidates', 30000);
    const cands = await row('SELECT kind, status, choice, reasons FROM qbo_candidates WHERE tenant_id = $1 ORDER BY kind, status', [tg]);
    const cust = cands.filter((c) => c.kind === 'customers').map((c) => c.status).sort();
    if (J(cust) !== J(['ambiguous', 'matched', 'quickbooks_only'])) throw new Error(`customers ${J(cands.filter((c) => c.kind === 'customers'))}`);
    const dup = cands.find((c) => c.kind === 'invoices' && (c.reasons || []).includes('possible_duplicate'));
    if (!dup || dup.choice !== 'skip') throw new Error(`no possible duplicate: ${J(cands.filter((c) => c.kind === 'invoices'))}`);
    await own.click('Invoices', 'main');
    await own.waitFor('document.querySelectorAll("main table tbody tr").length >= 1', 'the invoice candidates');
    await own.click('Possible duplicates', 'main');
    await own.waitFor('/possible duplicate/i.test(document.querySelector("main table")?.innerText || "")', 'the possible duplicate');
    const opts = await own.evaluate('[...document.querySelector("main table select").options].map((o) => o.textContent)');
    if (!opts.includes('Create anyway')) throw new Error(J(opts));
    await own.shot('q05-match');
    await own.click('Next', 'main');
    await own.waitFor('/step=review/.test(location.hash) && !!document.querySelector("main .qbo-diff")', 'the review step', 30000);
    return `customers ${cust.join('/')}; INV-2990 and QuickBooks 1043 a possible duplicate, not a create`;
  });

  await step('wizard: Review refuses Apply until every differing field has a side', async () => {
    const applyOff = () => own.evaluate('[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Apply").disabled');
    const rows = await own.evaluate('document.querySelectorAll("main .qbo-diff-row").length');
    if (rows < 2) throw new Error(`only ${rows} differing field(s) on the clinic`);
    if (!(await applyOff())) throw new Error(`Apply is on with ${rows} differences undecided`);
    if (!new RegExp(`${rows} differences still to decide`).test(await mainText(own))) throw new Error(`no reason shown: ${(await mainText(own)).slice(0, 300)}`);
    await bothWidths(own, 'shot-review', 'the Review step', '!!document.querySelector("main .qbo-diff")');
    await own.evaluate('document.querySelector("main .qbo-diff-row input[value=quickbooks]").click(); true');
    await own.waitFor(`/${rows - 1} difference${rows - 1 === 1 ? '' : 's'} still to decide/.test(document.querySelector("main").innerText)`, 'one fewer');
    if (!(await applyOff())) throw new Error('Apply is on with differences undecided');
    await own.evaluate('[...document.querySelectorAll("main .qbo-diff-row")].slice(1).forEach((r) => r.querySelector("input[value=fishtape]").click()); true');
    await own.waitFor('![...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Apply").disabled', 'Apply on');
    await sleep(500);
    const fc = (await row("SELECT field_choices FROM qbo_candidates WHERE tenant_id = $1 AND kind = 'customers' AND status = 'matched'", [tg]))[0]?.field_choices || {};
    if (Object.keys(fc).length !== rows || Object.values(fc)[0] !== 'quickbooks') throw new Error(`field choices on the server ${J(fc)}`);
    await own.shot('q06-review');
    await own.click('Apply', 'main');
    await own.waitFor('/step=apply/.test(location.hash)', 'the apply step');
    await drain('the practice apply');
    await own.waitFor('/Practice mode: records are linked, nothing was written/.test(document.querySelector("main").innerText)', 'the practice note', 30000);
    const conn = (await row('SELECT state, setup FROM qbo_connections WHERE tenant_id = $1', [tg]))[0];
    return `field choices ${J(fc)}; applied in practice mode (${conn.state}, ${conn.setup?.phase})`;
  });

  await step('practice mode: the "would change" list, and nothing written on either side', async () => {
    const before = await row('SELECT id, version FROM invoices WHERE tenant_id = $1 ORDER BY id', [tg]);
    const qboBefore = fake.list(REALM, 'Invoice').length;
    invId = await own.evaluate(`(() => { const s = kelbe.store; const c = s.list("clients").find((x) => /Dental Clinic$/.test(x.name)); const inv = s.add("invoices", { number: s.nextNumber("invoice"), clientId: c.id, status: "sent", issueDate: "2026-10-20", dueDate: "2026-11-03", lines: [{ description: "Panel work", qty: 1, unitCents: 50000, kind: "labour", labourHours: 0 }], taxProvince: "MB", taxTreatment: "pst-all", taxes: ${J(MB_TAXES)}, taxPct: 12, notes: "" }); return inv.id; })()`);
    await synced(own);
    await drain('the practice pass');
    if (fake.list(REALM, 'Invoice').length !== qboBefore) throw new Error('practice mode wrote an invoice to QuickBooks');
    if ((await link('invoices', invId))?.qbo_id) throw new Error('practice mode linked the invoice to a QuickBooks id');
    const after = await row('SELECT id, version FROM invoices WHERE tenant_id = $1 AND id <> $2 ORDER BY id', [tg, invId]);
    if (J(after) !== J(before)) throw new Error('practice mode changed Fishtape records');
    const byQbo = (await row("SELECT (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND updated_by = 'system:qbo') + (SELECT count(*) FROM clients WHERE tenant_id = $1 AND updated_by = 'system:qbo') AS n", [tg]))[0].n;
    if (Number(byQbo)) throw new Error(`${byQbo} writes by system:qbo`);
    const shadow = await row("SELECT action, collection, record_id, message FROM qbo_sync_log WHERE tenant_id = $1 AND outcome = 'shadow' ORDER BY id", [tg]);
    if (!shadow.some((l) => l.collection === 'invoices' && l.record_id !== null)) throw new Error(`no shadow log for the invoice: ${J(shadow)}`);
    await own.goto('/#/quickbooks');
    await own.waitFor('!!document.querySelector("main .qbo-shadow")', 'the practice banner');
    await own.click("Read the 'would change' list", 'main');
    await own.waitFor('/outcome=shadow/.test(location.hash) && document.querySelectorAll("main .list-row, main table tbody tr").length > 0', 'the would-change list');
    await own.shot('q07-shadow');
    return `${shadow.length} "would change" rows; no QuickBooks invoice, no link, no Fishtape write`;
  });

  await step('owner goes live: the rest of setup runs and the practice invoice reaches QuickBooks', async () => {
    await own.goto('/#/quickbooks');
    await own.waitFor('!!document.querySelector("main .qbo-shadow")', 'the practice banner');
    await own.click('Go live', 'main');
    await clickConfirm(own, 'Go live');
    await drain('the live apply');
    await own.goto('/#/quickbooks');
    await own.waitFor('!document.querySelector("main .qbo-shadow") && /Syncing/.test(document.querySelector("main").innerText)', 'live', 30000);
    if ((await mapping('option', 'writeMode')) !== 'live') throw new Error(`writeMode ${await mapping('option', 'writeMode')}`);
    const l = await link('invoices', invId);
    if (l?.state !== 'synced' || !l.qbo_id) throw new Error(`the practice invoice: ${J(l && { state: l.state, reason: l.reason, err: l.last_error })}`);
    const prairie = (await row("SELECT id FROM clients WHERE tenant_id = $1 AND data->>'name' = 'Prairie Co-op' AND deleted_at IS NULL", [tg]))[0];
    if (!prairie) throw new Error('the QuickBooks-only customer was not created in Fishtape');
    if (!(await row('SELECT last_push_at FROM qbo_connections WHERE tenant_id = $1', [tg]))[0].last_push_at) throw new Error('"Last to QuickBooks" was never recorded');
    await own.shot('q07b-live');
    await bothWidths(own, 'shot-overview', 'the overview', '!!document.querySelector("[data-qbo-kind=active]")');
    return `writeMode live; ${l.collection} ${invId} -> QuickBooks #${l.qbo_id}; Prairie Co-op created in Fishtape`;
  });

  await step('mappings: options typed in survive a code change and are saved with it', async () => {
    await own.goto('/#/quickbooks/mappings');
    await own.waitFor('!!document.querySelector("main [data-map=\'item.other\'] select") && !!document.querySelector("main input[name=practice]")', 'the mappings screen');
    await own.fill('main input[name=practice]', true);
    await own.fill('main input[name=timeLockedThrough]', '2026-10-15');
    // A select change redraws the screen; the options above must still be there afterwards.
    await pickOption(own, 'main [data-map="item.other"] select', 'Labour');
    const kept = await own.evaluate('({ practice: document.querySelector("main input[name=practice]").checked, locked: document.querySelector("main input[name=timeLockedThrough]").value })');
    if (!kept.practice || kept.locked !== '2026-10-15') throw new Error(`the redraw dropped the options: ${J(kept)}`);
    const before = own.qboCalls.length;
    await own.click('Save', 'main');
    await own.waitFor('/Saved \\d+ change/.test(document.body.innerText)', 'the saved toast');
    const put = own.qboCalls.slice(before).find((c) => c.method === 'PUT' && c.path === '/api/v1/qbo/mappings');
    if (!put) throw new Error('no save');
    const keys = (put.body.set || []).map((s) => `${s.kind}.${s.key}`);
    if ((put.body.remove || []).some((r) => keys.includes(`${r.kind}.${r.key}`))) throw new Error(`a key in both set and remove: ${J(put.body)}`);
    if ((await mapping('option', 'writeMode')) !== 'shadow' || (await mapping('option', 'timeLockedThrough')) !== '2026-10-15' || (await mapping('item', 'other')) !== S.items.labour.Id) throw new Error(J(put.body));
    const toast = await own.evaluate('[...document.querySelectorAll(".toast")].map((t) => t.innerText).join(" | ")');
    // Back to live for the rest of the run, the way an owner does it.
    await own.goto('/#/quickbooks');
    await own.waitFor('!!document.querySelector("main .qbo-shadow")', 'the practice banner');
    await own.click('Go live', 'main');
    await clickConfirm(own, 'Go live');
    await own.waitFor('!document.querySelector("main .qbo-shadow")', 'live again');
    if ((await mapping('option', 'writeMode')) !== 'live') throw new Error('not live again');
    return `practice + payroll lock + item saved together (${keys.join(', ')}); ${toast.slice(0, 120)}`;
  });

  await step('office on a phone (no two-step sign-in): reads the status, mfa_required on Sync now', async () => {
    await signIn(olive, people.office);
    if (!(await railHas(olive, 'quickbooks'))) throw new Error('no QuickBooks for office');
    await olive.goto('/#/quickbooks');
    await olive.waitFor('!!document.querySelector("[data-qbo-kind=active]")', 'the active card');
    const t = await mainText(olive);
    if (!/TG Electrical Ltd\./.test(t) || !/Turn on two-step sign-in to change QuickBooks data/.test(t)) throw new Error(t.slice(0, 400));
    if (/Disconnect from QuickBooks/.test(t)) throw new Error('office can disconnect');
    await noSideScroll(olive, '#/quickbooks');
    await olive.click('Sync now', 'main');
    await olive.waitFor('/Two-step sign-in needed/.test(document.querySelector("[role=dialog]")?.innerText || "")', 'the mfa sheet');
    if (!olive.qboCalls.some((c) => c.method === 'POST' && c.path === '/api/v1/qbo/sync')) throw new Error('no sync call');
    await olive.shot('q08-office-mfa');
    await olive.click('Later', '[role=dialog]');
    return 'status read; Sync now -> 403 mfa_required -> "Two-step sign-in needed"';
  });

  await step('office sends an invoice; its badge reaches "In QuickBooks"', async () => {
    const id = await olive.evaluate(`(() => { const s = kelbe.store; const c = s.list("clients").find((x) => /Residence$/.test(x.name)); const inv = s.add("invoices", { number: s.nextNumber("invoice"), clientId: c.id, status: "draft", issueDate: "2026-10-20", dueDate: "2026-11-03", lines: [{ description: "Service call", qty: 2, unitCents: 9500, kind: "labour", labourHours: 2 }], taxProvince: "MB", taxTreatment: "pst-all", taxes: ${J(MB_TAXES)}, taxPct: 12, notes: "" }); return inv.id; })()`);
    await olive.goto(`/#/invoices/${id}`);
    await olive.waitFor('/Mark sent/.test(document.querySelector("main aside")?.innerText || "")', 'the draft');
    await olive.click('Mark sent', 'main');
    await synced(olive);
    await drain('the push');
    const l = await link('invoices', id);
    if (l?.state !== 'synced' || !l.qbo_id) throw new Error(`link ${J(l && { state: l.state, reason: l.reason, err: l.last_error })}`);
    const q = fake.get(REALM, 'Invoice', l.qbo_id);
    if (Math.round(q.TotalAmt * 100) !== 21280) throw new Error(`QuickBooks total ${q.TotalAmt}`);
    await clearBadges(olive);
    await olive.goto('/#/invoices');
    await olive.waitFor('[...document.querySelectorAll("main .qbo-badge")].some((b) => b.textContent === "In QuickBooks")', 'the badge in the list');
    await olive.goto(`/#/invoices/${id}`);
    await olive.waitFor('/In QuickBooks/.test(document.querySelector("main aside")?.innerText || "")', 'the badge on the invoice');
    await bothWidths(olive, 'shot-invoice-badge', 'an invoice with its badge', '/In QuickBooks/.test(document.querySelector("main aside")?.innerText || "")');
    await olive.evaluate('document.querySelector("main aside .qbo-badge").click(); true');
    await olive.waitFor('/Open in QuickBooks/.test(document.querySelector("[role=dialog]")?.innerText || "")', 'the badge sheet');
    await olive.shot('q09-badge-sheet');
    await olive.click('Close', '[role=dialog]');
    invId = id;
    return `invoice ${id} -> QuickBooks #${l.qbo_id} ($212.80); badge and sheet`;
  });

  await step('a QuickBooks-side change arrives by signed webhook and shows in Fishtape', async () => {
    const l = await link('invoices', invId);
    fake.edit(REALM, 'Invoice', l.qbo_id, { DueDate: '2026-12-31' });
    const { raw } = fake.signedWebhook(REALM, VERIFIER);
    const bad = await fetch(`${ORIGIN}/api/v1/webhooks/qbo`, { method: 'POST', headers: { 'content-type': 'application/json', 'intuit-signature': 'nope' }, body: raw });
    if (bad.status !== 401) throw new Error(`unsigned webhook answered ${bad.status}`);
    const sig = fake.sign(raw, VERIFIER);
    const r = await fetch(`${ORIGIN}/api/v1/webhooks/qbo`, { method: 'POST', headers: { 'content-type': 'application/json', 'intuit-signature': sig }, body: raw });
    if (r.status !== 200) throw new Error(`signed webhook answered ${r.status}`);
    const inbox = (await row('SELECT count(*)::int AS n FROM qbo_inbox WHERE tenant_id = $1', [tg]))[0].n;
    const dirty = (await row('SELECT dirty_at FROM qbo_connections WHERE tenant_id = $1', [tg]))[0];
    if (!inbox && !dirty?.dirty_at) throw new Error('the webhook neither filled the inbox nor marked the company dirty');
    await drain('the pull');
    const server = (await row("SELECT data->>'dueDate' AS due, updated_by FROM invoices WHERE tenant_id = $1 AND id = $2", [tg, invId]))[0];
    if (server?.due !== '2026-12-31' || server.updated_by !== 'system:qbo') throw new Error(`server copy ${J(server)}`);
    await synced(olive);
    await olive.goto('/#/invoices');
    await olive.goto(`/#/invoices/${invId}`);
    try {
      await olive.waitFor('document.querySelector("main input[name=dueDate]")?.value === "2026-12-31"', 'the new due date on the phone');
    } catch (e) {
      throw new Error(`${e.message}; device copy ${J(await olive.evaluate(`({ due: kelbe.store.get("invoices", ${J(invId)})?.dueDate, input: document.querySelector("main input[name=dueDate]")?.value, status: kelbe.sync.status() })`))}`);
    }
    return 'verified (401 unsigned, 200 signed), pulled by the worker, due date 2026-12-31 on the phone, written by system:qbo';
  });

  await step('a change pulled while the invoice is open is not written back by the next keystroke (5.10)', async () => {
    // The phone still shows the invoice. The bookkeeper changes its line in QuickBooks; the pull
    // lands; the office user then types in the notes.
    const l = await link('invoices', invId);
    const q = fake.get(REALM, 'Invoice', l.qbo_id);
    const lines = q.Line.filter((x) => x.DetailType === 'SalesItemLineDetail').map((x) => ({ ...x, Amount: 198, SalesItemLineDetail: { ...x.SalesItemLineDetail, UnitPrice: 99, Qty: 2 } }));
    fake.edit(REALM, 'Invoice', l.qbo_id, { Line: lines });
    await webhook();
    await drain('the pull');
    await synced(olive);
    await olive.waitFor(`kelbe.store.get("invoices", ${J(invId)}).lines[0].unitCents === 9900`, 'the pull on the phone');
    await olive.waitFor('!!document.querySelector("main textarea[name=notes]")', 'the invoice screen');
    await olive.fill('main textarea[name=notes]', 'Gate code 4411');
    await sleep(700);
    const queued = await olive.evaluate(`kelbe.store.queue.filter((e) => e.id === ${J(invId)}).map((e) => e.fields)`);
    await synced(olive);
    await drain('the notes push');
    const d = (await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, invId]))[0];
    if (d.data.lines?.[0]?.unitCents !== 9900 || d.data.notes !== 'Gate code 4411' || d.data.dueDate !== '2026-12-31') throw new Error(J({ lines: d.data.lines, notes: d.data.notes, due: d.data.dueDate, queued }));
    if (J(queued) !== J([['notes']])) throw new Error(`queued ${J(queued)}`);
    const after = fake.get(REALM, 'Invoice', l.qbo_id);
    const unit = after.Line.find((x) => x.DetailType === 'SalesItemLineDetail').SalesItemLineDetail.UnitPrice;
    if (unit !== 99) throw new Error(`QuickBooks line went back to ${unit}`);
    return `queued fields ${J(queued)}; server and QuickBooks keep the QuickBooks line ($99.00), the server has the phone's notes`;
  });

  await step('a conflicting edit shows on the conflicts screen and is resolved per field', async () => {
    const l = await link('invoices', invId);
    worker.held = true;
    while (worker.busy) await sleep(50);
    // QuickBooks: the bookkeeper changes the line and the date. Fishtape: the owner changes both too.
    const q = fake.get(REALM, 'Invoice', l.qbo_id);
    const lines = q.Line.filter((x) => x.DetailType === 'SalesItemLineDetail').map((x) => ({ ...x, Amount: 200, SalesItemLineDetail: { ...x.SalesItemLineDetail, UnitPrice: 100, Qty: 2 } }));
    fake.edit(REALM, 'Invoice', l.qbo_id, { Line: lines, TxnDate: '2026-10-21' });
    await synced(own);
    await own.evaluate(`(() => { kelbe.store.update("invoices", ${J(invId)}, { lines: [{ description: "Service call", qty: 3, unitCents: 9500, kind: "labour", labourHours: 3 }], issueDate: "2026-10-22" }); return true; })()`);
    await synced(own);
    await webhook();
    worker.held = false;
    await drain('the pass that finds both changes');
    const open = await row("SELECT id, kind, fields FROM qbo_conflicts WHERE tenant_id = $1 AND record_id = $2 AND status = 'open'", [tg, invId]);
    if (open.length !== 1 || open[0].kind !== 'fields') throw new Error(`conflicts ${J(open)}; link ${J(await link('invoices', invId))}`);
    const fields = open[0].fields.map((f) => f.field);
    await go(own, '#/quickbooks');
    await clearBadges(own);
    await own.goto('/#/quickbooks');
    await own.waitFor('[...document.querySelectorAll("main .qbo-count")].some((a) => /Need a decision/.test(a.textContent))', 'the count link');
    await own.goto('/#/quickbooks/conflicts');
    await own.waitFor('document.querySelectorAll("main table tbody tr").length === 1', 'the conflict row');
    await own.evaluate('document.querySelector("main table tbody tr").click(); true');
    await own.waitFor(`location.hash === "#/quickbooks/conflicts/${open[0].id}" && !!document.querySelector("main .qbo-conflict-grid")`, 'the conflict');
    await bothWidths(own, 'shot-conflict', 'a conflict', '!!document.querySelector("main .qbo-conflict-grid")');
    const btnOff = () => own.evaluate('[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Use my choices").disabled');
    if (!(await btnOff())) throw new Error('"Use my choices" on before choosing');
    // QuickBooks for the lines, Fishtape for everything else.
    const want = Object.fromEntries(fields.map((f) => [f, f === 'lines' ? 'quickbooks' : 'fishtape']));
    for (const f of fields) await own.evaluate(`[...document.querySelectorAll("main input[name='c-${f}']")][${want[f] === 'fishtape' ? 0 : 1}].click(); true`);
    if (await btnOff()) throw new Error('"Use my choices" still off');
    await own.shot('q10-conflict');
    const before = own.qboCalls.length;
    await own.click('Use my choices', 'main');
    await own.waitFor('location.hash === "#/quickbooks/conflicts"', 'back on the list');
    const sent = own.qboCalls.slice(before).find((c) => /\/resolve$/.test(c.path));
    if (J(sent?.body) !== J({ choice: 'fields', fields: want })) throw new Error(`resolve body ${J(sent?.body)}`);
    await drain('the resolution');
    const after = await link('invoices', invId);
    if (after.state !== 'synced') throw new Error(`after resolving: ${J({ state: after.state, reason: after.reason, err: after.last_error })}`);
    const d = (await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, invId]))[0].data;
    if (d.lines[0].unitCents !== 10000) throw new Error(`Fishtape lines ${J(d.lines)}`);
    await clearBadges(own);
    await synced(own);
    await go(own, `#/invoices/${invId}`);
    await own.waitFor('/In QuickBooks/.test(document.querySelector("main aside")?.innerText || "")', 'back in step');
    return `fields ${fields.join(', ')} resolved ${J(want)}; QuickBooks' line ($100.00) now in Fishtape`;
  });

  await step('"Why no tax?" on a no-tax invoice, for every company', async () => {
    const id = await own.evaluate(`(() => { const s = kelbe.store; const inv = s.add("invoices", { number: s.nextNumber("invoice"), clientId: s.list("clients").find((x) => /Dental Clinic$/.test(x.name)).id, status: "draft", issueDate: "2026-10-20", dueDate: "2026-11-03", lines: [{ description: "Band office lighting", qty: 1, unitCents: 80000, kind: "labour", labourHours: 0 }], taxProvince: "MB", taxTreatment: "pst-all", taxes: ${J(MB_TAXES)}, taxPct: 12, notes: "" }); return inv.id; })()`);
    await own.goto(`/#/invoices/${id}`);
    await own.waitFor('!!document.querySelector("main select[name=taxTreatment]")', 'the tax editor');
    if (await own.evaluate('document.querySelector("main [data-no-tax]").hidden === false')) throw new Error('the picker shows on a taxed invoice');
    await pickOption(own, 'main select[name=taxTreatment]', 'No tax');
    await own.waitFor('document.querySelector("main [data-no-tax]").hidden === false', 'the picker');
    await pickOption(own, 'main select[name=taxNoneReason]', 'Indian Act relief');
    await sleep(700);
    await synced(own);
    const d = (await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, id]))[0].data;
    if (d.taxNoneReason !== 'relief' || d.taxTreatment !== 'none') throw new Error(J({ r: d.taxNoneReason, t: d.taxTreatment }));
    await own.shot('q11-no-tax');
    return 'taxNoneReason relief saved on the server';
  });

  await step('a credit applied in QuickBooks (a journal entry) comes back as a read-only settlement payment', async () => {
    const l = await link('invoices', invId);
    // A journal entry applied to the invoice is settled (4.9). A credit memo applied to one invoice is a
    // Fishtape credit note since Release 1 (the Release 1 step below), so this uses a journal entry.
    const customer = fake.get(REALM, 'Invoice', l.qbo_id).CustomerRef;
    fake.create(REALM, 'Payment', { CustomerRef: customer, TotalAmt: 0, Line: [{ Amount: 12, LinkedTxn: [{ TxnId: l.qbo_id, TxnType: 'Invoice' }] }, { Amount: 12, LinkedTxn: [{ TxnId: '999999', TxnType: 'JournalEntry' }] }] });
    await webhook();
    await drain('the settlement pull');
    const pay = (await row('SELECT data FROM payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tg, `credit-${invId}`]))[0];
    if (pay?.data?.amountCents !== 1200 || pay.data.method !== 'credit') throw new Error(`settlement ${J(pay)}`);
    await synced(own);
    await own.goto(`/#/invoices/${invId}`);
    await own.waitFor('!!document.querySelector("main [data-settlement]")', 'the settlement row');
    const r = await own.evaluate('(() => { const el = document.querySelector("main [data-settlement]"); return { text: el.innerText, del: !!el.querySelector("button[title=\'Delete payment\']") }; })()');
    if (!/Credited or paid in QuickBooks/.test(r.text) || r.del) throw new Error(J(r));
    return 'payment credit-<invoice> $12.00, labelled, no delete button';
  });

  await step('purchasing with QuickBooks: a bill gets its badge, and Mark paid is QuickBooks\'', async () => {
    await own.goto('/#/settings?section=modules');
    await own.waitFor('!!document.querySelector(\'[data-switch="purchasing"] input.switch\')', 'the Purchasing switch');
    if (!(await own.evaluate('document.querySelector(\'[data-switch="purchasing"] input.switch\').checked'))) await own.evaluate('document.querySelector(\'[data-switch="purchasing"] input.switch\').click(); true');
    await own.waitFor('!!document.querySelector(\'.rail [data-mod="purchasing"]\')', 'Purchasing in the rail');
    const billId = await own.evaluate(`(() => {
      const s = kelbe.store;
      const v = s.add("vendors", { name: "Westburne Winnipeg", companyName: "Westburne", email: "orders@westburne.example", phone: "", active: true, terms: "net30" });
      const b = s.add("bills", { kind: "bill", vendorId: v.id, number: "WB-55120", date: "2026-10-20", dueDate: "2026-11-19", status: "open", taxProvince: "MB",
        lines: [{ description: "EMT 3/4 x 10 ft", qty: 20, unitCents: 1250, amountCents: 25000, costType: "material" }], taxes: [{ id: "GST", cents: 1250 }, { id: "PST", cents: 0 }], totalCents: 26250 });
      return b.id; })()`);
    await synced(own);
    await drain('the bill push');
    const l = await link('bills', billId);
    await clearBadges(own);
    await own.goto(`/#/purchasing/bills/${billId}`);
    await own.waitFor('!!document.querySelector("main .qbo-badge")', 'the bill badge', 30000);
    await own.waitFor('!!document.querySelector("main [data-qbo-paid]")', 'the QuickBooks paid note');
    if (await own.evaluate('[...document.querySelectorAll("main button")].some((b) => /^Mark (un)?paid$/.test(b.textContent.trim()))')) throw new Error('Mark paid is offered with QuickBooks connected');
    const badge = await own.evaluate('document.querySelector("main .qbo-badge").textContent');
    await bothWidths(own, 'shot-bill', 'a purchasing bill', '!!document.querySelector("main .qbo-badge")');
    await own.goto('/#/purchasing');
    await own.waitFor('!!document.querySelector("main table .qbo-badge")', 'the badge in the bills list');
    await noSideScroll(own, '#/purchasing');
    return `bill ${billId}: link ${l ? `${l.state}${l.reason ? `/${l.reason}` : ''}` : 'none'}, badge "${badge}", no Mark paid`;
  });

  await step('look-up and activity read cleanly: no stray "null", plural record names, the waiting list', async () => {
    await own.goto('/#/quickbooks/lookup');
    await own.waitFor('!!document.querySelector("main .qbo-lookup-form")', 'the look-up form');
    const text = await own.evaluate('document.querySelector("main").innerText');
    if (/(^|\s)null(\s|$)/.test(text)) throw new Error(`the look-up screen shows "null": ${J(text.slice(0, 300))}`);
    await own.goto('/#/quickbooks/activity');
    await own.waitFor('!!document.querySelector("main select[name=collection]")', 'the records filter');
    const names = await own.evaluate('[...document.querySelectorAll("main select[name=collection] option")].map((o) => o.textContent)');
    if (!names.includes('Time entries') || names.some((n) => /entrys|services$/.test(n) && n !== 'Products and services')) throw new Error(J(names));
    await own.goto('/#/quickbooks/activity?show=waiting');
    await own.waitFor('/Waiting to be sent/.test(document.querySelector("main")?.innerText || "") && !!document.querySelector("main table, main .empty")', 'the waiting list');
    return `look-up without "null"; filter ${names.length - 1} record kinds; waiting list shown`;
  });

  await step('foreman on a phone: no QuickBooks anywhere, and 403 from the API', async () => {
    await superDb.query("INSERT INTO time_entries (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'te-fred-1', $2, 'system:e2e', 'system:e2e')",
      [tg, { employeeId: 'emp-fred', jobId: null, clockIn: new Date(Date.now() - 5 * 3600e3).toISOString(), clockOut: new Date(Date.now() - 3600e3).toISOString(), breakMins: 0, note: '', approved: true }]).catch(() => {});
    await signIn(fred, people.fred);
    if (await railHas(fred, 'quickbooks')) throw new Error('QuickBooks in the foreman rail');
    await fred.goto('/#/quickbooks');
    await fred.waitFor('/No access/.test(document.querySelector("main")?.innerText || "")', 'No access');
    await fred.goto('/#/time/week');
    await fred.waitFor('!!document.querySelector("main table, main .empty")', 'the timesheet');
    await sleep(800);
    if (await fred.evaluate('!!document.querySelector(".qbo-badge-host, .qbo-badge")')) throw new Error('a QuickBooks badge on the foreman screen');
    if (fred.qboCalls.length) throw new Error(`the foreman app called ${J(fred.qboCalls)}`);
    const status = await fred.evaluate('fetch("/api/v1/qbo/status", { credentials: "include" }).then((r) => r.status)');
    if (status !== 403) throw new Error(`status answered ${status}`);
    await noSideScroll(fred, '#/time/week');
    await fred.shot('q12-foreman');
    return 'no rail button, No access, no badges, no QuickBooks calls from the app, 403 from /api/v1/qbo/status';
  });

  // ---- Release 1 (docs/releases/r1-get-paid.md 9, 12.2; docs/integrations/quickbooks.md 17) ----
  const M = await import(pathToFileURL(join(APPDIR, 'js/lib/money.js')).href);
  const dayBefore = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Winnipeg' });
  const r1Doc = (o) => ({ clientId: clinic.id, status: 'sent', issueDate: dayBefore(0), dueDate: dayBefore(0), taxProvince: 'MB', taxTreatment: 'pst-all', taxes: MB_TAXES, taxPct: 12, notes: '', ...o });
  const cents = (d) => Math.round(Number(d) * 100);

  await step('Release 1: holdback invoice and release, deposit, credit note and RST recoverable bill through QuickBooks', async () => {
    const realm = (await row('SELECT realm_hash FROM qbo_connections WHERE tenant_id = $1', [tg]))[0].realm_hash;
    const item = (Name) => fake.create(REALM, 'Item', { Name, Type: 'Service', Active: true, IncomeAccountRef: { value: S.accounts.income.Id } }).Id;
    const ids = { holdback: item('Holdback'), deposit: item('Customer deposits'), interest: item('Overdue interest') };
    const rstAcct = fake.create(REALM, 'Account', { Name: 'RST recoverable', AccountType: 'Other Current Asset', AccountSubType: 'OtherCurrentAssets', Active: true, CurrentBalance: 0 }).Id;
    for (const [kind, key, value] of [...Object.entries(ids).map(([k, v]) => ['item', k, v]), ['account', 'rstRecoverable', rstAcct]]) {
      await superDb.query(`INSERT INTO qbo_mappings (tenant_id, realm_hash, kind, key, value) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value`, [tg, realm, kind, key, J(String(value))]);
    }
    const work = [{ description: 'Rough-in, phase 2', qty: 1, unitCents: 200000, kind: 'labour', labourHours: 0 }];
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'invoices', r1Doc({ id: 'r1-hb', number: 'INV-4101', kind: 'progress', lines: work, holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: true } }), who));
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'invoices', r1Doc({ id: 'r1-rel', number: 'INV-4102', kind: 'holdback-release', holdbackInvoiceIds: ['r1-hb'], lines: [M.holdbackReleaseLine(20000, { taxes: MB_TAXES, deferTaxIds: ['GST', 'RST'] })] }), who));
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'invoices', r1Doc({ id: 'r1-dep', number: 'INV-4103', ...M.depositInvoiceFields('prepayment'), lines: [M.depositInvoiceLine({ cents: 100000, ref: 'J-1042' })] }), who));
    const hbInv = (await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, 'r1-hb']))[0].data;
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'invoices', { ...M.creditNoteFrom({ ...hbInv, id: 'r1-hb' }, { reason: 'price', today: dayBefore(0), number: 'CR-1001' }), id: 'r1-cn', status: 'sent' }, who));
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'vendors', { id: 'r1-v', name: 'Guillevin Winnipeg', active: true }, who));
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'bills', {
      id: 'r1-bill', kind: 'bill', vendorId: 'r1-v', number: 'GV-77', date: dayBefore(0), dueDate: dayBefore(0), status: 'open', taxProvince: 'MB',
      lines: [{ description: 'Panelboard 225 A', qty: 1, unitCents: 150000, amountCents: 150000, costType: 'material' }],
      taxes: [{ id: 'GST', label: 'GST', cents: 7500 }, { id: 'RST', label: 'RST', cents: 10500 }], totalCents: 168000,
    }, who));
    await drain('the Release 1 documents');
    const qOf = async (coll, id, entity) => { const l = await link(coll, id); if (l?.state !== 'synced') throw new Error(`${id}: ${J({ state: l?.state, reason: l?.reason, err: l?.last_error })}`); return fake.get(REALM, entity || l.qbo_entity, l.qbo_id); };
    const hb = await qOf('invoices', 'r1-hb');
    const hbLine = hb.Line.find((x) => x.SalesItemLineDetail?.ItemRef?.value === String(ids.holdback));
    if (!hbLine || hbLine.Amount !== -200) throw new Error(`holdback line ${J(hbLine)}`);
    if (cents(hb.TotalAmt) !== M.docTotals(hbInv).totalCents) throw new Error(`holdback total ${hb.TotalAmt} vs ${M.docTotals(hbInv).totalCents}`);
    const rel = await qOf('invoices', 'r1-rel');
    if (rel.Line[0].SalesItemLineDetail.ItemRef.value !== String(ids.holdback) || rel.Line[0].Amount !== 200) throw new Error(`release ${J(rel.Line)}`);
    const dep = await qOf('invoices', 'r1-dep');
    if (dep.Line[0].SalesItemLineDetail.ItemRef.value !== String(ids.deposit)) throw new Error(`deposit ${J(dep.Line)}`);
    const cn = await qOf('invoices', 'r1-cn');
    if ((await link('invoices', 'r1-cn')).qbo_entity !== 'CreditMemo' || !cn.Line.some((x) => x.SalesItemLineDetail?.ItemRef?.value === String(ids.holdback) && x.Amount < 0)) throw new Error(`credit memo ${J(cn.Line)}`);
    const bill = await qOf('bills', 'r1-bill');
    const toRst = bill.Line.find((x) => x.AccountBasedExpenseLineDetail?.AccountRef?.value === String(rstAcct));
    if (cents(toRst?.Amount) !== 10500 || cents(bill.Line[0].Amount) !== 150000) throw new Error(`bill lines ${J(bill.Line.map((x) => [x.AccountBasedExpenseLineDetail?.AccountRef?.value, x.Amount]))}`);
    return `holdback -$200.00 on "Holdback", release +$200.00, deposit on "Customer deposits", CR-1001 a CreditMemo with its holdback, RST $105.00 to RST recoverable`;
  });

  await step('Release 1: a credit memo applied to one invoice in QuickBooks becomes a credit note and its application', async () => {
    const l = await link('invoices', 'r1-rel');
    const memo = fake.create(REALM, 'CreditMemo', { CustomerRef: fake.get(REALM, 'Invoice', l.qbo_id).CustomerRef, DocNumber: 'CM-77', Line: [{ DetailType: 'SalesItemLineDetail', Amount: 50, SalesItemLineDetail: { ItemRef: { value: S.items.labour.Id }, Qty: 1, UnitPrice: 50, TaxCodeRef: { value: S.taxCodes.gstPst.Id } } }] });
    fake.create(REALM, 'Payment', { CustomerRef: memo.CustomerRef, TotalAmt: 0, Line: [{ Amount: 56, LinkedTxn: [{ TxnId: l.qbo_id, TxnType: 'Invoice' }] }, { Amount: 56, LinkedTxn: [{ TxnId: memo.Id, TxnType: 'CreditMemo' }] }] });
    await webhook();
    await drain('the credit memo pull');
    const note = (await row("SELECT id, data FROM invoices WHERE tenant_id = $1 AND data->>'kind' = 'credit' AND data->>'creditsInvoiceId' = 'r1-rel' AND deleted_at IS NULL", [tg]))[0];
    const app = (await row("SELECT data FROM payments WHERE tenant_id = $1 AND data->>'invoiceId' = 'r1-rel' AND data->>'method' = 'credit-note' AND deleted_at IS NULL", [tg]))[0];
    const settled = (await row('SELECT data FROM payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tg, 'credit-r1-rel']))[0];
    if (!note || app?.data?.creditNoteId !== note.id || app.data.amountCents !== 5600 || settled) throw new Error(J({ note: note?.data?.number, app: app?.data, settled: settled?.data }));
    return `credit note ${note.data.number} and its $56.00 application; no settlement payment`;
  });

  await step('Release 1: a QuickBooks edit of an invoice in a closed month goes to review and is kept as a noted difference', async () => {
    // After the GST period filed in the wizard (2026-09-30), in a month then closed on Books.
    const old = dayBefore(30) > '2026-10-01' ? dayBefore(30) : '2026-10-01';
    await asSetup((tx, p, who) => records.createRecord(tx, p, 'invoices', r1Doc({ id: 'r1-sep', number: 'INV-4201', issueDate: old, dueDate: old, lines: [{ description: 'Lighting retrofit', qty: 1, unitCents: 80000, kind: 'labour', labourHours: 0 }] }), who));
    await drain('the September invoice');
    const l = await link('invoices', 'r1-sep');
    if (l?.state !== 'synced') throw new Error(`r1-sep ${J(l)}`);
    await superDb.query("INSERT INTO period_locks (tenant_id, kind, through, actor) VALUES ($1, 'books', $2, 'e2e')", [tg, old]);
    const q = fake.get(REALM, 'Invoice', l.qbo_id);
    fake.edit(REALM, 'Invoice', l.qbo_id, { Line: q.Line.map((x) => (x.SalesItemLineDetail ? { ...x, Amount: 750, SalesItemLineDetail: { ...x.SalesItemLineDetail, Qty: 1, UnitPrice: 750 } } : x)) });
    await webhook();
    await drain('the pull into the closed month');
    const held = await link('invoices', 'r1-sep');
    if (held.state !== 'needs_review' || held.reason !== 'period_locked') throw new Error(`after the pull ${J({ state: held.state, reason: held.reason })}`);
    const kept = (await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, 'r1-sep']))[0].data;
    if (kept.lines[0].unitCents !== 80000) throw new Error('Fishtape changed a locked invoice');
    const c = (await row("SELECT id FROM qbo_conflicts WHERE tenant_id = $1 AND record_id = 'r1-sep' AND status = 'open'", [tg]))[0];
    await own.goto(`/#/quickbooks/conflicts/${c.id}`);
    await own.waitFor('[...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "Keep the difference noted")', 'the Release 1 choices');
    const labels = await own.evaluate('[...document.querySelectorAll("main .qbo-actions button")].map((b) => b.textContent.trim())');
    if (J(labels) !== J(['Reopen the period and accept QuickBooks', 'Keep the difference noted'])) throw new Error(`buttons ${J(labels)}`);
    await own.fill('main textarea[aria-label="Note"]', 'Bookkeeper corrected the price after the close.');
    await own.shot('q14-locked-review');
    const before = own.qboCalls.length;
    await own.click('Keep the difference noted', 'main');
    await own.waitFor('location.hash === "#/quickbooks/conflicts"', 'back on the list');
    const sent = own.qboCalls.slice(before).find((x) => /\/resolve$/.test(x.path));
    if (J(sent?.body) !== J({ choice: 'note', note: 'Bookkeeper corrected the price after the close.' })) throw new Error(`resolve body ${J(sent?.body)}`);
    await drain('after the note');
    const after = await link('invoices', 'r1-sep');
    if (after.state !== 'synced' || after.meta?.noted?.note !== 'Bookkeeper corrected the price after the close.') throw new Error(`after ${J({ state: after.state, noted: after.meta?.noted })}`);
    const still = (await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, 'r1-sep']))[0].data;
    if (still.lines[0].unitCents !== 80000 || cents(fake.get(REALM, 'Invoice', l.qbo_id).Line[0].Amount) !== 75000) throw new Error('a side was overwritten after the note');
    await superDb.query("INSERT INTO period_locks (tenant_id, kind, through, actor) VALUES ($1, 'books', NULL, 'e2e')", [tg]);
    return 'needs_review/period_locked; two choices; noted with the note; neither side overwritten';
  });

  await step('phone layout: the QuickBooks screens fit 390 px', async () => {
    let practiceLocked = null;
    for (const h of ['#/quickbooks', '#/quickbooks/activity', '#/quickbooks/conflicts', '#/quickbooks/mappings', '#/quickbooks/lookup']) {
      await olive.goto(`/${h}`);
      await olive.waitFor('!!document.querySelector("main .qbo-nav")', h);
      await sleep(600);
      await noSideScroll(olive, h);
      if (h === '#/quickbooks/mappings') {
        await olive.waitFor('!!document.querySelector("main input[name=practice]")', 'the options');
        practiceLocked = await olive.evaluate('document.querySelector("main input[name=practice]").disabled');
        await olive.shot('q13-phone-mappings', { full: true });
      }
    }
    if (practiceLocked !== true) throw new Error('an office user can switch practice mode (Go live is an owner\'s)');
    return '5 screens, no sideways scroll; the practice switch is read-only for office';
  });
} catch {
  exitCode = 1;
} finally {
  const all = [];
  for (const p of pages) {
    const errs = p.consoleLines.filter((l) => /^\[(error|exception|assert)\]/.test(l)
      || (/^\[log:error\]/.test(l) && !/api\/v1\/(me|auth\/providers)/.test(l) && !/Failed to load resource.*(403|401)/.test(l)));
    all.push(...errs.map((l) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'quickbooks-e2e-results.json'), J({ results, jobs: worker.runs.slice(-120), failedJobs: worker.failed, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60), qbo: p.qboCalls.slice(-40) })) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`worker: ${worker.runs.length} jobs run, ${worker.failed.length} failed`);
  for (const f of worker.failed.slice(0, 10)) console.log('   ', f.kind, f.outcome, (f.error || '').slice(0, 200));
  console.log(`browser console errors: ${all.length}`);
  for (const e of all.slice(0, 20)) console.log('   ', e.slice(0, 300));
  console.log(`screenshots in ${SCRATCH}: ${shots.length}`);
  if (all.length || worker.failed.length) exitCode = 1;
  worker.stop = true;
  await Promise.race([workerDone, sleep(5000)]);
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  web.close();
  try { await api?.close(); } catch { /* ignore */ }
  try { await fakeHttp.close(); } catch { /* ignore */ }
  await db.close?.();
  await ownerClient.end(); await superDb.end();
  await pgServer.stop();
  await sleep(500);
  try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* Windows may hold files */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
