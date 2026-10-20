// First-connect matching and wizard baselines without a database (docs/integrations/quickbooks.md
// 6.3, 6.4, 11.2): normalizer parity with the importers, customer scores (a name-only match is
// always ambiguous), jobs, items, employees, suppliers, documents with the possible-duplicate pass
// and filed GST periods, payments on balance and net of the Stripe fee, per-field baselines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as importers from '../../electrical-app/js/lib/importers.js';
import {
  normEmail, phoneKey, nameKey, skuKey, postalKey, matchCustomers, matchJobs, matchItems, matchEmployees, matchVendors, matchDocs, matchPayments, totalsAgree,
} from '../src/qbo/map/match.js';
import { wizardBaseline, linesEquivalent } from '../src/qbo/map/baseline.js';
import { threeWayMerge, aliasHash } from '../src/qbo/map/merge.js';
import { fishtapeToCanon, qboToCanon } from '../src/qbo/map/canon.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/qbo/${name}.json`, import.meta.url), 'utf8'));
const REF = fixture('reference');
const M = fixture('mappings');
const F = fixture('fishtape');
const Q = fixture('transactions');
const CUSTOMERS = fixture('customers');
const ITEMS = fixture('items');
const VE = fixture('vendors-employees');
const find = (list, pred) => list.find(pred);
const byF = (cands, id) => find(cands, (c) => c.fishtapeId === id);
const byQ = (cands, id) => find(cands, (c) => c.qboId === id && !c.fishtapeId);

test('normalizers equal the importers\' (parity)', () => {
  const samples = [
    ' Dana.Smith@Example.COM ', 'mailto:AP@x.example', '+1 (306) 555-0142', '204.555.0199 ext 4', 'Émile Côté & Fils Électrique', '  Prairie   Homes, Ltd. ',
    'pnl-200 sie', 'R3C 1a1', '', null, undefined, 42, 'Ça va—très bien', 'ÆØÅ ﬁx', 'O\'Brien Electric',
  ];
  for (const s of samples) {
    assert.equal(normEmail(s), importers.normEmail(s), `normEmail ${s}`);
    assert.equal(phoneKey(s), importers.phoneKey(s), `phoneKey ${s}`);
    assert.equal(nameKey(s), importers.nameKey(s), `nameKey ${s}`);
    assert.equal(skuKey(s), importers.skuKey(s), `skuKey ${s}`);
  }
  assert.equal(postalKey('r3c 1a1'), 'R3C1A1');
});

const ACTIVE_CLIENTS = ['c-prairie', 'c-dana', 'c-redriver'];

test('customers: email 100, phone 80, name and postal code 75; a name-only match is never linked', () => {
  const cands = matchCustomers(F.clients, CUSTOMERS, { activeClientIds: ACTIVE_CLIENTS, importCustomers: 'active' });
  const prairie = byF(cands, 'c-prairie');
  assert.deepEqual([prairie.qboId, prairie.score, prairie.status, prairie.choice, prairie.reasons], ['58', 100, 'matched', 'link', ['email']]);
  assert.deepEqual(prairie.qboSummary, { name: 'Prairie Homes Ltd', email: 'ap@prairiehomes.example', phone: '(204) 555-0142', type: 'business', balanceCents: 183384, active: true });
  assert.ok(!('address' in prairie.qboSummary) && !('notes' in prairie.qboSummary)); // never addresses or notes
  const dana = byF(cands, 'c-dana');
  assert.deepEqual([dana.qboId, dana.score, dana.status, dana.choice], ['60', 75, 'matched', 'link']);
  const dana2 = byF(cands, 'c-dana2'); // no address: two "Dana Smith"s at 70
  assert.deepEqual([dana2.status, dana2.choice, dana2.score], ['ambiguous', 'skip', 70]);
  assert.deepEqual(dana2.options, ['60', '61']);
  assert.ok(dana2.reasons.includes('name_only'));
  assert.deepEqual([byF(cands, 'c-redriver').status, byF(cands, 'c-redriver').choice], ['fishtape_only', 'create_in_qbo']);
  assert.deepEqual([byF(cands, 'c-old').status, byF(cands, 'c-old').choice], ['fishtape_only', 'skip']);
  assert.equal(byQ(cands, '62').choice, 'create_in_fishtape'); // open balance
  assert.equal(byQ(cands, '63').choice, 'skip'); // inactive
  assert.ok(!cands.some((c) => ['59', '64'].includes(c.qboId))); // sub-customers and projects are jobs
  assert.ok(!byQ(cands, '61')); // offered on the ambiguous row, never created on its own
  // A single name-only candidate is still ambiguous
  const one = matchCustomers([{ id: 'x', name: 'Kenora Lakeside Lodge' }], CUSTOMERS);
  assert.deepEqual([byF(one, 'x').status, byF(one, 'x').score], ['ambiguous', 70]);
  // Phone: last 10 digits
  const ph = matchCustomers([{ id: 'p', name: 'Someone Else', phone: '+1 204 555 0142' }], CUSTOMERS);
  assert.deepEqual([byF(ph, 'p').qboId, byF(ph, 'p').score, byF(ph, 'p').status], ['58', 80, 'matched']);
  // Two clients with the same e-mail contest one customer: neither is linked
  const two = matchCustomers([{ id: 'a', name: 'A', email: 'ap@prairiehomes.example' }, { id: 'b', name: 'B', email: 'AP@prairiehomes.example' }], CUSTOMERS);
  assert.deepEqual(two.filter((c) => c.fishtapeId).map((c) => c.status), ['ambiguous', 'ambiguous']);
  // importCustomers 'all' brings every active QBO-only customer
  const all = matchCustomers([], CUSTOMERS, { importCustomers: 'all' });
  assert.deepEqual(all.filter((c) => c.choice === 'create_in_fishtape').map((c) => c.qboId), ['58', '60', '61', '62']);
});

