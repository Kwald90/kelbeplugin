// Run: node --test electrical-app/tests/
// Receivables (docs/releases/r1-get-paid.md 4.3 to 4.7, 7.3): deposits and the tax-set check,
// the holdback ledger with holdback the customer kept, statement balances and aging without holdback
// and disputes, interest only when disclosed and from the end of grace, the reminder plan's skips,
// the undisputed balance, receipts across invoices with on-account credit, the credit hold against
// exposure, ready to bill, invoice lag and DSO. Untaxed documents unless a test says otherwise, so the
// sums are easy to check by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/lib/receivables.js';
import { taxComponents } from '../js/lib/tax.js';
import { depositInvoiceLine, depositInvoiceFields, depositApplicationLine, sameTaxSet, holdbackSnapshot, creditNoteFrom, docTotals } from '../js/lib/money.js';

const line = (cents, extra = {}) => ({ description: 'Work', qty: 1, unitCents: cents, kind: 'labour', ...extra });
const inv = (id, cents, extra = {}) => ({ id, number: `INV-${id}`, clientId: 'c1', status: 'sent', issueDate: '2026-09-01', dueDate: '2026-09-15', taxes: [], lines: [line(cents)], ...extra });
const pay = (id, invoiceId, amountCents, extra = {}) => ({ id, invoiceId, amountCents, date: '2026-09-20', method: 'cheque', ...extra });

test('undisputed and collectible balances: disputes and holdback the customer kept come off', () => {
  const i = inv('1', 100000, { disputes: [{ id: 'd1', cents: 12000, reason: 'Pot lights', status: 'open' }, { id: 'd2', cents: 5000, status: 'won' }], holdback: { retainedByCustomerCents: 10000 } });
  const ps = [pay('p1', '1', 30000)];
  assert.equal(R.balanceCents(i, ps), 70000);
  assert.equal(R.undisputedBalance(i, ps), 58000, 'only the open dispute comes off');
  assert.equal(R.collectibleCents(i, ps), 48000, 'holdback kept by the customer is out of collections');
  assert.equal(R.collectibleCents({ ...i, status: 'draft' }, ps), 0);
});

test('deposits: only paid money is available, in the deposit line\'s terms; applications and refunds lower it; forfeit leaves nothing', () => {
  const taxes = taxComponents({ province: 'MB', treatment: 'pst-all', date: '2026-10-01' });
  const dep = { id: 'dep', number: 'INV-10', clientId: 'c1', jobId: 'j1', status: 'sent', issueDate: '2026-10-01', taxProvince: 'MB', taxTreatment: 'pst-all', taxes,
    ...depositInvoiceFields('prepayment'), lines: [depositInvoiceLine({ cents: 100000, model: 'prepayment', ref: 'E-2001' })] };
  assert.equal(docTotals(dep).totalCents, 112000, '$1,000 + GST 5% + RST 7%');
  assert.deepEqual(R.depositsAvailable([dep], [], { jobId: 'j1' }).map((d) => d.availableCents), [0], 'unpaid: nothing to apply');
  const half = [pay('p1', 'dep', 56000, { date: '2026-10-02' })];
  assert.equal(R.depositsAvailable([dep], half, { jobId: 'j1' })[0].availableCents, 50000, 'half paid: half the line');
  const paid = [pay('p1', 'dep', 112000, { date: '2026-10-02' })];
  const final = { id: 'fin', clientId: 'c1', jobId: 'j1', status: 'draft', taxProvince: 'MB', taxTreatment: 'pst-all', taxes, lines: [line(500000), depositApplicationLine(dep, 30000)] };
  const d = R.depositsAvailable([dep, final], paid, { jobId: 'j1' })[0];
  assert.equal(d.appliedCents, 30000);
  assert.equal(d.availableCents, 70000);
  assert.equal(sameTaxSet(dep, final), true, 'a prepayment applies on the same tax set');
  assert.equal(sameTaxSet(dep, { ...final, taxTreatment: 'gst-only', taxes: taxComponents({ province: 'MB', treatment: 'gst-only', date: '2026-10-01' }) }), false, 'another tax set: credit note and new invoice instead');
  // Refund: a credit note applied to the deposit, then the cheque back (method refund, negative).
  const refund = [...paid, { id: 'cn-app', invoiceId: 'dep', creditNoteId: 'cn', method: 'credit-note', amountCents: 112000, date: '2026-10-05' }, { id: 'ref', invoiceId: 'dep', method: 'refund', amountCents: -112000, date: '2026-10-05' }];
  assert.equal(R.depositsAvailable([dep], refund, { jobId: 'j1' })[0].availableCents, 0, 'refunded: nothing left');
  assert.equal(R.balanceCents(dep, refund), 0, 'the deposit invoice itself is settled');
  assert.equal(R.depositsAvailable([{ ...dep, forfeitedOn: '2026-10-06' }], paid, { jobId: 'j1' })[0].availableCents, 0, 'kept (forfeited): nothing to apply');
  // A security deposit: no tax on the deposit, the whole amount applies.
  const sec = { ...dep, id: 'sec', ...depositInvoiceFields('security'), lines: [depositInvoiceLine({ cents: 50000, model: 'security' })] };
  assert.equal(docTotals(sec).totalCents, 50000);
  assert.equal(R.depositsAvailable([sec], [pay('p2', 'sec', 50000)], { jobId: 'j1' })[0].availableCents, 50000);
});

