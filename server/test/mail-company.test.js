// Company email through the company's own SendGrid account (the alternative to Resend on the
// Integrations screen). SendGrid is a fake fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, startApp } from './support/app.js';
import { setFetch } from '../src/integrations/http.js';
import { createIntegrationHandlers } from '../src/integrations/jobs.js';
import { recoverStuck } from '../src/integrations/outbox.js';
import { createRecords } from '../src/services/records.js';
import { createValidator } from '../src/schemas.js';

// A fake key shaped like SendGrid's, joined at runtime so secret scanners don't flag the source.
const KEY = ['SG', 'abcdefghijklmnopqrstuv', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg'].join('.');
let t, app, A, handlers, records;
const sent = [];
let scopes = ['mail.send'];

before(async () => {
  if (skip) return;
  t = await createTestDatabase('mail_company');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Electric');
  await call(app, { method: 'POST', url: '/api/v1/settings', token: A.token, body: { id: 'settings', currency: 'CAD', company: { name: 'Alpha Electric', email: 'office@alpha.test', address: '1 Main St, Calgary' } } });
  records = createRecords({ validator: createValidator() });
  handlers = createIntegrationHandlers({ sealer: app.sealer, records });
  setFetch(async (url, init) => {
    if (url === 'https://api.sendgrid.com/v3/scopes') return Response.json({ scopes });
    if (url === 'https://api.sendgrid.com/v3/mail/send') {
      sent.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(null, { status: 202, headers: { 'x-message-id': `co${sent.length}` } });
    }
    throw new Error(`unexpected call to ${url}`);
  });
});
after(async () => { setFetch(null); await app?.close(); await t?.close(); });

test('a company connects SendGrid: key checked by shape, hints only, connection test reads the key\'s scopes', { skip }, async () => {
  const bad = await call(app, { method: 'PUT', url: '/api/v1/integrations/sendgrid', token: A.token, body: { secrets: { 'sendgrid.api_key': 're_not_sendgrid' } } });
  assert.equal(bad.status, 400);
  const r = await call(app, { method: 'PUT', url: '/api/v1/integrations/sendgrid', token: A.token,
    body: { secrets: { 'sendgrid.api_key': KEY, 'sendgrid.from': 'Alpha Electric <office@alpha.test>' }, config: { replyTo: 'office@alpha.test' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'connected');
  assert.ok(!JSON.stringify(r.body).includes(KEY), 'the key never comes back');
  assert.equal(r.body.guide, 'guides/sendgrid.md');
  const test1 = await call(app, { method: 'POST', url: '/api/v1/integrations/sendgrid/test', token: A.token });
  assert.equal(test1.body.status, 'ok');
  scopes = ['alerts.read'];
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/integrations/sendgrid/test', token: A.token })).body.status, 'error');
  scopes = ['mail.send'];
  assert.equal((await call(app, { url: '/api/v1/integrations/available', token: A.token })).body.email, true);
});

test('due company email goes out through the company\'s SendGrid key and sender', { skip }, async () => {
  const q = await call(app, { method: 'POST', url: '/api/v1/outbox', token: A.token,
    body: { status: 'queued', channel: 'email', to: 'pat@example.com', subject: 'Thanks', body: 'Hi Pat', relatedId: 'lead-1', dueAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(q.status, 201);
  const r = await handlers.integrations_dispatch({ db: t.db, job: { payload: { once: true } } });
  assert.equal(r.sent, 1, JSON.stringify(r));
  const m = sent.at(-1);
  assert.equal(m.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(m.body.from, { email: 'office@alpha.test', name: 'Alpha Electric' });
  assert.deepEqual(m.body.personalizations[0].to, [{ email: 'pat@example.com' }]);
  assert.deepEqual(m.body.reply_to, { email: 'office@alpha.test' });
  assert.equal(m.body.personalizations[0].custom_args.fishtape_ref, `fishtape-outbox-${q.body.id}`);
  assert.match(m.body.content[0].value, /reply with "unsubscribe"/);
  const rec = (await call(app, { url: `/api/v1/outbox/${q.body.id}`, token: A.token })).body;
  assert.equal(rec.status, 'sent');
  assert.equal(rec.provider, 'sendgrid');
  assert.equal(rec.providerMessageId, 'co1');
});

test('a SendGrid email interrupted mid-send is marked failed, not sent twice', { skip }, async () => {
  const q = await call(app, { method: 'POST', url: '/api/v1/outbox', token: A.token,
    body: { status: 'sending', channel: 'email', to: 'pat@example.com', subject: 'x', body: 'x', provider: 'sendgrid', sendingAt: new Date(Date.now() - 3600_000).toISOString() } });
  assert.equal(q.status, 201);
  assert.equal(await recoverStuck({ db: t.db, records, tenantId: A.tenantId }), 1);
  const rec = (await call(app, { url: `/api/v1/outbox/${q.body.id}`, token: A.token })).body;
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /SendGrid/);
});
