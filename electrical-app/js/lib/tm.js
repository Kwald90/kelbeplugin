// Billing mode per job: time & material (T&M) or fixed price (from the estimate). Pure, no DOM.
//
// T&M: approved time entries (travel included: `kind: 'travel'` on the entry, from the time clock's
// travel state; the older `travel: true` flag is still read, see isTravel)
// at the job's or the company's labour rate, plus material used on the job (stock moves out of
// a location onto the job, and fulfilled material requests that never became a stock move) at
// cost + markup, become invoice lines. What an invoice billed is kept on the invoice
// (`tm: { from, to, timeEntryIds, stockMoveIds, materialRequestIds }`), so nothing is billed
// twice and voiding the invoice frees it again (restoring it is refused once a newer invoice
// billed any of them: restoreConflicts). No other record is changed.
//
// Fixed price: time is tracked for payroll and job costing only and never becomes an invoice
// line. jobCosting() compares the estimate with what was spent: hours, cost and margin, using
// lib/costing.js (docs/releases/r1-get-paid.md 6: burdened labour, trucks, bills, accruals).
//
// Field tickets (r1-get-paid.md 4.1): on a T&M job, signed and refused tickets are billed by this
// builder, never priced as change orders. buildTmInvoice picks them up (ticketIds) and reconciles
// each day's billed hours from time entries against the hours on the tickets
// (ticketReconciliation); with settings.tickets.billFrom 'tickets' labour bills the ticket hours.
import { docTotals, entryHours, lineCents } from './money.js';
import { jobActuals, contractEstimate, contractValue, estimatedCost, jobVarianceCount, approvedChangeOrders } from './costing.js';

/**
 * Is this time entry travel? One model: `kind: 'travel'` (lib/timesheet.js, lib/clock.js). Entries saved
 * with the earlier `travel: true` checkbox (before 2026-10-20) still count as travel.
 */
export const isTravel = (t) => t?.kind === 'travel' || (t?.kind == null && t?.travel === true);
import { newDocTax } from './tax.js';

export const BILLING_MODES = [
  { value: 'tm', label: 'Time & material', hint: 'Bill approved hours and material used, at your rates.' },
  { value: 'fixed', label: 'Fixed price (estimate)', hint: 'Bill the estimate; time is tracked for payroll and job costing.' },
];
export const billingLabel = (mode) => BILLING_MODES.find((m) => m.value === mode)?.label || 'Fixed price (estimate)';

/** A job's mode. Jobs from before billing modes were quoted, so they count as fixed. */
export const jobBillingMode = (job) => (job?.billingMode === 'tm' ? 'tm' : 'fixed');

/** The mode a new job starts with: the client's default ("always T&M"), the company's, else fixed. */
export function defaultBillingMode(settings, client) {
  if (client?.billingMode === 'tm' || client?.billingMode === 'fixed') return client.billingMode;
  const d = settings?.billing?.defaultMode;
  return d === 'tm' ? 'tm' : 'fixed';
}

/** Rates for a job: its own, else the company's. Travel defaults to the labour rate. */
export function jobRates(job, settings) {
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const labourRateCents = n(job?.labourRateCents) ?? n(settings?.labourRateCents) ?? 0;
  const travelRateCents = n(job?.travelRateCents) ?? n(settings?.billing?.travelRateCents) ?? labourRateCents;
  const markupPct = n(job?.markupPct) ?? n(settings?.markupPct) ?? 0;
  return { labourRateCents, travelRateCents, markupPct };
}

const defaultDay = (iso) => String(iso || '').slice(0, 10);
const inRange = (day, from, to) => Boolean(day) && (!from || day >= from) && (!to || day <= to);
const round2 = (n) => Math.round(n * 100) / 100;

/** The records one T&M invoice bills: 'time:<id>', 'move:<id>', 'req:<id>'. */
function invoiceRefs(inv) {
  return [
    ...(inv?.tm?.timeEntryIds || []).map((id) => `time:${id}`),
    ...(inv?.tm?.stockMoveIds || []).map((id) => `move:${id}`),
    ...(inv?.tm?.materialRequestIds || []).map((id) => `req:${id}`),
  ];
}

