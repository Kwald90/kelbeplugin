// QuickBooks mapping without a database (docs/integrations/quickbooks.md 4, 11.2): names and
// addresses, request ids, canonical forms both ways for every entity against TG Electrical-style
// Manitoba fixtures (test/fixtures/qbo/), lossy lines, markup, negative lines, Canadian sales tax
// (keys, codes, the pre-push check, the override, purchases), payments that keep foreign lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { docTotals, lineCents } from '../../electrical-app/js/lib/money.js';
import { taxComponents } from '../../electrical-app/js/lib/tax.js';
import { qboName, nextDisplayName, stripNameSuffix, jobDisplayName, addressToQbo, addressFromQbo, addressKey, qboQuote } from '../src/qbo/map/names.js';
import { requestIdFor } from '../src/qbo/map/requestid.js';
import {
  fishtapeToCanon, qboToCanon, canonEqual, compareKey, normMethod, markerFor, stripLossySuffix, toCents, localDay, isVoidedInvoice,
} from '../src/qbo/map/canon.js';
import { canonToQbo, rebuildPaymentLines, paymentLineSummary, entityFor, SPARSE_ENTITIES } from '../src/qbo/map/to-qbo.js';
import { canonToFishtape, settlementCents, settlementRecord, depositRecord, billStatusFromQbo, linkMetaFromQbo, taxInclusiveToNet } from '../src/qbo/map/to-fishtape.js';
import { fieldsOf } from '../src/qbo/map/merge.js';
import {
  lineTaxKey, needsTaxReason, companyTaxKeys, reverseTaxKey, taxesFromCodes, expectedTax, taxMismatchMessage, compareTax, taxOverride,
  spreadPurchaseTax, purchaseCodeClaimsPst, suggestTaxCodes, codeMatchesKey, purchaseTaxKey, ratePct, taxIdForRate, NONE_KEYS,
} from '../src/qbo/map/tax.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/qbo/${name}.json`, import.meta.url), 'utf8'));
const REF = fixture('reference');
const M = fixture('mappings');
const F = fixture('fishtape');
const Q = fixture('transactions');
const CUSTOMERS = fixture('customers');
const ITEMS = fixture('items');
const VE = fixture('vendors-employees');
const byId = (list, id) => list.find((x) => x.id === id || x.Id === id);
const clone = (v) => JSON.parse(JSON.stringify(v));

// Links TG would have after the wizard: Fishtape id -> QBO id per collection.
const LINKS = {
  clients: { 'c-prairie': '58', 'c-dana': '60' },
  jobs: { 'job-1042': '59' },
  items: { 'item-panel': '101', 'item-pot': '102' },
  estimates: { 'est-2001': '501' },
  invoices: { 'inv-3001': '201', 'inv-3002': '202', 'inv-3010': '204' },
  vendors: { 'v-westburne': '701' },
  employees: { 'emp-kelvin': '81' },
  purchaseOrders: { 'po-5001': '801' },
};
const ITEM_TYPES = Object.fromEntries(ITEMS.map((i) => [i.Id, i.Type]));
const refs = {
  qboIdFor: (c, id) => LINKS[c]?.[id] ?? null,
  fishtapeIdFor: (c, q) => Object.entries(LINKS[c] || {}).find(([, v]) => v === String(q))?.[0] ?? null,
  itemKind: (q) => (Object.values(LINKS.items).includes(String(q)) ? 'material' : null),
  itemType: (q) => ITEM_TYPES[q] ?? null,
  clientOfJob: (j) => byId(F.jobs, j)?.clientId ?? null,
  employeeEntity: () => 'Employee',
  parentOf: (q) => CUSTOMERS.find((x) => x.Id === String(q))?.ParentRef?.value ?? null,
};
const FEATURES = { salesTax: true, customTxnNumbers: true, discounts: true, classes: true, multicurrency: false, purchaseOrders: true, purchaseCustomTxnNumbers: false };
const ctx = (collection, link = {}, extra = {}) => ({
  collection, mappings: M, features: FEATURES, company: { province: 'MB', zone: 'America/Winnipeg' }, refs, rates: REF,
  link: { role: 'main', ...link, meta: { ...(link.meta || {}) } }, now: '2026-10-20T15:00:00Z', ...extra,
});
/** Every field of a collection is the same on both sides. */
function assertSame(collection, L, R, skip = []) {
  for (const f of fieldsOf(collection)) {
    if (skip.includes(f)) continue;
    assert.ok(canonEqual(collection, f, L[f], R[f]), `${collection}.${f}: ${JSON.stringify(compareKey(collection, f, L[f]))} vs ${JSON.stringify(compareKey(collection, f, R[f]))}`);
  }
}
/** What QBO answers to a create: the body with ids on the object and its lines. */
function asCreated(body, id = '999') {
  const o = clone(body);
  o.Id = id; o.SyncToken = '0';
  (o.Line || []).forEach((l, i) => { l.Id = String(i + 1); });
  return o;
}

const INV_META = { marker: 'Fishtape ref 0123456789ab', lineIds: { 0: '1', 1: '2', 2: '3', markup: '4' }, globalTax: 'TaxExcluded' };

// ---------------------------------------------------------------------------------------------

test('names: QBO name rules, " (n)" suffixes, job names', () => {
  assert.equal(qboName(' Smith: "Dana"\tand\nCo '), 'Smith Dana and Co');
  assert.equal(qboName('x'.repeat(130)).length, 100);
  assert.equal(nextDisplayName('Dana Smith', 1), 'Dana Smith');
  assert.equal(nextDisplayName('Dana Smith', 2), 'Dana Smith (2)');
  assert.equal(nextDisplayName('Dana Smith', 9), 'Dana Smith (9)');
  assert.equal(nextDisplayName('Dana Smith', 10), null);
  assert.equal(nextDisplayName('y'.repeat(100), 3), `${'y'.repeat(96)} (3)`);
  assert.equal(stripNameSuffix('Dana Smith (4)'), 'Dana Smith');
  assert.equal(stripNameSuffix('Unit (12)'), 'Unit (12)');
  assert.equal(jobDisplayName(byId(F.jobs, 'job-1042')), 'J-1042 Panel upgrade 12 Elm');
  assert.equal(jobDisplayName({ id: 'abcdef123456', number: '', title: '' }), 'Job abcdef12');
});

test('addresses: one string to QBO and back, compared loosely', () => {
  const a = addressToQbo('120 Main St, Winnipeg, MB R3C1A1');
  assert.deepEqual(a, { Line1: '120 Main St', City: 'Winnipeg', CountrySubDivisionCode: 'MB', PostalCode: 'R3C 1A1', Country: 'CA' });
  assert.equal(addressFromQbo(a), '120 Main St, Winnipeg, MB R3C 1A1');
  for (const s of ['Unit 4, 120 Main St, Winnipeg, MB R3C 1A1', 'Box 12, Steinbach MB', '42 Harbour St, Regina, SK S4P 3Y2, Canada', '8 Lakeshore Dr\nKenora, ON P9N 1A1']) {
    assert.equal(addressKey(addressFromQbo(addressToQbo(s))), addressKey(addressFromQbo(addressToQbo(addressFromQbo(addressToQbo(s))))), s);
  }
  assert.equal(addressKey('120 Main St., Winnipeg MB  R3C1A1'), addressKey('120 main st, winnipeg, mb r3c 1a1'));
  assert.equal(addressKey('42 Harbour St, Regina, SK S4P 3Y2, Canada'), addressKey('42 Harbour St, Regina, SK S4P 3Y2'));
  assert.equal(addressToQbo(''), null);
  assert.equal(addressFromQbo({ Line1: '1 A St', Line2: 'Suite 2', City: 'Brandon', CountrySubDivisionCode: 'MB' }), '1 A St, Suite 2, Brandon, MB');
});

test('qboQuote escapes \\ and \', refuses % and _', () => {
  assert.equal(qboQuote("O'Brien Electric"), "O\\'Brien Electric");
  assert.equal(qboQuote('back\\slash'), 'back\\\\slash');
  assert.equal(qboQuote("a\\'b"), "a\\\\\\'b");
  for (const bad of ['100%', 'name_with', '%', '_']) assert.throws(() => qboQuote(bad), (e) => e.code === 'validation_failed' && e.statusCode === 400, bad);
  assert.equal(qboQuote(null), '');
});

test('request ids: stable, 36 base32 characters, every part counts', () => {
  const a = requestIdFor(['t-1', 'link-1', 'create']);
  assert.equal(a, requestIdFor(['t-1', 'link-1', 'create']));
  assert.equal(a.length, 36);
  assert.match(a, /^[a-z2-7]{36}$/);
  assert.notEqual(a, requestIdFor(['t-1', 'link-1', 'update', 4, '3']));
  assert.notEqual(requestIdFor(['a', 'bc']), requestIdFor(['ab', 'c']));
  assert.equal(requestIdFor(['x', null]), requestIdFor(['x', '']));
  assert.notEqual(requestIdFor(['t', 'l', 'update', 4, '3']), requestIdFor(['t', 'l', 'update', 5, '3']));
  assert.throws(() => requestIdFor([]), TypeError);
});

test('markers and payment method keys', () => {
  assert.equal(markerFor('01234567-89ab-cdef-0123-456789abcdef'), 'Fishtape ref 0123456789ab');
  assert.throws(() => markerFor('short'));
  for (const [i, o] of [['cheque', 'check'], ['Check', 'check'], ['etransfer', 'e-transfer'], ['e-transfer', 'e-transfer'], ['Interac', 'e-transfer'],
    ['cash', 'cash'], ['card', 'card'], ['transfer', 'transfer'], ['credit', 'credit'], ['bitcoin', 'other'], ['', null], [null, null]]) assert.equal(normMethod(i), o, String(i));
});

test('money and days: cents both ways, local dates in the company zone', () => {
  assert.equal(toCents(10.115), 1012);
  assert.equal(toCents(-10.115), -1012);
  assert.equal(toCents(3083.84), 308384);
  assert.equal(toCents('2.89'), 289);
  assert.equal(toCents(undefined), 0);
  // 19:00 in Winnipeg is the same day, even though UTC has moved on (4.7)
  assert.equal(localDay('2026-10-16T00:00:00Z', 'America/Winnipeg'), '2026-10-15');
  assert.equal(localDay('2026-10-15', 'America/Winnipeg'), '2026-10-15');
  assert.equal(localDay(null), null);
});