test('holdback ledger: held on invoices, kept by the customer, released; credit notes reduce it', () => {
  const taxes = taxComponents({ province: 'MB', treatment: 'pst-all', date: '2026-10-01' });
  const base = { clientId: 'gc', jobId: 'j1', status: 'sent', taxProvince: 'MB', taxTreatment: 'pst-all', taxes };
  const p1 = { ...base, id: 'p1', number: 'INV-1', kind: 'progress', issueDate: '2026-09-01', lines: [line(1000000)] };
  p1.holdback = holdbackSnapshot(p1, { pct: 10 });
  const p2 = { ...base, id: 'p2', number: 'INV-2', issueDate: '2026-09-15', lines: [line(200000)], holdback: { retainedByCustomerCents: 20000 } };
  const cr = { ...creditNoteFrom(p1, { lines: [line(100000)], reason: 'price', today: '2026-09-20' }), id: 'cr', status: 'sent' };
  const rel = { ...base, id: 'rel', kind: 'holdback-release', issueDate: '2026-11-01', lines: [{ kind: 'other', lineType: 'holdback', qty: 1, unitCents: 50000 }] };
  const led = R.holdbackLedger([p1, p2, cr, rel], { jobId: 'j1' });
  assert.equal(led.retainedCents, 100000 - 10000, '10% of $10,000 less 10% of the $1,000 credited');
  assert.equal(led.retainedByCustomerCents, 20000);
  assert.equal(led.releasedCents, 50000);
  assert.equal(led.outstandingCents, 40000, 'kept by the customer is never released by invoice');
  assert.equal(led.byInvoice.length, 3);
});

