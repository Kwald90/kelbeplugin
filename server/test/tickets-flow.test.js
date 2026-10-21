// Field tickets end to end on the server (docs/releases/r1-get-paid.md 4.1, 2.10, 10.1): the phone
// pushes the signature and then the signed ticket in one batch and gets a T-number; a signature whose
// snapshot does not match is stored unverified and the ticket still lands; the tickets sweep queues
// the written notice once on a refusal, emails the signer a copy once, drafts a service call's invoice
// once and tells the office; the send route sends a stale draft as written notice for the office only.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import ticketRoutes from '../src/routes/v1/tickets.js';
import { runTicketsSweep, scheduleTicketsSweep, createTicketHandlers } from '../src/services/tickets.js';
import { buildSignature } from '../../electrical-app/js/lib/esign.js';
import { newTicket } from '../../electrical-app/js/lib/tickets.js';

async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'POST', url: '/api/v1/tickets/:id/send' })) await app.register(ticketRoutes, { db: t.db, records, config });
  await app.ready();
  return { app, config, records };
}

const PAD = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
let t, app, records, A, B, office, sam;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = async (token, mutations) => (await call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: mutations.map(mut) } })).body.results;
const get = async (token, coll, id) => (await call(app, { url: `/api/v1/${coll}/${id}`, token })).body;
const q = async (sql, args) => (await t.superPool.query(sql, args)).rows;
const settings = { tickets: { agreementText: 'I confirm the work listed above was requested and done.', noticeOnRefusal: true, draftStaleDays: 3 } };
const ticket = (id, jobId, extra = {}) => ({ id, ...newTicket({ job: { id: jobId, clientId: 'gc' }, employee: { id: 'emp-sam' }, settings, date: '2026-10-20' }),
  title: 'Move two pot lights', description: 'Owner asked on site', requestedBy: 'Pat Super', labour: [{ employeeId: 'emp-sam', name: 'Sam Sparks', hours: 1.5 }],
  materials: [{ description: 'Pot light', qty: 2, unit: 'ea' }], ...extra });
