// The three-way merge without a database (docs/integrations/quickbooks.md 5.5, 5.6, 11.2): every
// case of the table for every field of every collection, auto against money, the 10-minute window,
// B = null after a relink, remoteAlias, the stale revert guard, held device values, lines as one
// field, push-only collections, canonical cuts and status collapse, display values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  threeWayMerge, FIELD_RULES, MONEY_RECORD_KEYS, PUSH_ONLY_COLLECTIONS, canonCollection, fieldsOf, canonHash, aliasHash, displayValue, conflictRows, fieldLabel,
} from '../src/qbo/map/merge.js';
import { fishtapeToCanon, qboToCanon } from '../src/qbo/map/canon.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/qbo/${name}.json`, import.meta.url), 'utf8'));
const M = fixture('mappings');
const F = fixture('fishtape');
const Q = fixture('transactions');

const T0 = '2026-10-20T15:00:00Z';
const at = (mins) => new Date(Date.parse(T0) + mins * 60000).toISOString();
const TWO_WAY = Object.keys(FIELD_RULES).filter((c) => !PUSH_ONLY_COLLECTIONS.includes(c));

/** A canonical form with every field set to `v`, one field set to `x`. */
const form = (collection, v, field, x) => Object.fromEntries(fieldsOf(collection).map((f) => [f, f === field ? x : v]));

test('field rules: every collection classified, money fields map to record keys', () => {
  assert.deepEqual(Object.keys(FIELD_RULES).sort(), ['bills', 'clients', 'estimates', 'invoices', 'items', 'jobs', 'paymentFee', 'payments', 'payoutFee', 'purchaseOrders', 'stripePayouts', 'timeEntries', 'vendors']);
  for (const [c, r] of Object.entries(FIELD_RULES)) {
    const all = [...r.money, ...r.auto, ...r.pushOnly];
    assert.equal(new Set(all).size, all.length, `${c} lists a field twice`);
    for (const f of r.money) assert.ok(MONEY_RECORD_KEYS[c]?.[f]?.length, `${c}.${f} has record keys`);
  }
  assert.deepEqual(FIELD_RULES.invoices.money, ['number', 'clientRef', 'jobRef', 'date', 'lines', 'status']);
  assert.deepEqual(FIELD_RULES.payments.auto, ['method', 'reference']);
  assert.equal(canonCollection('payments', 'fee'), 'paymentFee');
  assert.equal(canonCollection('stripePayouts', 'fee'), 'payoutFee');
  assert.equal(canonCollection('invoices', 'settlement'), 'invoices');
  assert.equal(fieldLabel('amountCents'), 'Amount');
});

test('every case of the merge table, for every field of every two-way collection', () => {
  for (const c of TWO_WAY) {
    const rules = FIELD_RULES[c];
    for (const f of fieldsOf(c)) {
      const cls = rules.money.includes(f) ? 'money' : rules.auto.includes(f) ? 'auto' : 'pushOnly';
      const B = form(c, 'base');
      const msg = `${c}.${f} (${cls})`;
      // L = B, R = B: nothing to do
      let r = threeWayMerge(c, B, form(c, 'base'), form(c, 'base'));
      assert.deepEqual([r.toLocal, r.toRemote, r.conflicts], [[], [], []], msg);
      // L = B, R ≠ B: take R (push-only fields are never read back)
      r = threeWayMerge(c, B, form(c, 'base'), form(c, 'base', f, 'qbo'));
      if (cls === 'pushOnly') assert.deepEqual([r.toLocal, r.toRemote], [[], []], msg);
      else { assert.deepEqual(r.toLocal, [f], msg); assert.equal(r.merged[f], 'qbo', msg); }
      // R = B, L ≠ B: take L
      r = threeWayMerge(c, B, form(c, 'base', f, 'ft'), form(c, 'base'));
      assert.deepEqual([r.toLocal, r.toRemote], [[], [f]], msg);
      assert.equal(r.merged[f], 'ft', msg);
      // L = R ≠ B: the snapshot moves, nothing is written
      r = threeWayMerge(c, B, form(c, 'base', f, 'same'), form(c, 'base', f, 'same'));
      assert.deepEqual([r.toLocal, r.toRemote, r.conflicts], [[], cls === 'pushOnly' ? [f] : [], []], msg);
      assert.equal(r.merged[f], 'same', msg);
      // Both changed differently
      const L = form(c, 'base', f, 'ft'), R = form(c, 'base', f, 'qbo');
      const later = threeWayMerge(c, B, L, R, { localAt: { [f]: at(30) }, remoteAt: { [f]: at(0) } });
      const earlier = threeWayMerge(c, B, L, R, { localAt: { [f]: at(0) }, remoteAt: { [f]: at(30) } });
      const close = threeWayMerge(c, B, L, R, { localAt: { [f]: at(0) }, remoteAt: { [f]: at(9) } });
      const unknown = threeWayMerge(c, B, L, R, { localAt: { [f]: at(0) } });
      if (cls === 'money') {
        for (const x of [later, earlier, close, unknown]) {
          assert.deepEqual(x.conflicts, [{ field: f, base: 'base', fishtape: 'ft', quickbooks: 'qbo' }], msg);
          assert.deepEqual([x.toLocal, x.toRemote], [[], []], msg); // nothing is written for the record
        }
      } else if (cls === 'auto') {
        assert.deepEqual([later.toRemote, later.autoResolved], [[f], [{ field: f, winner: 'fishtape' }]], msg);
        assert.deepEqual([earlier.toLocal, earlier.autoResolved], [[f], [{ field: f, winner: 'quickbooks' }]], msg);
        assert.equal(close.conflicts.length, 1, `${msg}: within 10 minutes`);
        assert.equal(unknown.conflicts.length, 1, `${msg}: unknown time`);
      } else {
        assert.deepEqual([later.toRemote, later.conflicts], [[f], []], msg);
      }
      // B = null (relink): every field where L ≠ R is a conflict, push-only fields wait for an edit
      const relink = threeWayMerge(c, null, L, R);
      if (cls === 'pushOnly') assert.deepEqual([relink.conflicts, relink.toRemote], [[], []], msg);
      else assert.deepEqual(relink.conflicts.map((x) => x.field), [f], msg);
      assert.deepEqual(threeWayMerge(c, null, form(c, 'x'), form(c, 'x')).conflicts, [], msg);
    }
  }
});

