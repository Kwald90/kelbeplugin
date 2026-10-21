// The Release 1 collections and their write rules (docs/releases/r1-get-paid.md 2.2, 2.5, 2.6, 2.9,
// 2.10, 4.1, 4.8): who reads and writes each one, crews' own rows, the van-owner count rule,
// append-only signatures stored valid or unverified, void only by the office in a full session,
// server ticket numbers that never collide, frozen signed tickets and change orders, the
// change-order merge, the final-billing checklist, the Manitoba exemption send block and server-
// stamped move costs.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';
import { snapshotOf, signedContent } from '../../electrical-app/js/lib/signing.js';

let t, app, A, office, foreman, sam, ana;
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const push = (token, mutations) => call(app, { method: 'POST', url: '/api/v1/sync/push', token, body: { mutations } });
const pushOne = async (token, m) => (await push(token, [mut(m)])).body.results[0];
const get = (token, coll, id) => call(app, { url: `/api/v1/${coll}/${id}`, token });
const list = (token, coll) => call(app, { url: `/api/v1/${coll}?limit=500`, token });
const post = (token, coll, body) => call(app, { method: 'POST', url: `/api/v1/${coll}`, token, body });
const patch = (token, coll, id, body) => call(app, { method: 'PATCH', url: `/api/v1/${coll}/${id}`, token, body });
const del = (token, coll, id) => call(app, { method: 'DELETE', url: `/api/v1/${coll}/${id}`, token });
const PAD = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const ticketData = (o = {}) => ({
  jobId: 'job-1', kind: 'extra', date: '2026-10-20', title: 'Move two pots', description: 'Owner asked', requestedBy: 'Super', pricingBasis: 'contract-rates',
  labour: [{ employeeId: 'emp-sam', name: 'Sam Sparks', hours: 1.5 }], materials: [{ description: 'Pot light', qty: 2, unit: 'ea' }], equipment: [], photos: [],
  agreementText: 'I confirm the work listed above was requested and done.', status: 'draft', employeeId: 'emp-sam', ...o,
});
/** A signature record for a document, with a correct (or a broken) digest. */
function signature(docType, doc, { extra = {}, docId = doc.id, broken = false, ...o } = {}) {
  const snapshot = snapshotOf(docType, doc, extra);
  return { v: 1, docType, docId, jobId: 'job-1', signerName: 'Site Super', method: 'on-device', dataUrl: PAD, signedAt: new Date().toISOString(),
    snapshot, digest: broken ? '0'.repeat(64) : sha(signedContent(snapshot)), status: 'valid', capturedBy: { name: 'Sam' }, ...o };
}

before(async () => {
  if (skip) return;
  t = await createTestDatabase('r1collections');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Ticketing Electric');
  for (const [id, name, role, extra] of [['emp-off', 'Olive Office', 'office'], ['emp-fore', 'Fred Foreman', 'foreman'], ['emp-sam', 'Sam Sparks', 'electrician', { defaultEquipmentId: 'truck-sam' }], ['emp-ana', 'Ana Apprentice', 'apprentice']]) {
    assert.equal((await post(A.token, 'employees', { id, name, role, ...extra })).status, 201);
  }
  office = await addMember(t, app, A.tenantId, { role: 'office', employeeId: 'emp-off' });
  foreman = await addMember(t, app, A.tenantId, { role: 'foreman', employeeId: 'emp-fore' });
  sam = await addMember(t, app, A.tenantId, { role: 'electrician', employeeId: 'emp-sam' });
  ana = await addMember(t, app, A.tenantId, { role: 'apprentice', employeeId: 'emp-ana' });
  const r = await push(A.token, [
    mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Ticketing Electric', province: 'MB' } } }),
    mut({ collection: 'jobs', id: 'job-1', op: 'upsert', data: { number: 'J-1', title: 'Clinic', status: 'in-progress', changeOrders: [] } }),
    mut({ collection: 'locations', id: 'van-sam', op: 'upsert', data: { name: 'Van 1', kind: 'van' } }),
    mut({ collection: 'locations', id: 'shop', op: 'upsert', data: { name: 'Shop', kind: 'shop' } }),
    mut({ collection: 'equipment', id: 'truck-sam', op: 'upsert', data: { name: 'Truck 1', kind: 'truck', rateCents: 9500, rateUnit: 'day', locationId: 'van-sam', active: true } }),
    mut({ collection: 'items', id: 'item-avg', op: 'upsert', data: { name: 'Wire', costCents: 1000, avgCostCents: 1234, priceCents: 2000 } }),
    mut({ collection: 'items', id: 'item-cat', op: 'upsert', data: { name: 'Box', costCents: 300, priceCents: 700 } }),
  ]);
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
});
after(async () => { await app?.close(); await t?.close(); });

