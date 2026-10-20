// The Enterprise "Let's talk" form: validated, honeypot, rate-limited per IP even with
// RATE_LIMIT=off, never echoes or logs what was sent, lands in HQ and queues one email.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skip, createTestDatabase } from './support/db.js';
import { call } from './support/app.js';
import { NOTIFY_EMAIL, hqUser, startHqApp } from './support/hq.js';

let t, app, logs, admin;
const URL = '/api/v1/public/enterprise-leads';
const PII = { name: 'Morgan Leadsworth', email: 'Morgan.Leads@BigShop.example', company: 'Big Shop Electric Ltd', phone: '306-555-0142' };
const post = (body, ip = '203.0.113.10', headers = {}) => app.inject({
  method: 'POST', url: URL, remoteAddress: ip, headers: { 'content-type': 'application/json', 'x-fishtape': '1', ...headers }, payload: JSON.stringify(body),
});

before(async () => {
  if (skip) return;
  t = await createTestDatabase('leads');
  ({ app, logs } = await startHqApp(t, { hq: { leadsPerHour: 3 } }));
  admin = await hqUser(t, app, 'hq_staff');
});
after(async () => { await app?.close(); await t?.close(); });

describe('Enterprise lead form', { skip }, () => {
  test('a valid lead is stored, audited without PII, and emails HQ without contact details', async () => {
    const r = await post({ ...PII, province: 'SK', teamSize: '16-50', message: 'We run 30 electricians across two shops.' });
    assert.equal(r.statusCode, 202, r.body);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    const lead = (await t.superPool.query('SELECT * FROM hq_leads')).rows;
    assert.equal(lead.length, 1);
    assert.equal(lead[0].email, 'morgan.leads@bigshop.example');
    assert.equal(lead[0].stage, 'new');
    const mail = (await t.superPool.query('SELECT to_address, subject, text_body FROM email_outbox')).rows;
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to_address, NOTIFY_EMAIL);
    assert.match(mail[0].subject, /Big Shop Electric/);
    assert.match(mail[0].text_body, new RegExp(`/hq/#/leads/${lead[0].id}`));
    for (const s of [PII.email.toLowerCase(), PII.phone, PII.name]) assert.ok(!mail[0].text_body.includes(s), `email body has ${s}`);
    const audit = (await t.superPool.query("SELECT summary, meta FROM audit_events WHERE action = 'lead.create'")).rows;
    assert.equal(audit[0].summary, 'Enterprise lead received');
    for (const h of Object.values(r.headers)) for (const s of [PII.email, PII.name, PII.company]) assert.ok(!String(h).includes(s));
  });

  test('the honeypot looks accepted but stores nothing', async () => {
    const r = await post({ ...PII, website: 'http://spam.example' }, '203.0.113.20');
    assert.equal(r.statusCode, 202);
    assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM hq_leads')).rows[0].n, 1);
  });

  test('validation errors name fields and never echo values', async () => {
    const r = await post({ name: PII.name, email: 'not-an-email', company: PII.company, phone: PII.phone, extra: PII.email }, '203.0.113.30');
    assert.equal(r.statusCode, 400);
    const body = JSON.parse(r.body);
    assert.equal(body.error.code, 'validation_failed');
    for (const s of [PII.name, PII.company, PII.phone, PII.email, 'not-an-email']) assert.ok(!r.body.includes(s), `echoed ${s}`);
    const bad = await post({ name: PII.name, email: 'nope', company: PII.company }, '203.0.113.31');
    assert.equal(bad.statusCode, 400);
    assert.ok(!bad.body.includes(PII.name));
  });

  test('it is rate-limited per IP (even with RATE_LIMIT=off)', async () => {
    const ip = '198.51.100.7';
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post({ ...PII, email: `x${i}@shop.example` }, ip)).statusCode);
    assert.deepEqual(codes, [202, 202, 202, 429, 429]);
    const r = await post({ ...PII, email: 'other@shop.example' }, '198.51.100.8');
    assert.equal(r.statusCode, 202, 'another IP is fine');
    const limited = await post(PII, ip);
    assert.equal(JSON.parse(limited.body).error.code, 'rate_limited');
  });

  test('services-page and contact-form leads store their source and name the service in the email', async () => {
    const r = await post({ ...PII, email: 'svc@shop.example', service: 'data-import' }, '203.0.113.60');
    assert.equal(r.statusCode, 202, r.body);
    const lead = (await t.superPool.query("SELECT id, source FROM hq_leads WHERE email = 'svc@shop.example'")).rows[0];
    assert.equal(lead.source, 'svc-data-import');
    const mail = (await t.superPool.query('SELECT subject, text_body FROM email_outbox WHERE text_body LIKE $1', [`%${lead.id}%`])).rows[0];
    assert.match(mail.subject, /^New lead \(Data import\): Big Shop Electric/);
    assert.match(mail.text_body, /asked about Data import \(services\)/);
    for (const s of [PII.phone, PII.name]) assert.ok(!mail.text_body.includes(s));

    assert.equal((await post({ ...PII, email: 'contact@shop.example', service: 'contact' }, '203.0.113.61')).statusCode, 202);
    assert.equal((await t.superPool.query("SELECT source FROM hq_leads WHERE email = 'contact@shop.example'")).rows[0].source, 'svc-contact');
    assert.equal((await post({ ...PII, email: 'plain@shop.example', service: '' }, '203.0.113.62')).statusCode, 202);
    assert.equal((await t.superPool.query("SELECT source FROM hq_leads WHERE email = 'plain@shop.example'")).rows[0].source, 'pricing');

    const bad = await post({ ...PII, email: 'bad@shop.example', service: 'free-pizza' }, '203.0.113.63');
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'validation_failed');
    assert.ok(!bad.body.includes('free-pizza'));
    assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM hq_leads WHERE email = 'bad@shop.example'")).rows[0].n, 0);
  });

  test('browsers need the CSRF header', async () => {
    const r = await app.inject({ method: 'POST', url: URL, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(PII), remoteAddress: '192.0.2.50' });
    assert.equal(r.statusCode, 403);
  });

  test('nothing the visitor typed reaches the logs', () => {
    const text = logs.text();
    for (const s of [PII.name, PII.email, PII.email.toLowerCase(), PII.phone, 'We run 30 electricians', 'Big Shop']) assert.ok(!text.includes(s), `log contains ${s}`);
  });

  test('HQ works the pipeline; changes are audited without contact details', async () => {
    const list = await call(app, { url: '/api/hq/leads', token: admin.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.byStage.new >= 5);
    const lead = list.body.data.at(-1);
    assert.equal(lead.company, PII.company);
    const r = await call(app, { method: 'PATCH', url: `/api/hq/leads/${lead.id}`, token: admin.token, body: { stage: 'contacted', notes: 'Called, demo Tuesday', nextStepAt: '2026-10-27', valueCents: 1200000, assignToMe: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stage, 'contacted');
    assert.equal(r.body.ownerId, admin.userId);
    assert.equal(r.body.nextStepAt, '2026-10-27');
    const ev = (await t.superPool.query("SELECT summary FROM audit_events WHERE action = 'hq.lead_update'")).rows[0];
    assert.match(ev.summary, /new -> contacted/);
    assert.ok(!ev.summary.includes(PII.company));
    const contacted = await call(app, { url: '/api/hq/leads?stage=contacted', token: admin.token });
    assert.deepEqual(contacted.body.data.map((l) => l.id), [lead.id]);
    assert.equal((await call(app, { url: '/api/hq/leads' })).status, 401);
  });
});