test('one time for every field, and the 10-minute edge', () => {
  const B = form('clients', 'b'), L = form('clients', 'b', 'email', 'ft@x.example'), R = form('clients', 'b', 'email', 'qbo@x.example');
  assert.deepEqual(threeWayMerge('clients', B, L, R, { localAt: at(11), remoteAt: at(0) }).toRemote, ['email']);
  assert.equal(threeWayMerge('clients', B, L, R, { localAt: at(10), remoteAt: at(0) }).conflicts.length, 1);
  assert.equal(threeWayMerge('clients', B, L, R, { localAt: 'not a time', remoteAt: at(0) }).conflicts.length, 1);
});

test('push-only collections overwrite a QBO-side edit; a purchase order\'s status comes back', () => {
  for (const c of PUSH_ONLY_COLLECTIONS) {
    for (const f of FIELD_RULES[c].pushOnly) {
      const r = threeWayMerge(c, form(c, 'b'), form(c, 'b'), form(c, 'b', f, 'edited in qbo'));
      assert.deepEqual(r.toRemote, [f], `${c}.${f}`);
      assert.deepEqual(r.autoResolved, [{ field: f, winner: 'fishtape' }], `${c}.${f}`);
    }
  }
  const po = threeWayMerge('purchaseOrders', form('purchaseOrders', 'b', 'status', 'open'), form('purchaseOrders', 'b', 'status', 'open'), form('purchaseOrders', 'b', 'status', 'closed'));
  assert.deepEqual([po.toLocal, po.toRemote], [['status'], []]);
});

test('lines are one field: two different line edits are a money conflict', () => {
  const c = { collection: 'invoices', mappings: M, features: { salesTax: true }, company: { province: 'MB', zone: 'America/Winnipeg' },
    refs: { qboIdFor: (coll, id) => ({ 'c-prairie': '58', 'job-1042': '59', 'item-panel': '101', 'est-2001': '501' })[id] ?? null, fishtapeIdFor: (coll, q) => (coll === 'jobs' && q === '59' ? 'job-1042' : null) },
    link: { meta: { lineIds: { 0: '1', 1: '2', 2: '3', markup: '4' }, marker: 'Fishtape ref 0123456789ab' } } };
  const inv = F.invoices[0];
  const B = fishtapeToCanon('invoices', inv, c);
  const L = fishtapeToCanon('invoices', { ...inv, lines: inv.lines.map((l, i) => (i === 0 ? { ...l, unitCents: 130000 } : l)) }, c);
  const R = qboToCanon('Invoice', { ...Q.invoice, Line: Q.invoice.Line.map((l) => (l.Id === '2' ? { ...l, Description: 'NMD90 14/2' } : l)) }, c);
  const r = threeWayMerge('invoices', B, L, R);
  assert.deepEqual(r.conflicts.map((x) => x.field), ['lines']);
  assert.deepEqual([r.toLocal, r.toRemote], [[], []]);
  // Only the description of one line changed in QBO: the lines come to Fishtape
  const r2 = threeWayMerge('invoices', B, B, R);
  assert.deepEqual(r2.toLocal, ['lines']);
  // A status that is "paid" in Fishtape is "open" in both canonical forms: never a status push
  const paid = fishtapeToCanon('invoices', { ...inv, status: 'paid' }, c);
  assert.deepEqual(threeWayMerge('invoices', B, paid, qboToCanon('Invoice', Q.invoice, c)).toRemote, []);
});

