import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryNavigation, navigationLabel } from '../js/lib/navigation.js';

const modules = ['dashboard', 'today', 'clients', 'jobs', 'invoices', 'time', 'drawings', 'schedule', 'calcs'].map((id) => ({ id, title: id }));
const ids = (role, available = modules) => primaryNavigation(available, role).map((m) => m.id);
test('office and field roles receive relevant primary destinations', () => {
  for (const role of ['owner', 'admin', 'office']) assert.deepEqual(ids(role), ['dashboard', 'clients', 'jobs', 'invoices']);
  for (const role of ['electrician', 'apprentice']) assert.deepEqual(ids(role), ['today', 'jobs', 'time', 'drawings']);
  assert.deepEqual(ids('foreman'), ['today', 'jobs', 'schedule', 'time']);
});
test('restricted or disabled destinations cannot be reintroduced by preference order', () => {
  const available = modules.filter((m) => !['clients', 'invoices', 'today'].includes(m.id));
  const selected = primaryNavigation(available, 'owner');
  assert.equal(selected.length, 4);
  assert.equal(new Set(selected.map((m) => m.id)).size, 4);
  assert.ok(selected.every((m) => available.includes(m)));
  assert.deepEqual(ids('apprentice', [modules[6]]), ['drawings']);
  assert.deepEqual(ids('owner', []), []);
});
test('plan-locked modules stay discoverable and unknown roles still respect availability', () => {
  const locked = { id: 'invoices', locked: true };
  assert.ok(primaryNavigation([...modules.filter((m) => m.id !== locked.id), locked], 'owner').includes(locked));
  assert.deepEqual(ids('custom', [{ id: 'time' }]), ['time']);
});
test('labels improve language without changing destination identities', () => {
  assert.equal(navigationLabel({ id: 'dashboard', title: 'Dashboard' }), 'Today');
  assert.equal(navigationLabel({ id: 'clients', title: 'Clients' }), 'Customers');
  assert.equal(navigationLabel({ id: 'jobs', title: 'Jobs' }), 'Jobs');
});
