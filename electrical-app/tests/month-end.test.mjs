// The month-end cutoff (js/lib/month-end.js, docs/releases/r1-get-paid.md 8.3): accrued payroll for hours
// in no exported run (vacation and holiday only when they accrue), the WIP and T&M revenue accruals,
// received not billed, the balances (holdback, deposits, on-account credit, disputes, self-assessed RST,
// bad-debt credit notes), inventory by location, and the journal with its named accounts.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/lib/month-end.js';

const dayOf = (iso) => String(iso).slice(0, 10);
const at = (d, h) => `${d}T${String(h).padStart(2, '0')}:00:00.000Z`;
const settings = { company: { province: 'MB' }, labourRateCents: 9000, markupPct: 0, payroll: { otRule: 'MB' }, costing: { statutoryPctFallback: 10, annualHours: 2000 } };
const sam = { id: 'sam', name: 'Sam', role: 'electrician', rateCents: 4000, burden: { vacationPct: 4, holidayPct: 4 } };
const entry = (id, d, o = {}) => ({ id, employeeId: 'sam', jobId: 'shop-time', clockIn: at(d, 13), clockOut: at(d, 21), breakMins: 0, approved: true, ...o });
const inv = (id, jobId, cents, o = {}) => ({ id, jobId, status: 'sent', issueDate: '2026-09-15', taxes: [], lines: [{ kind: 'other', qty: 1, unitCents: cents }], ...o });

const src = {
  asOf: '2026-09-30', settings, dayOf, now: Date.parse('2026-10-20T00:00:00Z'),
  employees: [sam],
  jobs: [
    { id: 'wa', number: 'J-1', status: 'in-progress', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 80000 } },
    { id: 'wb', number: 'J-2', status: 'in-progress', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 100000 },
      changeOrders: [{ id: 'co1', status: 'approved', approvedOn: '2026-09-15', amountCents: 5000, title: 'Extra pots' }] },
    { id: 'wt', number: 'J-3', status: 'in-progress', billingMode: 'tm' },
    { id: 'jw', number: 'J-4', status: 'in-progress', kind: 'warranty', billingMode: 'tm' },
  ],
  timeEntries: [
    entry('e1', '2026-09-29'), // exported in a run
    entry('e2', '2026-09-30'),
    entry('e3', '2026-10-01'), // after the cutoff
    entry('e4', '2026-09-30', { clockOut: null }), // still open
    { id: 'c1', kind: 'correction', correctsId: 'e1', workDay: '2026-09-30', adjustMinutes: 60, employeeId: 'sam', jobId: 'shop-time' },
    entry('t1', '2026-09-20', { employeeId: 'tom', jobId: 'wt', clockIn: at('2026-09-20', 13), clockOut: at('2026-09-20', 15) }),
  ],
  payrollRuns: [{ id: 'run1', status: 'exported', entryIds: ['e1'], exportedAt: '2026-10-02T12:00:00Z' }],
  bills: [
    { id: 'b1', status: 'open', date: '2026-09-10', lines: [{ costType: 'material', amountCents: 40000, jobId: 'wa' }], taxes: [] },
    { id: 'b2', status: 'open', date: '2026-09-10', lines: [{ costType: 'material', amountCents: 10000, jobId: 'wb' }], taxes: [] },
  ],
  purchaseOrders: [{ id: 'po1', number: 'PO-5001', status: 'open', date: '2026-09-10', lines: [{ itemId: 'i1', description: 'Wire', qty: 5, unitCents: 1000, receivedQty: 3, receivedAt: '2026-09-25T12:00:00Z' }] }],
  items: [{ id: 'i1', name: 'Wire', costCents: 1000, stock: { shop: 7 } }],
  locations: [{ id: 'shop', name: 'Shop', kind: 'shop' }],
  stockMoves: [{ id: 'mw', itemId: 'i1', fromLocationId: 'shop', qty: 1, jobId: 'jw', date: '2026-09-12', unitCostCents: 10000 }],
  invoices: [
    inv('ia', 'wa', 30000),
    inv('ib', 'wb', 50000),
    inv('prog', 'wb', 0, { kind: 'progress', lines: [], holdback: { pct: 10 } }),
    inv('hb', null, 100000, { kind: 'progress', holdback: { pct: 10 }, disputes: [{ id: 'd1', status: 'open', cents: 1200 }, { id: 'd2', status: 'won', cents: 99 }] }),
    inv('rel', null, 0, { kind: 'holdback-release', lines: [{ kind: 'other', lineType: 'holdback', qty: 1, unitCents: 4000 }] }),
    inv('dep', null, 0, { kind: 'deposit', depositModel: 'prepayment', lines: [{ kind: 'other', lineType: 'deposit', qty: 1, unitCents: 5000 }] }),
    inv('fin', null, 0, { lines: [{ kind: 'other', lineType: 'deposit', depositInvoiceId: 'dep', qty: 1, unitCents: -2000 }] }),
    inv('cr', null, 0, { kind: 'credit', creditReason: 'bad_debt', issueDate: '2026-09-10', number: 'CR-1001', lines: [{ kind: 'other', qty: 1, unitCents: -3000 }] }),
  ],
  payments: [
    { id: 'p1', invoiceId: null, clientId: 'c1', amountCents: 1500, date: '2026-09-20', method: 'cheque' },
    { id: 'p2', invoiceId: 'ia', appliedFromId: 'p1', amountCents: 500, date: '2026-09-21', method: 'cheque' },
  ],
  fieldTickets: [{ id: 'tk', status: 'signed', date: '2026-09-28' }, { id: 'tk2', status: 'billed', date: '2026-09-28' }],
};

