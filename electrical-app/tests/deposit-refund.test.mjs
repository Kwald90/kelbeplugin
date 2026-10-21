// Refunding a deposit (invoices.js creditNoteForAmount, docs/releases/r1-get-paid.md 4.3, 4.4).
// A security deposit is invoiced tax-free (Excise Tax Act s.168(9)), so its refund credit note must
// also carry no tax. A prepayment deposit WAS taxed, so its refund credit note keeps the tax.
// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The invoices module pulls in the UI layer, which touches the DOM at import time.
globalThis.document ??= { addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} } }), querySelector: () => null, body: { appendChild() {} } };
globalThis.window ??= { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, location: { hash: '' } };
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };

const { depositInvoiceFields, depositInvoiceLine, docTotals } = await import('../js/lib/money.js');
const { taxComponents } = await import('../js/lib/tax.js');
const { creditNoteForAmount } = await import('../js/modules/invoices.js');

const mb = () => taxComponents({ province: 'MB', treatment: 'pst-all', date: '2026-10-20' });
// A store just rich enough for creditNoteForAmount: settings (for the credit note date/snapshot)
// and the next credit number.
const fakeStore = () => ({ settings: () => ({ province: 'MB', nextNumbers: { credit: 1001 } }), nextNumber: () => 'CR-1001' });
const taxSnap = { taxProvince: 'MB', taxTreatment: 'pst-all', taxes: mb() };

test('a security-deposit refund credit note carries no tax (it was invoiced tax-free)', () => {
  // $100.00 security deposit in Manitoba: line taxOff ['*'], zero GST/RST, total == face.
  const sec = { id: 'inv-sec', number: 'INV-3002', status: 'sent', ...taxSnap, ...depositInvoiceFields('security'), lines: [depositInvoiceLine({ cents: 10000, model: 'security', ref: 'E-1' })] };
  assert.equal(docTotals(sec).taxCents, 0, 'the deposit itself was charged no tax');
  assert.equal(docTotals(sec).totalCents, 10000);

  const note = creditNoteForAmount(fakeStore(), sec, 10000, { reason: 'deposit-refund', today: '2026-10-21' });
  const t = docTotals(note);
  assert.equal(t.taxCents, 0, 'the refund must not credit tax that was never charged');
  assert.equal(t.totalCents, -10000, 'the refund credit note totals the refund amount');
  assert.deepEqual(note.lines[0].taxOff, ['*'], 'the refund line mirrors the tax-free deposit line');
});

test('a prepayment-deposit refund credit note keeps the tax (it was taxed when invoiced)', () => {
  // $100.00 prepayment in Manitoba was invoiced with GST + RST ($112.00). A refund reverses that.
  const dep = { id: 'inv-dep', number: 'INV-3001', status: 'paid', ...taxSnap, ...depositInvoiceFields('prepayment'), lines: [depositInvoiceLine({ cents: 10000, model: 'prepayment', ref: 'E-1' })] };
  assert.equal(docTotals(dep).totalCents, 11200, 'the prepayment was taxed on the deposit invoice');

  const note = creditNoteForAmount(fakeStore(), dep, 11200, { reason: 'deposit-refund', today: '2026-10-21' });
  const t = docTotals(note);
  assert.equal(t.totalCents, -11200, 'the refund credit note totals the refund amount');
  assert.equal(t.taxCents, -1200, 'the refund reverses the GST + RST that was charged');
});