test('statement: opening, rows with running balance, aging without holdback kept or disputes, on-account and credits on their own lines', () => {
  const a = inv('a', 100000, { issueDate: '2026-07-01', dueDate: '2026-07-31' });
  const b = inv('b', 50000, { issueDate: '2026-08-10', dueDate: '2026-09-09', disputes: [{ id: 'd', cents: 10000, status: 'open' }] });
  const c = inv('c', 80000, { issueDate: '2026-09-05', dueDate: '2026-10-05', holdback: { retainedByCustomerCents: 8000 } });
  const cn = { id: 'cn', number: 'CR-1001', kind: 'credit', clientId: 'c1', status: 'sent', issueDate: '2026-09-10', taxes: [], lines: [line(-5000)], creditsInvoiceId: 'a' };
  const other = inv('x', 999999, { clientId: 'c2' });
  const ps = [
    pay('p-a', 'a', 60000, { date: '2026-08-01' }),
    { id: 'oa', invoiceId: null, clientId: 'c1', amountCents: 20000, date: '2026-09-12', method: 'cheque', reference: 'Chq 77' },
    { id: 'oa-use', invoiceId: 'a', appliedFromId: 'oa', amountCents: 5000, date: '2026-09-13', method: 'cheque' },
  ];
  const s = R.statement('c1', { from: '2026-08-01', to: '2026-09-30', invoices: [a, b, c, cn, other], payments: ps });
  assert.equal(s.openingCents, 100000, 'invoice a before the period');
  assert.deepEqual(s.rows.map((r) => r.type), ['payment', 'invoice', 'invoice', 'credit-note', 'on-account']);
  assert.equal(s.closingCents, 100000 - 60000 + 50000 + 80000 - 5000 - 20000);
  assert.equal(s.rows.at(-1).balanceCents, s.closingCents);
  // Aging on 2026-09-30: a 35000 left (100000 - 60000 - 5000), 61 days late; b 40000 collectible, 21 days; c 72000 current.
  assert.deepEqual(s.aging, { current: 72000, d30: 40000, d60: 0, d90: 35000, d90p: 0 });
  assert.equal(s.disputedCents, 10000);
  assert.equal(s.holdbackRetainedCents, 8000);
  assert.equal(s.onAccountCents, 15000, 'on-account money left after "Apply credit"');
  assert.equal(s.creditsCents, 5000, 'the unapplied part of the credit note');
});

test('interest: only when disclosed, from the end of grace, simple per day; never on interest invoices; periods not charged twice', () => {
  const terms = R.interestTermsText({ enabled: true, annualPct: 18, graceDays: 10 });
  assert.match(terms, /1\.5% per month \(18% per year\)/);
  assert.equal(R.interestDisclosedIn(`Net 30. ${terms}`, { enabled: true, annualPct: 18, graceDays: 10 }), true);
  const i = inv('1', 365000, { dueDate: '2026-09-01', interestDisclosed: true });
  const o = { annualPct: 10, graceDays: 10 };
  assert.equal(R.interestDue(i, [], { ...o, asOf: '2026-09-11' }), 0, 'still in grace');
  assert.equal(R.interestDue(i, [], { ...o, asOf: '2026-09-12' }), 100, 'day one: 3650.00 x 10% / 365');
  assert.equal(R.interestDue(i, [], { ...o, asOf: '2026-09-21' }), 1000, 'ten days');
  assert.equal(R.interestDue({ ...i, interestDisclosed: false }, [], { ...o, asOf: '2026-09-21' }), 0, 'not disclosed: none');
  assert.equal(R.interestDue({ ...i, kind: 'interest' }, [], { ...o, asOf: '2026-09-21' }), 0);
  const disputed = { ...i, disputes: [{ id: 'd', cents: 182500, status: 'open' }] };
  assert.equal(R.interestDue(disputed, [], { ...o, asOf: '2026-09-21' }), 500, 'on the undisputed half only');
  assert.equal(R.interestDue(i, [pay('p', '1', 182500, { date: '2026-09-16' })], { ...o, asOf: '2026-09-21' }), 700, 'the 12th to the 15th in full, half from the day it was paid');
  const charges = R.interestCharges([i], [], { clientId: 'c1', ...o, asOf: '2026-09-21' });
  assert.deepEqual(charges.map((c) => [c.from, c.to, c.cents]), [['2026-09-12', '2026-09-21', 1000]]);
  const ii = { ...R.interestInvoice('c1', charges, { today: '2026-09-21' }), id: 'int', status: 'sent' };
  assert.equal(ii.taxNoneReason, 'exempt');
  assert.equal(ii.lines[0].lineType, 'interest');
  const next = R.interestCharges([i, ii], [], { clientId: 'c1', ...o, asOf: '2026-09-25' });
  assert.deepEqual(next.map((c) => [c.from, c.to, c.cents]), [['2026-09-22', '2026-09-25', 400]], 'starts the day after the last period charged');
});