describe('month-end cutoff', () => {
  const c = M.cutoff(src);

  test('accrued payroll: closed hours in no exported run, at the wage on the day plus burden; no vacation unless it accrues', () => {
    // e2 8 h + the correction's 1 h; e1 is in a run, e3 is after, e4 is open.
    const sam9 = c.accruedPayroll.rows.find((x) => x.employeeId === 'sam');
    assert.equal(sam9.minutes, 9 * 60);
    assert.equal(sam9.wagesCents, 9 * 4000);
    assert.equal(sam9.burdenCents, Math.round(9 * 4000 * 1.08 * 0.1));
    assert.equal(c.accruedPayroll.vacationCents, 0);
    const accrue = M.cutoff({ ...src, settings: { ...settings, payroll: { ...settings.payroll, vacationPayMode: 'accrue', holidayPayMode: 'accrue' } } });
    assert.equal(accrue.accruedPayroll.rows.find((x) => x.employeeId === 'sam').vacationCents, Math.round(9 * 4000 * 0.04));
    assert.equal(accrue.accruedPayroll.holidayCents, Math.round(9 * 4000 * 0.04));
  });

  test('revenue accruals from WIP and unbilled T&M; approved change orders listed, never added', () => {
    // wa: 40000 of 80000 = 50% of 100000 = 50000 earned, 30000 billed. wb: 10% of 105000, 50000 billed.
    assert.equal(c.accruedRevenue.wipUnderBilledCents, 20000);
    assert.equal(c.accruedRevenue.wipOverBilledCents, 50000 - 10500);
    assert.equal(c.accruedRevenue.tmUnbilledCents, 2 * 9000);
    assert.deepEqual(c.changeOrdersApprovedUnbilled.map((x) => [x.changeOrderId, x.amountCents]), [['co1', 5000]]);
  });

  test('received not billed, balances, inventory and tickets', () => {
    assert.equal(c.accruedCost.receivedNotBilledCents, 3000);
    assert.equal(c.holdbackReceivableCents, 10000 - 4000);
    assert.equal(c.depositsUnappliedCents, 5000 - 2000);
    assert.equal(c.onAccountCreditCents, 1500 - 500);
    assert.equal(c.disputedCents, 1200);
    assert.equal(c.rstSelfAssessCents, 700, 'warranty material self-assessed at 7%');
    assert.deepEqual(c.badDebtCreditNotes.map((x) => x.number), ['CR-1001']);
    assert.deepEqual(c.inventory, [{ locationId: 'shop', name: 'Shop', valueCents: 7 * 1000 }]);
    assert.equal(c.signedTicketsUnpriced, 1);
  });

  test('the journal names its accounts and balances', () => {
    const debit = c.journal.reduce((s, j) => s + j.debitCents, 0);
    const credit = c.journal.reduce((s, j) => s + j.creditCents, 0);
    assert.equal(debit, credit);
    const pair = (memo) => c.journal.filter((j) => j.memo.startsWith(memo)).map((j) => [j.account, j.debitCents, j.creditCents]);
    assert.deepEqual(pair('Under-billed'), [['Costs and estimated earnings in excess of billings', 20000, 0], ['Contract revenue', 0, 20000]]);
    assert.deepEqual(pair('Over-billed'), [['Contract revenue', 39500, 0], ['Billings in excess of costs and estimated earnings', 0, 39500]]);
    assert.deepEqual(pair('Time and material'), [['Accounts receivable, unbilled', 18000, 0], ['Contract revenue', 0, 18000]]);
    assert.deepEqual(pair('Material received'), [['Job cost', 3000, 0], ['Accrued liabilities', 0, 3000]]);
    assert.equal(pair('Hours worked')[0][0], 'Wages and burden');
    assert.deepEqual(pair('Self-assessed RST'), [['Expense or job cost', 700, 0], ['RST payable', 0, 700]]);
    const named = M.cutoff({ ...src, accounts: { revenue: '4100 Contract revenue' } });
    assert.ok(named.journal.some((j) => j.account === '4100 Contract revenue'), 'QuickBooks names replace the labels');
  });

  test('the CSV has every block', () => {
    const csv = M.cutoffCsv(c);
    for (const s of ['Accrued revenue', 'Received not billed', 'Accrued payroll', 'Holdback receivable', 'Inventory by location', 'Journal (suggested; reverse on the 1st)']) assert.ok(csv.includes(s), s);
  });
});
