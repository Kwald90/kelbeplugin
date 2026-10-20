// Purchasing (js/lib/purchasing.js): bill totals and the 2-cent check, refunds as negative
// receipts, statuses, POs from material requests, billing a PO, PO numbers, the module switch and
// plan gate, and the three collections' registry entries and schemas.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../js/lib/purchasing.js';
import * as M from '../js/lib/modules.js';
import { COLLECTIONS, DEFAULT_SETTINGS } from '../js/store.js';
import { FEATURE_PLAN } from '../js/plans.js';

const schema = (name) => JSON.parse(readFileSync(new URL(`../js/schema/${name}.json`, import.meta.url), 'utf8'));
const bill = (o = {}) => ({ id: 'b1', kind: 'bill', vendorId: 'v1', date: '2026-10-20', dueDate: '2026-11-19', status: 'draft', lines: [], taxes: [], totalCents: null, ...o });
const line = (qty, unitCents, o = {}) => P.newBillLine({ description: 'x', qty, unitCents, amountCents: Math.round(qty * unitCents), ...o });

describe('bill totals and the 2-cent check', () => {
  // A Manitoba wholesaler's bill: 3 lines, GST 5% and RST 7% printed separately.
  const mb = bill({
    lines: [line(50, 25), line(20, 1000), line(1, 4599, { amountCents: 4599 })],
    taxes: [{ id: 'GST', label: 'GST', cents: 1293 }, { id: 'RST', label: 'RST', cents: 1811 }],
    totalCents: 28953,
  });

  test('lines + taxes = the printed total: it adds up', () => {
    const t = P.billTotals(mb);
    assert.equal(t.linesCents, 1250 + 20000 + 4599);
    assert.equal(t.taxCents, 3104);
    assert.equal(t.computedCents, 28953);
    assert.equal(t.totalCents, 28953);
    assert.equal(t.diffCents, 0);
    assert.equal(t.mismatch, false);
    assert.ok(P.billAddsUp(mb));
  });

  test('off by 2 cents still adds up (supplier rounding); 3 cents does not', () => {
    assert.equal(P.billTotals({ ...mb, totalCents: 28955 }).mismatch, false);
    assert.equal(P.billTotals({ ...mb, totalCents: 28951 }).mismatch, false);
    const off = P.billTotals({ ...mb, totalCents: 28956 });
    assert.equal(off.mismatch, true);
    assert.equal(off.diffCents, 3);
    assert.equal(P.billTotals({ ...mb, totalCents: 28950 }).mismatch, true);
    const msg = P.billProblems({ ...mb, totalCents: 28956 }).find((p) => p.code === 'totals_mismatch');
    assert.ok(msg && !msg.block, 'a bill that doesn’t add up can still be saved');
    assert.match(msg.message, /Bill total doesn't add up/);
  });

  test('no printed total: the computed total stands, nothing to check', () => {
    const t = P.billTotals({ ...mb, totalCents: null });
    assert.equal(t.typed, false);
    assert.equal(t.totalCents, 28953);
    assert.equal(t.mismatch, false);
  });

  test('a line amount is round(qty × unit cost) unless typed', () => {
    assert.equal(P.lineAmountCents({ qty: 3, unitCents: 333 }), 999);
    assert.equal(P.lineAmountCents({ qty: 2.5, unitCents: 199 }), 498, '497.5 rounds up');
    assert.equal(P.lineAmountCents({ qty: 3, unitCents: 333, amountCents: 1000 }), 1000, 'typed wins');
    const l = P.editLine({ qty: 3, unitCents: 333, amountCents: 1000 }, { description: 'Wire' });
    assert.equal(l.amountCents, 1000, 'editing the description keeps a typed amount');
    assert.equal(P.editLine(l, { qty: 4 }).amountCents, 1332, 'a new qty works the amount out again');
    assert.equal(P.editLine(l, { unitCents: 100 }).amountCents, 300);
  });

  test('taxes from the province as a starting point (MB GST + RST, ON HST, QC GST + QST)', () => {
    assert.deepEqual(P.suggestTaxes('MB', '2026-10-20', 10000), [{ id: 'GST', label: 'GST', cents: 500 }, { id: 'RST', label: 'RST', cents: 700 }]);
    assert.deepEqual(P.suggestTaxes('ON', '2026-10-20', 10000), [{ id: 'HST', label: 'HST', cents: 1300 }]);
    assert.deepEqual(P.suggestTaxes('QC', '2026-10-20', 10000).map((t) => [t.id, t.cents]), [['GST', 500], ['QST', 998]]);
    assert.deepEqual(P.suggestTaxes('MB', '2019-06-30', 10000).map((t) => t.cents), [500, 800], 'MB RST was 8% before July 2019');
  });
});

describe('refunds are negative receipts', () => {
  const r = { kind: 'receipt', vendorId: 'v1', date: '2026-10-20', paidWith: 'card', status: 'draft',
    lines: [line(2, 1500)], taxes: [{ id: 'GST', label: 'GST', cents: 150 }], totalCents: 3150 };

  test('ticking Refund makes every amount negative; unticking makes them positive again', () => {
    const neg = { ...r, ...P.withSign(r, -1) };
    assert.equal(neg.lines[0].unitCents, -1500);
    assert.equal(neg.lines[0].amountCents, -3000);
    assert.equal(neg.taxes[0].cents, -150);
    assert.equal(neg.totalCents, -3150);
    assert.ok(P.isRefund(neg));
    assert.equal(P.billTotals(neg).mismatch, false);
    assert.deepEqual(P.billProblems(neg).filter((p) => p.block), [], 'a refund receipt is fine');
    const pos = { ...neg, ...P.withSign(neg, 1) };
    assert.deepEqual(pos.lines, r.lines);
    assert.equal(pos.totalCents, 3150);
    assert.equal(P.isRefund(pos), false);
  });

  test('a negative bill is refused (refunds are receipts), and so are mixed signs', () => {
    const negBill = { ...bill(), ...P.withSign({ ...r, kind: 'bill' }, -1), kind: 'bill' };
    assert.ok(P.billProblems(negBill).some((p) => p.code === 'negative_bill' && p.block));
    assert.equal(P.isRefund(negBill), false, 'only receipts are refunds');
    const mixed = { ...r, lines: [line(1, 1000), line(1, -400)], totalCents: null, taxes: [] };
    assert.ok(P.billProblems(mixed).some((p) => p.code === 'mixed_signs'));
  });

  test('switching a refund receipt to a bill makes it positive again', () => {
    const neg = { ...r, ...P.withSign(r, -1) };
    const patch = P.switchKind(neg, 'bill');
    assert.equal(patch.kind, 'bill');
    assert.equal(patch.paidWith, null);
    assert.equal(patch.totalCents, 3150);
    assert.ok(patch.dueDate);
  });
});

describe('statuses and what blocks entering a bill', () => {
  test('receipts are paid once saved; bills are to pay', () => {
    assert.equal(P.enteredStatus({ kind: 'receipt' }), 'paid');
    assert.equal(P.enteredStatus({ kind: 'bill' }), 'open');
    const n = P.newBill({ kind: 'receipt', settings: { company: { province: 'MB' } }, today: '2026-10-20' });
    assert.equal(n.status, 'draft');
    assert.equal(n.paidWith, 'card');
    assert.equal(n.dueDate, null);
    assert.equal(n.taxProvince, 'MB');
    assert.equal(P.newBill({ today: '2026-10-20' }).dueDate, '2026-10-20');
  });

  test('an open bill past its due date is overdue; receipts never are', () => {
    assert.equal(P.billStatusOf(bill({ status: 'open', dueDate: '2026-10-19' }), '2026-10-20'), 'overdue');
    assert.equal(P.billStatusOf(bill({ status: 'open', dueDate: '2026-10-20' }), '2026-10-20'), 'open');
    assert.equal(P.billStatusOf(bill({ status: 'paid', dueDate: '2026-01-01' }), '2026-10-20'), 'paid');
    assert.equal(P.billStatusOf({ kind: 'receipt', status: 'paid', dueDate: '2026-01-01' }, '2026-10-20'), 'paid');
  });

  test('blocking problems: no supplier, no lines, no date, receipt without a payment method', () => {
    const codes = (b) => P.billProblems(b).filter((p) => p.block).map((p) => p.code).sort();
    assert.deepEqual(codes({ kind: 'bill' }), ['no_date', 'no_lines', 'no_vendor']);
    assert.deepEqual(codes({ kind: 'receipt', vendorId: 'v', date: '2026-10-20', lines: [line(1, 100)] }), ['no_paid_with']);
    assert.deepEqual(codes(bill({ lines: [line(1, 100)] })), []);
    assert.ok(P.billProblems(bill({ lines: [line(1, 100)], dueDate: '2026-10-01' })).some((p) => p.code === 'due_before_date' && !p.block));
  });

  test('due date from the supplier’s terms', () => {
    assert.equal(P.dueFromTerms('Net 30', '2026-10-20'), '2026-11-19');
    assert.equal(P.dueFromTerms('net15 days', '2026-12-20'), '2027-01-04');
    assert.equal(P.dueFromTerms('COD', '2026-10-20'), null);
    assert.equal(P.dueFromTerms('Net 30', ''), null);
  });

  test('the summary: to pay, overdue, spent this month (refunds netted off, drafts and voids left out)', () => {
    const bills = [
      bill({ id: '1', status: 'open', totalCents: 10000, lines: [line(1, 10000)], dueDate: '2026-10-01', date: '2026-09-15' }),
      bill({ id: '2', status: 'open', totalCents: 5000, lines: [line(1, 5000)], dueDate: '2026-11-30', date: '2026-10-05' }),
      { id: '3', kind: 'receipt', status: 'paid', date: '2026-10-10', lines: [line(1, 2500)], taxes: [], totalCents: 2500 },
      { id: '4', kind: 'receipt', status: 'paid', date: '2026-10-11', lines: [line(1, -500)], taxes: [], totalCents: -500 },
      bill({ id: '5', status: 'draft', lines: [line(1, 99999)], date: '2026-10-12' }),
      bill({ id: '6', status: 'void', lines: [line(1, 77777)], date: '2026-10-12' }),
    ];
    assert.deepEqual(P.purchasingSummary(bills, '2026-10-20'), { toPayCents: 15000, overdueCents: 10000, monthCents: 5000 + 2500 - 500, toPay: 2, overdue: 1 });
  });

  test('job costs from bills, by cost type, line job over bill job', () => {
    const bills = [
      bill({ status: 'open', jobId: 'j1', lines: [line(1, 1000), line(1, 4000, { costType: 'subcontract' }), line(1, 300, { jobId: 'j2' })] }),
      { kind: 'receipt', status: 'paid', jobId: 'j1', lines: [line(1, -200)] },
      bill({ status: 'draft', jobId: 'j1', lines: [line(1, 99999)] }),
    ];
    assert.deepEqual(P.jobCostsFromBills(bills, 'j1'), { material: 800, subcontract: 4000, equipment: 0, other: 0, total: 4800 });
    assert.equal(P.jobCostsFromBills(bills, 'j2').total, 300);
  });

  test('search by supplier, number, job or line', () => {
    const vendors = new Map([['v1', { id: 'v1', name: 'Nedco Winnipeg' }]]);
    const jobs = new Map([['j1', { id: 'j1', number: 'J-1042', title: 'Panel upgrade' }]]);
    const b = bill({ number: 'INV-2231', jobId: 'j1', lines: [line(1, 1, { description: '3/4 EMT' })] });
    for (const q of ['nedco', 'INV-22', 'j-1042', 'panel', 'emt', '']) assert.ok(P.billMatches(b, q, { vendors, jobs }), q);
    assert.equal(P.billMatches(b, 'westburne', { vendors, jobs }), false);
  });
});

describe('the bill photo or PDF', () => {
  test('JPEG, PNG and PDF data URLs only, at most 2.5 MB of text', () => {
    assert.equal(P.receiptType('data:image/jpeg;base64,AAAA'), 'image/jpeg');
    assert.equal(P.receiptType('data:application/pdf;base64,JVBERi0='), 'application/pdf');
    assert.equal(P.receiptType('data:image/svg+xml;base64,PHN2Zz4='), null);
    assert.equal(P.receiptType('https://example.com/a.jpg'), null);
    assert.equal(P.receiptProblem(null), null);
    assert.equal(P.receiptProblem({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }), null);
    assert.match(P.receiptProblem({ dataUrl: 'data:text/html;base64,PGI+' }), /photo|PDF/);
    const big = 'data:application/pdf;base64,' + 'A'.repeat(P.RECEIPT_MAX_CHARS);
    assert.match(P.receiptProblem({ dataUrl: big }), /too big/);
    assert.equal(P.dataUrlBytes('data:image/png;base64,AAAA'), 3);
  });

  test('the schema caps the data URL at the same size and type', () => {
    const r = schema('bills').properties.receipt.properties.dataUrl;
    assert.equal(r.maxLength, P.RECEIPT_MAX_CHARS);
    const re = new RegExp(r.pattern);
    for (const t of P.RECEIPT_TYPES) assert.ok(re.test(`data:${t};base64,AAAA`), t);
    assert.equal(re.test('data:image/gif;base64,AAAA'), false);
  });
});

describe('purchase orders', () => {
  const items = new Map([['it-strap', { id: 'it-strap', name: 'Two-hole strap 3/4"', unit: 'ea', costCents: 25, priceCents: 80 }]]);
  const reqs = [
    { id: 'mr-1', jobId: 'j1', itemId: 'it-strap', description: 'strap', qty: 50, unit: 'ea', status: 'sent' },
    { id: 'mr-2', jobId: 'j1', itemId: 'it-strap', description: 'strap', qty: 25, unit: 'ea', status: 'sent' },
    { id: 'mr-3', jobId: 'j1', description: '3/4 EMT ', qty: 20, unit: 'sticks', status: 'requested', costCents: 1000 },
    { id: 'mr-4', jobId: 'j2', description: '3/4 emt', qty: 5, unit: 'sticks', status: 'sent' },
  ];

  test('same item, unit and job add up; each line lists the requests it covers; costs from the price book', () => {
    const lines = P.poLinesFromRequests(reqs, { items });
    assert.equal(lines.length, 3);
    const strap = lines.find((l) => l.itemId === 'it-strap');
    assert.deepEqual({ ...strap }, { itemId: 'it-strap', description: 'Two-hole strap 3/4"', qty: 75, unit: 'ea', unitCents: 25, jobId: 'j1', materialRequestIds: ['mr-1', 'mr-2'] });
    const emt = lines.filter((l) => /emt/i.test(l.description));
    assert.deepEqual(emt.map((l) => [l.jobId, l.qty, l.unitCents, l.materialRequestIds]), [['j1', 20, 1000, ['mr-3']], ['j2', 5, 0, ['mr-4']]], 'different jobs stay apart');
    assert.equal(P.commonJob(lines), null);
    assert.equal(P.commonJob(lines.filter((l) => l.jobId === 'j1')), 'j1');
  });

  test('one PO per chosen supplier, open, with the requests it covers', () => {
    const vendorOf = { 'mr-1': 'v-nedco', 'mr-2': 'v-nedco', 'mr-3': 'v-westburne', 'mr-4': 'v-nedco' };
    const out = P.ordersFromRequests(reqs, (r) => vendorOf[r.id], { items, today: '2026-10-20' });
    assert.deepEqual(out.map((g) => [g.vendorId, g.requestIds]), [['v-nedco', ['mr-1', 'mr-2', 'mr-4']], ['v-westburne', ['mr-3']]]);
    const [nedco, westburne] = out;
    assert.equal(nedco.order.status, 'open');
    assert.equal(nedco.order.vendorId, 'v-nedco');
    assert.equal(nedco.order.date, '2026-10-20');
    assert.equal(nedco.order.jobId, null, 'two jobs: the lines carry them');
    assert.equal(westburne.order.jobId, 'j1');
    assert.equal(P.poTotalCents(nedco.order), 75 * 25);
    assert.ok(!('number' in nedco.order) || nedco.order.number == null, 'numbered by the store when saved');
  });

  test('only requests not yet ordered can go on a PO', () => {
    assert.deepEqual(['requested', 'sent', 'ordered', 'fulfilled', 'cancelled', undefined].map((status) => P.orderableRequest({ status })), [true, true, false, false, false, true]);
  });

  test('PO numbers: PO-5001 on, never one already used', () => {
    assert.equal(DEFAULT_SETTINGS.nextNumbers.po, P.PO_START);
    assert.equal(P.PO_START, 5001);
    assert.deepEqual(P.nextPoNumber({ nextNumbers: {} }), { number: 'PO-5001', next: 5002 });
    assert.deepEqual(P.nextPoNumber({ nextNumbers: { po: 5007 } }, [{ number: 'PO-5003' }]), { number: 'PO-5007', next: 5008 });
    assert.deepEqual(P.nextPoNumber({ nextNumbers: { po: 5002 } }, [{ number: 'PO-5009' }, { number: 'misc' }]), { number: 'PO-5010', next: 5011 });
    assert.equal(P.parsePoNumber('po-5012'), 5012);
    assert.equal(P.parsePoNumber('5012'), null);
    assert.equal(P.formatPoNumber(5001), 'PO-5001');
  });

  test('what stops a PO being placed', () => {
    assert.deepEqual(P.poProblems({ lines: [] }), ['Pick the supplier.', 'Add at least one line.']);
    assert.deepEqual(P.poProblems({ vendorId: 'v', lines: [{ description: 'x', qty: 0 }] }), ['Every line needs a quantity above zero.']);
    assert.deepEqual(P.poProblems({ vendorId: 'v', lines: [{ description: 'x', qty: 2 }] }), []);
  });

  test('billing a PO: lines not yet billed, at the PO’s cost, pointing at their PO line', () => {
    const po = { id: 'po1', number: 'PO-5001', vendorId: 'v1', jobId: 'j1', status: 'open', lines: [
      { itemId: 'it-strap', description: 'Strap', qty: 75, unit: 'ea', unitCents: 25, jobId: 'j1', materialRequestIds: ['mr-1', 'mr-2'] },
      { description: 'EMT', qty: 20, unit: 'sticks', unitCents: 1000, jobId: 'j1', materialRequestIds: ['mr-3'] },
    ] };
    const first = P.billFromPo(po, { today: '2026-10-21', settings: { company: { province: 'MB' } } });
    assert.equal(first.kind, 'bill');
    assert.equal(first.status, 'draft');
    assert.equal(first.vendorId, 'v1');
    assert.equal(first.purchaseOrderId, 'po1');
    assert.deepEqual(first.materialRequestIds, ['mr-1', 'mr-2', 'mr-3']);
    assert.deepEqual(first.lines.map((l) => [l.qty, l.unitCents, l.amountCents, l.poLine.index]), [[75, 25, 1875, 0], [20, 1000, 20000, 1]]);
    // The supplier shipped part of the EMT: the first bill took 12 sticks.
    const b1 = { ...first, id: 'b1', status: 'open', lines: [first.lines[0], { ...first.lines[1], qty: 12, amountCents: 12000 }] };
    const billed = P.poBilled(po, [b1, { id: 'bx', status: 'void', lines: [{ ...first.lines[1] }] }]);
    assert.deepEqual(billed.lineQty, [75, 12]);
    assert.equal(billed.billedCents, 1875 + 12000);
    assert.deepEqual(billed.billIds, ['b1'], 'a void bill does not count');
    const rest = P.billFromPo(po, { bills: [b1] });
    assert.deepEqual(rest.lines.map((l) => [l.description, l.qty, l.poLine.index]), [['EMT', 8, 1]]);
    assert.equal(P.billFromPo(po, { bills: [b1, { id: 'b2', status: 'open', lines: rest.lines }] }).lines.length, 0, 'fully billed');
  });

  test('the PO as text for the supplier', () => {
    const jobs = new Map([['j1', { id: 'j1', number: 'J-1042', title: 'Panel upgrade' }], ['j2', { id: 'j2', number: 'J-1043' }]]);
    const text = P.poText({ number: 'PO-5001', date: '2026-10-20', jobId: 'j1', shipTo: '12 Elm St', notes: 'Call before delivery', lines: [
      { description: 'Strap', qty: 75, unit: 'ea', unitCents: 25, jobId: 'j1' }, { description: 'EMT', qty: 5, unit: 'sticks', unitCents: 0, jobId: 'j2' },
    ] }, { vendor: { name: 'Nedco', accountNumber: 'TG-44' }, company: 'TG Electrical', jobs, money: (c) => `$${(c / 100).toFixed(2)}` });
    assert.match(text, /^Purchase order PO-5001 from TG Electrical\nTo: Nedco \(account TG-44\)/);
    assert.match(text, /Job: J-1042 · Panel upgrade/);
    assert.match(text, /- 75 ea {2}Strap {2}@ \$0\.25 = \$18\.75\n/);
    assert.match(text, /- 5 sticks {2}EMT {2}\(J-1043\)/);
    assert.match(text, /Total before tax: \$18\.75\n\nCall before delivery$/);
  });
});

describe('suppliers', () => {
  test('a name is required and unique among active suppliers; email checked', () => {
    const vendors = [{ id: 'a', name: 'Nedco' }, { id: 'b', name: 'Old Supply', active: false }];
    assert.deepEqual(P.vendorProblems({ id: 'n', name: '' }), ['Give the supplier a name.']);
    assert.match(P.vendorProblems({ id: 'n', name: ' nedco ' }, vendors)[0], /already a supplier/);
    assert.deepEqual(P.vendorProblems({ id: 'a', name: 'Nedco' }, vendors), [], 'itself');
    assert.deepEqual(P.vendorProblems({ id: 'n', name: 'Old Supply' }, vendors), [], 'an inactive name can be reused');
    assert.match(P.vendorProblems({ id: 'n', name: 'X', email: 'nope' })[0], /email/);
  });

  test('choices: active suppliers by name, plus the document’s own inactive one', () => {
    const vendors = [{ id: 'b', name: 'Westburne' }, { id: 'a', name: 'Anixter' }, { id: 'c', name: 'Gone', active: false }];
    assert.deepEqual(P.vendorChoices(vendors).map((v) => v.id), ['a', 'b']);
    assert.deepEqual(P.vendorChoices(vendors, 'c').map((v) => v.id), ['a', 'c', 'b']);
    assert.equal(P.vendorName(null), 'No supplier');
    assert.equal(P.vendorName({ companyName: 'Acme Ltd' }), 'Acme Ltd');
  });
});

describe('module switch, plan and registry', () => {
  test('a Purchasing switch in Money, off for new companies, showing the purchasing screen', () => {
    const sw = M.SWITCH_BY_ID.purchasing;
    assert.deepEqual({ ...sw }, { id: 'purchasing', group: 'money', label: 'Purchasing', desc: 'Suppliers, bills, receipts and purchase orders.', modules: ['purchasing'] });
    assert.equal(M.switchOn({ modules: { ...DEFAULT_SETTINGS.modules } }, 'purchasing'), false, 'not core');
    assert.equal(M.switchOn({ modules: {} }, 'purchasing'), false, 'a company from before the switch: its default');
    assert.equal(M.switchOn(null, 'purchasing'), true, 'no switches at all (the demo): on');
    assert.equal(M.moduleOn({ modules: { purchasing: true } }, 'purchasing'), true);
    assert.equal(M.moduleOn({ modules: { purchasing: false } }, 'purchasing'), false);
  });

  test('writes to the three collections need the switch', () => {
    const off = { modules: M.nextModules(null, { purchasing: false }) };
    for (const c of ['vendors', 'bills', 'purchaseOrders']) {
      assert.deepEqual(M.COLLECTION_SWITCHES[c], ['purchasing'], c);
      assert.equal(M.blockingSwitch(off, c), 'purchasing', c);
      assert.equal(M.blockingSwitch({ modules: { purchasing: true } }, c), null, c);
    }
    assert.match(M.turnedOffMessage('purchasing'), /^Purchasing is turned off/);
  });

  test('who may use it: the invoices permission, the switch, then the plan', () => {
    const on = { modules: { purchasing: true } };
    assert.equal(P.purchasingAllowed({ canInvoices: false, settings: on }), false, 'foremen and crew: never');
    assert.equal(P.purchasingAllowed({ canInvoices: true, settings: { modules: { purchasing: false } } }), false);
    assert.equal(P.purchasingAllowed({ canInvoices: true, settings: on, entitlements: null }), true, 'demo');
    assert.equal(P.purchasingAllowed({ canInvoices: true, settings: on, entitlements: { plan: 'business', features: ['purchasing'] } }), true);
    // HQ turned it off for this company (an override is always in /me's feature list or not).
    assert.equal(P.purchasingAllowed({ canInvoices: true, settings: on, entitlements: { plan: 'business', features: [] } }), !Object.hasOwn(FEATURE_PLAN, 'purchasing'));
  });

  test('Pro and up have purchasing; Starter does not (plans.js, W1)', { skip: !Object.hasOwn(FEATURE_PLAN, 'purchasing') && 'waits for plans.js purchasing (W1)' }, () => {
    assert.equal(FEATURE_PLAN.purchasing, 'pro');
    assert.equal(P.purchasingAllowed({ canInvoices: true, settings: { modules: { purchasing: true } }, entitlements: { plan: 'starter', features: [] } }), false);
  });

  test('the three collections close the list, in contract order, each with a schema', () => {
    assert.deepEqual(COLLECTIONS.slice(-3), ['vendors', 'bills', 'purchaseOrders']);
    const index = JSON.parse(readFileSync(new URL('../js/schema/index.json', import.meta.url), 'utf8'));
    for (const c of ['vendors', 'bills', 'purchaseOrders']) {
      const s = schema(c);
      assert.equal(index.collections[c], `./${c}.json`);
      assert.equal(s.additionalProperties, true);
      assert.deepEqual(s.required, ['id']);
    }
    assert.deepEqual(schema('bills').properties.kind.enum, ['bill', 'receipt', null]);
    assert.deepEqual(schema('bills').properties.status.enum, ['draft', 'open', 'paid', 'void', null]);
    assert.deepEqual(schema('bills').properties.paidWith.enum, [...P.PAID_WITH, null]);
    assert.deepEqual(schema('bills').properties.lines.items.properties.costType.enum, [...P.COST_TYPES, null]);
    assert.deepEqual(schema('bills').properties.taxes.items.properties.id.enum, [...P.TAX_IDS, null]);
    assert.equal(schema('bills').properties.lines.maxItems, P.MAX_LINES);
    assert.deepEqual(schema('purchaseOrders').properties.status.enum, [...P.PO_STATUSES, null]);
    assert.equal(schema('vendors').properties.name.maxLength, 100);
  });
});