/** The phone's write order: the signature first, the signed ticket second, in one push. */
async function signOnPhone(tk, { signerEmail = null, tamper = false } = {}) {
  const sig = await buildSignature({ docType: 'fieldTicket', doc: tk, signerName: 'Pat Super', signerEmail, dataUrl: PAD, capturedBy: { employeeId: 'emp-sam', name: 'Sam Sparks' }, id: `sig-${tk.id}` });
  if (tamper) sig.snapshot = { ...sig.snapshot, title: 'Something else' };
  return push(sam.token, [
    { collection: 'signatures', id: sig.id, op: 'upsert', data: (({ id, ...d }) => d)(sig) },
    { collection: 'fieldTickets', id: tk.id, op: 'upsert', data: { ...(({ id, ...d }) => d)(tk), status: 'signed', signatureId: sig.id, signedAt: sig.signedAt, signerName: 'Pat Super' } },
  ]);
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('ticketsflow');
  ({ app, records } = await startR1App(t));
  A = await ownerTenant(t, app, 'Ticket Electric');
  B = await ownerTenant(t, app, 'Another Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  const c = await call(app, { method: 'PUT', url: '/api/v1/integrations/resend', token: A.token, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'Ticket Electric <office@ticket.test>' } } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const r = await push(A.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Ticket Electric', province: 'ON' }, labourRateCents: 9500, ...settings } },
    { collection: 'clients', id: 'gc', op: 'upsert', data: { name: 'Prairie Builders', email: 'pm@prairie.test' } },
    { collection: 'clients', id: 'owner-co', op: 'upsert', data: { name: 'Clinic Owner Inc', email: 'owner@clinic.test' } },
    { collection: 'clients', id: 'home', op: 'upsert', data: { name: 'Dana Home', email: 'dana@home.test' } },
    { collection: 'jobs', id: 'job-fp', op: 'upsert', data: { number: 'J-1042', title: 'Clinic fit-up', clientId: 'owner-co', status: 'in-progress', billingMode: 'fixed', changeOrders: [], contract: { role: 'sub', gcClientId: 'gc' } } },
    { collection: 'jobs', id: 'job-svc', op: 'upsert', data: { number: 'J-1043', title: 'No power in kitchen', clientId: 'home', status: 'in-progress', kind: 'service', billingMode: 'tm', changeOrders: [] } },
  ]);
  for (const x of r) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('tickets from the phone', { skip }, () => {
  test('signature then ticket in one push; the server numbers the ticket', async () => {
    const tk = ticket('tk-1', 'job-fp');
    const res = await signOnPhone(tk, { signerEmail: 'pat@prairie.test' });
    assert.deepEqual(res.map((x) => x.status), ['ok', 'ok'], JSON.stringify(res));
    const stored = await get(A.token, 'fieldTickets', 'tk-1');
    assert.match(stored.number, /^T-\d{4}$/);
    assert.equal(stored.status, 'signed');
    assert.equal((await get(A.token, 'signatures', 'sig-tk-1')).status, 'valid');
  });

  test('a snapshot that does not match is stored unverified, and the ticket still lands', async () => {
    const res = await signOnPhone(ticket('tk-2', 'job-fp'), { tamper: true });
    assert.deepEqual(res.map((x) => x.status), ['ok', 'ok'], JSON.stringify(res));
    const sig = await get(A.token, 'signatures', 'sig-tk-2');
    assert.equal(sig.status, 'unverified');
    assert.equal((await get(A.token, 'fieldTickets', 'tk-2')).status, 'signed');
  });

  test('a refused ticket: the sweep queues the written notice to the GC once and records it on the ticket', async () => {
    const tk = ticket('tk-3', 'job-fp');
    const res = await push(sam.token, [{ collection: 'fieldTickets', id: 'tk-3', op: 'upsert', data: { ...(({ id, ...d }) => d)(tk), status: 'refused', refusal: { at: '2026-10-20T19:00:00Z', by: 'Pat Super', reason: 'Not in scope' } } }]);
    assert.equal(res[0].status, 'ok', JSON.stringify(res));
    const first = await runTicketsSweep(t.db, A.tenantId, { records });
    const second = await runTicketsSweep(t.db, A.tenantId, { records });
    assert.equal(first.notices, 1);
    assert.equal(second.notices, 0, 'once');
    const ob = await q("SELECT id, data FROM outbox WHERE tenant_id = $1 AND data->>'kind' = 'ticket_notice'", [A.tenantId]);
    assert.deepEqual(ob.map((r) => r.id), ['tnotice-tk-3']);
    assert.equal(ob[0].data.to, 'pm@prairie.test', 'the general contractor on the contract, not the job\'s owner');
    assert.match(ob[0].data.body, /^Written notice of extra work: T-\d{4} on J-1042 Clinic fit-up, done 2026-10-20, refused by Pat Super/);
    assert.doesNotMatch(ob[0].data.body, /\$/);
    const stored = await get(A.token, 'fieldTickets', 'tk-3');
    assert.equal(stored.notice.kind, 'refusal');
    assert.equal(stored.notice.outboxId, 'tnotice-tk-3');
    const copies = await q("SELECT id FROM outbox WHERE tenant_id = $1 AND data->>'kind' = 'ticket_copy'", [A.tenantId]);
    assert.deepEqual(copies.map((r) => r.id), ['tcopy-tk-1'], 'a copy for the signer who gave an email, once');
    const signed = await q("SELECT ref FROM notifications WHERE tenant_id = $1 AND kind = 'ticket_signed'", [A.tenantId]);
    assert.ok(['ticket_signed:tk-1', 'ticket_signed:tk-2', 'ticket_signed:tk-3'].every((r) => signed.some((x) => x.ref === r)));
  });

  test('a signed service ticket becomes a draft invoice once, numbered on the server, and the office is told', async () => {
    const res = await signOnPhone(ticket('tk-4', 'job-svc', { kind: 'tm' }));
    assert.deepEqual(res.map((x) => x.status), ['ok', 'ok'], JSON.stringify(res));
    const a = await runTicketsSweep(t.db, A.tenantId, { records });
    const b = await runTicketsSweep(t.db, A.tenantId, { records });
    assert.equal(a.drafts, 1);
    assert.equal(b.drafts, 0);
    const inv = await get(A.token, 'invoices', 'svc-tk-4');
    assert.equal(inv.status, 'draft');
    assert.match(inv.number, /^INV-\d+$/);
    assert.deepEqual(inv.ticketIds, ['tk-4']);
    assert.deepEqual(inv.lines.map((l) => [l.kind, l.qty, l.unitCents]), [['labour', 1.5, 9500], ['material', 2, 0]]);
    assert.equal((await get(A.token, 'fieldTickets', 'tk-4')).invoiceId, 'svc-tk-4');
    const n = await q("SELECT title FROM notifications WHERE tenant_id = $1 AND kind = 'service_draft' AND ref = 'service_draft:tk-4'", [A.tenantId]);
    assert.ok(n.length >= 1);
    assert.match(n[0].title, /^Price within the hour: service call T-\d{4} signed$/);
    assert.equal((await get(A.token, 'settings', 'settings')).nextNumbers.invoice, Number(inv.number.slice(4)) + 1);
  });

  test('"Send as written notice" on a stale draft: office only, full session, audited', async () => {
    const tk = ticket('tk-5', 'job-fp', { date: '2026-10-10' });
    assert.equal((await push(sam.token, [{ collection: 'fieldTickets', id: 'tk-5', op: 'upsert', data: (({ id, ...d }) => d)(tk) }]))[0].status, 'ok');
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/tickets/tk-5/send', token: sam.token, body: { kind: 'notice' } })).status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/tickets/tk-5/send', token: B.token, body: { kind: 'notice' } })).status, 404, 'another company');
    const r = await call(app, { method: 'POST', url: '/api/v1/tickets/tk-5/send', token: office.token, body: { kind: 'notice' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'unsigned');
    const stored = await get(A.token, 'fieldTickets', 'tk-5');
    assert.equal(stored.notice.kind, 'unsigned');
    assert.equal(stored.status, 'draft', 'still the crew\'s draft');
    const audit = await q("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'ticket.send_notice'", [A.tenantId]);
    assert.equal(audit[0].n, 1);
    const copy = await call(app, { method: 'POST', url: '/api/v1/tickets/tk-1/send', token: office.token, body: { kind: 'copy' } });
    assert.equal(copy.status, 201);
    assert.equal(copy.body.to, 'pat@prairie.test');
  });

  test('the sweep is scheduled every 15 minutes per company, once per slot, and the handler runs it', async () => {
    await scheduleTicketsSweep(t.db, new Date(), { tenantId: A.tenantId });
    await scheduleTicketsSweep(t.db, new Date(), { tenantId: A.tenantId });
    const rows = await q("SELECT * FROM jobs_queue WHERE kind = 'tickets_sweep' AND tenant_id = $1", [A.tenantId]);
    assert.equal(rows.length, 1);
    const out = await createTicketHandlers({ records }).tickets_sweep({ db: t.db, job: rows[0] });
    assert.equal(out.drafts, 0);
  });
});