// ---------------------------------------------------------------------------------------------
// Customers, jobs, items, vendors

test('customers: Fishtape client and QBO customer agree field by field', () => {
  const L = fishtapeToCanon('clients', byId(F.clients, 'c-prairie'), ctx('clients'));
  const R = qboToCanon('Customer', byId(CUSTOMERS, '58'), ctx('clients'));
  assert.equal(L.type, 'business');
  assert.equal(R.type, 'business');
  assertSame('clients', L, R, ['notes']); // e-mail case, phone format and postal spacing are not differences
  assert.ok(!canonEqual('clients', 'notes', L.notes, R.notes)); // push only; QBO's collections note is never pulled
});

test('customers: create body, round trip, and a pull that never touches notes', () => {
  const c = ctx('clients', { meta: {} });
  const L = fishtapeToCanon('clients', byId(F.clients, 'c-prairie'), c);
  const { entity, body, sparse } = canonToQbo('clients', L, c);
  assert.equal(entity, 'Customer');
  assert.equal(sparse, false);
  assert.deepEqual(body, {
    DisplayName: 'Prairie Homes Ltd', CompanyName: 'Prairie Homes Ltd', PrimaryEmailAddr: { Address: 'AP@PrairieHomes.example' },
    PrimaryPhone: { FreeFormNumber: '204 555 0142' },
    BillAddr: { Line1: '120 Main St', City: 'Winnipeg', CountrySubDivisionCode: 'MB', PostalCode: 'R3C 1A1', Country: 'CA' },
    Notes: 'Prefers invoices by email', Active: true,
  });
  assert.ok(!('Id' in body) && !('SyncToken' in body));
  assertSame('clients', L, qboToCanon('Customer', asCreated(body), c));

  // A sparse update of only the phone, then a residential client clears CompanyName
  const up = canonToQbo('clients', { ...L, phone: '204-555-0000' }, c, { existing: byId(CUSTOMERS, '58'), fields: ['phone'] });
  assert.equal(up.sparse, true);
  assert.deepEqual(up.body, { PrimaryPhone: { FreeFormNumber: '204-555-0000' } });
  const res = canonToQbo('clients', { ...L, type: 'residential' }, c, { existing: byId(CUSTOMERS, '58'), fields: ['type'] });
  assert.equal(res.body.CompanyName, '');

  // Pull: an industrial client stays industrial; notes are never written
  const R = qboToCanon('Customer', byId(CUSTOMERS, '58'), c);
  const patch = canonToFishtape('clients', R, c, { existing: { ...byId(F.clients, 'c-prairie'), type: 'industrial' } });
  assert.equal(patch.type, 'industrial');
  assert.ok(!('notes' in patch));
  const fresh = canonToFishtape('clients', qboToCanon('Customer', byId(CUSTOMERS, '62'), c), c);
  assert.deepEqual(fresh, { name: 'Kenora Lakeside Lodge', type: 'commercial', email: 'office@lakesidelodge.example', phone: '', address: '8 Lakeshore Dr, Kenora, ON P9N 1A1' });
});

test('customers: a name sent with a " (2)" suffix reads back as unchanged', () => {
  const c = ctx('clients', { meta: { displayName: 'Dana Smith (2)' } });
  const L = fishtapeToCanon('clients', byId(F.clients, 'c-dana'), c);
  const R = qboToCanon('Customer', { ...byId(CUSTOMERS, '60'), DisplayName: 'Dana Smith (2)' }, c);
  assert.equal(R.name, 'Dana Smith');
  assert.ok(canonEqual('clients', 'name', L.name, R.name));
  assert.equal(canonToQbo('clients', L, c, { existing: byId(CUSTOMERS, '60'), fields: ['name'] }).body.DisplayName, 'Dana Smith (2)');
  assert.equal(canonToQbo('clients', L, ctx('clients'), { displayName: nextDisplayName('Dana Smith', 3) }).body.DisplayName, 'Dana Smith (3)');
  // Renamed in Fishtape: the suffix is not carried over
  assert.equal(canonToQbo('clients', { ...L, name: 'Dana Smith-Penner' }, c, { existing: byId(CUSTOMERS, '60'), fields: ['name'] }).body.DisplayName, 'Dana Smith-Penner');
});

test('jobs become sub-customers of their client (push only)', () => {
  const c = ctx('jobs');
  const L = fishtapeToCanon('jobs', byId(F.jobs, 'job-1042'), c);
  assert.deepEqual(L, { name: 'J-1042 Panel upgrade 12 Elm', parentRef: '58', address: '12 Elm St, Steinbach, MB R5G 1A1', active: true });
  assertSame('jobs', L, qboToCanon('Customer', byId(CUSTOMERS, '59'), c));
  const { entity, body } = canonToQbo('jobs', L, c);
  assert.equal(entity, 'Customer');
  assert.equal(body.Job, true);
  assert.equal(body.BillWithParent, true);
  assert.deepEqual(body.ParentRef, { value: '58' });
  assert.equal(body.ShipAddr.PostalCode, 'R5G 1A1');
  assert.deepEqual(canonToFishtape('jobs', L, c), {});
});

test('items: prices in dollars, SKU case ignored, NonInventory on create, full update keeps QBO fields', () => {
  const c = ctx('items');
  const L = fishtapeToCanon('items', byId(F.items, 'item-panel'), c);
  const R = qboToCanon('Item', byId(ITEMS, '101'), c);
  assert.equal(L.priceCents, 125000);
  assert.equal(R.priceCents, 125000);
  assertSame('items', L, R);
  const create = canonToQbo('items', L, c).body;
  assert.equal(create.Type, 'NonInventory');
  assert.deepEqual(create.IncomeAccountRef, { value: '45' });
  assert.deepEqual(create.ExpenseAccountRef, { value: '71' });
  assert.equal(create.UnitPrice, 1250);
  assert.equal(create.PurchaseCost, 890);
  assert.ok(!('TrackQtyOnHand' in create));
  // Full update of an Inventory item: QBO's own fields kept, quantities never written
  const pot = fishtapeToCanon('items', byId(F.items, 'item-pot'), c);
  const up = canonToQbo('items', { ...pot, priceCents: 3995 }, c, { existing: byId(ITEMS, '102') });
  assert.equal(up.sparse, false);
  assert.equal(up.body.Type, 'Inventory');
  assert.equal(up.body.QtyOnHand, 140);
  assert.equal(up.body.UnitPrice, 39.95);
  assert.ok(!('Id' in up.body) && !('SyncToken' in up.body));
  assert.deepEqual(canonToFishtape('items', R, c, { existing: byId(F.items, 'item-panel'), fields: ['priceCents', 'name'] }), { priceCents: 125000, name: '200A panel (Siemens)' });
});

test('vendors: every field both ways; full update keeps QBO-only fields', () => {
  const c = ctx('vendors');
  const L = fishtapeToCanon('vendors', byId(F.vendors, 'v-westburne'), c);
  const R = qboToCanon('Vendor', byId(VE.vendors, '701'), c);
  assertSame('vendors', L, R);
  const up = canonToQbo('vendors', { ...L, accountNumber: 'TG-50000', t5018: true }, c, { existing: byId(VE.vendors, '701') });
  assert.equal(up.body.AcctNum, 'TG-50000');
  assert.equal(up.body.T5018Eligible, true);
  assert.deepEqual(up.body.TermRef, { value: '3' });
  assert.equal(up.body.Vendor1099, false);
  const pulled = canonToFishtape('vendors', qboToCanon('Vendor', byId(VE.vendors, '704'), c), c);
  assert.equal(pulled.name, 'Sparky Subcontracting');
  assert.equal(pulled.t5018, true);
  assert.equal(pulled.active, true);
});

// ---------------------------------------------------------------------------------------------
// Estimates and invoices

test('a Manitoba invoice: Fishtape and QBO agree on every field, tax by code id', () => {
  const inv = byId(F.invoices, 'inv-3001');
  const t = docTotals(inv);
  // $1,250.00 + $216.75 materials, 10% markup $146.68, $1,140.00 labour = $2,753.43
  // GST 5% = $137.67, RST 7% = $192.74 -> $3,083.84 (QBO's two TaxLines)
  assert.equal(t.markupCents, 14668);
  assert.equal(t.subtotalCents, 275343);
  assert.deepEqual(t.taxes.map((x) => [x.id, x.cents]), [['GST', 13767], ['RST', 19274]]);
  assert.equal(t.totalCents, toCents(Q.invoice.TotalAmt));
  assert.equal(compareTax(t, Q.invoice.TxnTaxDetail, REF).equal, true);

  const c = ctx('invoices', { meta: INV_META });
  const L = fishtapeToCanon('invoices', inv, c);
  const R = qboToCanon('Invoice', Q.invoice, c);
  assert.equal(L.jobRef, '59'); // job sub-customer
  assert.equal(L.clientRef, null);
  assert.equal(R.jobRef, '59');
  assert.equal(L.status, 'open'); // partial collapses to open
  assert.equal(L.lines.length, 4);
  assert.deepEqual(L.lines.map((l) => [l.itemRef, l.amountCents, l.taxCodeId]), [['101', 125000, '10'], ['21', 21675, '10'], ['22', 114000, '10'], ['24', 14668, '10']]);
  assert.equal(L.lines[3].description, 'Materials markup (10%)');
  assert.equal(R.title, 'Panel upgrade'); // the marker is not part of the title
  assert.equal(R.estimateRef, '501');
  assertSame('invoices', L, R);
});