test('reminder plan: the latest step reached, once per invoice and step, on what is collectible; every skip', () => {
  const settings = { collections: { reminders: R.REMINDER_PRESETS } };
  const clients = [{ id: 'c1', name: 'Prairie Builders', email: 'ap@prairie.test', credit: { statementEmail: 'statements@prairie.test' } }, { id: 'c2', name: 'Paused', email: 'x@y.test', credit: { remindersPaused: true } }, { id: 'c3', name: 'No contact' }, { id: 'c4', name: 'Text only', phone: '204-555-0100' }];
  const due = { dueDate: '2026-09-15' };
  const invoices = [
    inv('late', 100000, { ...due, disputes: [{ id: 'd', cents: 30000, status: 'open' }], holdback: { retainedByCustomerCents: 10000 } }),
    inv('draft', 100000, { ...due, status: 'draft' }),
    inv('void', 100000, { ...due, status: 'void' }),
    inv('paid', 100000, due),
    { ...inv('credit', -5000, due), kind: 'credit' },
    { ...inv('interest', 1000, due), kind: 'interest' },
    { ...inv('release', 1000, { dueDate: '2026-10-25' }), kind: 'holdback-release' },
    inv('alldisputed', 100000, { ...due, disputes: [{ id: 'd', cents: 100000, status: 'open' }] }),
    inv('npn', 100000, { ...due, promptPayment: { nonPaymentNotice: { receivedOn: '2026-09-10', disputedCents: 100000 } } }),
    inv('paused', 100000, { ...due, clientId: 'c2' }),
    inv('nocontact', 100000, { ...due, clientId: 'c3' }),
    inv('sms', 100000, { ...due, clientId: 'c4' }),
    inv('early', 100000, { dueDate: '2026-10-23' }),
  ];
  const plan = R.reminderPlan(invoices, [pay('p', 'paid', 100000)], clients, settings, '2026-10-20');
  const by = Object.fromEntries(plan.map((p) => [p.invoiceId, p]));
  assert.deepEqual(Object.keys(by).sort(), ['early', 'late', 'sms']);
  assert.equal(by.late.id, 'rem-late-r4', '35 days late: the 30-day step');
  assert.equal(by.late.amountCents, 60000, 'undisputed balance less holdback kept');
  assert.equal(by.late.to, 'statements@prairie.test');
  assert.equal(by.sms.channel, 'sms', 'no email: a text to the phone');
  assert.equal(by.early.stepKey, 'r1', '3 days before due');
  const text = R.reminderText(by.late.step, { client: clients[0], invoice: invoices[0], balanceCents: by.late.amountCents, company: { name: 'TG Electrical' } });
  assert.match(text.subject, /INV-late is 30 days overdue/);
  assert.match(text.body, /\$600\.00/);
  assert.doesNotMatch(text.body, /\{payLink\}/);
  assert.deepEqual(R.reminderPlan(invoices, [], clients, { collections: { reminders: [] } }, '2026-10-20'), [], 'off until the office turns them on');
});

test('receipt allocation: oldest first up to what is collectible, the rest on account; Apply credit uses it up', () => {
  const invoices = [inv('2', 50000, { dueDate: '2026-09-30' }), inv('1', 100000, { dueDate: '2026-09-01', disputes: [{ id: 'd', cents: 12000, status: 'open' }] }), inv('3', 30000, { dueDate: '2026-10-15' })];
  const a = R.allocateReceipt(200000, invoices, [], { clientId: 'c1' });
  assert.deepEqual(a.allocations.map((x) => [x.invoiceId, x.amountCents]), [['1', 88000], ['2', 50000], ['3', 30000]]);
  assert.equal(a.onAccountCents, 32000);
  const short = R.allocateReceipt(100000, invoices, [], { clientId: 'c1' });
  assert.deepEqual(short.allocations.map((x) => x.amountCents), [88000, 12000, 0]);
  assert.equal(short.onAccountCents, 0);
  const onAcc = { id: 'oa', invoiceId: null, clientId: 'c1', amountCents: 32000, date: '2026-10-01' };
  const ps = [onAcc, { id: 'use', invoiceId: '2', appliedFromId: 'oa', amountCents: 20000 }];
  assert.equal(R.onAccountBalance(onAcc, ps), 12000);
  assert.deepEqual(R.onAccountCredits('c1', ps).map((x) => x.availableCents), [12000]);
});

