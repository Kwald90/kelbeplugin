// Receivables (docs/releases/r1-get-paid.md 4.3 to 4.7, 7.3): deposits, holdback, statements,
// overdue interest, reminder steps, the past-due hold, receipts across invoices, the ready-to-bill
// queue and the two collection KPIs. Pure: every function takes plain arrays of records, so the PWA
// (from the store) and the server (services/receivables.js, from one tenant transaction) give the
// same answers. Integer cents; days are 'YYYY-MM-DD' strings.
//
// Words used here:
//  - balance: what is still owed on an invoice (total less every payment against it, credit-note
//    applications and on-account applications included). A credit note's balance is its unapplied
//    part (negative while open), money.js creditNoteBalance.
//  - undisputed balance: balance less the invoice's open disputes (4.4). Reminders, interest and the
//    past-due hold run on it.
//  - collectible: the undisputed balance less holdback the customer kept on its own
//    (holdback.retainedByCustomerCents, 7.3): that amount is out of aging, reminders, interest and
//    the hold, and stays owed on the invoice.
import { docTotals, invoiceKind, creditNoteBalance, revenueCents, lineCents } from './money.js';
import { jobBillingMode, unbilledTm } from './tm.js';

const DAY_MS = 86400000;
const dayNum = (d) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS);
const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d);
const day = (d) => (isDay(d) ? d.slice(0, 10) : null);
/** Whole days from a to b (b later: positive). */
export function daysBetween(a, b) {
  if (!isDay(a) || !isDay(b)) return null;
  return dayNum(b.slice(0, 10)) - dayNum(a.slice(0, 10));
}
/** YYYY-MM-DD plus n days. */
export function plusDays(d, n) {
  const x = new Date((dayNum(d) + n) * DAY_MS);
  return x.toISOString().slice(0, 10);
}
const sum = (xs, f) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const live = (inv) => inv && inv.status !== 'void' && inv.status !== 'draft';
const isCredit = (inv) => invoiceKind(inv) === 'credit';

// ---- balances --------------------------------------------------------------------------------

/** Every payment against an invoice (cash, credit-note and on-account applications, refunds). */
export function paidCents(inv, payments = [], { asOf = null } = {}) {
  return sum(payments.filter((p) => p?.invoiceId === inv?.id && (!asOf || !p.date || p.date <= asOf)), (p) => p.amountCents);
}

/** What is still owed on an invoice; a credit note's unapplied part (negative while open). */
export function balanceCents(inv, payments = [], { asOf = null } = {}) {
  if (!inv || inv.status === 'void') return 0;
  if (isCredit(inv)) return creditNoteBalance(inv, payments.filter((p) => !asOf || !p.date || p.date <= asOf));
  return docTotals(inv).totalCents - paidCents(inv, payments, { asOf });
}

/** Open disputes on an invoice, in cents. */
export const openDisputesCents = (inv) => sum((inv?.disputes || []).filter((d) => d && (d.status || 'open') === 'open'), (d) => d.cents);

/** Holdback the customer kept on its own (7.3): still owed on the invoice, out of aging. */
export const retainedByCustomerCents = (inv) => Math.max(0, Number(inv?.holdback?.retainedByCustomerCents) || 0);

/** Balance less open disputes (4.4). */
export function undisputedBalance(invoice, payments = [], opts = {}) {
  return balanceCents(invoice, payments, opts) - openDisputesCents(invoice);
}

/** What collections chase: the undisputed balance less holdback the customer kept, never below 0. */
export function collectibleCents(invoice, payments = [], opts = {}) {
  if (!live(invoice) || isCredit(invoice)) return 0;
  return Math.max(0, undisputedBalance(invoice, payments, opts) - retainedByCustomerCents(invoice));
}

/** The client a payment belongs to: its own clientId, else its invoice's. */
export function paymentClientId(p, invoicesById) {
  return p?.clientId || (p?.invoiceId ? invoicesById.get(p.invoiceId)?.clientId : null) || null;
}

const byId = (list) => new Map((list || []).filter(Boolean).map((x) => [x.id, x]));

// ---- receipts and on-account credit (4.4) ---------------------------------------------------

/** What is left of an on-account payment (invoiceId null) after the "Apply credit" payments against it. */
export function onAccountBalance(payment, payments = []) {
  if (!payment || payment.invoiceId || payment.reversesId || payment.method === 'refund' || payment.method === 'credit-note') return 0;
  return (Number(payment.amountCents) || 0) - sum(payments.filter((p) => p?.appliedFromId === payment.id), (p) => p.amountCents);
}

