// Customer-communication flows wired into the records write pipeline (services/customer-comms.js):
// an ETA "on the way" email when a tech enters the time-clock TRAVEL state for a job with a customer,
// and a review ask when a job is closed. Both are OFF by default, gated by settings.notifications and
// a connected email provider, queued as outbox records, and deduped by a deterministic outbox id so a
// trigger never sends twice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { call, ownerTenant, testConfig } from './support/app.js';
import { buildApp } from '../src/app.js';

let t, app, A;
const mut = (o) => ({ mid: `m-${randomBytes(6).toString('hex')}`, baseVersion: null, ...o });
const push = async (token, muts) => (await call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations: muts.map(mut) } })).body.results;
const q = async (sql, args) => (await t.superPool.query(sql, args)).rows;
const outbox = async () => q('SELECT id, data FROM outbox WHERE tenant_id = $1 ORDER BY id', [A.tenantId]);
const sendJobs = async () => q("SELECT payload FROM jobs_queue WHERE tenant_id = $1 AND kind = 'integrations_send'", [A.tenantId]);
const travel = (id, jobId, employeeId = 'emp-sam', extra = {}) => mut({ collection: 'timeEntries', id, op: 'upsert',
  data: { employeeId, jobId, kind: 'travel', clockIn: '2026-11-09T14:00:00.000Z', clockOut: null, breakMins: 0, note: '', approved: false, source: 'clock', ...extra } });

before(async () => {
  if (skip) return;
  t = await createTestDatabase('ccomm');
  app = await buildApp({ config: testConfig(), db: t.db, oidcProviders: {}, logStream: new Writable({ write(c, e, cb) { cb(); } }) });
  await app.ready();
  A = await ownerTenant(t, app, 'TG Electric');
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/employees', token: A.token, body: { id: 'emp-sam', name: 'Sam Sparks', role: 'electrician' } })).status, 201);
  // Connect a sending provider so the hook queues (else it stands down).
  const c = await call(app, { method: 'PUT', url: '/api/v1/integrations/resend', token: A.token, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'TG Electric <office@tg.test>' } } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const r = await push(A.token, [
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'TG Electric', province: 'MB', phone: '204-555-1212' },
      notifications: { eta: { on: true, message: '' }, review: { on: true, url: 'https://g.page/r/tg', message: '' }, replyTo: 'office@tg.test' } } },
    { collection: 'clients', id: 'home', op: 'upsert', data: { name: 'Dana Home', email: 'dana@home.test' } },
    { collection: 'clients', id: 'noemail', op: 'upsert', data: { name: 'No Email Inc' } },
    { collection: 'jobs', id: 'job1', op: 'upsert', data: { number: 'J-1042', title: 'Panel swap', clientId: 'home', status: 'scheduled' } },
    { collection: 'jobs', id: 'job2', op: 'upsert', data: { number: 'J-1043', title: 'No contact', clientId: 'noemail', status: 'scheduled' } },
  ]);
  for (const x of r) assert.equal(x.status, 'ok', JSON.stringify(x));
});

after(async () => { if (t) await t.close(); });

test('ETA: entering TRAVEL to a job with a customer queues one on-the-way email', { skip }, async () => {
  const r = await push(A.token, [travel('te-1', 'job1')]);
  assert.equal(r[0].status, 'ok', JSON.stringify(r[0]));
  const rows = await outbox();
  const eta = rows.find((x) => x.id === 'eta-te-1');
  assert.ok(eta, 'eta outbox record exists');
  assert.equal(eta.data.channel, 'email');
  assert.equal(eta.data.kind, 'eta');
  assert.equal(eta.data.status, 'queued');
  assert.equal(eta.data.to, 'dana@home.test');
  assert.equal(eta.data.replyTo, 'office@tg.test');
  assert.match(eta.data.body, /Sam from TG Electric is on the way/);
  // and a send job was enqueued for it
  assert.ok((await sendJobs()).some((j) => j.payload.outboxId === 'eta-te-1'), 'send job enqueued');
});

test('ETA dedupe: a later update to the same travel entry does not re-queue', { skip }, async () => {
  // simulate a location fix attached to the open travel entry (still kind travel)
  const r = await push(A.token, [travel('te-1', 'job1', 'emp-sam', { locStatus: 'captured' })]);
  assert.equal(r[0].status, 'ok', JSON.stringify(r[0]));
  assert.equal((await outbox()).filter((x) => x.id === 'eta-te-1').length, 1, 'still exactly one eta record');
});

test('ETA: no customer email on the job means no email', { skip }, async () => {
  const r = await push(A.token, [travel('te-2', 'job2')]);
  assert.equal(r[0].status, 'ok');
  assert.equal((await outbox()).some((x) => x.id === 'eta-te-2'), false, 'no eta record for a job without a contact');
});

test('review: closing a job queues one review-ask email with the review link', { skip }, async () => {
  const r = await push(A.token, [{ collection: 'jobs', id: 'job1', op: 'upsert', baseVersion: null,
    data: { number: 'J-1042', title: 'Panel swap', clientId: 'home', status: 'complete' } }].map(mut));
  assert.equal(r[0].status, 'ok', JSON.stringify(r[0]));
  const rev = (await outbox()).find((x) => x.id === 'review-job1');
  assert.ok(rev, 'review outbox record exists');
  assert.equal(rev.data.kind, 'review');
  assert.equal(rev.data.to, 'dana@home.test');
  assert.match(rev.data.body, /https:\/\/g\.page\/r\/tg/);
});

test('review dedupe: re-saving the already-closed job does not re-queue', { skip }, async () => {
  const r = await push(A.token, [{ collection: 'jobs', id: 'job1', op: 'upsert', baseVersion: null,
    data: { number: 'J-1042', title: 'Panel swap (tidied up)', clientId: 'home', status: 'complete' } }].map(mut));
  assert.equal(r[0].status, 'ok', JSON.stringify(r[0]));
  assert.equal((await outbox()).filter((x) => x.id === 'review-job1').length, 1, 'still exactly one review record');
});

test('off by default: with the toggles off nothing is queued', { skip }, async () => {
  const B = await ownerTenant(t, app, 'Off Electric');
  const bpush = async (muts) => (await call(app, { method: 'POST', url: '/api/v1/sync/push', token: B.token, body: { mutations: muts.map(mut) } })).body.results;
  await call(app, { method: 'PUT', url: '/api/v1/integrations/resend', token: B.token, body: { secrets: { 'resend.api_key': `re_${randomBytes(12).toString('hex')}`, 'resend.from': 'Off <o@off.test>' } } });
  const r = await bpush([
    { collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Off Electric' } } },
    { collection: 'clients', id: 'cb', op: 'upsert', data: { name: 'Pat', email: 'pat@off.test' } },
    { collection: 'jobs', id: 'jb', op: 'upsert', data: { number: 'J-9', clientId: 'cb', status: 'scheduled' } },
    { collection: 'timeEntries', id: 'teb', op: 'upsert', data: { employeeId: 'e', jobId: 'jb', kind: 'travel', clockIn: '2026-11-09T14:00:00.000Z', clockOut: null, breakMins: 0, approved: false, source: 'clock' } },
    { collection: 'jobs', id: 'jb', op: 'upsert', data: { number: 'J-9', clientId: 'cb', status: 'complete' } },
  ]);
  for (const x of r) assert.equal(x.status, 'ok', JSON.stringify(x));
  assert.equal((await q('SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1', [B.tenantId]))[0].n, 0, 'no emails queued when off');
});
