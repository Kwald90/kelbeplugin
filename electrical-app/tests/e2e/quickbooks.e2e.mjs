// QuickBooks end to end (docs/integrations/quickbooks.md 11.5, W4): embedded Postgres 17 + the API
// (in-process) + a static server that proxies /api/ like nginx + the fake QuickBooks (W1,
// server/test/support/fake-qbo.js) in HTTP mode + headless Chrome over CDP.
//
// The QuickBooks routes of section 7 belong to W3 and are built in parallel, so this file answers
// them itself (`qboApi` below), on top of the real pieces that already exist:
//  - the connect flow is real W1 code: ticket (createConnectTicket), the interstitial (startPage),
//    start (startFromTicket), the fake's Intuit consent, the callback (completeCallback) and the
//    qbo_connections row it writes; disconnect and pause are W1's too;
//  - the webhook is verified and ingested by W1's receiveWebhook with a real HMAC signature;
//  - QuickBooks-side changes reach Fishtape through records.patchRecord as the system:qbo actor,
//    so devices get them on their next pull exactly as the engine's writes would arrive;
//  - the wizard, mappings, record states, conflicts, log and look-up are an in-memory stand-in that
//    follows the shapes of section 7. Once W3 merges, drop the stand-in and let /api/v1/qbo through.
//
//   owner on a desktop (1280 x 800): connects (ticket, interstitial, consent, callback), walks the
//     wizard (settings with a practice week, tax codes with the old 8% code refused, matching, the
//     Review step refusing Apply until every difference has a side), applies; practice mode shows the
//     "would change" list and writes nothing; goes live; resolves a conflict; picks "Why no tax?";
//     sees a settlement payment read-only.
//   office user on a phone (390 x 844, no two-step sign-in): reads the status, gets mfa_required on
//     Sync now; sends an invoice and its badge reaches "In QuickBooks"; a QuickBooks-side change
//     arrives by signed webhook and shows on the invoice.
//   foreman on a phone: no QuickBooks in the rail, "No access", no badges, 403 from /api/v1/qbo/status.
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
import { randomBytes, createHmac } from 'node:crypto';

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
const { createFakeQbo } = await mod('test/support/fake-qbo.js');
const C = await mod('src/qbo/connection.js');
const { donePage, PAGE_HEADERS } = await mod('src/qbo/pages.js');
const { receiveWebhook } = await mod('src/qbo/webhook.js');

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

// ---------- Postgres, fake QuickBooks, API, static + proxy ----------
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
log('seeded TG Electrical (Manitoba, Pro) with an owner, an office user and a foreman');

const fake = createFakeQbo();
const REALM = '9130350000000771';
fake.addCompany(REALM, { name: 'TG Electrical Ltd.' });
const fakeHttp = await fake.listen();
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
const records = createRecords({ validator: createValidator() });
const qboP = systemPrincipal(tg, 'qbo', 'QuickBooks sync');
const asQbo = (fn) => db.withTenant({ tenantId: tg }, (tx) => fn(tx, qboP, systemWho(qboP)), { write: true });
let api = null;
api = await buildApp({ config, db });
await api.listen({ port: apiPort, host: '127.0.0.1' });
log('API up');

// ---------- the QuickBooks API stand-in (section 7 shapes) ----------
const seedQ = fake.seed(REALM);
const rateById = new Map(Object.values(seedQ.taxRates).map((r) => [r.Id, r]));
const ratesOf = (list) => (list?.TaxRateDetail || []).map((d) => rateById.get(d.TaxRateRef.value)).filter(Boolean).map((r) => ({ name: r.Name, pct: Number(r.RateValue) }));
const CHOICES = {
  taxCodes: Object.values(seedQ.taxCodes).map((c) => ({ id: c.Id, name: c.Name, active: c.Active !== false, salesRates: ratesOf(c.SalesTaxRateList), purchaseRates: ratesOf(c.PurchaseTaxRateList) })),
  items: Object.values(seedQ.items).map((i) => ({ id: i.Id, name: i.Name, type: i.Type })),
  accounts: Object.values(seedQ.accounts).map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType, subType: a.AccountSubType })),
  paymentMethods: Object.values(seedQ.paymentMethods).map((m) => ({ id: m.Id, name: m.Name })),
  classes: [], departments: [], terms: [{ id: seedQ.terms.net30.Id, name: 'Net 30' }],
};
const REQUIRED = [['taxCode', 'GST+RST|MB'], ['taxCode', 'GST'], ['item', 'material'], ['item', 'labour'], ['item', 'other'], ['account', 'income.default'], ['account', 'expense.default'], ['option', 'timeOwner']];
const mock = {
  mappings: {}, candidates: [], setup: null, links: {}, conflicts: [], log: [], checks: [], calls: [], pendingRemote: null, resolved: [],
  lastPushAt: null, lastPullAt: null, seq: 0,
};
const nowIso = () => new Date().toISOString();
const linkOf = (c, id) => (mock.links[c] ||= {})[id];
const setLink = (c, id, s) => { (mock.links[c] ||= {})[id] = { ...(mock.links[c]?.[id] || {}), ...s }; };
const addLog = (e) => mock.log.unshift({ id: `log-${++mock.seq}`, at: nowIso(), actorType: 'system', errorCode: null, intuitTid: null, ...e });
const mapGet = (k, key) => mock.mappings[k]?.[key] ?? null;

