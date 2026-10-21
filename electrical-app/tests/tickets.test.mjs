// Run: node --test electrical-app/tests/
// Field tickets (docs/releases/r1-get-paid.md 4.1, 2.10): labour prefill includes the open entry,
// tickets carry no money (pricing lives on the change order, which only the office sees), pricing as
// a change order is refused on T&M jobs, the batch snapshot covers each ticket by id, the daily hours
// reconciliation, and the signing helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as T from '../js/lib/tickets.js';
import { buildSignature, SIGNING_NOTICE, queueSignatureFirst } from '../js/lib/esign.js';
import { signedContent, snapshotOf, SIGNED_KEYS } from '../js/lib/signing.js';

const settings = { labourRateCents: 9500, markupPct: 20, tickets: { agreementText: 'I confirm the work listed above was requested and done.' } };
const fixed = { id: 'j1', number: 'J-1042', clientId: 'c1', billingMode: 'fixed', contract: { authorizedSigners: [{ name: 'Pat Super', title: 'Superintendent' }] } };
const tmJob = { id: 'j2', number: 'J-2001', clientId: 'c1', billingMode: 'tm' };
const moneyKeys = (o, path = '') => Object.entries(o || {}).flatMap(([k, v]) => [/Cents$/.test(k) ? `${path}${k}` : null, ...(v && typeof v === 'object' ? moneyKeys(v, `${path}${k}.`) : [])]).filter(Boolean);

test('labour prefill: today on the job, mine or the crew, with the open entry counted to now', () => {
  const now = new Date('2026-10-20T20:00:00Z');
  const entries = [
    { id: 'a', employeeId: 'sam', jobId: 'j1', clockIn: '2026-10-20T13:00:00Z', clockOut: '2026-10-20T17:00:00Z', breakMins: 30 },
    { id: 'b', employeeId: 'sam', jobId: 'j1', clockIn: '2026-10-20T17:30:00Z' }, // open: 2.5 h to now
    { id: 'c', employeeId: 'ana', jobId: 'j1', clockIn: '2026-10-20T13:00:00Z', clockOut: '2026-10-20T19:00:00Z' },
    { id: 'd', employeeId: 'sam', jobId: 'j1', clockIn: '2026-10-19T13:00:00Z', clockOut: '2026-10-19T19:00:00Z' },
    { id: 'e', employeeId: 'sam', jobId: 'other', clockIn: '2026-10-20T08:00:00Z', clockOut: '2026-10-20T09:00:00Z' },
    { id: 't', employeeId: 'sam', jobId: 'j1', kind: 'travel', clockIn: '2026-10-20T12:30:00Z', clockOut: '2026-10-20T13:00:00Z' },
  ];
  const employees = [{ id: 'sam', name: 'Sam Sparks' }, { id: 'ana', name: 'Ana Apprentice' }];
  const mine = T.prefillLabour({ jobId: 'j1', day: '2026-10-20', timeEntries: entries, employees, employeeId: 'sam', now });
  assert.deepEqual(mine.map((r) => [r.name, r.hours, r.travel, r.timeEntryIds]), [['Sam Sparks', 6, false, ['a', 'b']], ['Sam Sparks', 0.5, true, ['t']]]);
  const crew = T.prefillLabour({ jobId: 'j1', day: '2026-10-20', timeEntries: entries, employees, employeeId: 'sam', crew: true, now });
  assert.deepEqual(crew.map((r) => r.name), ['Ana Apprentice', 'Sam Sparks', 'Sam Sparks']);
});

