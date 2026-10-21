// Run: node --test electrical-app/tests/
// Document money for Release 1 (docs/releases/r1-get-paid.md 2.6, 3.4, 3.6, 4.3, 7.3, 11):
// per-line taxOff, the out-of-pocket line, holdback and the taxes deferred to release, deposits,
// credit notes, revenue and the progress summary. Expected values worked by hand in the comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taxComponents, TAX_OFF_PRESETS } from '../js/lib/tax.js';
import * as M from '../js/lib/money.js';

const { docTotals } = M;
const mb = (date = '2026-10-20') => taxComponents({ province: 'MB', treatment: 'pst-all', date });
const lab = (cents, extra = {}) => ({ description: 'Labour', qty: 1, unitCents: cents, kind: 'labour', ...extra });
const mat = (cents, extra = {}) => ({ description: 'Material', qty: 1, unitCents: cents, kind: 'material', ...extra });
const oth = (cents, extra = {}) => ({ description: 'Other', qty: 1, unitCents: cents, kind: 'other', ...extra });
const passThrough = (cents) => { const { id, label, warning, printSuffix, ...p } = TAX_OFF_PRESETS[0]; return { description: 'Hotel, 2 nights', qty: 1, unitCents: cents, ...p }; };
const doc = (lines, extra = {}) => ({ taxProvince: 'MB', taxTreatment: 'pst-all', taxes: mb(), lines, ...extra });
const tax = (t, id) => t.taxes.find((x) => x.id === id);
/** A store that only lists payments, for invoiceStatus / invoiceShown. */
const storeWith = (payments) => ({ list: (coll, pred) => (coll === 'payments' ? payments.filter(pred || (() => true)) : []) });

test('lineTaxed: the kind decides, taxOff takes a tax off labour and other lines only', () => {
  const [gst, rst] = mb();
  assert.equal(M.lineTaxed(lab(100), rst), true);
  assert.equal(M.lineTaxed(lab(100, { taxOff: ['RST'] }), rst), false);
  assert.equal(M.lineTaxed(lab(100, { taxOff: ['RST'] }), gst), true);
  assert.equal(M.lineTaxed(oth(100, { taxOff: ['*'] }), gst), false);
  assert.equal(M.lineTaxed(mat(100, { taxOff: ['RST'] }), rst), true, 'material lines ignore taxOff');
  assert.equal(M.lineTaxed({ qty: 1, unitCents: 1 }, { id: 'GST', applies: { material: true, labour: false, other: false } }), true, 'no kind = material');
});

test('taxOff per line: RST off a labour line, everything off an other line', () => {
  // material $100 + labour $100 (no RST) + other $50 (no tax at all)
  // GST 5% × $200 = $10.00; RST 7% × $100 = $7.00; total $250 + $17 = $267.00
  const t = docTotals(doc([mat(10000), lab(10000, { taxOff: ['RST'] }), oth(5000, { taxOff: ['*'] })]));
  assert.equal(tax(t, 'GST').baseCents, 20000);
  assert.equal(tax(t, 'GST').cents, 1000);
  assert.equal(tax(t, 'RST').baseCents, 10000);
  assert.equal(tax(t, 'RST').cents, 700);
  assert.equal(t.totalCents, 26700);
});

test('the out-of-pocket line: GST only, outside the RST base and the holdback base', () => {
  assert.equal(TAX_OFF_PRESETS[0].kind, 'other');
  assert.deepEqual(TAX_OFF_PRESETS[0].taxOff, ['PST', 'RST']);
  // labour $1,000 + hotel $200: GST 5% × $1,200 = $60; RST 7% × $1,000 = $70
  const plain = docTotals(doc([lab(100000), passThrough(20000)]));
  assert.equal(plain.passThroughCents, 20000);
  assert.equal(tax(plain, 'GST').cents, 6000);
  assert.equal(tax(plain, 'RST').cents, 7000);
  assert.equal(plain.workSubtotalCents, 120000);
  assert.equal(plain.holdbackBaseCents, 100000, 'pass-through is out of the holdback base by default');
  // 10% holdback on the $1,000 of work, GST and RST deferred to release:
  // holdback $100; GST on $1,200 − $100 = $1,100 -> $55; RST on $1,000 − $100 = $900 -> $63
  // net $1,100 + $118 tax = $1,218
  const held = docTotals(doc([lab(100000), passThrough(20000)], { holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: true } }));
  assert.equal(held.holdbackCents, 10000);
  assert.equal(tax(held, 'GST').cents, 5500);
  assert.equal(tax(held, 'RST').cents, 6300);
  assert.equal(tax(held, 'RST').deferredCents, 10000);
  assert.equal(held.netSubtotalCents, 110000);
  assert.equal(held.totalCents, 121800);
  assert.equal(M.holdbackProblem(doc([lab(100000), passThrough(20000)], { holdback: { pct: 10, deferTaxIds: ['GST', 'RST'] } })), null);
  // With the pass-through line inside the base, RST would apply to some base lines and not others.
  const inside = doc([lab(100000), passThrough(20000)], { holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: false } });
  assert.equal(docTotals(inside).holdbackBaseCents, 120000);
  assert.equal(M.holdbackProblem(inside).code, 'holdback_tax_mixed');
  assert.equal(M.holdbackProblem(inside).taxId, 'RST');
});

