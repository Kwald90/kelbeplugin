// Period lock end to end (docs/releases/r1-get-paid.md 12.2, docs/office/period-lock.md): embedded
// Postgres 17 + the API in-process, driven the way the PWA drives it (sync push and pull, the closing
// routes), with the PWA's own lock rules (js/lib/closing.js isLocked) standing in for the disabled
// screens:
//   the owner sees the pre-close list and closes last month; the office's September invoice is locked
//   in the PWA, and a stale offline edit of it syncs, is rejected and is listed on Books; a credit note
//   dated today works; payroll for the month is exported with one unapproved entry (the server asks to
//   acknowledge it), the run locks only its entries and a foreman cannot edit them; an apprentice's
//   phone syncs a last-day-of-month entry two days late: accepted, posted on the first open day, in
//   Late hours; the unapproved entry is approved and goes in the next run with the late one; a
//   correction adds 1 h; a September draft invoice is re-dated and sent.
// API level: the Books screen needs modules/index.js to register it (the Lead's line), then a browser
// pass can be added the way purchasing.e2e.mjs drives Chrome.
//
//   cd server && npm install
//   node electrical-app/tests/e2e/period-lock.e2e.mjs [scratch dir]
// Not part of `node --test electrical-app/tests/*.test.mjs`.
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer as netServer } from 'node:net';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-pl-e2e-'));
mkdirSync(SCRATCH, { recursive: true });
const SERVER = join(WT, 'server');
const mod = (p) => import(pathToFileURL(join(SERVER, p)).href);
const lib = (p) => import(pathToFileURL(join(WT, 'electrical-app/js/lib', p)).href);
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
const { createRecords } = await mod('src/services/records.js');
const { createValidator } = await mod('src/schemas.js');
const { createTenantWithOwner } = await mod('src/services/tenants.js');
const { hashSecret } = await mod('src/auth/passwords.js');
const closingRoutes = (await mod('src/routes/v1/closing.js')).default;
const rulesRoutes = (await mod('src/routes/v1/rules.js')).default;
const { addDay, dayIn, endOfLastMonth, isLocked, locksFrom, isLateHours } = await lib('closing.js');

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pw = () => randomBytes(18).toString('base64url');
function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function step(name, fn) {
  try { await fn(); results.push({ name, ok: true }); log('PASS', name); } catch (e) { results.push({ name, ok: false, error: e.message }); log('FAIL', name, '\n  ', e.message); }
}

