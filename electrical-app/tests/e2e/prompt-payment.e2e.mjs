// Prompt payment end to end (docs/releases/r1-get-paid.md 7.2, 7.5, 10.1, 12.2): embedded Postgres 17 + the API
// in-process and the daily receivables job run on chosen days (the worker runs it at 07:00 in the company zone):
//   a prime contract signed 2025-05-01 with a proper invoice delivered: the day-15 and day-29 alarms, once each;
//   a subcontract invoice gets none until the office records the day the GC was paid, then gc7; a contract signed
//   2025-03-01 gets none; a company override of pp.MB.paymentDays to status verify stops the day-28 alarm.
// The rules are the 0160 seed rows (platform) with the company's own rows (Books → Rules, the `rules` collection).
//
//   cd server && npm install
//   node electrical-app/tests/e2e/prompt-payment.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-pp-e2e-'));
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
const { runReceivablesDaily, loadRules } = await mod('src/services/receivables.js');
const { promptPaymentAlarms, promptPaymentDates } = await lib('prompt-payment.js');
const { taxComponents } = await lib('tax.js');
const { addDay } = await lib('closing.js');

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
await app.ready();

async function call({ method = 'GET', url, token, body }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method !== 'GET') headers['x-fishtape'] = '1';
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.statusCode, body: json };
}

// ---------- TG Electrical (Manitoba) ----------
const ownerPw = pw();
const { tenant } = await createTenantWithOwner(db, { name: 'TG Electrical (prompt payment)', owner: { email: 'owner@tg-pp.test', password: ownerPw, displayName: 'Travis' } });
const T = tenant.id;
const login = await call({ method: 'POST', url: '/api/v1/auth/login', body: { email: 'owner@tg-pp.test', password: ownerPw, mode: 'bearer', tenantId: T } });
const owner = login.body.token;
const enrol = await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/enrol', token: owner });
await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/confirm', token: owner, body: { code: await generate({ secret: enrol.body.secret }) } });
const mut = (o) => ({ mid: `m-${randomBytes(6).toString('hex')}`, baseVersion: null, ...o });
const pushOk = async (list) => {
  const r = (await call({ method: 'POST', url: '/api/v1/sync/push', token: owner, body: { mutations: list.map(mut) } })).body.results;
  r.forEach((x) => assert.equal(x.status, 'ok', JSON.stringify(x)));
};
const upsert = (collection, id, data) => ({ collection, id, op: 'upsert', data });
const get = async (coll, id) => (await call({ url: `/api/v1/${coll}/${id}`, token: owner })).body;

const D = '2026-08-03'; // the proper invoices are delivered on this day
const mb = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: taxComponents({ province: 'MB', treatment: 'pst-all', date: D }), taxPct: 12 };
const job = (id, contract) => upsert('jobs', id, { number: id.toUpperCase(), title: `Job ${id}`, clientId: 'gc', status: 'in-progress', changeOrders: [], contract: { properInvoiceRequired: true, ...contract } });
const invoice = (id, jobId, delivered) => upsert('invoices', id, { number: `INV-${id}`, clientId: 'gc', jobId, status: 'sent', issueDate: delivered, dueDate: addDay(delivered, 60), ...mb, properInvoice: true,
  promptPayment: { deliveredOn: delivered, deliveredVia: 'gc-portal' }, lines: [{ kind: 'labour', description: 'Progress', qty: 1, unitCents: 1000000 }] });
