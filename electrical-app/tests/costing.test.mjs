// Job costing that tells the truth (js/lib/costing.js, docs/releases/r1-get-paid.md 6, 11): labour at
// the rate on the entry's day with the overtime premium on the entries that crossed, corrections,
// trucks once per truck and day, equipment use without ticket double counts, bills by tax use with
// supplier credits by job, returns netted, requests counted once, received not billed, committed,
// price variances, contract value with a superseded revision, the budget at the burdened rate, and
// WIP (over and under billed, loss provision, percent complete capped at 1, T&M, completed contracts).
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/lib/costing.js';
import { jobCosting } from '../js/lib/tm.js';

const dayOf = (iso) => String(iso).slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const at = (d, h, m = 0) => `${d}T${pad(h)}:${pad(m)}:00.000Z`;
const settings = { company: { province: 'MB' }, payroll: { otRule: 'MB' }, labourRateCents: 9000, markupPct: 0, costing: { annualHours: 2000, nonProductivePctDefault: 10, priceVariancePct: 2 } };
const job = { id: 'j1', number: 'J-1', title: 'Clinic', status: 'in-progress', billingMode: 'fixed', changeOrders: [] };
const sam = { id: 'sam', name: 'Sam', role: 'electrician', rateCents: 5000, rateHistory: [{ from: '2026-01-01', rateCents: 4000 }, { from: '2026-11-01', rateCents: 5000 }] };
const ana = { id: 'ana', name: 'Ana', role: 'apprentice', rateCents: 2500 };
const employees = [sam, ana];
const work = (id, emp, d, inH, outH, o = {}) => ({ id, employeeId: emp, jobId: 'j1', clockIn: at(d, inH), clockOut: at(d, outH), breakMins: 0, approved: true, ...o });
const base = { job, settings, employees, dayOf, now: Date.parse('2026-12-01T00:00:00Z') };

describe('labour', () => {
  test("the rate on the entry's day: a raise in November leaves September's cost unchanged", () => {
    const a = C.jobActuals({ ...base, timeEntries: [work('t1', 'sam', '2026-09-15', 8, 16), work('t2', 'sam', '2026-11-03', 8, 16)] });
    assert.equal(a.labourWageCents, 8 * 4000 + 8 * 5000);
    assert.equal(a.otPremiumCents, 0, 'eight hours is not overtime in Manitoba');
    assert.equal(a.burdenMissing, true, 'no burden data: the bare wage');
    assert.equal(a.labourCents, a.labourWageCents);
    const sept = C.jobActuals({ ...base, asOf: '2026-09-30', timeEntries: [work('t1', 'sam', '2026-09-15', 8, 16), work('t2', 'sam', '2026-11-03', 8, 16)] });
    assert.equal(sept.labourWageCents, 32000, 'September as of the 30th');
  });

  test('the overtime premium lands on the entry that crossed the daily threshold, in time order, across jobs', () => {
    const entries = [work('a', 'sam', '2026-09-19', 8, 14, { jobId: 'j2' }), work('b', 'sam', '2026-09-19', 14, 18)];
    const j1 = C.jobActuals({ ...base, timeEntries: entries });
    assert.equal(j1.labourWageCents, 4 * 4000);
    assert.equal(j1.otPremiumCents, 2 * 0.5 * 4000, 'the last 2 of 10 hours are overtime');
    const j2 = C.jobActuals({ ...base, job: { ...job, id: 'j2' }, timeEntries: entries });
    assert.equal(j2.otPremiumCents, 0, 'the first job of the day carries no premium');
  });

  test('burden at the flat fallback, with vacation and holiday pay; the premium carries the statutory %', () => {
    const s = { ...settings, costing: { ...settings.costing, statutoryPctFallback: 10 } };
    const emp = { ...sam, burden: { vacationPct: 4, holidayPct: 4 } };
    const entries = [work('a', 'sam', '2026-09-19', 8, 14, { jobId: 'j2' }), work('b', 'sam', '2026-09-19', 14, 18)];
    const a = C.jobActuals({ ...base, settings: s, employees: [emp], timeEntries: entries });
    const perHour = Math.round(4000 * 1.08 * 1.1);
    assert.equal(a.labourWageCents, 16000);
    assert.equal(a.burdenCents, 4 * (perHour - 4000));
    assert.equal(a.otPremiumCents, Math.round(2 * 0.5 * 4000 * 1.1));
    assert.equal(a.burdenMissing, false);
    assert.equal(a.labourCents, a.labourWageCents + a.burdenCents + a.otPremiumCents);
  });

  test('a correction counts at the rate on its work day; a negative one reduces cost', () => {
    const a = C.jobActuals({ ...base, timeEntries: [work('t1', 'sam', '2026-09-15', 8, 16),
      { id: 'c1', kind: 'correction', correctsId: 't1', workDay: '2026-09-15', adjustMinutes: -60, employeeId: 'sam', jobId: 'j1' }] });
    assert.equal(a.labourWageCents, 7 * 4000);
    assert.equal(a.hours, 7);
  });

  test('cost codes: actual cost and hours per code, "none" when a record has no code', () => {
    const a = C.jobActuals({ ...base, timeEntries: [work('t1', 'sam', '2026-09-15', 8, 12, { costCodeId: 'cc-rough' }), work('t2', 'sam', '2026-09-16', 8, 10)] });
    assert.deepEqual(a.byCostCode['cc-rough'], { estCents: 0, actualCents: 16000, hours: 4 });
    assert.equal(a.byCostCode.none.actualCents, 8000);
  });
});

