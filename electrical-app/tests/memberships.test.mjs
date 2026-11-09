// Residential service plans / memberships pure logic (js/lib/memberships.js).
// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newMembership, cadenceMonths, nextRenewal, renewPatch, isActive, isBilledByStripe,
  isDueForRenewal, monthlyEquivalentCents, remainingValueCents, perkSummary, statusTone, membershipLabel, MEMBERSHIP_STATUSES,
} from '../js/lib/memberships.js';

test('a new membership starts pending with a renewal one cycle out from the start', () => {
  const m = newMembership({ planName: 'Home Safe Annual', startDate: '2026-11-01', cadence: 'annual', by: 'u1' });
  assert.equal(m.status, 'pending');
  assert.equal(m.cadence, 'annual');
  assert.equal(m.startDate, '2026-11-01');
  assert.equal(m.renewalDate, '2027-11-01', 'annual: +12 months');
  assert.equal(m.stripeSubscriptionId, null);
  assert.equal(m.createdBy, 'u1');
  const mo = newMembership({ startDate: '2026-11-01', cadence: 'monthly' });
  assert.equal(mo.renewalDate, '2026-12-01', 'monthly: +1 month');
});

test('a bad cadence falls back to annual', () => {
  assert.equal(newMembership({ cadence: 'weekly' }).cadence, 'annual');
  assert.equal(cadenceMonths({ cadence: 'monthly' }), 1);
  assert.equal(cadenceMonths({ cadence: 'annual' }), 12);
  assert.equal(cadenceMonths({ cadence: 'nonsense' }), 12);
});

test('nextRenewal and renewPatch advance one cycle on', () => {
  assert.equal(nextRenewal('2026-11-01', 'annual'), '2027-11-01');
  assert.equal(nextRenewal('2026-11-30', 'monthly'), '2026-12-30');
  assert.equal(nextRenewal(null, 'annual'), null);
  const m = { cadence: 'monthly', renewalDate: '2026-12-01' };
  assert.equal(renewPatch(m).renewalDate, '2027-01-01');
});

test('only active plans are due for renewal, on or before the date', () => {
  const m = { status: 'active', renewalDate: '2026-11-01' };
  assert.equal(isDueForRenewal(m, '2026-11-01'), true);
  assert.equal(isDueForRenewal(m, '2026-10-31'), false);
  assert.equal(isDueForRenewal({ ...m, status: 'paused' }, '2027-01-01'), false);
  assert.equal(isDueForRenewal({ ...m, renewalDate: null }, '2027-01-01'), false);
  assert.equal(isActive(m), true);
  assert.equal(isActive({ status: 'cancelled' }), false);
});

test('monthly-equivalent price divides a yearly plan by twelve', () => {
  assert.equal(monthlyEquivalentCents({ cadence: 'annual', priceCents: 24000 }), 2000);
  assert.equal(monthlyEquivalentCents({ cadence: 'monthly', priceCents: 2000 }), 2000);
  assert.equal(monthlyEquivalentCents({ cadence: 'annual', priceCents: null }), null);
});

test('remaining cycle value prorates by the days left before renewal', () => {
  // Annual plan, cycle 2026-11-01 → 2027-11-01, $120/yr. Exactly at renewal: nothing left.
  const m = { cadence: 'annual', priceCents: 12000, renewalDate: '2027-11-01' };
  assert.equal(remainingValueCents(m, '2027-11-01'), 0);
  assert.equal(remainingValueCents(m, '2026-11-01'), 12000, 'at cycle start the whole cycle remains');
  // Half way through a 31-day monthly cycle.
  // Monthly cycle 2026-11-01 → 2026-12-01 is 30 days; 15 days remain on the 16th.
  const mo = { cadence: 'monthly', priceCents: 3100, renewalDate: '2026-12-01' };
  assert.equal(remainingValueCents(mo, '2026-11-16'), 1550, '15 of 30 days left');
  assert.equal(remainingValueCents({ cadence: 'annual', priceCents: null, renewalDate: '2027-11-01' }, '2027-01-01'), 0);
});

test('perk summary joins the discount and included perks', () => {
  assert.equal(perkSummary({ discountPct: 10, perks: ['Priority dispatch', 'Annual inspection'] }), '10% member discount · Priority dispatch · Annual inspection');
  assert.equal(perkSummary({ perks: [] }), '');
  assert.equal(perkSummary({ discountPct: 0, perks: ['', '  '] }), '');
});

test('status tone and labels', () => {
  assert.equal(statusTone('active'), 'success');
  assert.equal(statusTone('paused'), 'warning');
  assert.equal(statusTone('cancelled'), 'neutral');
  assert.equal(statusTone('pending'), 'info');
  assert.equal(membershipLabel({ planName: 'Gold' }), 'Gold');
  assert.equal(membershipLabel({}), 'Membership plan');
  assert.deepEqual(MEMBERSHIP_STATUSES, ['pending', 'active', 'paused', 'cancelled']);
  assert.equal(isBilledByStripe({ stripeSubscriptionId: 'sub_1' }), true);
  assert.equal(isBilledByStripe({}), false);
});
