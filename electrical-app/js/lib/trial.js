// The free-trial banner shown after sign-in ("12 days left in your trial", linking to
// #/billing). Pure helpers here so they can be tested without a DOM; app.js draws it.

const DAY = 86_400_000;

/**
 * Whole days left in the trial, rounded up (a trial that ends in 11.2 days has 12 left),
 * 0 on its last day or after it ends, or null when the company is not on a trial.
 * @param {{ onTrial?: boolean, trialEndsAt?: string|null }|null} ent /api/v1/me entitlements
 */
export function trialDaysLeft(ent, now = Date.now()) {
  if (!ent?.onTrial || !ent.trialEndsAt) return null;
  const ms = new Date(ent.trialEndsAt).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / DAY));
}

/** The banner text, or null when there is nothing to say. */
export function trialBannerText(ent, now = Date.now()) {
  const left = trialDaysLeft(ent, now);
  if (left == null) return null;
  if (new Date(ent.trialEndsAt).getTime() <= now) return 'Your free trial has ended';
  if (left <= 1) return 'Your free trial ends today';
  return `${left} days left in your trial`;
}