test('holdback with deferred GST only, and with GST and RST', () => {
  // material $500 + labour $1,000 = $1,500; holdback 10% = $150
  const lines = [mat(50000), lab(100000)];
  // GST only deferred: GST 5% × $1,350 = $67.50; RST 7% × $1,500 = $105.00; net $1,350 -> $1,522.50
  const g = docTotals(doc(lines, { holdback: { pct: 10, deferTaxIds: ['GST'] } }));
  assert.equal(g.holdbackCents, 15000);
  assert.equal(tax(g, 'GST').cents, 6750);
  assert.equal(tax(g, 'RST').cents, 10500);
  assert.equal(g.totalCents, 152250);
  // GST and RST deferred: RST 7% × $1,350 = $94.50 -> $1,350 + $67.50 + $94.50 = $1,512.00
  const gr = docTotals(doc(lines, { holdback: { pct: 10, deferTaxIds: ['GST', 'RST'] } }));
  assert.equal(tax(gr, 'RST').cents, 9450);
  assert.equal(gr.totalCents, 151200);
  // A fixed amount wins over the percentage; nothing deferred leaves the taxes as without holdback.
  const fixed = docTotals(doc(lines, { holdback: { pct: 10, cents: 10000, deferTaxIds: [] } }));
  assert.equal(fixed.holdbackCents, 10000);
  assert.equal(tax(fixed, 'GST').cents, 7500);
  assert.equal(fixed.totalCents, 140000 + 7500 + 10500);
  // No holdback: the new keys are there and the totals are as before.
  const none = docTotals(doc(lines));
  assert.equal(none.holdbackCents, 0);
  assert.equal(none.netSubtotalCents, none.subtotalCents);
  assert.equal(none.totalCents, 150000 + 7500 + 10500);
});

test('holdbackSnapshot: deferred taxes and the pass-through policy from the rules', () => {
  const d = doc([lab(100000)]);
  assert.deepEqual(M.holdbackSnapshot(d, { pct: 10 }), { pct: 10, deferTaxIds: ['GST', 'RST'], excludePassThrough: true });
  // An accountant says RST is due at billing: a company rule (any of the three shapes the callers have)
  const off = { 'tax.MB.rstHoldbackAtRelease': false };
  assert.deepEqual(M.holdbackSnapshot(d, { pct: 10, rules: off }).deferTaxIds, ['GST']);
  assert.deepEqual(M.holdbackSnapshot(d, { pct: 10, rules: new Map([['tax.MB.rstHoldbackAtRelease', { value: false, status: 'verified' }]]) }).deferTaxIds, ['GST']);
  const rows = [
    { key: 'tax.MB.rstHoldbackAtRelease', province: 'MB', value: true, status: 'verify', origin: 'platform', effectiveFrom: '1900-01-01' },
    { key: 'tax.MB.rstHoldbackAtRelease', province: 'MB', value: false, status: 'sourced', origin: 'company', effectiveFrom: '1900-01-01' },
    { key: 'holdback.excludePassThrough', province: null, value: false, status: 'verified', origin: 'company' },
  ];
  assert.deepEqual(M.holdbackSnapshot(d, { pct: 10, rules: rows }), { pct: 10, deferTaxIds: ['GST'], excludePassThrough: false });
  // A policy with no value set falls back to the seeded default; a verify policy still applies.
  assert.deepEqual(M.policyRule([{ key: 'tax.MB.passThroughAllowed', value: null, status: 'verify' }], 'tax.MB.passThroughAllowed'), { value: true, status: null });
  assert.deepEqual(M.policyRule([{ key: 'tax.MB.passThroughAllowed', value: true, status: 'verify' }], 'tax.MB.passThroughAllowed'), { value: true, status: 'verify' });
  // RST charged on nothing (exempt work): only GST is deferred. HST provinces defer HST.
  const exempt = { taxProvince: 'MB', taxes: taxComponents({ province: 'MB', treatment: 'gst-only', date: '2026-10-20' }), lines: [] };
  assert.deepEqual(M.holdbackSnapshot(exempt, { pct: 10 }).deferTaxIds, ['GST']);
  const on = { taxProvince: 'ON', taxes: taxComponents({ province: 'ON', treatment: 'standard', date: '2026-10-20' }), lines: [] };
  assert.deepEqual(M.holdbackSnapshot(on, { pct: 10 }).deferTaxIds, ['HST']);
  // BC: PST deferral follows its own rule.
  const bc = { taxProvince: 'BC', taxes: taxComponents({ province: 'BC', treatment: 'tpp-service', date: '2026-10-20' }), lines: [] };
  assert.deepEqual(M.holdbackSnapshot(bc, { pct: 10, rules: { 'tax.BC.pstHoldbackAtRelease': false } }).deferTaxIds, ['GST']);
});

