// Billing mode per job (js/lib/tm.js): T&M invoice building and fixed-price job costing.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as TM from '../js/lib/tm.js';
import { docTotals } from '../js/lib/money.js';

const settings = { company: { province: 'MB' }, tax: { mode: 'province' }, labourRateCents: 9500, markupPct: 20, billing: { travelRateCents: 6000 } };
const job = { id: 'j1', number: 'J-1001', title: 'Shop rewire', clientId: 'c1', billingMode: 'tm', crewIds: ['e1', 'e2'], changeOrders: [] };
const employees = [
  { id: 'e1', name: 'Sam Sparks', rateCents: 4000 },
  { id: 'e2', name: 'Ana Apprentice', rateCents: 2500 },
];
const items = [
  { id: 'i1', name: '3/4" EMT', unit: 'stick', costCents: 1000, priceCents: 2500 },
  { id: 'i2', name: 'Two-hole strap 3/4"', unit: 'ea', costCents: 25, priceCents: 80 },
];
// UTC timestamps; dayOf below reads the UTC day so the test is the same in every time zone.
const entry = (id, emp, day, inH, outH, extra = {}) => ({ id, employeeId: emp, jobId: 'j1', clockIn: `${day}T${inH}:00:00.000Z`, clockOut: `${day}T${outH}:00:00.000Z`, breakMins: 0, approved: true, ...extra });
const timeEntries = [
  entry('t1', 'e1', '2026-10-05', '14', '22'),                    // 8 h
  entry('t2', 'e2', '2026-10-05', '14', '18'),                    // 4 h
  entry('t3', 'e1', '2026-10-06', '13', '14', { travel: true }),   // 1 h travel
  entry('t4', 'e1', '2026-10-06', '14', '20', { approved: false }), // waiting for approval: not billed
  entry('t5', 'e1', '2026-10-09', '14', '16', { jobId: 'other' }), // another job
  entry('t6', 'e2', '2026-10-20', '14', '18'),                    // outside the range
];
const stockMoves = [
  { id: 'm1', itemId: 'i1', fromLocationId: 'van2', toLocationId: null, qty: 20, jobId: 'j1', date: '2026-10-05' }, // used on the job
  { id: 'm2', itemId: 'i1', fromLocationId: 'shop', toLocationId: 'van2', qty: 40, jobId: 'j1', date: '2026-10-05' }, // a transfer, not use
  { id: 'm3', itemId: 'i2', fromLocationId: 'van2', toLocationId: null, qty: 50, jobId: 'j1', date: '2026-10-06' },
];
const materialRequests = [
  { id: 'r1', jobId: 'j1', itemId: null, description: 'PVC 1in coupling', qty: 10, unit: 'ea', status: 'fulfilled', fulfilledAt: '2026-10-06T18:00:00.000Z', costCents: 150 },
  { id: 'r2', jobId: 'j1', itemId: 'i2', description: 'Two-hole strap', qty: 50, status: 'fulfilled', fulfilledAt: '2026-10-06T18:00:00.000Z', stockMoveId: 'm3' }, // counted by its stock move
  { id: 'r3', jobId: 'j1', itemId: null, description: 'Mystery fitting', qty: 2, unit: 'ea', status: 'fulfilled', fulfilledAt: '2026-10-06T18:00:00.000Z' }, // no cost yet
  { id: 'r4', jobId: 'j1', itemId: 'i1', qty: 5, status: 'ordered' }, // not here yet
];
const dayOf = (iso) => String(iso).slice(0, 10);
const sources = { timeEntries, stockMoves, materialRequests, items, employees, invoices: [], dayOf };

