// Prompt payment basics (docs/releases/r1-get-paid.md 7.2, 7.5; docs/office/prompt-payment.md).
// Manitoba's prompt payment rules (The Builders' Liens Amendment Act, in force 2025-04-01) apply to
// prime contracts signed on or after the in-force date: the owner gives a notice of non-payment within
// 14 days of a proper invoice or pays it within 28 days; a contractor pays its subcontractor within 7
// days of being paid. Every day count comes from the rules table (lib/rules.js): a value with status
// 'verify' never drives a date or an alarm. Counts are calendar days. While the weekend rule is
// unconfirmed (pp.MB.dayRollover), a date on a Saturday or Sunday is shown as "may move to Monday".
// Holidays are not known here: a holiday date shows no "may move" note.
// Pure: the PWA (invoice screen) and the daily job (services/receivables.js) share it.
import { ruleValue, ruleUnconfirmed } from './rules.js';
import { invoiceKind } from './money.js';
import { balanceCents, openDisputesCents, plusDays } from './receivables.js';

const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * The rules as a Map key -> resolved row (lib/rules.js resolveRules shape). Takes the Map itself, the
 * rows of GET /api/v1/rules/effective (store meta 'rules' keeps { rules: [...] }), or a plain
 * { key: { value, status } } object.
 */
export function rulesMap(rules) {
  if (rules instanceof Map) return rules;
  const rows = Array.isArray(rules) ? rules : Array.isArray(rules?.rules) ? rules.rules : null;
  if (rows) return new Map(rows.filter((r) => r?.key).map((r) => [r.key, r]));
  if (rules && typeof rules === 'object') return new Map(Object.entries(rules).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v : { value: v, status: 'verified' }]));
  return new Map();
}

const KEYS = { prime: ['pp.MB.inForceFrom', 'pp.MB.paymentDays', 'pp.MB.nonPaymentNoticeDays'], sub: ['pp.MB.inForceFrom', 'pp.MB.subPaymentDays'] };

/** Day of the week of a date (0 Sunday ... 6 Saturday). */
export const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
/** A day on a weekend (holidays are not known here). */
export const onWeekend = (d) => isDay(d) && [0, 6].includes(weekday(d));

/** "Sat 2026-11-14 (may move to Mon)" while the rollover rule is unconfirmed. */
export function fmtDue(d, mayMove = false) {
  if (!isDay(d)) return '';
  const name = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday(d)];
  return mayMove ? `${name} ${d} (may move to Mon)` : `${name} ${d}`;
}

/**
 * Do the prompt payment rules apply to this invoice? Manitoba (the invoice's taxProvince, else the
 * company's), the governing contract date (prime: contract.signedOn; sub: contract.primeSignedOn) on
 * or after pp.MB.inForceFrom, a proper invoice (invoice.properInvoice or the job's
 * properInvoiceRequired), and every rule it uses usable (never on 'verify').
 * @returns {{ applies: boolean, role: 'prime'|'sub'|null, why: string, checkApplies: boolean, unconfirmed: boolean, missing: string|null }}
 */
export function promptPaymentApplies(job, invoice, rules, { companyProvince = null } = {}) {
  const r = rulesMap(rules);
  const role = job?.contract?.role === 'prime' || job?.contract?.role === 'sub' ? job.contract.role : null;
  const out = (applies, why, missing = null) => ({
    applies, role, why, missing,
    checkApplies: applies && ruleUnconfirmed(r, 'pp.MB.appliesTo'),
    unconfirmed: applies && (KEYS[role] || []).some((k) => ruleUnconfirmed(r, k)),
  });
  if (!invoice || ['credit', 'interest', 'deposit'].includes(invoiceKind(invoice))) return out(false, 'Prompt payment dates are for progress and final invoices.');
  const province = invoice.taxProvince || companyProvince;
  if (province !== 'MB') return out(false, 'Not a Manitoba contract: no prompt payment dates.');
  if (!role) return out(false, 'Say on the job whether this is a prime contract or a subcontract.', 'role');
  const signed = role === 'prime' ? job.contract.signedOn : job.contract.primeSignedOn;
  if (!isDay(signed)) return out(false, role === 'prime' ? 'Add the day the contract was signed on the job.' : 'Add the day the prime contract (owner and general contractor) was signed on the job.', role === 'prime' ? 'signedOn' : 'primeSignedOn');
  const from = ruleValue(r, 'pp.MB.inForceFrom');
  if (!isDay(from)) return out(false, 'The rules table has no confirmed start date for prompt payment yet.');
  if (signed < from) return out(false, `Contract signed before ${from}: the prompt payment rules do not apply.`);
  if (!(invoice.properInvoice || job.contract.properInvoiceRequired)) return out(false, 'Not marked as a proper invoice.', 'properInvoice');
  if ((KEYS[role] || []).some((k) => ruleValue(r, k) == null)) return out(false, 'A day count in the rules table is unconfirmed, so no dates are worked out.');
  return out(true, role === 'prime' ? 'Prime contract: day 14 and day 28 apply.' : 'Subcontract: the general contractor pays within 7 days of being paid.');
}