describe('who reads and writes the new collections', { skip }, () => {
  test('crews read cost codes, rules, equipment and signatures; never payroll runs; office-only writes', async () => {
    assert.equal((await post(A.token, 'costCodes', { id: 'cc-1', code: '100', name: 'Rough-in', active: true })).status, 201);
    for (const c of ['costCodes', 'rules', 'equipment', 'signatures', 'fieldTickets', 'equipmentUse', 'stockCounts']) assert.equal((await list(sam.token, c)).status, 200, c);
    assert.equal((await list(sam.token, 'payrollRuns')).status, 403);
    assert.equal((await list(foreman.token, 'payrollRuns')).status, 200, 'time-approve reads runs');
    assert.equal((await post(sam.token, 'costCodes', { code: '200', name: 'x' })).status, 403);
    assert.equal((await post(sam.token, 'equipment', { name: 'x' })).status, 403);
    assert.equal((await post(foreman.token, 'equipment', { id: 'truck-2', name: 'Truck 2', kind: 'truck' })).status, 201, 'a foreman (inventory, manager) adds trucks');
    assert.equal((await post(office.token, 'costCodes', { code: '100', name: 'Dup', active: true })).body.error.code, 'duplicate_code');
    assert.equal((await post(office.token, 'costCodes', { id: 'cc-old', code: '100', name: 'Old', active: false })).status, 201, 'an inactive copy is fine');
  });

  test('crews see and write only their own tickets and equipment use', async () => {
    assert.equal((await pushOne(foreman.token, { collection: 'fieldTickets', id: 'tk-fore', op: 'upsert', data: ticketData({ employeeId: 'emp-fore' }) })).status, 'ok');
    assert.equal((await pushOne(sam.token, { collection: 'fieldTickets', id: 'tk-sam', op: 'upsert', data: ticketData() })).status, 'ok');
    assert.equal((await pushOne(sam.token, { collection: 'fieldTickets', id: 'tk-other', op: 'upsert', data: ticketData({ employeeId: 'emp-ana' }) })).status, 'rejected');
    const mine = (await list(sam.token, 'fieldTickets')).body.data.map((x) => x.id);
    assert.deepEqual(mine, ['tk-sam']);
    assert.equal((await pushOne(sam.token, { collection: 'equipmentUse', id: 'eu-1', op: 'upsert', data: { equipmentId: 'truck-sam', jobId: 'job-1', date: '2026-10-20', qty: 1, unit: 'day', employeeId: 'emp-sam', source: 'manual' } })).status, 'ok');
    assert.equal((await pushOne(ana.token, { collection: 'equipmentUse', id: 'eu-2', op: 'upsert', data: { equipmentId: 'truck-sam', jobId: 'job-1', date: '2026-10-20', qty: 1, unit: 'day', employeeId: 'emp-sam' } })).status, 'rejected');
  });

  test('a van owner counts their own van (draft and counted); posting is for managers', async () => {
    const c = (id, data) => pushOne(sam.token, { collection: 'stockCounts', id, op: 'upsert', data: { date: '2026-10-20', lines: [{ itemId: 'item-cat', expectedQty: 4, countedQty: 3 }], ...data } });
    assert.equal((await c('cnt-1', { locationId: 'van-sam', status: 'draft' })).status, 'ok');
    assert.equal((await c('cnt-1', { locationId: 'van-sam', status: 'counted' })).status, 'ok');
    const shop = await c('cnt-2', { locationId: 'shop', status: 'draft' });
    assert.equal(shop.status, 'rejected');
    assert.match(shop.error.message, /your own van/);
    assert.equal((await c('cnt-1', { locationId: 'van-sam', status: 'posted' })).status, 'rejected');
    assert.equal((await pushOne(ana.token, { collection: 'stockCounts', id: 'cnt-3', op: 'upsert', data: { locationId: 'van-sam', status: 'draft', date: '2026-10-20' } })).status, 'rejected', 'no truck: no count');
    assert.equal((await patch(foreman.token, 'stockCounts', 'cnt-1', { status: 'posted' })).status, 200);
  });
});

