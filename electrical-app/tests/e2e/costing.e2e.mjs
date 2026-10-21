// Job costing end to end (docs/releases/r1-get-paid.md 12.2, docs/office/job-costing.md): embedded
// Postgres 17 + the API in-process, driven the way the PWA drives it (sync push, REST, the reports and
// receiving routes), with the PWA's own libraries for month-end and the count sheet:
//   a Manitoba job with burdened time (one Saturday of overtime), a raise in November that leaves
//   September's cost unchanged, a truck shared by two people, a wholesaler's bill for resale material
//   with RST charged (flagged, not cost), a receipt for own-use supplies, an open purchase order
//   (committed), a field receipt by the electrician without prices (received not billed), a return to
//   the van, and a fulfilled request covered by the bill (not counted twice): job profit and WIP match
//   the fixture; a bill above the PO price is flagged and acknowledged; the RST view lists the own-use
//   stock move and the supplier credit; the month-end export totals and journal; a count sheet posts
//   its adjustment.
// API level: the Job costing and Month-end screens need modules/index.js to register them (the Lead's
// lines), then a browser pass can be added the way purchasing.e2e.mjs drives Chrome.
//
//   cd server && npm install
//   node electrical-app/tests/e2e/costing.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-cost-e2e-'));
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
const reportRoutes = (await mod('src/routes/v1/reports.js')).default;
const receivingRoutes = (await mod('src/routes/v1/receiving.js')).default;
const { priceVariances } = await lib('costing.js');
const { cutoff, cutoffCsv } = await lib('month-end.js');
const { countSheet, countAdjustments } = await lib('stock-counts.js');

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
if (!app.hasRoute({ method: 'GET', url: '/api/v1/reports/wip' })) await app.register(reportRoutes, { db, records, config });
if (!app.hasRoute({ method: 'GET', url: '/api/v1/receiving' })) await app.register(receivingRoutes, { db, records, config });
await app.ready();