test('holdbackProblem: larger than the base, wrong kind, bad percentage, a tax on part of the base', () => {
  assert.equal(M.holdbackProblem(doc([lab(100000)])), null);
  assert.equal(M.holdbackProblem(doc([lab(100000)], { holdback: { pct: 10, cents: 150000, deferTaxIds: [] } })).code, 'holdback_exceeds_base');
  assert.equal(M.holdbackProblem(doc([lab(100000)], { holdback: { pct: 110, deferTaxIds: [] } })).code, 'holdback_pct');
  assert.equal(M.holdbackProblem(doc([oth(100000, { lineType: 'deposit' })], { kind: 'deposit', holdback: { pct: 10, deferTaxIds: [] } })).code, 'holdback_kind');
  // BC goods sold separately: PST on materials only, so deferring PST over material and labour is refused.
  const bc = { taxProvince: 'BC', taxTreatment: 'separate-goods', taxes: taxComponents({ province: 'BC', treatment: 'separate-goods', date: '2026-10-20' }), lines: [mat(50000), lab(50000)] };
  assert.equal(M.holdbackProblem({ ...bc, holdback: { pct: 10, deferTaxIds: ['GST', 'PST'] } }).code, 'holdback_tax_mixed');
  assert.equal(M.holdbackProblem({ ...bc, holdback: { pct: 10, deferTaxIds: ['GST'] } }), null);
});

test('deposits: a prepayment is taxed now, a security deposit is not; applications are not taxed twice', () => {
  // Prepayment of $1,000 in Manitoba: GST $50 + RST $70 = $1,120
  const dep = { id: 'inv-dep', number: 'INV-3001', status: 'paid', ...M.depositInvoiceFields('prepayment'), ...doc([M.depositInvoiceLine({ cents: 100000, model: 'prepayment', ref: 'E-2001' })]) };
  assert.equal(dep.kind, 'deposit');
  assert.equal(dep.lines[0].lineType, 'deposit');
  assert.equal(dep.lines[0].description, 'Deposit on E-2001');
  const dt = docTotals(dep);
  assert.equal(dt.depositCents, 100000);
  assert.equal(dt.workSubtotalCents, 0);
  assert.equal(dt.totalCents, 112000);
  // Security deposit: no tax until applied, the invoice says why (out of scope).
  const sec = { id: 'inv-sec', number: 'INV-3002', ...M.depositInvoiceFields('security'), ...doc([M.depositInvoiceLine({ cents: 100000, model: 'security' })]) };
  assert.equal(sec.taxNoneReason, 'out_of_scope');
  assert.deepEqual(sec.lines[0].taxOff, ['*']);
  assert.equal(docTotals(sec).totalCents, 100000);
  // Final invoice of $3,000 labour less the prepayment: tax on $2,000 ($100 GST + $140 RST) -> $2,240
  const fin = doc([lab(300000), M.depositApplicationLine(dep, 100000)]);
  assert.equal(fin.lines[1].unitCents, -100000);
  assert.equal(fin.lines[1].depositInvoiceId, 'inv-dep');
  const ft = docTotals(fin);
  assert.equal(ft.depositCents, -100000);
  assert.equal(ft.workSubtotalCents, 300000);
  assert.equal(ft.taxCents, 24000);
  assert.equal(ft.totalCents, 224000);
  // Less the security deposit instead: tax on the full $3,000 ($150 + $210) -> $2,000 + $360 = $2,360
  const fs = docTotals(doc([lab(300000), M.depositApplicationLine(sec, 100000)]));
  assert.equal(fs.taxCents, 36000);
  assert.equal(fs.totalCents, 236000);
  // A deposit line is never part of the holdback base.
  assert.equal(docTotals(doc([lab(300000), M.depositApplicationLine(dep, 100000)], { holdback: { pct: 10, deferTaxIds: [] } })).holdbackCents, 30000);
  // A prepayment applies only on the same tax set.
  assert.ok(M.sameTaxSet(dep, fin));
  assert.ok(!M.sameTaxSet(dep, { ...fin, taxTreatment: 'gst-only', taxes: taxComponents({ province: 'MB', treatment: 'gst-only', date: '2026-10-20' }) }));
  assert.ok(!M.sameTaxSet(dep, { ...fin, taxExemptBasis: 'subtrade', taxExemptNumber: '1234567' }));
});