/** A client's on-account credits with something left: [{ paymentId, date, reference, availableCents }]. */
export function onAccountCredits(clientId, payments = []) {
  return payments.filter((p) => p && !p.invoiceId && p.clientId === clientId && (Number(p.amountCents) || 0) > 0)
    .map((p) => ({ paymentId: p.id, date: p.date || null, reference: p.reference || '', availableCents: onAccountBalance(p, payments) }))
    .filter((x) => x.availableCents > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Split one cheque, EFT or deposit across a client's open invoices, oldest due date first, each up
 * to what is collectible on it (disputed amounts and holdback the customer kept are not expected).
 * Anything left goes on account. The office edits the split before saving.
 * @returns {{ allocations: { invoiceId: string, number: string, amountCents: number, collectibleCents: number }[], onAccountCents: number }}
 */
export function allocateReceipt(amountCents, invoices = [], payments = [], { clientId } = {}) {
  let left = Math.max(0, Math.round(Number(amountCents) || 0));
  const open = invoices.filter((i) => live(i) && !isCredit(i) && (!clientId || i.clientId === clientId))
    .map((i) => ({ inv: i, c: collectibleCents(i, payments) }))
    .filter((x) => x.c > 0)
    .sort((a, b) => String(a.inv.dueDate || a.inv.issueDate || '').localeCompare(String(b.inv.dueDate || b.inv.issueDate || '')) || String(a.inv.number || '').localeCompare(String(b.inv.number || '')));
  const allocations = [];
  for (const { inv, c } of open) {
    const take = Math.min(left, c);
    allocations.push({ invoiceId: inv.id, number: inv.number || '', amountCents: take, collectibleCents: c });
    left -= take;
  }
  return { allocations, onAccountCents: left };
}

// ---- deposits (4.3) -------------------------------------------------------------------------

/**
 * Paid deposit invoices that can still be applied, for a job (and the client's deposits with no
 * job). Amounts are in the deposit line's terms: before tax for a prepayment (the application line
 * is taxed like the deposit was), the whole amount for a security deposit. Only paid money counts;
 * refunds lower it; a forfeited deposit has nothing left to apply.
 * @returns {{ invoiceId, number, model, jobId, paidCents, appliedCents, availableCents, forfeited }[]}
 */
export function depositsAvailable(invoices = [], payments = [], { jobId = null, clientId = null } = {}) {
  const deps = invoices.filter((i) => live(i) && invoiceKind(i) === 'deposit'
    && ((jobId && i.jobId === jobId) || (clientId && i.clientId === clientId && !i.jobId) || (!jobId && clientId && i.clientId === clientId)));
  return deps.map((d) => {
    const t = docTotals(d);
    // Cash in less refunds; a credit note applied to the deposit (a refund's first half) is not cash.
    const cash = sum(payments.filter((p) => p?.invoiceId === d.id && p.method !== 'credit-note'), (p) => p.amountCents);
    const paidBase = t.totalCents > 0 ? Math.round(t.depositCents * Math.min(1, Math.max(0, cash) / t.totalCents)) : 0;
    const appliedCents = sum(invoices.filter((i) => i && i.id !== d.id && i.status !== 'void'),
      (i) => sum((i.lines || []).filter((l) => l?.lineType === 'deposit' && l.depositInvoiceId === d.id), (l) => -lineCents(l)));
    const forfeited = Boolean(d.forfeitedOn);
    return {
      invoiceId: d.id, number: d.number || '', model: d.depositModel === 'security' ? 'security' : 'prepayment', jobId: d.jobId || null,
      paidCents: cash, appliedCents, availableCents: forfeited ? 0 : Math.max(0, paidBase - appliedCents), forfeited,
    };
  });
}

// ---- holdback (7.3) -------------------------------------------------------------------------

/**
 * Holdback on a job's invoices: what the invoices held back (retained), what the customer kept on
 * its own from invoices without a holdback, what release invoices billed, and what is still to be
 * released by a release invoice (outstanding = retained - released; holdback the customer kept is
 * owed on its original invoice and is never released by invoice).
 */
export function holdbackLedger(invoices = [], { jobId = null, clientId = null } = {}) {
  const mine = invoices.filter((i) => live(i) && ((jobId && i.jobId === jobId) || (!jobId && clientId && i.clientId === clientId)));
  const byInvoice = [];
  let retainedCents = 0, retainedByCustomer = 0, releasedCents = 0;
  for (const i of mine) {
    const kind = invoiceKind(i);
    if (kind === 'holdback-release') { releasedCents += docTotals(i).holdbackLineCents; continue; }
    if (!['standard', 'progress', 'credit'].includes(kind)) continue;
    const held = docTotals(i).holdbackCents;
    const kept = retainedByCustomerCents(i);
    if (!held && !kept) continue;
    retainedCents += held; retainedByCustomer += kept;
    byInvoice.push({ invoiceId: i.id, number: i.number || '', issueDate: i.issueDate || null, retainedCents: held, retainedByCustomerCents: kept });
  }
  return { retainedCents, retainedByCustomerCents: retainedByCustomer, releasedCents, outstandingCents: retainedCents - releasedCents, byInvoice };
}

// ---- statements (4.5) -----------------------------------------------------------------------

/**
 * A client's statement for from..to (as of asOf, default `to`): opening balance, every invoice,
 * credit note, payment and refund in the period with a running balance, aging of what is
 * collectible, and on their own lines holdback the customer kept, disputed amounts, unapplied
 * on-account money, unapplied credit notes and unapplied deposits.
 * Credit-note applications and "Apply credit" payments move money between a client's own
 * documents, so they are not rows.
 */
export function statement(clientId, { from, to, invoices = [], payments = [], asOf = null } = {}) {
  const at = asOf || to;
  const mine = invoices.filter((i) => i?.clientId === clientId && live(i) && (!at || !i.issueDate || i.issueDate <= at));
  const invById = byId(invoices);
  const entries = [];
  for (const i of mine) {
    const total = docTotals(i).totalCents;
    if (isCredit(i)) entries.push({ date: i.issueDate || null, type: 'credit-note', number: i.number || '', id: i.id, chargeCents: 0, creditCents: -total });
    else entries.push({ date: i.issueDate || null, type: 'invoice', number: i.number || '', id: i.id, chargeCents: total, creditCents: 0, dueDate: i.dueDate || null });
  }
  for (const p of payments) {
    if (!p || p.method === 'credit-note' || p.appliedFromId) continue;
    if (paymentClientId(p, invById) !== clientId) continue;
    if (p.invoiceId && !live(invById.get(p.invoiceId))) continue;
    if (at && p.date && p.date > at) continue;
    const amt = Number(p.amountCents) || 0;
    const number = p.reference || (p.invoiceId ? invById.get(p.invoiceId)?.number : 'On account') || '';
    if (amt >= 0) entries.push({ date: p.date || null, type: p.invoiceId ? 'payment' : 'on-account', number, id: p.id, chargeCents: 0, creditCents: amt });
    else entries.push({ date: p.date || null, type: p.method === 'refund' ? 'refund' : 'reversal', number, id: p.id, chargeCents: -amt, creditCents: 0 });
  }
  entries.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.type === 'invoice' ? -1 : 1));
  let openingCents = 0;
  const rows = [];
  let running = 0;
  for (const e of entries) {
    const net = e.chargeCents - e.creditCents;
    if (from && e.date && e.date < from) { openingCents += net; continue; }
    if (to && e.date && e.date > to) continue;
    rows.push(e);
  }
  running = openingCents;
  for (const r of rows) { running += r.chargeCents - r.creditCents; r.balanceCents = running; }
  const aging = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
  let disputedCents = 0, holdbackRetainedCents = 0, creditsCents = 0;
  for (const i of mine) {
    if (isCredit(i)) { creditsCents += Math.max(0, -balanceCents(i, payments, { asOf: at })); continue; }
    const bal = balanceCents(i, payments, { asOf: at });
    if (bal <= 0) continue;
    const disputed = Math.min(bal, Math.max(0, openDisputesCents(i)));
    const kept = Math.min(bal - disputed, retainedByCustomerCents(i));
    disputedCents += disputed; holdbackRetainedCents += kept;
    const c = bal - disputed - kept;
    if (c <= 0) continue;
    const late = i.dueDate && at ? daysBetween(i.dueDate, at) : 0;
    if (late <= 0) aging.current += c;
    else if (late <= 30) aging.d30 += c;
    else if (late <= 60) aging.d60 += c;
    else if (late <= 90) aging.d90 += c;
    else aging.d90p += c;
  }
  const onAccountCents = sum(payments.filter((p) => p && !p.invoiceId && p.clientId === clientId && (!at || !p.date || p.date <= at)), (p) => Math.max(0, onAccountBalance(p, payments)));
  const depositsUnappliedCents = sum(depositsAvailable(invoices, payments, { clientId }), (d) => d.availableCents);
  const held = holdbackLedger(invoices, { clientId });
  return {
    clientId, from: from || null, to: to || null, asOf: at || null,
    openingCents, rows, closingCents: running, aging,
    holdbackRetainedCents, holdbackUnbilledCents: held.outstandingCents, disputedCents, onAccountCents, creditsCents, depositsUnappliedCents,
  };
}