function countsNow() {
  const all = Object.values(mock.links).flatMap((m) => Object.values(m));
  const n = (s) => all.filter((l) => l.state === s).length;
  return { pending: n('pending'), error: n('error'), blocked: n('blocked'), conflict: n('conflict'), needsReview: n('needs_review'), mismatch: mock.checks.length, waitingOffline: 0 };
}
async function statusFor(me) {
  const conn = await db.withTenant({ tenantId: me.tenant.id }, C.loadConnection);
  return {
    available: true, environment: 'sandbox', plan: { entitled: true, needs: 'pro' },
    state: conn?.state || 'not_connected', pauseReason: conn?.pause_reason || null, reconnectReason: conn?.reconnect_reason || null,
    companyName: conn ? 'TG Electrical Ltd.' : null, features: conn?.features || null, connectedAt: conn?.connected_at || null,
    syncFrom: mapGet('option', 'syncFrom'), lastPullAt: mock.lastPullAt, lastPushAt: mock.lastPushAt, counts: countsNow(),
    writeMode: mapGet('option', 'writeMode') || 'live', writesEnabled: true, refreshExpiresAt: conn?.refresh_expires_at || null, hardExpiresAt: conn?.refresh_hard_expires_at || null,
    setup: mock.setup || conn?.setup || null, lookupsEnabled: true, takeoverOffer: await C.hasTakeoverOffer(db, me.tenant.id, me.user.id),
  };
}
function mappingsBody() {
  const required = REQUIRED.filter(([k, key]) => mapGet(k, key) == null).map(([kind, key]) => ({ kind, key }));
  const sug = { taxCode: { 'GST+RST|MB': seedQ.taxCodes.gstPst.Id, GST: seedQ.taxCodes.gst.Id, 'NONE|EXEMPT': seedQ.taxCodes.exempt.Id, 'NONE|ZERO': seedQ.taxCodes.zero.Id, 'NONE|OOS': seedQ.taxCodes.oos.Id } };
  return { mappings: mock.mappings, choices: CHOICES, required, suggestions: sug };
}
const pct = (k) => ({ 'GST+RST|MB': [5, 7], GST: [5], 'NONE|EXEMPT': [], 'NONE|ZERO': [], 'NONE|OOS': [], 'NONE|RELIEF': [] }[k]);
function validateMappings(set) {
  for (const s of set) {
    if (s.kind !== 'taxCode') continue;
    const code = CHOICES.taxCodes.find((c) => c.id === String(s.value));
    const want = pct(s.key);
    const has = (code?.salesRates || []).map((r) => r.pct).filter((x) => x > 0).sort((a, b) => a - b);
    if (!code || (want && J(has) !== J(want))) return `QuickBooks code ${code?.name || s.value} charges ${has.join('% + ')}%; Fishtape charges ${(want || []).join('% + ')}%`;
  }
  return null;
}
async function scan() {
  const clients = (await superDb.query('SELECT id, data FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY data->>\'name\'', [tg])).rows;
  const invoices = (await superDb.query('SELECT id, data FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY id', [tg])).rows;
  const [a, b] = clients;
  mock.candidates = [
    { id: 'cand-a', kind: 'customers', status: 'matched', choice: 'link', score: 100, reasons: ['email'], fishtapeId: a.id, qboId: '58',
      fishtape: { id: a.id, label: a.data.name, email: a.data.email }, quickbooks: { qboId: '58', label: `${a.data.name} Ltd`, email: a.data.email },
      diffs: [{ field: 'phone', label: 'Phone', fishtape: a.data.phone || '', quickbooks: '204-555-0199' }, { field: 'address', label: 'Address', fishtape: a.data.address, quickbooks: '42 Harbour Street, Winnipeg MB' }], fieldChoices: {}, confirmed: false },
    { id: 'cand-b', kind: 'customers', status: 'ambiguous', choice: 'skip', score: 70, reasons: ['name', 'name_only'], fishtapeId: b.id, qboId: '61',
      fishtape: { id: b.id, label: b.data.name, email: b.data.email }, quickbooks: { qboId: '61', label: b.data.name, email: null }, alternatives: [{ qboId: '62', label: `${b.data.name} (2)` }], diffs: [], fieldChoices: {} },
    { id: 'cand-c', kind: 'customers', status: 'quickbooks_only', choice: 'create_in_fishtape', score: 0, reasons: [], qboId: '77', quickbooks: { qboId: '77', label: 'Prairie Co-op', email: 'ap@prairie.example' }, diffs: [], fieldChoices: {} },
    { id: 'cand-d', kind: 'invoices', status: 'ambiguous', choice: 'skip', score: 80, reasons: ['possible_duplicate'], fishtapeId: invoices[0]?.id || null, qboId: '901',
      fishtape: { number: invoices[0]?.data.number || 'INV-3001', date: '2026-10-02', totalCents: 112000 }, quickbooks: { qboId: '901', number: '1043', date: '2026-10-03', totalCents: 112000 }, diffs: [], fieldChoices: {} },
  ];
  mock.setup = { phase: 'scan', done: 4, total: 4, finishedAt: nowIso() };
}
async function finishApply(shadow) {
  const total = 4;
  for (let i = 1; i <= total; i++) { await sleep(700); mock.setup = { phase: i < 3 ? 'links' : 'customers', done: i, total, errors: 0, startedAt: mock.setup?.startedAt }; }
  for (const c of mock.candidates.filter((x) => x.choice === 'link' && x.kind === 'customers')) setLink('clients', c.fishtapeId, { state: shadow ? 'synced' : 'synced', docNumber: null, qboId: c.qboId });
  await superDb.query(`UPDATE qbo_connections SET state = 'active', setup = $2::jsonb WHERE tenant_id = $1`, [tg, J({ phase: 'done', done: total, total, errors: 0, finishedAt: nowIso() })]);
  mock.setup = null;
  addLog({ direction: 'push', outcome: shadow ? 'shadow' : 'ok', action: 'setup', collection: null, recordId: null, label: null, message: shadow ? 'Would link 1 customer and create 1 in Fishtape' : 'Setup applied' });
}
/** The engine stand-in: every sent invoice without a link is created in QuickBooks (or, in practice mode, only logged). */
async function engineRun() {
  const shadow = mapGet('option', 'writeMode') === 'shadow';
  const invs = (await superDb.query("SELECT id, data FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'status' <> 'draft'", [tg])).rows;
  let n = 0;
  for (const r of invs) {
    if (linkOf('invoices', r.id)?.state) continue;
    n++;
    if (shadow) { addLog({ direction: 'push', outcome: 'shadow', action: 'create', collection: 'invoices', recordId: r.id, label: `Invoice ${r.data.number}`, message: `Would create invoice ${r.data.number} in QuickBooks` }); continue; }
    setLink('invoices', r.id, { state: 'synced', reason: null, docNumber: r.data.number, syncedAt: nowIso(), qboId: String(500 + n) });
    addLog({ direction: 'push', outcome: 'ok', action: 'create', collection: 'invoices', recordId: r.id, label: `Invoice ${r.data.number}`, message: `Created invoice ${r.data.number} in QuickBooks`, intuitTid: `1-${randomBytes(6).toString('hex')}` });
  }
  if (!shadow) mock.lastPushAt = nowIso();
  return n;
}

