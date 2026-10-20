// HQ Mail and SendGrid end to end against a real Postgres (npm run test:embedded). SendGrid is
// a fake fetch; nothing reaches the network. Covers: sending through the SendGrid provider,
// the Signed Event Webhook (valid, forged, replayed, stale), Inbound Parse (bad token, too
// big, MIME with attachments, threading), HQ-only access, attachment download headers, the
// support request endpoint, and that no addresses, subjects, bodies or tokens reach the logs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skip, createTestDatabase } from './support/db.js';
import { call, logCapture, ownerTenant, addMember, apiKey, testConfig } from './support/app.js';
import { hqUser } from './support/hq.js';
import { SAMPLE_MIME, keys, multipartBody, signWith } from './support/mail.js';
import { buildApp } from '../src/app.js';
import { setFetch } from '../src/integrations/http.js';
import { drainPlatformEmail, platformEmailConfig, recoverStuckEmail } from '../src/services/platform-email.js';
import { createMailStore } from '../src/email/storage.js';

const TOKEN = 'inb0und-T0ken-for-tests-6c1f0e2a9b';
const FROM = 'Fishtape <no-reply@fishtapehq.com>';
let t, app, logs, mailDir, k, other, admin, staff, owner, store;
let sendgrid; // { calls: [], next: Response factory }

function fakeSendgrid() {
  const s = { calls: [], status: 202, error: null, n: 0 };
  setFetch(async (url, init) => {
    if (!url.startsWith('https://api.sendgrid.com/')) throw new Error(`unexpected call to ${url}`);
    s.calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (s.status !== 202) return Response.json({ errors: [{ message: s.error || 'error' }] }, { status: s.status });
    s.n++;
    return new Response(null, { status: 202, headers: { 'x-message-id': `sgmsg${s.n}` } });
  });
  return s;
}

const drainCfg = () => ({ provider: 'sendgrid', apiKey: 'SG.test-key', from: FROM, appEnv: 'test', trackOpens: false, store });
const drain = () => drainPlatformEmail(t.db, { cfg: drainCfg() });

async function signedEvents(events, { key = k, at = Date.now(), body } = {}) {
  const raw = body ?? JSON.stringify(events);
  const ts = String(Math.floor(at / 1000));
  return call(app, {
    method: 'POST', url: '/api/v1/webhooks/sendgrid/events', csrf: false, body: raw,
    headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-signature': signWith(key.privateKey, ts, raw), 'x-twilio-email-event-webhook-timestamp': ts },
  });
}

async function inbound(mime, extra = {}, token = TOKEN) {
  const { body, contentType } = multipartBody({ email: mime, envelope: JSON.stringify({ to: ['support@inbox.fishtapehq.com'], from: 'bob@example.com' }), spam_score: '0.4', SPF: 'pass', dkim: '{@example.com : pass}', ...extra });
  return call(app, { method: 'POST', url: `/api/v1/webhooks/sendgrid/inbound/${token}`, csrf: false, body, headers: { 'content-type': contentType } });
}

const hq = (method, url, body, token = admin.token) => call(app, { method, url, token, body });
const list = async (mailboxId, folder, extra = {}) => (await hq('POST', '/api/hq/mail/list', { mailboxId, folder, ...extra })).body;
const outboxRow = async (id) => (await t.superPool.query('SELECT * FROM email_outbox WHERE id = $1', [id])).rows[0];