// ---- interest (4.5) ---------------------------------------------------------------------------

/** The terms sentence the invoice snapshots (Interest Act s.4: always with the annual rate). */
export function interestTermsText(interest = {}) {
  const annual = Number(interest?.annualPct);
  if (!interest?.enabled || !(annual > 0)) return '';
  const monthly = Math.round((annual / 12) * 1000) / 1000;
  const grace = Number(interest.graceDays) || 0;
  return grace
    ? `Overdue accounts are charged ${monthly}% per month (${annual}% per year) from the end of the grace period, ${grace} days after the due date.`
    : `Overdue accounts are charged ${monthly}% per month (${annual}% per year) from the due date.`;
}

/** Does this invoice's terms snapshot disclose the interest sentence the settings give? */
export const interestDisclosedIn = (termsText, interest) => {
  const s = interestTermsText(interest);
  return Boolean(s) && String(termsText || '').includes(s);
};

/**
 * Simple interest on the undisputed balance (less holdback the customer kept), per day, from the
 * end of grace (due date + graceDays) or `from` (the day after a period already charged) to asOf.
 * Zero unless the invoice was issued with the interest disclosed; never on interest invoices,
 * credit notes or deposits; a release invoice only from its own due date like any other.
 */
export function interestDue(invoice, payments = [], { annualPct, graceDays = 0, asOf, from = null } = {}) {
  if (!live(invoice) || !invoice.interestDisclosed || !(Number(annualPct) > 0) || !isDay(asOf) || !isDay(invoice.dueDate)) return 0;
  if (['interest', 'credit', 'deposit'].includes(invoiceKind(invoice))) return 0;
  let start = plusDays(invoice.dueDate, (Number(graceDays) || 0) + 1);
  if (isDay(from) && from > start) start = from;
  if (start > asOf) return 0;
  const n = daysBetween(start, asOf) + 1;
  let centDays = 0;
  for (let k = 0; k < n && k < 3660; k++) {
    const d = plusDays(start, k);
    const c = Math.max(0, balanceCents(invoice, payments, { asOf: d }) - openDisputesCents(invoice) - retainedByCustomerCents(invoice));
    centDays += c;
  }
  return Math.round(centDays * (Number(annualPct) / 100) / 365);
}

