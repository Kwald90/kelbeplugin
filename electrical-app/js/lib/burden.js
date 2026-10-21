// Labour burden: what an hour of an employee's time costs the company beyond the wage
// (docs/releases/r1-get-paid.md 6.4, docs/office/job-costing.md). Pure, no DOM: job costing, the
// Rates screen, month-end and the server's reports use it.
//
// Every legal number comes from the rules table (lib/rules.js): CPP, CPP2 and EI rates and yearly
// maximums, the WCB maximum, Manitoba vacation and construction holiday pay. A rule that is not
// loaded for the year (status verify, missing, or last year's row) is never used silently: the
// statutory part falls back to the company's flat percentage (settings.costing.statutoryPctFallback)
// and the result carries a warning the screens show.
//
// The maximums apply to expected yearly earnings (wage x annual hours, plus vacation and holiday pay,
// which CPP, EI and WCB also apply to), so a flat percentage never overstates the cost of a high
// earner. Amounts are integer cents per hour; percentages are plain numbers (5.95 means 5.95%).
import { resolveRules, ruleValue } from './rules.js';

/** Roles that count for break-even and the estimate budget (office wages belong in overhead). */
export const FIELD_ROLES = ['electrician', 'apprentice', 'foreman'];
export const DEFAULT_ANNUAL_HOURS = 2000;
export const DEFAULT_NON_PRODUCTIVE_PCT = 10;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * The effective-dated rate on a day from a history [{ from: 'YYYY-MM-DD', rateCents, rateUnit? }]:
 * the entry with the newest `from` on or before `day`, or null (the caller falls back to the
 * current rate). rateEntryOn returns the whole entry (equipment rates carry their unit).
 */
export function rateEntryOn(history, day) {
  if (!Array.isArray(history) || !history.length) return null;
  const d = String(day || '').slice(0, 10);
  let best = null;
  for (const h of history) {
    if (!h || !DAY_RE.test(String(h.from || '')) || num(h.rateCents) == null) continue;
    if (d && h.from > d) continue;
    if (!best || h.from > best.from) best = h;
  }
  return best;
}
export function rateOn(history, day) {
  const e = rateEntryOn(history, day);
  return e ? Number(e.rateCents) : null;
}

/** An employee's wage on a day: the rate history, else the current rateCents. */
export function wageOn(employee, day) {
  return rateOn(employee?.rateHistory, day) ?? num(employee?.rateCents) ?? 0;
}

/**
 * The rules in force for a province and day as a Map(key -> resolved row), from whatever the caller
 * has: a Map already resolved, the rows of GET /api/v1/rules/effective (store meta 'rules', or its
 * `{ rules }` envelope), or platform and company rows ({ platform, company }). Rows carrying `origin`
 * are split by it. Resolving again for the day means a yearly value from another year is reported
 * as missing for that year.
 */
export function rulesFor(rules, { province = null, on } = {}) {
  if (rules instanceof Map) return rules;
  if (!rules) return new Map();
  if (Array.isArray(rules?.rules)) return rulesFor(rules.rules, { province, on });
  if (!Array.isArray(rules) && (Array.isArray(rules.platform) || Array.isArray(rules.company))) {
    return resolveRules(rules.platform || [], rules.company || [], { province, on });
  }
  if (!Array.isArray(rules)) return new Map();
  const company = rules.filter((r) => r?.origin === 'company');
  const platform = rules.filter((r) => r?.origin !== 'company');
  return resolveRules(platform, company, { province, on });
}

/** Whole years from hire date to `on` (null without a hire date). */
export function yearsOfService(hireDate, on) {
  if (!DAY_RE.test(String(hireDate || '').slice(0, 10)) || !DAY_RE.test(String(on || '').slice(0, 10))) return null;
  const [hy, hm, hd] = hireDate.slice(0, 10).split('-').map(Number);
  const [y, m, d] = on.slice(0, 10).split('-').map(Number);
  let years = y - hy;
  if (m < hm || (m === hm && d < hd)) years -= 1;
  return Math.max(0, years);
}

/**
 * What an hour of this employee costs on `on` (YYYY-MM-DD; default 1 July of `year`).
 * @param {object} employee
 * @param {{ rules?: any, settings?: object, year?: number, on?: string }} o
 * @returns {{ wageCents: number, annualHours: number, vacationPct: number, holidayPct: number, cppPct: number|null,
 *   eiPct: number|null, wcbPct: number, levyPct: number, benefitsCentsPerHour: number, statutoryPct: number,
 *   nonProductivePct: number, costPerPaidHourCents: number, costPerProductiveHourCents: number,
 *   earningsCents: number, fallbackUsed: boolean, warnings: string[] }}
 */