describe('trucks and equipment', () => {
  const equipment = [
    { id: 'truck1', name: 'Truck 1', kind: 'truck', rateCents: 2500, rateUnit: 'hour', rateHistory: [{ from: '2026-01-01', rateCents: 2000, rateUnit: 'hour' }, { from: '2026-12-01', rateCents: 2500, rateUnit: 'hour' }] },
    { id: 'truck2', name: 'Truck 2', kind: 'truck', rateCents: 9500, rateUnit: 'day' },
    { id: 'gen1', name: 'Generator', kind: 'equipment', rateCents: 1500, rateUnit: 'hour' },
  ];

  test('an hour-rate truck is charged on the union of the intervals: two people in one truck count once', () => {
    const entries = [work('s', 'sam', '2026-09-16', 8, 16, { equipmentId: 'truck1' }), work('a', 'ana', '2026-09-16', 10, 18, { equipmentId: 'truck1' })];
    const rows = C.truckCharges({ timeEntries: entries, equipment, dayOf });
    assert.equal(rows.reduce((s, x) => s + x.cents, 0), 10 * 2000, '08:00 to 18:00 at the rate in force that day');
    const a = C.jobActuals({ ...base, equipment, timeEntries: entries });
    assert.equal(a.truckCents, 20000);
  });

  test('a day-rate truck is charged once a day, split across the day’s jobs by hours', () => {
    const entries = [work('s1', 'sam', '2026-09-17', 8, 12, { equipmentId: 'truck2' }), work('s2', 'sam', '2026-09-17', 13, 17, { equipmentId: 'truck2', jobId: 'j3' })];
    const a = C.jobActuals({ ...base, equipment, timeEntries: entries });
    assert.equal(a.truckCents, 4750);
    const all = C.truckCharges({ timeEntries: entries, equipment, dayOf });
    assert.equal(all.reduce((s, x) => s + x.cents, 0), 9500, 'once for the day');
  });

  test('equipment use at the rate on the day; a ticket’s record for a truck already on the clock is ignored', () => {
    const entries = [work('s', 'sam', '2026-09-16', 8, 16, { equipmentId: 'truck1' })];
    const equipmentUse = [
      { id: 'u1', equipmentId: 'truck1', jobId: 'j1', date: '2026-09-16', qty: 1, unit: 'day', source: 'ticket' },
      { id: 'u2', equipmentId: 'gen1', jobId: 'j1', date: '2026-09-16', qty: 3, unit: 'hour', source: 'manual' },
      { id: 'u3', equipmentId: 'truck2', jobId: 'j1', date: '2026-09-18', qty: 4, unit: 'hour', source: 'ticket' },
    ];
    const a = C.jobActuals({ ...base, equipment, equipmentUse, timeEntries: entries });
    assert.equal(a.truckCents, 8 * 2000);
    assert.equal(a.equipmentUseCents, 16000 + 4500 + Math.round((4 / 8) * 9500), 'the ticket record for truck 2 counts: it was not on a time entry that day');
  });

  test('recovery against actual per truck: charges against fuel and repair bills', () => {
    const entries = [work('s', 'sam', '2026-09-16', 8, 16, { equipmentId: 'truck1' })];
    const bills = [{ id: 'fuel', status: 'paid', date: '2026-09-20', lines: [{ costType: 'other', amountCents: 9000, equipmentId: 'truck1' }], taxes: [] }];
    const rows = C.equipmentRecovery({ equipment, timeEntries: entries, bills, from: '2026-01-01', to: '2026-12-31', dayOf });
    const t1 = rows.find((x) => x.equipmentId === 'truck1');
    assert.equal(t1.recoveredCents, 16000);
    assert.equal(t1.actualCents, 9000);
    assert.equal(t1.differenceCents, 7000);
  });
});