test('credit hold: past due beyond holdAfterDays on what is collectible, or exposure over the limit; the override wins until its date', () => {
  const settings = { collections: { holdAfterDays: 60, holdOverLimit: true } };
  const client = { id: 'c1', credit: { limitCents: 150000 } };
  const old = inv('old', 100000, { dueDate: '2026-08-01' });
  assert.deepEqual(R.creditHold(client, [old], [], settings, '2026-09-30').on, false, '60 days: not yet');
  const h = R.creditHold(client, [old], [], settings, '2026-10-01');
  assert.deepEqual([h.on, h.reason, h.overdueDays], [true, 'past_due', 61]);
  const kept = { ...old, holdback: { retainedByCustomerCents: 100000 } };
  assert.equal(R.creditHold(client, [kept], [], settings, '2026-10-01').on, false, 'holdback kept is out of the hold');
  const disputedOnly = { ...old, disputes: [{ id: 'd', cents: 100000, status: 'open' }] };
  assert.equal(R.creditHold(client, [disputedOnly], [], settings, '2026-10-01').on, false, 'a disputed amount is not past due');
  // Exposure: open AR (disputes included) + holdback held on invoices + unbilled T&M.
  const cur = inv('cur', 100000, { dueDate: '2026-12-01', disputes: [{ id: 'd', cents: 50000, status: 'open' }] });
  const prog = { ...inv('prog', 100000, { dueDate: '2026-12-01', jobId: 'j1' }), holdback: { cents: 10000 } };
  assert.equal(R.creditExposure(client, { invoices: [cur, prog], unbilledTmCents: 25000 }), 100000 + 90000 + 10000 + 25000);
  const over = R.creditHold(client, [cur, prog], [], settings, '2026-10-01', { exposureCents: 225000 });
  assert.deepEqual([over.on, over.reason], [true, 'over_limit']);
  assert.equal(R.creditHold({ id: 'c1', credit: {} }, [cur], [], settings, '2026-10-01').on, false, 'no limit: no limit hold');
  const released = R.creditHold({ ...client, credit: { ...client.credit, holdOverride: { mode: 'release', until: '2026-10-15' } } }, [old], [], settings, '2026-10-01');
  assert.deepEqual([released.on, released.auto, released.override], [false, true, 'release']);
  assert.equal(R.creditHold({ ...client, credit: { holdOverride: { mode: 'release', until: '2026-09-15' } } }, [old], [], settings, '2026-10-01').on, true, 'an expired override no longer counts');
  assert.equal(R.creditHold({ id: 'c1', credit: { holdOverride: { mode: 'hold' } } }, [], [], settings, '2026-10-01').on, true);
});