/**
 * The interest to charge a client now: per invoice, from the end of grace (or the day after the
 * last period an interest invoice already charged) to asOf. [{ invoiceId, number, from, to, cents }]
 */
export function interestCharges(invoices = [], payments = [], { clientId, annualPct, graceDays = 0, asOf } = {}) {
  const charged = new Map();
  for (const i of invoices) {
    if (!i || i.status === 'void' || invoiceKind(i) !== 'interest') continue;
    for (const f of i.interestFor || []) if (f?.invoiceId && isDay(f.to) && (!charged.has(f.invoiceId) || f.to > charged.get(f.invoiceId))) charged.set(f.invoiceId, f.to);
  }
  const out = [];
  for (const inv of invoices) {
    if (!live(inv) || (clientId && inv.clientId !== clientId)) continue;
    const last = charged.get(inv.id);
    const from = last ? plusDays(last, 1) : null;
    const cents = interestDue(inv, payments, { annualPct, graceDays, asOf, from });
    if (cents <= 0) continue;
    const start = from || plusDays(inv.dueDate, (Number(graceDays) || 0) + 1);
    out.push({ invoiceId: inv.id, number: inv.number || '', from: start, to: asOf, cents });
  }
  return out;
}

/** An interest invoice for some charges: kind 'interest', interest lines, exempt (VERIFY), interestFor. */
export function interestInvoice(clientId, charges, { today, dueDays = 0 } = {}) {
  return {
    kind: 'interest', status: 'draft', clientId, jobId: null, title: 'Interest on overdue invoices', issueDate: today, dueDate: dueDays ? plusDays(today, dueDays) : today,
    taxTreatment: 'none', taxNoneReason: 'exempt', taxes: [], taxPct: 0,
    lines: charges.map((c) => ({ itemId: null, kind: 'other', lineType: 'interest', description: `Interest on ${c.number} from ${c.from} to ${c.to}`, qty: 1, unitCents: c.cents, labourHours: 0 })),
    interestFor: charges.map((c) => ({ invoiceId: c.invoiceId, from: c.from, to: c.to, cents: c.cents })), notes: '',
  };
}