test('holdback release line: taxed by the deferred taxes only', () => {
  // $150 held, GST deferred and RST charged at billing: the release charges GST only ($7.50)
  const line = M.holdbackReleaseLine(15000, { taxes: mb(), deferTaxIds: ['GST'] });
  assert.equal(line.lineType, 'holdback');
  assert.deepEqual(line.taxOff, ['RST']);
  const t = docTotals(doc([line], { kind: 'holdback-release' }));
  assert.equal(t.holdbackLineCents, 15000);
  assert.equal(t.workSubtotalCents, 0);
  assert.equal(t.totalCents, 15750);
  // Both deferred: nothing is switched off.
  assert.equal(M.holdbackReleaseLine(15000, { taxes: mb(), deferTaxIds: ['GST', 'RST'] }).taxOff, undefined);
});

test('credit notes keep the original tax snapshot (never re-rated), and carry a negative holdback', () => {
  // Invoiced in June 2019 at RST 8%: labour $1,000 -> GST $50 + RST $80 = $1,130
  const inv = { id: 'inv-1', number: 'INV-3005', issueDate: '2019-06-01', status: 'sent', clientId: 'c1', jobId: 'j1', ...doc([lab(100000)], { taxes: mb('2019-06-01') }), taxExemptBasis: null };
  assert.equal(docTotals(inv).totalCents, 113000);
  const note = M.creditNoteFrom(inv, { reason: 'price', today: '2026-10-20', settings: { nextNumbers: { credit: 1001 } } });
  assert.equal(note.kind, 'credit');
  assert.equal(note.number, 'CR-1001');
  assert.equal(note.issueDate, '2026-10-20');
  assert.equal(note.creditsInvoiceId, 'inv-1');
  assert.equal(note.creditReason, 'price');
  assert.equal(note.lines[0].unitCents, -100000);
  assert.equal(tax(docTotals(note), 'RST').pct, 8, 'the 2019 rate, not today’s 7%');
  assert.equal(docTotals(note).totalCents, -113000);
  assert.equal(note.creditTaxSnapshot.invoiceNumber, 'INV-3005');
  assert.equal(note.creditTaxSnapshot.invoiceDate, '2019-06-01');
  assert.equal(note.creditTaxSnapshot.taxes[1].pct, 8);
  assert.equal(M.invoiceKind(note), 'credit');
  assert.equal(M.creditNoteFrom(inv, { reason: 'nonsense' }).creditReason, 'other');
  assert.equal(M.creditNoteFrom(inv, { number: 'CR-77' }).number, 'CR-77');
  // Holdback: 10% of $2,000 = $200 held; crediting $500 of it gives −$50 of holdback.
  const held = { id: 'inv-2', number: 'INV-3006', issueDate: '2026-10-01', ...doc([lab(150000), lab(50000)], { holdback: { pct: 10, deferTaxIds: ['GST', 'RST'], retainedByCustomerCents: 0 } }) };
  assert.equal(docTotals(held).holdbackCents, 20000);
  const part = M.creditNoteFrom(held, { lines: [held.lines[1]], reason: 'dispute', today: '2026-10-20' });
  assert.equal(part.holdback.cents, -5000);
  assert.equal(part.holdback.retainedByCustomerCents, undefined);
  // −$500 + $50 = −$450 net; GST on −$450 = −$22.50; RST −$31.50 -> −$504.00
  const pt = docTotals(part);
  assert.equal(pt.holdbackCents, -5000);
  assert.equal(pt.netSubtotalCents, -45000);
  assert.equal(pt.totalCents, -50400);
  assert.equal(M.holdbackProblem(part), null);
});