/** Records a non-void invoice already billed: Set of 'time:<id>', 'move:<id>', 'req:<id>'. */
export function billedRefs(invoices = []) {
  const out = new Set();
  for (const inv of invoices) {
    if (!inv?.tm || inv.status === 'void') continue;
    for (const r of invoiceRefs(inv)) out.add(r);
  }
  return out;
}

/**
 * What a voided T&M invoice would bill twice if it were restored: the records it bills that
 * another non-void invoice has billed since the void freed them. Empty when it can come back.
 */
export function restoreConflicts(invoice, invoices = []) {
  if (!invoice?.tm) return [];
  const billed = billedRefs(invoices.filter((i) => i?.id !== invoice.id));
  return invoiceRefs(invoice).filter((r) => billed.has(r));
}

/**
 * Does a fulfilled request's stock move still stand for it? A move that was undone (deleted)
 * no longer does, unless an invoice billed it before it went.
 */
const coveredByMove = (r, moveIds, billed = new Set()) => Boolean(r.stockMoveId) && (moveIds.has(r.stockMoveId) || billed.has(`move:${r.stockMoveId}`));

/** Is a stock move material used on a job (out of a location, not into another)? */
export const isJobUse = (m, jobId) => m.jobId === jobId && Boolean(m.fromLocationId) && !m.toLocationId && Number(m.qty) > 0;

/**
 * Is a stock move material coming back from a job (into a van or the shop, from no location)? It
 * counts as negative job use. Receipts from a supplier and count adjustments are not returns.
 */
export const isJobReturn = (m, jobId) => m.jobId === jobId && Boolean(m.toLocationId) && !m.fromLocationId && Number(m.qty) > 0
  && m.use !== 'receive' && m.use !== 'adjust' && !m.countId;

/**
 * What a T&M job has not billed yet, between `from` and `to` (YYYY-MM-DD, inclusive; either may
 * be empty for open-ended). `firstDay` is the earliest day of anything left to bill (approved or
 * waiting for approval): the invoice builder's default start. The totals are the amounts of the
 * invoice's own lines (tmLines), so the preview and the invoice it builds always agree.
 * @param {object} o
 * @param {object} o.job
 * @param {object} o.settings company settings
 * @param {object[]} [o.timeEntries] @param {object[]} [o.stockMoves] @param {object[]} [o.materialRequests]
 * @param {object[]} [o.items] price book @param {object[]} [o.employees] @param {object[]} [o.invoices]
 * @param {(iso: string) => string} [o.dayOf] the local day of a timestamp (the PWA passes ui.localDay)
 */
