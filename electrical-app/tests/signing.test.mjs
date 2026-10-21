// Signatures and their digests (js/lib/signing.js, docs/releases/r1-get-paid.md 2.10).
// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SNAPSHOT_VERSION, SNAPSHOT_BUILDERS, SIGNED_KEYS, snapshotOf, signedContent, digestHex, snapshotLike, sameSnapshot, signatureCovers, snapshotWithoutMoney } from '../js/lib/signing.js';

const estimate = {
  id: 'e1', number: 'E-2001', clientId: 'c1', jobId: 'j1', title: 'Panel upgrade', issueDate: '2026-10-20', validUntil: '2026-11-19',
  taxes: [{ id: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }], taxProvince: 'MB', taxTreatment: 'pst-all',
  markupPct: 10, lines: [{ description: '200 A panel', qty: 1, unitCents: 120000, kind: 'material' }, { description: 'Labour', qty: 6.5, unitCents: 9500, kind: 'labour' }],
  notes: 'Café hours', status: 'sent', updatedAt: '2026-10-20T00:00:00Z', internalNote: 'not shown',
};
const ticket = {
  id: 't1', number: 'T-1001', jobId: 'j1', clientId: 'c1', kind: 'extra', date: '2026-10-20', title: 'Move two pots', description: 'Owner asked',
  requestedBy: 'Site super', pricingBasis: 'contract-rates', rateSheetRef: 'rates in contract 24-117',
  labour: [{ employeeId: 'e1', name: 'Jo', hours: 1.25, timeEntryIds: ['te1'] }], materials: [{ description: 'Pot light', qty: 2, unit: 'ea', stockMoveId: 'm1' }],
  equipment: [], photos: [{ id: 'ph1', dataUrl: 'data:image/jpeg;base64,AAAA', takenAt: 'x', width: 1, height: 1 }], agreementText: 'I confirm the work listed above was requested and done.',
  status: 'draft', employeeId: 'e1',
};
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

test('the canonical string is stable across key order and Unicode normalisation', () => {
  const a = { b: 1, a: 'Café', c: [1.5, null, { z: true, y: 2 }] };
  const b = { c: [1.5, null, { y: 2, z: true }], a: 'Café', b: 1 };
  assert.equal(signedContent(a), signedContent(b));
  assert.equal(signedContent(a), '{"a":"Café","b":1,"c":[1.5,null,{"y":2,"z":true}]}');
  assert.equal(signedContent({ x: undefined, y: 0.1 + 0.2 }), '{"y":0.3}');
});

test('digests match node:crypto, so the server computes the same', async () => {
  const snap = snapshotOf('estimate', estimate);
  const text = signedContent(snap);
  assert.equal(await digestHex(text), createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.match(await digestHex(text), /^[0-9a-f]{64}$/);
});

test('snapshots carry v and no photos or data URLs; totals come from the document', () => {
  const s = snapshotOf('estimate', estimate);
  assert.equal(s.v, SNAPSHOT_VERSION);
  assert.equal(s.docType, 'estimate');
  assert.equal(s.totalCents, Math.round((120000 + 12000 + 61750) * 1.05));
  assert.deepEqual(s.lines, [{ description: '200 A panel', qty: 1 }, { description: 'Labour', qty: 6.5 }]);
  const t = snapshotOf('fieldTicket', ticket);
  assert.deepEqual(t.photoIds, ['ph1']);
  assert.equal(JSON.stringify(t).includes('data:image'), false);
  assert.equal('number' in t, false, 'a ticket snapshot uses its id, never its number');
  const co = snapshotOf('changeOrder', { id: 'co1', title: 'Extra', amountCents: 45000, lines: [{ description: 'x', qty: 2, unitCents: 1 }] }, { jobId: 'j1' });
  assert.deepEqual(co, { v: 1, docType: 'changeOrder', jobId: 'j1', changeOrderId: 'co1', title: 'Extra', amountCents: 45000, lines: [{ description: 'x', qty: 2 }] });
  const batch = snapshotOf('ticketBatch', { jobId: 'j1', tickets: [ticket, { ...ticket, id: 't2' }] });
  assert.equal(batch.tickets.length, 2);
  assert.throws(() => snapshotOf('invoice', {}), /No snapshot/);
});

test('a snapshot built from SIGNED_KEYS only equals the full one', () => {
  assert.ok(sameSnapshot(snapshotOf('estimate', { id: estimate.id, ...pick(estimate, SIGNED_KEYS.estimates) }), snapshotOf('estimate', estimate)));
  assert.ok(sameSnapshot(snapshotOf('fieldTicket', { id: ticket.id, ...pick(ticket, SIGNED_KEYS.fieldTickets) }), snapshotOf('fieldTicket', ticket)));
  const co = { id: 'co1', title: 'Extra', amountCents: 45000, lines: [{ description: 'x', qty: 2 }], status: 'approved', note: 'n' };
  assert.ok(sameSnapshot(snapshotOf('changeOrder', { id: co.id, ...pick(co, SIGNED_KEYS.changeOrder) }, { jobId: 'j1' }), snapshotOf('changeOrder', co, { jobId: 'j1' })));
  // A change outside the signed keys does not change the snapshot; one inside does.
  assert.ok(sameSnapshot(snapshotOf('estimate', { ...estimate, status: 'accepted', internalNote: 'y' }), snapshotOf('estimate', estimate)));
  assert.equal(sameSnapshot(snapshotOf('estimate', { ...estimate, markupPct: 12 }), snapshotOf('estimate', estimate)), false);
});

test('a v1 snapshot still verifies after v2 ships', () => {
  const sig = { docType: 'fieldTicket', snapshot: snapshotOf('fieldTicket', ticket, {}, 1) };
  SNAPSHOT_BUILDERS[2] = { fieldTicket: (t) => ({ ...SNAPSHOT_BUILDERS[1].fieldTicket(t), v: 2, newField: t.costCodeId ?? null }) };
  try {
    assert.ok(sameSnapshot(snapshotLike(sig, ticket), sig.snapshot), 'rebuilt with v1');
    assert.equal(snapshotOf('fieldTicket', ticket, {}, 2).v, 2);
    assert.equal(snapshotLike({ docType: 'fieldTicket', snapshot: { v: 9 } }, ticket), null, 'an unknown version');
  } finally { delete SNAPSHOT_BUILDERS[2]; }
});

test('coverage and money stripping', () => {
  assert.ok(signatureCovers({ docType: 'fieldTicket', docId: 't1' }, 't1'));
  assert.equal(signatureCovers({ docType: 'fieldTicket', docId: 't1' }, 't2'), false);
  assert.ok(signatureCovers({ docType: 'ticketBatch', docId: 'b1', docIds: ['t1', 't2'] }, 't2'));
  assert.deepEqual(snapshotWithoutMoney({ v: 1, totalCents: 5, taxCents: 1, lines: [{ qty: 1, unitCents: 3 }], nested: { amountCents: 2, ok: 1 } }), { v: 1, lines: [{ qty: 1 }], nested: { ok: 1 } });
});