async function call({ method = 'GET', url, token, body }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method !== 'GET') headers['x-fishtape'] = '1';
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = res.body; }
  return { status: res.statusCode, body: json, raw: res.body };
}
async function login(email, password, tenantId) {
  const r = await call({ method: 'POST', url: '/api/v1/auth/login', token: '', body: { email, password, mode: 'bearer', tenantId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

// ---------- TG Electrical (Manitoba): owner, office, electrician, apprentice ----------
const ownerPw = pw();
const { tenant } = await createTenantWithOwner(db, { name: 'TG Electrical (costing e2e)', owner: { email: 'owner@tg-cost.test', password: ownerPw, displayName: 'Travis' } });
const T = tenant.id;
const owner = await login('owner@tg-cost.test', ownerPw, T);
const enrol = await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/enrol', token: owner });
await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/confirm', token: owner, body: { code: await generate({ secret: enrol.body.secret }) } });
const tokens = {};
const burden = { vacationPct: 4, holidayPct: 4 };
for (const [id, name, role, extra] of [
  ['emp-off', 'Dana Office', 'office', {}],
  ['emp-sam', 'Sam Sparks', 'electrician', { rateCents: 5000, rateHistory: [{ from: '2026-01-01', rateCents: 4000 }, { from: '2026-11-01', rateCents: 5000 }], burden }],
  ['emp-ana', 'Ana Apprentice', 'apprentice', { rateCents: 2500, burden }],
]) {
  const r = await call({ method: 'POST', url: '/api/v1/employees', token: owner, body: { id, name, role, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const email = `${role}@tg-cost.test`;
  const p = pw();
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, await hashSecret(p)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [T, u.rows[0].id, role, id]);
  tokens[role] = await login(email, p, T);
}
const mut = (o) => ({ mid: `m-${randomBytes(6).toString('hex')}`, baseVersion: null, ...o });
const push = async (token, list) => (await call({ method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: list.map(mut) } })).body.results;
const get = async (coll, id, token = owner) => (await call({ url: `/api/v1/${coll}/${id}`, token })).body;
const list = async (coll, token = owner) => (await call({ url: `/api/v1/${coll}?limit=500`, token })).body.data;
const at = (day, h) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
const work = (id, emp, day, inH, outH, o = {}) => ({ collection: 'timeEntries', id, op: 'upsert', data: { employeeId: emp, jobId: 'job-1', clockIn: at(day, inH), clockOut: at(day, outH), breakMins: 0, approved: true, ...o } });
const mbTax = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: [{ id: 'GST', label: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }, { id: 'RST', label: 'RST', pct: 7, applies: { material: true, labour: true, other: true } }] };

const setup = await push(owner, [
  { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'TG Electrical (costing e2e)', province: 'MB' }, labourRateCents: 9500, payroll: { otRule: 'MB' },
    costing: { annualHours: 2000, nonProductivePctDefault: 10, statutoryPctFallback: 10, priceVariancePct: 2 } } },
  { collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1001', title: 'Clinic fit-up', status: 'in-progress', contract: { valueCents: 500000 }, costing: { estCostOverrideCents: 300000 } } },
  { collection: 'jobs', id: 'job-w', op: 'upsert', data: { number: 'J-1002', title: 'Warranty callback', status: 'in-progress', kind: 'warranty', billable: false } },
  { collection: 'equipment', id: 'truck-1', op: 'upsert', data: { name: 'Truck 1', kind: 'truck', rateCents: 2000, rateUnit: 'hour', rateHistory: [{ from: '2026-01-01', rateCents: 2000, rateUnit: 'hour' }], active: true } },
  { collection: 'locations', id: 'van-1', op: 'upsert', data: { name: 'Van 1', kind: 'van' } },
  { collection: 'items', id: 'item-wire', op: 'upsert', data: { name: '14/2 wire', unit: 'm', costCents: 300, priceCents: 600, stock: { 'van-1': 42 } } },
  { collection: 'items', id: 'item-panel', op: 'upsert', data: { name: 'Panel', unit: 'ea', costCents: 10000, priceCents: 20000, stock: { 'van-1': 0 } } },
  { collection: 'vendors', id: 'v-whole', op: 'upsert', data: { name: 'Prairie Wholesale' } },
  { collection: 'vendors', id: 'v-store', op: 'upsert', data: { name: 'Hardware store' } },
  { collection: 'purchaseOrders', id: 'po-1', op: 'upsert', data: { number: 'PO-5001', vendorId: 'v-whole', jobId: 'job-1', status: 'sent', date: '2026-09-10', lines: [
    { itemId: 'item-wire', description: '14/2 wire', qty: 10, unit: 'm', unitCents: 1000 },
    { description: 'Boxes', qty: 20, unit: 'ea', unitCents: 500, quoteRef: 'Q-2291' },
  ] } },
  // Time: Tuesday with the truck shared (Sam 08-16, Ana 10-18), Saturday 10 h (2 h overtime), and a November day at the raise.
  work('te-1', 'emp-sam', '2026-09-15', 8, 16, { equipmentId: 'truck-1' }), work('te-2', 'emp-ana', '2026-09-15', 10, 18, { equipmentId: 'truck-1' }),
  work('te-3', 'emp-sam', '2026-09-19', 8, 18), work('te-4', 'emp-sam', '2026-11-03', 8, 16),
  // Bills: resale material with RST charged (and covering the crew's request), own-use supplies, and the boxes above the PO price.
  { collection: 'bills', id: 'b-1', op: 'upsert', data: { kind: 'bill', vendorId: 'v-whole', status: 'open', date: '2026-09-20', jobId: 'job-1', materialRequestIds: ['req-1'],
    lines: [{ description: 'EMT 3/4', costType: 'material', qty: 10, unitCents: 2000, amountCents: 20000 }], taxes: [{ id: 'GST', label: 'GST', cents: 1000 }, { id: 'RST', label: 'RST', cents: 1400 }], totalCents: 22400 } },
  { collection: 'bills', id: 'b-2', op: 'upsert', data: { kind: 'receipt', vendorId: 'v-store', status: 'paid', paidWith: 'card', date: '2026-09-21', lines: [{ description: 'Drill bits', costType: 'other', qty: 1, unitCents: 5000, amountCents: 5000, jobId: 'job-1' }],
    taxes: [{ id: 'GST', label: 'GST', cents: 250 }, { id: 'RST', label: 'RST', cents: 350 }], totalCents: 5600 } },
  { collection: 'bills', id: 'b-3', op: 'upsert', data: { kind: 'bill', vendorId: 'v-whole', status: 'open', date: '2026-09-22', purchaseOrderId: 'po-1', lines: [{ description: 'Boxes', costType: 'material', qty: 20, unitCents: 550, amountCents: 11000, jobId: 'job-1', poLine: { purchaseOrderId: 'po-1', index: 1 } }],
    taxes: [], totalCents: 11000 } },
  { collection: 'materialRequests', id: 'req-1', op: 'upsert', data: { jobId: 'job-1', description: 'EMT 3/4', qty: 10, unit: 'stick', status: 'fulfilled', fulfilledAt: '2026-09-20T18:00:00Z', costCents: 2000, employeeId: 'emp-sam' } },
  // Stock: 10 m used on the job, 2 m back to the van, a panel used on the warranty call (own use).
  { collection: 'stockMoves', id: 'mv-use', op: 'upsert', data: { itemId: 'item-wire', fromLocationId: 'van-1', toLocationId: null, qty: 10, jobId: 'job-1', date: '2026-09-16' } },
  { collection: 'stockMoves', id: 'mv-ret', op: 'upsert', data: { itemId: 'item-wire', fromLocationId: null, toLocationId: 'van-1', qty: 2, jobId: 'job-1', date: '2026-09-18' } },
  { collection: 'stockMoves', id: 'mv-war', op: 'upsert', data: { itemId: 'item-panel', fromLocationId: 'van-1', toLocationId: null, qty: 1, jobId: 'job-w', date: '2026-09-23', use: 'own-use', ownUseReason: 'warranty' } },
  { collection: 'invoices', id: 'inv-1', op: 'upsert', data: { number: 'INV-3001', jobId: 'job-1', status: 'sent', issueDate: '2026-09-25', ...mbTax, lines: [{ kind: 'other', description: 'Progress billing', qty: 1, unitCents: 200000 }] } },
]);
for (const r of setup) assert.equal(r.status, 'ok', JSON.stringify(r));

// The fixture, worked by hand (statutory 10% flat while CPP/EI are not loaded, vacation 4% + holiday 4%).
const perHour = (wage) => Math.round(wage * 1.08 * 1.1);
const LABOUR = 8 * perHour(4000) + 8 * perHour(2500) + 10 * perHour(4000) + Math.round(2 * 0.5 * 4000 * 1.1);
const TRUCK = 10 * 2000; // 08:00 to 18:00, two people, one truck
const BILLS = 20000 + 5000 + 350 + 11000; // resale RST recoverable; own-use RST is cost
const STOCK = 10 * 300 - 2 * 300; // stamped at the item cost; the return netted
const ACCRUED = 6 * 1000; // received in the field, not billed yet
const COST = LABOUR + TRUCK + BILLS + STOCK + ACCRUED;

await step('the electrician receives the wire in the field and never sees a price', async () => {
  const lines = await call({ url: '/api/v1/receiving?jobId=job-1', token: tokens.electrician });
  assert.equal(lines.status, 200, JSON.stringify(lines.body));
  assert.ok(!JSON.stringify(lines.body).includes('Cents'));
  const r = await call({ method: 'POST', url: '/api/v1/receiving/po-1', token: tokens.electrician, body: { lines: [{ index: 0, qty: 6 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes('Cents'));
  // Backdate the receipt into September (the field received it on the 24th).
  const move = await get('stockMoves', r.body.moveIds[0]);
  assert.equal(move.unitCostCents, 1000);
  await superDb.query("UPDATE stock_moves SET data = jsonb_set(data, '{date}', '\"2026-09-24\"') WHERE tenant_id = $1 AND id = $2", [T, move.id]);
  await superDb.query("UPDATE purchase_orders SET data = jsonb_set(data, '{lines,0,receivedAt}', '\"2026-09-24T15:00:00.000Z\"') WHERE tenant_id = $1 AND id = 'po-1'", [T]);
});

await step('job profit for September matches the fixture: burdened labour with overtime, the truck once, bills by tax use, returns netted, accrued', async () => {
  const r = await call({ url: '/api/v1/reports/job-profit?from=2026-09-01&to=2026-09-30&jobId=job-1', token: tokens.office });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const j = r.body.jobs[0];
  assert.equal(j.byType.labour, LABOUR, 'labour');
  assert.equal(j.otPremiumCents, Math.round(2 * 0.5 * 4000 * 1.1), 'overtime premium on the Saturday');
  assert.equal(j.truckCents, TRUCK, 'the truck once');
  assert.equal(j.accruedCents, ACCRUED);
  assert.equal(j.costCents, COST);
  assert.equal(j.revenueCents, 200000);
  assert.equal(j.grossProfitCents, 200000 - COST);
  assert.equal(j.committedCents, 4 * 1000, 'the wire still to come; the boxes are billed');
});

await step("a raise in November leaves September's cost unchanged", async () => {
  const nov = await call({ url: '/api/v1/reports/job-profit?from=2026-09-01&to=2026-11-30&jobId=job-1', token: tokens.office });
  assert.equal(nov.body.jobs[0].byType.labour, LABOUR + 8 * perHour(5000));
  const sep = await call({ url: '/api/v1/reports/job-profit?from=2026-09-01&to=2026-09-30&jobId=job-1', token: tokens.office });
  assert.equal(sep.body.jobs[0].byType.labour, LABOUR);
});

await step('WIP as of September 30: earned from cost over estimate, under billed', async () => {
  const r = await call({ url: '/api/v1/reports/wip?asOf=2026-09-30', token: tokens.office });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = r.body.rows.find((x) => x.jobId === 'job-1');
  const earned = Math.round(500000 * (COST / 300000));
  assert.equal(w.costToDateCents, COST);
  assert.equal(w.earnedCents, earned);
  assert.equal(w.underBilledCents, earned - 200000);
  assert.ok(!r.body.rows.some((x) => x.jobId === 'job-w'), 'warranty work is not WIP');
  assert.equal((await call({ url: '/api/v1/reports/wip', token: tokens.electrician })).status, 403, 'never to the crew');
});

await step('the bill above the PO price is flagged, then acknowledged', async () => {
  const bill = await get('bills', 'b-3');
  const v = priceVariances(bill, { purchaseOrders: await list('purchaseOrders'), items: await list('items'), tolerancePct: 2 });
  assert.deepEqual(v.map((x) => [x.refKind, x.quoteRef, x.overPct, x.overCents]), [['po', 'Q-2291', 10, 1000]]);
  const ack = await call({ method: 'PATCH', url: '/api/v1/bills/b-3', token: tokens.office, body: { varianceAck: { by: 'Dana Office', at: new Date().toISOString(), note: 'Copper surcharge, OK' } } });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal((await get('bills', 'b-3')).varianceAck.note, 'Copper surcharge, OK');
});

await step('the RST view lists the own-use stock move and the supplier credit', async () => {
  const r = await call({ url: '/api/v1/reports/rst?from=2026-09-01&to=2026-09-30', token: tokens.office });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.selfAssess.map((x) => [x.id, x.costCents, x.rstCents]), [['mv-war', 10000, 700]]);
  assert.deepEqual(r.body.resaleCredits.map((x) => [x.billId, x.rstCents]), [['b-1', 1400]]);
});

await step('the month-end export: totals and the named journal', async () => {
  const src = {};
  for (const c of ['jobs', 'estimates', 'invoices', 'payments', 'timeEntries', 'payrollRuns', 'stockMoves', 'materialRequests', 'bills', 'purchaseOrders', 'items', 'employees', 'equipment', 'equipmentUse', 'vendors', 'locations', 'fieldTickets']) src[c] = await list(c);
  const settings = await get('settings', 'settings');
  const c = cutoff({ ...src, settings, asOf: '2026-09-30', dayOf: (iso) => String(iso).slice(0, 10) });
  const earned = Math.round(500000 * (COST / 300000));
  assert.equal(c.accruedRevenue.wipUnderBilledCents, earned - 200000);
  assert.equal(c.accruedCost.receivedNotBilledCents, ACCRUED);
  assert.equal(c.accruedPayroll.wagesCents, 18 * 4000 + 8 * 2500, 'no payroll run yet: all September hours');
  assert.equal(c.rstSelfAssessCents, 700);
  const j = (memo) => c.journal.filter((x) => x.memo.startsWith(memo)).map((x) => x.account);
  assert.deepEqual(j('Under-billed'), ['Costs and estimated earnings in excess of billings', 'Contract revenue']);
  assert.deepEqual(j('Material received'), ['Job cost', 'Accrued liabilities']);
  assert.deepEqual(j('Self-assessed RST'), ['Expense or job cost', 'RST payable']);
  assert.equal(c.journal.reduce((s, x) => s + x.debitCents - x.creditCents, 0), 0, 'the journal balances');
  assert.match(cutoffCsv(c), /Journal \(suggested; reverse on the 1st\)/);
});

await step('a count sheet posts its adjustment against what was there when counted', async () => {
  const items = await list('items');
  const sheet = countSheet({ items, locationId: 'van-1', date: '2026-10-20' });
  const wire = sheet.lines.find((l) => l.itemId === 'item-wire');
  assert.equal(wire.expectedQty, 42);
  wire.countedQty = 40;
  const count = { ...sheet, id: 'count-1', status: 'counted', countedAt: new Date().toISOString(), countedBy: 'Sam Sparks' };
  const adj = countAdjustments(count, { items, stockMoves: await list('stockMoves') });
  assert.deepEqual(adj.map((a) => [a.itemId, a.diff]), [['item-wire', -2]]);
  // The phone syncs the counted sheet; the office posts it (modules/inventory.js postCount: the move, the stock, the count).
  const r = await push(tokens.office, [
    { collection: 'stockCounts', id: 'count-1', op: 'upsert', data: count },
    { collection: 'stockMoves', id: 'adj-1', op: 'upsert', data: adj[0].move },
  ]);
  for (const x of r) assert.equal(x.status, 'ok', JSON.stringify(x));
  const stock = await call({ method: 'PATCH', url: '/api/v1/items/item-wire', token: tokens.office, body: { stock: { 'van-1': 40 } } });
  assert.equal(stock.status, 200, JSON.stringify(stock.body));
  const posted = await call({ method: 'PATCH', url: '/api/v1/stockCounts/count-1', token: tokens.office, body: { status: 'posted', postedAt: new Date().toISOString(), postedBy: 'Dana Office', moveIds: ['adj-1'] } });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const move = await get('stockMoves', 'adj-1');
  assert.deepEqual([move.use, move.countId, move.fromLocationId, move.qty], ['adjust', 'count-1', 'van-1', 2]);
  assert.ok(move.postedOn, 'the server posts it');
  assert.equal((await get('stockCounts', 'count-1')).status, 'posted');
});

await app.close();
await db.close();
await ownerClient.end();
await superDb.end();
await pgServer.stop();
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
