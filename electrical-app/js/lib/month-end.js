// The month-end cutoff export (docs/releases/r1-get-paid.md 8.3, docs/office/month-end.md): what the
// accountant needs to close a month that the books themselves do not show. Pure, no DOM: the Month-end
// screen and the tests use it. Nothing here is pushed to QuickBooks; the journal is a suggestion the
// accountant enters (and reverses on the 1st).
//
//   accrued revenue   fixed-price jobs from WIP (under-billed and over-billed), T&M jobs from unbilled
//                     time and material at sell; approved change orders not billed are listed only
//                     (WIP's contract already includes them)
//   accrued cost      PO lines received and not billed, at the PO price
//   accrued payroll   hours worked on or before the cutoff that are in no exported payroll run, at the
//                     wage on the day plus burden; vacation and holiday pay only when the payroll modes
//                     accrue them (settings.payroll.vacationPayMode / holidayPayMode 'accrue')
//   balances          holdback receivable, deposits not applied, on-account credit, disputed amounts,
//                     self-assessed RST for the month, bad-debt credit notes
//   inventory         value by location as of the cutoff (lib/stock-counts.js)
import { docTotals, invoiceKind } from './money.js';
import { entryMinutes, isCorrection, localDay } from './timesheet.js';
import { jobBillingMode } from './tm.js';
import { wipReport, receivedNotBilled } from './costing.js';
import { burdenCache } from './burden.js';
import { rstSelfAssessment, ADD_TO_RETURN } from './rst.js';
import { valuationByLocation } from './stock-counts.js';
import { locksFrom } from './closing.js';