test('jobs: sub-customers and projects under the matched client', () => {
  const cands = matchJobs(F.jobs, CUSTOMERS, { 'c-prairie': '58', 'c-redriver': null });
  assert.deepEqual([byF(cands, 'job-1042').qboId, byF(cands, 'job-1042').score, byF(cands, 'job-1042').choice], ['59', 90, 'link']);
  assert.deepEqual([byF(cands, 'job-1050').qboId, byF(cands, 'job-1050').score, byF(cands, 'job-1050').choice], ['64', 70, 'link']);
  assert.equal(byF(cands, 'job-1050').qboSummary.type, 'project');
  assert.deepEqual([byF(cands, 'job-1060').status, byF(cands, 'job-1060').choice], ['fishtape_only', 'skip']);
  assert.ok(cands.filter((c) => c.status === 'quickbooks_only').every((c) => c.choice === 'skip'));
  // A sub-customer under another parent is never matched
  const other = matchJobs([F.jobs[0]], CUSTOMERS, new Map([['c-prairie', '62']]));
  assert.equal(other[0].status, 'fishtape_only');
});

test('items: SKU 100, name 70, categories and generic items left out', () => {
  const generic = Object.values(M.item);
  const cands = matchItems(F.items, ITEMS, { items: 'on_use', exclude: generic });
  assert.deepEqual([byF(cands, 'item-panel').qboId, byF(cands, 'item-panel').score, byF(cands, 'item-panel').choice], ['101', 100, 'link']);
  assert.deepEqual([byF(cands, 'item-pot').qboId, byF(cands, 'item-pot').score, byF(cands, 'item-pot').choice], ['102', 70, 'link']);
  assert.equal(byF(cands, 'item-afci').choice, 'skip');
  assert.equal(byQ(cands, '104').choice, 'create_in_fishtape');
  assert.equal(byQ(cands, '105').choice, 'skip');
  assert.ok(!cands.some((c) => c.qboId === '103' || generic.includes(c.qboId)));
  assert.equal(byF(matchItems(F.items, ITEMS, { items: 'all', exclude: generic }), 'item-afci').choice, 'create_in_qbo');
});

test('employees: link or skip only', () => {
  const cands = matchEmployees(F.employees, VE.employees);
  assert.deepEqual([byF(cands, 'emp-kelvin').qboId, byF(cands, 'emp-kelvin').score, byF(cands, 'emp-kelvin').choice], ['81', 100, 'link']);
  assert.deepEqual([byF(cands, 'emp-jordan').qboId, byF(cands, 'emp-jordan').score, byF(cands, 'emp-jordan').choice], ['82', 70, 'link']);
  assert.equal(byF(cands, 'emp-sam').choice, 'skip');
  assert.ok(cands.every((c) => ['link', 'skip'].includes(c.choice)));
  assert.ok(!cands.some((c) => c.qboId === '83')); // inactive
});

