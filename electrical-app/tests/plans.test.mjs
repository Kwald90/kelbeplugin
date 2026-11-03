// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN_IDS, PLANS, FEATURE_PLAN, hasFeature, entitlements, monthlyCents, priceCents, periodOf, planFor } from '../js/plans.js';

// Module ids, read from the source (the modules themselves need a DOM to import).
const modDir = new URL('../js/modules/', import.meta.url);
const MODULE_IDS = [...readFileSync(new URL('index.js', modDir), 'utf8').matchAll(/from '\.\/([\w-]+)\.js'/g)]
  .map(([, file]) => readFileSync(new URL(`${file}.js`, modDir), 'utf8').match(/^\s+id: '([\w-]+)'/m)?.[1]);

test('higher plans include everything lower plans do', () => {
  for (let i = 1; i < PLAN_IDS.length; i++) {
    const lower = new Set(entitlements(PLAN_IDS[i - 1]));
    const higher = new Set(entitlements(PLAN_IDS[i]));
    for (const f of lower) assert.ok(higher.has(f), `${PLAN_IDS[i]} is missing ${f}`);
  }
});

test('three self-serve tiers, Enterprise retired', () => {
  assert.deepEqual(PLAN_IDS, ['starter', 'pro', 'business']);
  assert.equal(PLANS.starter.name, 'Live Wire');
  assert.equal(PLANS.pro.name, 'Fully Loaded');
  assert.equal(PLANS.business.name, 'Full Power');
});

test('Live Wire is calculators and concept drawings only', () => {
  for (const f of ['calcs', 'bending', 'wireruns', 'drawings', 'panels']) {
    assert.equal(hasFeature('starter', f), true, f);
  }
  for (const f of ['clients', 'jobs', 'estimates', 'invoices', 'leads', 'portal', 'leadsite']) {
    assert.equal(hasFeature('starter', f), false, f);
  }
  assert.equal(planFor('drawings'), 'starter');
  assert.equal(planFor('clients'), 'pro');
});

test('Fully Loaded adds the business app and lead-capture; Full Power adds scale', () => {
  assert.equal(hasFeature('pro', 'clients'), true);
  assert.equal(hasFeature('pro', 'leadsite'), true);
  assert.equal(hasFeature('pro', 'api'), false);
  assert.equal(hasFeature('pro', 'sso'), false);
  assert.equal(hasFeature('business', 'api'), true);
  assert.equal(hasFeature('business', 'sso'), true);
  assert.equal(hasFeature('business', 'integrations.sms'), true);
});

test('AI is gone from the pricing surface (no labels), but its server gate stays', async () => {
  const { FEATURE_LABELS } = await import('../js/modules/billing.js');
  for (const f of ['ai.assistant', 'ai.cec', 'ai.background', 'mcp', 'assistant']) {
    assert.equal(FEATURE_LABELS[f], undefined, `${f} should not be labelled`);
    assert.ok(FEATURE_PLAN[f], `${f} should still be gated`);
  }
});

test('Release 1 (contract 2.11): the books and reporting live in the full app (Fully Loaded)', () => {
  for (const f of ['books', 'tickets', 'reports', 'reports.wip', 'monthend']) {
    assert.equal(FEATURE_PLAN[f], 'pro', f);
    assert.equal(hasFeature('starter', f), false, f);
    assert.equal(hasFeature('pro', f), true, f);
  }
});

test('HQ overrides win over the plan, both ways', () => {
  assert.equal(hasFeature('starter', 'clients', { clients: true }), true);
  assert.equal(hasFeature('business', 'api', { api: false }), false);
});

test('unknown plans get only the always-on features', () => {
  assert.equal(hasFeature('nope', 'clients'), false);
  assert.equal(hasFeature('nope', 'some-feature-nobody-gates'), true);
});

test('every module in the app has a plan', () => {
  assert.ok(MODULE_IDS.length >= 20, `found ${MODULE_IDS.length} modules`);
  for (const id of MODULE_IDS) assert.ok(id && FEATURE_PLAN[id], `module ${id} has no plan in FEATURE_PLAN`);
});

test('price by period, with extra seats only on Full Power', () => {
  // Live Wire: $40/year, one seat, no paid extras.
  assert.equal(periodOf('starter'), 'year');
  assert.equal(priceCents('starter', 1), 4000);
  assert.equal(priceCents('starter', 5), 4000);
  assert.equal(monthlyCents('starter'), Math.round(4000 / 12));
  // Fully Loaded: $149/month, up to 2 seats, no paid extras.
  assert.equal(periodOf('pro'), 'month');
  assert.equal(priceCents('pro', 2), 14900);
  assert.equal(priceCents('pro', 4), 14900);
  // Full Power: $349/month includes 5, then $47/seat.
  assert.equal(priceCents('business', 5), 34900);
  assert.equal(priceCents('business', 7), 34900 + 2 * 4700);
  assert.equal(priceCents('nope', 50), null);
});