export function unbilledTm({ job, settings, timeEntries = [], stockMoves = [], materialRequests = [], items = [], employees = [], invoices = [], from = '', to = '', dayOf = defaultDay }) {
  const billed = billedRefs(invoices);
  const rates = jobRates(job, settings);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const labour = [];
  let pendingApproval = 0;
  let firstDay = '';
  const seen = (day) => { if (day && (!firstDay || day < firstDay)) firstDay = day; };
  for (const t of timeEntries) {
    if (t.jobId !== job.id || !t.clockOut || billed.has(`time:${t.id}`)) continue;
    const day = dayOf(t.clockIn);
    if (!inRange(day, from, to)) continue;
    seen(day);
    if (!t.approved) { pendingApproval++; continue; }
    // Exact hours: tmLines adds them up per invoice line and rounds once there.
    const hours = entryHours(t);
    if (round2(hours) <= 0) continue;
    const e = empById.get(t.employeeId);
    const travel = isTravel(t);
    const rateCents = travel ? rates.travelRateCents : (Number(e?.billRateCents) > 0 && job.labourRateCents == null ? Number(e.billRateCents) : rates.labourRateCents);
    labour.push({ id: t.id, day, hours, travel, employeeId: t.employeeId || null, name: e?.name || 'Crew', rateCents });
  }
  const materials = [];
  const unit = (costCents) => Math.round(costCents * (1 + rates.markupPct / 100));
  const moveIds = new Set(stockMoves.map((m) => m.id));
  // A move whose request was billed on its own (the move was missing then) is billed already.
  const billedViaRequest = new Set(materialRequests.filter((r) => r.stockMoveId && billed.has(`req:${r.id}`)).map((r) => r.stockMoveId));
  for (const m of stockMoves) {
    // Material used on the job, and material returned from it (a credit at the same price).
    const back = !isJobUse(m, job.id) && isJobReturn(m, job.id);
    if ((!isJobUse(m, job.id) && !back) || billed.has(`move:${m.id}`) || billedViaRequest.has(m.id)) continue;
    const day = m.date || dayOf(m.createdAt);
    if (!inRange(day, from, to)) continue;
    seen(day);
    const it = itemById.get(m.itemId);
    const cost = it?.costCents;
    materials.push({ source: 'move', id: m.id, day, itemId: m.itemId || null, description: it?.name || 'Material', unit: it?.unit || 'ea', qty: back ? -Number(m.qty) : Number(m.qty),
      costCents: cost == null ? null : Number(cost), unitCents: cost == null ? 0 : unit(Number(cost)), ...(back ? { returned: true } : {}) });
  }
  for (const r of materialRequests) {
    if (r.jobId !== job.id || r.status !== 'fulfilled' || coveredByMove(r, moveIds, billed) || billed.has(`req:${r.id}`)) continue;
    const day = dayOf(r.fulfilledAt || r.updatedAt || r.createdAt);
    if (!inRange(day, from, to)) continue;
    seen(day);
    const it = r.itemId ? itemById.get(r.itemId) : null;
    const cost = r.costCents ?? it?.costCents ?? null;
    materials.push({ source: 'request', id: r.id, day, itemId: r.itemId || null, description: it?.name || r.description || 'Material', unit: r.unit || it?.unit || 'ea', qty: Number(r.qty) || 0,
      costCents: cost == null ? null : Number(cost), unitCents: cost == null ? 0 : unit(Number(cost)) });
  }
  const hours = round2(labour.filter((l) => !l.travel).reduce((s, l) => s + l.hours, 0));
  const travelHours = round2(labour.filter((l) => l.travel).reduce((s, l) => s + l.hours, 0));
  const { lines } = tmLines({ labour, materials });
  const sum = (kind) => lines.filter((l) => l.kind === kind).reduce((s, l) => s + lineCents(l), 0);
  const labourCents = sum('labour');
  const materialCents = sum('material');
  return {
    rates, labour, materials, hours, travelHours, labourCents, materialCents, totalCents: labourCents + materialCents,
    missingCost: materials.filter((m) => m.costCents == null).length, pendingApproval, firstDay,
    empty: !labour.length && !materials.length,
  };
}

/**
 * Invoice lines from unbilledTm(): one labour line per person and rate (travel on its own line),
 * one material line per item and price (free-text requests by description). A labour line's
 * hours are the exact sum of its entries, rounded once to 0.01 h.
 * @returns {{ lines: object[], refs: { timeEntryIds: string[], stockMoveIds: string[], materialRequestIds: string[] } }}
 */
export function tmLines(u, { fmtDay = (d) => d } = {}) {
  const lines = [];
  const groups = new Map();
  for (const l of u.labour) {
    const k = `${l.employeeId}|${l.travel}|${l.rateCents}`;
    if (!groups.has(k)) groups.set(k, { ...l, hours: 0, days: [] });
    const g = groups.get(k);
    g.hours += l.hours;
    g.days.push(l.day);
  }
  for (const g of groups.values()) g.hours = round2(g.hours);
  for (const g of [...groups.values()].sort((a, b) => Number(a.travel) - Number(b.travel) || a.name.localeCompare(b.name))) {
    const days = [...new Set(g.days)].sort();
    const span = days.length > 1 ? `${fmtDay(days[0])} to ${fmtDay(days.at(-1))}` : fmtDay(days[0]);
    lines.push({ itemId: null, description: `${g.travel ? 'Travel' : 'Labour'}: ${g.name} (${span})`, qty: g.hours, unitCents: g.rateCents, labourHours: 0, kind: 'labour' });
  }
  const mats = new Map();
  for (const m of u.materials) {
    const k = `${m.itemId || m.description.toLowerCase()}|${m.unitCents}|${m.unit}`;
    if (!mats.has(k)) mats.set(k, { ...m, qty: 0 });
    mats.get(k).qty = round2(mats.get(k).qty + m.qty);
  }
  for (const m of [...mats.values()].sort((a, b) => a.description.localeCompare(b.description))) {
    lines.push({ itemId: m.itemId, description: m.costCents == null ? `${m.description} (price needed)` : m.description, qty: m.qty, unitCents: m.unitCents, labourHours: 0, kind: 'material' });
  }
  return {
    lines,
    refs: {
      timeEntryIds: u.labour.map((l) => l.id),
      stockMoveIds: u.materials.filter((m) => m.source === 'move').map((m) => m.id),
      materialRequestIds: u.materials.filter((m) => m.source === 'request').map((m) => m.id),
    },
  };
}