test('ready to bill: tickets, change orders, T&M, complete jobs, holdback due, deliveries and disputes, oldest first', () => {
  const jobs = [
    { id: 'fp', number: 'J-1', status: 'in-progress', billingMode: 'fixed', changeOrders: [{ id: 'co1', title: 'Extra pot lights', status: 'approved', approvedOn: '2026-10-01', amountCents: 50000 }, { id: 'co2', status: 'approved', approvedOn: '2026-10-02', amountCents: 1 }] },
    { id: 'tmj', number: 'J-2', status: 'in-progress', billingMode: 'tm' },
    { id: 'done', number: 'J-3', status: 'complete', contract: { completedOn: '2026-09-20', holdbackReleaseOn: '2026-10-10', properInvoiceRequired: true } },
  ];
  const fieldTickets = [
    { id: 't1', number: 'T-1001', jobId: 'fp', status: 'signed', signedAt: '2026-10-05T15:00:00Z', date: '2026-10-05' },
    { id: 't2', number: 'T-1002', jobId: 'fp', status: 'priced', date: '2026-10-05' },
    { id: 't3', number: 'T-1003', jobId: 'tmj', status: 'refused', refusal: { at: '2026-10-07T15:00:00Z' }, date: '2026-10-07' },
    { id: 't4', number: 'T-1004', jobId: 'tmj', status: 'signed', date: '2026-10-08', invoiceId: 'inv-tm' },
  ];
  const invoices = [
    { id: 'inv-tm', jobId: 'tmj', status: 'draft', lines: [] },
    { id: 'inv-co', jobId: 'fp', status: 'sent', lines: [{ changeOrderId: 'co2', qty: 1, unitCents: 1 }] },
    { ...inv('prog', 100000, { jobId: 'done', holdback: { cents: 10000 }, properInvoice: true, issueDate: '2026-09-25' }) },
    { ...inv('disp', 1000, { jobId: 'fp', disputes: [{ id: 'd', cents: 500, status: 'open', openedAt: '2026-10-15T00:00:00Z', reason: 'Cleanup' }] }) },
  ];
  const timeEntries = [{ id: 'te', jobId: 'tmj', employeeId: 'e', clockIn: '2026-10-09T14:00:00Z', clockOut: '2026-10-09T22:00:00Z', approved: true }];
  const rows = R.readyToBill({ jobs, invoices, fieldTickets, timeEntries, stockMoves: [], materialRequests: [], items: [], employees: [], settings: { labourRateCents: 10000 }, dayOf: (iso) => iso.slice(0, 10) }, { asOf: '2026-10-20' });
  const kinds = rows.map((r) => r.key);
  assert.deepEqual(kinds.sort(), ['co:fp:co1', 'complete:done', 'delivery:prog', 'dispute:disp:d', 'holdback:done', 'ticket:t1', 'ticket:t3', 'tm:tmj'].sort());
  assert.equal(rows[0].key, 'complete:done', 'the oldest first (30 days)');
  assert.equal(rows.find((r) => r.key === 'ticket:t1').ageDays, 15);
});

test('a tax-included amount turned into a before-tax credit line: exact when possible, else the nearest cent', () => {
  const doc = { taxProvince: 'MB', taxes: taxComponents({ province: 'MB', treatment: 'pst-all', date: '2026-10-01' }) };
  const total = (b) => docTotals({ ...doc, lines: [{ kind: 'other', qty: 1, unitCents: b }] }).totalCents;
  assert.equal(total(R.baseForAmount(doc, 120000)), 120000);
  assert.equal(Math.abs(total(R.baseForAmount(doc, 35000)) - 35000), 1, 'GST and RST each round: $350.00 is not reachable, $350.01 is the nearest');
  assert.equal(R.baseForAmount({ taxes: [] }, 1234), 1234);
});

test('invoice lag and DSO over the last 90 days', () => {
  const jobs = [{ id: 'j1', contract: { completedOn: '2026-09-01' } }, { id: 'j2', contract: { completedOn: '2026-09-10' } }];
  const fieldTickets = [{ id: 't', status: 'billed', signedAt: '2026-10-01T12:00:00Z', invoiceId: 'i3' }];
  const invoices = [
    inv('i1', 100000, { jobId: 'j1', issueDate: '2026-09-05' }),
    inv('i2', 100000, { jobId: 'j2', issueDate: '2026-09-30' }),
    inv('i3', 50000, { issueDate: '2026-10-11' }),
    inv('old', 900000, { issueDate: '2026-05-01' }),
  ];
  assert.deepEqual(R.invoiceLagDays({ jobs, fieldTickets, invoices, asOf: '2026-10-20' }), { medianDays: 10, count: 3 }, 'lags 4, 20 and 10');
  const d = R.dso({ invoices, payments: [pay('p', 'i1', 100000)], asOf: '2026-10-20' });
  assert.equal(d.salesCents, 250000);
  assert.equal(d.arCents, 100000 + 50000 + 900000);
  assert.equal(d.days, Math.round((1050000 / 250000) * 90 * 10) / 10);
});