test('suppliers: as customers, one side only is created on the other', () => {
  const cands = matchVendors(F.vendors, VE.vendors);
  assert.deepEqual([byF(cands, 'v-westburne').qboId, byF(cands, 'v-westburne').choice], ['701', 'link']);
  assert.equal(byF(cands, 'v-guillevin').choice, 'create_in_qbo');
  assert.equal(byQ(cands, '704').choice, 'create_in_fishtape');
  const nameOnly = matchVendors([{ id: 'v-x', name: 'Home Depot' }], VE.vendors);
  assert.equal(byF(nameOnly, 'v-x').status, 'ambiguous');
});

const CUSTOMER_FOR = (d) => (d.jobId === 'job-1042' ? '59' : ({ 'c-prairie': '58', 'c-dana': '60' })[d.clientId] ?? null);

test('invoices: number pass, possible duplicates, filed GST periods, QBO-only documents', () => {
  const qbo = [Q.invoice, Q.invoiceQboOnly, Q.invoiceRekeyed, Q.invoiceTaxInclusive];
  const cands = matchDocs('invoices', F.invoices, qbo, CUSTOMER_FOR, { syncFrom: '2026-10-01', taxFiledThrough: '2026-09-30', ref: REF });
  const inv = byF(cands, 'inv-3001');
  assert.deepEqual([inv.qboId, inv.score, inv.status, inv.choice], ['201', 100, 'matched', 'link']);
  assert.deepEqual(inv.qboSummary, { docNumber: 'INV-3001', date: '2026-10-15', totalCents: 308384, balanceCents: 183384, status: 'open', name: 'Prairie Homes Ltd:J-1042 Panel upgrade 12 Elm' });
  // Keyed into QBO by hand as 1078 two days later: possible duplicate, never created by default
  const dup = byF(cands, 'inv-3010');
  assert.deepEqual([dup.qboId, dup.status, dup.choice, dup.reasons], ['204', 'ambiguous', 'skip', ['possible_duplicate']]);
  // Open, dated before syncFrom and inside a filed GST period: created only with the tick
  const filed = byF(cands, 'inv-3011');
  assert.deepEqual([filed.status, filed.choice, filed.needsConfirm, filed.reasons], ['fishtape_only', 'create_in_qbo', true, ['filed_period']]);
  assert.equal(byF(cands, 'inv-3012').choice, 'skip'); // paid before syncFrom
  assert.ok(!byF(cands, 'inv-3013')); // drafts are not pushed
  assert.equal(byQ(cands, '203').choice, 'create_in_fishtape');
  assert.equal(byQ(cands, '205').choice, 'create_in_fishtape');
  // The same number with other totals: ambiguous, both totals shown
  const off = { ...Q.invoice, TotalAmt: 3100, TxnTaxDetail: { TotalTax: 346.57, TaxLine: Q.invoice.TxnTaxDetail.TaxLine } };
  const diff = byF(matchDocs('invoices', F.invoices, [off], CUSTOMER_FOR, { syncFrom: '2026-10-01', ref: REF }), 'inv-3001');
  assert.deepEqual([diff.status, diff.reasons], ['ambiguous', ['number', 'totals_differ']]);
  assert.equal(diff.qboSummary.fishtapeTotalCents, 308384);
  assert.equal(totalsAgree(F.invoices[0], Q.invoice, REF), true);
  assert.equal(totalsAgree(F.invoices[0], { ...Q.invoice, TotalAmt: 3083.87 }, REF), false);
});

test('estimates: the same rules; a pending QBO estimate comes in whatever its date', () => {
  const cands = matchDocs('estimates', F.estimates, [Q.estimate, { ...Q.invoiceQboOnly, Id: '502', DocNumber: '88', TxnDate: '2026-01-05', TxnStatus: 'Pending' }], CUSTOMER_FOR, { syncFrom: '2026-10-01', zone: 'America/Winnipeg', ref: REF });
  assert.deepEqual([byF(cands, 'est-2001').qboId, byF(cands, 'est-2001').status], ['501', 'matched']);
  assert.equal(byQ(cands, '502').choice, 'create_in_fishtape');
});

