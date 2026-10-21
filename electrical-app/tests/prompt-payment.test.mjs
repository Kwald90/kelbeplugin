// Run: node --test electrical-app/tests/
// Prompt payment (docs/releases/r1-get-paid.md 7.2, 7.5): applies only in Manitoba from 2025-04-01
// to proper invoices, a 'verify' rule gives no dates and no alarms, a prime contract gets day 14 and
// day 28, a subcontract gets neither and gc7 only once gcPaidOn is recorded, and a weekend date "may
// move" while the rollover rule is unconfirmed. The rules are the 0160 seed rows as the API serves them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/lib/prompt-payment.js';

const seed = [
  { key: 'pp.MB.inForceFrom', value: '2025-04-01', status: 'sourced' },
  { key: 'pp.MB.paymentDays', value: 28, status: 'sourced' },
  { key: 'pp.MB.nonPaymentNoticeDays', value: 14, status: 'sourced' },
  { key: 'pp.MB.subPaymentDays', value: 7, status: 'sourced' },
  { key: 'pp.MB.appliesTo', value: null, status: 'verify' },
  { key: 'pp.MB.dayRollover', value: null, status: 'verify' },
];
const rules = { rules: seed };
const prime = { id: 'j1', contract: { role: 'prime', signedOn: '2025-05-01', properInvoiceRequired: true } };
const sub = { id: 'j2', contract: { role: 'sub', primeSignedOn: '2025-06-01', properInvoiceRequired: true } };
const inv = (id, jobId, extra = {}) => ({ id, number: `INV-${id}`, jobId, status: 'sent', taxProvince: 'MB', taxes: [], issueDate: '2026-10-01', dueDate: '2026-10-31',
  lines: [{ kind: 'labour', qty: 1, unitCents: 100000 }], promptPayment: { deliveredOn: '2026-10-02' }, ...extra });

test('applies only to Manitoba proper invoices on contracts signed from 2025-04-01, with usable rules', () => {
  assert.equal(P.promptPaymentApplies(prime, inv('1', 'j1'), rules).applies, true);
  assert.equal(P.promptPaymentApplies(prime, inv('1', 'j1', { taxProvince: 'ON' }), rules).applies, false, 'outside Manitoba');
  assert.equal(P.promptPaymentApplies(prime, inv('1', 'j1', { taxProvince: null }), rules, { companyProvince: 'MB' }).applies, true, 'the company province when the invoice has none');
  const early = { id: 'j', contract: { ...prime.contract, signedOn: '2025-03-01' } };
  const a = P.promptPaymentApplies(early, inv('1', 'j'), rules);
  assert.equal(a.applies, false);
  assert.match(a.why, /before 2025-04-01/);
  assert.equal(P.promptPaymentApplies({ id: 'j', contract: { role: 'prime', signedOn: '2025-05-01' } }, inv('1', 'j'), rules).applies, false, 'not a proper invoice');
  assert.equal(P.promptPaymentApplies({ id: 'j', contract: { role: 'prime', signedOn: '2025-05-01' } }, inv('1', 'j', { properInvoice: true }), rules).applies, true);
  const unknown = P.promptPaymentApplies({ id: 'j', contract: { role: 'sub', properInvoiceRequired: true } }, inv('1', 'j'), rules);
  assert.deepEqual([unknown.applies, unknown.missing], [false, 'primeSignedOn'], 'unknown dates: no alarms, and which date to add');
  assert.equal(P.promptPaymentApplies(prime, inv('1', 'j1'), rules).checkApplies, true, 'appliesTo unconfirmed: "check it applies"');
  assert.equal(P.promptPaymentApplies(prime, inv('1', 'j1'), rules).unconfirmed, true, 'sourced, not verified: the disclaimer shows');
  assert.equal(P.promptPaymentApplies(prime, { ...inv('1', 'j1'), kind: 'credit' }, rules).applies, false);
});

test('a rule with status verify gives no dates and no alarms', () => {
  const v = { rules: seed.map((r) => (r.key === 'pp.MB.paymentDays' ? { ...r, status: 'verify', origin: 'company' } : r)) };
  const d = P.promptPaymentDates(inv('1', 'j1'), prime, v);
  assert.equal(d.applies, false);
  assert.equal(d.paymentDueOn, null);
  assert.deepEqual(P.promptPaymentAlarms([inv('1', 'j1')], [prime], [], v, '2026-12-01'), []);
});