test('invoice create body (golden) and its round trip', () => {
  const c = ctx('invoices', { meta: { marker: 'Fishtape ref 0123456789ab' } });
  const inv = byId(F.invoices, 'inv-3001');
  const L = fishtapeToCanon('invoices', inv, c);
  const out = canonToQbo('invoices', L, c, { billEmail: 'ap@prairiehomes.example' });
  assert.equal(out.entity, 'Invoice');
  assert.deepEqual(out.lossyLines, []);
  assert.deepEqual(out.body, {
    DocNumber: 'INV-3001', CustomerRef: { value: '59' }, TxnDate: '2026-10-15', DueDate: '2026-11-14',
    CustomerMemo: { value: 'Thank you for your business.' }, PrivateNote: 'Fishtape ref 0123456789ab · Panel upgrade',
    Line: [
      { DetailType: 'SalesItemLineDetail', Amount: 1250, Description: '200A panel (Siemens)', SalesItemLineDetail: { ItemRef: { value: '101' }, Qty: 1, UnitPrice: 1250, TaxCodeRef: { value: '10' } } },
      { DetailType: 'SalesItemLineDetail', Amount: 216.75, Description: '14/2 NMD90 wire (m)', SalesItemLineDetail: { ItemRef: { value: '21' }, Qty: 75, UnitPrice: 2.89, TaxCodeRef: { value: '10' } } },
      { DetailType: 'SalesItemLineDetail', Amount: 1140, Description: 'Electrician labour', SalesItemLineDetail: { ItemRef: { value: '22' }, Qty: 12, UnitPrice: 95, TaxCodeRef: { value: '10' } } },
      { DetailType: 'SalesItemLineDetail', Amount: 146.68, Description: 'Materials markup (10%)', SalesItemLineDetail: { ItemRef: { value: '24' }, Qty: 1, UnitPrice: 146.68, TaxCodeRef: { value: '10' } } },
    ],
    GlobalTaxCalculation: 'TaxExcluded', LinkedTxn: [{ TxnId: '501', TxnType: 'Estimate' }],
    EmailStatus: 'NotSet', PrintStatus: 'NotSet', AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false,
    BillEmail: { Address: 'ap@prairiehomes.example' },
  });
  const created = asCreated(out.body, '201');
  const meta = linkMetaFromQbo('Invoice', created, c);
  assert.deepEqual(meta.lineIds, { 0: '1', 1: '2', 2: '3', markup: '4' });
  assert.equal(meta.globalTax, 'TaxExcluded');
  const c2 = ctx('invoices', { meta: { ...c.link.meta, ...meta } });
  assertSame('invoices', fishtapeToCanon('invoices', inv, c2), qboToCanon('Invoice', created, c2));
});

test('invoice update: sparse, lines matched by Line.Id keep QBO-only attributes, GlobalTaxCalculation sent back', () => {
  const c = ctx('invoices', { meta: { ...INV_META, globalTax: 'TaxExcluded' } });
  const inv = clone(byId(F.invoices, 'inv-3001'));
  inv.lines[2].qty = 14; // two more hours
  const L = fishtapeToCanon('invoices', inv, c);
  const out = canonToQbo('invoices', L, c, { existing: Q.invoice, fields: ['lines'] });
  assert.equal(out.sparse, true);
  assert.deepEqual(Object.keys(out.body).sort(), ['GlobalTaxCalculation', 'Line', 'PrivateNote']);
  const labour = out.body.Line.find((l) => l.Id === '3');
  assert.equal(labour.Amount, 1330);
  assert.equal(labour.SalesItemLineDetail.ServiceDate, '2026-10-14');
  assert.deepEqual(labour.SalesItemLineDetail.ClassRef, { value: '900', name: 'Residential' });
  assert.deepEqual(out.body.Line.map((l) => l.Id), ['1', '2', '3', '4']);
  assert.equal(out.body.PrivateNote, 'Fishtape ref 0123456789ab · Panel upgrade');
  // TaxInclusive objects keep their setting on update
  const kept = canonToQbo('invoices', L, ctx('invoices', { meta: { ...INV_META, globalTax: 'TaxInclusive' } }), { existing: Q.invoice, fields: ['lines'] });
  assert.equal(kept.body.GlobalTaxCalculation, 'TaxInclusive');
  // QBO numbering: no DocNumber is sent
  const qn = canonToQbo('invoices', L, { ...c, mappings: { ...M, option: { ...M.option, numbering: 'quickbooks' } } });
  assert.ok(!('DocNumber' in qn.body));
});

test('invoice pull: unchanged lines keep everything Fishtape has; the markup stays a percentage', () => {
  const c = ctx('invoices', { meta: INV_META });
  const inv = byId(F.invoices, 'inv-3001');
  const report = {};
  const patch = canonToFishtape('invoices', qboToCanon('Invoice', Q.invoice, c), c, { existing: inv, report });
  assert.deepEqual(patch.lines, inv.lines); // labourHours and changeOrderId kept through meta.lineIds
  assert.equal(patch.markupPct, 10);
  assert.equal(report.markup, 'kept');
  assert.equal(report.taxShape, false);
  assert.equal(patch.taxTreatment, 'pst-all');
  assert.equal(patch.taxProvince, 'MB');
  assert.deepEqual(patch.taxes.map((x) => [x.id, x.pct]), [['GST', 5], ['RST', 7]]);
  assert.equal(patch.clientId, 'c-prairie');
  assert.equal(patch.jobId, 'job-1042');
  assert.equal(patch.estimateId, 'est-2001');
  assert.equal(patch.number, 'INV-3001');
  assert.ok(!('status' in patch)); // sent/partial/paid follow payments, never the pull

  // The bookkeeper adds two hours in QBO
  const edited = clone(Q.invoice);
  Object.assign(edited.Line[2], { Amount: 1330 });
  edited.Line[2].SalesItemLineDetail.Qty = 14;
  const p2 = canonToFishtape('invoices', qboToCanon('Invoice', edited, c), c, { existing: inv, fields: ['lines'] });
  assert.deepEqual(p2.lines[2], { description: 'Electrician labour', qty: 14, unitCents: 9500, kind: 'labour', changeOrderId: 'co-1' });
  assert.equal(p2.markupPct, 10);
  // ...or edits the markup line: markupPct goes to 0 and the line becomes a material line
  const mk = clone(Q.invoice);
  Object.assign(mk.Line[3], { Amount: 200 });
  mk.Line[3].SalesItemLineDetail.UnitPrice = 200;
  const report3 = {};
  const p3 = canonToFishtape('invoices', qboToCanon('Invoice', mk, c), c, { existing: inv, fields: ['lines'], report: report3 });
  assert.equal(p3.markupPct, 0);
  assert.equal(report3.markup, 'dropped');
  assert.deepEqual(p3.lines[3], { description: 'Materials markup (10%)', qty: 1, unitCents: 20000, kind: 'material' });
  // A void in QBO only sets the status
  const voided = { ...clone(Q.invoice), TotalAmt: 0, PrivateNote: 'Voided', Line: Q.invoice.Line.map((l) => ({ ...l, Amount: 0 })) };
  assert.equal(isVoidedInvoice(voided), true);
  assert.equal(isVoidedInvoice(Q.invoice), false);
  assert.deepEqual(canonToFishtape('invoices', qboToCanon('Invoice', voided, c), c, { existing: inv, fields: ['status'] }), { status: 'void' });
});

test('a QBO-only invoice becomes a Fishtape record (HST ON keeps its province; Service items are labour)', () => {
  const c = ctx('invoices');
  const report = {};
  const rec = canonToFishtape('invoices', qboToCanon('Invoice', Q.invoiceQboOnly, c), c, { report });
  assert.equal(rec.number, '1077');
  assert.equal(rec.status, 'sent');
  assert.equal(rec.issueDate, '2026-10-08');
  assert.deepEqual(rec.lines, [{ description: 'Service call', qty: 1, unitCents: 80000, kind: 'labour' }]);
  assert.equal(rec.taxProvince, 'ON');
  assert.equal(rec.taxTreatment, 'standard');
  assert.deepEqual(rec.taxes.map((x) => [x.id, x.pct]), [['HST', 13]]);
  assert.equal(docTotals(rec).totalCents, toCents(Q.invoiceQboOnly.TotalAmt));
  assert.equal(report.taxShape, false);
  // Tax-inclusive invoices are not converted: gross amounts, no taxes, flagged for review
  const r2 = {};
  const inc = canonToFishtape('invoices', qboToCanon('Invoice', Q.invoiceTaxInclusive, c), c, { report: r2 });
  assert.equal(r2.taxInclusive, true);
  assert.deepEqual(inc.taxes, []);
  assert.equal(docTotals(inc).totalCents, 11200);
});

test('a pulled document whose kind has two different codes needs review (tax_shape)', () => {
  const c = ctx('invoices', { meta: INV_META });
  const odd = clone(Q.invoice);
  odd.Line[1].SalesItemLineDetail.TaxCodeRef = { value: '11' }; // GST only on one material line
  const report = {};
  const patch = canonToFishtape('invoices', qboToCanon('Invoice', odd, c), c, { existing: byId(F.invoices, 'inv-3001'), fields: ['lines'], report });
  assert.equal(report.taxShape, true);
  assert.ok(!('taxes' in patch)); // the record keeps its own tax until a person decides
  const unmapped = clone(Q.invoice);
  unmapped.Line.forEach((l) => { if (l.SalesItemLineDetail) l.SalesItemLineDetail.TaxCodeRef = { value: '999' }; });
  const r2 = {};
  canonToFishtape('invoices', qboToCanon('Invoice', unmapped, c), c, { existing: byId(F.invoices, 'inv-3001'), fields: ['lines'], report: r2 });
  assert.equal(r2.taxShape, true);
});

test('lossy lines: a QBO price Fishtape cannot hold comes in as qty 1 and never ping-pongs', () => {
  const c = ctx('estimates', { meta: { lineIds: { 0: '1', 1: '2', 2: '3' }, lossyLines: [2], marker: 'Fishtape ref fedcba987654' } });
  const R = qboToCanon('Estimate', Q.estimate, c);
  assert.deepEqual(R.lines[2].lossy, { qty: 3, unitPrice: 12.3333 });
  assert.equal(R.lines[2].amountCents, 3700);
  assert.equal(R.lines[1].itemRef, null); // description-only
  assert.equal(R.status, 'accepted');
  const est = byId(F.estimates, 'est-2001');
  const L = fishtapeToCanon('estimates', est, c);
  assert.equal(L.date, '2026-10-01'); // created 20:30 in Winnipeg on Oct 1 (01:30 UTC on Oct 2)
  assert.equal(L.lines[2].description, 'Fixture install');
  assertSame('estimates', L, R);
  // Pulled fresh, the line gets the " (3 × $12.3333)" note and its index is reported
  const report = {};
  const rec = canonToFishtape('estimates', qboToCanon('Estimate', Q.estimate, ctx('estimates')), ctx('estimates'), { report });
  assert.deepEqual(rec.lines[2], { description: 'Fixture install (3 × $12.3333)', qty: 1, unitCents: 3700, kind: 'labour' });
  assert.deepEqual(rec.lines[1], { description: 'Permit and inspection included', qty: 0, unitCents: 0, kind: 'other' });
  assert.deepEqual(report.lossyLines, [2]);
  assert.equal(rec.status, 'accepted');
  assert.equal(stripLossySuffix('Fixture install (3 × $12.3333)'), 'Fixture install');
  assert.equal(stripLossySuffix('Labour (2.6667 h × $95.00)'), 'Labour');
  // An unchanged lossy line goes back to QBO exactly as QBO has it
  const out = canonToQbo('estimates', L, c, { existing: Q.estimate, fields: ['lines'] });
  assert.deepEqual(out.body.Line[2], Q.estimate.Line[2]);
  assert.deepEqual(out.body.Line[1], { Id: '2', DetailType: 'DescriptionOnly', Description: 'Permit and inspection included', DescriptionLineDetail: {} });
  assert.deepEqual(out.lossyLines, [2]);
  // Changed in Fishtape: sent as qty 1 with the plain description
  const changed = clone(est);
  changed.lines[2].unitCents = 4000;
  const out2 = canonToQbo('estimates', fishtapeToCanon('estimates', changed, c), c, { existing: Q.estimate, fields: ['lines'] });
  assert.deepEqual(out2.body.Line[2].SalesItemLineDetail.Qty, 1);
  assert.equal(out2.body.Line[2].Description, 'Fixture install');
  assert.equal(out2.body.Line[2].Amount, 40);
});