test('a ticket carries no money: new, filled, signed and priced', () => {
  const t = { id: 'tk1', ...T.newTicket({ job: fixed, employee: { id: 'sam' }, settings, date: '2026-10-20' }) };
  assert.equal(t.kind, 'extra');
  assert.equal(T.newTicket({ job: tmJob, settings, date: '2026-10-20' }).kind, 'tm');
  assert.equal(t.number, null, 'the server numbers it');
  assert.equal(T.ticketLabel(t), 'T-pending tk1');
  assert.equal(t.agreementText, 'I confirm the work listed above was requested and done. Billed at our contract rates.');
  assert.equal(T.agreementTextFor(settings, { pricingBasis: 'contract-rates', rateSheetRef: 'rates in contract 24-117' }).endsWith('Billed at the rates in contract 24-117.'), true);
  assert.equal(T.agreementTextFor(settings, { pricingBasis: 'quote-to-follow' }).endsWith('Price to follow by quote; this confirms the work only.'), true);
  Object.assign(t, { title: 'Move two pots', labour: [{ employeeId: 'sam', name: 'Sam Sparks', hours: 1.5 }], materials: [{ itemId: 'pot', description: 'Pot light', qty: 2, unit: 'ea' }], equipment: [{ equipmentId: 'lift', description: 'Scissor lift', qty: 2, unit: 'hour' }] });
  assert.deepEqual(moneyKeys(t), []);
  const co = T.ticketToChangeOrder(t, { job: fixed, items: [{ id: 'pot', name: 'Pot light', priceCents: 4500, costCents: 2000 }], equipment: [{ id: 'lift', name: 'Scissor lift', billRateCents: 6000 }], settings, today: '2026-10-21' });
  assert.equal(co.amountCents, 1.5 * 9500 + 2 * 4500 + 2 * 6000, 'labour at the job rate, price book material, equipment bill rate');
  assert.deepEqual(co.ticketIds, ['tk1']);
  const priced = { ...t, status: 'priced', changeOrderId: co.id, office: { pricedAt: '2026-10-21T15:00:00Z', pricedBy: 'Dana' } };
  assert.deepEqual(moneyKeys(priced), [], 'the price stays on the change order (office only), never on the ticket');
  const snap = snapshotOf('fieldTicket', priced);
  assert.deepEqual(moneyKeys(snap), [], 'nor in what was signed');
  assert.ok(SIGNED_KEYS.fieldTickets.every((k) => !/Cents$/.test(k)));
});

test('cost plus markup when the item has no price; refused on T&M jobs; refused tickets note the written notice', () => {
  const t = { id: 'tk2', status: 'refused', refusal: { at: '2026-10-20T19:00:00Z', by: 'Pat' }, notice: { queuedAt: '2026-10-20T19:15:00Z' }, title: 'Extra run', labour: [], materials: [{ itemId: 'w', qty: 10, unit: 'm' }] };
  const co = T.ticketToChangeOrder(t, { job: fixed, items: [{ id: 'w', name: 'Wire', costCents: 100 }], settings });
  assert.equal(co.amountCents, 10 * 120);
  assert.equal(co.note, 'Unsigned: written notice given 2026-10-20');
  assert.throws(() => T.ticketToChangeOrder(t, { job: tmJob, settings }), /time and material job/);
  const lines = T.ticketToInvoiceLines({ ...t, labour: [{ name: 'Sam', hours: 2, travel: true }] }, { job: { ...fixed, travelRateCents: 5000 }, settings, items: [] });
  assert.deepEqual(lines.map((l) => [l.kind, l.qty, l.unitCents]), [['labour', 2, 5000], ['material', 10, 0]], 'travel at the travel rate; a missing price is flagged on the line');
  assert.match(lines[1].description, /price needed/);
});