function mime({ from = 'Bob Builder <bob@example.com>', to = 'support@inbox.fishtapehq.com', subject, messageId, inReplyTo, references, body = 'Hello' }) {
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, messageId ? `Message-ID: <${messageId}>` : null,
    inReplyTo ? `In-Reply-To: <${inReplyTo}>` : null, references ? `References: ${references}` : null,
    'Date: Mon, 19 Oct 2026 12:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].filter((x) => x !== null).join('\r\n');
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('mail');
  mailDir = mkdtempSync(join(tmpdir(), 'ft-mail-test-'));
  k = keys();
  other = keys();
  const config = testConfig({});
  config.hq = { tlsCheck: false };
  config.mail = {
    mailDir, inboundToken: TOKEN, eventPublicKey: k.publicB64, from: FROM, provider: 'sendgrid', sendgridApiKey: 'SG.test-key',
    inboundMaxBytes: 2 * 1024 * 1024, supportPerHour: 2, supportPerDay: 5,
    fetchImage: async () => ({ contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') }),
  };
  const captured = logCapture();
  logs = captured;
  app = await buildApp({ config, db: t.db, oidcProviders: {}, logStream: captured.stream });
  await app.ready();
  store = createMailStore({ mailDir, appEnv: 'test' });
  admin = await hqUser(t, app, 'hq_admin');
  staff = await hqUser(t, app, 'hq_staff');
  owner = await ownerTenant(t, app, 'Sparks Electric');
  sendgrid = fakeSendgrid();
});

after(async () => {
  setFetch(null);
  await app?.close();
  await t?.close();
  if (mailDir) rmSync(mailDir, { recursive: true, force: true });
});

// ---- sending ---------------------------------------------------------------------------------

test('EMAIL_PROVIDER: SendGrid when its key is set, Resend when asked for or when only Resend is set', { skip }, () => {
  assert.equal(platformEmailConfig({ SENDGRID_API_KEY: 'SG.a', EMAIL_FROM: FROM }).provider, 'sendgrid');
  assert.equal(platformEmailConfig({ SENDGRID_API_KEY: 'SG.a', EMAIL_FROM: FROM }).apiKey, 'SG.a');
  assert.equal(platformEmailConfig({ RESEND_API_KEY: 're_a', EMAIL_FROM: FROM }).provider, 'resend');
  assert.equal(platformEmailConfig({ SENDGRID_API_KEY: 'SG.a', RESEND_API_KEY: 're_a', EMAIL_PROVIDER: 'resend' }).apiKey, 're_a');
  assert.equal(platformEmailConfig({ EMAIL_PROVIDER: 'sendgrid' }).apiKey, '');
});

test('platform email goes out through SendGrid Mail Send with the outbox id in custom_args', { skip }, async () => {
  const id = (await t.superPool.query("INSERT INTO email_outbox (to_address, subject, text_body, template) VALUES ('reset@example.com', 'Reset your password', 'link', 'password-reset') RETURNING id")).rows[0].id;
  sendgrid.calls.length = 0;
  const r = await drain();
  assert.equal(r.sent, 1);
  const c = sendgrid.calls[0];
  assert.equal(c.url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(c.headers.authorization, 'Bearer SG.test-key');
  assert.deepEqual(c.body.from, { email: 'no-reply@fishtapehq.com', name: 'Fishtape' });
  assert.deepEqual(c.body.personalizations[0].to, [{ email: 'reset@example.com' }]);
  assert.deepEqual(c.body.personalizations[0].custom_args, { ft_outbox_id: id, ft_env: 'test' });
  assert.deepEqual(c.body.categories, ['fishtape', 'password-reset']);
  assert.equal(c.body.tracking_settings.click_tracking.enable, false, 'reset links are never rewritten');
  const row = await outboxRow(id);
  assert.equal(row.status, 'sent');
  assert.equal(row.provider, 'sendgrid');
  assert.equal(row.provider_message_id, 'sgmsg1');
  assert.equal((await drain()).sent, 0, 'sent once');
});

test('SendGrid refusals: an unverified sender fails at once, rate limiting is retried', { skip }, async () => {
  const a = (await t.superPool.query("INSERT INTO email_outbox (to_address, subject, text_body) VALUES ('a@example.com', 's', 'b') RETURNING id")).rows[0].id;
  sendgrid.status = 403; sendgrid.error = 'The from address does not match a verified Sender Identity.';
  await drain();
  let row = await outboxRow(a);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /Sender Authentication/);
  const b = (await t.superPool.query("INSERT INTO email_outbox (to_address, subject, text_body) VALUES ('b@example.com', 's', 'b') RETURNING id")).rows[0].id;
  sendgrid.status = 429;
  await drain();
  row = await outboxRow(b);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  sendgrid.status = 202;
  await drain();
  assert.equal((await outboxRow(b)).status, 'sent');
});

test('a worker that died mid-send: rows SendGrid reported count as sent, the rest are queued again', { skip }, async () => {
  const ids = (await t.superPool.query(
    `INSERT INTO email_outbox (to_address, subject, text_body, status, sending_at, delivery_status) VALUES
       ('x1@example.com', 's', 'b', 'sending', now() - interval '20 minutes', 'delivered'),
       ('x2@example.com', 's', 'b', 'sending', now() - interval '20 minutes', NULL),
       ('x3@example.com', 's', 'b', 'sending', now() - interval '1 minute', NULL) RETURNING id`)).rows.map((r) => r.id);
  assert.equal(await recoverStuckEmail(t.db), 2);
  assert.deepEqual((await Promise.all(ids.map(outboxRow))).map((r) => r.status), ['sent', 'queued', 'sending']);
  await t.superPool.query('DELETE FROM email_outbox WHERE id = ANY($1)', [ids]);
});

// ---- delivery events --------------------------------------------------------------------------

test('signed delivery events update the outbox; forged, unsigned, altered and stale requests are refused', { skip }, async () => {
  const id = (await t.superPool.query("INSERT INTO email_outbox (to_address, subject, text_body, status, sent_at) VALUES ('d@example.com', 's', 'b', 'sent', now()) RETURNING id")).rows[0].id;
  const events = [
    { email: 'd@example.com', event: 'processed', sg_event_id: 'ev-p-1', timestamp: 1760870000, ft_outbox_id: id, ft_env: 'test' },
    { email: 'd@example.com', event: 'delivered', sg_event_id: 'ev-d-1', timestamp: 1760870005, ft_outbox_id: id, ft_env: 'test', response: '250 OK' },
  ];
  const body = JSON.stringify(events);
  const forged = await signedEvents(events, { key: other });
  assert.equal(forged.status, 403);
  const unsigned = await call(app, { method: 'POST', url: '/api/v1/webhooks/sendgrid/events', csrf: false, body, headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 403);
  const stale = await signedEvents(events, { at: Date.now() - 3600_000 });
  assert.equal(stale.status, 403);
  const ts = String(Math.floor(Date.now() / 1000));
  const altered = await call(app, { method: 'POST', url: '/api/v1/webhooks/sendgrid/events', csrf: false, body: body.replace('delivered', 'dropped'),
    headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-signature': signWith(k.privateKey, ts, body), 'x-twilio-email-event-webhook-timestamp': ts } });
  assert.equal(altered.status, 403);
  assert.equal((await outboxRow(id)).delivery_status, null, 'nothing applied yet');

  const ok = await signedEvents(events);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { received: 2, applied: 2, duplicates: 0 });
  assert.equal((await outboxRow(id)).delivery_status, 'delivered');

  const replay = await signedEvents(events); // SendGrid retry, or someone replaying captured events with a fresh signature
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicates, 2);
  assert.equal(replay.body.applied, 0);
  assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM email_events WHERE outbox_id = $1', [id])).rows[0].n, 2);

  const late = await signedEvents([{ event: 'deferred', sg_event_id: 'ev-late', timestamp: 1760869999, ft_outbox_id: id, ft_env: 'test', reason: 'try later', attempt: '2' }]);
  assert.equal(late.status, 200);
  assert.equal((await outboxRow(id)).delivery_status, 'delivered', 'an older, lower event does not undo delivery');
  const otherEnv = await signedEvents([{ event: 'bounce', sg_event_id: 'ev-prod', ft_outbox_id: id, ft_env: 'production' }]);
  assert.equal(otherEnv.status, 200);
  assert.equal((await outboxRow(id)).status, 'sent', 'events from another environment are ignored');
});

test('a bounce marks the email failed with the reason, and HQ lists it under Not sent', { skip }, async () => {
  const id = (await t.superPool.query("INSERT INTO email_outbox (to_address, subject, text_body, status, sent_at, template) VALUES ('nobody@example.com', 'Invitation', 'b', 'sent', now(), 'invite') RETURNING id")).rows[0].id;
  const r = await signedEvents([{ email: 'nobody@example.com', event: 'bounce', type: 'bounce', status: '5.1.1', reason: '550 5.1.1 <nobody@example.com>: user unknown', sg_event_id: 'ev-b-1', timestamp: 1760870100, ft_outbox_id: id, ft_env: 'test', bounce_classification: 'Invalid Address' }]);
  assert.equal(r.status, 200);
  const row = await outboxRow(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.delivery_status, 'bounce');
  assert.equal(row.last_error, 'Bounced (5.1.1): 550 5.1.1 <[email]>: user unknown');
  const notSent = await list('system', 'not_sent');
  const item = notSent.items.find((x) => x.id === id);
  assert.ok(item, 'listed under Not sent');
  assert.equal(item.deliveryStatus, 'bounce');
  assert.match(item.deliveryDetail, /user unknown/);
  const detail = await hq('GET', `/api/hq/mail/system/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.events[0].event, 'bounce');
  assert.ok(!('text' in detail.body) && !('body' in detail.body), 'system email bodies are never shown');
});

// ---- inbound -----------------------------------------------------------------------------------

test('inbound: a wrong token is 404 and stores nothing; too big is 413; without raw MIME is 400', { skip }, async () => {
  const before = (await t.superPool.query('SELECT count(*)::int AS n FROM mail_inbound')).rows[0].n;
  assert.equal((await inbound(SAMPLE_MIME, {}, 'wrong-token')).status, 404);
  assert.equal((await inbound(SAMPLE_MIME, {}, `${TOKEN}x`)).status, 404);
  const big = await inbound(`${SAMPLE_MIME}\r\n${'x'.repeat(3 * 1024 * 1024)}`);
  assert.equal(big.status, 413);
  const { body, contentType } = multipartBody({ text: 'parsed mode', from: 'bob@example.com' });
  const parsed = await call(app, { method: 'POST', url: `/api/v1/webhooks/sendgrid/inbound/${TOKEN}`, csrf: false, body, headers: { 'content-type': contentType } });
  assert.equal(parsed.status, 400);
  assert.equal(parsed.body.error.code, 'raw_mime_required');
  assert.equal((await t.superPool.query('SELECT count(*)::int AS n FROM mail_inbound')).rows[0].n, before);
});

let inboxMsg; // the sample message once filed
let support; // the Support mailbox

test('inbound MIME with attachments is filed into the Support inbox, files on disk, HTML sanitized', { skip }, async () => {
  const r = await inbound(SAMPLE_MIME);
  assert.equal(r.status, 200);
  const drop = (await t.superPool.query("SELECT payload FROM mail_inbound WHERE source = 'parse' ORDER BY id DESC LIMIT 1")).rows[0].payload;
  assert.equal(drop.attachments.length, 3);
  const files = readdirSync(mailDir, { recursive: true }).filter((f) => /[a-f0-9]{32}$/.test(String(f)));
  assert.equal(files.length, 4, 'three attachments plus the original .eml');

  const ov = await hq('GET', '/api/hq/mail/overview');
  assert.equal(ov.status, 200);
  support = ov.body.mailboxes.find((m) => m.address === 'support@inbox.fishtapehq.com');
  assert.equal(support.counts.inboxUnread, 1);
  assert.equal(ov.body.inbound.pending, 0, 'the drop box is empty after filing');
  const items = (await list(support.id, 'inbox')).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].subject, 'Panel question ⚡');
  assert.equal(items[0].hasAttachments, true);
  assert.equal(items[0].read, false);
  inboxMsg = items[0];

  const m = (await hq('GET', `/api/hq/mail/messages/${inboxMsg.id}`)).body;
  assert.deepEqual(m.from, { name: 'Bob Builder', address: 'bob@example.com' });
  assert.equal(m.attachments.length, 3);
  assert.equal(m.attachments.find((a) => a.filename === 'logo.png').inline, true);
  assert.match(m.render.html, /<img src="data:image\/png;base64,/, 'cid: image inlined from the message');
  assert.ok(!/onclick|tracker\.example/.test(m.render.html));
  assert.equal(m.render.trackers, 1);
  assert.equal(m.auth.spf, 'pass');
  assert.equal(m.rawAvailable, true);
});

test('attachment downloads: always attachment, nosniff, sandboxed CSP, inert content type', { skip }, async () => {
  const m = (await hq('GET', `/api/hq/mail/messages/${inboxMsg.id}`)).body;
  const pdf = m.attachments.find((a) => a.filename === '_quote.pdf');
  const r = await call(app, { url: `/api/hq/mail/attachments/${pdf.id}`, token: staff.token });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="_quote.pdf"; filename*=UTF-8\'\'_quote.pdf');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /default-src 'none'; sandbox/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.raw.rawPayload.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  const html = m.attachments.find((a) => a.filename === 'evil.html');
  const h = await call(app, { url: `/api/hq/mail/attachments/${html.id}`, token: staff.token });
  assert.equal(h.headers['content-type'], 'application/octet-stream', 'HTML never comes back as HTML');
  assert.match(h.headers['content-disposition'], /^attachment;/);
  const eml = await call(app, { url: `/api/hq/mail/messages/${inboxMsg.id}/raw`, token: staff.token });
  assert.equal(eml.headers['content-type'], 'application/octet-stream');
  assert.match(eml.headers['content-disposition'], /filename="message\.eml"/);
  const img = await call(app, { url: `/api/hq/mail/messages/${inboxMsg.id}/images/0`, token: staff.token });
  assert.equal(img.status, 200, 'remote image 0 through the proxy');
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal((await call(app, { url: `/api/hq/mail/messages/${inboxMsg.id}/images/7`, token: staff.token })).status, 404);
});

test('search: free text, from, to, subject and has-attachment filters', { skip }, async () => {
  assert.equal((await list(support.id, 'inbox', { q: 'breaker' })).items.length, 1);
  assert.equal((await list(support.id, 'inbox', { q: 'nothing-like-this' })).items.length, 0);
  assert.equal((await list(support.id, 'inbox', { from: 'bob' })).items.length, 1);
  assert.equal((await list(support.id, 'inbox', { from: 'alice' })).items.length, 0);
  assert.equal((await list(support.id, 'inbox', { to: 'carol' })).items.length, 1);
  assert.equal((await list(support.id, 'inbox', { subject: 'panel' })).items.length, 1);
  assert.equal((await list(support.id, 'inbox', { hasAttachment: true })).items.length, 1);
  assert.equal((await list(support.id, 'inbox', { from: '%' })).items.length, 0, 'LIKE wildcards are literal');
});

let sentReply;
test('reply from HQ: queued with threading headers and attachments, sent through SendGrid, delivery shown in the reading pane', { skip }, async () => {
  const up = await hq('POST', '/api/hq/mail/uploads', { filename: 'wiring.txt', contentType: 'text/plain', data: Buffer.from('L1 L2 N G').toString('base64') });
  assert.equal(up.status, 201);
  const r = await hq('POST', '/api/hq/mail/send', {
    mailboxId: support.id, to: ['Bob Builder <bob@example.com>'], subject: 'RE: Panel question ⚡', replyToId: inboxMsg.id,
    html: '<p>Check the <b>neutral</b>.</p><script>alert(1)</script><p onclick="x()">Thanks</p>', attachmentIds: [up.body.id],
  });
  assert.equal(r.status, 202);
  sentReply = r.body.id;
  const ob = (await t.superPool.query('SELECT * FROM email_outbox WHERE mail_message_id = $1', [sentReply])).rows[0];
  assert.equal(ob.status, 'queued');
  assert.equal(ob.from_address, '"Fishtape Support" <support@fishtapehq.com>');
  assert.equal(ob.reply_to, '"Fishtape Support" <support@inbox.fishtapehq.com>');
  assert.equal(ob.headers['In-Reply-To'], '<msg-1@example.com>');
  assert.equal(ob.headers.References, '<root@fishtapehq.com> <out-1@fishtapehq.com> <msg-1@example.com>');
  assert.ok(!/script|onclick/.test(ob.html_body), 'outgoing HTML is sanitized too');
  assert.match(ob.text_body, /Check the neutral/);
  assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM jobs_queue WHERE dedupe_key = 'platform_email:now'")).rows[0].n, 1, 'the worker is nudged');

  sendgrid.calls.length = 0;
  assert.equal((await drain()).sent, 1);
  const sg = sendgrid.calls[0].body;
  assert.deepEqual(sg.from, { email: 'support@fishtapehq.com', name: 'Fishtape Support' });
  assert.deepEqual(sg.reply_to, { email: 'support@inbox.fishtapehq.com', name: 'Fishtape Support' });
  assert.equal(sg.headers['In-Reply-To'], '<msg-1@example.com>');
  assert.match(sg.headers['Message-ID'], /^<[0-9a-f-]{36}@fishtapehq\.com>$/);
  assert.deepEqual(sg.attachments, [{ content: Buffer.from('L1 L2 N G').toString('base64'), filename: 'wiring.txt', type: 'text/plain', disposition: 'attachment' }]);
  assert.deepEqual(sg.categories, ['fishtape', 'hq-mail']);

  await signedEvents([{ email: 'bob@example.com', event: 'delivered', sg_event_id: 'ev-reply-d', timestamp: 1760871000, ft_outbox_id: ob.id, ft_env: 'test', response: '250 OK' }]);
  const m = (await hq('GET', `/api/hq/mail/messages/${sentReply}`)).body;
  assert.equal(m.threadId, inboxMsg.threadId, 'the reply joins the conversation');
  assert.equal(m.events[0].event, 'delivered');
  assert.equal(m.delivery.deliveryStatus, 'delivered');
  const sent = await list(support.id, 'sent');
  assert.ok(sent.items.some((x) => x.id === sentReply));
  assert.equal(m.thread.length, 2);
});

test('threading: replies by In-Reply-To and by subject join the conversation; a duplicate delivery is filed once', { skip }, async () => {
  const ob = (await t.superPool.query('SELECT headers FROM email_outbox WHERE mail_message_id = $1', [sentReply])).rows[0];
  const ourId = ob.headers['Message-ID'].slice(1, -1);
  assert.equal((await inbound(mime({ subject: 'Re: Panel question ⚡', messageId: 'msg-2@example.com', inReplyTo: ourId, body: 'That fixed it' }))).status, 200);
  assert.equal((await inbound(mime({ subject: 'RE: RE: panel question ⚡', messageId: 'msg-3@example.com', body: 'One more thing' }))).status, 200);
  assert.equal((await inbound(mime({ subject: 'Re: Panel question ⚡', messageId: 'msg-2@example.com', inReplyTo: ourId, body: 'That fixed it' }))).status, 200);
  assert.equal((await inbound(mime({ from: 'stranger@example.net', subject: 'Panel question ⚡', messageId: 'msg-4@example.net', body: 'Unrelated' }))).status, 200);
  await hq('GET', '/api/hq/mail/overview');
  const thread = (await t.superPool.query('SELECT message_id FROM mail_messages WHERE thread_id = $1 ORDER BY received_at, message_id', [inboxMsg.threadId])).rows.map((r) => r.message_id);
  assert.equal(thread.length, 4, `thread: ${thread.join(', ')}`);
  assert.ok(thread.includes('msg-2@example.com') && thread.includes('msg-3@example.com'));
  assert.equal((await t.superPool.query("SELECT count(*)::int AS n FROM mail_messages WHERE message_id = 'msg-2@example.com'")).rows[0].n, 1, 'filed once');
  const stranger = (await t.superPool.query("SELECT thread_id FROM mail_messages WHERE message_id = 'msg-4@example.net'")).rows[0];
  assert.notEqual(stranger.thread_id, inboxMsg.threadId, 'same subject from someone else starts a new conversation');
  const grouped = await list(support.id, 'inbox');
  const conv = grouped.items.find((x) => x.threadId === inboxMsg.threadId);
  assert.equal(conv.threadCount, 3, 'three inbox messages in the conversation');
  assert.equal(conv.threadUnread, 3);
});

test('routing: envelope recipient picks the mailbox, forwarded aliases too, and a high spam score goes to Junk', { skip }, async () => {
  const ov = (await hq('GET', '/api/hq/mail/overview')).body;
  const sales = ov.mailboxes.find((m) => m.address === 'sales@inbox.fishtapehq.com');
  const tg = await hq('POST', '/api/hq/mail/mailboxes', { name: 'TG Electrical', address: 'tg@inbox.fishtapehq.com', aliases: ['info@tgelectrical.ca'], fromName: 'TG Electrical', fromAddress: 'info@tgelectrical.ca' });
  assert.equal(tg.status, 201);
  assert.equal((await hq('POST', '/api/hq/mail/mailboxes', { name: 'x', address: 'tg@inbox.fishtapehq.com' }, staff.token)).status, 403, 'staff cannot add mailboxes');
  await inbound(mime({ to: 'someone@else.example', subject: 'Pricing', messageId: 'sales-1@example.com' }), { envelope: JSON.stringify({ to: ['sales@inbox.fishtapehq.com'] }) });
  await inbound(mime({ to: 'info@tgelectrical.ca', subject: 'Quote for a basement', messageId: 'fwd-1@example.com' }), { envelope: JSON.stringify({ to: ['info@tgelectrical.ca'] }) });
  await inbound(mime({ subject: 'You won', messageId: 'spam-1@example.com' }), { spam_score: '9.8' });
  await hq('GET', '/api/hq/mail/overview');
  assert.equal((await list(sales.id, 'inbox')).items[0].subject, 'Pricing');
  assert.equal((await list(tg.body.id, 'inbox')).items[0].subject, 'Quote for a basement');
  const junk = await list(support.id, 'junk');
  assert.equal(junk.items[0].subject, 'You won');
  assert.equal(junk.items[0].spam, true);
});

test('HQ actions: read, flag, archive, junk, delete, restore, assign', { skip }, async () => {
  const id = inboxMsg.id;
  assert.equal((await hq('PATCH', '/api/hq/mail/messages', { ids: [id], read: true }, staff.token)).status, 200);
  assert.equal((await hq('PATCH', '/api/hq/mail/messages', { ids: [id], flagged: true })).status, 200);
  assert.equal((await hq('PATCH', '/api/hq/mail/messages', { ids: [id], assignedTo: staff.userId })).status, 200);
  let m = (await hq('GET', `/api/hq/mail/messages/${id}`)).body;
  assert.equal(m.read, true);
  assert.equal(m.flagged, true);
  assert.equal(m.assignedTo, staff.userId);
  assert.equal((await hq('PATCH', '/api/hq/mail/messages', { ids: [id], assignedTo: owner.userId })).status, 400, 'only HQ staff can be assigned');
  await hq('PATCH', '/api/hq/mail/messages', { ids: [id], folder: 'trash' });
  assert.equal((await hq('GET', `/api/hq/mail/messages/${id}`)).body.folder, 'trash');
  await hq('PATCH', '/api/hq/mail/messages', { ids: [id], folder: 'restore' });
  m = (await hq('GET', `/api/hq/mail/messages/${id}`)).body;
  assert.equal(m.folder, 'inbox');
  await hq('PATCH', '/api/hq/mail/messages', { ids: [id], folder: 'archive' });
  assert.equal((await hq('GET', `/api/hq/mail/messages/${id}`)).body.folder, 'archive');
  assert.equal((await hq('DELETE', '/api/hq/mail/messages', { ids: [id] })).body.deleted, 0, 'only Deleted items can be deleted for good');
  await hq('PATCH', '/api/hq/mail/messages', { ids: [id], folder: 'inbox' });
});

test('Not sent: a bounced HQ message shows the reason; a queued one can be taken back to Drafts', { skip }, async () => {
  const r = await hq('POST', '/api/hq/mail/send', { mailboxId: support.id, to: ['typo@exmaple.com'], subject: 'Your account', html: '<p>Hello</p>' });
  assert.equal(r.status, 202);
  await drain();
  const ob = (await t.superPool.query('SELECT id FROM email_outbox WHERE mail_message_id = $1', [r.body.id])).rows[0];
  await signedEvents([{ email: 'typo@exmaple.com', event: 'bounce', type: 'bounce', status: '5.1.2', reason: '550 5.1.2 Host unknown', sg_event_id: 'ev-hq-b', timestamp: 1760872000, ft_outbox_id: ob.id, ft_env: 'test' }]);
  const notSent = await list(support.id, 'not_sent');
  const item = notSent.items.find((x) => x.id === r.body.id);
  assert.ok(item, 'listed under Not sent');
  assert.match(item.deliveryDetail, /Bounced \(5\.1\.2\): 550 5\.1\.2 Host unknown/);
  const ov = (await hq('GET', '/api/hq/mail/overview')).body;
  assert.equal(ov.mailboxes.find((m) => m.id === support.id).counts.notSent, 1);

  const q = await hq('POST', '/api/hq/mail/send', { mailboxId: support.id, to: ['later@example.com'], subject: 'Wait', html: '<p>x</p>' });
  assert.equal((await list(support.id, 'outbox')).items.some((x) => x.id === q.body.id), true, 'queued mail is in the Outbox');
  const back = await hq('POST', `/api/hq/mail/messages/${q.body.id}/to-drafts`);
  assert.equal(back.status, 200);
  const cancelled = (await t.superPool.query('SELECT status, last_error FROM email_outbox WHERE mail_message_id = $1', [q.body.id])).rows[0];
  assert.deepEqual(cancelled, { status: 'failed', last_error: 'Cancelled in HQ Mail' });
  assert.equal((await list(support.id, 'drafts')).items.some((x) => x.id === q.body.id), true);
  sendgrid.calls.length = 0;
  await drain();
  assert.ok(!sendgrid.calls.some((c) => c.body.personalizations[0].to[0].email === 'later@example.com'), 'a cancelled message is not sent');
});

// ---- access ------------------------------------------------------------------------------------

test('HQ only: the app role cannot read mail, writes to the drop boxes only outside a company, and companies get 403', { skip }, async () => {
  for (const table of ['mail_messages', 'mail_mailboxes', 'mail_threads', 'mail_attachments', 'mail_settings', 'mail_inbound', 'email_events']) {
    await assert.rejects(t.appPool.query(`SELECT * FROM ${table} LIMIT 1`), (e) => e.code === '42501', `${table} is not readable by fishtape_app`);
  }
  await assert.rejects(t.appPool.query("UPDATE mail_inbound SET attempts = 0"), (e) => e.code === '42501');
  await assert.rejects(t.appPool.query("DELETE FROM email_events"), (e) => e.code === '42501');
  await t.db.tx((c) => c.query("INSERT INTO mail_inbound (source, payload) VALUES ('parse', '{}')"));
  await assert.rejects(t.db.withTenant({ tenantId: owner.tenantId }, (tx) => tx.query("INSERT INTO mail_inbound (source, payload) VALUES ('parse', '{}')")),
    (e) => e.code === '42501', 'refused inside a company context');
  await t.superPool.query("DELETE FROM mail_inbound WHERE payload = '{}'::jsonb");
  const { rows } = await t.superPool.query(
    "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.relname IN ('mail_messages','mail_mailboxes','mail_threads','mail_attachments','mail_settings','mail_inbound','email_events')");
  assert.equal(rows.length, 7);
  for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} RLS forced`);

  for (const [method, url, body] of [['GET', '/api/hq/mail/overview'], ['POST', '/api/hq/mail/list', { mailboxId: support.id, folder: 'inbox' }], ['GET', `/api/hq/mail/messages/${inboxMsg.id}`]]) {
    const r = await call(app, { method, url, token: owner.token, body });
    assert.equal(r.status, 403, `${method} ${url} for a company owner`);
  }
  assert.equal((await call(app, { url: '/api/hq/mail/overview' })).status, 401);
  assert.equal((await hq('PUT', '/api/hq/mail/settings', { retentionDays: 365 }, staff.token)).status, 403, 'staff cannot change retention');
  const s = await hq('PUT', '/api/hq/mail/settings', { retentionDays: 365, spamThreshold: 6 });
  assert.equal(s.status, 200);
  assert.equal(s.body.retentionDays, 365);
});

// ---- support requests --------------------------------------------------------------------------

test('support request: filed into the HQ Support mailbox with company, user and app version; the user gets a confirmation', { skip }, async () => {
  const member = await addMember(t, app, owner.tenantId, { role: 'office' });
  const shot = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;
  const r = await call(app, { method: 'POST', url: '/api/v1/support/requests', token: member.token,
    body: { subject: 'Invoice PDF is blank', message: 'When I print invoice 1042 the page is blank.', category: 'problem', appVersion: '1.4.2', page: '#/invoices', screenshot: shot } });
  assert.equal(r.status, 201);
  assert.match(r.body.reference, /^FT-[A-Z2-9]{6}$/);
  assert.equal(r.body.confirmationEmailed, true);
  const conf = (await t.superPool.query("SELECT * FROM email_outbox WHERE template = 'support-confirmation'")).rows[0];
  assert.equal(conf.to_address, member.email);
  assert.equal(conf.reply_to, 'support@inbox.fishtapehq.com');
  assert.match(conf.subject, new RegExp(r.body.reference));
  await hq('GET', '/api/hq/mail/overview');
  const found = (await list(support.id, 'inbox', { subject: r.body.reference })).items[0];
  assert.ok(found, 'filed in Support');
  const m = (await hq('GET', `/api/hq/mail/messages/${found.id}`)).body;
  assert.equal(m.source, 'support');
  assert.equal(m.meta.tenantName, 'Sparks Electric');
  assert.equal(m.meta.appVersion, '1.4.2');
  assert.equal(m.replyTo[0].address, member.email);
  assert.equal(m.attachments[0].filename, 'screenshot.png');
  const audit = (await t.superPool.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'support.request'", [owner.tenantId])).rows;
  assert.equal(audit.length, 1);

  assert.equal((await call(app, { method: 'POST', url: '/api/v1/support/requests', token: member.token, body: { subject: 'Two', message: 'x' } })).status, 201);
  const limited = await call(app, { method: 'POST', url: '/api/v1/support/requests', token: member.token, body: { subject: 'Three', message: 'x' } });
  assert.equal(limited.status, 429);
  const key = await apiKey(app, owner.token, ['jobs:read']);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/support/requests', token: key, body: { subject: 'x', message: 'y' } })).status, 403);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/support/requests', body: { subject: 'x', message: 'y' } })).status, 401);
  const bad = await call(app, { method: 'POST', url: '/api/v1/support/requests', token: owner.token, body: { subject: 'x', message: 'y', screenshot: 'data:text/html;base64,PGI+' } });
  assert.equal(bad.status, 400);
});

test('no addresses, subjects, bodies or tokens in the logs', { skip }, () => {
  const text = logs.text();
  assert.ok(text.length > 0);
  for (const s of ['bob@example.com', 'carol@example.com', 'breaker trips', 'Panel question', 'That fixed it', TOKEN, 'Invoice PDF is blank', 'invoice 1042',
    'typo@exmaple.com', 'reset@example.com', 'nobody@example.com', 'user unknown', 'L1 L2 N G', 'info@tgelectrical.ca']) {
    assert.ok(!text.includes(s), `logs contain "${s}"`);
  }
});