test('lossy push: a quantity QBO cannot hold goes out as qty 1 with the hours in the text', () => {
  const c = ctx('invoices', { meta: { marker: 'Fishtape ref 0123456789ab' } });
  const inv = { ...byId(F.invoices, 'inv-3001'), markupPct: 0, lines: [{ description: 'Labour', qty: 2.000004999, unitCents: 125000, kind: 'labour' }] };
  assert.equal(lineCents(inv.lines[0]), 250001);
  const out = canonToQbo('invoices', fishtapeToCanon('invoices', inv, c), c);
  assert.deepEqual(out.lossyLines, [0]);
  const line = out.body.Line[0];
  assert.equal(line.Amount, 2500.01);
  assert.equal(line.SalesItemLineDetail.Qty, 1);
  assert.equal(line.SalesItemLineDetail.UnitPrice, 2500.01);
  assert.equal(line.Description, 'Labour (2 h × $1250.00)');
  // Read back with meta.lossyLines, it equals the Fishtape line
  const c2 = ctx('invoices', { meta: { marker: 'Fishtape ref 0123456789ab', lossyLines: out.lossyLines } });
  assert.ok(canonEqual('invoices', 'lines', fishtapeToCanon('invoices', inv, c2).lines, qboToCanon('Invoice', asCreated(out.body), c2).lines));
});

test('negative lines go on the deposit item; a document with no-tax lines needs a reason', () => {
  const c = ctx('invoices', { meta: {} });
  const inv = { ...byId(F.invoices, 'inv-3001'), markupPct: 0, lines: [
    { description: 'Panel upgrade', qty: 1, unitCents: 300000, kind: 'material' },
    { description: 'Less deposit (INV-2990)', qty: 1, unitCents: -100000, kind: 'other' },
  ] };
  const L = fishtapeToCanon('invoices', inv, c);
  assert.equal(L.lines[1].itemRef, '25');
  const out = canonToQbo('invoices', L, c);
  assert.equal(out.body.Line[1].Amount, -1000);
  assert.deepEqual(out.body.Line[1].SalesItemLineDetail.ItemRef, { value: '25' });
  assert.equal(docTotals(inv).totalCents, 224000);
  // No tax, no reason: blocked/tax_reason
  const none = { ...inv, taxTreatment: 'none', taxes: [], taxPct: 0 };
  assert.equal(needsTaxReason(none), true);
  assert.equal(lineTaxKey(none, 'material'), 'NONE');
  assert.equal(needsTaxReason({ ...none, taxNoneReason: 'exempt' }), false);
  assert.equal(fishtapeToCanon('invoices', { ...none, taxNoneReason: 'exempt' }, c).lines[0].taxCodeId, '12');
});

test('estimate status: Closed or Converted in QBO is never reopened', () => {
  const c = ctx('estimates', { meta: { marker: 'Fishtape ref fedcba987654' } });
  const L = fishtapeToCanon('estimates', { ...byId(F.estimates, 'est-2001'), status: 'declined' }, c);
  assert.equal(L.status, 'rejected');
  assert.equal(canonToQbo('estimates', L, c, { existing: Q.estimate, fields: ['status'] }).body.TxnStatus, 'Rejected');
  assert.ok(!('TxnStatus' in canonToQbo('estimates', L, c, { existing: { ...Q.estimate, TxnStatus: 'Converted' }, fields: ['status'] }).body));
  const acc = canonToQbo('estimates', { ...L, status: 'accepted' }, c, { existing: { ...Q.estimate, TxnStatus: 'Pending' }, fields: ['status'] });
  assert.equal(acc.body.TxnStatus, 'Accepted');
  assert.equal(acc.body.AcceptedDate, '2026-10-20');
  for (const [s, f] of [['Pending', 'sent'], ['Accepted', 'accepted'], ['Closed', 'accepted'], ['Converted', 'accepted'], ['Rejected', 'declined']]) {
    const R = qboToCanon('Estimate', { ...Q.estimate, TxnStatus: s }, c);
    assert.equal(canonToFishtape('estimates', R, c, { existing: { status: 'draft' }, fields: ['status'] }).status, f, s);
  }
});

test('cuts: notes to 1,000, numbers and references to 21, both sides alike', () => {
  const c = ctx('invoices', { meta: INV_META });
  const long = 'n'.repeat(1500);
  const L = fishtapeToCanon('invoices', { ...byId(F.invoices, 'inv-3001'), notes: long }, c);
  const sent = canonToQbo('invoices', L, c).body.CustomerMemo.value;
  assert.equal(sent.length, 1000);
  const R = qboToCanon('Invoice', { ...Q.invoice, CustomerMemo: { value: sent } }, c);
  assert.ok(canonEqual('invoices', 'notes', L.notes, R.notes));
  // The cut note never comes back over the full one
  assert.ok(!('notes' in canonToFishtape('invoices', R, c, { existing: { notes: long }, fields: ['notes'] })));
  const p = fishtapeToCanon('payments', { ...byId(F.payments, 'pay-1'), reference: 'E-TRANSFER CA1234567890XYZ' }, ctx('payments', { qbo_line: '201' }));
  assert.equal(p.reference, 'E-TRANSFER CA12345678');
  assert.ok(!('reference' in canonToFishtape('payments', { ...p }, ctx('payments'), { existing: { reference: 'E-TRANSFER CA1234567890XYZ' }, fields: ['reference'] })));
});

test('a document on a QBO project that is no linked job belongs to the parent\'s client (4.7)', () => {
  const c = ctx('invoices');
  const qbo = { ...Q.invoiceQboOnly, CustomerRef: { value: '64' } }; // "Prairie Homes Ltd:Basement suite wiring"
  const R = qboToCanon('Invoice', qbo, c);
  assert.equal(R.clientRef, '58');
  assert.equal(R.jobRef, null);
  const rec = canonToFishtape('invoices', R, c);
  assert.equal(rec.clientId, 'c-prairie');
  assert.ok(!rec.jobId);
  // Stored like that, Fishtape's side is the same: no push of another CustomerRef, no conflict
  const L = fishtapeToCanon('invoices', rec, c);
  assert.ok(canonEqual('invoices', 'clientRef', L.clientRef, R.clientRef));
  assert.ok(canonEqual('invoices', 'jobRef', L.jobRef, R.jobRef));
  // A linked job's sub-customer is still the job; a deeper sub-customer finds its nearest linked parent
  assert.deepEqual([qboToCanon('Invoice', { ...qbo, CustomerRef: { value: '59' } }, c)].map((x) => [x.clientRef, x.jobRef]), [[null, '59']]);
  const deep = ctx('invoices', {}, { refs: { ...refs, parentOf: (q) => ({ 66: '65', 65: '59' })[q] ?? null } });
  const d = qboToCanon('Invoice', { ...qbo, CustomerRef: { value: '66' } }, deep);
  assert.deepEqual([d.clientRef, d.jobRef], [null, '59']);
  // Bill lines costed to the project are costed to the client
  const onProject = clone(Q.bill);
  for (const l of onProject.Line) l.AccountBasedExpenseLineDetail.CustomerRef = { value: '64' };
  assert.deepEqual(qboToCanon('Bill', onProject, ctx('bills')).lines.map((l) => l.customerRef), ['58', '58']);
});

test('line descriptions: QBO text over Fishtape\'s 1,000 characters is cut alike on both sides and never ping-pongs', () => {
  const c = ctx('invoices');
  const long = `Scope of work: ${'rough-in and finish '.repeat(80)}`.trim(); // 1,614 characters
  const qbo = clone(Q.invoiceQboOnly);
  qbo.Line[0].Description = long;
  qbo.Line[0].SalesItemLineDetail.ItemRef = { value: '22' };
  const R = qboToCanon('Invoice', qbo, c);
  assert.equal(R.lines[0].description.length, 1000);
  const rec = canonToFishtape('invoices', R, c);
  assert.ok(rec.lines[0].description.length <= 1000);
  const L = fishtapeToCanon('invoices', rec, c);
  assert.ok(canonEqual('invoices', 'lines', L.lines, R.lines));
  // Pushed back with a new price, QBO keeps its whole text
  const linked = ctx('invoices', { meta: { lineIds: { 0: '1' } } });
  const L2 = fishtapeToCanon('invoices', { ...rec, lines: [{ ...rec.lines[0], unitCents: 90000 }] }, linked);
  const out = canonToQbo('invoices', L2, linked, { existing: qbo, fields: ['lines'] });
  assert.equal(out.body.Line[0].Description, long);
  assert.equal(out.body.Line[0].Amount, 900);
  // A lossy line: the suffix fits inside the 1,000, and both sides still compare equal
  const lossyQbo = clone(qbo);
  Object.assign(lossyQbo.Line[0].SalesItemLineDetail, { Qty: 3, UnitPrice: 266.6667 });
  const report = {};
  const recL = canonToFishtape('invoices', qboToCanon('Invoice', lossyQbo, c), c, { report });
  assert.ok(recL.lines[0].description.length <= 1000);
  assert.match(recL.lines[0].description, / \(3 × \$266\.6667\)$/);
  assert.deepEqual(report.lossyLines, [0]);
  const lc = ctx('invoices', { meta: { lossyLines: [0], lineIds: { 0: '1' } } });
  assert.ok(canonEqual('invoices', 'lines', fishtapeToCanon('invoices', recL, lc).lines, qboToCanon('Invoice', lossyQbo, lc).lines));
  // SKUs to Fishtape's 80 characters
  const sku = 'SQD-QO120-'.repeat(10);
  assert.equal(qboToCanon('Item', { ...ITEMS[0], Sku: sku }, ctx('items')).sku.length, 80);
  assert.ok(canonEqual('items', 'sku', fishtapeToCanon('items', { name: 'x', sku: sku.slice(0, 80) }, ctx('items')).sku, qboToCanon('Item', { ...ITEMS[0], Sku: sku }, ctx('items')).sku));
});