test('payments: paired on equal amounts, net of the Stripe fee, never a double payment', () => {
  const stripe = F.payments[2];
  const agree = matchPayments([{
    invoice: { fishtapeId: 'inv-3010', qboId: '204', fishtapeDueCents: 0, qboBalanceCents: 0 },
    fishtape: [stripe], qbo: [{ qboId: '311', amountCents: 48908, date: '2026-10-22' }],
  }]);
  assert.deepEqual(agree.map((c) => [c.fishtapeId, c.qboId, c.qboLine, c.status, c.choice, c.netOfFee]), [['stripe-pi_3Q9aBcDeFgHiJkLmN0pQrStU', '311', '204', 'matched', 'link', true]]);
  // Balances agree: leftovers on either side are skipped
  const left = matchPayments([{
    invoice: { fishtapeId: 'inv-3001', qboId: '201', fishtapeDueCents: 183384, qboBalanceCents: 183384 },
    fishtape: [F.payments[0], { id: 'pay-x', amountCents: 25000, date: '2026-10-19' }], qbo: [{ qboId: '301', amountCents: 100000 }, { qboId: '399', amountCents: 25000 }],
  }]);
  assert.deepEqual(left.map((c) => [c.fishtapeId, c.qboId, c.choice]), [['pay-x', '399', 'link'], ['pay-1', '301', 'link']]);
  const extra = matchPayments([{
    invoice: { fishtapeId: 'inv-3001', qboId: '201', fishtapeDueCents: 0, qboBalanceCents: 0 },
    fishtape: [{ id: 'pay-x', amountCents: 25000 }], qbo: [],
  }]);
  assert.deepEqual(extra.map((c) => [c.status, c.choice, c.reasons]), [['fishtape_only', 'skip', ['balances_agree']]]);
  // Balances differ: one side only is created on the other, unless that overpays
  const differ = matchPayments([{
    invoice: { fishtapeId: 'inv-3001', qboId: '201', fishtapeDueCents: 50000, qboBalanceCents: 30000 },
    fishtape: [{ id: 'f-1', amountCents: 20000, date: '2026-10-01' }, { id: 'f-2', amountCents: 20000, date: '2026-10-02' }],
    qbo: [{ qboId: 'q-1', amountCents: 40000 }, { qboId: 'q-2', amountCents: 20000 }],
  }]);
  assert.deepEqual(differ.map((c) => [c.fishtapeId, c.qboId, c.status, c.choice]), [
    ['f-1', 'q-2', 'matched', 'link'],
    ['f-2', null, 'fishtape_only', 'create_in_qbo'],
    [null, 'q-1', 'quickbooks_only', 'create_in_fishtape'],
  ]);
  const over = matchPayments([{
    invoice: { fishtapeId: 'i', qboId: '9', fishtapeDueCents: 10000, qboBalanceCents: 5000 },
    fishtape: [{ id: 'f', amountCents: 8000 }], qbo: [{ qboId: 'q', amountCents: 12000 }],
  }]);
  assert.deepEqual(over.map((c) => [c.status, c.reasons]), [['ambiguous', ['would_overpay']], ['ambiguous', ['would_overpay']]]);
});

// ---------------------------------------------------------------------------------------------
// Baselines

const CTX = (collection, meta = {}) => ({
  collection, mappings: M, features: { salesTax: true }, company: { province: 'MB', zone: 'America/Winnipeg' },
  refs: {
    qboIdFor: (c, id) => ({ clients: { 'c-prairie': '58', 'c-dana': '60' }, jobs: { 'job-1042': '59' }, items: { 'item-panel': '101' }, estimates: { 'est-2001': '501' }, invoices: { 'inv-3010': '204' } })[c]?.[id] ?? null,
    fishtapeIdFor: (c, q) => (c === 'jobs' && q === '59' ? 'job-1042' : null),
  },
  link: { meta },
});