test('prime: notice due day 14, payment due day 28; day14 then day28, each the day after', () => {
  const i = inv('3010', 'j1');
  const d = P.promptPaymentDates(i, prime, rules);
  assert.deepEqual([d.deliveredOn, d.noticeDueOn, d.paymentDueOn, d.gcDueOn], ['2026-10-02', '2026-10-16', '2026-10-30', null]);
  assert.deepEqual(P.promptPaymentAlarms([i], [prime], [], rules, '2026-10-16'), [], 'on the day itself: nothing yet');
  const a15 = P.promptPaymentAlarms([i], [prime], [], rules, '2026-10-17');
  assert.deepEqual(a15.map((a) => [a.step, a.ref]), [['day14', 'pp:3010:day14']]);
  assert.equal(a15[0].title, 'No notice of non-payment on INV-3010 by day 14: the full amount is due by 2026-10-30.');
  const a29 = P.promptPaymentAlarms([i], [prime], [], rules, '2026-10-31');
  assert.deepEqual(a29.map((a) => a.step), ['day14', 'day28']);
  const noticed = { ...i, promptPayment: { ...i.promptPayment, nonPaymentNotice: { receivedOn: '2026-10-10', disputedCents: 20000 } } };
  assert.deepEqual(P.promptPaymentAlarms([noticed], [prime], [], rules, '2026-10-31').map((a) => a.step), ['day28'], 'a recorded notice stops day 14');
  const paid = [{ invoiceId: '3010', amountCents: 100000 }];
  assert.deepEqual(P.promptPaymentAlarms([i], [prime], paid, rules, '2026-10-31'), [], 'paid: no alarms');
  const disputed = { ...i, disputes: [{ id: 'd', cents: 100000, status: 'open' }] };
  assert.deepEqual(P.promptPaymentAlarms([disputed], [prime], [], rules, '2026-10-31').map((a) => a.step), ['day14'], 'day 28 runs on the undisputed balance');
  const notDelivered = { ...i, promptPayment: {} };
  assert.deepEqual(P.promptPaymentAlarms([notDelivered], [prime], [], rules, '2026-12-31'), [], 'no delivery date: nothing to count from');
  assert.equal(P.promptPaymentDates(notDelivered, prime, rules, { emailedOn: '2026-10-05' }).noticeDueOn, '2026-10-19', 'emailed through Fishtape: that day');
});

test('sub: no day 14 or day 28; gc7 only once the GC\'s payment is recorded; an information date otherwise', () => {
  const i = inv('4001', 'j2');
  const d = P.promptPaymentDates(i, sub, rules);
  assert.deepEqual([d.noticeDueOn, d.paymentDueOn, d.gcDueOn, d.expectedLatestOn], [null, null, null, '2026-11-06']);
  assert.deepEqual(P.promptPaymentAlarms([i], [sub], [], rules, '2026-12-31'), []);
  const paidByOwner = { ...i, promptPayment: { ...i.promptPayment, gcPaidOn: '2026-11-02' } };
  assert.equal(P.promptPaymentDates(paidByOwner, sub, rules).gcDueOn, '2026-11-09');
  assert.deepEqual(P.promptPaymentAlarms([paidByOwner], [sub], [], rules, '2026-11-09'), []);
  assert.deepEqual(P.promptPaymentAlarms([paidByOwner], [sub], [], rules, '2026-11-10').map((a) => a.ref), ['pp:4001:gc7']);
});

test('a date on a weekend may move while the rollover rule is unconfirmed', () => {
  const i = inv('5', 'j1', { promptPayment: { deliveredOn: '2026-10-17' } }); // + 28 = Sat 2026-11-14
  const d = P.promptPaymentDates(i, prime, rules);
  assert.equal(d.paymentDueOn, '2026-11-14');
  assert.equal(d.mayMove.paymentDueOn, true);
  assert.equal(d.mayMove.noticeDueOn, true, '2026-10-31 is a Saturday too');
  assert.equal(P.fmtDue(d.paymentDueOn, d.mayMove.paymentDueOn), 'Sat 2026-11-14 (may move to Mon)');
  const confirmed = { rules: seed.map((r) => (r.key === 'pp.MB.dayRollover' ? { ...r, value: 'no', status: 'verified' } : r)) };
  assert.equal(P.promptPaymentDates(i, prime, confirmed).mayMove.paymentDueOn, false);
  const weekday = P.promptPaymentDates(inv('6', 'j1'), prime, rules);
  assert.equal(weekday.mayMove.paymentDueOn, false, 'Fri 2026-10-30 does not move');
});

test('rulesMap takes a Map, the API rows or a plain object', () => {
  assert.equal(P.rulesMap(seed).get('pp.MB.paymentDays').value, 28);
  assert.equal(P.rulesMap(new Map([['x', { value: 1 }]])).get('x').value, 1);
  assert.equal(P.rulesMap({ 'pp.MB.paymentDays': 30 }).get('pp.MB.paymentDays').status, 'verified');
});