test('a number QBO would cut is refused (number_too_long), not sent cut', () => {
  const c = ctx('invoices', { meta: INV_META });
  const L = fishtapeToCanon('invoices', { ...byId(F.invoices, 'inv-3001'), number: 'INV-2026-PRAIRIE-HOMES-01' }, c);
  const out = canonToQbo('invoices', L, c);
  assert.equal(out.error, 'number_too_long');
  assert.equal(out.body, null);
  // An update that does not send the number goes through
  assert.ok(!canonToQbo('invoices', L, c, { existing: Q.invoice, fields: ['notes'] }).error);
  // Numbering by QuickBooks never sends one
  const qb = ctx('invoices', { meta: INV_META }, { mappings: { ...M, option: { ...M.option, numbering: 'quickbooks' } } });
  assert.ok(!canonToQbo('invoices', L, qb).error);
});

// ---------------------------------------------------------------------------------------------
// Payments

test('payments: a QBO payment on several invoices is one Fishtape payment per invoice', () => {
  const c1 = ctx('payments', { qbo_line: '201' });
  const L = fishtapeToCanon('payments', byId(F.payments, 'pay-1'), c1);
  assert.deepEqual(L.method, { ref: '32', key: 'check' });
  const R = qboToCanon('Payment', Q.payment, c1);
  assert.equal(R.amountCents, 100000);
  assert.equal(R.invoiceRef, '201');
  assertSame('payments', L, R);
  const R2 = qboToCanon('Payment', Q.payment, ctx('payments', { qboLine: '202' }));
  assert.equal(R2.amountCents, 60000);
  assertSame('payments', fishtapeToCanon('payments', byId(F.payments, 'pay-2'), ctx('payments', { qbo_line: '202' })), R2);
  // The line moved to another invoice: invoiceRef shows it (a fields conflict, not a delete)
  const moved = { ...Q.payment, Line: [{ Amount: 1000, LinkedTxn: [{ TxnId: '777', TxnType: 'Invoice' }] }] };
  assert.equal(qboToCanon('Payment', moved, c1).invoiceRef, '777');
  // Pulled: the method is kept when it maps to the same QBO method
  assert.ok(!('method' in canonToFishtape('payments', R, c1, { existing: byId(F.payments, 'pay-1'), fields: ['method'] })));
  assert.equal(canonToFishtape('payments', { ...R, method: { ref: '31', key: 'cash' } }, c1, { existing: byId(F.payments, 'pay-1'), fields: ['method'] }).method, 'cash');
  const meta = linkMetaFromQbo('Payment', Q.payment, c1);
  assert.equal(meta.unappliedCents, 50000);
  assert.deepEqual(meta.foreignLines, [{ txnType: 'Invoice', txnId: '150', amountCents: 15000 }, { txnType: 'CreditMemo', txnId: '401', amountCents: 25000 }]);
});

test('payment push keeps every line Fishtape does not own, and the unapplied amount', () => {
  const c = ctx('payments', { qbo_line: '201', meta: { marker: 'Fishtape ref 1111aaaa2222' } });
  const L = fishtapeToCanon('payments', { ...byId(F.payments, 'pay-1'), amountCents: 120000 }, c);
  const out = canonToQbo('payments', L, c, { existing: Q.payment, fields: ['amountCents'] });
  assert.equal(out.entity, 'Payment');
  assert.equal(out.sparse, false);
  assert.deepEqual(out.body.Line.map((l) => [l.LinkedTxn[0].TxnId, l.Amount]), [['201', 1200], ['202', 600], ['150', 150], ['401', 250]]);
  assert.equal(out.body.TotalAmt, 2200);
  assert.equal(out.totalChanged, true);
  assert.deepEqual(out.body.CustomerRef, { value: '59' });
  // A reference change alone: lines and total exactly as they were
  const ref = canonToQbo('payments', { ...fishtapeToCanon('payments', byId(F.payments, 'pay-1'), c), reference: 'CHQ 4472' }, c, { existing: Q.payment, fields: ['reference'] });
  assert.deepEqual(ref.body.Line, Q.payment.Line);
  assert.equal(ref.body.TotalAmt, 2000);
  assert.equal(ref.body.PaymentRefNum, 'CHQ 4472');
  assert.equal(ref.totalChanged, false);
  // The applied amount is capped at the invoice balance; the rest stays as credit
  const capped = canonToQbo('payments', L, c, { existing: Q.payment, fields: ['amountCents'], invoiceBalanceCents: 10000 });
  assert.deepEqual(capped.body.Line[0].Amount, 1100);
  assert.equal(capped.body.TotalAmt, 2200);
  assert.deepEqual(capped.warnings, ['$100.00 left as credit in QuickBooks']);
  // Moved to another invoice: the old line goes, the new one is added
  const mv = canonToQbo('payments', { ...L, invoiceRef: '204', amountCents: 100000 }, c, { existing: Q.payment, fields: ['invoiceRef'], previousInvoiceRef: '201' });
  assert.deepEqual(mv.body.Line.map((l) => l.LinkedTxn[0].TxnId), ['202', '150', '401', '204']);
  assert.equal(mv.body.TotalAmt, 2000);
});

test('rebuildPaymentLines: a delete of one part leaves the total and other lines alone', () => {
  const del = rebuildPaymentLines(Q.payment, [{ invoiceQboId: '201', amountCents: 0 }], { keepTotal: true });
  assert.deepEqual(del.Line.map((l) => l.LinkedTxn[0].TxnId), ['202', '150', '401']);
  assert.equal(del.TotalAmt, 2000);
  const fresh = rebuildPaymentLines(null, [{ invoiceQboId: '201', amountCents: 50000 }]);
  assert.deepEqual(fresh, { Line: [{ Amount: 500, LinkedTxn: [{ TxnId: '201', TxnType: 'Invoice' }] }], TotalAmt: 500 });
  const s = paymentLineSummary(Q.payment, ['201', '202']);
  assert.equal(s.ownedLines.length, 2);
  assert.equal(s.foreignLines.length, 2);
  assert.equal(s.unappliedCents, 50000);
});

test('a capped payment pushed again counts its own excess once: TotalAmt stays the money received', () => {
  const c = ctx('payments', { qbo_line: '201', meta: { marker: 'Fishtape ref 1111aaaa2222' } });
  const L = fishtapeToCanon('payments', { ...byId(F.payments, 'pay-1'), amountCents: 10000 }, c);
  const created = canonToQbo('payments', L, c, { invoiceCustomerRef: '59', invoiceBalanceCents: 9999 });
  assert.deepEqual(created.body.Line.map((l) => l.Amount), [99.99]);
  assert.equal(created.body.TotalAmt, 100);
  assert.equal(created.ownExcessCents, 1);
  const qbo = asCreated(created.body, '950');
  const meta = { ...c.link.meta, ...linkMetaFromQbo('Payment', qbo, c, { pushed: created }) };
  assert.equal(meta.ownExcessCents, 1);
  // A later pull keeps it; it never exceeds what is unapplied
  assert.equal(linkMetaFromQbo('Payment', qbo, ctx('payments', { qbo_line: '201', meta })).ownExcessCents, 1);
  assert.equal(linkMetaFromQbo('Payment', { ...qbo, UnappliedAmt: 0 }, ctx('payments', { qbo_line: '201', meta })).ownExcessCents, 0);
  const c2 = ctx('payments', { qbo_line: '201', meta });
  // The same amount again (every field, as after a conflict resolved for Fishtape): nothing moves
  const again = canonToQbo('payments', L, c2, { existing: qbo, invoiceBalanceCents: 0 });
  assert.equal(again.body.TotalAmt, 100);
  assert.deepEqual(again.body.Line.map((l) => l.Amount), [99.99]);
  assert.equal(again.totalChanged, false);
  // $101.00 now: $1.01 left as credit, and the total is $101.00
  const more = canonToQbo('payments', { ...L, amountCents: 10100 }, c2, { existing: qbo, fields: ['amountCents'], invoiceBalanceCents: 0 });
  assert.equal(more.body.TotalAmt, 101);
  assert.deepEqual(more.warnings, ['$1.01 left as credit in QuickBooks']);
  assert.equal(more.ownExcessCents, 101);
  // $90.00 now: the excess is released
  const less = canonToQbo('payments', { ...L, amountCents: 9000 }, c2, { existing: qbo, fields: ['amountCents'], invoiceBalanceCents: 0 });
  assert.equal(less.body.TotalAmt, 90);
  assert.deepEqual(less.body.Line.map((l) => l.Amount), [90]);
  assert.equal(less.ownExcessCents, 0);
  // Never below the lines: an excess QBO already used elsewhere is not taken back twice
  assert.equal(rebuildPaymentLines(Q.payment, [{ invoiceQboId: '201', amountCents: 100000 }], { extraUnappliedCents: -90000 }).TotalAmt, 1500);
});

