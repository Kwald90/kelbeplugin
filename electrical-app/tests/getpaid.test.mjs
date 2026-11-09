// Close-the-sale flow logic (lib/getpaid.js): estimate/invoice selection and the four-step state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jobEstimates, pickEstimate, invoiceForEstimate, owing, steps, flowComplete, currentStep, progress,
} from '../js/lib/getpaid.js';

const ests = [
  { id: 'e1', jobId: 'j1', status: 'draft', createdAt: '2026-01-01' },
  { id: 'e2', jobId: 'j1', status: 'accepted', createdAt: '2026-01-03' },
  { id: 'e3', jobId: 'j1', status: 'superseded', createdAt: '2026-01-02' },
  { id: 'e9', jobId: 'j2', status: 'sent', createdAt: '2026-01-05' },
  { id: 'edel', jobId: 'j1', status: 'draft', createdAt: '2026-02-01', deletedAt: '2026-02-02' },
];

test('jobEstimates filters by job, drops deleted, newest first', () => {
  const list = jobEstimates(ests, 'j1');
  assert.deepEqual(list.map((e) => e.id), ['e2', 'e3', 'e1']);
  assert.equal(jobEstimates(ests, 'nope').length, 0);
  assert.equal(jobEstimates(ests, null).length, 0);
});

test('pickEstimate prefers accepted, else newest live, else newest', () => {
  assert.equal(pickEstimate(ests, 'j1').id, 'e2'); // accepted wins over newer? e2 is accepted
  assert.equal(pickEstimate(ests, 'j2').id, 'e9'); // only a sent one
  // no accepted, newest live (sent/draft) wins over superseded
  const noAccept = [
    { id: 'a', jobId: 'jx', status: 'superseded', createdAt: '2026-01-09' },
    { id: 'b', jobId: 'jx', status: 'draft', createdAt: '2026-01-08' },
  ];
  assert.equal(pickEstimate(noAccept, 'jx').id, 'b');
  assert.equal(pickEstimate(ests, 'empty'), null);
});

test('invoiceForEstimate returns the non-void newest, else null', () => {
  const invs = [
    { id: 'i1', estimateId: 'e2', status: 'draft', createdAt: '2026-01-04' },
    { id: 'i2', estimateId: 'e2', status: 'void', createdAt: '2026-01-06' },
    { id: 'i3', estimateId: 'e2', status: 'sent', createdAt: '2026-01-05' },
  ];
  assert.equal(invoiceForEstimate(invs, 'e2').id, 'i3');
  assert.equal(invoiceForEstimate(invs, 'nope'), null);
  assert.equal(invoiceForEstimate(invs, null), null);
});

test('owing sums only this invoice\'s payments against the total', () => {
  const inv = { id: 'i1', status: 'sent', lines: [{ qty: 1, unitCents: 10000, description: 'x' }] };
  const pays = [{ invoiceId: 'i1', amountCents: 4000 }, { invoiceId: 'other', amountCents: 9999 }];
  assert.equal(owing(inv, pays), 6000);
  assert.equal(owing(null, pays), null);
});

test('steps: fresh job has quote active, the rest blocked', () => {
  const s = steps({ estimate: null, invoice: null, bal: null });
  assert.deepEqual(s.map((x) => x.state), ['now', 'blocked', 'blocked', 'blocked']);
  assert.equal(currentStep(s).key, 'quote');
  assert.equal(flowComplete(s), false);
  assert.deepEqual(progress(s), { done: 0, total: 4 });
});

test('steps: accepted estimate, no invoice -> invoice is active', () => {
  const s = steps({ estimate: { status: 'accepted' }, invoice: null, bal: null });
  assert.deepEqual(s.map((x) => x.state), ['done', 'done', 'now', 'blocked']);
  assert.equal(currentStep(s).key, 'invoice');
});

test('steps: unsigned estimate -> signature active, invoice/pay blocked', () => {
  const s = steps({ estimate: { status: 'sent' }, invoice: null, bal: null });
  assert.deepEqual(s.map((x) => x.state), ['done', 'now', 'blocked', 'blocked']);
});

test('steps: invoice with balance -> pay active; paid -> complete', () => {
  const open = steps({ estimate: { status: 'accepted' }, invoice: { id: 'i' }, bal: 5000 });
  assert.deepEqual(open.map((x) => x.state), ['done', 'done', 'done', 'now']);
  assert.equal(flowComplete(open), false);
  const paid = steps({ estimate: { status: 'accepted' }, invoice: { id: 'i' }, bal: 0 });
  assert.deepEqual(paid.map((x) => x.state), ['done', 'done', 'done', 'done']);
  assert.equal(flowComplete(paid), true);
  assert.equal(currentStep(paid), null);
  assert.deepEqual(progress(paid), { done: 4, total: 4 });
});
