// RST exemptions end to end (docs/releases/r1-get-paid.md 2.9, 3.1, 3.2, 12.2): embedded Postgres 17
// + the API (in-process) + a static server that proxies /api/ like nginx + headless Chrome over CDP.
//   The owner of TG Electrical (Manitoba) on an iPad (1180 x 820):
//   1. bills a general contractor with "PST/RST exempt, GST charged" and no exemption on file:
//      the invoice can't be emailed (the dialog gives the Manitoba hint) and the server refuses it;
//   2. marks the exemption on the job (subtrade, RST no. 1234567): a new invoice on the job leaves
//      RST off with the exemption filled in, prints "RST exemption: ...subtrade, RST no. 1234567",
//      and sends;
//   3. the same client on another job is charged RST (the client's evidence alone changes nothing);
//   4. a British Columbia invoice without a PST number only warns, and sends.
// Email goes through a connected Resend account into the outbox (the sender worker is not running,
// so nothing leaves the machine). Marking the exemption on the job uses the job card when it is
// there (R1-D, `jobs.js`), otherwise writes jobs.taxExempt through the store as that card would.
//
//   cd server && npm install
//   node electrical-app/tests/e2e/rst.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-rst-e2e-'));
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
const { generate } = await pkg('otplib');

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

// TG Electrical in Manitoba, on Pro (email is a Pro feature); the owner signs in with a known password.
const tg = (await superDb.query("SELECT id FROM tenants WHERE name = 'TG Electrical'")).rows[0].id;
await superDb.query("UPDATE tenants SET province = 'MB', plan = 'pro' WHERE id = $1", [tg]).catch(async () => superDb.query("UPDATE tenants SET plan = 'pro' WHERE id = $1", [tg]));
const owner = { email: 'owner@tgelectrical.test', password: `pw-${randomBytes(10).toString('hex')}` };
await superDb.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE email = $1', [owner.email, await hashSecret(owner.password)]);
log('seeded TG Electrical (MB, Pro)');

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
  listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    else if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`[exception] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    else if (msg.method === 'Log.entryAdded') consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
  });
  for (const m of ['Runtime.enable', 'Page.enable', 'Log.enable']) await send(m);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
    name, send, evaluate, waitFor, consoleLines,
    async goto(path) { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); await waitFor(`document.readyState === "complete" && location.href.startsWith(${J(ORIGIN)})`, 'load'); },
    fill: (sel, val) => evaluate(`(() => { const el = [...document.querySelectorAll(${J(sel)})].at(-1); if (!el) throw new Error('missing ' + ${J(sel)}); el.focus(); if (el.type === 'checkbox') el.checked = ${J(Boolean(val))}; else el.value = ${J(String(val))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    click: (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a, [role=button], [role=tab]')].find((b) => (b.textContent.trim() === ${J(text)} || b.getAttribute('aria-label') === ${J(text)}) && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)} + ' in ' + ${J(within)}); el.click(); return true; })()`),
    has: (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); return !!root && [...root.querySelectorAll('button')].some((b) => b.textContent.trim() === ${J(text)} && b.getClientRects().length); })()`),
    async shot(file) { try { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SCRATCH, `${file}.png`), Buffer.from(data, 'base64')); } catch { /* ignore */ } },
  };
}

const pages = [];
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
const row = async (sql, args = []) => (await superDb.query(sql, args)).rows;
const mainText = (p) => p.evaluate('document.querySelector("main").innerText');
const pickOption = (p, sel, label) => p.evaluate(`(() => {
  const s = [...document.querySelectorAll(${J(sel)})].at(-1); if (!s) throw new Error('no select ' + ${J(sel)});
  const o = [...s.options].find((x) => x.textContent.trim() === ${J(label)}); if (!o) throw new Error('no option ' + ${J(label)} + ': ' + [...s.options].map((x) => x.textContent).join('|'));
  s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
/** The invoice open on screen, as the store has it (after the editor's autosave). */
const invoiceOnScreen = async (p) => {
  await sleep(700);
  return p.evaluate('kelbe.store.get("invoices", location.hash.split("/")[2].split("?")[0])');
};
/** A new invoice for a job, through the app's own "New invoice" route. */
async function newInvoice(p, jobId) {
  const before = await p.evaluate('location.hash');
  await p.goto(`/#/invoices/new?jobId=${jobId}`);
  await p.waitFor(`location.hash.startsWith("#/invoices/") && !location.hash.includes("new") && location.hash !== ${J(before)} && !!document.querySelector("main select[name=taxTreatment]")`, 'the new invoice');
  return p.evaluate('location.hash.split("/")[2].split("?")[0]');
}
const addLabour = async (p) => {
  const n = await p.evaluate('document.querySelectorAll("main .lines-body .line-row").length');
  await p.click('Labour', 'main');
  await p.waitFor(`document.querySelectorAll("main .lines-body .line-row").length === ${n + 1}`, 'a labour line');
  await p.fill('main .lines-body .line-row:last-child .line-qty input', '8');
};
const previewEmail = async (p) => {
  await p.click('Print / PDF', 'main');
  await p.waitFor('!!document.querySelector("[role=dialog] .doc-sheet")', 'the preview');
  await p.waitFor('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Email")', 'the Email button (email connected)');
};
const closeDialogs = (p) => p.evaluate('(() => { for (const b of [...document.querySelectorAll("[role=dialog] .sheet-head button")].reverse()) b.click(); return true; })()');
const outboxFor = async (id) => row("SELECT data->>'kind' AS kind, data->>'to' AS \"to\" FROM outbox WHERE tenant_id = $1 AND data->>'relatedId' = $2", [tg, id]);

let exitCode = 0;
try {
  const own = await openPage('owner-ipad', { width: 1180, height: 820, mobile: false, touch: true });
  pages.push(own);
  let jobA = null, jobB = null, inv1 = null, inv2 = null;

  await step('owner signs in; the company is in Manitoba with email connected', async () => {
    await signInOwner(own, owner);
    await own.evaluate('(() => { const s = kelbe.store.settings(); kelbe.store.saveSettings({ company: { ...s.company, name: "TG Electrical", province: "MB", gstHstNo: "123456789 RT0001", pstNo: "1234567" }, tax: { mode: "province", treatment: null, custom: [] } }); return true; })()');
    await synced(own);
    const r = await own.evaluate(`fetch("/api/v1/integrations/resend", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json", "x-fishtape": "1" },
      body: JSON.stringify({ secrets: { "resend.api_key": "re_${randomBytes(12).toString('hex')}", "resend.from": "TG Electrical <office@tgelectrical.test>" } }) }).then((r) => r.status)`);
    if (r !== 200) throw new Error(`connecting Resend: ${r}`);
    const s = (await row("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings'", [tg]))[0]?.data;
    if (s?.company?.province !== 'MB') throw new Error(`server province ${s?.company?.province}`);
    return 'MB, Resend connected';
  });

  await step('a general contractor with two jobs', async () => {
    ({ jobA, jobB } = await own.evaluate(`(() => {
      const s = kelbe.store;
      const c = s.add("clients", { name: "Prairie Builders", type: "commercial", email: "ap@prairie.example", phone: "204-555-0142", address: "77 Portage Ave, Winnipeg",
        taxExemptBasis: "subtrade", taxExemptNumber: "1234567", taxExemptProvince: "MB", taxExemptCheckedAt: "2026-10-01" });
      const a = s.add("jobs", { number: s.nextNumber("job"), title: "Federal building rewire (subcontract)", clientId: c.id, status: "active", address: "269 Main St, Winnipeg" });
      const b = s.add("jobs", { number: s.nextNumber("job"), title: "Prairie Builders office reno", clientId: c.id, status: "active", address: "77 Portage Ave, Winnipeg" });
      return { jobA: a.id, jobB: b.id }; })()`));
    await synced(own);
    await own.goto(`/#/clients/${await own.evaluate(`kelbe.store.get("jobs", ${J(jobA)}).clientId`)}`);
    await own.waitFor('!!document.querySelector("main [data-exemption-card]") && !!document.querySelector("main [data-credit-card]")', 'the exemption and credit cards');
    const card = await own.evaluate('document.querySelector("main [data-exemption-card]").innerText');
    if (!/1234567/.test(card) || !/Mark the exemption on each job/.test(card)) throw new Error(card);
    await own.shot('r01-client-cards');
    return 'client evidence on file: subtrade, RST no. 1234567';
  });

  await step('RST off without the exemption on the job: Email is blocked with the hint, the server refuses', async () => {
    inv1 = await newInvoice(own, jobA);
    const treat = await own.evaluate('document.querySelector("main select[name=taxTreatment]").value');
    if (treat !== 'pst-all') throw new Error(`default treatment ${treat}: client evidence alone must not drop RST`);
    await pickOption(own, 'main select[name=taxTreatment]', 'PST/RST exempt, GST charged');
    await addLabour(own);
    await own.waitFor('!!document.querySelector("main .tax-exempt .tax-exempt-msg.block")', 'the exemption warning on the invoice');
    await previewEmail(own);
    await own.click('Email', '[role=dialog]');
    await own.waitFor('!!document.querySelector("[data-send-block]")', 'the send-blocked dialog');
    const why = await own.evaluate('document.querySelector("[data-send-block]").innerText');
    if (!/RST/.test(why) || !/Manitoba: only when the customer is another electrical or mechanical contractor/.test(why)) throw new Error(why);
    await own.shot('r02-send-blocked');
    await own.click('OK', '[role=dialog]');
    await closeDialogs(own);
    await synced(own);
    const r = await own.evaluate(`fetch("/api/v1/integrations/email/document", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-fishtape": "1" }, body: JSON.stringify({ collection: "invoices", id: ${J(inv1)} }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`);
    if (r.status !== 422 || r.body?.error?.code !== 'exemption_required') throw new Error(`server: ${J(r)}`);
    if ((await outboxFor(inv1)).length) throw new Error('queued anyway');
    return `PWA blocked; server ${r.status} ${r.body.error.code}`;
  });

  await step('mark the exemption on the job; a new invoice leaves RST off, prints the number and sends', async () => {
    // The job's "Contract and payment" card (R1-D) holds lib/doc-view.js exemptionEditor; ticking it
    // fills the client's evidence. Without that card, write jobs.taxExempt as the card does.
    await own.goto(`/#/jobs/${jobA}`);
    await own.waitFor('!!document.querySelector("main h1")', 'the job');
    const onCard = await own.evaluate('!!document.querySelector("main .tax-exempt-job input[name=taxExempt]")');
    if (onCard) await own.evaluate('(() => { document.querySelector("main .tax-exempt-job input[name=taxExempt]").click(); return true; })()');
    else await own.evaluate(`(() => { kelbe.store.update("jobs", ${J(jobA)}, { taxExempt: { basis: "subtrade", number: "1234567", endCustomer: null, details: {}, confirmedBy: kelbe.auth.who().name, confirmedAt: new Date().toISOString(), province: "MB" } }); return true; })()`);
    await synced(own);
    const ex = (await row('SELECT data->\'taxExempt\' AS x FROM jobs WHERE tenant_id = $1 AND id = $2', [tg, jobA]))[0]?.x;
    if (ex?.basis !== 'subtrade' || ex?.number !== '1234567') throw new Error(`job exemption on the server: ${J(ex)}`);
    if (typeof ex.confirmedBy !== 'string' || !ex.confirmedBy) throw new Error(`confirmedBy must be the name (jobs schema: a string): ${J(ex.confirmedBy)}`);
    inv2 = await newInvoice(own, jobA);
    let treat = await own.evaluate('document.querySelector("main select[name=taxTreatment]").value');
    let via = 'new invoice default';
    if (treat !== 'gst-only') {
      // Until invoices.js passes the job to newDocTax (R1-D), the editor offers the job's exemption.
      await own.click('Use the job’s exemption', 'main');
      await own.waitFor('document.querySelector("main select[name=taxTreatment]").value === "gst-only"', 'gst-only');
      treat = 'gst-only'; via = '"Use the job’s exemption"';
    }
    await addLabour(own);
    await own.waitFor('!!document.querySelector("main .tax-exempt .tax-exempt-msg.ok")', 'the exemption ready to print');
    const doc = await invoiceOnScreen(own);
    if (doc.taxExemptBasis !== 'subtrade' || doc.taxExemptNumber !== '1234567' || doc.taxTreatment !== 'gst-only') throw new Error(J({ b: doc.taxExemptBasis, n: doc.taxExemptNumber, t: doc.taxTreatment }));
    if ((doc.taxes || []).find((x) => x.id === 'RST')?.applies?.labour) throw new Error('RST still charged');
    await synced(own);
    await previewEmail(own);
    const printed = await own.evaluate('document.querySelector("[role=dialog] [data-exemption]")?.innerText || ""');
    if (!/RST exemption: [^\n]*subtrade, RST no\. 1234567/i.test(printed)) throw new Error(`printed: ${printed}`);
    await own.shot('r03-printed-exemption');
    await own.click('Email', '[role=dialog]');
    await own.waitFor('!!document.querySelector("[role=dialog] input[name=to]")', 'the email sheet');
    await own.click('Send', '[role=dialog]');
    await own.waitFor('/Sending invoice/.test(document.querySelector(".toasts")?.innerText || "")', 'sending');
    await closeDialogs(own);
    await synced(own);
    const ob = await outboxFor(inv2);
    if (ob.length !== 1 || ob[0].kind !== 'invoice' || ob[0].to !== 'ap@prairie.example') throw new Error(J(ob));
    const st = (await row('SELECT data->>\'status\' AS s FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, inv2]))[0]?.s;
    if (st !== 'sent') throw new Error(`status ${st}`);
    return `exemption via ${via}; printed; emailed to ${ob[0].to}`;
  });

  await step('the same client on another job is charged RST', async () => {
    const id = await newInvoice(own, jobB);
    const treat = await own.evaluate('document.querySelector("main select[name=taxTreatment]").value');
    if (treat !== 'pst-all') throw new Error(`treatment ${treat}`);
    if (await own.evaluate('!!document.querySelector("main .tax-exempt")?.childNodes.length')) throw new Error('an exemption editor on a taxed invoice');
    await addLabour(own);
    const doc = await invoiceOnScreen(own);
    if (doc.taxExemptBasis || !(doc.taxes || []).find((x) => x.id === 'RST')?.applies?.labour) throw new Error(J({ b: doc.taxExemptBasis, taxes: doc.taxes }));
    if (!/RST 7%/.test(await mainText(own))) throw new Error('no RST in the totals');
    return `${id}: GST + RST`;
  });

  await step('British Columbia without a PST number only warns, and sends', async () => {
    const id = await newInvoice(own, jobB);
    await pickOption(own, 'main select[name=taxProvince]', 'British Columbia');
    await pickOption(own, 'main select[name=taxTreatment]', 'PST/RST exempt, GST charged');
    await addLabour(own);
    await own.waitFor('!!document.querySelector("main .tax-exempt .tax-exempt-msg.warn")', 'the BC warning');
    if (await own.evaluate('!!document.querySelector("main .tax-exempt .tax-exempt-msg.block")')) throw new Error('BC must not block');
    await invoiceOnScreen(own);
    await synced(own);
    await previewEmail(own);
    await own.click('Email', '[role=dialog]');
    await own.waitFor('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Send anyway")', 'the warning');
    await own.click('Send anyway', '[role=dialog]');
    await own.waitFor('!!document.querySelector("[role=dialog] input[name=to]")', 'the email sheet');
    await own.click('Send', '[role=dialog]');
    await own.waitFor('/Sending invoice/.test(document.querySelector(".toasts")?.innerText || "")', 'sending');
    await closeDialogs(own);
    await synced(own);
    const ob = await outboxFor(id);
    if (ob.length !== 1) throw new Error(J(ob));
    await own.shot('r04-bc-sent');
    return `${id}: warned, sent`;
  });
} catch {
  exitCode = 1;
} finally {
  const all = [];
  for (const p of pages) {
    const errs = p.consoleLines.filter((l) => /^\[(error|exception|assert)\]/.test(l)
      || (/^\[log:error\]/.test(l) && !/api\/v1\/(me|auth\/providers)/.test(l) && !/Failed to load resource.*(403|422)/.test(l)));
    all.push(...errs.map((l) => `${p.name}: ${l}`));
  }
  writeFileSync(join(SCRATCH, 'rst-e2e-results.json'), J({ results, console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`browser console errors: ${all.length}`);
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