test('a full update keeps QBO\'s PrivateNote: a pulled payment\'s memo, and anything after Fishtape\'s own text', () => {
  const memo = 'Cheque 4471 – holdback release';
  const pulled = { ...Q.payment, PrivateNote: memo };
  const c = ctx('payments', { qbo_line: '201' }); // pulled from QBO: no marker
  const L = { ...fishtapeToCanon('payments', byId(F.payments, 'pay-1'), c), reference: 'CHQ 4472' };
  assert.equal(canonToQbo('payments', L, c, { existing: pulled, fields: ['reference'] }).body.PrivateNote, memo);
  assert.equal(canonToQbo('payments', { ...L, amountCents: 110000 }, c, { existing: pulled, fields: ['amountCents'] }).body.PrivateNote, memo);
  // Created by Fishtape: the marker stays in front, the bookkeeper's text after it stays too
  const cm = ctx('payments', { qbo_line: '201', meta: { marker: 'Fishtape ref 1111aaaa2222' } });
  const noted = { ...Q.payment, PrivateNote: `Fishtape ref 1111aaaa2222 · ${memo}` };
  assert.equal(canonToQbo('payments', L, cm, { existing: noted, fields: ['reference'] }).body.PrivateNote, `Fishtape ref 1111aaaa2222 · ${memo}`);
  assert.equal(canonToQbo('payments', L, cm, { existing: pulled, fields: ['reference'] }).body.PrivateNote, `Fishtape ref 1111aaaa2222 · ${memo}`);
  assert.equal(canonToQbo('payments', L, cm, { existing: Q.payment, fields: ['reference'] }).body.PrivateNote, 'Fishtape ref 1111aaaa2222');
  // Purchase orders and Stripe transfers alike
  const pc = ctx('purchaseOrders', { meta: { marker: 'Fishtape ref 7f7f7f7f7f7f' } });
  const po = canonToQbo('purchaseOrders', fishtapeToCanon('purchaseOrders', byId(F.purchaseOrders, 'po-5001'), pc), pc,
    { existing: { ...Q.purchaseOrder, PrivateNote: 'Fishtape ref 7f7f7f7f7f7f · Backordered 2 weeks' } });
  assert.equal(po.body.PrivateNote, 'Fishtape ref 7f7f7f7f7f7f · Backordered 2 weeks');
  const tc = ctx('stripePayouts', { meta: { marker: 'Fishtape ref 5a5a5a5a5a5a' } });
  const tr = canonToQbo('stripePayouts', fishtapeToCanon('stripePayouts', F.stripePayouts[0], tc), tc, { existing: { ...Q.transfer, PrivateNote: `${Q.transfer.PrivateNote} · Reconciled Oct` } });
  assert.equal(tr.body.PrivateNote, 'Fishtape ref 5a5a5a5a5a5a · Stripe payout po_1Q2w3E4r5T6y7U8i · Reconciled Oct');
});

test('Stripe payments: gross into the clearing account, fee as a Purchase, settlement and deposits', () => {
  const pay = byId(F.payments, 'stripe-pi_3Q9aBcDeFgHiJkLmN0pQrStU');
  const c = ctx('payments', { qbo_line: '204', meta: { marker: 'Fishtape ref 2222bbbb3333' } });
  const L = fishtapeToCanon('payments', pay, c);
  assert.equal(L.reference, 'pi_3Q9aBcDeFgHiJkLmN0'); // 21 characters
  assert.deepEqual(L.method, { ref: '33', key: 'card' });
  const out = canonToQbo('payments', L, c, { invoiceCustomerRef: '60' });
  assert.deepEqual(out.body.DepositToAccountRef, { value: '91' });
  assert.equal(out.body.PrivateNote, 'Fishtape ref 2222bbbb3333 · pi_3Q9aBcDeFgHiJkLmN0pQrStU');
  assert.equal(out.body.TotalAmt, 504);
  // The fee link: a Purchase from the clearing account to Stripe fees
  const fc = ctx('payments', { role: 'fee', meta: { marker: 'Fishtape ref 3333cccc4444' } });
  const fee = fishtapeToCanon('payments', pay, fc);
  assert.deepEqual(fee, { amountCents: 1492, date: '2026-10-18', extra: { chargeId: 'ch_3Q9aBcDeFgHiJkLm', paymentIntentId: 'pi_3Q9aBcDeFgHiJkLmN0pQrStU' } });
  const fb = canonToQbo('payments', fee, fc);
  assert.equal(fb.entity, 'Purchase');
  assert.equal(fb.body.PaymentType, 'Cash');
  assert.deepEqual(fb.body.AccountRef, { value: '91' });
  assert.deepEqual(fb.body.EntityRef, { value: '703', type: 'Vendor' });
  assert.equal(fb.body.Line[0].Amount, 14.92);
  assert.deepEqual(fb.body.Line[0].AccountBasedExpenseLineDetail, { AccountRef: { value: '75' }, TaxCodeRef: { value: '12' } });
  assert.equal(fb.body.PrivateNote, 'Fishtape ref 3333cccc4444 · Stripe fee ch_3Q9aBcDeFgHiJkLm');
  // Settled in QBO by a $250 credit memo: (3,083.84 − 1,833.84) − 1,000 linked = 250
  assert.equal(settlementCents(Q.invoice, [100000]), 25000);
  assert.equal(settlementCents(Q.invoice, [100000, 25000]), 0);
  assert.equal(settlementCents({ TotalAmt: 100, Balance: 100 }, [5000]), 0);
  // The invoice's own Deposit has its own Fishtape payment (depositRecord): never counted again
  assert.equal(settlementCents({ ...Q.invoice, Deposit: 200, Balance: 1633.84 }, [100000]), 25000);
  assert.deepEqual(settlementRecord({ invoiceId: 'inv-3001', cents: 25000, date: '2026-10-20' }),
    { invoiceId: 'inv-3001', amountCents: 25000, date: '2026-10-20', method: 'credit', source: 'quickbooks', reference: 'Credited or paid in QuickBooks' });
  assert.deepEqual(depositRecord({ ...Q.invoice, Deposit: 200 }, 'inv-3001'), { invoiceId: 'inv-3001', amountCents: 20000, date: '2026-10-15', method: 'transfer', reference: 'Deposit in QuickBooks' });
  assert.equal(depositRecord(Q.invoice, 'inv-3001'), null);
  const dep = qboToCanon('Invoice', { ...Q.invoice, Deposit: 200 }, ctx('payments', { role: 'deposit' }));
  assert.equal(dep.amountCents, 20000);
  assert.equal(entityFor('payments', dep, 'deposit'), 'Invoice');
});

// ---------------------------------------------------------------------------------------------
// Bills, receipts, purchase orders, time, Stripe payouts

test('a Manitoba bill: GST-only code, RST spread into job cost, equal both ways', () => {
  const c = ctx('bills', { meta: { marker: 'Fishtape ref 89abcdef0123', lineIds: { 0: '1', 1: '2' } } });
  const bill = byId(F.bills, 'bill-1');
  assert.equal(purchaseTaxKey(bill), 'GST+RST|MB');
  const L = fishtapeToCanon('bills', bill, c);
  // RST $105.00 spread $84.00 / $21.00 over $1,200 / $300 of lines
  assert.deepEqual(L.lines.map((l) => [l.amountCents, l.taxCodeId, l.accountRef, l.customerRef]), [[128400, '11', '71', '59'], [32100, '11', '71', '59']]);
  assert.deepEqual(L.taxes, [{ id: 'GST', pct: 5, cents: 7500 }]);
  const R = qboToCanon('Bill', Q.bill, c);
  assertSame('bills', L, R);
  const out = canonToQbo('bills', L, c, { existing: Q.bill });
  assert.equal(out.entity, 'Bill');
  assert.deepEqual(out.body.Line[1].AccountBasedExpenseLineDetail.ClassRef, { value: '900' });
  assert.equal(out.body.Line[0].AccountBasedExpenseLineDetail.BillableStatus, 'NotBillable');
  assert.deepEqual(out.body.APAccountRef, { value: '33', name: 'Accounts Payable (A/P)' });
  const created = canonToQbo('bills', L, ctx('bills', { meta: { marker: 'Fishtape ref 89abcdef0123' } })).body;
  assert.equal(created.PrivateNote, 'Fishtape ref 89abcdef0123 · Delivered to site');
  assert.deepEqual(created.VendorRef, { value: '701' });
  assert.equal(created.GlobalTaxCalculation, 'TaxExcluded');
  assert.deepEqual(created.Line.map((l) => l.Amount), [1284, 321]);
  // Pulled back: the spread amounts and the recoverable tax only; the totals still add up
  const patch = canonToFishtape('bills', R, c, { existing: bill, fields: ['lines', 'taxes'] });
  assert.deepEqual(patch.lines.map((l) => l.amountCents), [128400, 32100]);
  assert.deepEqual(patch.taxes, [{ id: 'GST', label: 'GST', cents: 7500 }]);
  assert.equal(patch.totalCents, 168000);
  assert.equal(patch.lines[0].jobId, 'job-1042');
  assert.ok(canonEqual('bills', 'lines', fishtapeToCanon('bills', { ...bill, ...patch }, c).lines, R.lines));
  assert.equal(billStatusFromQbo({ ...Q.bill, Balance: 0 }, 'open'), 'paid');
  assert.equal(billStatusFromQbo({ ...Q.bill, Balance: 10 }, 'paid'), 'open');
  assert.equal(billStatusFromQbo(Q.bill, 'open'), null);
  // Taxes compare by id and amount: GST changed to HST with the same cents is a change
  assert.ok(!canonEqual('bills', 'taxes', [{ id: 'GST', cents: 7500 }], [{ id: 'HST', cents: 7500 }]));
  assert.ok(canonEqual('bills', 'taxes', [{ id: 'GST', cents: 7500 }, { id: 'QST', cents: 0 }], [{ id: 'gst', cents: 7500 }]));
  // Item lines: Qty × UnitPrice must give Amount, else Qty 1 at the amount
  const items = canonToQbo('bills', { kind: 'bill', vendorRef: '701', lines: [
    { itemRef: '21', description: 'Wire', qty: 3, amountCents: 1000 }, { itemRef: '21', description: 'Wire (m)', qty: 2000, amountCents: 100001 },
  ], taxes: [] }, ctx('bills')).body.Line.map((l) => [l.ItemBasedExpenseLineDetail.Qty, l.ItemBasedExpenseLineDetail.UnitPrice, l.Amount]);
  assert.deepEqual(items, [[3, 3.33333, 10], [1, 1000.01, 1000.01]]);
  // With sub-customers off a job's cost goes to its client; that client coming back keeps the job
  const off = ctx('bills', { meta: { lineIds: { 0: '1', 1: '2' } } }, { mappings: { ...M, option: { ...M.option, jobsAsSubCustomers: false } } });
  const perLine = { ...bill, jobId: null, lines: bill.lines.map((l) => ({ ...l, jobId: 'job-1042' })) };
  assert.deepEqual(fishtapeToCanon('bills', perLine, off).lines.map((l) => l.customerRef), ['58', '58']);
  const Roff = clone(Q.bill);
  for (const l of Roff.Line) l.AccountBasedExpenseLineDetail.CustomerRef = { value: '58' };
  assert.deepEqual(canonToFishtape('bills', qboToCanon('Bill', Roff, off), off, { existing: perLine, fields: ['lines'] }).lines.map((l) => l.jobId), ['job-1042', 'job-1042']);
});