describe('bills, stock and requests', () => {
  const vendors = [{ id: 'v1', name: 'Wholesaler' }, { id: 'v2', name: 'Mech Sub', meSubtrade: true }, { id: 'v3', name: 'Painter' }];
  const items = [{ id: 'i1', name: 'Wire', costCents: 1000, avgCostCents: 900 }];
  const purchaseOrders = [
    { id: 'po1', number: 'PO-5001', jobId: 'j1', status: 'open', date: '2026-09-10', lines: [
      { itemId: 'i1', description: 'Wire', qty: 10, unitCents: 1500, receivedQty: 6, receivedAt: '2026-09-22T15:00:00Z', materialRequestIds: ['r4'] },
      { description: 'Boxes', qty: 4, unitCents: 500 },
    ] },
    { id: 'po2', number: 'PO-5002', jobId: 'j1', status: 'open', date: '2026-09-10', lines: [{ itemId: 'i1', description: 'Wire for stock', qty: 5, unitCents: 800, receivedQty: 5 }] },
  ];
  const bills = [
    { id: 'b1', vendorId: 'v1', status: 'open', date: '2026-09-20', jobId: 'j1', materialRequestIds: ['r1'], lines: [{ costType: 'material', qty: 10, unitCents: 1000, amountCents: 10000 }], taxes: [{ id: 'GST', cents: 500 }, { id: 'RST', cents: 700 }] },
    { id: 'b2', kind: 'receipt', vendorId: 'v3', status: 'paid', date: '2026-09-21', lines: [{ costType: 'other', amountCents: 5000, jobId: 'j1' }], taxes: [{ id: 'GST', cents: 250 }, { id: 'RST', cents: 350 }] },
    { id: 'b3', vendorId: 'v2', status: 'open', date: '2026-09-21', lines: [{ costType: 'subcontract', amountCents: 20000, jobId: 'j1' }], taxes: [{ id: 'RST', cents: 1400 }] },
    { id: 'b4', vendorId: 'v1', status: 'paid', date: '2026-09-21', jobId: 'j1', lines: [{ costType: 'other', amountCents: 8000, equipmentId: 'truck1' }], taxes: [] },
    { id: 'b5', vendorId: 'v1', status: 'open', date: '2026-09-25', reversesId: 'b1', lines: [{ costType: 'material', qty: -2, unitCents: 1000, amountCents: -2000 }], taxes: [{ id: 'RST', cents: -140 }] },
    { id: 'b6', vendorId: 'v1', status: 'draft', date: '2026-09-21', jobId: 'j1', lines: [{ costType: 'material', amountCents: 99999 }], taxes: [] },
    { id: 'b7', vendorId: 'v1', status: 'open', date: '2026-09-23', lines: [{ costType: 'material', qty: 5, unitCents: 800, amountCents: 4000, jobId: 'j1', poLine: { purchaseOrderId: 'po2', index: 0 } }], taxes: [] },
    { id: 'b8', vendorId: 'v1', status: 'open', date: '2026-09-23', lines: [{ costType: 'material', qty: 4, unitCents: 500, amountCents: 2000, jobId: 'j1', poLine: { purchaseOrderId: 'po1', index: 1 } }], taxes: [] },
  ];
  const stockMoves = [
    { id: 'm1', itemId: 'i1', fromLocationId: 'van', toLocationId: null, qty: 5, jobId: 'j1', date: '2026-09-12', unitCostCents: 1200 },
    { id: 'm2', itemId: 'i1', fromLocationId: null, toLocationId: 'van', qty: 2, jobId: 'j1', date: '2026-09-14', unitCostCents: 1200 },
    { id: 'm3', itemId: 'i1', fromLocationId: 'van', toLocationId: null, qty: 1, jobId: 'j1', date: '2026-09-14' },
    { id: 'm4', itemId: 'i1', fromLocationId: 'shop', toLocationId: 'van', qty: 30, jobId: 'j1', date: '2026-09-14' },
    { id: 'rcv', itemId: 'i1', fromLocationId: null, toLocationId: 'shop', qty: 5, use: 'receive', poId: 'po2', poLineIndex: 0, unitCostCents: 800, date: '2026-09-15' },
  ];
  const materialRequests = [
    { id: 'r1', jobId: 'j1', itemId: 'i1', qty: 10, status: 'fulfilled', fulfilledAt: '2026-09-20T12:00:00Z' },
    { id: 'r2', jobId: 'j1', itemId: 'i1', qty: 5, status: 'fulfilled', fulfilledAt: '2026-09-12T12:00:00Z', stockMoveId: 'm1' },
    { id: 'r3', jobId: 'j1', description: 'Fitting', qty: 2, costCents: 300, status: 'fulfilled', fulfilledAt: '2026-09-13T12:00:00Z' },
    { id: 'r4', jobId: 'j1', itemId: 'i1', qty: 10, status: 'fulfilled', fulfilledAt: '2026-09-22T12:00:00Z' },
  ];
  const src = { ...base, vendors, items, purchaseOrders, bills, stockMoves, materialRequests };

  test('bills by tax use: resale RST is not cost, own-use RST is; trucks and stock receipts are not job cost; credits follow the job', () => {
    const a = C.jobActuals(src);
    // b1 10000 (RST 700 recoverable) + b2 5000 + 350 + b3 20000 (an M&E subtrade: resale) - b5 2000 + b8 2000.
    assert.equal(a.billsCents, 10000 + 5350 + 20000 - 2000 + 2000);
    assert.equal(a.subcontractCents, 20000);
    assert.equal(a.otherCents, 5350);
    assert.equal(a.byType.material, 10000 - 2000 + 2000 + a.materialCents);
  });

  test('writing off a resale RST credit moves it into cost', () => {
    const off = bills.map((b) => (b.id === 'b1' ? { ...b, lines: [{ ...b.lines[0], resaleCreditWrittenOff: { by: 'Dana', at: '2026-10-01' } }] } : b));
    assert.equal(C.jobActuals({ ...src, bills: off }).billsCents, C.jobActuals(src).billsCents + 700);
  });

  test('stock at the stamped cost, returns netted, requests counted once', () => {
    const a = C.jobActuals(src);
    // m1 5 x 12.00, m2 returned 2 x 12.00, m3 1 at the average 9.00 (no stamp); m4 is a transfer.
    // r1 is on bill b1, r2 is m1, r4 is on PO po1: only r3 (2 x 3.00) counts.
    assert.equal(a.returnsCents, 2400);
    assert.equal(a.materialCents, 6000 - 2400 + 900 + 600);
  });

  test('received not billed is accrued; committed is shown, never added', () => {
    const a = C.jobActuals(src);
    assert.equal(a.accruedCents, 6 * 1500, 'po1 line 1: 6 received, none billed');
    assert.deepEqual(a.accrued.map((x) => [x.purchaseOrderId, x.index, x.qty]), [['po1', 0, 6]]);
    assert.equal(a.committedCents, 4 * 1500, 'po1 line 1: 4 still to come; line 2 billed without receipt');
    assert.equal(a.costCents, a.labourCents + a.materialCents + a.billsCents + a.equipmentUseCents + a.accruedCents);
    const early = C.jobActuals({ ...src, asOf: '2026-09-20' });
    assert.equal(early.accruedCents, 0, 'received on the 22nd');
    assert.equal(early.billsCents, 10000);
  });

  test('a receive move straight to the job is accrued until its bill arrives, never counted twice', () => {
    const po = { id: 'po3', number: 'PO-5003', jobId: 'j1', status: 'sent', date: '2026-09-10', lines: [{ itemId: 'i1', description: 'Wire', qty: 4, unitCents: 1000 }] };
    const rcv = { id: 'rj', itemId: 'i1', jobId: 'j1', fromLocationId: null, toLocationId: null, qty: 4, use: 'receive', poId: 'po3', poLineIndex: 0, unitCostCents: 1000, date: '2026-09-11' };
    const before = C.jobActuals({ ...base, purchaseOrders: [po], stockMoves: [rcv] });
    assert.equal(before.accruedCents, 4000);
    assert.equal(before.costCents, 4000);
    const bill = { id: 'bx', status: 'open', date: '2026-09-12', lines: [{ costType: 'material', qty: 4, unitCents: 1050, amountCents: 4200, jobId: 'j1', poLine: { purchaseOrderId: 'po3', index: 0 } }], taxes: [] };
    const after = C.jobActuals({ ...base, purchaseOrders: [po], stockMoves: [rcv], bills: [bill] });
    assert.equal(after.accruedCents, 0);
    assert.equal(after.costCents, 4200, 'the bill replaces the accrual at its own price');
  });

  test('own-use material on a warranty job carries self-assessed RST', () => {
    const jw = { id: 'jw', kind: 'warranty', status: 'in-progress' };
    const a = C.jobActuals({ ...base, job: jw, stockMoves: [{ id: 'mw', itemId: 'i1', fromLocationId: 'van', qty: 1, jobId: 'jw', date: '2026-09-10', unitCostCents: 10000 }], items });
    assert.equal(a.selfAssessedRstCents, 700);
    assert.equal(a.materialCents, 10700);
  });
});

