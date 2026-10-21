// Getting paid end to end (docs/releases/r1-get-paid.md 4.1 to 4.4, 4.8, 7.3, 12.2): embedded Postgres 17 + the
// API in-process, driven the way the PWA drives it (sync push and pull, the R1-D routes and worker jobs), with
// the PWA's own libraries (lib/tickets.js, lib/esign.js, lib/money.js, lib/receivables.js, lib/closeout.js,
// lib/tm.js) doing what the screens do:
//   an electrician, offline, writes an extra-work ticket with photos on a fixed-price job; the super signs; the
//   phone syncs and gets a T-number; the electrician never sees a price. The office prices it into a change order,
//   signs the change order on the iPad and bills it; the ticket shows billed. On a T&M job a signed ticket of 6.5 h
//   against 8 h of time: the builder flags the day and the invoice is saved with the reason. A refused ticket
//   queues a written notice. A signed service ticket becomes a draft invoice. An estimate signed on the device is
//   accepted and its revision supersedes it. A prepayment deposit is paid and applied on the final invoice with
//   the right totals. A progress invoice holds back 10% and a release invoice bills it. Setting the job complete
//   shows the open items as warnings; setting it invoiced is refused until they are cleared.
// API level (the screens are covered by the module code; modules/index.js registers tickets: the Lead's line).
//
//   cd server && npm install
//   node electrical-app/tests/e2e/get-paid.e2e.mjs [scratch dir]
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
const SCRATCH = process.argv[2] || mkdtempSync(join(tmpdir(), 'fishtape-getpaid-e2e-'));
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
const { runTicketsSweep } = await mod('src/services/tickets.js');
const ticketRoutes = (await mod('src/routes/v1/tickets.js')).default;
const receivablesRoutes = (await mod('src/routes/v1/receivables.js')).default;
const { newTicket, ticketToChangeOrder, ticketReconciliation, billableTickets } = await lib('tickets.js');
const { buildSignature } = await lib('esign.js');
const { docTotals, depositInvoiceFields, depositInvoiceLine, depositApplicationLine, holdbackSnapshot, holdbackReleaseLine, sameTaxSet } = await lib('money.js');
const { depositsAvailable, holdbackLedger } = await lib('receivables.js');
const { closeoutChecklist, closeoutRecord } = await lib('closeout.js');
const { buildTmInvoice } = await lib('tm.js');
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
if (!app.hasRoute({ method: 'POST', url: '/api/v1/tickets/:id/send' })) await app.register(ticketRoutes, { db, records, config });
if (!app.hasRoute({ method: 'GET', url: '/api/v1/statements/:clientId' })) await app.register(receivablesRoutes, { db, records, config });
await app.ready();

