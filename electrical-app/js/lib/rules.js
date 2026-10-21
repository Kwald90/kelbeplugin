// The rules table (docs/releases/r1-get-paid.md 2.7, docs/office/rules-table.md): legal and
// statutory values (prompt-payment day counts, holdback, payroll maximums, tax timing) live in
// data, never in code. This file holds only the DEFINITIONS: key, label, unit, kind, scope and
// what uses each one. The values are platform rows (`platform_rules`, seeded by migration 0160 and
// maintained by Fishtape HQ) and company overrides (the `rules` collection, Books → Rules).
//
// Statuses: verified (a lawyer, accountant or the official text confirmed it; who and when are
// required), sourced (a published source is cited, not yet confirmed for us), verify (unconfirmed
// or missing). Kinds:
//   deadline  drives an alarm or a countdown: never runs on 'verify'.
//   rate      drives a calculation: on 'verify' the caller uses its fallback (or, with allowVerify,
//             the value marked "unconfirmed").
//   policy    a yes/no or list Kelvin chose: applies on any status; screens show "unconfirmed"
//             until it is verified.
// Pure (no DOM): the PWA, the server (routes/v1/rules.js) and HQ's Rules page import it.

export const RULE_STATUS = ['verified', 'sourced', 'verify'];
export const RULE_KINDS = ['deadline', 'rate', 'policy'];
export const RULE_UNITS = ['days', 'date', 'list', 'text', 'pct', 'bool', 'factor', 'years', 'cents'];
/** Same pattern as platform_rules.key (migration 0160). */
export const RULE_KEY_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,5}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const d = (label, unit, kind, extra) => ({ label, unit, kind, scope: 'province', province: 'MB', yearly: false, companyOnly: false, usedBy: [], description: '', ...extra });
const all = (label, unit, kind, extra) => d(label, unit, kind, { scope: 'all', province: null, ...extra });

