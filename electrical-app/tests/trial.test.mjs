// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialBannerText, trialDaysLeft } from '../js/lib/trial.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const at = (days) => new Date(NOW + days * 86_400_000).toISOString();

test('days left round up and stop at zero', () => {
  assert.equal(trialDaysLeft({ onTrial: true, trialEndsAt: at(14) }, NOW), 14);
  assert.equal(trialDaysLeft({ onTrial: true, trialEndsAt: at(11.2) }, NOW), 12);
  assert.equal(trialDaysLeft({ onTrial: true, trialEndsAt: at(0.3) }, NOW), 1);
  assert.equal(trialDaysLeft({ onTrial: true, trialEndsAt: at(-2) }, NOW), 0);
});

test('no banner off trial or without an end date', () => {
  assert.equal(trialDaysLeft(null, NOW), null);
  assert.equal(trialDaysLeft({ onTrial: false, trialEndsAt: at(5) }, NOW), null);
  assert.equal(trialDaysLeft({ onTrial: true, trialEndsAt: null }, NOW), null);
  assert.equal(trialBannerText({ onTrial: false }, NOW), null);
});

test('banner text', () => {
  assert.equal(trialBannerText({ onTrial: true, trialEndsAt: at(11.5) }, NOW), '12 days left in your trial');
  assert.equal(trialBannerText({ onTrial: true, trialEndsAt: at(0.5) }, NOW), 'Your free trial ends today');
  assert.equal(trialBannerText({ onTrial: true, trialEndsAt: at(-0.1) }, NOW), 'Your free trial has ended');
});