// ---------- Postgres and the API ----------
const pgPort = await freePort();
const superPw = pw();
const pgServer = new EmbeddedPostgres({ databaseDir: join(SCRATCH, `pg-${Date.now()}`, 'data'), port: pgPort, user: 'postgres', password: superPw, authMethod: 'scram-sha-256', persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
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
const config = readConfig({ APP_ENV: 'test', PUBLIC_ORIGIN: 'https://app.fishtape.test', SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), RATE_LIMIT: 'off', LOG_LEVEL: 'warn' });
const app = await buildApp({ config, db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
const records = createRecords({ validator: createValidator(), config, db });
if (!app.hasRoute({ method: 'GET', url: '/api/v1/closing' })) await app.register(closingRoutes, { db, records, config });
if (!app.hasRoute({ method: 'GET', url: '/api/v1/rules/effective' })) await app.register(rulesRoutes, { db, records, config });
await app.ready();

async function call({ method = 'GET', url, token, body }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method !== 'GET') headers['x-fishtape'] = '1';
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
async function login(email, password, tenantId, secret) {
  const r = await call({ method: 'POST', url: '/api/v1/auth/login', token: '', body: { email, password, mode: 'bearer', tenantId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.mfa === 'verify') {
    const v = await call({ method: 'POST', url: '/api/v1/auth/mfa/verify', token: r.body.token, body: { code: await generate({ secret }) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  return r.body.token;
}

// ---------- TG Electrical (Manitoba): owner, office, foreman, apprentice ----------
const ownerPw = pw();
const { tenant, userId: ownerId } = await createTenantWithOwner(db, { name: 'TG Electrical (e2e)', owner: { email: 'owner@tg-e2e.test', password: ownerPw, displayName: 'Travis' } });
const T = tenant.id;
let owner = await login('owner@tg-e2e.test', ownerPw, T);
const enrol = await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/enrol', token: owner });
await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/confirm', token: owner, body: { code: await generate({ secret: enrol.body.secret }) } });
void ownerId;
const tokens = {};
for (const [id, name, role] of [['emp-off', 'Dana Office', 'office'], ['emp-fore', 'Marcus Foreman', 'foreman'], ['emp-tom', 'Tom Apprentice', 'apprentice']]) {
  await call({ method: 'POST', url: '/api/v1/employees', token: owner, body: { id, name, role } });
  const email = `${role}@tg-e2e.test`;
  const p = pw();
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, await hashSecret(p)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [T, u.rows[0].id, role, id]);
  tokens[role] = await login(email, p, T);
}
const mut = (o) => ({ mid: `m-${randomBytes(6).toString('hex')}`, baseVersion: null, ...o });
const push = async (token, list) => (await call({ method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: list.map(mut) } })).body.results;
const get = async (coll, id, token = owner) => (await call({ url: `/api/v1/${coll}/${id}`, token })).body;

const ZONE = 'America/Winnipeg';
const today = dayIn(new Date().toISOString(), ZONE);
const THROUGH = endOfLastMonth(today);
const MONTH_START = `${THROUGH.slice(0, 8)}01`;
const at = (day, h) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
const work = (id, day, emp, o = {}) => ({ collection: 'timeEntries', id, op: 'upsert', data: { employeeId: emp, jobId: 'job-1', clockIn: at(day, 14), clockOut: at(day, 22), breakMins: 30, approved: true, ...o } });
const mbTax = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'GST', pct: 5 }, { id: 'RST', pct: 7 }] };

const setup = await push(owner, [
  { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'TG Electrical (e2e)', province: 'MB' } } },
  { collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1001', title: 'Clinic', status: 'in-progress' } },
  { collection: 'invoices', id: 'inv-sep', op: 'upsert', data: { number: 'INV-3001', status: 'sent', issueDate: addDay(THROUGH, -3), ...mbTax, lines: [{ kind: 'labour', qty: 10, unitCents: 9500 }] } },
  { collection: 'invoices', id: 'inv-sep-draft', op: 'upsert', data: { number: 'INV-3002', status: 'draft', issueDate: addDay(THROUGH, -2), ...mbTax, lines: [{ kind: 'labour', qty: 2, unitCents: 9500 }] } },
  work('te-1', MONTH_START, 'emp-fore'), work('te-2', addDay(MONTH_START, 1), 'emp-tom'),
  work('te-3', addDay(MONTH_START, 2), 'emp-tom', { approved: false }),
]);
assert.ok(setup.every((r) => r.status === 'ok'), JSON.stringify(setup));
log(`company set up; closing through ${THROUGH}`);

await step('the owner sees the pre-close list and closes the month', async () => {
  const pf = await call({ url: `/api/v1/closing/preflight?through=${THROUGH}`, token: owner });
  assert.equal(pf.status, 200);
  assert.equal(pf.body.counts.draftInvoices, 1, 'the draft invoice is listed');
  assert.equal(pf.body.counts.timeOpen, 1, 'the unapproved entry is listed');
  const refused = await call({ method: 'PUT', url: '/api/v1/closing/books', token: owner, body: { through: THROUGH } });
  assert.equal(refused.body.error.code, 'preflight_open');
  const ok = await call({ method: 'PUT', url: '/api/v1/closing/books', token: owner, body: { through: THROUGH, reason: 'Draft is being re-dated; Tom approves Monday' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const st = await call({ url: '/api/v1/closing', token: tokens.office });
  assert.equal(st.body.books.through, THROUGH);
});

await step('the office: a September invoice is locked in the PWA; a stale offline edit is rejected and listed on Books', async () => {
  const settings = await get('settings', 'settings', tokens.office);
  const locks = locksFrom(settings, []);
  const inv = await get('invoices', 'inv-sep', tokens.office);
  assert.equal(isLocked(locks, 'invoices', inv, { zone: ZONE }), true, 'disabled in the PWA');
  const r = await push(tokens.office, [{ collection: 'invoices', id: 'inv-sep', op: 'upsert', baseVersion: inv.version, data: { ...inv, lines: [{ kind: 'labour', qty: 12, unitCents: 9500 }] } }]);
  assert.equal(r[0].status, 'rejected');
  assert.equal(r[0].error.code, 'period_locked');
  const rej = await call({ url: '/api/v1/closing/rejections', token: tokens.office });
  assert.ok(rej.body.data.some((x) => x.recordId === 'inv-sep' && x.code === 'period_locked'));
});

await step('a credit note dated today works', async () => {
  const r = await push(tokens.office, [{ collection: 'invoices', id: 'cr-1', op: 'upsert', data: { number: 'CR-1001', kind: 'credit', status: 'sent', issueDate: today, creditsInvoiceId: 'inv-sep', creditReason: 'price', ...mbTax, lines: [{ kind: 'labour', qty: -2, unitCents: 9500 }] } }]);
  assert.equal(r[0].status, 'ok', JSON.stringify(r[0]));
});

let firstRun;
await step('payroll export with one unapproved entry asks to acknowledge; the run locks only its entries', async () => {
  const body = { id: 'run-sep', from: MONTH_START, to: THROUGH, format: 'generic', entryIds: ['te-1', 'te-2'], lockThrough: true };
  const ask = await call({ method: 'POST', url: '/api/v1/closing/payroll-runs', token: tokens.office, body });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'unexported_entries');
  assert.deepEqual(ask.body.error.details.entries.map((x) => x.entryId), ['te-3']);
  const ok = await call({ method: 'POST', url: '/api/v1/closing/payroll-runs', token: tokens.office, body: { ...body, leftOutAck: true } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  firstRun = ok.body.run;
  const locked = await call({ method: 'PATCH', url: '/api/v1/timeEntries/te-2', token: tokens.foreman, body: { breakMins: 0 } });
  assert.equal(locked.body.error.code, 'payroll_locked', 'a foreman cannot edit exported hours');
});

await step("an apprentice's phone syncs the month's last day late: accepted, posted on the first open day, in Late hours", async () => {
  const r = await push(tokens.apprentice, [work('te-late', THROUGH, 'emp-tom', { approved: false })]);
  assert.equal(r[0].status, 'ok', JSON.stringify(r[0]));
  const e = await get('timeEntries', 'te-late');
  assert.equal(e.postedOn, addDay(THROUGH, 1));
  assert.equal(e.late, true);
  const settings = await get('settings', 'settings');
  const locks = locksFrom(settings, [firstRun]);
  assert.equal(isLateHours(e, locks, { zone: ZONE }), true);
});

await step('the unapproved entry is approved (it was never locked) and goes in the next run with the late one; a correction adds 1 h', async () => {
  for (const id of ['te-3', 'te-late']) {
    const a = await call({ method: 'PATCH', url: `/api/v1/timeEntries/${id}`, token: tokens.foreman, body: { approved: true, approvedAt: new Date().toISOString(), approvedBy: 'emp-fore' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  const c = await push(tokens.office, [{ collection: 'timeEntries', id: 'corr-1', op: 'upsert', data: { kind: 'correction', correctsId: 'te-2', workDay: addDay(MONTH_START, 1), adjustMinutes: 60, employeeId: 'emp-tom', jobId: 'job-1', approved: true, note: 'Missed hour on the 2nd' } }]);
  assert.equal(c[0].status, 'ok', JSON.stringify(c[0]));
  const next = await call({ method: 'POST', url: '/api/v1/closing/payroll-runs', token: tokens.office, body: {
    id: 'run-oct-1', from: addDay(THROUGH, 1), to: addDay(THROUGH, 7), format: 'generic', entryIds: [], lateEntryIds: ['te-3', 'te-late', 'corr-1'], lockThrough: false,
  } });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal(next.body.run.totals.minutes, 450 + 450 + 60);
});

await step('a September draft invoice is re-dated and sent', async () => {
  const stuck = await call({ method: 'PATCH', url: '/api/v1/invoices/inv-sep-draft', token: tokens.office, body: { status: 'sent' } });
  assert.match(stuck.body.error.message, /Re-date this invoice to today/);
  const ok = await call({ method: 'PATCH', url: '/api/v1/invoices/inv-sep-draft', token: tokens.office, body: { status: 'sent', issueDate: today } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

await app.close();
await db.close();
await ownerClient.end();
await superDb.end();
await pgServer.stop();
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
