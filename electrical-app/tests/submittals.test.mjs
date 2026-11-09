// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSubmittal, nextNumber, submitPatch, reviewPatch, revisePatch, filterSubmittals, sortSubmittals, summarize, isDraft, isOutstanding, isClosed, typeLabel, statusLabel, REVIEW_OUTCOMES, submittalNo, submittalLabel } from '../js/lib/submittals.js';

test('submittal numbers run per job, starting at 1', () => {
  assert.equal(nextNumber([], 'j1'), 1);
  const items = [{ jobId: 'j1', number: 1 }, { jobId: 'j1', number: 2 }, { jobId: 'j2', number: 1 }];
  assert.equal(nextNumber(items, 'j1'), 3);
  assert.equal(nextNumber(items, 'j2'), 2);
  assert.equal(nextNumber(items, 'j3'), 1);
});

test('a new submittal is a draft, tied to a job and client, at the next job number and revision 0', () => {
  const s = newSubmittal({ job: { id: 'j1', clientId: 'c1' }, items: [{ jobId: 'j1', number: 2 }], by: 'u1', type: 'product-data' });
  assert.equal(s.jobId, 'j1');
  assert.equal(s.clientId, 'c1');
  assert.equal(s.number, 3);
  assert.equal(s.type, 'product-data');
  assert.equal(s.status, 'draft');
  assert.equal(s.revision, 0);
  assert.ok(isDraft(s) && !isOutstanding(s) && !isClosed(s));
});

test('an unknown type falls back to shop-drawing', () => {
  assert.equal(newSubmittal({ type: 'nonsense' }).type, 'shop-drawing');
});

test('submitting stamps the submitted date and moves out for review', () => {
  const s = newSubmittal({ job: { id: 'j1' } });
  const p = submitPatch(s, { at: '2026-11-09' });
  assert.deepEqual(p, { status: 'submitted', submittedDate: '2026-11-09' });
  Object.assign(s, p);
  assert.ok(isOutstanding(s) && !isClosed(s));
});

test('a reviewer return sets the outcome status and stamps the returned date', () => {
  const s = newSubmittal({ job: { id: 'j1' } });
  Object.assign(s, submitPatch(s, { at: '2026-11-09' }));
  const p = reviewPatch(s, 'approved-as-noted', { at: '2026-11-12' });
  assert.deepEqual(p, { status: 'approved-as-noted', returnedDate: '2026-11-12' });
  Object.assign(s, p);
  assert.ok(isClosed(s), 'approved-as-noted is a closed outcome');
  // an unknown outcome is coerced to approved rather than stored raw
  assert.equal(reviewPatch(s, 'bogus').status, 'approved');
});

test('revise & resubmit bumps the revision, clears dates and goes back to draft', () => {
  const s = newSubmittal({ job: { id: 'j1' } });
  Object.assign(s, submitPatch(s, { at: '2026-11-09' }));
  Object.assign(s, reviewPatch(s, 'revise-resubmit', { at: '2026-11-12' }));
  assert.ok(!isClosed(s), 'revise & resubmit is not a closed outcome');
  const p = revisePatch(s);
  assert.deepEqual(p, { status: 'draft', revision: 1, submittedDate: null, returnedDate: null });
  Object.assign(s, p);
  assert.ok(isDraft(s));
  assert.equal(revisePatch(s).revision, 2, 'each revision bumps again');
});

test('review outcomes are the four reviewer return statuses', () => {
  assert.deepEqual(REVIEW_OUTCOMES.map((o) => o.id), ['approved', 'approved-as-noted', 'revise-resubmit', 'rejected']);
});

test('filter by job and status, with __none for submittals not linked to a job', () => {
  const items = [
    { id: 'a', jobId: 'j1', status: 'draft' },
    { id: 'b', jobId: 'j1', status: 'approved' },
    { id: 'c', jobId: 'j2', status: 'submitted' },
    { id: 'd', jobId: null, status: 'draft' },
  ];
  assert.deepEqual(filterSubmittals(items, { jobId: 'j1' }).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(filterSubmittals(items, { jobId: 'j1', status: 'approved' }).map((s) => s.id), ['b']);
  assert.deepEqual(filterSubmittals(items, { jobId: '__none' }).map((s) => s.id), ['d']);
});

test('sort puts outstanding first, then drafts, then closed', () => {
  const items = [
    { number: 1, status: 'approved' },
    { number: 2, status: 'draft' },
    { number: 3, status: 'under-review' },
    { number: 4, status: 'submitted' },
  ];
  assert.deepEqual(sortSubmittals(items).map((s) => s.status), ['submitted', 'under-review', 'draft', 'approved']);
});

test('summary counts drafts, outstanding and closed', () => {
  const items = [
    { status: 'draft' }, { status: 'submitted' }, { status: 'under-review' },
    { status: 'approved' }, { status: 'rejected' }, { status: 'revise-resubmit' },
  ];
  assert.deepEqual(summarize(items), { total: 6, draft: 1, outstanding: 3, closed: 2 });
});

test('labels: padded number with the revision suffix, type and status labels', () => {
  assert.equal(submittalNo({ number: 3 }), 'SUB-003');
  assert.equal(submittalNo({ number: 3, revision: 2 }), 'SUB-003 R2');
  assert.equal(submittalNo({ number: 0 }), 'SUB');
  assert.equal(submittalLabel({ number: 3, description: 'Panelboards' }), 'SUB-003 · Panelboards');
  assert.equal(typeLabel('shop-drawing'), 'Shop drawing');
  assert.equal(statusLabel('approved-as-noted'), 'Approved as noted');
});