/** Every rule Fishtape knows. A company override must use one of these keys. */
export const RULE_DEFS = {
  // ---- Manitoba prompt payment (The Builders' Liens Act as amended, in force 2025-04-01) ----
  'pp.MB.inForceFrom': d('Prompt payment applies to prime contracts signed on or after', 'date', 'deadline', {
    usedBy: ['prompt-payment alarms'], description: 'The day the prompt payment rules came into force. Contracts signed before it have no alarms.' }),
  'pp.MB.paymentDays': d('Owner pays a proper invoice within', 'days', 'deadline', {
    usedBy: ['prompt-payment alarms'], description: 'Days after a proper invoice is given to the owner by which the owner must pay (the day-28 alarm).' }),
  'pp.MB.nonPaymentNoticeDays': d('Owner gives a notice of non-payment within', 'days', 'deadline', {
    usedBy: ['prompt-payment alarms'], description: 'Days after a proper invoice by which the owner must give a notice of non-payment (the day-14 alarm).' }),
  'pp.MB.subPaymentDays': d('Contractor pays its subcontractor within', 'days', 'deadline', {
    usedBy: ['prompt-payment alarms'], description: 'Days after the contractor is paid by the owner by which it must pay its subcontractors (the GC 7-day rule).' }),
  'pp.MB.subNonPaymentNoticeDays': d("A contractor's notice of non-payment to its sub within", 'days', 'deadline', {
    usedBy: [], description: 'Not used for alarms in Release 1.' }),
  'pp.MB.appliesTo': d('Contracts the prompt payment rules apply to', 'list', 'policy', {
    usedBy: ['prompt-payment alarms'], description: 'Exclusions (residential work, value thresholds). Until a lawyer confirms, alarms run on every Manitoba prime contract with "check it applies".' }),
  'pp.MB.dayRollover': d('A deadline on a weekend or holiday moves to', 'text', 'policy', {
    usedBy: ['prompt-payment alarms'], description: 'Whether a deadline that falls on a weekend or holiday moves to the next business day (Interpretation Act). Until confirmed the alarm says "may move".' }),
  'pp.MB.adjudicationPayDays': d('Pay an adjudicator’s determination within', 'days', 'deadline', {
    usedBy: [], description: 'Shown only; no alarm in Release 1.' }),
  // ---- holdback and liens ----
  'holdback.MB.pct': d('Builders’ lien holdback', 'pct', 'rate', {
    usedBy: ['jobs (display)'], description: 'Display only. Invoices use the holdback percentage typed on the job.' }),
  'holdback.MB.releaseDays': d('Holdback is released after', 'days', 'deadline', {
    usedBy: [], description: 'Days after substantial performance (or the certificate) before holdback is due. No countdown until verified.' }),
  'holdback.excludePassThrough': all('Out-of-pocket disbursements are outside the holdback base', 'bool', 'policy', {
    usedBy: ['invoice totals'], description: 'Hotel and meals billed at cost are left out of the holdback.' }),
  'lien.MB.days': d('Lien deadline', 'days', 'deadline', { usedBy: [], description: 'No countdown in Release 1.' }),
  'properInvoice.MB.fields': d('What a proper invoice must contain', 'list', 'policy', {
    usedBy: ['invoice warnings'], description: 'Shown as warnings on invoices for contracts that need a proper invoice.' }),
  // ---- tax timing ----
  'tax.CA.gstHoldbackAtRelease': all('GST on holdback is charged when it is released', 'bool', 'policy', {
    usedBy: ['invoice totals'], description: 'Excise Tax Act s.168(7).' }),
  'tax.CA.gstDueAtSubstantialCompletion': all('GST is due at substantial completion', 'bool', 'policy', {
    usedBy: ['closeout checklist', 'notifications'], description: 'Excise Tax Act s.168(3)(c).' }),
  'tax.MB.rstHoldbackAtRelease': d('RST on holdback is charged when it is released', 'bool', 'policy', {
    usedBy: ['invoice totals'], description: 'If your accountant says RST was due at billing, the deferred RST is remitted late with interest: change this here.' }),
  'tax.SK.pstHoldbackAtRelease': d('PST on holdback is charged when it is released', 'bool', 'policy', { province: 'SK', usedBy: ['invoice totals'] }),
  'tax.BC.pstHoldbackAtRelease': d('PST on holdback is charged when it is released', 'bool', 'policy', { province: 'BC', usedBy: ['invoice totals'] }),
  'tax.MB.passThroughAllowed': d('Out-of-pocket disbursements billed at cost without RST', 'bool', 'policy', {
    usedBy: ['invoice lines'], description: 'Bulletin 031 wording on separately billed hotel and meals.' }),
  // ---- payroll and burden ----
  'payroll.MB.vacationPct': d('Vacation pay', 'pct', 'rate', { usedBy: ['burden'] }),
  'payroll.MB.vacationPctLong': d('Vacation pay after the long-service years', 'pct', 'rate', { usedBy: ['burden'] }),
  'payroll.MB.vacationLongYears': d('Years of service for the higher vacation pay', 'years', 'rate', { usedBy: ['burden'] }),
  'payroll.MB.constructionHolidayPct': d('General holiday pay (construction)', 'pct', 'rate', { usedBy: ['burden'] }),
  'payroll.CA.ei.employerFactor': all('EI employer premium factor', 'factor', 'rate', { usedBy: ['burden'] }),
  'payroll.CA.cpp.rate': all('CPP contribution rate (employer)', 'pct', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.CA.cpp.ympe': all('CPP yearly maximum pensionable earnings', 'cents', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.CA.cpp.basicExemption': all('CPP basic exemption', 'cents', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.CA.cpp2.rate': all('CPP2 contribution rate (employer)', 'pct', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.CA.cpp2.yampe': all('CPP2 yearly additional maximum pensionable earnings', 'cents', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.CA.ei.rate': all('EI premium rate (employee)', 'pct', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.CA.ei.mie': all('EI maximum insurable earnings', 'cents', 'rate', { yearly: true, usedBy: ['burden'] }),
  'payroll.MB.wcb.maxAssessableCents': d('WCB maximum assessable earnings', 'cents', 'rate', { yearly: true, usedBy: ['burden'] }),
  // Company-only keys (no platform row).
  'payroll.company.wcbRatePct': all('Your WCB rate', 'pct', 'rate', {
    companyOnly: true, usedBy: ['burden'], description: 'From the company’s WCB assessment notice.' }),
  'payroll.company.healthLevyPct': all('Health and Post-Secondary Education Tax Levy', 'pct', 'rate', {
    companyOnly: true, usedBy: ['burden'], description: 'Leave empty when the company is under the exemption threshold (the usual case).' }),
};

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined) return o[k]; return undefined; };
const dayOf = (v) => (typeof v === 'string' && DAY_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

/** A platform_rules row or a `rules` record as one shape. */
export function normaliseRule(row, origin) {
  const confirmed = pick(row, 'confirmedBy', 'confirmed_by');
  return {
    key: row.key,
    province: str(row.province) || null,
    value: row.value === undefined ? null : row.value,
    status: RULE_STATUS.includes(row.status) ? row.status : 'verify',
    source: pick(row, 'source') ?? null,
    sourceUrl: pick(row, 'sourceUrl', 'source_url') ?? null,
    note: pick(row, 'note') ?? null,
    effectiveFrom: dayOf(pick(row, 'effectiveFrom', 'effective_from') instanceof Date ? pick(row, 'effectiveFrom', 'effective_from').toISOString() : pick(row, 'effectiveFrom', 'effective_from')) || '1900-01-01',
    confirmedBy: confirmed ?? null,
    confirmedAt: (() => { const v = pick(row, 'confirmedAt', 'confirmed_at'); return v instanceof Date ? v.toISOString() : v ?? null; })(),
    origin,
    ...(origin === 'company' && row.id ? { id: row.id } : {}),
  };
}

/**
 * Effective rules for one province and date. For each key the row with the newest effectiveFrom
 * on or before `on` wins; on a tie the company row wins. When a newer platform row beats a company
 * override, the platform row comes back with staleOverride: true (Books → Rules warns). A yearly key
 * whose winning row is from an earlier year comes back with status 'verify' and missingYear.
 * @returns {Map<string, object>}
 */
export function resolveRules(platformRows = [], companyRecords = [], { province = null, on } = {}) {
  const today = dayOf(on) || new Date().toISOString().slice(0, 10);
  const prov = str(province);
  const fits = (r) => r.key && (!r.province || r.province === prov) && r.effectiveFrom <= today;
  const rows = [
    ...platformRows.map((r) => normaliseRule(r, 'platform')),
    ...companyRecords.filter((r) => r && !r.deleted).map((r) => normaliseRule(r, 'company')),
  ].filter(fits);
  // Newest effectiveFrom wins; on a tie the company row; then a province row over an all-province row.
  const rank = (r) => [r.effectiveFrom, r.origin === 'company' ? 1 : 0, r.province ? 1 : 0];
  const beats = (a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const byKey = new Map();
  for (const r of rows) {
    const cur = byKey.get(r.key);
    if (!cur || beats(r, cur)) byKey.set(r.key, r);
  }
  const out = new Map();
  for (const [key, r] of byKey) {
    const res = { ...r };
    if (r.origin === 'platform' && rows.some((x) => x.key === key && x.origin === 'company')) res.staleOverride = true;
    const def = RULE_DEFS[key];
    if (def?.yearly && r.effectiveFrom.slice(0, 4) < today.slice(0, 4)) {
      res.status = 'verify';
      res.missingYear = Number(today.slice(0, 4));
    }
    out.set(key, res);
  }
  return out;
}

/**
 * The value a calculation may use, or null.
 *   deadline: status 'verified' or 'sourced' and a non-null value; never on 'verify'.
 *   rate:     'verified' or 'sourced'; on 'verify' only with allowVerify (the caller shows "unconfirmed").
 *   policy:   any status with a non-null value; on 'verify' the caller shows "unconfirmed".
 */
export function ruleValue(resolved, key, { allowVerify = false } = {}) {
  const r = resolved?.get?.(key);
  if (!r || r.value === null || r.value === undefined) return null;
  const kind = RULE_DEFS[key]?.kind || 'deadline';
  if (kind === 'policy') return r.value;
  if (r.status === 'verified' || r.status === 'sourced') return r.value;
  return kind === 'rate' && allowVerify ? r.value : null;
}

/** True when the rule is missing or not 'verified' (screens show "unconfirmed"). */
export function ruleUnconfirmed(resolved, key) {
  const r = resolved?.get?.(key);
  return !r || r.status !== 'verified';
}

/** Type check of a value for a definition: an error sentence, or null. null always passes (not set). */
export function ruleProblem(def, value) {
  if (!def) return 'Unknown rule.';
  if (value === null) return null;
  const num = typeof value === 'number' && Number.isFinite(value);
  switch (def.unit) {
    case 'days': return Number.isInteger(value) && value >= 0 && value <= 3650 ? null : 'Enter a whole number of days (0 to 3650).';
    case 'years': return Number.isInteger(value) && value >= 0 && value <= 100 ? null : 'Enter a whole number of years.';
    case 'cents': return Number.isInteger(value) && value >= 0 && value <= 1e11 ? null : 'Enter an amount in cents (a whole number).';
    case 'pct': return num && value >= 0 && value <= 100 ? null : 'Enter a percentage from 0 to 100.';
    case 'factor': return num && value >= 0 && value <= 10 ? null : 'Enter a factor from 0 to 10.';
    case 'bool': return typeof value === 'boolean' ? null : 'Pick yes or no.';
    case 'date': return typeof value === 'string' && DAY_RE.test(value) ? null : 'Enter a date as YYYY-MM-DD.';
    case 'text': return typeof value === 'string' && value.length <= 500 ? null : 'Enter up to 500 characters.';
    case 'list': return Array.isArray(value) && value.length <= 50 && value.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 80) ? null : 'Enter up to 50 short items.';
    default: return 'Unknown unit.';
  }
}

/**
 * A company override record's problems (Books → Rules and the server write rule): unknown key,
 * wrong province, bad value, no source, 'verified' without who and when. Returns a sentence or null.
 */
export function ruleRecordProblem(rec) {
  if (!rec || typeof rec !== 'object') return 'A rule needs a key.';
  const def = RULE_DEFS[rec.key];
  if (!def) return 'Pick a rule from the list.';
  const prov = str(rec.province);
  if (def.scope === 'province' && prov && prov !== def.province) return `This rule is for ${def.province} only.`;
  if (rec.effectiveFrom != null && !(typeof rec.effectiveFrom === 'string' && DAY_RE.test(rec.effectiveFrom))) return 'The effective date must be YYYY-MM-DD.';
  if (!RULE_STATUS.includes(rec.status)) return 'Pick a status: verified, sourced or verify.';
  const bad = ruleProblem(def, rec.value === undefined ? null : rec.value);
  if (bad) return bad;
  if (!str(rec.source)) return 'Name the source of this value (a bulletin, a letter, who told you).';
  if (rec.status === 'verified' && !(str(rec.confirmedBy?.name) && str(rec.confirmedAt))) return 'Marking a rule verified needs who confirmed it and when.';
  return null;
}

/** The rule key, province and effective date that must be unique among company rows. */
export const ruleIdentity = (rec) => `${rec?.key}|${str(rec?.province) || ''}|${dayOf(rec?.effectiveFrom) || '1900-01-01'}`;

/** "28 days", "4%", "Yes", "2025-04-01", "3 items", "Not set". */
export function ruleValueText(def, value) {
  if (value === null || value === undefined) return 'Not set';
  switch (def?.unit) {
    case 'days': return `${value} day${value === 1 ? '' : 's'}`;
    case 'years': return `${value} year${value === 1 ? '' : 's'}`;
    case 'pct': return `${value}%`;
    case 'factor': return `×${value}`;
    case 'bool': return value ? 'Yes' : 'No';
    case 'cents': return `$${(value / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'list': return Array.isArray(value) ? value.join(', ') : String(value);
    default: return String(value);
  }
}