/** Journal account labels used when QuickBooks mappings don't name the accounts. */
export const ACCOUNTS = {
  underBilled: 'Costs and estimated earnings in excess of billings',
  overBilled: 'Billings in excess of costs and estimated earnings',
  revenue: 'Contract revenue',
  unbilledAr: 'Accounts receivable, unbilled',
  jobCost: 'Job cost',
  accruedLiabilities: 'Accrued liabilities',
  wages: 'Wages and burden',
  accruedPayroll: 'Accrued payroll',
  expense: 'Expense or job cost',
  rstPayable: 'RST payable',
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = (v) => String(v || '').slice(0, 10);
const r = Math.round;
const live = (i) => i && i.status !== 'void' && i.status !== 'draft';

/** The first day of the month holding `d`. */
export const monthStart = (d) => `${String(d).slice(0, 7)}-01`;

/**
 * The month-end cutoff as of `asOf` (YYYY-MM-DD). `accounts` overrides ACCOUNTS labels (QuickBooks
 * mapping names when connected). `dayOf` turns timestamps into the company's day.
 */
export function cutoff({
  asOf, jobs = [], estimates = [], invoices = [], payments = [], timeEntries = [], payrollRuns = [], stockMoves = [], materialRequests = [],
  bills = [], purchaseOrders = [], items = [], employees = [], equipment = [], equipmentUse = [], vendors = [], locations = [], fieldTickets = [],
  settings = null, rules = null, accounts = {}, dayOf = localDay, now = Date.now(),
} = {}) {
  const A = { ...ACCOUNTS, ...accounts };
  const sources = { estimates, invoices, timeEntries, stockMoves, materialRequests, bills, purchaseOrders, items, employees, equipment, equipmentUse, vendors, settings, rules, dayOf, now };
  const province = settings?.company?.province || 'MB';

  // ---- accrued revenue ----
  const wip = wipReport({ jobs, asOf, ...sources });
  const fixed = wip.rows.filter((x) => x.mode === 'fixed');
  const tm = wip.rows.filter((x) => x.mode === 'tm');
  const accruedRevenue = {
    wipUnderBilledCents: fixed.reduce((s, x) => s + x.underBilledCents, 0),
    wipOverBilledCents: fixed.reduce((s, x) => s + x.overBilledCents, 0),
    tmUnbilledCents: tm.reduce((s, x) => s + x.underBilledCents, 0),
    rows: wip.rows.filter((x) => x.underBilledCents || x.overBilledCents),
  };

  // Approved change orders with no invoice line pointing at them (information only).
  const billedCos = new Set(invoices.filter(live).flatMap((i) => (i.lines || []).map((l) => l?.changeOrderId).filter(Boolean)));
  const changeOrdersApprovedUnbilled = [];
  for (const j of jobs) {
    for (const c of j?.changeOrders || []) {
      if (c?.status !== 'approved' || billedCos.has(c.id) || String(c.approvedOn || c.date || '') > asOf) continue;
      changeOrdersApprovedUnbilled.push({ jobId: j.id, number: j.number || '', changeOrderId: c.id, title: c.title || '', approvedOn: c.approvedOn || null, amountCents: num(c.amountCents) });
    }
  }

  // ---- accrued cost ----
  const rnb = receivedNotBilled({ purchaseOrders, bills, stockMoves, asOf });
  const accruedCost = { receivedNotBilledCents: rnb.reduce((s, x) => s + x.cents, 0), rows: rnb };

  // ---- accrued payroll ----
  const locks = locksFrom(settings, payrollRuns);
  const burden = burdenCache({ rules, settings });
  const empById = new Map(employees.map((e) => [e.id, e]));
  const accrueVac = settings?.payroll?.vacationPayMode === 'accrue';
  const accrueHol = settings?.payroll?.holidayPayMode === 'accrue';
  const perEmp = new Map();
  for (const t of timeEntries) {
    if (!t || locks.payrollEntryIds.has(t.id)) continue;
    if (!isCorrection(t) && !t.clockOut) continue;
    const d = isCorrection(t) ? t.workDay : dayOf(t.clockIn);
    if (!d || d > asOf) continue;
    const minutes = entryMinutes(t, now);
    const emp = empById.get(t.employeeId) || {};
    const b = burden(emp, d);
    const wages = (minutes / 60) * b.wageCents;
    const vac = wages * (b.vacationPct / 100), hol = wages * (b.holidayPct / 100);
    const burdenPart = (wages + vac + hol) * (b.statutoryPct / 100) + (minutes / 60) * b.benefitsCentsPerHour;
    if (!perEmp.has(t.employeeId)) perEmp.set(t.employeeId, { employeeId: t.employeeId || null, name: emp.name || '', minutes: 0, entries: 0, wagesCents: 0, burdenCents: 0, vacationCents: 0, holidayCents: 0 });
    const row = perEmp.get(t.employeeId);
    row.minutes += minutes; row.entries += 1; row.wagesCents += wages; row.burdenCents += burdenPart;
    if (accrueVac) row.vacationCents += vac;
    if (accrueHol) row.holidayCents += hol;
  }
  const payRows = [...perEmp.values()].map((x) => ({ ...x, wagesCents: r(x.wagesCents), burdenCents: r(x.burdenCents), vacationCents: r(x.vacationCents), holidayCents: r(x.holidayCents) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const accruedPayroll = {
    wagesCents: payRows.reduce((s, x) => s + x.wagesCents, 0), burdenCents: payRows.reduce((s, x) => s + x.burdenCents, 0),
    vacationCents: payRows.reduce((s, x) => s + x.vacationCents, 0), holidayCents: payRows.reduce((s, x) => s + x.holidayCents, 0), rows: payRows,
  };

  // ---- balances ----
  const upTo = (i) => live(i) && day(i.issueDate || i.createdAt) <= asOf;
  let holdbackReceivableCents = 0;
  for (const i of invoices.filter(upTo)) {
    const k = invoiceKind(i);
    if (['standard', 'progress', 'credit'].includes(k)) holdbackReceivableCents += docTotals(i).holdbackCents;
    if (k === 'holdback-release') holdbackReceivableCents -= docTotals(i).holdbackLineCents;
  }
  const deposits = invoices.filter((i) => upTo(i) && invoiceKind(i) === 'deposit' && !(i.forfeitedOn && i.forfeitedOn <= asOf));
  const depositIds = new Set(deposits.map((i) => i.id));
  const applied = invoices.filter(upTo).flatMap((i) => (i.lines || []).filter((l) => l?.lineType === 'deposit' && depositIds.has(l.depositInvoiceId)));
  const depositsUnappliedCents = Math.max(0, deposits.reduce((s, i) => s + docTotals(i).depositCents, 0) + applied.reduce((s, l) => s + r(num(l.qty) * num(l.unitCents)), 0));
  const onAccountCreditCents = payments.filter((p) => p && day(p.date || p.createdAt) <= asOf && p.method !== 'credit-note')
    .reduce((s, p) => s + (!p.invoiceId ? num(p.amountCents) : 0) - (p.appliedFromId ? num(p.amountCents) : 0), 0);
  const disputedCents = invoices.filter(upTo).reduce((s, i) => s + (i.disputes || []).filter((d) => d?.status === 'open').reduce((a, d) => a + num(d.cents), 0), 0);
  const rst = rstSelfAssessment({ stockMoves, materialRequests, bills, vendors, items, jobs, purchaseOrders, from: monthStart(asOf), to: asOf, province, dayOf });
  const badDebtCreditNotes = invoices.filter((i) => live(i) && invoiceKind(i) === 'credit' && i.creditReason === 'bad_debt' && day(i.issueDate) >= monthStart(asOf) && day(i.issueDate) <= asOf)
    .map((i) => ({ invoiceId: i.id, number: i.number || '', creditsInvoiceId: i.creditsInvoiceId || null, issueDate: i.issueDate, totalCents: docTotals(i).totalCents, taxCents: docTotals(i).taxCents }));
  const inventory = valuationByLocation({ items, stockMoves, locations, asOf }).map(({ locationId, name, valueCents }) => ({ locationId, name, valueCents }));
  const signedTicketsUnpriced = fieldTickets.filter((t) => t && ['signed', 'refused'].includes(t.status) && day(t.date) <= asOf).length;

  // ---- the journal (a suggestion; reverse each entry on the 1st) ----
  const journal = [];
  const entry = (debit, credit, cents, memo) => {
    if (!cents) return;
    journal.push({ account: debit, debitCents: cents, creditCents: 0, memo });
    journal.push({ account: credit, debitCents: 0, creditCents: cents, memo });
  };
  entry(A.underBilled, A.revenue, accruedRevenue.wipUnderBilledCents, 'Under-billed fixed-price work (WIP)');
  entry(A.revenue, A.overBilled, accruedRevenue.wipOverBilledCents, 'Over-billed fixed-price work (WIP)');
  entry(A.unbilledAr, A.revenue, accruedRevenue.tmUnbilledCents, 'Time and material not billed yet');
  entry(A.jobCost, A.accruedLiabilities, accruedCost.receivedNotBilledCents, 'Material received, supplier bill not in yet');
  entry(A.wages, A.accruedPayroll, accruedPayroll.wagesCents + accruedPayroll.burdenCents + accruedPayroll.vacationCents + accruedPayroll.holidayCents, 'Hours worked, not yet paid');
  entry(A.expense, A.rstPayable, rst.totals.selfAssessCents, `Self-assessed RST. ${ADD_TO_RETURN}`);

  return {
    asOf, accruedRevenue, changeOrdersApprovedUnbilled, accruedCost, accruedPayroll,
    holdbackReceivableCents, depositsUnappliedCents, onAccountCreditCents, disputedCents,
    rstSelfAssessCents: rst.totals.selfAssessCents, rst, badDebtCreditNotes, inventory, journal, signedTicketsUnpriced,
    tmJobs: jobs.filter((j) => jobBillingMode(j) === 'tm').length,
  };
}

/** The cutoff as CSV for the accountant: one section per block. `money` formats cents. */
export function cutoffCsv(c, { money = (x) => (x / 100).toFixed(2) } = {}) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const row = (...cells) => cells.map(esc).join(',');
  const out = [row('Month-end cutoff', c.asOf), ''];
  out.push(row('Accrued revenue', 'Job', 'Title', 'Mode', 'Earned', 'Billed', 'Under billed', 'Over billed'));
  for (const x of c.accruedRevenue.rows) out.push(row('', x.number, x.title, x.mode, money(x.earnedCents), money(x.billedCents), money(x.underBilledCents), money(x.overBilledCents)));
  out.push(row('Totals', '', '', '', '', '', money(c.accruedRevenue.wipUnderBilledCents + c.accruedRevenue.tmUnbilledCents), money(c.accruedRevenue.wipOverBilledCents)), '');
  out.push(row('Change orders approved, not billed (information only)', 'Job', 'Change order', 'Approved', 'Amount'));
  for (const x of c.changeOrdersApprovedUnbilled) out.push(row('', x.number, x.title, x.approvedOn || '', money(x.amountCents)));
  out.push('');
  out.push(row('Received not billed', 'Purchase order', 'Line', 'Description', 'Qty', 'Unit', 'Amount'));
  for (const x of c.accruedCost.rows) out.push(row('', x.number, x.index + 1, x.description, x.qty, money(x.unitCents), money(x.cents)));
  out.push(row('Total', '', '', '', '', '', money(c.accruedCost.receivedNotBilledCents)), '');
  out.push(row('Accrued payroll', 'Employee', 'Hours', 'Wages', 'Burden', 'Vacation', 'Holiday'));
  for (const x of c.accruedPayroll.rows) out.push(row('', x.name, (x.minutes / 60).toFixed(2), money(x.wagesCents), money(x.burdenCents), money(x.vacationCents), money(x.holidayCents)));
  out.push(row('Total', '', '', money(c.accruedPayroll.wagesCents), money(c.accruedPayroll.burdenCents), money(c.accruedPayroll.vacationCents), money(c.accruedPayroll.holidayCents)), '');
  out.push(row('Balances', 'Amount'));
  out.push(row('Holdback receivable', money(c.holdbackReceivableCents)));
  out.push(row('Customer deposits not applied', money(c.depositsUnappliedCents)));
  out.push(row('On-account credit', money(c.onAccountCreditCents)));
  out.push(row('Disputed', money(c.disputedCents)));
  out.push(row('Self-assessed RST this month', money(c.rstSelfAssessCents)), '');
  out.push(row('Bad-debt credit notes', 'Number', 'Date', 'Total', 'Tax'));
  for (const x of c.badDebtCreditNotes) out.push(row('', x.number, x.issueDate, money(x.totalCents), money(x.taxCents)));
  out.push('');
  out.push(row('Inventory by location', 'Value'));
  for (const x of c.inventory) out.push(row(x.name, money(x.valueCents)));
  out.push('');
  out.push(row('Journal (suggested; reverse on the 1st)', 'Debit', 'Credit', 'Memo'));
  for (const j of c.journal) out.push(row(j.account, j.debitCents ? money(j.debitCents) : '', j.creditCents ? money(j.creditCents) : '', j.memo));
  out.push('', row('Signed or refused field tickets not priced or billed', c.signedTicketsUnpriced));
  return out.join('\n');
}