describe('price variances', () => {
  const purchaseOrders = [{ id: 'po1', lines: [{ unitCents: 1000, quoteRef: 'Q-77' }] }];
  const items = [{ id: 'i2', costCents: 2000 }];
  test('above the PO (a job quote) or the price book by more than 2% and $1.00 is flagged', () => {
    const bill = { lines: [
      { qty: 10, unitCents: 1050, amountCents: 10500, poLine: { purchaseOrderId: 'po1', index: 0 } }, // 5%, $5.00
      { qty: 1, unitCents: 2030, amountCents: 2030, itemId: 'i2' }, // 1.5%
      { qty: 100, unitCents: 2050, amountCents: 205000, itemId: 'i2' }, // 2.5%, $50.00
      { qty: 1, unitCents: 2100, amountCents: 2100, itemId: 'i2' }, // 5% but only $1.00
      { qty: 1, unitCents: 999, amountCents: 999 }, // no reference
    ] };
    const v = C.priceVariances(bill, { purchaseOrders, items, tolerancePct: 2 });
    assert.deepEqual(v.map((x) => [x.lineIndex, x.refKind, x.overCents]), [[0, 'po', 500], [2, 'price-book', 5000]]);
    assert.equal(v[0].quoteRef, 'Q-77');
    assert.equal(v[0].overPct, 5);
  });
  test('a job counts bills with unacknowledged variances', () => {
    const b = { id: 'b', status: 'open', jobId: 'j1', lines: [{ qty: 10, unitCents: 1050, amountCents: 10500, poLine: { purchaseOrderId: 'po1', index: 0 } }] };
    assert.equal(C.jobVarianceCount('j1', { bills: [b], purchaseOrders }), 1);
    assert.equal(C.jobVarianceCount('j1', { bills: [{ ...b, varianceAck: { by: 'Dana', at: '2026-10-01' } }], purchaseOrders }), 0);
  });
});