test('baseline: an empty side gets the other\'s value; a choice writes the chosen side; no silent overwrite', () => {
  const c = CTX('clients');
  const L = fishtapeToCanon('clients', { id: 'c-dana', name: 'Dana Smith', phone: '204 555 0100', email: 'dana@x.example', address: '12 Elm St, Steinbach, MB R5G 1A1' }, c);
  const R = qboToCanon('Customer', { ...CUSTOMERS[2], DisplayName: 'Dana M. Smith' }, c); // no e-mail, other phone and name
  const open = wizardBaseline('clients', L, R);
  assert.deepEqual(open.needsChoice, ['name', 'phone']);
  assert.equal(open.differs, false);
  assert.deepEqual(open.diffs.map((d) => d.field), ['name', 'email', 'phone']);
  assert.equal(open.snapshot.email, null); // the empty side
  const chosen = wizardBaseline('clients', L, R, { name: 'fishtape', phone: 'quickbooks' });
  assert.deepEqual(chosen.needsChoice, []);
  const r = threeWayMerge('clients', chosen.snapshot, L, R);
  assert.deepEqual(r.toRemote.sort(), ['email', 'name']); // QBO gets Fishtape's e-mail and the chosen name
  assert.deepEqual(r.toLocal, ['phone']); // Fishtape gets QBO's phone
  assert.deepEqual(r.conflicts, []);
});

test('baseline: equal-money documents are linked as they are; documents that differ go to review', () => {
  const c = CTX('invoices', { lineIds: { 0: '1', 1: '2', 2: '3', markup: '4' } });
  const L = fishtapeToCanon('invoices', F.invoices[0], c);
  // The bookkeeper's copy uses the generic Materials item and other text, same amounts and codes
  const rq = JSON.parse(JSON.stringify(Q.invoice));
  rq.Line[0].SalesItemLineDetail.ItemRef = { value: '21' };
  rq.Line[2].Description = 'Labour';
  const R = qboToCanon('Invoice', rq, c);
  assert.equal(linesEquivalent(L, R), true);
  const b = wizardBaseline('invoices', L, R);
  assert.equal(b.differs, false);
  assert.deepEqual(Object.keys(b.remoteAlias), ['lines']);
  assert.equal(b.remoteAlias.lines, aliasHash('invoices', 'lines', R.lines));
  const first = threeWayMerge('invoices', b.snapshot, L, R, { remoteAlias: b.remoteAlias });
  assert.deepEqual([first.toLocal, first.toRemote, first.conflicts], [[], [], []]); // neither side rewritten
  // Someone really edits in QBO: the alias drops and the lines come over
  rq.Line[2].Amount = 1330; rq.Line[2].SalesItemLineDetail.Qty = 14;
  const later = threeWayMerge('invoices', b.snapshot, L, qboToCanon('Invoice', rq, c), { remoteAlias: b.remoteAlias });
  assert.deepEqual(later.toLocal, ['lines']);
  // Another date: review, with QBO as the truth in the snapshot
  const moved = wizardBaseline('invoices', L, qboToCanon('Invoice', { ...Q.invoice, TxnDate: '2026-10-16' }, c));
  assert.equal(moved.differs, true);
  assert.equal(moved.snapshot.date, '2026-10-16');
  // Different amounts are never "equivalent"
  const rx = JSON.parse(JSON.stringify(Q.invoice));
  rx.Line[1].Amount = 216.80;
  assert.equal(linesEquivalent(L, qboToCanon('Invoice', rx, c)), false);
});

test('baseline: a Stripe payment entered net of the fee, on the payout day', () => {
  const c = { ...CTX('payments'), link: { qbo_line: '204', meta: {} } };
  const L = fishtapeToCanon('payments', F.payments[2], c);
  const R = qboToCanon('Payment', { Id: '311', TxnDate: '2026-10-22', PaymentMethodRef: { value: '33' }, Line: [{ Amount: 489.08, LinkedTxn: [{ TxnId: '204', TxnType: 'Invoice' }] }], TotalAmt: 489.08 }, c);
  const b = wizardBaseline('payments', L, R);
  assert.equal(b.differs, false);
  assert.deepEqual(Object.keys(b.remoteAlias).sort(), ['amountCents', 'date']);
  const r = threeWayMerge('payments', b.snapshot, L, R, { remoteAlias: b.remoteAlias });
  assert.deepEqual([r.toLocal, r.toRemote, r.conflicts], [[], ['reference'], []]); // only the empty QBO reference is filled
  // A gross amount that differs for another reason goes to review
  const R2 = { ...R, amountCents: 40000 };
  assert.equal(wizardBaseline('payments', L, R2).differs, true);
});
