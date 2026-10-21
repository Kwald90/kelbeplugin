import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../js/store.js';
import { detectSteps, onboardingJourney, onboardingQuoteAction, showFor } from '../js/modules/onboarding.js';

const facts = (settings = structuredClone(DEFAULT_SETTINGS)) => ({ settings, synced: false, items: 0, jobs: 0, estimates: 0, planSets: 0, employees: 0 });

test('essentials prioritize company, province and rates without requiring a price book', () => {
  const steps = detectSteps(facts());
  const before = structuredClone(steps);
  const journey = onboardingJourney(steps);
  assert.deepEqual(journey.essential.map(s => s.id), ['company', 'province', 'rates']);
  assert.ok(journey.later.some(s => s.id === 'pricebook'));
  assert.equal(journey.verified, 0);
  assert.equal(journey.next.id, 'company');
  assert.deepEqual(steps, before, 'grouping does not alter progress or persisted steps');
});

test('skipping every essential never means the essentials have been verified', () => {
  const f = facts();
  f.settings.onboarding = { skipped: { company: true, province: true, rates: true } };
  const journey = onboardingJourney(detectSteps(f));
  assert.equal(journey.ready, false);
  assert.equal(journey.verified, 0);
  assert.equal(journey.skipped, 3);
  assert.equal(journey.next, null);
});

test('confirmed defaults and real company details make essentials ready without completing later setup', () => {
  const f = facts();
  f.settings.company = { ...f.settings.company, name: 'Test Electrical', phone: '403-555-0100', gstHstNo: '123456789 RT0001' };
  f.settings.onboarding = { provinceAt: '2026-10-21', ratesAt: '2026-10-21' };
  const steps = detectSteps(f), journey = onboardingJourney(steps);
  assert.equal(journey.ready, true);
  assert.equal(journey.verified, 3);
  assert.equal(journey.completed, 3);
  assert.ok(journey.later.some(s => !s.done));
  assert.equal(showFor({ isAdmin: () => true }, f.settings, steps), true);
  f.settings.onboarding.dismissedAt = '2026-10-21';
  assert.equal(showFor({ isAdmin: () => true }, f.settings, steps), false);
});

test('existing company data is recognized and module-off steps stay filtered', () => {
  const f = facts();
  f.settings.company = { ...f.settings.company, name: 'Existing Electric', address: '123 Test St', gstHstNo: '123456789 RT0001', province: 'AB' };
  f.settings.labourRateCents = 11000;
  f.settings.modules = { estimates: false, pricebook: false, inventory: false, drawings: false, integrations: false };
  const journey = onboardingJourney(detectSteps(f));
  assert.equal(journey.ready, true);
  assert.ok(!journey.later.some(s => ['pricebook', 'plans', 'connect'].includes(s.id)));
});

test('quote entry requires role access, enabled module and effective synced entitlement', () => {
  const available = { canEstimate: true, enabled: true, synced: true, entitlements: { features: ['estimates'] } };
  assert.equal(onboardingQuoteAction(available).href, '#/estimates/new');
  assert.equal(onboardingQuoteAction({ ...available, canEstimate: false }).href, null);
  assert.equal(onboardingQuoteAction({ ...available, enabled: false }).href, null);
  assert.equal(onboardingQuoteAction({ ...available, entitlements: { features: [] } }).href, null);
  assert.equal(onboardingQuoteAction({ ...available, entitlements: null }).href, null);
  assert.equal(onboardingQuoteAction({ ...available, synced: false, entitlements: null }).href, '#/estimates/new');
});

test('existing estimates lead to the list instead of silently creating another', () => {
  assert.deepEqual(onboardingQuoteAction({ canEstimate: true, enabled: true, estimateCount: 4 }), {
    href: '#/estimates', label: 'Open estimates', text: 'Continue an existing estimate or create another for your next customer.',
  });
});