async function call({ method = 'GET', url, token, body }) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method !== 'GET') headers['x-fishtape'] = '1';
  const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.statusCode, body: json };
}
async function login(email, password, tenantId) {
  const r = await call({ method: 'POST', url: '/api/v1/auth/login', body: { email, password, mode: 'bearer', tenantId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

// ---------- TG Electrical (Manitoba): owner, office, electrician ----------
const ownerPw = pw();
const { tenant } = await createTenantWithOwner(db, { name: 'TG Electrical (get paid)', owner: { email: 'owner@tg-gp.test', password: ownerPw, displayName: 'Travis' } });
const T = tenant.id;
const owner = await login('owner@tg-gp.test', ownerPw, T);
const enrol = await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/enrol', token: owner });
await call({ method: 'POST', url: '/api/v1/auth/mfa/totp/confirm', token: owner, body: { code: await generate({ secret: enrol.body.secret }) } });
const tokens = {};
for (const [id, name, role] of [['emp-off', 'Dana Office', 'office'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
  await call({ method: 'POST', url: '/api/v1/employees', token: owner, body: { id, name, role, billRateCents: null } });
  const email = `${role}@tg-gp.test`;
  const p = pw();
  const u = await superDb.query('INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, await hashSecret(p)]);
  await superDb.query('INSERT INTO memberships (tenant_id, user_id, role, employee_id) VALUES ($1, $2, $3, $4)', [T, u.rows[0].id, role, id]);
  tokens[role] = await login(email, p, T);
}
const mut = (o) => ({ mid: `m-${randomBytes(6).toString('hex')}`, baseVersion: null, ...o });
const push = async (token, list) => (await call({ method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: list.map(mut) } })).body.results;
const get = async (coll, id, token = owner) => (await call({ url: `/api/v1/${coll}/${id}`, token })).body;
const pushOk = async (token, list) => { const r = await push(token, list); r.forEach((x) => assert.equal(x.status, 'ok', JSON.stringify(x))); return r; };
const upsert = (collection, id, data) => ({ collection, id, op: 'upsert', data });
const strip = ({ id, version, ...d }) => { void id; void version; return d; };
/** An update of a record this device read: its version is the base (a fresh write, not a stale one). */
const upd = (collection, rec, patch) => ({ collection, id: rec.id, op: 'upsert', baseVersion: rec.version, data: { ...strip(rec), ...patch } });
const PAD = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const ZONE = 'America/Winnipeg';
const today = dayIn(new Date().toISOString(), ZONE);
const mbTaxes = taxComponents({ province: 'MB', treatment: 'pst-all', date: today });
const mb = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: mbTaxes, taxPct: 12 };
const settings = { company: { name: 'TG Electrical (get paid)', province: 'MB' }, labourRateCents: 9500, markupPct: 20,
  tickets: { agreementText: 'I confirm the work listed above was requested and done.', noticeOnRefusal: true, captureLocation: true, draftStaleDays: 3 } };
const conn = await call({ method: 'PUT', url: '/api/v1/integrations/resend', token: owner, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'TG Electrical <office@tg-gp.test>' } } });
assert.equal(conn.status, 200, JSON.stringify(conn.body));
await pushOk(owner, [
  upsert('settings', 'settings', settings),
  upsert('clients', 'gc', { name: 'Prairie Builders', email: 'pm@prairie.test' }),
  upsert('clients', 'home', { name: 'Dana Home', email: 'dana@home.test' }),
  upsert('items', 'pot', { name: 'Pot light', unit: 'ea', costCents: 2000, priceCents: 4500 }),
  upsert('jobs', 'job-fp', { number: 'J-1042', title: 'Clinic fit-up', clientId: 'gc', status: 'in-progress', billingMode: 'fixed', changeOrders: [],
    contract: { role: 'prime', signedOn: '2025-05-01', valueCents: 5000000, holdbackPct: 10, gcClientId: 'gc', authorizedSigners: [{ name: 'Pat Super', title: 'Superintendent' }] } }),
  upsert('jobs', 'job-tm', { number: 'J-1043', title: 'Service upgrades', clientId: 'gc', status: 'in-progress', billingMode: 'tm', changeOrders: [] }),
  upsert('jobs', 'job-svc', { number: 'J-1044', title: 'No power in kitchen', clientId: 'home', status: 'in-progress', kind: 'service', billingMode: 'tm', changeOrders: [] }),
]);
log(`company set up for ${today}`);
const ticketBody = (id, jobId, extra = {}) => ({ id, ...newTicket({ job: { id: jobId, clientId: 'gc', billingMode: jobId === 'job-tm' ? 'tm' : 'fixed' }, employee: { id: 'emp-sam' }, settings, date: today }),
  title: 'Move two pot lights', description: 'GC asked on site', requestedBy: 'Pat Super', labour: [{ employeeId: 'emp-sam', name: 'Sam Sparks', hours: 1.5 }], materials: [{ itemId: 'pot', description: 'Pot light', qty: 2, unit: 'ea' }], ...extra });
const signTicket = async (tk, extra = {}) => {
  const sig = await buildSignature({ docType: 'fieldTicket', doc: tk, signerName: 'Pat Super', dataUrl: PAD, capturedBy: { employeeId: 'emp-sam', name: 'Sam Sparks' }, loc: { lat: 49.9, lng: -97.1, accuracyM: 12, at: new Date().toISOString() }, ...extra });
  return { sig, muts: [upsert('signatures', sig.id, strip(sig)), upsert('fieldTickets', tk.id, { ...strip(tk), status: 'signed', signatureId: sig.id, signedAt: sig.signedAt, signerName: sig.signerName })] };
};
let coId;

await step('offline ticket with photos on a fixed-price job: signed, synced, numbered; the electrician never sees a price', async () => {
  const tk = ticketBody('tk-fp', 'job-fp', { photos: [{ id: 'ph-1', dataUrl: PAD, takenAt: new Date().toISOString(), width: 1, height: 1 }, { id: 'ph-2', dataUrl: PAD, takenAt: new Date().toISOString(), width: 1, height: 1 }] });
  const { muts } = await signTicket(tk);
  await pushOk(tokens.electrician, muts); // the queue pushes the signature first, then the ticket
  const stored = await get('fieldTickets', 'tk-fp', tokens.electrician);
  assert.match(stored.number, /^T-\d{4}$/);
  assert.equal(stored.status, 'signed');
  const sig = await get('signatures', stored.signatureId, tokens.electrician);
  assert.equal(sig.status, 'valid');
  assert.equal(JSON.stringify(sig.snapshot).includes('Cents'), false);
  assert.equal(JSON.stringify(stored).includes('Cents'), false, 'a ticket carries no money');
});

await step('the office prices it into a change order, signs the change order on the iPad and bills it; the ticket shows billed', async () => {
  const tk = await get('fieldTickets', 'tk-fp', tokens.office);
  const job = await get('jobs', 'job-fp', tokens.office);
  const items = [await get('items', 'pot', tokens.office)];
  const co = ticketToChangeOrder(tk, { job, items, settings, today, id: 'co-tk-fp' });
  coId = co.id;
  assert.equal(co.amountCents, 1.5 * 9500 + 2 * 4500);
  await pushOk(tokens.office, [
    upd('jobs', job, { changeOrders: [co] }),
    upd('fieldTickets', tk, { status: 'priced', changeOrderId: co.id, office: { pricedAt: new Date().toISOString(), pricedBy: 'Dana Office', note: null } }),
  ]);
  const crewView = await get('jobs', 'job-fp', tokens.electrician);
  assert.equal(crewView.changeOrders[0].amountCents, undefined, 'the crew never sees the change order price');
  const sig = await buildSignature({ docType: 'changeOrder', doc: co, extra: { jobId: 'job-fp' }, jobId: 'job-fp', signerName: 'Pat Super', dataUrl: PAD, capturedBy: { name: 'Dana Office' } });
  const j2 = await get('jobs', 'job-fp', tokens.office);
  await pushOk(tokens.office, [upsert('signatures', sig.id, strip(sig)),
    upd('jobs', j2, { changeOrders: j2.changeOrders.map((c) => (c.id === co.id ? { ...c, status: 'approved', approvedOn: today, signatureId: sig.id, signedAt: sig.signedAt, signedName: 'Pat Super' } : c)) })]);
  assert.equal((await get('signatures', sig.id)).status, 'valid');
  const inv = { number: 'INV-3001', clientId: 'gc', jobId: 'job-fp', status: 'draft', issueDate: today, dueDate: addDay(today, 30), ...mb,
    lines: [{ kind: 'other', changeOrderId: co.id, description: `Change order: ${co.title}`, qty: 1, unitCents: co.amountCents }], ticketIds: ['tk-fp'] };
  await pushOk(tokens.office, [upsert('invoices', 'inv-co', inv)]);
  const sent = await call({ method: 'PATCH', url: '/api/v1/invoices/inv-co', token: tokens.office, body: { status: 'sent', sentAt: new Date().toISOString() } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await pushOk(tokens.office, [upd('fieldTickets', await get('fieldTickets', 'tk-fp', tokens.office), { status: 'billed', invoiceId: 'inv-co' })]);
  assert.equal((await get('fieldTickets', 'tk-fp', tokens.electrician)).status, 'billed');
});

await step('T&M job: 6.5 h signed against 8 h of time; the builder flags the day and the invoice is saved with the reason', async () => {
  const at = (h) => `${today}T${String(h).padStart(2, '0')}:00:00.000Z`;
  await pushOk(tokens.electrician, [upsert('timeEntries', 'te-1', { employeeId: 'emp-sam', jobId: 'job-tm', clockIn: at(13), clockOut: at(21), breakMins: 0 })]);
  await call({ method: 'PATCH', url: '/api/v1/timeEntries/te-1', token: owner, body: { approved: true, approvedAt: new Date().toISOString(), approvedBy: 'emp-off' } });
  const { muts } = await signTicket(ticketBody('tk-tm', 'job-tm', { kind: 'tm', labour: [{ employeeId: 'emp-sam', name: 'Sam Sparks', hours: 6.5 }], materials: [] }));
  await pushOk(tokens.electrician, muts);
  const job = await get('jobs', 'job-tm', tokens.office);
  const all = (coll) => call({ url: `/api/v1/${coll}?limit=500`, token: tokens.office }).then((r) => r.body.data);
  const src = { timeEntries: await all('timeEntries'), stockMoves: [], materialRequests: [], items: [], employees: await all('employees'), invoices: await all('invoices'), fieldTickets: await all('fieldTickets') };
  const draft = buildTmInvoice({ job, settings, issueDate: today, dueDate: addDay(today, 14), ...src, dayOf: (iso) => dayIn(iso, ZONE) });
  const rows = Array.isArray(draft.invoice.ticketReconciliation) ? draft.invoice.ticketReconciliation : ticketReconciliation({ tickets: billableTickets(src.fieldTickets, 'job-tm'), labour: draft.unbilled.labour });
  const day = rows.find((r) => r.day === today);
  assert.deepEqual([day.billedMinutes, day.signedMinutes], [480, 390]);
  assert.equal(day.flagged ?? day.billedMinutes > day.signedMinutes, true, 'the day is flagged');
  const ticketIds = draft.invoice.ticketIds || billableTickets(src.fieldTickets, 'job-tm').map((t) => t.id);
  await pushOk(tokens.office, [upsert('invoices', 'inv-tm', { ...draft.invoice, number: 'INV-3002', ticketIds,
    ticketReconciliation: rows.map((r) => ({ day: r.day, billedMinutes: r.billedMinutes, signedMinutes: r.signedMinutes, reason: 'Super signed before the last 1.5 h of cleanup' })) })]);
  const tk = await get('fieldTickets', 'tk-tm', tokens.office);
  await pushOk(tokens.office, [upd('fieldTickets', tk, { status: 'billed', invoiceId: 'inv-tm' })]);
  assert.equal((await get('invoices', 'inv-tm')).ticketReconciliation[0].reason.length > 0, true);
});

await step('a refused ticket queues a written notice to the GC; a signed service ticket becomes a draft invoice', async () => {
  const ref = ticketBody('tk-ref', 'job-fp');
  await pushOk(tokens.electrician, [upsert('fieldTickets', 'tk-ref', { ...strip(ref), status: 'refused', refusal: { at: new Date().toISOString(), by: 'Pat Super', reason: 'Not ours' } })]);
  const svc = ticketBody('tk-svc', 'job-svc', { kind: 'tm', materials: [] });
  const { muts } = await signTicket(svc);
  await pushOk(tokens.electrician, muts);
  const a = await runTicketsSweep(db, T, { records });
  const b = await runTicketsSweep(db, T, { records });
  assert.equal(a.notices, 1); assert.equal(b.notices, 0);
  assert.equal(a.drafts, 1); assert.equal(b.drafts, 0);
  const notice = (await superDb.query("SELECT data FROM outbox WHERE tenant_id = $1 AND id = 'tnotice-tk-ref'", [T])).rows[0]?.data;
  assert.equal(notice?.to, 'pm@prairie.test');
  const draft = await get('invoices', 'svc-tk-svc', tokens.office);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.lines.map((l) => [l.qty, l.unitCents]), [[1.5, 9500]]);
});

await step('an estimate signed on the device is accepted; its revision supersedes it', async () => {
  const est = { id: 'est-1', number: 'E-2001', clientId: 'gc', jobId: 'job-fp', title: 'Clinic fit-up', status: 'sent', issueDate: today, validUntil: addDay(today, 30), ...mb,
    lines: [{ kind: 'labour', description: 'Rough-in', qty: 40, unitCents: 9500 }, { kind: 'material', description: 'Wire', qty: 1, unitCents: 100000 }], markupPct: 0, notes: '' };
  await pushOk(tokens.office, [upsert('estimates', 'est-1', strip(est))]);
  const sig = await buildSignature({ docType: 'estimate', doc: est, signerName: 'Clinic Owner', dataUrl: PAD, capturedBy: { name: 'Dana Office' } });
  await pushOk(tokens.office, [upsert('signatures', sig.id, strip(sig)), upd('estimates', await get('estimates', 'est-1', tokens.office), { status: 'accepted', signatureId: sig.id, signedAt: sig.signedAt, signedName: 'Clinic Owner', acceptedVia: 'signature' })]);
  assert.equal((await get('signatures', sig.id)).status, 'valid');
  const frozen = await call({ method: 'PATCH', url: '/api/v1/estimates/est-1', token: tokens.office, body: { lines: [] } });
  assert.equal(frozen.body.error.code, 'document_signed', 'a signed estimate changes by revision');
  const rev = { ...strip(est), number: 'E-2002', status: 'accepted', revisionOf: 'est-1', acceptedVia: 'manual', lines: [...est.lines, { kind: 'labour', description: 'Extra circuit', qty: 4, unitCents: 9500 }] };
  await pushOk(tokens.office, [upsert('estimates', 'est-2', rev), upd('estimates', await get('estimates', 'est-1', tokens.office), { status: 'superseded' })]);
  assert.equal((await get('estimates', 'est-1')).status, 'superseded');
});

await step('a prepayment deposit is paid and applied on the final invoice with the right totals', async () => {
  const dep = { number: 'INV-3003', clientId: 'gc', jobId: 'job-fp', status: 'sent', issueDate: today, dueDate: today, ...mb, ...depositInvoiceFields('prepayment'), lines: [depositInvoiceLine({ cents: 100000, model: 'prepayment', ref: 'E-2001' })] };
  await pushOk(tokens.office, [upsert('invoices', 'dep-1', dep), upsert('payments', 'pay-dep', { invoiceId: 'dep-1', clientId: 'gc', amountCents: docTotals(dep).totalCents, date: today, method: 'cheque' })]);
  const invoices = (await call({ url: '/api/v1/invoices?limit=500', token: tokens.office })).body.data;
  const payments = (await call({ url: '/api/v1/payments?limit=500', token: tokens.office })).body.data;
  const [avail] = depositsAvailable(invoices, payments, { jobId: 'job-fp' });
  assert.equal(avail.availableCents, 100000);
  const final = { number: 'INV-3004', clientId: 'gc', jobId: 'job-fp', status: 'draft', issueDate: today, dueDate: addDay(today, 30), ...mb, lines: [{ kind: 'labour', description: 'Final', qty: 1, unitCents: 500000 }] };
  assert.equal(sameTaxSet({ ...dep, id: 'dep-1' }, final), true);
  final.lines.push(depositApplicationLine({ ...dep, id: 'dep-1' }, avail.availableCents));
  const t = docTotals(final);
  assert.equal(t.totalCents, Math.round(400000 * 1.12), '$5,000 less the $1,000 deposit, taxed once: $4,480');
  await pushOk(tokens.office, [upsert('invoices', 'inv-final', final)]);
  const after = depositsAvailable([...invoices, { ...final, id: 'inv-final' }], payments, { jobId: 'job-fp' })[0];
  assert.equal(after.availableCents, 0);
  const sent = await call({ method: 'PATCH', url: '/api/v1/invoices/inv-final', token: tokens.office, body: { status: 'sent' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
});

await step('a progress invoice holds back 10%; the release invoice bills it with the deferred taxes only', async () => {
  const prog = { number: 'INV-3005', clientId: 'gc', jobId: 'job-fp', kind: 'progress', status: 'draft', issueDate: today, dueDate: addDay(today, 30), ...mb, lines: [{ kind: 'labour', description: 'Progress to 40%', qty: 1, unitCents: 2000000 }] };
  prog.holdback = holdbackSnapshot(prog, { pct: 10, rules: null });
  assert.deepEqual(prog.holdback.deferTaxIds, ['GST', 'RST']);
  const t = docTotals(prog);
  assert.equal(t.holdbackCents, 200000);
  assert.equal(t.totalCents, Math.round(1800000 * 1.12), 'tax on the work net of holdback');
  await pushOk(tokens.office, [upsert('invoices', 'inv-prog', prog)]);
  assert.equal((await call({ method: 'PATCH', url: '/api/v1/invoices/inv-prog', token: tokens.office, body: { status: 'sent' } })).status, 200);
  const invoices = (await call({ url: '/api/v1/invoices?limit=500', token: tokens.office })).body.data;
  const led = holdbackLedger(invoices, { jobId: 'job-fp' });
  assert.equal(led.outstandingCents, 200000);
  const rel = { number: 'INV-3006', clientId: 'gc', jobId: 'job-fp', kind: 'holdback-release', holdbackInvoiceIds: ['inv-prog'], status: 'draft', issueDate: today, dueDate: today, ...mb,
    lines: [holdbackReleaseLine(led.outstandingCents, { taxes: mb.taxes, deferTaxIds: prog.holdback.deferTaxIds })] };
  assert.equal(docTotals(rel).totalCents, 224000, '$2,000 plus GST and RST deferred to release');
  await pushOk(tokens.office, [upsert('invoices', 'inv-rel', rel)]);
  assert.equal((await call({ method: 'PATCH', url: '/api/v1/invoices/inv-rel', token: tokens.office, body: { status: 'sent' } })).status, 200);
  assert.equal(holdbackLedger([...invoices, { ...rel, id: 'inv-rel', status: 'sent' }], { jobId: 'job-fp' }).outstandingCents, 0);
});

await step('complete shows the open items as warnings; invoiced is refused until they are cleared (or a reason is given)', async () => {
  const all = async (coll) => (await call({ url: `/api/v1/${coll}?limit=500`, token: tokens.office })).body.data;
  const src = async () => ({ invoices: await all('invoices'), payments: await all('payments'), fieldTickets: await all('fieldTickets'), timeEntries: await all('timeEntries'), settings, purchaseOrders: [], bills: [], permits: [], inspections: [] });
  const job = await get('jobs', 'job-fp', tokens.office);
  const atComplete = closeoutChecklist(job, await src(), { at: 'complete', asOf: today });
  assert.ok(atComplete.length > 0 && atComplete.every((i) => i.severity === 'warn'), JSON.stringify(atComplete));
  await pushOk(tokens.office, [upd('jobs', job, { status: 'complete', closeout: closeoutRecord(atComplete, { by: 'Dana Office', stage: 'complete' }), contract: { ...job.contract, completedOn: today } })]);
  const j2 = await get('jobs', 'job-fp', tokens.office);
  const noCheck = await call({ method: 'PATCH', url: '/api/v1/jobs/job-fp', token: tokens.office, body: { status: 'invoiced', closeout: null } });
  assert.equal(noCheck.body.error.code, 'closeout_required', 'no checklist: refused');
  const atInvoiced = closeoutChecklist(j2, await src(), { at: 'invoiced', asOf: today });
  const blocks = atInvoiced.filter((i) => i.severity === 'block');
  assert.ok(blocks.some((i) => i.key === 'tickets_open'), 'the refused ticket is not priced yet');
  const refused = await call({ method: 'PATCH', url: '/api/v1/jobs/job-fp', token: tokens.office, body: { status: 'invoiced', closeout: closeoutRecord(atInvoiced, { by: 'Dana Office' }) } });
  assert.equal(refused.body.error.code, 'closeout_required', 'blocking items: refused');
  // Clear: price the refused ticket into a change order, bill it, sign off.
  const tk = await get('fieldTickets', 'tk-ref', tokens.office);
  const co = ticketToChangeOrder(tk, { job: j2, items: [await get('items', 'pot', tokens.office)], settings, today, id: 'co-tk-ref' });
  assert.match(co.note, /^Unsigned: written notice given/);
  await pushOk(tokens.office, [upd('jobs', j2, { changeOrders: [...j2.changeOrders, { ...co, status: 'approved', approvedOn: today }] }),
    upd('fieldTickets', tk, { status: 'priced', changeOrderId: co.id, office: { pricedAt: new Date().toISOString(), pricedBy: 'Dana Office' } }),
    upsert('invoices', 'inv-co2', { number: 'INV-3007', clientId: 'gc', jobId: 'job-fp', status: 'draft', issueDate: today, dueDate: addDay(today, 30), ...mb, lines: [{ kind: 'other', changeOrderId: co.id, description: co.title, qty: 1, unitCents: co.amountCents }], ticketIds: ['tk-ref'] })]);
  await call({ method: 'PATCH', url: '/api/v1/invoices/inv-co2', token: tokens.office, body: { status: 'sent' } });
  const tk2 = await get('fieldTickets', 'tk-ref', tokens.office);
  await pushOk(tokens.office, [upd('fieldTickets', tk2, { status: 'billed', invoiceId: 'inv-co2' })]);
  const j3 = await get('jobs', 'job-fp', tokens.office);
  const clear = closeoutChecklist(j3, await src(), { at: 'invoiced', asOf: today });
  assert.deepEqual(clear.filter((i) => i.severity === 'block').map((i) => i.key), [], JSON.stringify(clear));
  const ok = await call({ method: 'PATCH', url: '/api/v1/jobs/job-fp', token: tokens.office, body: { status: 'invoiced', closeout: closeoutRecord(clear, { by: 'Dana Office' }) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  void coId;
});

await app.close();
await db.close();
await ownerClient.end();
await superDb.end();
await pgServer.stop();
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
