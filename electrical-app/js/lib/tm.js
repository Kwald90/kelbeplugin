// Billing mode per job: time & material (T&M) or fixed price (from the estimate). Pure, no DOM.
//
// T&M: approved time entries (travel included when it is tracked, `travel: true` on the entry)
// at the job's or the company's labour rate, plus material used on the job (stock moves out of
// a location onto the job, and fulfilled material requests that never became a stock move) at
// cost + markup, become invoice lines. What an invoice billed is kept on the invoice
// (`tm: { from, to, timeEntryIds, stockMoveIds, materialRequestIds }`), so nothing is billed
// twice and voiding the invoice frees it again. No other record is changed.
//
// Fixed price: time is tracked for payroll and job costing only and never becomes an invoice
// line. jobCosting() compares the estimate with what was spent: hours, cost and margin.
import { docTotals, entryHours } from './money.js';
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

/** Records a non-void invoice already billed: Set of 'time:<id>', 'move:<id>', 'req:<id>'. */
export function billedRefs(invoices = []) {
  const out = new Set();
  for (const inv of invoices) {
    if (!inv?.tm || inv.status === 'void') continue;
    for (const id of inv.tm.timeEntryIds || []) out.add(`time:${id}`);
    for (const id of inv.tm.stockMoveIds || []) out.add(`move:${id}`);
    for (const id of inv.tm.materialRequestIds || []) out.add(`req:${id}`);
  }
  return out;
}

/** Is a stock move material used on a job (out of a location, not into another)? */
export const isJobUse = (m, jobId) => m.jobId === jobId && Boolean(m.fromLocationId) && !m.toLocationId && Number(m.qty) > 0;

/**
 * What a T&M job has not billed yet, between `from` and `to` (YYYY-MM-DD, inclusive; either may
 * be empty for open-ended).
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
  for (const t of timeEntries) {
    if (t.jobId !== job.id || !t.clockOut || billed.has(`time:${t.id}`)) continue;
    const day = dayOf(t.clockIn);
    if (!inRange(day, from, to)) continue;
    if (!t.approved) { pendingApproval++; continue; }
    const hours = round2(entryHours(t));
    if (hours <= 0) continue;
    const e = empById.get(t.employeeId);
    const travel = Boolean(t.travel);
    const rateCents = travel ? rates.travelRateCents : (Number(e?.billRateCents) > 0 && job.labourRateCents == null ? Number(e.billRateCents) : rates.labourRateCents);
    labour.push({ id: t.id, day, hours, travel, employeeId: t.employeeId || null, name: e?.name || 'Crew', rateCents });
  }
  const materials = [];
  const unit = (costCents) => Math.round(costCents * (1 + rates.markupPct / 100));
  for (const m of stockMoves) {
    if (!isJobUse(m, job.id) || billed.has(`move:${m.id}`) || !inRange(m.date || dayOf(m.createdAt), from, to)) continue;
    const it = itemById.get(m.itemId);
    const cost = it?.costCents;
    materials.push({ source: 'move', id: m.id, itemId: m.itemId || null, description: it?.name || 'Material', unit: it?.unit || 'ea', qty: Number(m.qty),
      costCents: cost == null ? null : Number(cost), unitCents: cost == null ? 0 : unit(Number(cost)) });
  }
  for (const r of materialRequests) {
    if (r.jobId !== job.id || r.status !== 'fulfilled' || r.stockMoveId || billed.has(`req:${r.id}`)) continue;
    if (!inRange(dayOf(r.fulfilledAt || r.updatedAt || r.createdAt), from, to)) continue;
    const it = r.itemId ? itemById.get(r.itemId) : null;
    const cost = r.costCents ?? it?.costCents ?? null;
    materials.push({ source: 'request', id: r.id, itemId: r.itemId || null, description: it?.name || r.description || 'Material', unit: r.unit || it?.unit || 'ea', qty: Number(r.qty) || 0,
      costCents: cost == null ? null : Number(cost), unitCents: cost == null ? 0 : unit(Number(cost)) });
  }
  const hours = round2(labour.filter((l) => !l.travel).reduce((s, l) => s + l.hours, 0));
  const travelHours = round2(labour.filter((l) => l.travel).reduce((s, l) => s + l.hours, 0));
  const labourCents = labour.reduce((s, l) => s + Math.round(l.hours * l.rateCents), 0);
  const materialCents = materials.reduce((s, m) => s + Math.round(m.qty * m.unitCents), 0);
  return {
    rates, labour, materials, hours, travelHours, labourCents, materialCents, totalCents: labourCents + materialCents,
    missingCost: materials.filter((m) => m.costCents == null).length, pendingApproval,
    empty: !labour.length && !materials.length,
  };
}

/**
 * Invoice lines from unbilledTm(): one labour line per person and rate (travel on its own line),
 * one material line per item and price (free-text requests by description).
 * @returns {{ lines: object[], refs: { timeEntryIds: string[], stockMoveIds: string[], materialRequestIds: string[] } }}
 */