test('creditNoteBalance and the status of a credit note: open, then applied, never paid', () => {
  const note = { id: 'cr-1', kind: 'credit', status: 'sent', ...doc([lab(-100000)]) }; // −$1,120
  assert.equal(M.creditNoteBalance(note, []), -112000);
  const partly = [{ id: 'p1', method: 'credit-note', creditNoteId: 'cr-1', invoiceId: 'inv-1', amountCents: 60000 }, { id: 'p2', invoiceId: 'inv-1', amountCents: 5000 }];
  assert.equal(M.creditNoteBalance(note, partly), -52000);
  assert.equal(M.invoiceStatus(storeWith(partly), note), 'open');
  assert.deepEqual(M.invoiceShown(storeWith(partly), note), { status: 'open', balanceCents: -52000 });
  const full = [...partly, { id: 'p3', method: 'credit-note', creditNoteId: 'cr-1', invoiceId: 'inv-1', amountCents: 52000 }];
  assert.equal(M.creditNoteBalance(note, full), 0);
  assert.equal(M.invoiceStatus(storeWith(full), note), 'applied');
  assert.equal(M.invoiceStatus(storeWith([]), { ...note, status: 'draft' }), 'draft');
  // On the original invoice the application counts as paid (payments sum by invoiceId).
  const orig = { id: 'inv-1', status: 'sent', ...doc([lab(100000)]) };
  assert.equal(M.invoiceStatus(storeWith(full.filter((p) => p.creditNoteId)), orig), 'paid');
});

test('revenueCents per kind: work lines gross of holdback; never deposits, releases or interest', () => {
  // material $500 + 10% markup $50 + labour $1,000 + hotel $200, 10% holdback -> revenue $1,750
  const std = { status: 'sent', ...doc([mat(50000), lab(100000), passThrough(20000)], { markupPct: 10, holdback: { pct: 10, deferTaxIds: ['GST'] } }) };
  assert.equal(M.revenueCents(std), 175000);
  assert.equal(M.revenueCents({ ...std, kind: 'progress' }), 175000);
  assert.equal(M.revenueCents({ ...std, status: 'draft' }), 0);
  assert.equal(M.revenueCents({ ...std, status: 'void' }), 0);
  // Less an applied deposit: the deposit line is not revenue.
  assert.equal(M.revenueCents({ status: 'sent', ...doc([lab(300000), oth(-100000, { lineType: 'deposit', depositInvoiceId: 'd' })]) }), 300000);
  const dep = { status: 'paid', ...M.depositInvoiceFields('prepayment'), ...doc([M.depositInvoiceLine({ cents: 100000 })]) };
  assert.equal(M.revenueCents(dep), 0);
  assert.equal(M.revenueCents({ ...dep, forfeitedOn: '2026-10-15' }), 100000, 'a forfeited prepayment is revenue');
  assert.equal(M.revenueCents({ ...dep, forfeitedOn: '2026-10-15' }, { asOf: '2026-09-30' }), 0);
  assert.equal(M.revenueCents({ ...dep, depositModel: 'security', forfeitedOn: '2026-10-15' }), 0, 'a forfeited security deposit is flagged for the accountant, not revenue');
  assert.equal(M.revenueCents({ status: 'sent', kind: 'holdback-release', ...doc([M.holdbackReleaseLine(15000, { taxes: mb(), deferTaxIds: ['GST', 'RST'] })]) }), 0);
  assert.equal(M.revenueCents({ status: 'sent', kind: 'interest', ...doc([oth(1500, { lineType: 'interest' })]) }), 0);
  assert.equal(M.revenueCents({ status: 'sent', kind: 'credit', ...doc([lab(-35000)]) }), -35000, 'a back-charge reduces revenue');
});

