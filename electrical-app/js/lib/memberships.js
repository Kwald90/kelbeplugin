// Residential service plans / memberships: recurring plans a homeowner buys (an annual electrical
// safety plan, a priority-service membership, a member discount). The recurring-billing,
// customer-facing cousin of js/lib/service.js service agreements — same local-first model.
//
// Pure logic, shared by the module (js/modules/memberships.js) and tests. Billing is optional:
// a membership tracks its status and renewal date by hand, and — when the company has connected
// its own Stripe — can also be put on a Stripe subscription (the module calls the server for that;
// nothing here talks to the network). Keeps the renewal date, proration and perk maths in one place.
import { addMonths } from './service.js';

const newId = (p) => (globalThis.crypto?.randomUUID ? `${p}-${crypto.randomUUID()}` : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Billing cadences: label + months per cycle. */
export const CADENCES = [
  { id: 'monthly', label: 'Monthly', months: 1 },
  { id: 'annual', label: 'Yearly', months: 12 },
];

/** A membership moves through these states. 'pending' = created, waiting on first Stripe payment. */
export const MEMBERSHIP_STATUSES = ['pending', 'active', 'paused', 'cancelled'];

/** Months in one billing cycle for a membership (defaults to yearly). */
export function cadenceMonths(m) {
  const c = CADENCES.find((x) => x.id === (m?.cadence || m));
  return c ? c.months : 12;
}

export const cadenceLabel = (id) => CADENCES.find((c) => c.id === id)?.label || 'Yearly';

/** A new membership for a client. Starts pending with a renewal one cycle out from the start date. */
export function newMembership({ client = null, planName = '', by = null, startDate = null, cadence = 'annual' } = {}) {
  const start = startDate || null;
  return {
    id: newId('mb'),
    clientId: client?.id || null,
    planName: String(planName || 'Membership plan').slice(0, 200),
    cadence: CADENCES.some((c) => c.id === cadence) ? cadence : 'annual',
    priceCents: null,
    discountPct: null,
    perks: [],
    status: 'pending',
    startDate: start,
    renewalDate: start ? addMonths(start, cadenceMonths({ cadence })) : null,
    stripeSubscriptionId: null,
    stripeCustomerId: null,
    billingStatus: null,
    lastPaymentAt: null,
    notes: '',
    createdBy: by || null,
  };
}

/** The renewal date one cycle on from `from` (YYYY-MM-DD) for a membership's cadence. */
export function nextRenewal(from, cadence) {
  if (!from) return null;
  return addMonths(from, cadenceMonths({ cadence }));
}

/** Advance the renewal date one cycle (used when a cycle is billed/renewed by hand). */
export function renewPatch(m, from = null) {
  const base = from || m?.renewalDate || null;
  return { renewalDate: nextRenewal(base, m?.cadence) };
}

export const isActive = (m) => m?.status === 'active';
export const isBilledByStripe = (m) => Boolean(m?.stripeSubscriptionId);

/** Is a membership up for renewal on or before `asOf` (YYYY-MM-DD)? Only active plans renew. */
export function isDueForRenewal(m, asOf) {
  if (!isActive(m) || !m?.renewalDate) return false;
  return String(m.renewalDate) <= String(asOf);
}

/**
 * The monthly-equivalent price in cents (a yearly plan divided by twelve), for comparing plans.
 * Returns null when there is no price.
 */
export function monthlyEquivalentCents(m) {
  if (m?.priceCents == null) return null;
  const months = cadenceMonths(m);
  return Math.round(m.priceCents / months);
}

/**
 * Unused value left in the current cycle, in cents, as of `asOf` (YYYY-MM-DD): the share of the
 * cycle price for the days still to run before the renewal date. For a mid-cycle cancellation
 * credit or a plan change. Returns 0 when there is no price, no renewal date or the cycle is over.
 */
export function remainingValueCents(m, asOf) {
  if (m?.priceCents == null || !m?.renewalDate || !asOf) return 0;
  const months = cadenceMonths(m);
  const cycleStart = addMonths(m.renewalDate, -months);
  const start = Date.parse(`${cycleStart}T00:00:00Z`);
  const end = Date.parse(`${m.renewalDate}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start) return 0;
  const total = end - start;
  const remaining = Math.min(Math.max(end - now, 0), total);
  return Math.round(m.priceCents * (remaining / total));
}

/** A short human summary of a plan's perks (discount + included perks), or '' when there are none. */
export function perkSummary(m) {
  const parts = [];
  if (m?.discountPct) parts.push(`${+m.discountPct}% member discount`);
  for (const p of m?.perks || []) { const s = String(p || '').trim(); if (s) parts.push(s); }
  return parts.join(' · ');
}

/** Badge tone for a status: active→success, paused→warning, cancelled→neutral, pending→info. */
export function statusTone(status) {
  return { active: 'success', paused: 'warning', cancelled: 'neutral', pending: 'info' }[status] || 'neutral';
}

export const membershipLabel = (m) => m?.planName || 'Membership plan';
