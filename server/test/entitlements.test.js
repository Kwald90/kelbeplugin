// Plan entitlements: trial rule, HQ overrides and the route guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePlan, tenantHas, tenantEntitlements, assertFeature, requireFeature, TRIAL_PLAN } from '../src/services/entitlements.js';

const day = 86_400_000;
const now = new Date('2026-10-19T12:00:00Z');

test('a running trial gets the trial plan; an expired one drops to starter', () => {
  assert.equal(effectivePlan({ plan: 'trial', trial_ends_at: null }, now), TRIAL_PLAN);
  assert.equal(effectivePlan({ plan: 'trial', trial_ends_at: new Date(now - (-day)) }, now), TRIAL_PLAN);
  assert.equal(effectivePlan({ plan: 'trial', trial_ends_at: new Date(now - day) }, now), 'starter');
  assert.equal(effectivePlan({ plan: 'pro' }, now), 'pro');
  assert.equal(effectivePlan({ plan: 'something-old' }, now), 'starter');
});

test('overrides from HQ win over the plan', () => {
  assert.equal(tenantHas({ plan: 'starter', plan_overrides: {} }, 'drawings', now), false);
  assert.equal(tenantHas({ plan: 'starter', plan_overrides: { drawings: true } }, 'drawings', now), true);
  assert.equal(tenantHas({ plan: 'business', plan_overrides: { 'ai.assistant': false } }, 'ai.assistant', now), false);
});

test('tenantEntitlements reports plan, trial state and features', () => {
  const e = tenantEntitlements({ plan: 'trial', trial_ends_at: new Date(now.getTime() + 5 * day), plan_overrides: {} }, now);
  assert.equal(e.plan, TRIAL_PLAN);
  assert.equal(e.onTrial, true);
  assert.ok(e.features.includes('ai.assistant'));
  assert.ok(!e.features.includes('sso'));
});

test('assertFeature and requireFeature refuse with feature_not_in_plan', async () => {
  const db = { query: async (_sql, [id]) => ({ rows: id === 't-pro' ? [{ plan: 'pro', plan_overrides: {}, trial_ends_at: null }] : [] }) };
  await assertFeature(db, 't-pro', 'drawings');
  await assert.rejects(assertFeature(db, 't-pro', 'mcp'), (e) => e.code === 'feature_not_in_plan' && e.statusCode === 403);
  await assert.rejects(assertFeature(db, 'missing', 'clients'), (e) => e.code === 'feature_not_in_plan');
  await assert.rejects(requireFeature(db, 'mcp')({ principal: { tenantId: 't-pro' } }), (e) => e.code === 'feature_not_in_plan');
  await requireFeature(db, 'panels')({ principal: { tenantId: 't-pro' } });
});

test('new companies get a trial that ends: TRIAL_DAYS, default 14, at most 730 (Stripe)', async () => {
  const { trialDays } = await import('../src/services/tenants.js');
  assert.equal(trialDays({}), 14);
  assert.equal(trialDays({ TRIAL_DAYS: '30' }), 30);
  assert.equal(trialDays({ TRIAL_DAYS: '0' }), 14);
  assert.equal(trialDays({ TRIAL_DAYS: 'soon' }), 14);
  assert.equal(trialDays({ TRIAL_DAYS: '999' }), 730);
});

test('a trialing Stripe subscription counts as a trial with the chosen tier', async () => {
  const { tenantEntitlements } = await import('../src/services/entitlements.js');
  const ends = new Date(Date.now() + 14 * 86_400_000);
  const e = tenantEntitlements({ plan: 'pro', billing_status: 'trialing', trial_ends_at: ends, plan_overrides: {} });
  assert.equal(e.plan, 'pro');
  assert.equal(e.onTrial, true);
  assert.equal(e.trialEndsAt, ends.toISOString());
  assert.ok(e.features.includes('drawings') && !e.features.includes('ai.assistant'));
  assert.equal(tenantEntitlements({ plan: 'pro', billing_status: 'active', plan_overrides: {} }).onTrial, false);
});