describe('contract value and budget', () => {
  const estimates = [
    { id: 'e1', jobId: 'j1', status: 'superseded', lines: [{ kind: 'other', qty: 1, unitCents: 100000 }] },
    { id: 'e2', jobId: 'j1', status: 'accepted', revisionOf: 'e1', signedAt: '2026-09-01T12:00:00Z', lines: [{ kind: 'other', qty: 1, unitCents: 120000 }] },
    { id: 'e3', jobId: 'j1', status: 'declined', lines: [{ kind: 'other', qty: 1, unitCents: 999999 }] },
  ];
  const withCos = { ...job, changeOrders: [{ id: 'co1', status: 'approved', approvedOn: '2026-09-15', amountCents: 10000 }, { id: 'co2', status: 'approved', approvedOn: '2026-10-15', amountCents: 5000 }, { id: 'co3', status: 'pending', amountCents: 9999 }] };

  test('the latest accepted estimate that is not superseded, plus change orders approved by asOf', () => {
    assert.equal(C.contractValue(withCos, estimates, { asOf: '2026-09-30' }), 130000);
    assert.equal(C.contractValue(withCos, estimates), 135000);
    // The original still marked accepted: its accepted revision replaces it.
    assert.equal(C.contractValue(job, [{ ...estimates[0], status: 'accepted', signedAt: '2026-08-01' }, estimates[1]]), 120000);
    assert.equal(C.contractValue({ ...withCos, contract: { valueCents: 200000 } }, estimates, { asOf: '2026-09-30' }), 210000, 'a typed contract value wins');
  });

  test('the budget prices labour at the burdened cost per productive hour', () => {
    const s = { ...settings, costing: { ...settings.costing, statutoryPctFallback: 10 } };
    const crew = [{ id: 'x', role: 'electrician', rateCents: 4000, burden: { vacationPct: 0, holidayPct: 0 } }, { id: 'o', role: 'office', rateCents: 9000 }];
    const est = { id: 'e9', markupPct: 10, lines: [
      { kind: 'labour', qty: 10, unitCents: 9500, costCodeId: 'cc1' },
      { kind: 'material', itemId: 'i1', qty: 20, unitCents: 2500, labourHours: 0.5, costCodeId: 'cc2' },
      { kind: 'other', qty: 1, unitCents: 11000, costType: 'subcontract' },
    ] };
    const b = C.budgetFromEstimate(est, { items: [{ id: 'i1', costCents: 1000 }], employees: crew, settings: s, on: '2026-09-01' });
    const rate = Math.round((4000 * 1.1 * 2000) / (2000 * 0.9));
    assert.equal(b.labourRateCents, rate, 'field roles only; office wages are overhead');
    assert.equal(b.labourHours, 20);
    assert.equal(b.labourCostCents, 20 * rate);
    assert.equal(b.materialCents, 20000);
    assert.equal(b.subCents, 10000, 'a subcontract line at its price over 1 + markup');
    assert.deepEqual(b.byCostCode.cc1, { estCents: 10 * rate, hours: 10 });
    assert.deepEqual(b.byCostCode.cc2, { estCents: 20000 + 10 * rate, hours: 10 });
    assert.equal(C.budgetTotal(b), 20 * rate + 20000 + 10000);
  });

  test('estimated cost: the stored budget, plus change-order budgets; an override wins', () => {
    const budget = { estimateId: 'e2', labourHours: 10, labourCostCents: 50000, materialCents: 30000, subCents: 0, equipmentCents: 0, otherCents: 0 };
    const j = { ...withCos, costing: { budget }, changeOrders: [{ id: 'co1', status: 'approved', amountCents: 12000 }, { id: 'co2', status: 'approved', amountCents: 6000, estCostCents: 1000 }] };
    const e = C.estimatedCost(j, { estimates });
    assert.equal(e.estCostCents, 80000 + Math.round(12000 * (80000 / 120000)) + 1000);
    assert.equal(C.estimatedCost({ ...j, costing: { budget, estCostOverrideCents: 99000 } }, { estimates }).estCostCents, 99000);
  });

  test('jobCosting (lib/tm.js) carries the new keys and the old ones', () => {
    const c = jobCosting({ job: withCos, estimates, settings, employees, dayOf, timeEntries: [work('t1', 'sam', '2026-09-15', 8, 16)] });
    assert.equal(c.contractCents, 135000);
    assert.equal(c.labourCents, 32000);
    assert.equal(c.labourWageCents, 32000);
    for (const k of ['burdenCents', 'otPremiumCents', 'billsCents', 'subcontractCents', 'equipmentCents', 'otherCents', 'accruedCents', 'committedCents', 'varianceCount']) assert.equal(c[k], 0, k);
    assert.equal(c.burdenMissing, true);
    assert.ok(c.byCostCode.none);
  });
});