/** Ticket ids a non-void invoice already billed. */
export function billedTicketIds(invoices = []) {
  const out = new Set();
  for (const inv of invoices) if (inv && inv.status !== 'void') for (const id of inv.ticketIds || []) out.add(id);
  return out;
}

/** Minutes of labour on a field ticket row: hours, plus travel when it is a number of hours. */
const ticketRowMinutes = (l) => Math.round(((Number(l?.hours) || 0) + (typeof l?.travel === 'number' ? l.travel : 0)) * 60);

/**
 * Signed and refused field tickets on a T&M job dated in from..to that no invoice has billed yet
 * (a refused ticket is billed with its written notice).
 */
export function billableTickets(job, fieldTickets = [], { invoices = [], from = '', to = '' } = {}) {
  const done = billedTicketIds(invoices);
  return fieldTickets.filter((t) => t && t.jobId === job.id && ['signed', 'refused'].includes(t.status) && !t.invoiceId && !done.has(t.id) && inRange(t.date, from, to))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.number || a.id).localeCompare(String(b.number || b.id)));
}

/**
 * Per day: minutes billed from time entries against minutes on the day's signed or refused tickets.
 * A day where billed exceeds signed needs a reason before the invoice is saved (the invoice screen asks).
 * Only when the job has tickets in the range; a company that does not use tickets reconciles nothing.
 */
