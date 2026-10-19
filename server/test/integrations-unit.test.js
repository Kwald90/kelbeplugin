// Integrations without a database: phone numbers, opt-out words, signatures, lead mapping,
// sequence steps (checked against the PWA's own processSequences), message building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { toE164, optKeyword, twilioSignature, verifyTwilio } from '../src/integrations/twilio.js';
import { verifyFacebook, mapLead } from '../src/integrations/facebook.js';
import { verifyStripeEvent, stripeTestHeader } from '../src/integrations/stripe.js';
import { formEncode, scrub } from '../src/integrations/http.js';
import { dueSteps } from '../src/integrations/leads.js';
import { emailFooter, smsBody, textToHtml } from '../src/integrations/outbox.js';
import { PROVIDERS, senderAddress } from '../src/integrations/providers.js';
import { SECRETS } from '../src/services/secrets.js';
import { processSequences } from '../../electrical-app/js/modules/sequences.js';

test('Canadian and US numbers become E.164', () => {
  for (const [input, out] of [
    ['(403) 555-0199', '+14035550199'], ['403.555.0199', '+14035550199'], ['1-403-555-0199', '+14035550199'],
    ['+1 604 555 0101', '+16045550101'], ['+44 20 7946 0958', '+442079460958'], ['4035550199 ', '+14035550199'],
  ]) assert.equal(toE164(input), out, input);
  for (const bad of ['', '12345', '555-0199', '(103) 555-0199', '403 155 0199', '+1 403 155 0199', 'call me', null]) assert.equal(toE164(bad), null, String(bad));
});

test('opt-out and opt-in keywords are single words, any case', () => {
  for (const w of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'cancel', 'END', 'quit', 'STOPALL']) assert.equal(optKeyword(w), 'out', w);
  for (const w of ['START', 'yes', 'Unstop']) assert.equal(optKeyword(w), 'in', w);
  for (const w of ['please stop', 'STOP texting me', 'hello', '', null]) assert.equal(optKeyword(w), null, String(w));
});

test('Twilio signature matches the twilio-node test vector and rejects tampering', () => {
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  assert.equal(twilioSignature('12345', url, params), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  assert.equal(verifyTwilio('12345', url, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), true);
  assert.equal(verifyTwilio('12345', url, { ...params, Digits: '9999' }, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false);
  assert.equal(verifyTwilio('54321', url, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false);
  assert.equal(verifyTwilio(null, url, params, 'x'), false);
});

test('Facebook X-Hub-Signature-256 is HMAC-SHA256 of the exact body', () => {
  const secret = 'a'.repeat(32);
  const body = '{"object":"page","entry":[]}';
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyFacebook(body, sig, secret), true);
  assert.equal(verifyFacebook(body, sig.toUpperCase().replace('SHA256=', 'sha256='), secret), true, 'hex case does not matter');
  assert.equal(verifyFacebook(`${body} `, sig, secret), false);
  assert.equal(verifyFacebook(body, sig, 'b'.repeat(32)), false);
  assert.equal(verifyFacebook(body, 'sha1=abc', secret), false);
  assert.equal(verifyFacebook(body, undefined, secret), false);
});

test('Stripe events verify with the right secret only', () => {
  const secret = 'whsec_test_secret_value';
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: {} } });
  assert.equal(verifyStripeEvent(payload, stripeTestHeader(payload, secret), secret).id, 'evt_1');
  assert.equal(verifyStripeEvent(payload, stripeTestHeader(payload, 'whsec_other'), secret), null);
  assert.equal(verifyStripeEvent(payload, 't=1,v1=abc', secret), null);
  assert.equal(verifyStripeEvent(payload, stripeTestHeader(payload, secret), null), null);
});

test('Facebook lead fields map onto a leads record', () => {
  const m = mapLead({ id: '42', form_id: '7', field_data: [
    { name: 'first_name', values: ['Sam'] }, { name: 'last_name', values: ['Lee'] }, { name: 'email', values: ['sam@example.com'] },
    { name: 'phone_number', values: ['+14035550100'] }, { name: 'job_type', values: ['Hot tub hookup'] }, { name: 'postal_code', values: ['T2P 1J9'] },
  ] });
  assert.equal(m.contactName, 'Sam Lee');
  assert.equal(m.email, 'sam@example.com');
  assert.equal(m.phone, '+14035550100');
  assert.equal(m.title, 'Hot tub hookup');
  assert.match(m.notes, /Job type: Hot tub hookup\nPostal code: T2P 1J9/);
  assert.equal(m.facebook.leadId, '42');
  const bare = mapLead({ id: '43', field_data: [{ name: 'full_name', values: ['Robin'] }] });
  assert.equal(bare.title, 'Facebook lead: Robin');
  assert.equal(bare.email, null);
});

