// Collections end to end (docs/releases/r1-get-paid.md 4.4, 4.5, 4.7, 7.3, 12.2): embedded Postgres 17 + the API
// in-process, driven the way the PWA drives it (sync push, the R1-D routes and worker jobs), with the PWA's own
// libraries (lib/receivables.js, lib/money.js) doing what the screens do:
//   one cheque pays three invoices less a $1,200 dispute and a $350 back-charge; the undisputed balance is
//   reminded; the dispute is conceded into a credit note. A GC keeps 10% holdback on its own: recorded, out of
//   ageing. An overdue invoice: the daily job queues reminder 1 once; the client goes on hold; scheduling that
//   client's job needs "Dispatch anyway" (recorded on the schedule entry); a payment clears the hold on the
//   recheck. The statement prints and emails. Ready to bill lists the oldest item first.
// API level (the screens are covered by the module code).
//
//   cd server && npm install
//   node electrical-app/tests/e2e/collections.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-collections-e2e-'));
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
const { runReceivablesDaily, createReceivablesHandlers } = await mod('src/services/receivables.js');
const receivablesRoutes = (await mod('src/routes/v1/receivables.js')).default;
const R = await lib('receivables.js');
const { docTotals, creditNoteFrom } = await lib('money.js');
const { taxComponents } = await lib('tax.js');
const { dayIn, addDay } = await lib('closing.js');

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
// The Lead registers these in app.js; until then the scenario registers them itself.
if (!app.hasRoute({ method: 'GET', url: '/api/v1/statements/:clientId' })) await app.register(receivablesRoutes, { db, records, config });
await app.ready();

async function call({ method = 'GET', url, token, body }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method !== 'GET') headers['x-fishtape'] = '1';
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.statusCode, body: json, text: res.body };
}
async function login(email, password, tenantId) {
  const r = await call({ method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer', tenantId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

// ---------- TG Electrical (Manitoba): owner, office, foreman ----------
const ownerPw = pw();
const { tenant } = await createTenantWithOwner(db, { name: 'TG Electrical (collections)', owner: { email: 'owner@tg-col.test', password: ownerPw, displayName: 'Travis' } });
const T = tenant.id;
const owner = await login('owner@tg-col.test', ownerPw, T);
const enrol = await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/enrol', token: owner });
await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/confirm', token: owner, body: { code: await generate({ secret: enrol.body.secret }) } });
const tokens = {};
for (const [id, name, role] of [['emp-off', 'Dana Office', 'office'], ['emp-fore', 'Marcus Foreman', 'foreman']]) {
  await call({ method: 'POST', url: '/api/v1/employees', token: owner, body: { id, name, role } });
  const email = `${role}@tg-col.test`;
  const p = pw();
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, await hashSecret(p)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [T, u.rows[0].id, role, id]);
  tokens[role] = await login(email, p, T);
}
const mut = (o) => ({ mid: `m-${randomBytes(6).toString('hex')}`, baseVersion: null, ...o });
const push = async (token, list) => (await call({ method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: list.map(mut) } })).body.results;
const get = async (coll, id, token = owner) => (await call({ url: `/api/v1/${coll}/${id}`, token })).body;
const all = async (coll, token = tokens.office) => (await call({ url: `/api/v1/${coll}?limit=500`, token })).body.data;
const pushOk = async (token, list) => { const r = await push(token, list); r.forEach((x) => assert.equal(x.status, 'ok', JSON.stringify(x))); return r; };
const upsert = (collection, id, data) => ({ collection, id, op: 'upsert', data });
const strip = ({ id, version, ...d }) => { void id; void version; return d; };
const upd = (collection, rec, patch) => ({ collection, id: rec.id, op: 'upsert', baseVersion: rec.version, data: { ...strip(rec), ...patch } });

const ZONE = 'America/Winnipeg';
const today = dayIn(new Date().toISOString(), ZONE);
const mb = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: taxComponents({ province: 'MB', treatment: 'pst-all', date: today }), taxPct: 12 };
const inv = (id, number, cents, due) => upsert('invoices', id, { number, clientId: 'gc', jobId: 'job-1', status: 'sent', issueDate: addDay(due, -30), dueDate: due, ...mb, lines: [{ kind: 'labour', description: 'Work', qty: 1, unitCents: cents }] });
const conn = await call({ method: 'PUT', url: '/api/v1/integrations/resend', token: owner, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'TG Electrical <office@tg-col.test>' } } });
assert.equal(conn.status, 200, JSON.stringify(conn.body));
const reminder1 = { key: 'r1', dayOffset: 1, channel: 'email', subject: 'Invoice {number} is now due', body: 'Hi {client},\n\n{balance} is open on invoice {number}, due {dueDate}.\n\n{company}', active: true };
await pushOk(owner, [
  upsert('settings', 'settings', { company: { name: 'TG Electrical (collections)', province: 'MB', phone: '204-555-0100' }, collections: { reminders: [reminder1], holdAfterDays: 60, holdOverLimit: true } }),
  upsert('clients', 'gc', { name: 'Prairie Builders', email: 'ap@prairie.test', credit: { statementEmail: 'statements@prairie.test', limitCents: 50000000 } }),
  upsert('jobs', 'job-1', { number: 'J-1042', title: 'Clinic fit-up', clientId: 'gc', status: 'in-progress', billingMode: 'fixed', changeOrders: [] }),
  inv('i1', 'INV-3001', 1000000, addDay(today, -40)),
  inv('i2', 'INV-3002', 500000, addDay(today, -20)),
  inv('i3', 'INV-3003', 300000, addDay(today, -30)),
]);
log(`company set up for ${today}`);
const total = (cents) => Math.round(cents * 1.12);
let noteId;