export function tmLines(u, { fmtDay = (d) => d } = {}) {
  const lines = [];
  const groups = new Map();
  for (const l of u.labour) {
    const k = `${l.employeeId}|${l.travel}|${l.rateCents}`;
    if (!groups.has(k)) groups.set(k, { ...l, hours: 0, days: [] });
    const g = groups.get(k);
    g.hours = round2(g.hours + l.hours);
    g.days.push(l.day);
  }
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

/**
 * The draft invoice for "Build invoice from time & material". Taxes come from the company's
 * province (tax.js) on the issue date. Throws for a fixed-price job.
 */
export function buildTmInvoice({ job, settings, issueDate, dueDate, from = '', to = '', fmtDay, ...sources }) {
  if (jobBillingMode(job) !== 'tm') throw new Error('This job is fixed price: bill it from the estimate. Its time is for payroll and job costing.');
  const u = unbilledTm({ job, settings, from, to, ...sources });
  if (u.empty) throw new Error(u.pendingApproval ? `Nothing approved to bill yet: ${u.pendingApproval} time entr${u.pendingApproval === 1 ? 'y is' : 'ies are'} waiting for approval.` : 'Nothing to bill in that range.');
  const { lines, refs } = tmLines(u, { fmtDay });
  const range = from && to ? `${from} to ${to}` : from ? `from ${from}` : to ? `up to ${to}` : 'to date';
  return {
    invoice: {
      clientId: job.clientId || null, jobId: job.id, estimateId: null, title: job.title || '', status: 'draft', lines,
      ...newDocTax(settings, issueDate), issueDate, dueDate,
      notes: `Time and material ${range}.`, billingMode: 'tm', tm: { from: from || null, to: to || null, ...refs },
    },
    unbilled: u,
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
 * Estimate against actual for a job (fixed price, though it works for T&M too).
 * Estimate: accepted estimates (else every estimate on the job) plus approved change orders.
 * Actual: every closed time entry at each person's cost rate, and material used at cost.
 * Labour cost in the estimate uses the average cost rate of the job's crew (else everyone's).
 */
export function jobCosting({ job, estimates = [], timeEntries = [], stockMoves = [], materialRequests = [], items = [], employees = [], now = new Date() }) {
  const mine = estimates.filter((e) => e.jobId === job.id || e.id === job.estimateId);
  const accepted = mine.filter((e) => e.status === 'accepted');
  const basis = accepted.length ? accepted : mine;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const coCents = (job.changeOrders || []).filter((c) => c.status === 'approved').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
  const contractCents = basis.reduce((s, e) => s + docValue(e), 0) + coCents;
  const estHours = round2(basis.reduce((s, e) => s + docHours(e), 0));
  const estMaterialCents = basis.reduce((s, e) => s + (e.lines || []).filter((l) => l.kind !== 'labour' && l.kind !== 'other')
    .reduce((a, l) => a + Math.round((Number(l.qty) || 0) * (Number(itemById.get(l.itemId)?.costCents) || 0)), 0), 0);
  const crew = (job.crewIds || []).map((id) => empById.get(id)).filter((e) => e && Number(e.rateCents) > 0);
  const pool = crew.length ? crew : employees.filter((e) => e.active !== false && Number(e.rateCents) > 0);
  const avgRate = pool.length ? Math.round(pool.reduce((s, e) => s + Number(e.rateCents), 0) / pool.length) : 0;
  const estLabourCents = Math.round(estHours * avgRate);
  const estCostCents = estLabourCents + estMaterialCents;

  let hours = 0, travelHours = 0, labourCents = 0;
  for (const t of timeEntries) {
    if (t.jobId !== job.id || !t.clockIn) continue;
    const h = entryHours(t, now);
    if (t.travel) travelHours += h; else hours += h;
    labourCents += Math.round(h * (Number(empById.get(t.employeeId)?.rateCents) || 0));
  }
  let materialCents = 0;
  for (const m of stockMoves) if (isJobUse(m, job.id)) materialCents += Math.round(Number(m.qty) * (Number(itemById.get(m.itemId)?.costCents) || 0));
  for (const r of materialRequests) {
    if (r.jobId !== job.id || r.status !== 'fulfilled' || r.stockMoveId) continue;
    materialCents += Math.round((Number(r.qty) || 0) * (Number(r.costCents ?? itemById.get(r.itemId)?.costCents) || 0));
  }
  const costCents = labourCents + materialCents;
  const marginCents = contractCents - costCents;
  return {
    estimates: basis.length, contractCents, coCents,
    estHours, estLabourCents, estMaterialCents, estCostCents,
    hours: round2(hours), travelHours: round2(travelHours), labourCents, materialCents, costCents,
    hoursUsedPct: estHours ? Math.round(((hours + travelHours) / estHours) * 100) : null,
    costUsedPct: estCostCents ? Math.round((costCents / estCostCents) * 100) : null,
    marginCents, marginPct: contractCents ? Math.round((marginCents / contractCents) * 100) : null,
    estMarginCents: contractCents - estCostCents,
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