test('batch signature: one signature over the job\'s drafts, each ticket by id; the digest is the SHA-256 of the canonical snapshot', async () => {
  const tickets = ['b1', 'b2', 'b3'].map((id, i) => ({ id, jobId: 'j1', kind: 'tm', date: '2026-10-20', title: `Ticket ${i}`, labour: [{ name: 'Sam', hours: i + 1 }], materials: [], equipment: [], photos: [{ id: `ph-${i}`, dataUrl: 'data:image/jpeg;base64,AAAA' }], agreementText: 'ok', status: 'draft' }));
  assert.equal(T.batchCandidates([...tickets, { id: 'x', jobId: 'j1', status: 'signed' }], 'j1').length, 3);
  const sig = await buildSignature({ docType: 'ticketBatch', doc: { id: 'batch-1', jobId: 'j1', tickets }, signerName: 'Pat Super', dataUrl: 'data:image/jpeg;base64,AA==', capturedBy: { name: 'Fred' } });
  assert.equal(sig.docType, 'ticketBatch');
  assert.equal(sig.docId, 'batch-1');
  assert.deepEqual(sig.docIds, ['b1', 'b2', 'b3']);
  assert.deepEqual(sig.snapshot.tickets.map((t) => t.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(sig.snapshot.tickets[0].photoIds, ['ph-0'], 'photo ids, never the images');
  assert.equal(JSON.stringify(sig.snapshot).includes('data:image'), false);
  assert.equal(sig.digest, createHash('sha256').update(signedContent(sig.snapshot), 'utf8').digest('hex'));
  const co = await buildSignature({ docType: 'changeOrder', doc: { id: 'co-9', title: 'Pots', amountCents: 1000, lines: [] }, extra: { jobId: 'j1' }, signerName: 'Pat', dataUrl: 'x' });
  assert.deepEqual([co.docId, co.changeOrderId, co.jobId], ['co-9', 'co-9', 'j1']);
  const email = await buildSignature({ docType: 'estimate', doc: { id: 'e1', lines: [] }, method: 'email-reply', evidence: { dataUrl: 'data:image/jpeg;base64,AA', from: 'a@b.c' }, signerName: 'Owner' });
  assert.equal(email.dataUrl, undefined);
  assert.equal(email.evidence.from, 'a@b.c');
  assert.match(SIGNING_NOTICE, /location/);
});

test('authorized signers warn, stale drafts, problems, and the daily hours reconciliation', () => {
  assert.equal(T.signerOnList(fixed, 'pat super'), true);
  assert.equal(T.signerOnList(fixed, 'Someone Else'), false);
  assert.equal(T.signerOnList(tmJob, 'Anyone'), null, 'no list: no warning');
  const drafts = [{ id: 'a', status: 'draft', date: '2026-10-15' }, { id: 'b', status: 'draft', date: '2026-10-19' }, { id: 'c', status: 'signed', date: '2026-10-01' }];
  assert.deepEqual(T.staleDrafts(drafts, { asOf: '2026-10-20', days: 3 }).map((t) => t.id), ['a']);
  assert.deepEqual(T.ticketProblems({ jobId: 'j', title: '' }), ['Say what the work was (a short title).', 'Add a description, hours or material.']);
  assert.deepEqual(T.ticketProblems({ jobId: 'j', title: 'x', labour: [{ name: 'Sam', hours: 25 }] }), ['Hours for Sam must be between 0 and 24.']);
  const rec = T.ticketReconciliation({
    tickets: [{ id: 't', status: 'signed', date: '2026-10-20', labour: [{ hours: 6.5 }] }, { id: 'u', status: 'draft', date: '2026-10-21', labour: [{ hours: 8 }] }],
    labour: [{ day: '2026-10-20', hours: 8 }, { day: '2026-10-21', hours: 4 }],
  });
  assert.deepEqual(rec, [{ day: '2026-10-20', billedMinutes: 480, signedMinutes: 390, flagged: true }, { day: '2026-10-21', billedMinutes: 240, signedMinutes: 0, flagged: true }]);
  assert.deepEqual(T.ticketReconciliation({ tickets: [], labour: [{ day: '2026-10-20', hours: 8 }] }), [], 'no tickets in range: nothing to reconcile');
  const notice = T.noticeText({ id: 'x', number: 'T-1042', date: '2026-10-20', title: 'Move pots', refusal: { by: 'Pat', at: '2026-10-20T19:00:00Z' }, labour: [{ name: 'Sam', hours: 2 }], materials: [] }, { job: fixed, company: { name: 'TG Electrical' } });
  assert.match(notice, /^Written notice of extra work: T-1042 on J-1042/);
  assert.doesNotMatch(notice, /\$/);
});

test('the sync queue pushes the signature before a document edited (and coalesced) before it was signed', () => {
  const put = [];
  const queue = [
    { mid: 'm1', seq: 1, collection: 'jobs', id: 'j1', sent: false, state: 'pending' },
    { mid: 'm2', seq: 2, collection: 'clients', id: 'c1', sent: false, state: 'pending' },
    { mid: 'm3', seq: 3, collection: 'signatures', id: 'sig-1', sent: false, state: 'pending' },
  ];
  const store = { queue, putQueue: (e) => put.push(e.mid) };
  assert.equal(queueSignatureFirst(store, 'sig-1', [{ coll: 'jobs', id: 'j1' }]), true);
  assert.deepEqual(queue.map((e) => e.mid), ['m3', 'm1', 'm2']);
  assert.ok(queue[0].seq < queue[1].seq, 'and the stored order (seq) agrees after a reload');
  assert.deepEqual(put, ['m3']);
  assert.equal(queueSignatureFirst(store, 'sig-1', [{ coll: 'jobs', id: 'j1' }]), false, 'already first: nothing moves');
  const inFlight = { queue: [{ mid: 'a', seq: 1, collection: 'fieldTickets', id: 't', sent: true }, { mid: 'b', seq: 2, collection: 'signatures', id: 's', sent: false }], putQueue() {} };
  assert.equal(queueSignatureFirst(inFlight, 's', [{ coll: 'fieldTickets', id: 't' }]), false, 'a mutation already sent is left alone');
});