test('the server queues the same first steps as the PWA (modules/sequences.js)', () => {
  const now = new Date('2026-10-19T15:00:00Z');
  const sequence = { id: 's1', name: 'New lead', active: true, steps: [
    { dayOffset: 0, channel: 'email', subject: 'Hi {{name}}', body: '{{fullname}}, {{company}} here about {{job}}.' },
    { dayOffset: 0, channel: 'sms', subject: '', body: 'Text for {{name}}' },
    { dayOffset: 3, channel: 'email', subject: 'Later', body: 'Later' },
  ] };
  const lead = { id: 'l1', title: 'Basement wiring', contactName: 'Pat Customer', email: 'pat@example.com', phone: '403-555-0199', stage: 'new' };
  const enrolment = { id: 'e1', sequenceId: 's1', leadId: 'l1', startedAt: now.toISOString(), stepIndex: 0, status: 'active' };
  const server = dueSteps(enrolment, sequence, lead, null, 'Alpha Electric', now);

  // A tiny in-memory store with the PWA store's synchronous API.
  const data = { enrolments: [{ ...enrolment }], leads: [lead], sequences: [sequence], outbox: [], clients: [] };
  const store = {
    list: (c, pred) => (data[c] || []).filter((r) => !pred || pred(r)).map((r) => ({ ...r })),
    get: (c, id) => (data[c] || []).find((r) => r.id === id) || null,
    add: (c, rec) => { data[c].push({ ...rec, id: `x${data[c].length}` }); },
    update: (c, id, patch) => Object.assign(data[c].find((r) => r.id === id), patch),
    settings: () => ({ company: { name: 'Alpha Electric' } }),
  };
  processSequences(store, now);
  assert.deepEqual(server.messages, data.outbox.map(({ id, ...r }) => r));
  assert.equal(server.stepIndex, data.enrolments[0].stepIndex);
  assert.equal(server.status, data.enrolments[0].status);
  assert.equal(server.messages[0].body, 'Pat Customer, Alpha Electric here about Basement wiring.');
  assert.deepEqual(dueSteps(enrolment, { ...sequence, active: false }, lead, null, '', now).messages, [], 'paused sequences wait');
});

test('messages: CASL footer, STOP line, escaped HTML', () => {
  assert.match(emailFooter({ name: 'Alpha Electric', address: '1 Main St' }), /Alpha Electric · 1 Main St\nTo stop these emails, reply with "unsubscribe"\./);
  assert.equal(smsBody({ body: 'Hi' }), 'Hi\nReply STOP to opt out.');
  assert.equal(smsBody({ body: 'Reply STOP to end' }), 'Reply STOP to end');
  assert.equal(smsBody({ body: 'Invoice ready', kind: 'invoice' }), 'Invoice ready');
  const html = textToHtml('<script>alert(1)</script>\nPay: https://x.test/pay?a=1&b=2 "q"');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/x\.test\/pay\?a=1&amp;b=2">/);
  assert.match(html, /<br>/);
});

test('helpers: form encoding, scrubbing, sender addresses, registry', () => {
  assert.equal(formEncode({ a: 1, b: { c: [{ d: 'x y' }] }, skip: undefined }), 'a=1&b%5Bc%5D%5B0%5D%5Bd%5D=x%20y');
  const s = scrub('Invalid key sk_live_abcdefghijklmnop for pat@example.com at +1 (403) 555-0199');
  assert.ok(!s.includes('sk_live_abcdefghijklmnop') && !s.includes('pat@example.com') && !s.includes('555-0199'), s);
  assert.equal(senderAddress('TG Electrical <office@tg.ca>'), 'office@tg.ca');
  assert.equal(senderAddress('office@tg.ca'), 'office@tg.ca');
  assert.equal(senderAddress('<script>@x'), null);
  for (const p of Object.values(PROVIDERS)) for (const f of p.secrets) assert.ok(SECRETS[f.name], f.name);
  assert.equal(PROVIDERS.stripe.secrets[0].check('rk_live_51Habcdefghijklmn'), null);
  assert.ok(PROVIDERS.stripe.secrets[0].check('pk_live_51Habcdefghijklmn'));
  assert.ok(PROVIDERS.twilio.secrets[0].check('AC123'));
});