describe('signatures', { skip }, () => {
  test('a correct digest is stored valid; a mismatch is stored unverified and the office is told; neither is refused', async () => {
    const tk = { id: 'tk-sig', ...ticketData() };
    const ok = await pushOne(sam.token, { collection: 'signatures', id: 'sig-ok', op: 'upsert', data: signature('fieldTicket', tk) });
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
    assert.equal((await get(A.token, 'signatures', 'sig-ok')).body.status, 'valid');
    const bad = await pushOne(sam.token, { collection: 'signatures', id: 'sig-bad', op: 'upsert', data: signature('fieldTicket', tk, { broken: true }) });
    assert.equal(bad.status, 'ok');
    const b = (await get(A.token, 'signatures', 'sig-bad')).body;
    assert.equal(b.status, 'unverified');
    assert.equal(b.unverifiedReason, 'digest_mismatch');
    const n = await t.superPool.query("SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND kind = 'signature_unverified'", [A.tenantId]);
    assert.ok(n.rows[0].n >= 1);
    const forged = await pushOne(sam.token, { collection: 'signatures', id: 'sig-forged', op: 'upsert', data: { ...signature('fieldTicket', tk), status: 'void' } });
    assert.equal(forged.status, 'ok');
    assert.equal((await get(A.token, 'signatures', 'sig-forged')).body.status, 'valid', 'the server decides the status');
  });

  test('only a schema violation or a missing image is refused; crews sign tickets, not estimates', async () => {
    const tk = { id: 'tk-x', ...ticketData() };
    const noPad = await pushOne(sam.token, { collection: 'signatures', id: 'sig-nopad', op: 'upsert', data: { ...signature('fieldTicket', tk), dataUrl: null } });
    assert.equal(noPad.error.code, 'validation_failed');
    const est = await pushOne(sam.token, { collection: 'signatures', id: 'sig-est', op: 'upsert', data: signature('estimate', { id: 'est-1', lines: [] }) });
    assert.equal(est.status, 'rejected');
    const email = await pushOne(sam.token, { collection: 'signatures', id: 'sig-mail', op: 'upsert', data: { ...signature('fieldTicket', tk), method: 'email-reply', dataUrl: null, evidence: { dataUrl: PAD, receivedAt: new Date().toISOString(), from: 'gc@example.test' } } });
    assert.equal(email.status, 'rejected', 'only the office records email acceptance');
    const officeMail = await pushOne(office.token, { collection: 'signatures', id: 'sig-mail2', op: 'upsert', data: { ...signature('fieldTicket', tk), method: 'email-reply', dataUrl: null, evidence: { dataUrl: PAD, receivedAt: new Date().toISOString(), from: 'gc@example.test' } } });
    assert.equal(officeMail.status, 'ok', JSON.stringify(officeMail));
  });

  test('append-only: never edited or deleted; void needs the office and a reason', async () => {
    assert.equal((await patch(A.token, 'signatures', 'sig-ok', { signerName: 'Someone else' })).status, 403);
    assert.equal((await del(A.token, 'signatures', 'sig-ok')).status, 403);
    assert.equal((await patch(foreman.token, 'signatures', 'sig-bad', { status: 'void', voidReason: 'Wrong ticket' })).status, 403);
    assert.equal((await patch(office.token, 'signatures', 'sig-bad', { status: 'void' })).status, 403, 'a reason is needed');
    const v = await patch(office.token, 'signatures', 'sig-bad', { status: 'void', voidReason: 'Signed the wrong ticket' });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.status, 'void');
    assert.ok(v.body.voidedAt);
    assert.equal((await patch(office.token, 'signatures', 'sig-bad', { status: 'valid' })).status, 403);
    const a = await t.superPool.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'signature.void'", [A.tenantId]);
    assert.equal(a.rows[0].n, 1);
  });
});

