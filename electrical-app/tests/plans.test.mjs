// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN_IDS, PLANS, FEATURE_PLAN, hasFeature, entitlements, monthlyCents, planFor } from '../js/plans.js';

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

test('tiers unlock what the pricing table says', () => {
  assert.equal(hasFeature('starter', 'bending'), true);
  assert.equal(hasFeature('starter', 'drawings'), false);
  assert.equal(hasFeature('pro', 'drawings'), true);
  assert.equal(hasFeature('pro', 'ai.assistant'), false);
  assert.equal(hasFeature('business', 'mcp'), true);
  assert.equal(hasFeature('business', 'sso'), false);
  assert.equal(hasFeature('enterprise', 'sso'), true);
  assert.equal(planFor('drawings'), 'pro');
});

test('HQ overrides win over the plan, both ways', () => {
  assert.equal(hasFeature('starter', 'drawings', { drawings: true }), true);
  assert.equal(hasFeature('business', 'mcp', { mcp: false }), false);
});

test('unknown plans get only the always-on features', () => {
  assert.equal(hasFeature('nope', 'clients'), false);
  assert.equal(hasFeature('nope', 'some-feature-nobody-gates'), true);
});

test('every module in the app has a plan', () => {
  assert.ok(MODULE_IDS.length >= 20, `found ${MODULE_IDS.length} modules`);
  for (const id of MODULE_IDS) assert.ok(id && FEATURE_PLAN[id], `module ${id} has no plan in FEATURE_PLAN`);
});

test('monthly price with extra users', () => {
  assert.equal(monthlyCents('starter', 1), PLANS.starter.priceCents);
  assert.equal(monthlyCents('starter', 4), PLANS.starter.priceCents + 2 * 1500);
  assert.equal(monthlyCents('enterprise', 50), null);
});