describe('WIP', () => {
  const bill = (id, jobId, cents) => ({ id, status: 'open', date: '2026-09-10', lines: [{ costType: 'other', amountCents: cents, jobId }], taxes: [] });
  const inv = (id, jobId, cents, o = {}) => ({ id, jobId, status: 'sent', issueDate: '2026-09-15', lines: [{ kind: 'other', qty: 1, unitCents: cents }], taxes: [], ...o });
  const jobs = [
    { id: 'wa', number: 'J-1', status: 'in-progress', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 80000 } },
    { id: 'wl', number: 'J-2', status: 'in-progress', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 120000 } },
    { id: 'wc', number: 'J-3', status: 'in-progress', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 50000 } },
    { id: 'wo', number: 'J-4', status: 'on-hold', contract: { valueCents: 100000 }, costing: { estCostOverrideCents: 80000, pctCompleteOverride: 25 } },
    { id: 'ws', number: 'J-5', status: 'in-progress', kind: 'service', billingMode: 'tm' },
    { id: 'wt', number: 'J-6', status: 'in-progress', billingMode: 'tm' },
    { id: 'wd', number: 'J-7', status: 'complete', contract: { valueCents: 50000, completedOn: '2026-08-30' } },
    { id: 'wx', number: 'J-8', status: 'complete', contract: { valueCents: 50000, completedOn: '2025-08-30' } },
  ];
  const sources = {
    settings, employees, dayOf, now: Date.parse('2026-12-01T00:00:00Z'), estimates: [],
    bills: [bill('b1', 'wa', 40000), bill('b2', 'wl', 60000), bill('b3', 'wc', 70000), bill('b4', 'wd', 30000), bill('b5', 'wo', 10000)],
    invoices: [inv('i1', 'wa', 60000), inv('i2', 'wl', 30000), inv('i3', 'wt', 20000), inv('i4', 'wa', 99999, { status: 'draft' })],
    timeEntries: [work('t1', 'ana', '2026-09-16', 8, 10, { jobId: 'wt' })],
  };
  const w = C.wipReport({ jobs, asOf: '2026-09-30', ...sources });
  const row = (id) => w.rows.find((x) => x.jobId === id);

  test('percent complete from cost, earned, over billed', () => {
    assert.equal(row('wa').pct, 0.5);
    assert.equal(row('wa').earnedCents, 50000);
    assert.equal(row('wa').billedCents, 60000, 'a draft invoice is not billed');
    assert.equal(row('wa').overBilledCents, 10000);
    assert.equal(row('wa').underBilledCents, 0);
  });
  test('a projected loss is taken now (loss provision)', () => {
    assert.equal(row('wl').projectedGrossProfitCents, -20000);
    assert.equal(row('wl').earnedCents, 60000 - 20000);
    assert.equal(row('wl').lossProvisionCents, 10000);
    assert.equal(row('wl').underBilledCents, 10000);
  });
  test('percent complete is capped at 1; the job’s override wins', () => {
    assert.equal(row('wc').pct, 1);
    assert.equal(row('wc').earnedCents, 100000);
    assert.equal(row('wo').pct, 0.25);
    assert.equal(row('wo').pctOverridden, true);
    assert.equal(row('wo').earnedCents, 25000);
  });
  test('T&M jobs earn billed plus unbilled at sell; service calls are left out', () => {
    assert.equal(row('wt').mode, 'tm');
    assert.equal(row('wt').earnedCents, 20000 + 2 * 9000);
    assert.equal(row('wt').underBilledCents, 18000);
    assert.equal(row('ws'), undefined);
  });
  test('contracts completed this fiscal year, for the bonding company', () => {
    assert.deepEqual(w.completed.map((x) => [x.jobId, x.contractCents, x.costCents, x.grossProfitCents]), [['wd', 50000, 30000, 20000]]);
    assert.equal(w.totals.overBilledCents, 10000);
    assert.ok(C.wipCsv(w).includes('Completed this fiscal year'));
  });
  test('job profit: revenue, cost by type, margin and budget margin', () => {
    const p = C.jobProfit({ job: jobs[0], from: '2026-09-01', to: '2026-09-30', ...sources });
    assert.equal(p.revenueCents, 60000);
    assert.equal(p.costCents, 40000);
    assert.equal(p.grossProfitCents, 20000);
    assert.equal(p.marginPct, 33.33);
    assert.equal(p.budgetMarginPct, 20);
    const list = C.jobProfitList({ jobs, from: '2026-09-01', to: '2026-09-30', ...sources });
    assert.ok(list.some((x) => x.jobId === 'wa'));
    assert.ok(C.jobProfitCsv(list).startsWith('Job,Title,Revenue'));
  });
});