// ---- reminders (4.5) -----------------------------------------------------------------------

/** The presets the collections screen offers (question 6). */
export const REMINDER_PRESETS = [
  { key: 'r1', dayOffset: -3, channel: 'email', subject: 'Invoice {number} is due in 3 days', body: 'Hi {client},\n\nA reminder that invoice {number} for {balance} is due on {dueDate}.\n{payLink}\n\nThank you,\n{company}', active: true },
  { key: 'r2', dayOffset: 1, channel: 'email', subject: 'Invoice {number} is now due', body: 'Hi {client},\n\nInvoice {number} was due on {dueDate}. {balance} is still open.\n{payLink}\n\nThank you,\n{company}', active: true },
  { key: 'r3', dayOffset: 15, channel: 'email', subject: 'Invoice {number} is 15 days overdue', body: 'Hi {client},\n\nInvoice {number} is 15 days past due. Please pay {balance} or call us if something is wrong with it.\n{payLink}\n\n{company}', active: true },
  { key: 'r4', dayOffset: 30, channel: 'email', subject: 'Invoice {number} is 30 days overdue', body: 'Hi {client},\n\nInvoice {number} is 30 days past due with {balance} open. Please call us this week.\n{payLink}\n\n{company}', active: true },
];

/** Placeholders filled: {client}, {number}, {balance}, {dueDate}, {payLink}, {company}. */
export function reminderText(step, { client, invoice, balanceCents, company, payLink = '', money = (c) => `$${(c / 100).toFixed(2)}` } = {}) {
  const vals = {
    client: String(client?.name || '').split(/\s+/)[0] || 'there', number: invoice?.number || '', balance: money(balanceCents || 0),
    dueDate: invoice?.dueDate || '', payLink: payLink ? `Pay online: ${payLink}` : '', company: company?.name || '',
  };
  const fill = (s) => String(s || '').replace(/\{(client|number|balance|dueDate|payLink|company)\}/g, (_, k) => vals[k]).replace(/\n{3,}/g, '\n\n').trim();
  const preset = REMINDER_PRESETS.find((p) => p.key === step?.key) || REMINDER_PRESETS[1];
  return { subject: fill(step?.subject || preset.subject).slice(0, 300), body: fill(step?.body || preset.body) };
}

/** The address a reminder goes to: statement email, else email, else a text to the phone. */
export function reminderContact(client, channel = 'email') {
  const email = String(client?.credit?.statementEmail || client?.email || '').trim();
  const phone = String(client?.phone || '').trim();
  if (channel === 'sms') return phone ? { channel: 'sms', to: phone } : email ? { channel: 'email', to: email } : null;
  return email ? { channel: 'email', to: email } : phone ? { channel: 'sms', to: phone } : null;
}

/**
 * The reminders to queue today: for each open invoice, the latest active step whose day has come
 * (dayOffset days after the due date; negative = before), once (the outbox id rem-<invoiceId>-<step>
 * is deterministic, so a second run never doubles). The amount is the collectible balance.
 * Skipped: draft, void, paid, credit and interest invoices, release invoices before their due
 * date, nothing collectible, a recorded notice of non-payment covering the whole balance,
 * reminders paused for the client, no contact.
 * @returns {{ id, invoiceId, clientId, stepKey, channel, to, amountCents, step }[]}
 */