export function burdenRate(employee, { rules = null, settings = null, year = null, on = null } = {}) {
  const day = DAY_RE.test(String(on || '').slice(0, 10)) ? String(on).slice(0, 10) : `${Number(year) || new Date().getFullYear()}-07-01`;
  const yr = Number(day.slice(0, 4));
  const province = String(settings?.company?.province || '').toUpperCase() || null;
  const costing = settings?.costing || {};
  const own = employee?.burden || {};
  const resolved = rulesFor(rules, { province, on: day });
  const warnings = [];
  const rate = (key) => num(ruleValue(resolved, key));

  const wageCents = wageOn(employee, day);
  const annualHours = num(own.annualHours) ?? num(costing.annualHours) ?? DEFAULT_ANNUAL_HOURS;
  const nonProductivePct = Math.min(95, Math.max(0, num(own.nonProductivePct) ?? num(costing.nonProductivePctDefault) ?? DEFAULT_NON_PRODUCTIVE_PCT));
  const benefitsCentsPerHour = Math.max(0, num(own.benefitsCentsPerHour) ?? 0);

  // Vacation: the employee's override, else the long-service rate from the hire-date anniversary.
  let vacationPct = num(own.vacationPct);
  if (vacationPct == null) {
    const base = rate(`payroll.${province}.vacationPct`);
    const long = rate(`payroll.${province}.vacationPctLong`);
    const longYears = rate(`payroll.${province}.vacationLongYears`);
    const years = yearsOfService(employee?.hireDate, day);
    if (long != null && longYears != null && years != null && years >= longYears) vacationPct = long;
    else vacationPct = base;
    if (vacationPct == null) { vacationPct = 0; warnings.push(`Vacation pay rule not loaded for ${province || 'your province'}: set it on the employee.`); }
  }
  let holidayPct = num(own.holidayPct);
  if (holidayPct == null) {
    holidayPct = rate(`payroll.${province}.constructionHolidayPct`);
    if (holidayPct == null) { holidayPct = 0; if (province === 'MB') warnings.push('Construction holiday pay rule not loaded: set it on the employee.'); }
  }

  const earningsCents = wageCents * annualHours * (1 + (vacationPct + holidayPct) / 100);
  const zero = !(earningsCents > 0);
  if (zero) warnings.push('No wage or annual hours: burden is zero.');

  // Statutory parts as a % of earnings, each capped by its yearly maximum.
  const missing = [];
  const pctOf = (cents) => (zero ? 0 : (cents / earningsCents) * 100);
  let cppPct = null, eiPct = null, wcbPct = 0, levyPct = 0;
  const cpp = { rate: rate('payroll.CA.cpp.rate'), ympe: rate('payroll.CA.cpp.ympe'), basic: rate('payroll.CA.cpp.basicExemption') };
  const cpp2 = { rate: rate('payroll.CA.cpp2.rate'), yampe: rate('payroll.CA.cpp2.yampe') };
  if (cpp.rate == null || cpp.ympe == null || cpp.basic == null || cpp2.rate == null || cpp2.yampe == null) missing.push('CPP');
  else {
    const base = Math.min((cpp.rate / 100) * Math.max(0, earningsCents - cpp.basic), (cpp.rate / 100) * Math.max(0, cpp.ympe - cpp.basic));
    const second = (cpp2.rate / 100) * Math.max(0, Math.min(earningsCents, cpp2.yampe) - cpp.ympe);
    cppPct = pctOf(base + second);
  }
  const ei = { rate: rate('payroll.CA.ei.rate'), mie: rate('payroll.CA.ei.mie'), factor: rate('payroll.CA.ei.employerFactor') };
  if (ei.rate == null || ei.mie == null || ei.factor == null) missing.push('EI');
  else eiPct = pctOf(Math.min(earningsCents, ei.mie) * (ei.rate / 100) * ei.factor);
  const wcbRate = num(own.wcbPct) ?? rate('payroll.company.wcbRatePct');
  if (wcbRate == null) warnings.push('Your WCB rate is not set (Books → Rules, or on the employee).');
  else {
    const max = province === 'MB' ? rate('payroll.MB.wcb.maxAssessableCents') : null;
    if (province === 'MB' && max == null) missing.push('WCB maximum');
    wcbPct = pctOf((max == null ? earningsCents : Math.min(earningsCents, max)) * (wcbRate / 100));
  }
  levyPct = rate('payroll.company.healthLevyPct') ?? 0;

  const fallback = num(costing.statutoryPctFallback);
  let statutoryPct = (cppPct ?? 0) + (eiPct ?? 0) + wcbPct + levyPct;
  let fallbackUsed = false;
  if (missing.length) {
    const what = `${missing.join('/')} ${yr} ${missing.length > 1 ? 'values' : 'value'} not loaded`;
    if (fallback != null) {
      statutoryPct = fallback;
      fallbackUsed = true;
      warnings.push(`${what}; using your flat ${fallback}%.`);
    } else {
      warnings.push(`${what} and no flat statutory % is set (Job costing → Rates): the cost is understated.`);
    }
  }
  if (zero) statutoryPct = 0;

  const loaded = wageCents * (1 + (vacationPct + holidayPct) / 100);
  const costPerPaidHour = zero ? 0 : loaded * (1 + statutoryPct / 100) + benefitsCentsPerHour;
  return {
    wageCents, annualHours, vacationPct, holidayPct,
    cppPct: cppPct == null ? null : round4(cppPct), eiPct: eiPct == null ? null : round4(eiPct),
    wcbPct: round4(wcbPct), levyPct, benefitsCentsPerHour, statutoryPct: round4(statutoryPct), nonProductivePct,
    costPerPaidHourCents: Math.round(costPerPaidHour),
    costPerProductiveHourCents: Math.round(costPerPaidHour / (1 - nonProductivePct / 100)),
    earningsCents: Math.round(earningsCents), fallbackUsed, warnings,
  };
}

/** The burden for many (employee, day) pairs without resolving the rules each time. */
export function burdenCache({ rules = null, settings = null } = {}) {
  const resolvedByDay = new Map();
  const out = new Map();
  const province = String(settings?.company?.province || '').toUpperCase() || null;
  return (employee, day) => {
    const d = String(day || '').slice(0, 10) || `${new Date().getFullYear()}-07-01`;
    const k = `${employee?.id || ''}|${d}`;
    if (out.has(k)) return out.get(k);
    if (!resolvedByDay.has(d)) resolvedByDay.set(d, rulesFor(rules, { province, on: d }));
    const b = burdenRate(employee, { rules: resolvedByDay.get(d), settings, on: d });
    out.set(k, b);
    return b;
  };
}

/** "4%" style text for the Rates screen. */
export const pctText = (p) => (p == null ? '—' : `${round2(p)}%`);