describe('purchase orders on their own: received, billed, committed', () => {
  const po = { id: 'p', number: 'PO-1', jobId: 'j1', status: 'open', date: '2026-09-01', lines: [{ description: 'Wire', qty: 10, unitCents: 100 }, { description: 'Boxes', qty: 5, unitCents: 200, jobId: 'j2' }] };
  const moves = [
    { id: 'r1', use: 'receive', poId: 'p', poLineIndex: 0, qty: 4, jobId: 'j1', date: '2026-09-05' },
    { id: 'r2', use: 'receive', poId: 'p', poLineIndex: 0, qty: 3, jobId: 'j1', date: '2026-09-20' },
    { id: 'r3', use: 'receive', poId: 'p', poLineIndex: 1, qty: 5, toLocationId: 'shop', date: '2026-09-06' },
  ];
  const bills = [{ id: 'b', status: 'open', date: '2026-09-10', lines: [{ qty: 2, poLine: { purchaseOrderId: 'p', index: 0 } }] }];
  test('received as of a day comes from the receive moves', () => {
    assert.equal(C.receivedQtyAsOf(po, 0, { stockMoves: moves, asOf: '2026-09-10' }), 4);
    assert.equal(C.receivedQtyAsOf(po, 0, { stockMoves: moves }), 7);
    assert.equal(C.receiptDestination(po, 1, { stockMoves: moves }), 'stock');
    assert.equal(C.receiptDestination(po, 0, { stockMoves: moves }), 'job');
  });
  test('received not billed: everything for month-end, only the job’s own receipts for job cost', () => {
    const all = C.receivedNotBilled({ purchaseOrders: [po], bills, stockMoves: moves });
    assert.deepEqual(all.map((x) => [x.index, x.destination, x.qty, x.cents]), [[0, 'job', 5, 500], [1, 'stock', 5, 1000]]);
    assert.deepEqual(C.receivedNotBilled({ purchaseOrders: [po], bills, stockMoves: moves, jobId: 'j2' }), [], 'received into stock is not the job’s cost');
    assert.deepEqual(C.receivedNotBilled({ purchaseOrders: [po], bills, stockMoves: moves, asOf: '2026-09-09' }).map((x) => [x.index, x.qty]), [[0, 4], [1, 5]], 'the bill came on the 10th');
  });
  test('committed: what is still to come', () => {
    assert.equal(C.committedCost({ purchaseOrders: [po], bills, stockMoves: moves, jobId: 'j1' }).cents, 3 * 100);
    assert.equal(C.committedCost({ purchaseOrders: [{ ...po, status: 'closed' }], bills, stockMoves: moves }).cents, 0, 'a closed order commits nothing');
  });
  test('one WIP row, and the rate on a day', () => {
    const j = { id: 'w', status: 'in-progress', contract: { valueCents: 1000 }, costing: { estCostOverrideCents: 800 } };
    const row = C.wipRow(j, { asOf: '2026-09-30', bills: [{ id: 'b', status: 'open', date: '2026-09-01', lines: [{ costType: 'other', amountCents: 200, jobId: 'w' }], taxes: [] }], dayOf });
    assert.deepEqual([row.pct, row.earnedCents, row.underBilledCents], [0.25, 250, 250]);
    assert.equal(C.rateOn([{ from: '2026-01-01', rateCents: 100 }, { from: '2026-06-01', rateCents: 120 }], '2026-05-31'), 100);
    assert.deepEqual(C.equipmentRateOn({ rateCents: 9500, rateUnit: 'day' }, '2026-01-01'), { rateCents: 9500, rateUnit: 'day' });
  });
});