const err = (status, code, message, details) => ({ status, body: { error: { code, message, requestId: 'e2e', ...(details ? { details } : {}) } } });
const ok = (body, status = 200) => ({ status, body });
async function meOf(cookie) {
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/v1/me`, { headers: { cookie: cookie || '', accept: 'application/json' } });
  return r.ok ? r.json() : null;
}
const cookieOf = (header, name) => (String(header || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1) || null;
const WRITE_ROUTES = /^(POST|PUT|DELETE) \/api\/v1\/qbo\/(?!lookup\/(customers|invoices|estimates)$)/;
const ADMIN_ROUTES = /^POST \/api\/v1\/qbo\/(connect|connect\/takeover|disconnect)$/;

async function qboRoute(rq, url, raw) {
  const method = rq.method;
  const path = url.pathname;
  const key = `${method} ${path}`;
  // Public OAuth pages and the webhook (2.2, 5.9).
  if (key === 'GET /api/v1/qbo/oauth/start') {
    const me = await meOf(rq.headers.cookie);
    const r = await C.startPage(db, config, url.searchParams.get('ticket'), { sessionUserId: me?.user?.id || null });
    return r.html ? { status: 200, html: r.html, headers: r.headers } : { status: 302, location: r.redirect };
  }
  if (key === 'POST /api/v1/qbo/oauth/start') {
    const ticket = new URLSearchParams(raw.toString('utf8')).get('ticket');
    const r = await C.startFromTicket(db, sealer, config, ticket);
    return { status: 302, location: r.redirect, cookies: r.flowCookie ? [`${C.FLOW_COOKIE}=${r.flowCookie}; Path=${C.FLOW_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=600`] : [] };
  }
  if (key === 'GET /api/v1/qbo/oauth/callback') {
    const me = await meOf(rq.headers.cookie);
    const q = url.searchParams;
    const r = await C.completeCallback(db, sealer, config, { code: q.get('code'), state: q.get('state'), realmId: q.get('realmId'), error: q.get('error'), flowCookie: cookieOf(rq.headers.cookie, C.FLOW_COOKIE), sessionUserId: me?.user?.id || null });
    mock.calls.push({ key, result: r.result });
    return { status: 302, location: r.redirect, cookies: [`${C.FLOW_COOKIE}=; Path=${C.FLOW_COOKIE_PATH}; Max-Age=0`] };
  }
  if (key === 'GET /api/v1/qbo/oauth/done') return { status: 200, html: donePage(url.searchParams.get('result')), headers: PAGE_HEADERS };
  if (key === 'POST /api/v1/webhooks/qbo') {
    const r = await receiveWebhook(db, sealer, config, raw, rq.headers['intuit-signature']);
    if (r.status === 200 && mock.pendingRemote) {
      const p = mock.pendingRemote; mock.pendingRemote = null;
      await asQbo((tx, pr, who) => records.patchRecord(tx, pr, p.collection, p.id, p.patch, {}, who));
      mock.lastPullAt = nowIso();
      addLog({ direction: 'pull', outcome: 'ok', action: 'update', collection: p.collection, recordId: p.id, label: p.label, message: p.message });
    }
    return ok(r.body, r.status);
  }

  // Everything else: office sessions only (7.1).
  const me = await meOf(rq.headers.cookie);
  const role = me?.tenant?.role;
  mock.calls.push({ key, role });
  if (!me?.tenant || me.session?.kind === 'crew' || !['owner', 'admin', 'office'].includes(role)) return err(403, 'forbidden', 'QuickBooks is for office users only.');
  if (ADMIN_ROUTES.test(key) && !['owner', 'admin'].includes(role)) return err(403, 'forbidden', 'Only an owner or admin can do this.');
  if (WRITE_ROUTES.test(key) && !me.session.mfaEnrolled) return err(403, 'mfa_required', 'Turn on two-step sign-in to change QuickBooks data.', { mfa: 'enrol', link: '#/account' });
  const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  const tenantId = me.tenant.id;
  try {
    if (key === 'GET /api/v1/qbo/status') return ok(await statusFor(me));
    if (key === 'POST /api/v1/qbo/connect') return ok(await C.createConnectTicket(db, config, { tenantId, userId: me.user.id, returnTo: body.returnTo, reconnect: Boolean(body.reconnect) }));
    if (key === 'POST /api/v1/qbo/disconnect') return ok({ ok: true, ...(await C.disconnect(db, sealer, config, tenantId, { purge: Boolean(body.purge) })) });
    if (key === 'POST /api/v1/qbo/pause') { await C.setPaused(db, tenantId, Boolean(body.paused), 'user', { allowCount: body.allowCount ?? null }); return ok(await statusFor(me)); }
    if (key === 'POST /api/v1/qbo/sync') { await engineRun(); return ok({ queued: true }, 202); }
    if (key === 'GET /api/v1/qbo/mappings') return ok(mappingsBody());
    if (key === 'PUT /api/v1/qbo/mappings') {
      const bad = validateMappings(body.set || []);
      if (bad) return err(400, 'validation_failed', bad);
      for (const s of body.set || []) (mock.mappings[s.kind] ||= {})[s.key] = s.value;
      for (const r of body.remove || []) delete mock.mappings[r.kind]?.[r.key];
      return ok(mappingsBody());
    }
    if (key === 'POST /api/v1/qbo/reference/refresh') return ok({ queued: true }, 202);
    if (key === 'POST /api/v1/qbo/setup/scan') { await scan(); return ok({ setup: mock.setup }, 202); }
    if (key === 'GET /api/v1/qbo/setup/matches') {
      const q = url.searchParams;
      const data = mock.candidates.filter((c) => (!q.get('kind') || c.kind === q.get('kind')) && (!q.get('status') || c.status === q.get('status')) && (!q.get('choice') || c.choice === q.get('choice')));
      const counts = Object.fromEntries(['matched', 'ambiguous', 'fishtape_only', 'quickbooks_only'].map((s) => [s, mock.candidates.filter((c) => c.kind === (q.get('kind') || c.kind) && c.status === s).length]));
      return ok({ data, cursor: null, more: false, counts });
    }
    if (key === 'PUT /api/v1/qbo/setup/matches') {
      let updated = 0;
      for (const ch of body.choices || []) {
        const c = mock.candidates.find((x) => x.id === ch.id);
        if (!c) continue;
        Object.assign(c, { choice: ch.choice ?? c.choice, ...(ch.qboId ? { qboId: ch.qboId } : {}), ...(ch.fieldChoices ? { fieldChoices: ch.fieldChoices } : {}), ...(ch.confirmed != null ? { confirmed: ch.confirmed } : {}) });
        updated++;
      }
      if (body.bulk) for (const c of mock.candidates.filter((x) => x.kind === body.bulk.kind)) {
        if (body.bulk.fieldsFrom && c.choice === 'link') { c.fieldChoices = Object.fromEntries((c.diffs || []).map((d) => [d.field, body.bulk.fieldsFrom])); updated++; }
        if (body.bulk.choice && c.status === body.bulk.status) { c.choice = body.bulk.choice; updated++; }
      }
      return ok({ updated });
    }
    if (key === 'GET /api/v1/qbo/setup/plan') {
      const undecided = mock.candidates.filter((c) => c.choice === 'link').reduce((n, c) => n + (c.diffs || []).filter((d) => !c.fieldChoices?.[d.field]).length, 0);
      const kinds = [...new Set(mock.candidates.map((c) => c.kind))];
      const cnt = (k, ch) => mock.candidates.filter((c) => c.kind === k && c.choice === ch).length;
      return ok({
        phases: kinds.map((k) => ({ kind: k, link: cnt(k, 'link'), createInQbo: cnt(k, 'create_in_qbo'), createInFishtape: cnt(k, 'create_in_fishtape'), skip: cnt(k, 'skip') })),
        warnings: [{ code: 'differences', message: 'Differences still to decide', count: undecided }, { code: 'possible_duplicates', message: 'Possible duplicates', count: mock.candidates.filter((c) => (c.reasons || []).includes('possible_duplicate')).length }],
        numbers: { invoice: { qboHighest: 1043, fishtapeNext: 3001 }, estimate: { qboHighest: null, fishtapeNext: 2002 } },
      });
    }
    if (key === 'POST /api/v1/qbo/setup/apply') {
      const undecided = mock.candidates.some((c) => c.choice === 'link' && (c.diffs || []).some((d) => !c.fieldChoices?.[d.field]));
      if (undecided) return err(409, 'setup_incomplete', 'Some differences still need a choice.');
      mock.setup = { phase: 'links', done: 0, total: 4, errors: 0, startedAt: nowIso() };
      mock.applied = body;
      finishApply(mapGet('option', 'writeMode') === 'shadow').catch((e) => log('apply failed', e.message));
      return ok({ setup: mock.setup }, 202);
    }
    if (key === 'POST /api/v1/qbo/setup/cancel') return ok({ setup: mock.setup });
    if (key === 'GET /api/v1/qbo/records/status') {
      const coll = url.searchParams.get('collection');
      return ok({ data: Object.fromEntries(Object.entries(mock.links[coll] || {}).map(([id, l]) => [id, { state: l.state, reason: l.reason || null, message: l.message || null, syncedAt: l.syncedAt || null, conflictId: l.conflictId || null, docNumber: l.docNumber || null }])) });
    }
    let m = /^\/api\/v1\/qbo\/records\/(\w+)\/([^/]+)(\/\w+)?$/.exec(path);
    if (m) {
      const [, coll, id, sub] = m;
      const l = linkOf(coll, decodeURIComponent(id));
      if (method === 'GET' && !sub) {
        if (!l) return err(404, 'not_found', 'Not linked.');
        return ok({ state: { state: l.state, reason: l.reason || null, message: l.message || null, syncedAt: l.syncedAt || null, conflictId: l.conflictId || null, docNumber: l.docNumber || null },
          quickbooks: { entity: 'Invoice', docNumber: l.docNumber, updatedAt: l.syncedAt, totalCents: null, balanceCents: null, url: `https://app.sandbox.qbo.intuit.com/app/invoice?txnId=${l.qboId}` },
          log: mock.log.filter((e) => e.recordId === decodeURIComponent(id)).slice(0, 20), conflict: null });
      }
      if (sub === '/sync') return ok({ queued: true }, 202);
      return err(404, 'not_found', 'Not in the stand-in.');
    }
    if (key === 'GET /api/v1/qbo/checks') return ok({ data: mock.checks, cursor: null, more: false });
    if (key === 'GET /api/v1/qbo/log') {
      const q = url.searchParams;
      const data = mock.log.filter((e) => (!q.get('outcome') || e.outcome === q.get('outcome')) && (!q.get('collection') || e.collection === q.get('collection')) && (!q.get('recordId') || e.recordId === q.get('recordId')));
      return ok({ data, cursor: null, more: false });
    }
    if (key === 'GET /api/v1/qbo/conflicts') return ok({ data: mock.conflicts.filter((c) => c.status === (url.searchParams.get('status') || 'open')), cursor: null, more: false });
    m = /^\/api\/v1\/qbo\/conflicts\/([^/]+)(\/resolve)?$/.exec(path);
    if (m) {
      const c = mock.conflicts.find((x) => x.id === decodeURIComponent(m[1]));
      if (!c) return err(404, 'not_found', 'No such conflict.');
      if (method === 'GET') return ok(c);
      c.status = 'resolved'; c.resolvedAt = nowIso();
      mock.resolved.push({ id: c.id, ...body });
      setLink(c.collection, c.recordId, { state: 'synced', conflictId: null, reason: null });
      addLog({ direction: 'push', outcome: 'ok', action: 'resolve', collection: c.collection, recordId: c.recordId, label: c.label, message: 'Conflict resolved' });
      return ok(c);
    }
    if (key === 'POST /api/v1/qbo/lookup/customers') return ok({ data: [{ qboId: '77', name: 'Prairie Co-op', companyName: 'Prairie Co-op Ltd', email: 'ap@prairie.example', phone: null, balanceCents: 0, active: true, isJob: false, linked: null }].filter((x) => x.name.toLowerCase().startsWith(String(body.q || '').toLowerCase())) });
    return err(404, 'not_found', `The stand-in has no ${key}.`);
  } catch (e) {
    return err(e.statusCode || e.status || 500, e.code || 'error', e.message);
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };
const web = createServer((rq, rs) => {
  const url = new URL(rq.url, ORIGIN);
  if (url.pathname.startsWith('/api/v1/qbo/') || url.pathname === '/api/v1/webhooks/qbo') {
    const chunks = [];
    rq.on('data', (d) => chunks.push(d));
    rq.on('end', async () => {
      try {
        const r = await qboRoute(rq, url, Buffer.concat(chunks));
        const headers = { 'cache-control': 'no-store', ...(r.headers || {}) };
        if (r.cookies?.length) headers['set-cookie'] = r.cookies;
        if (r.location) { rs.writeHead(r.status, { ...headers, location: r.location }); rs.end(); return; }
        if (r.html) { rs.writeHead(r.status, { ...headers, 'content-type': 'text/html; charset=utf-8' }); rs.end(r.html); return; }
        rs.writeHead(r.status, { ...headers, 'content-type': 'application/json' });
        rs.end(J(r.body));
      } catch (e) {
        log('stand-in error', e.stack);
        rs.writeHead(500, { 'content-type': 'application/json' }); rs.end(J({ error: { code: 'error', message: e.message } }));
      }
    });
    return;
  }
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
  for (const m of ['Runtime.enable', 'Page.enable', 'Log.enable', 'DOM.enable']) await send(m);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
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
  return {
    name, send, evaluate, waitFor, consoleLines, width,
    async goto(path) { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); await waitFor(`document.readyState === "complete" && location.href.startsWith(${J(ORIGIN)})`, 'load'); },
    fill: (sel, val, scope = 'document') => evaluate(`(() => { const el = [...${scope}.querySelectorAll(${J(sel)})].at(-1); if (!el) throw new Error('missing ' + ${J(sel)}); el.focus(); if (el.type === 'checkbox') el.checked = ${J(Boolean(val))}; else el.value = ${J(String(val))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    click: (text, within = 'body') => evaluate(`(() => { const root = [...document.querySelectorAll(${J(within)})].at(-1); const el = root && [...root.querySelectorAll('button, a, [role=button], [role=tab]')].find((b) => (b.textContent.trim() === ${J(text)} || b.getAttribute('aria-label') === ${J(text)}) && !b.disabled && b.getClientRects().length); if (!el) throw new Error('no button: ' + ${J(text)} + ' in ' + ${J(within)}); el.click(); return true; })()`),
    text: () => evaluate('document.body.innerText'),
    async shot(file) { try { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SCRATCH, `${file}.png`), Buffer.from(data, 'base64')); } catch { /* ignore */ } },
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
  const r = await p.evaluate('({ sw: document.documentElement.scrollWidth, w: window.innerWidth })');
  if (r.sw > r.w + 1) throw new Error(`${p.name}: ${where} scrolls sideways (${r.sw} > ${r.w})`);
};
const pickOption = (p, sel, label) => p.evaluate(`(() => {
  const s = [...document.querySelectorAll(${J(sel)})].at(-1); if (!s) throw new Error('no select ' + ${J(sel)});
  const o = [...s.options].find((x) => x.textContent.trim().startsWith(${J(label)})); if (!o) throw new Error('no option ' + ${J(label)} + ': ' + [...s.options].map((x) => x.textContent).join('|'));
  s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const clickConfirm = (p, label) => p.click(label, '[role=dialog]');
/** In-app navigation that redraws even when the hash is already the same (Page.navigate would not). */
const go = (p, hash) => p.evaluate(`kelbe.nav(${J(hash)}); true`).then(() => sleep(250));

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
    const cb = mock.calls.find((x) => x.key === 'GET /api/v1/qbo/oauth/callback');
    await own.shot('q03-connected');
    return `callback result ${cb?.result}; qbo_connections.state = setup`;
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
    if (mock.mappings.option?.timeOwner !== 'fishtape' || mock.mappings.option?.writeMode !== 'shadow') throw new Error(J(mock.mappings.option));
    return `options saved: ${Object.keys(mock.mappings.option).length}, writeMode shadow`;
  });

  await step('wizard: tax codes by rates (the old 8% code refused), products and accounts; Next waits for the required ones', async () => {
    const opt = await own.evaluate(`(() => { const s = document.querySelector('main [data-map="taxCode.GST+RST|MB"] select'); return [...s.options].map((o) => ({ t: o.textContent, d: o.disabled, sel: o.selected })); })()`);
    const old = opt.find((o) => /8% \(old\)/.test(o.t));
    if (!old?.d || !/does not fit/.test(old.t)) throw new Error(`the 8% code is offered: ${J(opt)}`);
    if (!opt.find((o) => o.sel && /GST\/PST MB · 5% \+ 7%/.test(o.t))) throw new Error(`no 5% + 7% suggestion: ${J(opt)}`);
    const nextDisabled = await own.evaluate('[...document.querySelectorAll("main .qbo-wizard-foot button")].at(-1).disabled');
    if (!nextDisabled) throw new Error('Next is on with required mappings missing');
    await pickOption(own, 'main [data-map="item.material"] select', 'Materials');
    await pickOption(own, 'main [data-map="item.labour"] select', 'Labour');
    await pickOption(own, 'main [data-map="item.other"] select', 'Materials');
    await pickOption(own, 'main [data-map="account.income.default"] select', 'Sales');
    await pickOption(own, 'main [data-map="account.expense.default"] select', 'Job Materials');
    await own.click('Save', 'main');
    await own.waitFor('![...document.querySelectorAll("main .qbo-wizard-foot button")].at(-1).disabled', 'Next on after saving');
    if (mapGet('taxCode', 'GST+RST|MB') !== seedQ.taxCodes.gstPst.Id || mapGet('item', 'labour') !== seedQ.items.labour.Id) throw new Error(J(mock.mappings));
    await own.shot('q04-mappings');
    await own.click('Next', 'main');
    await own.waitFor('/step=match/.test(location.hash)', 'the match step');
    return 'GST + Manitoba RST -> GST/PST MB (5% + 7%); 5 required entries set';
  });

  await step('wizard: read QuickBooks and match (possible duplicates filter)', async () => {
    await own.waitFor('!!document.querySelector("main .qbo-scan button")', 'the read button');
    await own.click('Read QuickBooks', 'main');
    await own.waitFor('document.querySelectorAll("main table tbody tr").length === 3', 'three customer candidates');
    await own.click('Invoices', 'main');
    await own.waitFor('document.querySelectorAll("main table tbody tr").length === 1', 'the invoice candidate');
    await own.click('Possible duplicates', 'main');
    await own.waitFor('/possible duplicate/.test(document.querySelector("main table")?.innerText || "")', 'the possible duplicate');
    const opts = await own.evaluate('[...document.querySelector("main table select").options].map((o) => o.textContent)');
    if (!opts.includes('Create anyway')) throw new Error(J(opts));
    await own.shot('q05-match');
    await own.click('Next', 'main');
    await own.waitFor('/step=review/.test(location.hash) && !!document.querySelector("main .qbo-diff")', 'the review step');
    return 'customers matched/ambiguous/QuickBooks-only; the re-keyed invoice is a possible duplicate, not a create';
  });

  await step('wizard: Review refuses Apply until every differing field has a side', async () => {
    const applyOff = () => own.evaluate('[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Apply").disabled');
    if (!(await applyOff())) throw new Error('Apply is on with two differences undecided');
    if (!/2 differences still to decide/.test(await mainText(own))) throw new Error('no reason shown');
    await own.evaluate('document.querySelector("main .qbo-diff-row input[value=quickbooks]").click(); true');
    await own.waitFor('/1 difference still to decide/.test(document.querySelector("main").innerText)', 'one left');
    if (!(await applyOff())) throw new Error('Apply is on with one difference undecided');
    await own.evaluate('document.querySelectorAll("main .qbo-diff-row")[1].querySelector("input[value=fishtape]").click(); true');
    await own.waitFor('![...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Apply").disabled', 'Apply on');
    const fc = mock.candidates.find((c) => c.id === 'cand-a').fieldChoices;
    if (J(fc) !== J({ phone: 'quickbooks', address: 'fishtape' })) throw new Error(J(fc));
    await own.shot('q06-review');
    await own.click('Apply', 'main');
    await own.waitFor('/step=apply/.test(location.hash)', 'the apply step');
    await own.waitFor('/Setup applied/.test(document.querySelector("main").innerText)', 'setup applied', 30000);
    if (!/Practice mode: records are linked, nothing was written/.test(await mainText(own))) throw new Error('no practice note');
    return `field choices ${J(fc)}; applied in practice mode`;
  });

  await step('practice mode: the "would change" list, and nothing written on either side', async () => {
    const before = (await row("SELECT id, version FROM invoices WHERE tenant_id = $1 ORDER BY id", [tg]));
    invId = await own.evaluate(`(() => { const s = kelbe.store; const c = s.list("clients")[0]; const inv = s.add("invoices", { number: s.nextNumber("invoice"), clientId: c.id, status: "sent", issueDate: "2026-10-20", dueDate: "2026-11-03", lines: [{ description: "Panel work", qty: 1, unitCents: 50000, kind: "labour", labourHours: 0 }], taxProvince: "MB", taxTreatment: "pst-all", taxes: [{ id: "GST", label: "GST", pct: 5, applies: { material: true, labour: true, other: true } }, { id: "RST", label: "RST", pct: 7, applies: { material: true, labour: true, other: true } }], taxPct: 12, notes: "" }); return inv.id; })()`);
    await synced(own);
    const pushed = await engineRun();
    if (pushed !== 1) throw new Error(`engine saw ${pushed}`);
    if (linkOf('invoices', invId)) throw new Error('practice mode linked the invoice');
    const after = (await row("SELECT id, version FROM invoices WHERE tenant_id = $1 AND id <> $2 ORDER BY id", [tg, invId]));
    if (J(after) !== J(before)) throw new Error('practice mode changed Fishtape records');
    const hist = await row("SELECT (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND updated_by = 'system:qbo') + (SELECT count(*) FROM clients WHERE tenant_id = $1 AND updated_by = 'system:qbo') AS n", [tg]);
    if (Number(hist[0].n)) throw new Error(`${hist[0].n} writes by system:qbo`);
    await own.goto('/#/quickbooks');
    await own.waitFor('!!document.querySelector("main .qbo-shadow")', 'the practice banner');
    await own.click("Read the 'would change' list", 'main');
    await own.waitFor('/outcome=shadow/.test(location.hash) && /Would create invoice/.test(document.querySelector("main").innerText)', 'the would-change list');
    await own.shot('q07-shadow');
    return 'one "Would create invoice" row; no link, no Fishtape write';
  });

  await step('owner goes live', async () => {
    await own.goto('/#/quickbooks');
    await own.waitFor('!!document.querySelector("main .qbo-shadow")', 'the practice banner');
    await own.click('Go live', 'main');
    await clickConfirm(own, 'Go live');
    await own.waitFor('!document.querySelector("main .qbo-shadow") && /Syncing/.test(document.querySelector("main").innerText)', 'live');
    if (mapGet('option', 'writeMode') !== 'live') throw new Error(J(mock.mappings.option));
    return 'writeMode live';
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
    if (!mock.calls.some((c) => c.key === 'POST /api/v1/qbo/sync' && c.role === 'office')) throw new Error('no sync call');
    await olive.shot('q08-office-mfa');
    await olive.click('Later', '[role=dialog]');
    return 'status read; Sync now -> 403 mfa_required -> "Two-step sign-in needed"';
  });

  await step('office sends an invoice; its badge reaches "In QuickBooks"', async () => {
    const id = await olive.evaluate(`(() => { const s = kelbe.store; const c = s.list("clients")[1]; const inv = s.add("invoices", { number: s.nextNumber("invoice"), clientId: c.id, status: "draft", issueDate: "2026-10-20", dueDate: "2026-11-03", lines: [{ description: "Service call", qty: 2, unitCents: 9500, kind: "labour", labourHours: 2 }], taxProvince: "MB", taxTreatment: "pst-all", taxes: [{ id: "GST", label: "GST", pct: 5, applies: { material: true, labour: true, other: true } }, { id: "RST", label: "RST", pct: 7, applies: { material: true, labour: true, other: true } }], taxPct: 12, notes: "" }); return inv.id; })()`);
    await olive.goto(`/#/invoices/${id}`);
    await olive.waitFor('/Mark sent/.test(document.querySelector("main aside")?.innerText || "")', 'the draft');
    await olive.click('Mark sent', 'main');
    await synced(olive);
    await engineRun();
    if (linkOf('invoices', id)?.state !== 'synced') throw new Error(J(mock.links.invoices));
    await clearBadges(olive);
    await olive.goto('/#/invoices');
    await olive.waitFor(`[...document.querySelectorAll("main .qbo-badge")].some((b) => b.textContent === "In QuickBooks")`, 'the badge in the list');
    await olive.goto(`/#/invoices/${id}`);
    await olive.waitFor('/In QuickBooks/.test(document.querySelector("main aside")?.innerText || "")', 'the badge on the invoice');
    await olive.evaluate('document.querySelector("main aside .qbo-badge").click(); true');
    await olive.waitFor('/Open in QuickBooks/.test(document.querySelector("[role=dialog]")?.innerText || "")', 'the badge sheet');
    await olive.shot('q09-badge-sheet');
    await olive.click('Close', '[role=dialog]');
    invId = id;
    return `invoice ${id} linked; badge and sheet`;
  });

  await step('a QuickBooks-side change arrives by signed webhook and shows in Fishtape', async () => {
    mock.pendingRemote = { collection: 'invoices', id: invId, patch: { dueDate: '2026-12-31' }, label: 'Invoice', message: 'Due date changed in QuickBooks' };
    const body = J([{ specversion: '1.0', id: `ev-${randomBytes(4).toString('hex')}`, source: 'intuit.e2e', type: 'qbo.invoice.updated.v1', time: nowIso(), intuitentityid: '501', intuitaccountid: REALM, data: {} }]);
    const bad = await fetch(`${ORIGIN}/api/v1/webhooks/qbo`, { method: 'POST', headers: { 'content-type': 'application/json', 'intuit-signature': 'nope' }, body });
    if (bad.status !== 401 || !mock.pendingRemote) throw new Error(`unsigned webhook answered ${bad.status}`);
    const sig = createHmac('sha256', VERIFIER).update(body).digest('base64');
    const r = await fetch(`${ORIGIN}/api/v1/webhooks/qbo`, { method: 'POST', headers: { 'content-type': 'application/json', 'intuit-signature': sig }, body });
    if (r.status !== 200) throw new Error(`signed webhook answered ${r.status}`);
    const dirty = (await row('SELECT dirty_at FROM qbo_connections WHERE tenant_id = $1', [tg]))[0];
    if (!dirty?.dirty_at) throw new Error('the webhook did not mark the company dirty');
    const server = (await row('SELECT data->>\'dueDate\' AS due, version FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, invId]))[0];
    if (server?.due !== '2026-12-31') throw new Error(`server copy ${J(server)}`);
    await synced(olive);
    await olive.goto('/#/invoices');
    await olive.goto(`/#/invoices/${invId}`);
    try {
      await olive.waitFor('document.querySelector("main input[name=dueDate]")?.value === "2026-12-31"', 'the new due date on the phone');
    } catch (e) {
      throw new Error(`${e.message}; device copy ${J(await olive.evaluate(`({ due: kelbe.store.get("invoices", ${J(invId)})?.dueDate, input: document.querySelector("main input[name=dueDate]")?.value, status: kelbe.sync.status() })`))}`);
    }
    const h = await row("SELECT updated_by FROM invoices WHERE tenant_id = $1 AND id = $2", [tg, invId]);
    if (h[0].updated_by !== 'system:qbo') throw new Error(J(h));
    return 'verified (401 unsigned, 200 signed), dirty_at set, due date 2026-12-31 on the phone, written by system:qbo';
  });

  await step('a conflicting edit shows on the conflicts screen and is resolved per field', async () => {
    const label = `Invoice ${(await row('SELECT data FROM invoices WHERE tenant_id = $1 AND id = $2', [tg, invId]))[0].data.number}`;
    mock.conflicts.push({ id: 'k1', kind: 'fields', collection: 'invoices', recordId: invId, label, status: 'open', createdAt: nowIso(),
      fields: [{ field: 'lines', label: 'Lines', base: '1 line, $212.80', fishtape: '2 lines, $319.20', quickbooks: '1 line, $224.00' }, { field: 'date', label: 'Date', base: '2026-10-20', fishtape: '2026-10-20', quickbooks: '2026-10-21' }] });
    setLink('invoices', invId, { state: 'conflict', conflictId: 'k1' });
    await go(own, '#/quickbooks');
    await own.waitFor('[...document.querySelectorAll("main .qbo-count")].some((a) => /Need a decision/.test(a.textContent))', 'the count link');
    await own.goto('/#/quickbooks/conflicts');
    await own.waitFor('document.querySelectorAll("main table tbody tr").length === 1', 'the conflict row');
    await own.evaluate('document.querySelector("main table tbody tr").click(); true');
    await own.waitFor('location.hash === "#/quickbooks/conflicts/k1" && !!document.querySelector("main .qbo-conflict-grid")', 'the conflict');
    const btnOff = () => own.evaluate('[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Use my choices").disabled');
    if (!(await btnOff())) throw new Error('"Use my choices" on before choosing');
    await own.evaluate('[...document.querySelectorAll("main input[name=c-lines]")][1].click(); [...document.querySelectorAll("main input[name=c-date]")][0].click(); true');
    if (await btnOff()) throw new Error('"Use my choices" still off');
    await own.shot('q10-conflict');
    await own.click('Use my choices', 'main');
    await own.waitFor('location.hash === "#/quickbooks/conflicts"', 'back on the list');
    const r = mock.resolved.at(-1);
    if (J(r) !== J({ id: 'k1', choice: 'fields', fields: { lines: 'quickbooks', date: 'fishtape' } })) throw new Error(J(r));
    await clearBadges(own);
    await synced(own);
    await go(own, `#/invoices/${invId}`);
    await own.waitFor('/In QuickBooks/.test(document.querySelector("main aside")?.innerText || "")', 'back in step');
    return `resolved ${J(r.fields)}`;
  });

  await step('"Why no tax?" on a no-tax invoice, for every company', async () => {
    const id = await own.evaluate(`(() => { const s = kelbe.store; const inv = s.add("invoices", { number: s.nextNumber("invoice"), clientId: s.list("clients")[0].id, status: "draft", issueDate: "2026-10-20", dueDate: "2026-11-03", lines: [{ description: "Band office lighting", qty: 1, unitCents: 80000, kind: "labour", labourHours: 0 }], taxProvince: "MB", taxTreatment: "pst-all", taxes: [{ id: "GST", label: "GST", pct: 5, applies: { material: true, labour: true, other: true } }, { id: "RST", label: "RST", pct: 7, applies: { material: true, labour: true, other: true } }], taxPct: 12, notes: "" }); return inv.id; })()`);
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

  await step('a settlement payment from QuickBooks shows read-only on the invoice', async () => {
    await asQbo((tx, p, who) => records.createRecord(tx, p, 'payments', { invoiceId: invId, amountCents: 1200, date: '2026-10-21', method: 'credit', source: 'quickbooks', reference: 'Credited or paid in QuickBooks' }, who));
    await synced(own);
    await own.goto(`/#/invoices/${invId}`);
    await own.waitFor('!!document.querySelector("main [data-settlement]")', 'the settlement row');
    const r = await own.evaluate('(() => { const el = document.querySelector("main [data-settlement]"); return { text: el.innerText, del: !!el.querySelector("button[title=\'Delete payment\']") }; })()');
    if (!/Credited or paid in QuickBooks/.test(r.text) || r.del) throw new Error(J(r));
    return 'labelled, no delete button';
  });

  await step('foreman on a phone: no QuickBooks anywhere, and 403 from the API', async () => {
    await superDb.query("INSERT INTO time_entries (tenant_id, id, data, created_by, updated_by) VALUES ($1, 'te-fred-1', $2, 'system:e2e', 'system:e2e')",
      [tg, { employeeId: 'emp-fred', jobId: null, clockIn: new Date(Date.now() - 5 * 3600e3).toISOString(), clockOut: new Date(Date.now() - 3600e3).toISOString(), breakMins: 0, note: '', approved: true }]).catch(() => {});
    setLink('timeEntries', 'te-fred-1', { state: 'synced' });
    const before = mock.calls.length;
    await signIn(fred, people.fred);
    if (await railHas(fred, 'quickbooks')) throw new Error('QuickBooks in the foreman rail');
    await fred.goto('/#/quickbooks');
    await fred.waitFor('/No access/.test(document.querySelector("main")?.innerText || "")', 'No access');
    await fred.goto('/#/time/week');
    await fred.waitFor('!!document.querySelector("main table, main .empty")', 'the timesheet');
    await sleep(800);
    if (await fred.evaluate('!!document.querySelector(".qbo-badge-host, .qbo-badge")')) throw new Error('a QuickBooks badge on the foreman screen');
    const fromApp = mock.calls.slice(before).filter((c) => c.role === 'foreman');
    if (fromApp.length) throw new Error(`the foreman app called ${J(fromApp)}`);
    const status = await fred.evaluate('fetch("/api/v1/qbo/status", { credentials: "include" }).then((r) => r.status)');
    if (status !== 403) throw new Error(`status answered ${status}`);
    await noSideScroll(fred, '#/time/week');
    await fred.shot('q12-foreman');
    return 'no rail button, No access, no badges, no QuickBooks calls from the app, 403 from /api/v1/qbo/status';
  });

  await step('phone layout: the QuickBooks screens fit 390 px', async () => {
    for (const h of ['#/quickbooks', '#/quickbooks/activity', '#/quickbooks/conflicts', '#/quickbooks/mappings', '#/quickbooks/lookup']) {
      await olive.goto(`/${h}`);
      await olive.waitFor('!!document.querySelector("main .qbo-nav")', h);
      await sleep(600);
      await noSideScroll(olive, h);
    }
    await olive.shot('q13-phone-mappings');
    return '5 screens, no sideways scroll';
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
  writeFileSync(join(SCRATCH, 'quickbooks-e2e-results.json'), J({ results, calls: mock.calls.slice(-80), console: pages.map((p) => ({ name: p.name, lines: p.consoleLines.slice(-60) })) }, null, 2));
  console.log('\n==== results ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.detail ? `\n      ${r.detail}` : ''}`);
  console.log(`browser console errors: ${all.length}`);
  for (const e of all.slice(0, 20)) console.log('   ', e.slice(0, 300));
  if (all.length) exitCode = 1;
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