await pushOk([
  upsert('settings', 'settings', { company: { name: 'TG Electrical (prompt payment)', province: 'MB' }, collections: { reminders: [], holdAfterDays: 365 } }),
  upsert('clients', 'gc', { name: 'Prairie Builders', email: 'ap@prairie.test' }),
  job('ja', { role: 'prime', signedOn: '2025-05-01' }), invoice('a', 'ja', D),
  job('js', { role: 'sub', signedOn: '2025-06-15', primeSignedOn: '2025-06-01' }), invoice('s', 'js', D),
  job('jo', { role: 'prime', signedOn: '2025-03-01' }), invoice('o', 'jo', D),
]);
const runOn = (day) => runReceivablesDaily(db, T, { records, now: new Date(`${day}T15:00:00Z`) });
const alarms = async () => (await superDb.query("SELECT ref, count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND kind = 'prompt_payment' GROUP BY ref ORDER BY ref", [T])).rows;
const people = (await superDb.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND status = 'active' AND role IN ('owner', 'admin', 'office')", [T])).rows[0].n;
log(`invoices delivered ${D}`);

await step('prime contract signed 2025-05-01: nothing on day 14, the day-15 alarm once, the day-29 alarm once', async () => {
  await runOn(addDay(D, 14));
  assert.deepEqual(await alarms(), [], 'on the day itself: nothing yet');
  await runOn(addDay(D, 15));
  await runOn(addDay(D, 15));
  assert.deepEqual(await alarms(), [{ ref: 'pp:a:day14', n: people }], 'day 15: once per person, even when the job runs twice');
  const t = (await superDb.query("SELECT title FROM notifications WHERE tenant_id = $1 AND ref = 'pp:a:day14' LIMIT 1", [T])).rows[0].title;
  assert.equal(t, `No notice of non-payment on INV-a by day 14: the full amount is due by ${addDay(D, 28)}.`);
  await runOn(addDay(D, 29));
  await runOn(addDay(D, 30));
  assert.deepEqual(await alarms(), [{ ref: 'pp:a:day14', n: people }, { ref: 'pp:a:day28', n: people }]);
});

await step('subcontract: no day 14 or 28; gc7 only once the GC\'s payment is recorded', async () => {
  assert.equal((await alarms()).some((r) => r.ref.startsWith('pp:s:')), false);
  const s = await get('invoices', 's');
  await pushOk([{ collection: 'invoices', id: 's', op: 'upsert', baseVersion: s.version, data: { ...s, id: undefined, version: undefined, promptPayment: { ...s.promptPayment, gcPaidOn: addDay(D, 30) } } }]);
  await runOn(addDay(D, 37));
  assert.equal((await alarms()).some((r) => r.ref === 'pp:s:gc7'), false, 'the GC has 7 days');
  await runOn(addDay(D, 38));
  assert.deepEqual((await alarms()).filter((r) => r.ref.startsWith('pp:s:')), [{ ref: 'pp:s:gc7', n: people }]);
});

await step('a contract signed 2025-03-01 gets no dates and no alarms', async () => {
  assert.equal((await alarms()).some((r) => r.ref.startsWith('pp:o:')), false);
  const o = await get('invoices', 'o');
  const jo = await get('jobs', 'jo');
  const rules = await db.withTenant({ tenantId: T }, (tx) => loadRules(tx, { province: 'MB', on: addDay(D, 40) }));
  const d = promptPaymentDates(o, jo, rules, { companyProvince: 'MB' });
  assert.equal(d.applies, false);
  assert.match(d.why, /before 2025-04-01/);
});

await step('a company override of pp.MB.paymentDays to status verify stops the day-28 alarm', async () => {
  const D2 = addDay(D, 20);
  await pushOk([job('jb', { role: 'prime', signedOn: '2025-05-01' }), invoice('b', 'jb', D2)]);
  const b = await get('invoices', 'b');
  const jb = await get('jobs', 'jb');
  const seed = await db.withTenant({ tenantId: T }, (tx) => loadRules(tx, { province: 'MB', on: addDay(D2, 29) }));
  assert.deepEqual(promptPaymentAlarms([b], [jb], [], seed, addDay(D2, 29)).map((x) => x.step), ['day14', 'day28'], 'with the seed rows it would alarm');
  const r = await call({ method: 'POST', url: '/api/v1/rules', token: owner, body: { key: 'pp.MB.paymentDays', province: 'MB', value: 28, effectiveFrom: '2025-04-01', status: 'verify', source: 'Our lawyer is checking the 28 days for our contracts' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await runOn(addDay(D2, 29));
  assert.equal((await alarms()).some((x) => x.ref.startsWith('pp:b:')), false, 'a deadline never runs on verify');
});

await app.close();
await db.close();
await ownerClient.end();
await superDb.end();
await pgServer.stop();
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
