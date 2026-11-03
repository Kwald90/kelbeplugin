// Service management: recurring maintenance agreements and a per-site asset registry.
//
// A service agreement is a recurring contract for a client (e.g. quarterly generator PM): it has a
// frequency and a next-due date, and "logging a visit" bumps the due date forward and can spin up a
// job for the crew. An asset is a piece of equipment installed at a customer site (panel, generator,
// EV charger) with make/model/serial, warranty and service history. Pure logic, shared by the
// module and tests. Keeps Fishtape's local-first, offline model (no background scheduler): the Due
// list is computed from nextDueDate, and visits are logged by hand.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Visit frequencies: label + months between visits. 'custom' uses the agreement's intervalMonths. */
export const FREQUENCIES = [
  { id: 'monthly', label: 'Monthly', months: 1 },
  { id: 'quarterly', label: 'Quarterly', months: 3 },
  { id: 'semi-annual', label: 'Every 6 months', months: 6 },
  { id: 'annual', label: 'Yearly', months: 12 },
  { id: 'custom', label: 'Custom', months: null },
];

export const AGREEMENT_STATUSES = ['active', 'paused', 'ended'];
export const ASSET_TYPES = ['panel', 'service', 'generator', 'transfer-switch', 'ev-charger', 'ups', 'lighting', 'motor', 'hvac-electrical', 'fire-alarm', 'other'];

/** Months between visits for an agreement (custom falls back to intervalMonths, then 12). */
export function intervalMonths(a) {
  const f = FREQUENCIES.find((x) => x.id === a?.frequency);
  if (f && f.months != null) return f.months;
  return Math.max(1, Math.round(Number(a?.intervalMonths) || 12));
}

/** Add whole months to a YYYY-MM-DD date, clamping the day to the month's length. */
export function addMonths(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return iso || null;
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
  const base = new Date(Date.UTC(y, mo + n, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  return base.toISOString().slice(0, 10);
}

/** A new service agreement for a client. */
export function newAgreement({ client = null, job = null, title = '', by = null, startDate = null } = {}) {
  return {
    id: newId('sa'),
    clientId: client?.id || null,
    jobId: job?.id || null,
    title: String(title || 'Maintenance agreement').slice(0, 200),
    frequency: 'quarterly',
    intervalMonths: 3,
    priceCents: null,
    billing: 'per-visit', // 'per-visit' | 'monthly' | 'annual'
    status: 'active',
    startDate: startDate || null,
    nextDueDate: startDate || null,
    lastVisitAt: null,
    visits: [],
    assetIds: [],
    notes: '',
    createdBy: by || null,
  };
}

/** Is a visit due on or before `asOf` (YYYY-MM-DD)? Only active agreements are ever due. */
export function isDue(a, asOf) {
  if (!a || a.status !== 'active' || !a.nextDueDate) return false;
  return String(a.nextDueDate) <= String(asOf);
}

/** How a visit changes the agreement: record it and move the due date one interval on. */
export function logVisitPatch(a, { at = null, jobId = null, note = '' } = {}) {
  const when = at || new Date().toISOString();
  const from = a?.nextDueDate || when.slice(0, 10);
  const visit = { id: newId('v'), at: when, jobId: jobId || null, note: String(note || '').slice(0, 500) };
  return {
    lastVisitAt: when,
    nextDueDate: addMonths(from, intervalMonths(a)),
    visits: [...(a?.visits || []), visit],
  };
}

/** A new site asset for a client (and optional job/site). */
export function newAsset({ client = null, job = null, name = '', type = 'panel', by = null } = {}) {
  return {
    id: newId('as'),
    clientId: client?.id || null,
    jobId: job?.id || null,
    name: String(name || '').slice(0, 200),
    type: ASSET_TYPES.includes(type) ? type : 'other',
    location: '',
    make: '', model: '', serial: '',
    specs: '',
    installedAt: null,
    warrantyUntil: null,
    lastServiceAt: null,
    status: 'in-service',
    notes: '',
    photos: [],
    createdBy: by || null,
  };
}

/** 'expired' | 'expiring' | 'ok' | null for an asset's warranty, given today and a window (days). */
export function warrantyState(asset, asOf, withinDays = 60) {
  const until = asset?.warrantyUntil;
  if (!until) return null;
  if (String(until) < String(asOf)) return 'expired';
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const u = Date.parse(`${until}T00:00:00Z`);
  if (Number.isFinite(a) && Number.isFinite(u) && (u - a) / 86400000 <= withinDays) return 'expiring';
  return 'ok';
}

export const agreementLabel = (a) => a?.title || 'Agreement';
export const assetLabel = (x) => x?.name || [x?.make, x?.model].filter(Boolean).join(' ') || 'Asset';
