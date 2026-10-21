// Statements (docs/releases/r1-get-paid.md 4.5, 11): the JSON route gives the same balances the PWA
// prints (electrical-app/js/lib/receivables.js), the HTML form prints, sending queues an outbox item
// (kind statement) and is audited, and the routes check the invoices permission, the plan's email,
// the connection and the company.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';
import receivablesRoutes from '../src/routes/v1/receivables.js';

async function startR1App(t) {
  const config = testConfig();
  const app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  const records = createRecords({ validator: createValidator(), config, db: t.db });
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/statements/:clientId' })) await app.register(receivablesRoutes, { db: t.db, records, config });
  await app.ready();
  return { app, config, records };
}

let t, app, A, B, office, sam;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: mutations.map(mut) } });
const line = (cents) => [{ kind: 'labour', description: 'Work', qty: 1, unitCents: cents }];
const inv = (id, number, cents, issueDate, dueDate, extra = {}) => ({ collection: 'invoices', id, op: 'upsert', data: { number, clientId: 'gc', status: 'sent', issueDate, dueDate, taxes: [], lines: line(cents), ...extra } });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('statements');
  ({ app } = await startR1App(t));
  A = await ownerTenant(t, app, 'Statement Electric');
  B = await ownerTenant(t, app, 'Elsewhere Electric');
  for (const [id, name, role] of [['emp-off', 'Olive Office', 'office'], ['emp-sam', 'Sam Sparks', 'electrician']]) {
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id, name, role } })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  const r = await push(A.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Statement Electric', province: 'ON', phone: '204-555-0100' } } },
    { collection: 'clients', id: 'gc', op: 'upsert', data: { name: 'Prairie Builders', email: 'ap@prairie.test', credit: { statementEmail: 'statements@prairie.test' } } },
    inv('a', 'INV-1', 100000, '2026-07-01', '2026-07-31'),
    inv('b', 'INV-2', 50000, '2026-08-10', '2026-09-09', { disputes: [{ id: 'd', cents: 10000, status: 'open', reason: 'Cleanup' }] }),
    inv('c', 'INV-3', 80000, '2026-09-05', '2026-10-05', { holdback: { retainedByCustomerCents: 8000 } }),
    { collection: 'invoices', id: 'cn', op: 'upsert', data: { number: 'CR-1001', kind: 'credit', clientId: 'gc', status: 'sent', issueDate: '2026-09-10', taxes: [], lines: line(-5000), creditsInvoiceId: 'a', creditReason: 'backcharge' } },
    { collection: 'payments', id: 'p-a', op: 'upsert', data: { invoiceId: 'a', amountCents: 60000, date: '2026-08-01', method: 'cheque' } },
    { collection: 'payments', id: 'oa', op: 'upsert', data: { invoiceId: null, clientId: 'gc', amountCents: 20000, date: '2026-09-12', method: 'cheque', reference: 'Chq 77' } },
    { collection: 'payments', id: 'oa-use', op: 'upsert', data: { invoiceId: 'a', appliedFromId: 'oa', amountCents: 5000, date: '2026-09-13', method: 'cheque' } },
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('statements', { skip }, () => {
  test('the JSON statement: opening, rows, closing, aging and the lines out of aging', async () => {
    const r = await call(app, { url: '/api/v1/statements/gc?from=2026-08-01&to=2026-09-30', token: office.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const s = r.body;
    assert.equal(s.client.name, 'Prairie Builders');
    assert.equal(s.openingCents, 100000);
    assert.deepEqual(s.rows.map((x) => x.type), ['payment', 'invoice', 'invoice', 'credit-note', 'on-account']);
    assert.equal(s.closingCents, 145000);
    assert.deepEqual(s.aging, { current: 72000, d30: 40000, d60: 0, d90: 35000, d90p: 0 });
    assert.equal(s.disputedCents, 10000);
    assert.equal(s.holdbackRetainedCents, 8000);
    assert.equal(s.onAccountCents, 15000);
    const html = await call(app, { url: '/api/v1/statements/gc?from=2026-08-01&to=2026-09-30&format=html', token: office.token });
    assert.equal(html.status, 200);
    assert.match(html.raw.body, /<h2>Statement for Prairie Builders<\/h2>/);
    assert.match(html.raw.body, /In dispute: \$100\.00/);
  });

  test('permissions and the company: the crew cannot read it; another company gets 404', async () => {
    assert.equal((await call(app, { url: '/api/v1/statements/gc', token: sam.token })).status, 403);
    assert.equal((await call(app, { url: '/api/v1/statements/gc', token: B.token })).status, 404);
    assert.equal((await call(app, { url: '/api/v1/statements/gc?from=2026-10-01&to=2026-09-01', token: office.token })).status, 400);
  });

  test('sending needs email connected, then queues one outbox item (kind statement) and an audit event', async () => {
    const before = await call(app, { method: 'POST', url: '/api/v1/statements/gc/send', token: office.token, body: { from: '2026-08-01', to: '2026-09-30' } });
    assert.equal(before.status, 409);
    assert.equal(before.body.error.code, 'not_connected');
    const c = await call(app, { method: 'PUT', url: '/api/v1/integrations/resend', token: A.token, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'Statement Electric <office@statement.test>' } } });
    assert.equal(c.status, 200);
    const r = await call(app, { method: 'POST', url: '/api/v1/statements/gc/send', token: office.token, body: { from: '2026-08-01', to: '2026-09-30' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.to, 'statements@prairie.test');
    const ob = (await t.superPool.query('SELECT data FROM outbox WHERE tenant_id = $1 AND id = $2', [A.tenantId, r.body.outboxId])).rows[0].data;
    assert.equal(ob.kind, 'statement');
    assert.equal(ob.status, 'queued');
    assert.match(ob.body, /Balance: \$1,450\.00/);
    assert.match(ob.body, /Amounts in dispute: \$100\.00/);
    const audit = await t.superPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'statement.send'", [A.tenantId]);
    assert.equal(audit.rows[0].n, 1);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/statements/gc/send', token: sam.token, body: {} })).status, 403);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/statements/gc/send', token: office.token, body: { toEmail: 'not an email' } })).status, 400);
  });
});
