// Quick-find index + ranking (lib/quickfind.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchEntries, rankEntries } from '../js/lib/quickfind.js';

const modules = [
  { id: 'invoices', title: 'Invoices', group: 'money', perm: 'invoices', icon: 'receipt' },
  { id: 'getpaid', title: 'Get paid', group: 'money', perm: 'invoices', icon: 'dollar' },
  { id: 'secret', title: 'Secret', group: 'admin', perm: 'admin', hidden: true },
  { id: 'crew', title: 'Crew', group: 'people', perm: 'employees' },
];
const switches = [
  { id: 'booking', label: 'Online booking', desc: 'A public booking form and inbox.', group: 'sales' },
  { id: 'hiddenSw', label: 'Hidden', desc: '', group: 'extras', hidden: true },
];
const groups = { money: 'Money', people: 'People', sales: 'Sales', admin: 'Admin' };

const base = {
  modules, switches, groups,
  canAccess: (perm) => perm !== 'admin', // the person cannot open admin screens
  isEnabled: (id) => id !== 'getpaid', // getpaid is turned off
  isSwitchOn: (id) => id === 'booking',
  label: (m) => m.title,
};

test('searchEntries drops hidden + no-access, flags enabled, builds targets', () => {
  const e = searchEntries(base);
  const ids = e.map((x) => `${x.kind}:${x.id}`);
  assert.ok(ids.includes('screen:invoices'));
  assert.ok(ids.includes('screen:getpaid'));
  assert.ok(ids.includes('screen:crew'));
  assert.ok(!ids.includes('screen:secret'), 'hidden module excluded');
  assert.ok(!ids.some((i) => i === 'screen:undefined'));
  // admin screen filtered by canAccess
  assert.ok(!e.some((x) => x.id === 'secret'));
  // option entries
  assert.ok(ids.includes('option:booking'));
  assert.ok(!ids.includes('option:hiddenSw'), 'hidden switch excluded');
  const getpaid = e.find((x) => x.id === 'getpaid');
  assert.equal(getpaid.enabled, false);
  assert.equal(getpaid.target, 'getpaid');
  const booking = e.find((x) => x.kind === 'option' && x.id === 'booking');
  assert.equal(booking.enabled, true);
  assert.match(booking.target, /settings\?section=modules&find=booking/);
});

test('includeOptions:false leaves out switches', () => {
  const e = searchEntries({ ...base, includeOptions: false });
  assert.ok(!e.some((x) => x.kind === 'option'));
});

test('rankEntries: empty query returns entries unchanged (capped)', () => {
  const e = searchEntries(base);
  assert.deepEqual(rankEntries(e, '').map((x) => x.id), e.map((x) => x.id));
  assert.equal(rankEntries(e, '  ', { limit: 2 }).length, 2);
});

test('rankEntries: matches label and description, exact/prefix beat contains', () => {
  const e = searchEntries(base);
  // "paid" matches Get paid by label
  const paid = rankEntries(e, 'paid');
  assert.equal(paid[0].id, 'getpaid');
  // "booking" matches the option by label; "public booking form" matches via its description terms
  assert.ok(rankEntries(e, 'booking').some((x) => x.id === 'booking'));
  assert.ok(rankEntries(e, 'public form').some((x) => x.id === 'booking'), 'description is searchable');
  // exact label beats a mere substring
  const inv = rankEntries(e, 'invoices');
  assert.equal(inv[0].id, 'invoices');
  // no match
  assert.equal(rankEntries(e, 'zzznope').length, 0);
});

test('rankEntries: all tokens must match (AND)', () => {
  const e = searchEntries(base);
  assert.equal(rankEntries(e, 'get paid').some((x) => x.id === 'getpaid'), true);
  assert.equal(rankEntries(e, 'get zzz').length, 0);
});