/**
 * The prompt payment dates of an invoice. deliveredOn = promptPayment.deliveredOn, else the day
 * Fishtape emailed it (opts.emailedOn). Prime: notice due = delivered + nonPaymentNoticeDays, payment
 * due = delivered + paymentDays. Sub: no day 14 or 28; with gcPaidOn the general contractor pays by
 * gcPaidOn + subPaymentDays, else an information date (delivered + paymentDays + subPaymentDays).
 * mayMove: per date, true when it falls on a weekend while pp.MB.dayRollover is unconfirmed.
 */
export function promptPaymentDates(invoice, job, rules, { companyProvince = null, emailedOn = null } = {}) {
  const r = rulesMap(rules);
  const a = promptPaymentApplies(job, invoice, r, { companyProvince });
  const pp = invoice?.promptPayment || {};
  const deliveredOn = isDay(pp.deliveredOn) ? pp.deliveredOn : isDay(emailedOn) ? emailedOn : null;
  const res = { role: a.role, applies: a.applies, why: a.why, deliveredOn, noticeDueOn: null, paymentDueOn: null, gcDueOn: null, expectedLatestOn: null, mayMove: {} };
  if (!a.applies) return res;
  const n = (k) => Number(ruleValue(r, k));
  if (a.role === 'prime' && deliveredOn) {
    res.noticeDueOn = plusDays(deliveredOn, n('pp.MB.nonPaymentNoticeDays'));
    res.paymentDueOn = plusDays(deliveredOn, n('pp.MB.paymentDays'));
  }
  if (a.role === 'sub') {
    if (isDay(pp.gcPaidOn)) res.gcDueOn = plusDays(pp.gcPaidOn, n('pp.MB.subPaymentDays'));
    const pay = ruleValue(r, 'pp.MB.paymentDays');
    if (deliveredOn && pay != null) res.expectedLatestOn = plusDays(deliveredOn, Number(pay) + n('pp.MB.subPaymentDays'));
  }
  const rollover = ruleValue(r, 'pp.MB.dayRollover');
  const unsure = rollover == null || ruleUnconfirmed(r, 'pp.MB.dayRollover');
  for (const k of ['noticeDueOn', 'paymentDueOn', 'gcDueOn', 'expectedLatestOn']) res.mayMove[k] = Boolean(res[k]) && unsure && onWeekend(res[k]);
  return res;
}

/**
 * The alarms due on asOf (the daily job notifies each once, ref pp:<invoiceId>:<step>):
 *  - day14 (prime): the day after notice due, when no notice of non-payment is recorded;
 *  - day28 (prime): the day after payment due, with an undisputed balance;
 *  - gc7 (sub): the day after the general contractor's days, with a balance.
 * @returns {{ invoiceId, step: 'day14'|'day28'|'gc7', title, ref }[]}
 */
export function promptPaymentAlarms(invoices = [], jobs = [], payments = [], rules, asOf, { companyProvince = null, emailedOn = {} } = {}) {
  const r = rulesMap(rules);
  const jobById = new Map(jobs.filter(Boolean).map((j) => [j.id, j]));
  const out = [];
  for (const inv of invoices) {
    if (!inv || ['draft', 'void'].includes(inv.status)) continue;
    const job = jobById.get(inv.jobId);
    if (!job) continue;
    const d = promptPaymentDates(inv, job, r, { companyProvince, emailedOn: emailedOn[inv.id] || null });
    if (!d.applies) continue;
    const bal = balanceCents(inv, payments);
    const undisputed = bal - openDisputesCents(inv);
    const label = inv.number || 'An invoice';
    const push = (step, title) => out.push({ invoiceId: inv.id, step, title, ref: `pp:${inv.id}:${step}` });
    if (d.role === 'prime') {
      if (d.noticeDueOn && asOf > d.noticeDueOn && !inv.promptPayment?.nonPaymentNotice?.receivedOn && bal > 0) {
        push('day14', `No notice of non-payment on ${label} by day 14: the full amount is due by ${d.paymentDueOn}.`);
      }
      if (d.paymentDueOn && asOf > d.paymentDueOn && undisputed > 0) push('day28', `${label} is past its prompt-payment date.`);
    } else if (d.role === 'sub' && d.gcDueOn && asOf > d.gcDueOn && bal > 0) {
      push('gc7', `${label}: the general contractor was paid on ${inv.promptPayment.gcPaidOn} and should have paid you by ${d.gcDueOn}.`);
    }
  }
  return out;
}

/** The note every screen with these dates shows while a rule used is only sourced. */
export const PP_DISCLAIMER = 'Based on published guidance, not legal advice. Confirm deadlines with your lawyer.';
export const PP_CHECK_APPLIES = 'Check that the Act applies to this contract (residential and value exclusions).';