await step('one cheque pays three invoices less a $1,200 dispute and a $350 back-charge', async () => {
  const i2 = await get('invoices', 'i2', tokens.office);
  const d = await call({ method: 'PATCH', url: '/api/v1/invoices/i2', token: tokens.office, body: { disputes: [{ id: 'd1', cents: 120000, reason: 'Pot lights not installed', status: 'open', openedAt: new Date().toISOString(), openedBy: 'Dana Office' }] } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  void i2;
  // The back-charge: a credit note for $350 tax included, applied to INV-3003 (the screen's creditNoteForAmount).
  const i3 = await get('invoices', 'i3', tokens.office);
  const note = { ...creditNoteFrom(i3, { lines: [{ kind: 'other', description: 'Cleanup back-charge', qty: 1, unitCents: R.baseForAmount(i3, 35000) }], reason: 'backcharge', today, settings: { nextNumbers: { credit: 1001 } } }), status: 'sent' };
  const back = -docTotals(note).totalCents;
  assert.ok(Math.abs(back - 35000) <= 1, `$350 tax included, within the cent each tax rounds (${back})`);
  await pushOk(tokens.office, [upsert('invoices', 'cr-1', note), upsert('payments', 'cr-1-app', { invoiceId: 'i3', creditNoteId: 'cr-1', method: 'credit-note', amountCents: back, date: today, reference: note.number })]);
  const invoices = await all('invoices'), payments = await all('payments');
  const expected = R.collectibleCents(invoices.find((x) => x.id === 'i1'), payments) + R.collectibleCents(invoices.find((x) => x.id === 'i2'), payments) + R.collectibleCents(invoices.find((x) => x.id === 'i3'), payments);
  assert.equal(expected, total(1000000) + (total(500000) - 120000) + (total(300000) - back));
  const cheque = expected - 50000; // short by $500 on the undisputed part of INV-3002
  const a = R.allocateReceipt(cheque, invoices, payments, { clientId: 'gc' });
  assert.deepEqual(a.allocations.map((x) => x.invoiceId), ['i1', 'i3', 'i2'], 'oldest due first');
  assert.equal(a.onAccountCents, 0);
  await pushOk(tokens.office, a.allocations.filter((x) => x.amountCents > 0).map((x, k) => upsert('payments', `chq-${k}`, { invoiceId: x.invoiceId, clientId: 'gc', amountCents: x.amountCents, date: today, method: 'cheque', reference: 'Chq 5521', receiptId: 'rc-5521' })));
  const p2 = await all('payments');
  const i = await all('invoices');
  const bal = (id) => R.balanceCents(i.find((x) => x.id === id), p2);
  assert.deepEqual([bal('i1'), bal('i3'), bal('i2')], [0, 0, 170000]);
  assert.equal(R.undisputedBalance(i.find((x) => x.id === 'i2'), p2), 50000);
});

await step('the undisputed balance is reminded (once); the dispute is conceded into a credit note', async () => {
  const a = await runReceivablesDaily(db, T, { records });
  const b = await runReceivablesDaily(db, T, { records });
  assert.equal(b.reminders, 0, 'a second run never doubles');
  const ob = (await superDb.query("SELECT id, data FROM outbox WHERE tenant_id = $1 AND data->>'kind' = 'invoice_reminder'", [T])).rows;
  assert.ok(a.reminders >= 1);
  const r2 = ob.find((r) => r.id === 'rem-i2-r1');
  assert.ok(r2, JSON.stringify(ob.map((r) => r.id)));
  assert.match(r2.data.body, /\$500\.00/, 'the undisputed balance, not the disputed part');
  assert.equal(r2.data.to, 'statements@prairie.test');
  const i2 = await get('invoices', 'i2', tokens.office);
  const note = { ...creditNoteFrom(i2, { lines: [{ kind: 'other', description: 'Dispute conceded: pot lights', qty: 1, unitCents: R.baseForAmount(i2, 120000) }], reason: 'dispute', today, settings: { nextNumbers: { credit: 1002 } } }), status: 'sent' };
  assert.equal(docTotals(note).totalCents, -120000);
  noteId = 'cr-2';
  await pushOk(tokens.office, [upsert('invoices', 'cr-2', note), upsert('payments', 'cr-2-app', { invoiceId: 'i2', creditNoteId: 'cr-2', method: 'credit-note', amountCents: -docTotals(note).totalCents, date: today })]);
  const r = await call({ method: 'PATCH', url: '/api/v1/invoices/i2', token: tokens.office, body: { disputes: i2.disputes.map((x) => ({ ...x, status: 'conceded', resolvedAt: new Date().toISOString(), resolvedBy: 'Dana Office', creditNoteId: 'cr-2' })) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await get('invoices', 'i2', tokens.office);
  assert.equal(R.balanceCents(after, await all('payments')), 50000);
  assert.equal(R.balanceCents(await get('invoices', 'cr-2', tokens.office), await all('payments')), 0, 'the credit note is fully applied');
});

await step('a GC keeps 10% holdback on its own: recorded on the invoice, out of ageing, on the statement', async () => {
  await pushOk(tokens.office, [inv('i4', 'INV-3004', 400000, addDay(today, 10))]);
  const i4 = await get('invoices', 'i4', tokens.office);
  const kept = Math.round(docTotals(i4).totalCents / 10);
  const r = await call({ method: 'PATCH', url: '/api/v1/invoices/i4', token: tokens.office, body: { holdback: { retainedByCustomerCents: kept, retainedRecordedAt: new Date().toISOString(), retainedRecordedBy: 'Dana Office' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(docTotals(await get('invoices', 'i4')).totalCents, total(400000), 'the invoice total and tax do not change');
  const st = await call({ url: `/api/v1/statements/gc?from=${addDay(today, -90)}&to=${today}`, token: tokens.office });
  assert.equal(st.status, 200);
  assert.equal(st.body.holdbackRetainedCents, kept);
  assert.equal(st.body.aging.current, total(400000) - kept, 'held back amount out of ageing');
  const led = R.holdbackLedger(await all('invoices'), { jobId: 'job-1' });
  assert.equal(led.retainedByCustomerCents, kept);
});

await step('an overdue invoice: reminder 1 once; the client goes on hold; dispatch needs "Dispatch anyway"; a payment clears it on the recheck', async () => {
  await pushOk(tokens.office, [inv('i5', 'INV-3005', 200000, addDay(today, -70))]);
  await runReceivablesDaily(db, T, { records });
  await runReceivablesDaily(db, T, { records });
  const n = (await superDb.query("SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND id = 'rem-i5-r1'", [T])).rows[0].n;
  assert.equal(n, 1, 'reminder 1 queued once');
  const seen = await get('clients', 'gc', tokens.foreman);
  assert.equal(seen.credit.hold.on, true, 'the foreman sees the hold');
  assert.equal(seen.credit.hold.reason, 'past_due');
  assert.equal(seen.credit.limitCents, undefined, 'never the limit');
  // The schedule screen asks "Dispatch anyway" and records who said so.
  await pushOk(tokens.foreman, [upsert('schedule', 'sch-1', { jobId: 'job-1', employeeId: 'emp-fore', date: today, hours: 8, holdAck: { by: 'Marcus Foreman', at: new Date().toISOString() } })]);
  assert.equal((await get('schedule', 'sch-1')).holdAck.by, 'Marcus Foreman');
  await pushOk(tokens.office, [upsert('payments', 'pay-i5', { invoiceId: 'i5', clientId: 'gc', amountCents: total(200000), date: today, method: 'e-transfer' })]);
  const rc = await call({ method: 'POST', url: '/api/v1/receivables/recheck/gc', token: tokens.office });
  assert.equal(rc.status, 202);
  const job = (await superDb.query("SELECT * FROM jobs_queue WHERE kind = 'receivables_client' AND tenant_id = $1 AND status = 'queued'", [T])).rows[0];
  await createReceivablesHandlers({ records }).receivables_client({ db, job });
  assert.equal((await get('clients', 'gc', tokens.foreman)).credit.hold.on, false, 'the hold is lifted');
});

await step('the statement prints and emails', async () => {
  const html = await call({ url: `/api/v1/statements/gc?from=${addDay(today, -90)}&to=${today}&format=html`, token: tokens.office });
  assert.equal(html.status, 200);
  assert.match(html.text, /Statement for Prairie Builders/);
  const sent = await call({ method: 'POST', url: '/api/v1/statements/gc/send', token: tokens.office, body: { from: addDay(today, -90), to: today } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const ob = (await superDb.query('SELECT data FROM outbox WHERE tenant_id = $1 AND id = $2', [T, sent.body.outboxId])).rows[0].data;
  assert.equal(ob.kind, 'statement');
  assert.equal(ob.to, 'statements@prairie.test');
  void noteId;
});

await step('ready to bill lists the oldest item first', async () => {
  const job = await get('jobs', 'job-1', tokens.office);
  await pushOk(tokens.office, [upd('jobs', job, { status: 'complete', contract: { completedOn: addDay(today, -25) }, changeOrders: [{ id: 'co-1', title: 'Extra circuit', status: 'approved', approvedOn: addDay(today, -10), amountCents: 80000 }],
    closeout: { checkedAt: new Date().toISOString(), checkedBy: 'Dana Office', open: ['co_unbilled'] } })]);
  const rows = R.readyToBill({ jobs: await all('jobs'), invoices: await all('invoices'), fieldTickets: [], settings: {} }, { asOf: today });
  assert.deepEqual(rows.map((r) => r.kind).slice(0, 2), ['complete', 'change-order']);
  assert.equal(rows[0].ageDays, 25);
});

await app.close();
await db.close();
await ownerClient.end();
await superDb.end();
await pgServer.stop();
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