export function reminderPlan(invoices = [], payments = [], clients = [], settings = {}, asOf) {
  const steps = (settings?.collections?.reminders || []).filter((s) => s && s.active !== false && s.key && Number.isFinite(Number(s.dayOffset)))
    .sort((a, b) => Number(a.dayOffset) - Number(b.dayOffset));
  if (!steps.length || !isDay(asOf)) return [];
  const clientById = byId(clients);
  const out = [];
  for (const inv of invoices) {
    if (!live(inv) || !isDay(inv.dueDate)) continue;
    const kind = invoiceKind(inv);
    if (kind === 'credit' || kind === 'interest') continue;
    if (kind === 'holdback-release' && asOf < inv.dueDate) continue;
    const amount = collectibleCents(inv, payments);
    if (amount <= 0) continue;
    const bal = balanceCents(inv, payments);
    const npn = inv.promptPayment?.nonPaymentNotice;
    if (npn?.receivedOn && (Number(npn.disputedCents) || 0) >= bal) continue;
    const client = clientById.get(inv.clientId);
    if (!client || client.credit?.remindersPaused) continue;
    const late = daysBetween(inv.dueDate, asOf);
    const reached = steps.filter((s) => Number(s.dayOffset) <= late);
    const step = reached[reached.length - 1];
    if (!step) continue;
    const contact = reminderContact(client, step.channel);
    if (!contact) continue;
    out.push({ id: `rem-${inv.id}-${step.key}`.slice(0, 128), invoiceId: inv.id, clientId: client.id, stepKey: step.key, channel: contact.channel, to: contact.to, amountCents: amount, step });
  }
  return out;
}

// ---- credit hold (4.5, 4.6) ---------------------------------------------------------------

/**
 * What the client could owe: open AR (disputes included), holdback retained on its jobs not yet
 * released, and unbilled T&M at sell (tm.js unbilledTm, passed in as cents).
 */
export function creditExposure(client, { invoices = [], payments = [], unbilledTmCents = 0 } = {}) {
  const mine = invoices.filter((i) => i?.clientId === client?.id && live(i));
  const ar = sum(mine.filter((i) => !isCredit(i)), (i) => Math.max(0, balanceCents(i, payments)));
  const held = holdbackLedger(invoices, { clientId: client?.id }).outstandingCents;
  return ar + Math.max(0, held) + Math.max(0, Number(unbilledTmCents) || 0);
}

/**
 * The past-due hold (4.5): on when something collectible is more than holdAfterDays past due, or
 * (holdOverLimit) exposure is over the credit limit. The office's override wins until its date.
 * @returns {{ on: boolean, reason: 'past_due'|'over_limit'|null, overdueDays: number, auto: boolean, override: string|null }}
 */
export function creditHold(client, invoices = [], payments = [], settings = {}, asOf, { exposureCents = null } = {}) {
  const c = settings?.collections || {};
  const after = Number.isFinite(Number(c.holdAfterDays)) && c.holdAfterDays !== null ? Number(c.holdAfterDays) : 60;
  let overdueDays = 0;
  for (const i of invoices) {
    if (i?.clientId !== client?.id || !live(i) || isCredit(i) || !isDay(i.dueDate)) continue;
    if (collectibleCents(i, payments) <= 0) continue;
    overdueDays = Math.max(overdueDays, daysBetween(i.dueDate, asOf) || 0);
  }
  let on = false, reason = null;
  if (overdueDays > after) { on = true; reason = 'past_due'; }
  const limit = client?.credit?.limitCents;
  if (!on && c.holdOverLimit !== false && Number.isInteger(limit)) {
    const exp = exposureCents ?? creditExposure(client, { invoices, payments });
    if (exp > limit) { on = true; reason = 'over_limit'; }
  }
  const auto = on;
  const o = client?.credit?.holdOverride;
  if (o && ['hold', 'release'].includes(o.mode) && (!o.until || o.until >= asOf)) {
    return { on: o.mode === 'hold', reason: o.mode === 'hold' ? (reason || 'past_due') : null, overdueDays, auto, override: o.mode };
  }
  return { on, reason, overdueDays, auto, override: null };
}

// ---- ready to bill and the KPIs (4.7) ---------------------------------------------------------

const ticketTime = (t) => day(t?.signedAt) || day(t?.refusal?.at) || day(t?.date) || null;

/** Is this ticket on a live invoice (or marked billed)? */
export function ticketBilled(t, invoices = []) {
  if (t?.status === 'billed') return true;
  if (t?.invoiceId && invoices.some((i) => i?.id === t.invoiceId && i.status !== 'void')) return true;
  return invoices.some((i) => i && i.status !== 'void' && (i.ticketIds || []).includes(t?.id));
}