describe('break-even', () => {
  test('field roles only; overhead makes it break-even, without it it is labour cost only; target from margin', () => {
    const s = { ...settings, costing: { ...settings.costing, statutoryPctFallback: 10, overheadAnnualCents: null, targetMarginPct: 20 } };
    const crew = [{ id: 'x', name: 'X', role: 'electrician', rateCents: 4000, burden: { vacationPct: 0, holidayPct: 0 } }, { id: 'o', name: 'O', role: 'office', rateCents: 9000 }];
    const equipment = [{ id: 't', kind: 'truck', rateCents: 9500, rateUnit: 'day' }];
    const lab = C.breakEven({ employees: crew, equipment, settings: s, on: '2026-09-01' });
    assert.deepEqual(lab.rows.map((x) => x.employeeId), ['x']);
    assert.equal(lab.labourOnly, true);
    assert.equal(lab.breakEvenRateCents, lab.burdenedCostPerProductiveHourCents);
    assert.equal(lab.equipmentRecoveryPerProductiveHourCents, Math.round((9500 * 250) / 1800), 'shown beside, never added');
    const full = C.breakEven({ employees: crew, settings: { ...s, costing: { ...s.costing, overheadAnnualCents: 18_000_000 } }, on: '2026-09-01' });
    assert.equal(full.labourOnly, false);
    assert.equal(full.overheadPerProductiveHourCents, 10000);
    assert.equal(full.breakEvenRateCents, full.burdenedCostPerProductiveHourCents + 10000);
    assert.equal(full.targetRateCents, Math.round(full.breakEvenRateCents / 0.8));
  });
});
