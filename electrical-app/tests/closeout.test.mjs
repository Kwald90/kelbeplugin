// Run: node --test electrical-app/tests/
// The final-billing checklist (docs/releases/r1-get-paid.md 4.8): every item a warning when the job
// is set complete, the block items block when it is set invoiced, and the holdback item blocks only
// once the release date has passed. What is saved on the job matches the server's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeoutChecklist, closeoutRecord, closeoutBlocks, contractValueCents, unbilledContractCents, CLOSEOUT_ITEMS } from '../js/lib/closeout.js';

const job = {
  id: 'j1', number: 'J-1042', status: 'in-progress', billingMode: 'fixed',
  changeOrders: [{ id: 'co1', title: 'Pot lights', status: 'approved', amountCents: 50000 }, { id: 'co2', status: 'pending', amountCents: 1 }],
  contract: { valueCents: 1000000, holdbackReleaseOn: '2026-11-15', substantialPerformanceOn: '2026-10-01' },
};
const sources = {
  invoices: [
    { id: 'prog', jobId: 'j1', status: 'sent', kind: 'progress', issueDate: '2026-09-01', taxes: [], lines: [{ kind: 'labour', qty: 1, unitCents: 600000 }], holdback: { cents: 60000 },
      disputes: [{ id: 'd', cents: 100, status: 'open' }] },
    { id: 'draft', jobId: 'j1', status: 'draft', taxes: [], lines: [] },
    { id: 'dep', jobId: 'j1', status: 'sent', kind: 'deposit', depositModel: 'prepayment', taxes: [], lines: [{ kind: 'other', lineType: 'deposit', qty: 1, unitCents: 20000 }] },
    { id: 'dep2', jobId: 'j1', status: 'sent', kind: 'deposit', depositModel: 'prepayment', taxes: [], lines: [{ kind: 'other', lineType: 'deposit', qty: 1, unitCents: 30000 }] },
  ],
  payments: [{ id: 'p', invoiceId: 'dep', amountCents: 20000 }],
  fieldTickets: [
    { id: 't1', jobId: 'j1', status: 'signed', date: '2026-10-10' },
    { id: 't2', jobId: 'j1', status: 'priced', date: '2026-10-10', changeOrderId: 'co1' },
    { id: 't3', jobId: 'j1', status: 'draft', date: '2026-10-01' },
    { id: 't4', jobId: 'j1', status: 'draft', date: '2026-10-19' },
  ],
  timeEntries: [{ id: 'te', jobId: 'j1', clockIn: '2026-10-10T14:00:00Z', clockOut: '2026-10-10T22:00:00Z', approved: false }],
  purchaseOrders: [{ id: 'po', jobId: 'j1', status: 'sent', lines: [] }, { id: 'po2', jobId: 'j1', status: 'closed', lines: [{ receivedQty: 2 }] }],
  bills: [],
  permits: [{ id: 'pm', jobId: 'j1', status: 'issued' }],
  inspections: [{ id: 'in', jobId: 'j1', permitId: 'pm', type: 'rough-in', result: 'passed' }],
  settings: { tickets: { draftStaleDays: 3 } },
};

test('at complete, every open item is a warning', () => {
  const list = closeoutChecklist(job, sources, { at: 'complete', asOf: '2026-10-20' });
  assert.ok(list.length > 5);
  assert.ok(list.every((i) => i.severity === 'warn'));
  const keys = list.map((i) => i.key);
  for (const k of ['co_unbilled', 'tickets_open', 'time_unapproved', 'holdback_unreleased', 'deposits_unapplied', 'deposit_unpaid', 'disputes_open', 'drafts', 'po_open', 'permit_open', 'gst_substantial']) assert.ok(keys.includes(k), k);
  assert.equal(list.find((i) => i.key === 'tickets_open').count, 2, 'the signed one and the stale draft; priced is billed with its change order');
  assert.equal(list.find((i) => i.key === 'po_open').count, 2, 'an open PO and received lines with no bill');
  const rec = closeoutRecord(list, { by: 'Dana', at: '2026-10-20T15:00:00Z', stage: 'complete' });
  assert.equal(rec.open.length, list.length, 'complete saves every item open');
});

test('at invoiced, the block items block; holdback blocks only after the release date', () => {
  const list = closeoutChecklist(job, sources, { at: 'invoiced', asOf: '2026-10-20' });
  const sev = Object.fromEntries(list.map((i) => [i.key, i.severity]));
  assert.equal(sev.co_unbilled, 'block');
  assert.equal(sev.tickets_open, 'block');
  assert.equal(sev.deposits_unapplied, 'block');
  assert.equal(sev.holdback_unreleased, 'warn', 'release date not reached');
  assert.equal(sev.drafts, 'warn');
  const later = closeoutChecklist(job, sources, { at: 'invoiced', asOf: '2026-11-16' });
  assert.equal(later.find((i) => i.key === 'holdback_unreleased').severity, 'block');
  assert.equal(closeoutChecklist(job, sources, { at: 'invoiced', asOf: '2026-11-15' }).find((i) => i.key === 'holdback_unreleased').severity, 'warn', 'on the day itself it has not passed');
  // The record the server checks: open lists the blocks; an override needs 10 characters.
  const rec = closeoutRecord(list, { by: 'Dana' });
  assert.deepEqual(rec.open.sort(), closeoutBlocks(list).map((i) => i.key).sort());
  assert.equal(rec.override, undefined);
  assert.equal(closeoutRecord(list, { by: 'Dana', override: { reason: 'short' } }).override, undefined);
  assert.equal(closeoutRecord(list, { by: 'Dana', override: { reason: 'GC agreed to bill the CO next job' } }).override.reason, 'GC agreed to bill the CO next job');
});

test('a clean job has nothing open; warnings alone save open []', () => {
  const clean = { id: 'c', billingMode: 'fixed', changeOrders: [] };
  assert.deepEqual(closeoutChecklist(clean, {}, { asOf: '2026-10-20' }), []);
  const warnOnly = closeoutChecklist(clean, { invoices: [{ id: 'd', jobId: 'c', status: 'draft', lines: [] }] }, { asOf: '2026-10-20' });
  assert.deepEqual(warnOnly.map((i) => [i.key, i.severity]), [['drafts', 'warn']]);
  assert.deepEqual(closeoutRecord(warnOnly, { by: 'x' }).open, []);
});

test('T&M jobs: unbilled approved time blocks; signed tickets stay open until billed', () => {
  const tm = { id: 't', billingMode: 'tm', changeOrders: [] };
  const list = closeoutChecklist(tm, {
    timeEntries: [{ id: 'e', jobId: 't', employeeId: 'x', clockIn: '2026-10-10T14:00:00Z', clockOut: '2026-10-10T16:00:00Z', approved: true }],
    fieldTickets: [{ id: 'k', jobId: 't', status: 'priced', date: '2026-10-10' }],
    settings: { labourRateCents: 9000 },
  }, { asOf: '2026-10-20' });
  assert.deepEqual(list.map((i) => i.key), ['tickets_open', 'tm_unbilled']);
});

test('contract value counts approved change orders; unbilled value for the GST notice', () => {
  assert.equal(contractValueCents(job), 1050000);
  assert.equal(unbilledContractCents(job, sources.invoices), 1050000 - 600000);
  assert.equal(contractValueCents({ contract: {} }), null);
  assert.equal(CLOSEOUT_ITEMS.length, 12);
});