/** Approved change orders on a job that no live invoice line bills. */
export function unbilledChangeOrders(job, invoices = []) {
  const billed = new Set(invoices.filter((i) => i && i.status !== 'void' && i.jobId === job?.id).flatMap((i) => (i.lines || []).map((l) => l?.changeOrderId).filter(Boolean)));
  return (job?.changeOrders || []).filter((c) => c && c.status === 'approved' && !billed.has(c.id));
}

/** Proper invoices with no delivery date recorded ("When and how was this delivered?"). */
export function needsDelivery(inv, job) {
  return live(inv) && !isCredit(inv) && (inv.properInvoice || job?.contract?.properInvoiceRequired) && !inv.promptPayment?.deliveredOn;
}

/**
 * The ready-to-bill queue: [{ key, kind, label, jobId, refId, since, ageDays, href }] oldest first.
 * kinds: ticket, change-order, tm, complete, holdback, delivery, dispute.
 * sources: { jobs, invoices, payments, fieldTickets, timeEntries, stockMoves, materialRequests, items, employees, settings, dayOf }
 */
export function readyToBill(sources = {}, { asOf } = {}) {
  const { jobs = [], invoices = [], fieldTickets = [], settings = {} } = sources;
  const jobById = byId(jobs);
  const out = [];
  const add = (row) => out.push({ ...row, ageDays: row.since ? Math.max(0, daysBetween(row.since, asOf) ?? 0) : 0 });
  for (const t of fieldTickets) {
    if (!t || !['signed', 'refused', 'priced'].includes(t.status)) continue;
    const job = jobById.get(t.jobId);
    if (!job) continue;
    const tm = jobBillingMode(job) === 'tm' || job.kind === 'service';
    if (ticketBilled(t, invoices)) continue;
    if (!tm && t.status === 'priced') continue; // priced into a change order: billed with it
    add({ key: `ticket:${t.id}`, kind: 'ticket', label: `${t.number || 'Ticket'} ${t.status === 'refused' ? '(refused) ' : ''}on ${job.number || ''}: ${tm ? 'bill it' : 'price it as a change order'}`, jobId: job.id, refId: t.id, since: ticketTime(t), href: `#/tickets/${t.id}` });
  }
  for (const job of jobs) {
    if (!job || ['cancelled', 'lead'].includes(job.status)) continue;
    for (const co of unbilledChangeOrders(job, invoices)) {
      add({ key: `co:${job.id}:${co.id}`, kind: 'change-order', label: `${job.number || ''} change order: ${co.title || ''}`, jobId: job.id, refId: co.id, since: day(co.approvedOn) || day(co.date), href: `#/jobs/${job.id}?tab=changes` });
    }
    if (jobBillingMode(job) === 'tm' && job.status !== 'invoiced' && sources.timeEntries) {
      const u = unbilledTm({ job, settings, timeEntries: sources.timeEntries || [], stockMoves: sources.stockMoves || [], materialRequests: sources.materialRequests || [], items: sources.items || [], employees: sources.employees || [], invoices, dayOf: sources.dayOf });
      if (u.labour.length || u.materials.length) add({ key: `tm:${job.id}`, kind: 'tm', label: `${job.number || ''}: time and material not billed (${Math.round((u.hours + u.travelHours) * 100) / 100} h, ${u.materials.length} material)`, jobId: job.id, refId: job.id, since: u.firstDay || null, href: `#/jobs/${job.id}` });
    }
    if (job.status === 'complete') add({ key: `complete:${job.id}`, kind: 'complete', label: `${job.number || ''} is complete and not invoiced`, jobId: job.id, refId: job.id, since: day(job.contract?.completedOn) || day(job.updatedAt), href: `#/jobs/${job.id}` });
    const rel = job.contract?.holdbackReleaseOn;
    if (isDay(rel) && rel <= asOf) {
      const led = holdbackLedger(invoices, { jobId: job.id });
      if (led.outstandingCents > 0) add({ key: `holdback:${job.id}`, kind: 'holdback', label: `${job.number || ''}: holdback release is due`, jobId: job.id, refId: job.id, since: rel, href: `#/jobs/${job.id}?tab=money` });
    }
  }
  for (const inv of invoices) {
    const job = jobById.get(inv?.jobId);
    if (needsDelivery(inv, job)) add({ key: `delivery:${inv.id}`, kind: 'delivery', label: `${inv.number}: when and how was this delivered?`, jobId: inv.jobId || null, refId: inv.id, since: day(inv.sentAt) || day(inv.issueDate), href: `#/invoices/${inv.id}` });
    if (!live(inv)) continue;
    for (const d of inv.disputes || []) {
      if ((d?.status || 'open') !== 'open') continue;
      add({ key: `dispute:${inv.id}:${d.id}`, kind: 'dispute', label: `${inv.number}: open dispute (${d.reason || 'no reason given'})`, jobId: inv.jobId || null, refId: inv.id, since: day(d.openedAt), href: `#/invoices/${inv.id}` });
    }
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || a.key.localeCompare(b.key));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};