test('a long supplier number is cut to 21 and kept whole in the private note', () => {
  const c = ctx('bills', { meta: { marker: 'Fishtape ref 89abcdef0123' } });
  const bill = { ...byId(F.bills, 'bill-1'), number: 'WESTBURNE-2026-INV-778812-A' };
  const L = fishtapeToCanon('bills', bill, c);
  assert.equal(L.number, 'WESTBURNE-2026-INV-77');
  const body = canonToQbo('bills', L, c).body;
  assert.equal(body.DocNumber, 'WESTBURNE-2026-INV-77');
  assert.equal(body.PrivateNote, 'Fishtape ref 89abcdef0123 · Supplier no. WESTBURNE-2026-INV-778812-A · Delivered to site');
  const R = qboToCanon('Bill', asCreated(body), c);
  assert.equal(R.notes, 'Delivered to site');
  assert.ok(!('number' in canonToFishtape('bills', R, c, { existing: bill, fields: ['number'] })));
});

test('a tax-inclusive receipt is converted to net, with the PST in the cost', () => {
  const net = taxInclusiveToNet(Q.purchaseInclusive, REF);
  assert.deepEqual(net.lines.map((l) => [l.grossCents, l.netCents]), [[11200, 10000], [2240, 2000]]);
  assert.deepEqual(net.taxes.map((t) => [t.id, t.cents]), [['GST', 600], ['RST', 840]]);
  const c = ctx('bills');
  const R = qboToCanon('Purchase', Q.purchaseInclusive, c);
  assert.equal(R.kind, 'receipt');
  assert.deepEqual(R.lines.map((l) => l.amountCents), [10700, 2140]); // $8.40 PST spread 7.00 / 1.40
  assert.deepEqual(R.taxes.map((t) => [t.id, t.cents]), [['GST', 600]]);
  assert.deepEqual(R.paidWith, { ref: '51', key: 'card', paymentType: 'CreditCard' });
  const rec = canonToFishtape('bills', R, c);
  assert.equal(rec.kind, 'receipt');
  assert.equal(rec.paidWith, 'card');
  assert.equal(rec.totalCents, 13440); // QBO's $134.40
  assert.deepEqual(rec.lines.map((l) => l.costType), ['material', 'other']);
  // Stored like that, the Fishtape bill gives the same canonical form back
  assertSame('bills', fishtapeToCanon('bills', { ...rec, vendorId: null, taxProvince: 'MB' }, c), R, ['vendorRef', 'number', 'date', 'notes', 'dueDate']);
});

test('a supplier credit (Purchase with Credit: true) is a receipt with negative amounts, both ways', () => {
  const c = ctx('bills');
  const R = qboToCanon('Purchase', Q.purchaseCredit, c);
  assert.deepEqual(R.lines.map((l) => l.amountCents), [-5000]);
  assert.deepEqual(R.taxes.map((t) => [t.id, t.cents]), [['GST', -250]]);
  const rec = canonToFishtape('bills', R, c);
  assert.equal(rec.totalCents, -5250);
  const L = fishtapeToCanon('bills', { ...rec, vendorId: 'v-westburne', taxProvince: 'MB' }, c);
  const out = canonToQbo('bills', L, c);
  assert.equal(out.entity, 'Purchase');
  assert.equal(out.body.Credit, true);
  assert.equal(out.body.Line[0].Amount, 50);
  assert.equal(out.body.PaymentType, 'CreditCard');
  assert.deepEqual(out.body.EntityRef, { value: '701', type: 'Vendor' });
});

test('purchase orders push; only the closed status comes back', () => {
  const c = ctx('purchaseOrders', { meta: { marker: 'Fishtape ref 7f7f7f7f7f7f' } });
  const po = byId(F.purchaseOrders, 'po-5001');
  const L = fishtapeToCanon('purchaseOrders', po, c);
  const R = qboToCanon('PurchaseOrder', Q.purchaseOrder, c);
  assertSame('purchaseOrders', L, R, ['status', 'number']);
  assert.equal(R.status, 'closed');
  const body = canonToQbo('purchaseOrders', L, c).body;
  assert.ok(!('DocNumber' in body)); // purchase custom numbers are off
  assert.equal(body.POStatus, 'Open');
  assert.equal(body.Memo, 'Deliver to the side door');
  assert.deepEqual(body.Line[0].ItemBasedExpenseLineDetail, { ItemRef: { value: '21' }, Qty: 300, UnitPrice: 4, CustomerRef: { value: '59' }, BillableStatus: 'NotBillable' });
  const patch = canonToFishtape('purchaseOrders', R, c, { existing: po });
  assert.equal(patch.status, 'closed');
  assert.ok(patch.closedAt);
});

test('approved time becomes a TimeActivity: net minutes, local day, not billable', () => {
  const c = ctx('timeEntries', { meta: { marker: 'Fishtape ref 0a1b2c3d4e5f' } }, { related: { job: byId(F.jobs, 'job-1042') } });
  const L = fishtapeToCanon('timeEntries', byId(F.timeEntries, 'te-1'), c);
  assert.deepEqual(L, {
    employeeRef: { nameOf: 'Employee', ref: '81' }, customerRef: '59', itemRef: '22', date: '2026-10-15', minutes: 450,
    description: 'J-1042 Panel upgrade 12 Elm - Rough-in · Fishtape ref 0a1b2c3d4e5f',
  });
  assertSame('timeEntries', L, qboToCanon('TimeActivity', Q.timeActivity, c));
  const body = canonToQbo('timeEntries', L, c).body;
  assert.deepEqual(body, {
    NameOf: 'Employee', EmployeeRef: { value: '81' }, CustomerRef: { value: '59' }, ItemRef: { value: '22' }, TxnDate: '2026-10-15',
    Hours: 7, Minutes: 30, Description: 'J-1042 Panel upgrade 12 Elm - Rough-in · Fishtape ref 0a1b2c3d4e5f', BillableStatus: 'NotBillable',
  });
  // A late shift is dated by the Winnipeg clock-in day; travel goes on the travel item
  const late = fishtapeToCanon('timeEntries', { ...byId(F.timeEntries, 'te-1'), clockIn: '2026-10-16T03:30:00Z', clockOut: '2026-10-16T05:00:00Z', breakMins: 0, kind: 'travel' }, c);
  assert.equal(late.date, '2026-10-15');
  assert.equal(late.minutes, 90);
  assert.equal(late.itemRef, '22');
  // A subcontractor linked to a QBO vendor
  const sub = canonToQbo('timeEntries', { ...L, employeeRef: { nameOf: 'Vendor', ref: '704' } }, c, { existing: Q.timeActivity }).body;
  assert.equal(sub.NameOf, 'Vendor');
  assert.deepEqual(sub.VendorRef, { value: '704' });
  assert.ok(!('EmployeeRef' in sub));
});

test('Stripe payouts: a Transfer from the clearing account, payout-level fees as one Purchase', () => {
  const payout = F.stripePayouts[0];
  const c = ctx('stripePayouts', { meta: { marker: 'Fishtape ref 5a5a5a5a5a5a' } });
  const L = fishtapeToCanon('stripePayouts', payout, c);
  assertSame('stripePayouts', L, qboToCanon('Transfer', Q.transfer, c));
  const body = canonToQbo('stripePayouts', L, c).body;
  assert.deepEqual(body, { FromAccountRef: { value: '91' }, ToAccountRef: { value: '92' }, Amount: 1557.84, TxnDate: '2026-10-22', PrivateNote: 'Fishtape ref 5a5a5a5a5a5a · Stripe payout po_1Q2w3E4r5T6y7U8i' });
  const fc = ctx('stripePayouts', { role: 'fee', meta: { marker: 'Fishtape ref 6b6b6b6b6b6b' } });
  const fee = fishtapeToCanon('stripePayouts', payout, fc);
  assert.deepEqual(fee.lines, [{ description: 'Stripe fee', amountCents: 500 }, { description: 'Stripe dispute fee', amountCents: 1500 }]);
  assert.equal(fee.amountCents, 2000);
  const fb = canonToQbo('stripePayouts', fee, fc);
  assert.equal(fb.entity, 'Purchase');
  assert.deepEqual(fb.body.Line.map((l) => [l.Amount, l.AccountBasedExpenseLineDetail.AccountRef.value]), [[5, '75'], [15, '75']]);
  assertSame('payoutFee', fee, qboToCanon('Purchase', asCreated(fb.body), { ...fc, collection: 'stripePayouts' }));
});

test('sparse entities and the entity of each collection', () => {
  assert.deepEqual([...SPARSE_ENTITIES].sort(), ['Customer', 'Deposit', 'Estimate', 'Invoice']);
  assert.equal(entityFor('bills', { kind: 'receipt' }), 'Purchase');
  assert.equal(entityFor('bills', { kind: 'bill' }), 'Bill');
  assert.equal(entityFor('payments', {}, 'fee'), 'Purchase');
  assert.equal(entityFor('timeEntries', {}), 'TimeActivity');
  assert.throws(() => entityFor('leads', {}));
});

// ---------------------------------------------------------------------------------------------
// Canadian sales tax

test('tax keys: line keys, the no-tax reasons and the keys a Manitoba company needs', () => {
  const mb = byId(F.invoices, 'inv-3001');
  assert.equal(lineTaxKey(mb, 'material'), 'GST+RST|MB');
  const gstOnly = byId(F.invoices, 'inv-3011');
  assert.equal(lineTaxKey(gstOnly, 'material'), 'GST'); // gst-only is never NONE
  for (const [reason, key] of [['zero', 'NONE|ZERO'], ['exempt', 'NONE|EXEMPT'], ['out_of_scope', 'NONE|OOS'], ['relief', 'NONE|RELIEF']]) {
    assert.equal(lineTaxKey({ taxes: [], taxNoneReason: reason }, 'labour'), key);
  }
  const bc = { taxProvince: 'BC', taxes: taxComponents({ province: 'BC', treatment: 'separate-goods', date: '2026-10-19' }) };
  assert.equal(lineTaxKey(bc, 'material'), 'GST+PST|BC');
  assert.equal(lineTaxKey(bc, 'labour'), 'GST');
  assert.deepEqual(companyTaxKeys('MB', '2026-10-19'), ['GST+RST|MB', 'GST', ...NONE_KEYS]);
  assert.deepEqual(companyTaxKeys('ON', '2026-10-19'), ['HST|ON', ...NONE_KEYS]);
  assert.deepEqual(companyTaxKeys('BC', '2026-10-19').slice(0, 2), ['GST', 'GST+PST|BC']);
});