test('remoteAlias: R counts as equal to the snapshot until R really changes', () => {
  const B = form('payments', 'b', 'amountCents', 50400);
  const alias = { amountCents: aliasHash('payments', 'amountCents', 48908) };
  const net = form('payments', 'b', 'amountCents', 48908);
  const r = threeWayMerge('payments', B, B, net, { remoteAlias: alias });
  assert.deepEqual([r.toLocal, r.toRemote, r.conflicts, r.aliasDropped], [[], [], [], []]);
  // Fishtape changes the amount: the alias holds, so it is a plain push
  assert.deepEqual(threeWayMerge('payments', B, form('payments', 'b', 'amountCents', 51000), net, { remoteAlias: alias }).toRemote, ['amountCents']);
  // QBO changes it: the alias is dropped and the change comes to Fishtape
  const moved = threeWayMerge('payments', B, B, form('payments', 'b', 'amountCents', 40000), { remoteAlias: alias });
  assert.deepEqual([moved.toLocal, moved.aliasDropped], [['amountCents'], ['amountCents']]);
  assert.equal(canonHash({ a: 1, b: [1, 2] }), canonHash({ b: [1, 2], a: 1 }));
  assert.notEqual(canonHash({ a: 1 }), canonHash({ a: 2 }));
  assert.match(canonHash(null), /^[0-9a-f]{64}$/);
});

test('stale revert guard: a device that never saw the pull does not push the old value back', () => {
  // The pull moved dueDate (auto) and lines (money) to QBO's values; the device put the old ones back.
  const B = form('invoices', 'b', 'dueDate', '2026-11-30');
  const R = form('invoices', 'b', 'dueDate', '2026-11-30');
  const L = form('invoices', 'b', 'dueDate', '2026-11-14');
  const prevValues = { dueDate: '2026-11-14' };
  const r = threeWayMerge('invoices', B, L, R, { stale: true, prevValues });
  assert.deepEqual([r.toLocal, r.toRemote, r.autoResolved], [['dueDate'], [], [{ field: 'dueDate', winner: 'quickbooks' }]]);
  assert.equal(r.merged.dueDate, '2026-11-30');
  const m = threeWayMerge('invoices', form('invoices', 'b', 'lines', 'new'), form('invoices', 'b', 'lines', 'old'), form('invoices', 'b', 'lines', 'new'), { stale: true, prevValues: { lines: 'old' } });
  assert.deepEqual(m.conflicts.map((x) => x.field), ['lines']);
  // Not stale: an ordinary Fishtape edit
  assert.deepEqual(threeWayMerge('invoices', B, L, R, { stale: false, prevValues }).toRemote, ['dueDate']);
});

test('held device money values always open a conflict', () => {
  const B = form('invoices', 'b');
  // records.js kept the server's lines and held the device's; L is built with the held lines
  const r = threeWayMerge('invoices', B, form('invoices', 'b', 'lines', 'device lines'), B, { held: { lines: ['…'], markupPct: 0 } });
  assert.deepEqual(r.conflicts, [{ field: 'lines', base: 'b', fishtape: 'device lines', quickbooks: 'b' }]);
  assert.deepEqual(r.toRemote, []);
  const amount = threeWayMerge('payments', form('payments', 'b'), form('payments', 'b', 'amountCents', 1), form('payments', 'b'), { held: { amountCents: 1 } });
  assert.deepEqual(amount.conflicts.map((x) => x.field), ['amountCents']);
});

test('display values for the conflicts screen', () => {
  const lines = [{ amountCents: 100000 }, { amountCents: 6500 }, { amountCents: 0 }];
  assert.equal(displayValue('invoices', 'lines', lines), '3 lines, $1,065.00');
  assert.equal(displayValue('invoices', 'lines', [{ amountCents: 500 }]), '1 line, $5.00');
  assert.equal(displayValue('payments', 'amountCents', 112001), '$1,120.01');
  assert.equal(displayValue('items', 'priceCents', 125000), '$1,250.00');
  assert.equal(displayValue('payments', 'method', { ref: '32', key: 'check' }), 'check');
  assert.equal(displayValue('invoices', 'date', '2026-10-21'), '2026-10-21');
  assert.equal(displayValue('invoices', 'status', 'void'), 'Void');
  assert.equal(displayValue('estimates', 'status', 'rejected'), 'Declined');
  assert.equal(displayValue('clients', 'active', false), 'No');
  assert.equal(displayValue('clients', 'type', 'business'), 'Business (company name)');
  assert.equal(displayValue('invoices', 'notes', null), '(empty)');
  assert.equal(displayValue('bills', 'taxes', [{ id: 'GST', cents: 7500 }]), 'GST $75.00');
  assert.equal(displayValue('timeEntries', 'minutes', 450), '7 h 30 min');
  assert.equal(displayValue('invoices', 'clientRef', '58'), 'QuickBooks #58');
  assert.deepEqual(conflictRows('invoices', [{ field: 'date', base: '2026-10-20', fishtape: '2026-10-20', quickbooks: '2026-10-21' }]),
    [{ field: 'date', label: 'Date', base: '2026-10-20', fishtape: '2026-10-20', quickbooks: '2026-10-21' }]);
});