describe('field tickets', { skip }, () => {
  test('two offline phones get different server numbers', async () => {
    const [a, b] = await Promise.all([
      push(sam.token, [mut({ collection: 'fieldTickets', id: 'tk-n1', op: 'upsert', data: ticketData() }), mut({ collection: 'fieldTickets', id: 'tk-n2', op: 'upsert', data: ticketData() })]),
      push(foreman.token, [mut({ collection: 'fieldTickets', id: 'tk-n3', op: 'upsert', data: ticketData({ employeeId: 'emp-fore' }) })]),
    ]);
    for (const x of [...a.body.results, ...b.body.results]) assert.equal(x.status, 'ok');
    const nums = [];
    for (const id of ['tk-fore', 'tk-sam', 'tk-n1', 'tk-n2', 'tk-n3']) nums.push((await get(A.token, 'fieldTickets', id)).body.number);
    assert.equal(new Set(nums).size, nums.length, nums.join());
    for (const x of nums) assert.match(x, /^T-1\d{3}$/);
    const forged = await pushOne(sam.token, { collection: 'fieldTickets', id: 'tk-n1', op: 'upsert', baseVersion: 1, data: { ...ticketData(), number: 'T-9999' } });
    assert.ok(['ok', 'conflict'].includes(forged.status));
    assert.notEqual((await get(A.token, 'fieldTickets', 'tk-n1')).body.number, 'T-9999', 'devices never set the number');
  });

  test('signed: the reference must be a live signature of this ticket; a differing snapshot marks it unverified, the ticket lands', async () => {
    const tk = { id: 'tk-sign', ...ticketData() };
    assert.equal((await pushOne(sam.token, { collection: 'signatures', id: 'sig-tk', op: 'upsert', data: signature('fieldTicket', tk) })).status, 'ok');
    const wrong = await pushOne(sam.token, { collection: 'fieldTickets', id: 'tk-other-doc', op: 'upsert', data: ticketData({ status: 'signed', signatureId: 'sig-tk', signedAt: new Date().toISOString(), signerName: 'Super' }) });
    assert.equal(wrong.status, 'rejected');
    assert.equal(wrong.error.code, 'signature_invalid');
    // The signature then the ticket, in one push; the ticket's text was changed after signing.
    const r = await push(sam.token, [mut({ collection: 'fieldTickets', id: 'tk-sign', op: 'upsert', data: { ...ticketData({ title: 'Move THREE pots' }), status: 'signed', signatureId: 'sig-tk', signedAt: new Date().toISOString(), signerName: 'Super' } })]);
    assert.equal(r.body.results[0].status, 'ok', JSON.stringify(r.body));
    assert.equal((await get(A.token, 'signatures', 'sig-tk')).body.status, 'unverified');
    assert.equal((await get(A.token, 'signatures', 'sig-tk')).body.unverifiedReason, 'document_differs');
  });

  test('a signed ticket is frozen for everyone; the office prices, bills or voids it', async () => {
    const tk = { id: 'tk-frz', ...ticketData() };
    const s = await push(sam.token, [
      mut({ collection: 'signatures', id: 'sig-frz', op: 'upsert', data: signature('fieldTicket', tk) }),
      mut({ collection: 'fieldTickets', id: 'tk-frz', op: 'upsert', data: { ...ticketData(), status: 'signed', signatureId: 'sig-frz', signedAt: new Date().toISOString(), signerName: 'Super' } }),
    ]);
    for (const x of s.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
    assert.equal((await get(A.token, 'signatures', 'sig-frz')).body.status, 'valid');
    assert.equal((await patch(sam.token, 'fieldTickets', 'tk-frz', { title: 'changed' })).status, 403);
    assert.equal((await patch(office.token, 'fieldTickets', 'tk-frz', { title: 'changed' })).status, 403);
    assert.equal((await patch(foreman.token, 'fieldTickets', 'tk-frz', { status: 'priced' })).status, 403, 'pricing is the office');
    const p = await patch(office.token, 'fieldTickets', 'tk-frz', { status: 'priced', changeOrderId: 'co-9', office: { pricedAt: new Date().toISOString(), pricedBy: 'Olive' } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal((await del(office.token, 'fieldTickets', 'tk-frz')).status, 403, 'void it instead');
    assert.equal((await patch(office.token, 'fieldTickets', 'tk-frz', { status: 'void' })).status, 200);
    const refused = await pushOne(sam.token, { collection: 'fieldTickets', id: 'tk-ref', op: 'upsert', data: ticketData({ status: 'refused' }) });
    assert.equal(refused.status, 'rejected', 'a refusal records who and when');
    assert.equal((await pushOne(sam.token, { collection: 'fieldTickets', id: 'tk-ref', op: 'upsert', data: ticketData({ status: 'refused', refusal: { at: new Date().toISOString(), by: 'Super', reason: 'Not authorised' } }) })).status, 'ok');
  });
});

describe('change orders, closeout, exemption, move cost', { skip }, () => {
  test('an iPad signing CO-3 offline and the office adding CO-4 both survive; a signed CO is never removed', async () => {
    const co3 = { id: 'co-3', title: 'Extra circuit', amountCents: 45000, lines: [{ description: 'Circuit', qty: 1, unitCents: 45000 }], status: 'proposed' };
    const job0 = (await get(A.token, 'jobs', 'job-1')).body;
    let r = await patch(office.token, 'jobs', 'job-1', { changeOrders: [co3] });
    assert.equal(r.status, 200);
    const base = r.body.version;
    // Office adds CO-4 (online).
    r = await patch(office.token, 'jobs', 'job-1', { changeOrders: [co3, { id: 'co-4', title: 'Later extra', amountCents: 1000, status: 'proposed' }] });
    assert.equal(r.status, 200);
    // The iPad signed CO-3 while offline on the older copy (baseVersion before CO-4).
    const sig = signature('changeOrder', co3, { extra: { jobId: 'job-1' }, docId: 'co-3', changeOrderId: 'co-3' });
    const signedCo = { ...co3, status: 'approved', approvedOn: '2026-10-20', signatureId: 'sig-co3', signedAt: new Date().toISOString(), signedName: 'Owner', updatedAt: new Date().toISOString() };
    const out = await push(office.token, [
      mut({ collection: 'signatures', id: 'sig-co3', op: 'upsert', data: sig }),
      mut({ collection: 'jobs', id: 'job-1', op: 'upsert', baseVersion: base, data: { ...job0, changeOrders: [signedCo], updatedAt: new Date(Date.now() - 60000).toISOString() } }),
    ]);
    assert.equal(out.body.results[0].status, 'ok');
    assert.ok(['ok', 'conflict'].includes(out.body.results[1].status), JSON.stringify(out.body.results[1]));
    const job = (await get(A.token, 'jobs', 'job-1')).body;
    const byId = Object.fromEntries(job.changeOrders.map((c) => [c.id, c]));
    assert.equal(byId['co-3'].signatureId, 'sig-co3', 'the signing survived');
    assert.ok(byId['co-4'], 'the office change survived');
    assert.equal((await get(A.token, 'signatures', 'sig-co3')).body.status, 'valid');
    // A write that leaves the signed change order out gets it back; changing its amount is refused.
    r = await patch(office.token, 'jobs', 'job-1', { changeOrders: [byId['co-4']] });
    assert.equal(r.status, 200);
    assert.ok(r.body.changeOrders.some((c) => c.id === 'co-3'));
    r = await patch(office.token, 'jobs', 'job-1', { changeOrders: r.body.changeOrders.map((c) => (c.id === 'co-3' ? { ...c, amountCents: 1 } : c)) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'document_signed');
  });

  test('a job is marked invoiced only after its final-billing checklist', async () => {
    let r = await patch(office.token, 'jobs', 'job-1', { status: 'invoiced' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'closeout_required');
    r = await patch(office.token, 'jobs', 'job-1', { status: 'invoiced', closeout: { checkedAt: new Date().toISOString(), checkedBy: 'Olive', open: ['co_unbilled'] } });
    assert.equal(r.body.error.code, 'closeout_required');
    r = await patch(office.token, 'jobs', 'job-1', { status: 'invoiced', closeout: { checkedAt: new Date().toISOString(), checkedBy: 'Olive', open: ['co_unbilled'], override: { by: 'Olive', at: new Date().toISOString(), reason: 'Billed on the GC portal directly' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('a Manitoba invoice with RST off cannot leave draft without the evidence; estimates are not blocked', async () => {
    const inv = { status: 'draft', issueDate: '2026-10-20', taxProvince: 'MB', taxTreatment: 'gst-only', taxes: [{ id: 'GST', pct: 5, applies: { material: true, labour: true, other: true } }, { id: 'RST', pct: 7, applies: { material: false, labour: false, other: false } }], lines: [{ kind: 'labour', qty: 8, unitCents: 9500 }] };
    assert.equal((await post(office.token, 'invoices', { id: 'inv-ex', ...inv })).status, 201);
    let r = await patch(office.token, 'invoices', 'inv-ex', { status: 'sent' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'exemption_required');
    assert.deepEqual(r.body.error.details.missing, ['basis']);
    assert.equal((await post(office.token, 'invoices', { id: 'inv-ex2', ...inv, status: 'sent' })).body.error.code, 'exemption_required');
    r = await patch(office.token, 'invoices', 'inv-ex', { status: 'sent', taxExemptBasis: 'subtrade', taxExemptNumber: '1234567' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await post(office.token, 'estimates', { id: 'est-ex', ...inv, status: 'sent' })).status, 201);
  });

  test('stock moves are stamped with the item cost on create; devices cannot set it', async () => {
    const item = (await get(A.token, 'items', 'item-avg')).body;
    assert.equal(item.avgCostCents, undefined, 'only the receiving route writes the average');
    await t.superPool.query("UPDATE items SET data = data || '{\"avgCostCents\": 1234}' WHERE tenant_id = $1 AND id = 'item-avg'", [A.tenantId]);
    const m = (id, itemId, extra) => pushOne(foreman.token, { collection: 'stockMoves', id, op: 'upsert', data: { itemId, fromLocationId: 'van-sam', toLocationId: null, qty: 2, jobId: 'job-1', date: '2026-10-20', ...extra } });
    assert.equal((await m('mv-1', 'item-avg', { unitCostCents: 1 })).status, 'ok');
    assert.equal((await m('mv-2', 'item-cat')).status, 'ok');
    const s = await t.superPool.query("SELECT id, data->'unitCostCents' AS c FROM stock_moves WHERE tenant_id = $1 AND id IN ('mv-1', 'mv-2') ORDER BY id", [A.tenantId]);
    assert.deepEqual(s.rows.map((x) => x.c), [1234, 300]);
    const seen = (await get(foreman.token, 'stockMoves', 'mv-1')).body;
    assert.equal(seen.unitCostCents, undefined, 'a foreman without costs does not see it');
    assert.equal((await get(A.token, 'stockMoves', 'mv-1')).body.unitCostCents, 1234);
  });
});