export function ticketReconciliation(labour, tickets) {
  if (!tickets.length) return [];
  const days = new Map();
  const at = (d) => { if (!days.has(d)) days.set(d, { day: d, billedMinutes: 0, signedMinutes: 0 }); return days.get(d); };
  for (const l of labour) at(l.day).billedMinutes += l.hours * 60;
  for (const t of tickets) for (const l of t.labour || []) at(t.date).signedMinutes += ticketRowMinutes(l);
  return [...days.values()].map((x) => ({ ...x, billedMinutes: Math.round(x.billedMinutes), signedMinutes: Math.round(x.signedMinutes) }))
    .map((x) => ({ ...x, needsReason: x.billedMinutes > x.signedMinutes }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Labour rows to bill from tickets (settings.tickets.billFrom 'tickets'): the signed hours, at the job's rates. */
function ticketLabour(job, tickets, rates, employees) {
  const empById = new Map(employees.map((e) => [e.id, e]));
  const out = [];
  for (const t of tickets) {
    (t.labour || []).forEach((l, i) => {
      const e = l.employeeId ? empById.get(l.employeeId) : null;
      const name = l.name || e?.name || 'Crew';
      const rateCents = Number(e?.billRateCents) > 0 && job.labourRateCents == null ? Number(e.billRateCents) : rates.labourRateCents;
      const hours = Number(l.hours) || 0;
      if (hours > 0) out.push({ id: `${t.id}:${i}`, day: t.date, hours, travel: l.travel === true, employeeId: l.employeeId || null, name, rateCents: l.travel === true ? rates.travelRateCents : rateCents, ticketId: t.id });
      if (typeof l.travel === 'number' && l.travel > 0) out.push({ id: `${t.id}:${i}:travel`, day: t.date, hours: l.travel, travel: true, employeeId: l.employeeId || null, name, rateCents: rates.travelRateCents, ticketId: t.id });
    });
  }
  return out;
}

/**
 * The draft invoice for "Build invoice from time & material". Taxes come from the company's
 * province (tax.js newDocTax, exemption-aware with the job and client) on the issue date. Throws for
 * a fixed-price job. With `fieldTickets`, signed and refused tickets on the job in the range are picked
 * up (invoice.ticketIds, and invoice.ticketReconciliation per day; `flaggedDays` lists the days where
 * billed hours exceed signed hours). With settings.tickets.billFrom 'tickets', labour lines bill the
 * hours on the tickets instead of time entries (material still comes from moves and requests), and
 * the time entries those tickets name are marked billed.
 */
export function buildTmInvoice({ job, settings, issueDate, dueDate, from = '', to = '', fmtDay, client = null, fieldTickets = [], ...sources }) {
  if (jobBillingMode(job) !== 'tm') throw new Error('This job is fixed price: bill it from the estimate. Its time is for payroll and job costing.');
  const u = unbilledTm({ job, settings, from, to, ...sources });
  const tickets = billableTickets(job, fieldTickets, { invoices: sources.invoices || [], from, to });
  const fromTickets = settings?.tickets?.billFrom === 'tickets';
  let billing = u;
  let reconciliation;
  if (fromTickets) {
    const labour = ticketLabour(job, tickets, u.rates, sources.employees || []);
    billing = { ...u, labour, empty: !labour.length && !u.materials.length };
    reconciliation = ticketReconciliation(labour, tickets).map((x) => ({ ...x, needsReason: false }));
  } else {
    reconciliation = ticketReconciliation(u.labour, tickets);
  }
  if (billing.empty) throw new Error(u.pendingApproval ? `Nothing approved to bill yet: ${u.pendingApproval} time entr${u.pendingApproval === 1 ? 'y is' : 'ies are'} waiting for approval.` : 'Nothing to bill in that range.');
  const { lines, refs } = tmLines(billing, { fmtDay });
  if (fromTickets) {
    const named = new Set(tickets.flatMap((t) => (t.labour || []).flatMap((l) => l.timeEntryIds || [])));
    refs.timeEntryIds = u.labour.filter((l) => named.has(l.id)).map((l) => l.id);
  }
  const range = from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `up to ${to}` : 'to date';
  const ticketPart = tickets.length ? ` Field tickets ${tickets.map((t) => t.number || `T-pending ${String(t.id).slice(0, 4)}`).join(', ')}.` : '';
  return {
    invoice: {
      clientId: job.clientId || null, jobId: job.id, estimateId: null, title: job.title || '', status: 'draft', lines,
      ...newDocTax(settings, issueDate, { job, client }), issueDate, dueDate,
      notes: `Time and material ${range}.${ticketPart}`, billingMode: 'tm', tm: { from: from || null, to: to || null, ...refs },
      ...(tickets.length ? { ticketIds: tickets.map((t) => t.id), ticketReconciliation: reconciliation.map(({ day, billedMinutes, signedMinutes }) => ({ day, billedMinutes, signedMinutes })) } : {}),
    },
    unbilled: billing,
    tickets,
    flaggedDays: reconciliation.filter((x) => x.needsReason).map((x) => x.day),
  };
}

/** Pre-tax value of a document's lines, markup included. */
const docValue = (d) => docTotals(d).subtotalCents;

/** Hours a document plans: per-unit labour hours plus labour lines (their qty is hours). */
export function docHours(d) {
  const labourLines = (d.lines || []).filter((l) => l.kind === 'labour').reduce((s, l) => s + (Number(l.qty) || 0), 0);
  return round2(docTotals(d).hours + labourLines);
}

/**
 * Estimate against actual for a job (fixed price, though it works for T&M too), through lib/costing.js.
 * Contract: contract.valueCents, else the latest accepted estimate that is not superseded (else, for
 * display only, the job's latest open estimate), plus change orders approved on or before asOf.
 * Estimate: the job's stored budget (costing.budget), else the estimate's at the burdened rate, plus
 * change-order budgets; costing.estCostOverrideCents wins. Actual: jobActuals (6.1).
 * Old keys keep their names: labourCents is burdened labour with the overtime premium (the bare wage
 * when no burden data exists, then burdenMissing is true), materialCents is stock and requests net of
 * returns, costCents is every cost including accrued.
 */
export function jobCosting({
  job, estimates = [], timeEntries = [], stockMoves = [], materialRequests = [], items = [], employees = [], bills = [], vendors = [],
  purchaseOrders = [], equipment = [], equipmentUse = [], rules = null, settings = null, asOf = '', now = new Date(), dayOf,
}) {
  const accepted = contractEstimate(job, estimates);
  const open = estimates.filter((e) => (e.jobId === job.id || e.id === job.estimateId) && !['declined', 'superseded', 'void'].includes(e.status))
    .sort((a, b) => String(b.issueDate || b.createdAt || '').localeCompare(String(a.issueDate || a.createdAt || '')));
  const basis = accepted || open[0] || null;
  const coCents = approvedChangeOrders(job, { asOf }).reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
  const contractCents = accepted || Number.isInteger(job?.contract?.valueCents) ? contractValue(job, estimates, { asOf }) : (basis ? docValue(basis) : 0) + coCents;
  const est = estimatedCost(job, { estimates, items, employees, equipment, rules, settings, asOf, estimate: basis });
  const budget = est.budget;
  const estHours = budget ? round2(Number(budget.labourHours) || 0) : 0;
  const estLabourCents = budget ? Number(budget.labourCostCents) || 0 : 0;
  const estMaterialCents = budget ? Number(budget.materialCents) || 0 : 0;
  const estCostCents = est.estCostCents;

  const a = jobActuals({ job, timeEntries, stockMoves, materialRequests, items, employees, bills, vendors, purchaseOrders, equipment, equipmentUse, rules, settings, asOf,
    now: now instanceof Date ? now.getTime() : now, ...(dayOf ? { dayOf } : {}) });
  const byCostCode = { ...a.byCostCode };
  for (const [k, v] of Object.entries(budget?.byCostCode || {})) {
    byCostCode[k] = { estCents: 0, actualCents: 0, hours: 0, ...byCostCode[k] };
    byCostCode[k].estCents = Number(v.estCents) || 0;
  }
  const marginCents = contractCents - a.costCents;
  return {
    estimates: basis ? 1 : 0, contractCents, coCents,
    estHours, estLabourCents, estMaterialCents, estCostCents,
    hours: a.hours, travelHours: a.travelHours, labourCents: a.labourCents, materialCents: a.materialCents, costCents: a.costCents,
    hoursUsedPct: estHours ? Math.round(((a.hours + a.travelHours) / estHours) * 100) : null,
    costUsedPct: estCostCents ? Math.round((a.costCents / estCostCents) * 100) : null,
    marginCents, marginPct: contractCents ? Math.round((marginCents / contractCents) * 100) : null,
    estMarginCents: contractCents - estCostCents,
    labourWageCents: a.labourWageCents, burdenCents: a.burdenCents, otPremiumCents: a.otPremiumCents,
    billsCents: a.billsCents, subcontractCents: a.subcontractCents, equipmentCents: a.equipmentCents, otherCents: a.otherCents,
    accruedCents: a.accruedCents, committedCents: a.committedCents, byCostCode,
    varianceCount: jobVarianceCount(job.id, { bills, purchaseOrders, items, tolerancePct: settings?.costing?.priceVariancePct ?? 2 }),
    burdenMissing: a.burdenMissing,
  };
}

/** Sum of unbilled T&M (pre-tax) across jobs, for the dashboard. */
export function unbilledAcrossJobs(jobs, sources, opts = {}) {
  let cents = 0, count = 0, hours = 0;
  for (const job of jobs) {
    if (jobBillingMode(job) !== 'tm' || ['invoiced'].includes(job.status)) continue;
    const u = unbilledTm({ job, ...sources, ...opts });
    if (u.empty) continue;
    cents += u.totalCents; hours += u.hours + u.travelHours; count++;
  }
  return { cents, count, hours: round2(hours) };
}