test('progressSummary: contract and change orders, previously billed, holdback retained, balance to finish', () => {
  const job = {
    id: 'j1', contract: { valueCents: 1000000, holdbackPct: 10 },
    changeOrders: [
      { id: 'co1', status: 'approved', amountCents: 50000, approvedOn: '2026-09-01' },
      { id: 'co2', status: 'pending', amountCents: 99900 },
      { id: 'co3', status: 'approved', amountCents: 70000, approvedOn: '2026-11-01' },
    ],
  };
  const hb = { pct: 10, deferTaxIds: ['GST', 'RST'] };
  const p1 = { id: 'p1', number: 'INV-3001', jobId: 'j1', kind: 'progress', status: 'sent', issueDate: '2026-08-01', ...doc([lab(300000)], { holdback: hb }) };
  const cr = { id: 'cr', number: 'CR-1001', jobId: 'j1', kind: 'credit', status: 'sent', issueDate: '2026-09-15', ...doc([lab(-10000)], { holdback: { ...hb, cents: -1000 } }) };
  const draft = { id: 'd', number: 'INV-3009', jobId: 'j1', status: 'draft', issueDate: '2026-09-20', ...doc([lab(999900)]) };
  const other = { id: 'o', number: 'INV-3008', jobId: 'j2', status: 'sent', issueDate: '2026-09-20', ...doc([lab(999900)]) };
  const kept = { id: 'k', number: 'INV-3002', jobId: 'j1', status: 'sent', issueDate: '2026-08-15', ...doc([lab(100000)]), holdback: { retainedByCustomerCents: 10000 } };
  const p2 = { id: 'p2', number: 'INV-3010', jobId: 'j1', kind: 'progress', status: 'draft', issueDate: '2026-10-01', ...doc([lab(200000)], { holdback: hb }) };
  const later = { id: 'l', number: 'INV-3011', jobId: 'j1', status: 'sent', issueDate: '2026-10-05', ...doc([lab(100000)]) };
  const s = M.progressSummary(p2, { job, invoices: [p1, cr, draft, other, kept, p2, later] });
  // contract $10,000 + CO $500 (the pending one and the one approved after this invoice don't count)
  assert.equal(s.contractCents, 1050000);
  assert.equal(s.changeOrdersCents, 50000);
  // previously billed: $3,000 − $100 credit + $1,000 = $3,900; this invoice $2,000
  assert.equal(s.previousCents, 390000);
  assert.equal(s.thisCents, 200000);
  assert.equal(s.billedToDateCents, 590000);
  // holdback: $300 − $10 + $100 kept by the GC + $200 on this invoice = $590
  assert.equal(s.holdbackRetainedCents, 59000);
  assert.equal(s.balanceToFinishCents, 460000);
  assert.equal(s.pctBilled, 56.2);
  // A release invoice reduces what is retained.
  const rel = { id: 'r', number: 'INV-3003', jobId: 'j1', kind: 'holdback-release', status: 'sent', issueDate: '2026-09-30', ...doc([M.holdbackReleaseLine(30000, { taxes: mb(), deferTaxIds: ['GST', 'RST'] })]) };
  const s2 = M.progressSummary(p2, { job, invoices: [p1, cr, kept, rel] });
  assert.equal(s2.holdbackReleasedCents, 30000);
  assert.equal(s2.holdbackRetainedCents, 29000);
  assert.equal(s2.previousCents, 390000, 'the release is not billed again');
  assert.equal(M.progressSummary(p2, { job: { id: 'j1' }, invoices: [] }), null, 'no contract value, no block');
});

test('each tax is rounded once per document, with taxOff and holdback too', () => {
  // three 33 ¢ labour lines: GST 99 ¢ × 5% = 4.95 ¢ -> 5 ¢ (per line: 2 + 2 + 2 = 6); RST 6.93 ¢ -> 7 ¢
  const t = docTotals(doc([lab(33), lab(33), lab(33)]));
  assert.equal(tax(t, 'GST').cents, 5);
  assert.equal(tax(t, 'RST').cents, 7);
  // one of them without RST: RST on 66 ¢ = 4.62 ¢ -> 5 ¢
  assert.equal(tax(docTotals(doc([lab(33), lab(33), lab(33, { taxOff: ['RST'] })])), 'RST').cents, 5);
  // 10% holdback on $10.01 = $1.001 -> $1.00; GST on $9.01 = 45.05 ¢ -> 45 ¢
  const h = docTotals(doc([lab(1001)], { holdback: { pct: 10, deferTaxIds: ['GST'] } }));
  assert.equal(h.holdbackCents, 100);
  assert.equal(tax(h, 'GST').cents, 45);
});

test('invoiceKind defaults to standard', () => {
  assert.equal(M.invoiceKind({}), 'standard');
  assert.equal(M.invoiceKind({ kind: 'deposit' }), 'deposit');
  assert.equal(M.invoiceKind({ kind: 'weird' }), 'standard');
  assert.equal(M.invoiceKind(null), 'standard');
});
