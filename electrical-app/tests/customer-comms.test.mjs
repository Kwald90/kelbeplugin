// Run: node --test electrical-app/tests/
// The pure helpers behind the two customer-communication flows (js/lib/customer-comms.js): when an
// ETA / review email should fire (the state transition), how settings are normalised, and the
// rendered subject/body. The server (services/customer-comms.js) uses the same functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commsSettings, cleanUrl, shouldSendEta, shouldSendReview, etaEmail, reviewEmail, DONE_STATUSES,
} from '../js/lib/customer-comms.js';

test('commsSettings fills safe defaults and keeps a clean https review url', () => {
  const d = commsSettings({});
  assert.deepEqual(d, { eta: { on: false, message: '' }, review: { on: false, url: '', message: '' }, replyTo: '' });
  const s = commsSettings({ notifications: {
    eta: { on: true, message: '  hi  ' },
    review: { on: true, url: 'http://ex.com/r', message: 'thanks' },
    replyTo: ' office@x.ca ',
  } });
  assert.equal(s.eta.on, true);
  assert.equal(s.eta.message, '  hi  '); // trimming is left to the caller; stored value preserved
  assert.equal(s.review.url, 'http://ex.com/r');
  assert.equal(s.replyTo, 'office@x.ca');
});

test('cleanUrl only allows http(s), drops anything else', () => {
  assert.equal(cleanUrl('https://g.page/r/x'), 'https://g.page/r/x');
  assert.equal(cleanUrl('http://x.ca'), 'http://x.ca');
  assert.equal(cleanUrl('javascript:alert(1)'), '');
  assert.equal(cleanUrl('g.page/r/x'), '');
  assert.equal(cleanUrl(''), '');
  assert.equal(cleanUrl(null), '');
});

test('shouldSendEta fires only on the transition into TRAVEL with a destination job', () => {
  // fresh travel entry
  assert.equal(shouldSendEta(null, { kind: 'travel', jobId: 'j1' }), true);
  // work -> travel (switched in place)
  assert.equal(shouldSendEta({ kind: 'work', jobId: 'j1' }, { kind: 'travel', jobId: 'j1' }), true);
  // already travelling (a later location-fix update): no re-send
  assert.equal(shouldSendEta({ kind: 'travel', jobId: 'j1' }, { kind: 'travel', jobId: 'j1' }), false);
  // travel with no known destination: cannot email a customer
  assert.equal(shouldSendEta(null, { kind: 'travel', jobId: null }), false);
  // not travel
  assert.equal(shouldSendEta(null, { kind: 'work', jobId: 'j1' }), false);
  assert.equal(shouldSendEta(null, null), false);
});

test('shouldSendReview fires only on the transition into a closed status', () => {
  assert.ok(DONE_STATUSES.has('complete') && DONE_STATUSES.has('invoiced'));
  assert.equal(shouldSendReview({ status: 'in-progress' }, { status: 'complete' }), true);
  assert.equal(shouldSendReview(null, { status: 'complete' }), true);
  assert.equal(shouldSendReview({ status: 'scheduled' }, { status: 'invoiced' }), true);
  // already closed -> re-saved: no re-send
  assert.equal(shouldSendReview({ status: 'complete' }, { status: 'invoiced' }), false);
  assert.equal(shouldSendReview({ status: 'complete' }, { status: 'complete' }), false);
  // not a close
  assert.equal(shouldSendReview({ status: 'scheduled' }, { status: 'in-progress' }), false);
  assert.equal(shouldSendReview(null, null), false);
});

test('etaEmail renders a default body with the tech first name, company and job', () => {
  const { subject, body } = etaEmail({ company: { name: 'TG Electric', phone: '204-555-1212' }, tech: { name: 'Sam Sparks' }, job: { number: 'J-1042', title: 'Panel swap' }, customerName: 'Dana Home' });
  assert.match(subject, /On the way for J-1042 - TG Electric/);
  assert.match(body, /^Hi Dana,/);
  assert.match(body, /Sam from TG Electric is on the way for J-1042 - Panel swap\./);
  assert.match(body, /- TG Electric \| 204-555-1212/);
});

test('etaEmail custom message replaces the default body', () => {
  const { body } = etaEmail({ company: { name: 'TG Electric' }, tech: { name: 'Sam' }, job: { number: 'J-1' }, customerName: 'Dana', message: 'Running ~15 min out, see you soon!' });
  assert.match(body, /Running ~15 min out, see you soon!/);
  assert.doesNotMatch(body, /is on the way/);
});

test('reviewEmail appends a valid review link and drops a bad one', () => {
  const ok = reviewEmail({ company: { name: 'TG Electric' }, job: { title: 'Panel swap' }, customerName: 'Dana', reviewUrl: 'https://g.page/r/x' });
  assert.match(ok.subject, /How did we do\? - TG Electric/);
  assert.match(ok.body, /Thanks for choosing TG Electric for your job|Panel swap/);
  assert.match(ok.body, /https:\/\/g\.page\/r\/x/);
  const bad = reviewEmail({ company: { name: 'TG Electric' }, reviewUrl: 'javascript:bad' });
  assert.doesNotMatch(bad.body, /javascript:/);
});

test('reviewEmail custom message is used with the link below it', () => {
  const { body } = reviewEmail({ company: { name: 'TG' }, reviewUrl: 'https://g.page/r/x', message: 'Hope the new panel is working great.' });
  assert.match(body, /Hope the new panel is working great\./);
  assert.match(body, /Leave a review: https:\/\/g\.page\/r\/x/);
});