/**
 * Invoice lag: the median days from a job's completion, or a ticket's signature, to the invoice
 * that billed it, for invoices issued in the last `days` days. { medianDays, count }.
 */
export function invoiceLagDays({ jobs = [], fieldTickets = [], invoices = [], asOf, days = 90 } = {}) {
  const since = plusDays(asOf, -days);
  const recent = invoices.filter((i) => live(i) && !['credit', 'interest', 'deposit'].includes(invoiceKind(i)) && isDay(i.issueDate) && i.issueDate > since && i.issueDate <= asOf);
  const lags = [];
  for (const job of jobs) {
    const done = day(job?.contract?.completedOn);
    if (!done) continue;
    const first = recent.filter((i) => i.jobId === job.id && i.issueDate >= done).sort((a, b) => a.issueDate.localeCompare(b.issueDate))[0];
    if (first) lags.push(daysBetween(done, first.issueDate));
  }
  for (const t of fieldTickets) {
    const signed = ticketTime(t);
    if (!signed || !['signed', 'refused', 'priced', 'billed'].includes(t?.status)) continue;
    const inv = recent.find((i) => i.id === t.invoiceId || (i.ticketIds || []).includes(t.id));
    if (inv && inv.issueDate >= signed) lags.push(daysBetween(signed, inv.issueDate));
  }
  return { medianDays: median(lags), count: lags.length };
}

/**
 * Days sales outstanding over the last `days` days: receivables at asOf / sales in the period x days.
 * Sales are invoices issued in the period (credit notes subtract); receivables are open balances.
 */
export function dso({ invoices = [], payments = [], asOf, days = 90 } = {}) {
  const since = plusDays(asOf, -days);
  const inPeriod = invoices.filter((i) => live(i) && isDay(i.issueDate) && i.issueDate > since && i.issueDate <= asOf);
  const salesCents = sum(inPeriod, (i) => docTotals(i).totalCents);
  const arCents = sum(invoices.filter((i) => live(i) && !isCredit(i) && isDay(i.issueDate) && i.issueDate <= asOf), (i) => Math.max(0, balanceCents(i, payments, { asOf })));
  return { days: salesCents > 0 ? Math.round((arCents / salesCents) * days * 10) / 10 : null, arCents, salesCents };
}

/**
 * The before-tax amount of one 'other' line that, taxed like `doc`, totals `cents` (a dispute or a
 * back-charge is agreed tax included). Each tax rounds on its own, so an exact match is not always
 * possible: the closest total wins, then the one that does not go over.
 */
export function baseForAmount(doc, cents) {
  const t = docTotals({ ...doc, holdback: null, markupPct: 0, lines: [{ kind: 'other', qty: 1, unitCents: 100000 }] });
  const ratio = t.totalCents ? 100000 / t.totalCents : 1;
  const b0 = Math.round(cents * ratio);
  let best = b0, bestDiff = Infinity;
  for (let d = -3; d <= 3; d++) {
    const b = b0 + d;
    const tot = docTotals({ ...doc, holdback: null, markupPct: 0, lines: [{ kind: 'other', qty: 1, unitCents: b }] }).totalCents;
    const diff = Math.abs(tot - cents) * 2 + (Math.abs(tot) > Math.abs(cents) ? 1 : 0);
    if (diff < bestDiff) { best = b; bestDiff = diff; }
  }
  return best;
}

/** Revenue billed to date on a job (money.js revenueCents; credit notes and back-charges negative). */
export const billedRevenueCents = (invoices = [], jobId) => sum(invoices.filter((i) => i?.jobId === jobId), (i) => revenueCents(i));