describe('time & material', () => {
  test('modes and defaults: a job from before modes is fixed; client default beats the company', () => {
    assert.equal(TM.jobBillingMode({}), 'fixed');
    assert.equal(TM.jobBillingMode({ billingMode: 'tm' }), 'tm');
    assert.equal(TM.defaultBillingMode({}, null), 'fixed');
    assert.equal(TM.defaultBillingMode({ billing: { defaultMode: 'tm' } }, null), 'tm');
    assert.equal(TM.defaultBillingMode({ billing: { defaultMode: 'tm' } }, { billingMode: 'fixed' }), 'fixed');
    assert.equal(TM.defaultBillingMode({}, { billingMode: 'tm' }), 'tm', 'this customer is always T&M');
    assert.deepEqual(TM.jobRates({ labourRateCents: 12000 }, settings), { labourRateCents: 12000, travelRateCents: 6000, markupPct: 20 });
    assert.deepEqual(TM.jobRates({}, { labourRateCents: 9000 }), { labourRateCents: 9000, travelRateCents: 9000, markupPct: 0 }, 'travel defaults to the labour rate');
  });

  test('unbilled: approved time in range at the rates, material used at cost + markup', () => {
    const u = TM.unbilledTm({ job, settings, from: '2026-10-01', to: '2026-10-10', ...sources });
    assert.deepEqual(u.labour.map((l) => l.id).sort(), ['t1', 't2', 't3']);
    assert.equal(u.hours, 12);
    assert.equal(u.travelHours, 1);
    assert.equal(u.pendingApproval, 1);
    assert.equal(u.labourCents, 12 * 9500 + 6000);
    // m1: 20 x $10.00 x 1.2 = $240; m3: 50 x $0.25 x 1.2 = $15; r1: 10 x $1.50 x 1.2 = $18; r3: no cost
    assert.deepEqual(u.materials.map((m) => m.id).sort(), ['m1', 'm3', 'r1', 'r3']);
    assert.equal(u.materialCents, 24000 + 1500 + 1800);
    assert.equal(u.missingCost, 1);
    assert.equal(u.totalCents, u.labourCents + u.materialCents);
  });

  test('the invoice: one labour line per person, travel apart, material lines, provincial tax', () => {
    const { invoice } = TM.buildTmInvoice({ job, settings, issueDate: '2026-10-11', dueDate: '2026-10-25', from: '2026-10-01', to: '2026-10-10', ...sources });
    assert.equal(invoice.billingMode, 'tm');
    assert.equal(invoice.jobId, 'j1');
    assert.equal(invoice.clientId, 'c1');
    const labour = invoice.lines.filter((l) => l.kind === 'labour');
    assert.deepEqual(labour.map((l) => [l.description.split(' (')[0], l.qty, l.unitCents]), [
      ['Labour: Ana Apprentice', 4, 9500], ['Labour: Sam Sparks', 8, 9500], ['Travel: Sam Sparks', 1, 6000],
    ]);
    const mats = invoice.lines.filter((l) => l.kind === 'material');
    assert.deepEqual(mats.map((l) => [l.description, l.qty, l.unitCents]), [
      ['3/4" EMT', 20, 1200], ['Mystery fitting (price needed)', 2, 0], ['PVC 1in coupling', 10, 180], ['Two-hole strap 3/4"', 50, 30],
    ]);
    assert.deepEqual(invoice.tm, { from: '2026-10-01', to: '2026-10-10', timeEntryIds: ['t1', 't2', 't3'], stockMoveIds: ['m1', 'm3'], materialRequestIds: ['r1', 'r3'] });
    // Manitoba: GST 5% + RST 7% on the whole contract, labour included (tax.js, Bulletin 031).
    assert.deepEqual(invoice.taxes.map((t) => [t.id, t.pct]), [['GST', 5], ['RST', 7]]);
    const t = docTotals(invoice);
    assert.equal(t.subtotalCents, 12 * 9500 + 6000 + 24000 + 1800 + 1500);
    assert.equal(t.taxCents, Math.round(t.subtotalCents * 0.05) + Math.round(t.subtotalCents * 0.07));
  });

  test('nothing is billed twice; voiding the invoice frees it', () => {
    const { invoice } = TM.buildTmInvoice({ job, settings, issueDate: '2026-10-11', from: '2026-10-01', to: '2026-10-10', ...sources });
    const after = TM.unbilledTm({ job, settings, ...sources, invoices: [{ ...invoice, id: 'inv1' }], from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(after.labour.map((l) => l.id), ['t6'], 'only the later entry is left');
    assert.equal(after.materials.length, 0);
    const voided = TM.unbilledTm({ job, settings, ...sources, invoices: [{ ...invoice, id: 'inv1', status: 'void' }], from: '2026-10-01', to: '2026-10-10' });
    assert.equal(voided.labour.length, 3);
    assert.throws(() => TM.buildTmInvoice({ job, settings, issueDate: '2026-10-11', from: '2026-11-01', to: '2026-11-30', ...sources }), /Nothing to bill/);
  });

  test('a voided invoice cannot come back once a newer invoice billed its records', () => {
    const range = { issueDate: '2026-10-11', from: '2026-10-01', to: '2026-10-10' };
    const a = { ...TM.buildTmInvoice({ job, settings, ...range, ...sources }).invoice, id: 'invA', status: 'void' };
    assert.deepEqual(TM.restoreConflicts(a, [a]), [], 'nothing else billed them: it can be restored');
    // The void freed t1..t3, m1, m3, r1, r3; invoice B bills them again.
    const b = { ...TM.buildTmInvoice({ job, settings, ...range, ...sources, invoices: [a] }).invoice, id: 'invB' };
    assert.deepEqual(b.tm.timeEntryIds, a.tm.timeEntryIds);
    const clash = TM.restoreConflicts(a, [a, b]);
    assert.deepEqual(clash.sort(), ['move:m1', 'move:m3', 'req:r1', 'req:r3', 'time:t1', 'time:t2', 'time:t3']);
    assert.deepEqual(TM.restoreConflicts(a, [a, { ...b, status: 'void' }]), [], 'B voided too: A may come back');
    assert.deepEqual(TM.restoreConflicts({ id: 'x', status: 'void', lines: [] }, [a, b]), [], 'an invoice without T&M records never clashes');
  });

  test('the builder starts at the earliest unbilled day, so time approved after the last invoice is not hidden', () => {
    // Billed up to Oct 15 at noon; Oct 15's shift was still waiting for approval, so it was skipped.
    const day15 = entry('t15', 'e1', '2026-10-15', '14', '18', { approved: false });
    const src = { ...sources, timeEntries: [entry('t14', 'e1', '2026-10-14', '14', '18'), day15], stockMoves: [], materialRequests: [] };
    const first = { ...TM.buildTmInvoice({ job, settings, issueDate: '2026-10-15', from: '2026-10-14', to: '2026-10-15', ...src }).invoice, id: 'inv1' };
    assert.deepEqual(first.tm.timeEntryIds, ['t14']);
    // Approved later, plus a stock move back-dated to Oct 12.
    const later = { ...src, timeEntries: [src.timeEntries[0], { ...day15, approved: true }], stockMoves: [{ id: 'mb', itemId: 'i1', fromLocationId: 'van2', qty: 2, jobId: 'j1', date: '2026-10-12' }], invoices: [first] };
    const all = TM.unbilledTm({ job, settings, ...later });
    assert.equal(all.firstDay, '2026-10-12', 'the default start covers everything not billed yet');
    const second = TM.buildTmInvoice({ job, settings, issueDate: '2026-10-20', from: all.firstDay, to: '2026-10-20', ...later });
    assert.deepEqual(second.invoice.tm.timeEntryIds, ['t15']);
    assert.deepEqual(second.invoice.tm.stockMoveIds, ['mb']);
    assert.equal(second.unbilled.totalCents, all.totalCents, 'the preview matches the job card');
    assert.equal(TM.unbilledTm({ job, settings, ...later, invoices: [first, { ...second.invoice, id: 'inv2' }] }).firstDay, '', 'nothing left');
    assert.equal(TM.unbilledTm({ job, settings, ...src }).firstDay, '2026-10-14', 'an entry waiting for approval counts too');
  });

  test('an undone stock move no longer hides its fulfilled request', () => {
    // r2 was taken from stock as move m3; the move was undone (deleted) without reopening r2.
    const src = { ...sources, stockMoves: stockMoves.filter((m) => m.id !== 'm3') };
    const u = TM.unbilledTm({ job, settings, from: '2026-10-01', to: '2026-10-10', ...src });
    assert.ok(u.materials.some((m) => m.source === 'request' && m.id === 'r2'), 'billed as the request');
    const costed = TM.jobCosting({ job, ...src });
    assert.equal(costed.materialCents, 20 * 1000 + 50 * 25 + 10 * 150, 'and costed');
    // A move that an invoice billed before it was undone is not billed again through its request.
    const billedMove = { id: 'inv0', status: 'sent', tm: { timeEntryIds: [], stockMoveIds: ['m3'], materialRequestIds: [] } };
    assert.ok(!TM.unbilledTm({ job, settings, ...src, invoices: [billedMove] }).materials.some((m) => m.id === 'r2'));
    // ...and a request billed on its own keeps its move (if it shows up later) off the next invoice.
    const viaRequest = { id: 'inv1', status: 'sent', tm: { timeEntryIds: [], stockMoveIds: [], materialRequestIds: ['r2'] } };
    assert.ok(!TM.unbilledTm({ job, settings, ...sources, invoices: [viaRequest] }).materials.some((m) => m.id === 'm3'));
  });

  test('hours are rounded once per invoice line, and the unbilled total is the invoice subtotal', () => {
    const short = ['t1', 't2', 't3'].map((id, i) => ({ id, employeeId: 'e1', jobId: 'j1', clockIn: `2026-10-05T1${i}:00:00.000Z`, clockOut: `2026-10-05T1${i}:20:00.000Z`, breakMins: 0, approved: true }));
    const src = { ...sources, timeEntries: short, stockMoves: [], materialRequests: [] };
    const s9750 = { ...settings, labourRateCents: 9750 };
    const { invoice, unbilled } = TM.buildTmInvoice({ job, settings: s9750, issueDate: '2026-10-11', ...src });
    const labour = invoice.lines.filter((l) => l.kind === 'labour');
    assert.deepEqual(labour.map((l) => l.qty), [1], 'three 20-minute entries bill as 1.00 h, not 0.99 h');
    assert.equal(unbilled.totalCents, 9750);
    assert.equal(unbilled.totalCents, docTotals(invoice).subtotalCents);
    // Material at a fractional quantity: the preview still matches the invoice to the cent.
    const mats = { ...sources, timeEntries: [], materialRequests: [], stockMoves: [
      { id: 'q1', itemId: 'i2', fromLocationId: 'van2', qty: 2.5, jobId: 'j1', date: '2026-10-05' },
      { id: 'q2', itemId: 'i2', fromLocationId: 'van2', qty: 2.5, jobId: 'j1', date: '2026-10-05' }] };
    const m = TM.buildTmInvoice({ job, settings: { ...settings, markupPct: 0 }, issueDate: '2026-10-11', ...mats });
    assert.equal(m.unbilled.totalCents, docTotals(m.invoice).subtotalCents);
  });

  test('a fixed-price job never builds T&M lines', () => {
    assert.throws(() => TM.buildTmInvoice({ job: { ...job, billingMode: 'fixed' }, settings, issueDate: '2026-10-11', ...sources }), /fixed price/);
    assert.throws(() => TM.buildTmInvoice({ job: { ...job, billingMode: undefined }, settings, issueDate: '2026-10-11', ...sources }), /fixed price/);
    const all = TM.unbilledAcrossJobs([{ ...job, billingMode: 'fixed' }, job], { settings, ...sources });
    assert.equal(all.count, 1, 'only the T&M job counts');
  });

  test('one travel model: kind "travel" entries from the time clock bill as travel; the old flag still counts', () => {
    assert.equal(TM.isTravel({ kind: 'travel' }), true);
    assert.equal(TM.isTravel({ travel: true }), true, 'entries saved with the earlier checkbox');
    assert.equal(TM.isTravel({ kind: 'work', travel: true }), false, 'kind wins when both are set');
    assert.equal(TM.isTravel({}), false);
    // The GPS clock's day: work at another job, travel to this one (billed to the job travelled to), work here.
    const clock = [
      entry('g1', 'e2', '2026-10-07', '13', '15', { jobId: 'other', kind: 'work' }),
      entry('g2', 'e2', '2026-10-07', '15', '16', { kind: 'travel', travelFromJobId: 'other' }),
      entry('g3', 'e2', '2026-10-07', '16', '21', { kind: 'work' }),
    ];
    const src = { ...sources, timeEntries: clock };
    const u = TM.unbilledTm({ job, settings, from: '2026-10-07', to: '2026-10-07', ...src });
    assert.deepEqual(u.labour.map((l) => [l.id, l.travel, l.rateCents]), [['g2', true, 6000], ['g3', false, 9500]]);
    assert.equal(u.travelHours, 1);
    assert.equal(u.hours, 5);
    const { invoice } = TM.buildTmInvoice({ job, settings, issueDate: '2026-10-08', from: '2026-10-07', to: '2026-10-07', ...src });
    assert.ok(invoice.lines.some((l) => /^Travel: Ana Apprentice/.test(l.description) && l.qty === 1 && l.unitCents === 6000));
    assert.deepEqual([...invoice.tm.timeEntryIds].sort(), ['g2', 'g3']);
    // Fixed price: the same travel is never billed, only costed.
    assert.throws(() => TM.buildTmInvoice({ job: { ...job, billingMode: 'fixed' }, settings, issueDate: '2026-10-08', ...src }), /fixed price/);
    const c = TM.jobCosting({ job: { ...job, billingMode: 'fixed' }, settings, ...src });
    assert.equal(c.travelHours, 1);
  });

  test('Ontario HST and a job rate', () => {
    const on = { ...settings, company: { province: 'ON' } };
    const { invoice } = TM.buildTmInvoice({ job: { ...job, labourRateCents: 11000 }, settings: on, issueDate: '2026-10-11', from: '2026-10-05', to: '2026-10-05', ...sources });
    assert.deepEqual(invoice.taxes.map((t) => [t.id, t.pct]), [['HST', 13]]);
    assert.ok(invoice.lines.filter((l) => l.kind === 'labour').every((l) => l.unitCents === 11000));
  });
});

describe('field tickets on a T&M job (r1-get-paid.md 4.1)', () => {
  // Oct 5: 8 h + 4 h of approved time (t1, t2); the super signed a ticket for 6.5 h and a refused one for 2 h.
  const ticket = (id, o = {}) => ({ id, number: null, jobId: 'j1', kind: 'tm', date: '2026-10-05', status: 'signed', labour: [{ employeeId: 'e1', name: 'Sam Sparks', hours: 6.5, timeEntryIds: ['t1'] }], ...o });
  const fieldTickets = [
    ticket('tk1', { number: 'T-1001' }),
    ticket('tk2', { number: 'T-1002', status: 'refused', labour: [{ employeeId: 'e2', name: 'Ana Apprentice', hours: 2, timeEntryIds: ['t2'] }], refusal: { at: '2026-10-05T23:00:00Z', by: 'Super', reason: 'not mine' } }),
    ticket('tk3', { status: 'draft' }), // not signed: never billed
    ticket('tk4', { status: 'signed', date: '2026-10-20' }), // outside the range
    ticket('tk5', { status: 'signed', invoiceId: 'inv-old' }), // billed already
    ticket('tk6', { jobId: 'other' }),
  ];
  const range = { issueDate: '2026-10-11', from: '2026-10-05', to: '2026-10-05' };

  test('signed and refused tickets are picked up; the day where billed hours exceed signed hours is flagged', () => {
    const r = TM.buildTmInvoice({ job, settings, ...range, ...sources, fieldTickets });
    assert.deepEqual(r.invoice.ticketIds, ['tk1', 'tk2']);
    assert.deepEqual(r.invoice.ticketReconciliation, [{ day: '2026-10-05', billedMinutes: 12 * 60, signedMinutes: 8.5 * 60 }]);
    assert.deepEqual(r.flaggedDays, ['2026-10-05'], 'the invoice screen asks for a reason');
    assert.match(r.invoice.notes, /T-1001, T-1002/);
    const fine = TM.buildTmInvoice({ job, settings, ...range, ...sources, fieldTickets: [ticket('tk1', { labour: [{ name: 'Crew', hours: 12 }] })] });
    assert.deepEqual(fine.flaggedDays, []);
  });

  test('a ticket an invoice billed is not picked up again; no tickets, no reconciliation', () => {
    const first = { ...TM.buildTmInvoice({ job, settings, ...range, ...sources, fieldTickets }).invoice, id: 'inv1' };
    assert.deepEqual(TM.billableTickets(job, fieldTickets, { invoices: [first], from: '2026-10-01', to: '2026-10-31' }).map((t) => t.id), ['tk4']);
    const none = TM.buildTmInvoice({ job, settings, ...range, ...sources });
    assert.equal(none.invoice.ticketIds, undefined);
    assert.equal(none.invoice.ticketReconciliation, undefined);
  });

  test("billFrom 'tickets': labour bills the signed ticket hours; materials still come from moves and requests", () => {
    const s = { ...settings, tickets: { billFrom: 'tickets' } };
    const r = TM.buildTmInvoice({ job, settings: s, ...range, ...sources, fieldTickets });
    const labour = r.invoice.lines.filter((l) => l.kind === 'labour');
    assert.deepEqual(labour.map((l) => [l.description.split(' (')[0], l.qty]), [['Labour: Ana Apprentice', 2], ['Labour: Sam Sparks', 6.5]]);
    assert.ok(r.invoice.lines.some((l) => l.kind === 'material'));
    assert.deepEqual(r.invoice.tm.timeEntryIds.sort(), ['t1', 't2'], 'the entries the tickets name are billed by them');
    assert.deepEqual(r.flaggedDays, []);
  });

  test('the invoice takes the job’s exemption (tax.js newDocTax with the job)', () => {
    const exempt = { ...job, taxExempt: { basis: 'subtrade', number: '1234567', confirmedBy: 'Dana', confirmedAt: '2026-10-01' } };
    const { invoice } = TM.buildTmInvoice({ job: exempt, settings, ...range, ...sources });
    assert.equal(invoice.taxTreatment, 'gst-only');
    assert.equal(invoice.taxExemptNumber, '1234567');
    assert.equal(docTotals(invoice).taxes.find((t) => t.id === 'RST')?.cents ?? 0, 0, 'no RST charged');
  });

  test('material returned from the job to the van is credited on the next T&M invoice', () => {
    const back = { id: 'ret', itemId: 'i1', fromLocationId: null, toLocationId: 'van2', qty: 5, jobId: 'j1', date: '2026-10-06' };
    assert.equal(TM.isJobReturn(back, 'j1'), true);
    assert.equal(TM.isJobReturn({ ...back, use: 'receive' }, 'j1'), false, 'a supplier receipt is not a return');
    assert.equal(TM.isJobReturn({ ...back, fromLocationId: 'shop' }, 'j1'), false, 'a transfer is not a return');
    const u = TM.unbilledTm({ job, settings, from: '2026-10-01', to: '2026-10-10', ...sources, stockMoves: [...stockMoves, back] });
    const ret = u.materials.find((m) => m.id === 'ret');
    assert.equal(ret.qty, -5);
    assert.equal(u.materialCents, 24000 + 1500 + 1800 - 5 * 1200);
  });
});

describe('fixed price: estimate vs actual', () => {
  const fixed = { ...job, billingMode: 'fixed', estimateId: 'e1', changeOrders: [{ id: 'co', amountCents: 50000, status: 'approved' }, { id: 'co2', amountCents: 99999, status: 'pending' }] };
  const estimates = [{
    id: 'e1', jobId: 'j1', status: 'accepted', markupPct: 0, taxes: [],
    lines: [
      { itemId: 'i1', description: 'EMT', qty: 30, unitCents: 2500, labourHours: 0.25, kind: 'material' }, // 7.5 h, cost 30 x $10
      { itemId: null, description: 'Labour', qty: 10, unitCents: 9500, labourHours: 0, kind: 'labour' },   // 10 h
    ],
  }, { id: 'e2', jobId: 'j1', status: 'declined', lines: [{ qty: 1, unitCents: 999999, kind: 'other' }] }];

  test('hours, cost and margin against the accepted estimate', () => {
    const c = TM.jobCosting({ job: fixed, estimates, ...sources, now: new Date('2026-10-30T00:00:00Z') });
    assert.equal(c.estimates, 1, 'the declined estimate is ignored');
    assert.equal(c.contractCents, 30 * 2500 + 10 * 9500 + 50000, 'accepted estimate + approved change orders, before tax');
    assert.equal(c.estHours, 17.5);
    assert.equal(c.estMaterialCents, 30 * 1000);
    assert.equal(c.estLabourCents, Math.round(17.5 * 3250), 'average crew cost rate');
    // actual: every closed entry on the job, approved or not, at each person's cost rate
    assert.equal(c.hours, 8 + 4 + 6 + 4);
    assert.equal(c.travelHours, 1);
    assert.equal(c.labourCents, (8 + 1 + 6) * 4000 + (4 + 4) * 2500);
    assert.equal(c.materialCents, 20 * 1000 + 50 * 25 + 10 * 150, 'material used at cost (request r3 has none)');
    assert.equal(c.costCents, c.labourCents + c.materialCents);
    assert.equal(c.marginCents, c.contractCents - c.costCents);
    assert.equal(c.hoursUsedPct, Math.round((23 / 17.5) * 100));
    assert.ok(c.marginPct < 100);
  });

  test('a job with no estimate still reports actuals', () => {
    const c = TM.jobCosting({ job: { ...fixed, estimateId: null }, estimates: [], ...sources });
    assert.equal(c.estimates, 0);
    assert.equal(c.contractCents, 50000);
    assert.equal(c.hoursUsedPct, null);
    assert.ok(c.hours > 0);
  });
});