test('reverse mapping: many keys to one code, the document\'s own key first, the province from the key', () => {
  assert.equal(reverseTaxKey('10', M.taxCode), 'GST+RST|MB'); // not the legacy TAX
  assert.equal(reverseTaxKey('10', M.taxCode, { preferred: 'TAX' }), 'TAX');
  assert.equal(reverseTaxKey('10', M.taxCode, { preferred: 'GST' }), 'GST+RST|MB');
  assert.equal(reverseTaxKey('16', M.taxCode, { province: 'MB' }), 'HST|ON');
  assert.equal(reverseTaxKey('999', M.taxCode), null);
  assert.equal(reverseTaxKey(null, M.taxCode), null);
});

test('taxesFromCodes builds Fishtape taxes from the keys of a pulled document', () => {
  const d = '2026-10-15';
  const pst = taxesFromCodes({ material: 'GST+RST|MB', labour: 'GST+RST|MB' }, { province: 'MB', date: d });
  assert.equal(pst.ok, true);
  assert.equal(pst.taxTreatment, 'pst-all');
  assert.equal(pst.taxPct, 12);
  const gst = taxesFromCodes({ material: 'GST', labour: 'GST' }, { province: 'MB', date: d });
  assert.equal(gst.taxTreatment, 'gst-only');
  assert.equal(gst.taxPct, 5);
  const bc = taxesFromCodes({ material: 'GST' }, { province: 'BC', date: d, existingTreatment: 'gst-only' });
  assert.equal(bc.taxTreatment, 'gst-only'); // the document keeps its own treatment when it still fits
  assert.equal(taxesFromCodes({ material: 'GST' }, { province: 'BC', date: d }).taxTreatment, 'real-property');
  const on = taxesFromCodes({ labour: 'HST|ON' }, { province: 'MB', date: d });
  assert.equal(on.taxProvince, 'ON');
  assert.equal(on.taxTreatment, 'standard');
  const none = taxesFromCodes({ material: 'NONE|EXEMPT', labour: 'NONE|EXEMPT' }, { province: 'MB', date: d });
  assert.deepEqual([none.ok, none.taxTreatment, none.taxNoneReason, none.taxes.length], [true, 'none', 'exempt', 0]);
  assert.equal(taxesFromCodes({ material: 'NONE|ZERO', labour: 'NONE|EXEMPT' }, { province: 'MB', date: d }).ok, false);
  assert.equal(taxesFromCodes({ material: 'HST|ON', labour: 'GST+RST|MB' }, { province: 'MB', date: d }).ok, false);
  const legacy = taxesFromCodes({ material: 'TAX', labour: 'TAX' }, { province: 'MB', date: d, legacyPct: 12 });
  assert.deepEqual([legacy.ok, legacy.taxTreatment, legacy.taxes[0].pct], [true, 'custom', 12]);
  assert.equal(taxesFromCodes({ material: 'TAX' }, { province: 'MB', date: d }).ok, false);
  // RST on material only, GST on labour: no MB treatment does that, so exact custom components
  const mixed = taxesFromCodes({ material: 'GST+RST|MB', labour: 'GST' }, { province: 'MB', date: d });
  assert.equal(mixed.taxTreatment, 'custom');
  assert.equal(mixed.taxProvince, 'MB');
  assert.deepEqual(mixed.taxes.find((t) => t.id === 'RST').applies, { material: true, labour: false, other: false });
  const doc = { taxProvince: mixed.taxProvince, taxes: mixed.taxes };
  assert.equal(lineTaxKey(doc, 'material'), 'GST+RST|MB');
  assert.equal(lineTaxKey(doc, 'labour'), 'GST');
});

test('before a push: the mapped code must charge what the document charges (8% PST refused)', () => {
  const inv = byId(F.invoices, 'inv-3001');
  const ok = expectedTax(inv, { material: '10', labour: '10' }, REF, '2026-10-15');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.perRate.map((r) => [r.rateId, r.baseCents, r.cents]), [['1', 275343, 13767], ['2', 275343, 19274]]);
  const old = expectedTax(inv, { material: '15', labour: '15' }, REF, '2026-10-15');
  assert.equal(old.ok, false);
  assert.deepEqual(old.mismatch, { codeName: 'GST/PST MB (old)', codePcts: [5, 8], docPcts: [5, 7] });
  assert.equal(taxMismatchMessage(old.mismatch, 'invoice'), 'QuickBooks code GST/PST MB (old) charges 5% + 8%; this invoice charges 5% + 7%');
  assert.equal(expectedTax(inv, { material: '10' }, REF).ok, false); // labour has no code
  // The PST (MB) rate history: 8% before July 2019
  assert.equal(ratePct(byId(REF.rates, '2'), '2019-06-30'), 8);
  assert.equal(ratePct(byId(REF.rates, '2'), '2019-07-01'), 7);
});

test('after a write: per-rate comparison, 2-cent tolerance and the override', () => {
  const t = docTotals(byId(F.invoices, 'inv-3001'));
  const off = (gst, pst) => ({ TotalTax: (gst + pst) / 100, TaxLine: [
    { Amount: gst / 100, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '1' }, TaxPercent: 5 } },
    { Amount: pst / 100, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '2' }, TaxPercent: 7 } },
  ] });
  assert.deepEqual(compareTax(t, off(13767, 19274), REF), { equal: true, withinTolerance: true, perRate: [{ rateId: '1', fishtapeCents: 13767, qboCents: 13767 }, { rateId: '2', fishtapeCents: 19274, qboCents: 19274 }] });
  const one = compareTax(t, off(13768, 19274), REF);
  assert.deepEqual([one.equal, one.withinTolerance], [false, true]);
  const three = compareTax(t, off(13767, 19277), REF);
  assert.deepEqual([three.equal, three.withinTolerance], [false, false]);
  // Without TaxPercent the rate's own percentage is used
  const bare = { TaxLine: [{ Amount: 137.67, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '1' } } }, { Amount: 192.74, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '2' } } }] };
  assert.equal(compareTax(t, bare, REF, '2026-10-15').equal, true);
  assert.deepEqual(taxOverride(t, ['10'], REF, { date: '2026-10-15' }), {
    TotalTax: 330.41,
    TaxLine: [
      { Amount: 137.67, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '1' }, PercentBased: true, TaxPercent: 5, NetAmountTaxable: 2753.43 } },
      { Amount: 192.74, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '2' }, PercentBased: true, TaxPercent: 7, NetAmountTaxable: 2753.43 } },
    ],
  });
  assert.equal(taxOverride(t, ['11'], REF), null); // RST has no rate on a GST-only code
  // A bill's printed GST onto its purchase code
  const billTax = { taxes: [{ id: 'GST', pct: 5, cents: 7500, baseCents: 160500 }], taxCents: 7500 };
  assert.equal(taxOverride(billTax, ['11'], REF, { purchase: true }).TotalTax, 75);
});

test('purchases: PST/RST spread pro rata, remainder on the largest line; codes that claim PST refused', () => {
  const s = spreadPurchaseTax([{ amountCents: 333 }, { amountCents: 333 }, { amountCents: 334 }], [{ id: 'GST', cents: 50 }, { id: 'RST', cents: 100 }]);
  assert.deepEqual(s.lines.map((l) => l.amountCents), [366, 366, 368]);
  assert.deepEqual(s.taxes, [{ id: 'GST', cents: 50 }]);
  const neg = spreadPurchaseTax([{ amountCents: -1000 }], [{ id: 'PST', cents: -70 }]);
  assert.deepEqual(neg.lines.map((l) => l.amountCents), [-1070]);
  assert.deepEqual(spreadPurchaseTax([{ amountCents: 100 }], [{ id: 'HST', cents: 13 }]).lines[0].amountCents, 100);
  assert.equal(purchaseCodeClaimsPst(byId(REF.codes, '10'), REF.rates, REF.agencies), true);
  assert.equal(purchaseCodeClaimsPst(byId(REF.codes, '11'), REF.rates, REF.agencies), false);
  assert.equal(purchaseCodeClaimsPst(byId(REF.codes, '16'), REF.rates, REF.agencies), false); // HST is recoverable
  assert.equal(codeMatchesKey('GST+RST|MB', byId(REF.codes, '11'), REF, { purchase: true }), true);
  assert.equal(codeMatchesKey('GST+RST|MB', byId(REF.codes, '10'), REF, { purchase: true }), false);
  assert.equal(codeMatchesKey('GST+RST|MB', byId(REF.codes, '10'), REF, { date: '2026-10-15' }), true);
  assert.equal(codeMatchesKey('GST+RST|MB', byId(REF.codes, '15'), REF, { date: '2026-10-15' }), false);
  assert.equal(taxIdForRate(byId(REF.rates, '8'), 'MB'), 'RST');
  assert.equal(taxIdForRate(null, 'ON', 13), 'HST');
});

test('suggested codes go by rates, never by name alone', () => {
  const keys = ['GST+RST|MB', 'GST', ...NONE_KEYS, 'TAX', 'HST|ON'];
  assert.deepEqual(suggestTaxCodes(keys, REF.codes, REF.rates, { province: 'MB', date: '2026-10-19' }), {
    'GST+RST|MB': '10', GST: '11', 'NONE|ZERO': '13', 'NONE|EXEMPT': '12', 'NONE|OOS': '14', 'NONE|RELIEF': null, TAX: null, 'HST|ON': '16',
  });
  // With the current code switched off, the 8% code is still never offered
  const codes = REF.codes.map((c) => (c.Id === '10' ? { ...c, Active: false } : c));
  assert.equal(suggestTaxCodes(['GST+RST|MB'], codes, REF.rates, { province: 'MB', date: '2026-10-19' })['GST+RST|MB'], null);
  assert.deepEqual(suggestTaxCodes(['GST+RST|MB', 'GST', 'NONE', 'stripeFee'], REF.codes, REF.rates, { province: 'MB', date: '2026-10-19', purchase: true, agencies: REF.agencies }),
    { 'GST+RST|MB': '11', GST: '11', NONE: '12', stripeFee: '12' });
});
