// Job costing that tells the truth (docs/releases/r1-get-paid.md 6, 11; docs/office/job-costing.md).
// Pure, no DOM: the job screen (lib/tm.js jobCosting), Job costing reports, WIP, month-end and the
// server's reports all compute with these functions, so every screen and export agrees.
//
// What counts as cost on a job (jobActuals; every source is cut at `asOf` when given):
//   labour      time entries at the burdened cost per paid hour on the entry's day (rate history and
//               lib/burden.js), plus the overtime premium on the minutes that crossed the daily or weekly
//               threshold (lib/timesheet.js allocateOvertime, in time order, over the person's whole
//               week); corrections at the rate on their work day
//   trucks      a truck on time entries is charged once per truck and day: an hour rate on the union of
//               the entries' intervals (two people in one truck count once), a day rate once; split
//               across that day's jobs by hours
//   equipment   equipment use records at the rate on the day (a ticket's record for a truck already
//               charged through a time entry that day is ignored)
//   bills       open and paid bills and receipts, by line: own-use lines carry their share of PST/RST,
//               resale lines none (lib/rst.js); lines received into stock are inventory; truck lines
//               (equipmentId) are never job cost; supplier credits inherit the original line's job
//   stock       moves onto the job at the server-stamped unit cost, returns to a van or the shop netted;
//               own-use material on warranty and callback jobs adds self-assessed RST
//   requests    fulfilled material requests no stock move, bill or purchase order covers
//   accrued     PO lines received to the job and not billed yet, at the PO price (dropped as bills arrive)
//   committed   open PO lines not received or billed (shown, never added to cost)
import { docTotals, lineCents, revenueCents, pctOfCents } from './money.js';
import { allocateOvertime, otRule, entryMinutes, isCorrection, weekOf, localDay } from './timesheet.js';
import { isTravel, isJobUse, isJobReturn, jobBillingMode, unbilledTm } from './tm.js';
import { burdenCache, rateEntryOn, FIELD_ROLES } from './burden.js';
import { billLineCosts, moveIsOwnUse, requestCovered, moveUnitCents, provincialRateOn, spread } from './rst.js';

/** Every collection the costing functions read (the server loads these; the PWA lists them). */
export const COST_COLLECTIONS = ['jobs', 'estimates', 'invoices', 'payments', 'timeEntries', 'stockMoves', 'materialRequests', 'bills',
  'purchaseOrders', 'items', 'employees', 'equipment', 'equipmentUse', 'vendors', 'locations', 'payrollRuns', 'fieldTickets'];
export const NO_CODE = 'none';
/** Hours in a working day, to turn an hour rate into a day rate and back for equipment use. */
export const HOURS_PER_DAY = 8;

const int = (v) => (Number.isInteger(v) ? v : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoDay = (v) => String(v || '').slice(0, 10);
const inRange = (d, from, to) => Boolean(d) && (!from || d >= from) && (!to || d <= to);
const r = Math.round;
const round2 = (n) => Math.round(n * 100) / 100;
const lineAmount = (l) => int(l?.amountCents) ?? r(num(l?.qty) * num(l?.unitCents));
const codeKey = (id) => id || NO_CODE;

// ---- rates ---------------------------------------------------------------------------------------

/** An equipment record's rate on a day: { rateCents, rateUnit } from its history, else its current rate. */
export function equipmentRateOn(eq, day) {
  const e = rateEntryOn(eq?.rateHistory, day);
  const rateCents = e ? num(e.rateCents) : num(eq?.rateCents);
  const rateUnit = (e?.rateUnit || eq?.rateUnit) === 'day' ? 'day' : 'hour';
  return { rateCents, rateUnit };
}

/** Cost of `qty` `unit`s of equipment at a rate, converting hours and days at HOURS_PER_DAY. */
export function equipmentCents(qty, unit, { rateCents, rateUnit }) {
  const q = num(qty);
  if (!q || !rateCents) return 0;
  if ((unit === 'day') === (rateUnit === 'day')) return r(q * rateCents);
  return unit === 'day' ? r(q * HOURS_PER_DAY * rateCents) : r((q / HOURS_PER_DAY) * rateCents);
}

export { rateOn } from './burden.js';

// ---- trucks --------------------------------------------------------------------------------------

/**
 * Trucks on time entries (`equipmentId`), charged once per truck and day: an hour rate on the union
 * of the intervals of every entry carrying that truck that day, a day rate once; the charge is split
 * across that day's jobs (and cost codes) by the hours of the entries on each.
 * @returns {Array<{ equipmentId, day, jobId, costCodeId, minutes, cents }>}
 */
export function truckCharges({ timeEntries = [], equipment = [], dayOf = localDay, now = Date.now(), from = '', to = '' } = {}) {
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const groups = new Map();
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  for (const t of timeEntries) {
    if (!t?.equipmentId || !t.clockIn || isCorrection(t)) continue;
    const eq = eqById.get(t.equipmentId);
    if (!eq) continue;
    const day = dayOf(t.clockIn);
    if (!inRange(day, from, to)) continue;
    const k = `${t.equipmentId}|${day}`;
    if (!groups.has(k)) groups.set(k, { eq, day, entries: [] });
    groups.get(k).entries.push(t);
  }
  const out = [];
  for (const { eq, day, entries } of groups.values()) {
    const rate = equipmentRateOn(eq, day);
    if (!rate.rateCents) continue;
    let cents;
    if (rate.rateUnit === 'day') cents = rate.rateCents;
    else {
      const spans = entries.map((t) => [Date.parse(t.clockIn), t.clockOut ? Date.parse(t.clockOut) : nowMs]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a, b) => a[0] - b[0]);
      let ms = 0, curA = null, curB = null;
      for (const [a, b] of spans) {
        if (curB == null || a > curB) { if (curB != null) ms += curB - curA; curA = a; curB = b; } else curB = Math.max(curB, b);
      }
      if (curB != null) ms += curB - curA;
      cents = r((ms / 3_600_000) * rate.rateCents);
    }
    const parts = new Map();
    for (const t of entries) {
      const k = `${t.jobId || ''}|${t.costCodeId || ''}`;
      if (!parts.has(k)) parts.set(k, { jobId: t.jobId || null, costCodeId: t.costCodeId || null, minutes: 0 });
      parts.get(k).minutes += Math.max(0, entryMinutes(t, nowMs));
    }
    const list = [...parts.values()];
    const shares = spread(cents, list.map((p) => p.minutes || 1));
    list.forEach((p, i) => out.push({ equipmentId: eq.id, day, jobId: p.jobId, costCodeId: p.costCodeId, minutes: p.minutes, cents: shares[i] }));
  }
  return out;
}

// ---- purchase orders: received, billed, committed -------------------------------------------------

const lineJob = (po, l) => l?.jobId || po?.jobId || null;
const receiveMovesOf = (stockMoves, poId, index) => stockMoves.filter((m) => m?.use === 'receive' && m.poId === poId && m.poLineIndex === index);

/** Quantity received on a PO line by `asOf`: its receive moves when there are any, else receivedQty (dated receivedAt). */
export function receivedQtyAsOf(po, index, { stockMoves = [], asOf = '' } = {}) {
  const moves = receiveMovesOf(stockMoves, po?.id, index);
  if (moves.length) return round2(moves.filter((m) => !asOf || (m.date || isoDay(m.createdAt)) <= asOf).reduce((s, m) => s + num(m.qty), 0));
  const l = po?.lines?.[index];
  if (!(num(l?.receivedQty) > 0)) return 0;
  return !asOf || !l.receivedAt || isoDay(l.receivedAt) <= asOf ? num(l.receivedQty) : 0;
}

/** Where a PO line's material went: 'stock' (received into a location), 'job', or 'overhead'. */
export function receiptDestination(po, index, { stockMoves = [] } = {}) {
  const moves = receiveMovesOf(stockMoves, po?.id, index);
  if (moves.some((m) => m.toLocationId)) return 'stock';
  if (moves.some((m) => m.jobId)) return 'job';
  return lineJob(po, po?.lines?.[index]) ? 'job' : 'overhead';
}

/** Quantity billed per PO line by `asOf` (open and paid bills, and drafts when `drafts`), as [qty]. */
export function billedQtyByLine(po, bills = [], { asOf = '', drafts = false } = {}) {
  const qty = (po?.lines || []).map(() => 0);
  for (const b of bills) {
    if (!b || b.status === 'void' || (!drafts && b.status === 'draft')) continue;
    if (asOf && (b.date || isoDay(b.createdAt)) > asOf) continue;
    for (const l of b.lines || []) {
      if (l?.poLine?.purchaseOrderId !== po.id) continue;
      const i = l.poLine.index;
      if (Number.isInteger(i) && i >= 0 && i < qty.length) qty[i] = round2(qty[i] + num(l.qty));
    }
  }
  return qty;
}

/**
 * PO lines received and not billed (an accrued liability; job cost when received to the job):
 * [{ purchaseOrderId, number, index, jobId, destination, qty, unitCents, cents }] at the PO price.
 */
export function receivedNotBilled({ purchaseOrders = [], bills = [], stockMoves = [], jobId = null, asOf = '' } = {}) {
  const out = [];
  for (const po of purchaseOrders) {
    if (!po || ['draft', 'cancelled'].includes(po.status || 'draft')) continue;
    const billed = billedQtyByLine(po, bills, { asOf });
    (po.lines || []).forEach((l, index) => {
      const received = receivedQtyAsOf(po, index, { stockMoves, asOf });
      const qty = round2(received - billed[index]);
      if (!(qty > 0)) return;
      const destination = receiptDestination(po, index, { stockMoves });
      const job = destination === 'stock' ? null : lineJob(po, l);
      if (jobId && (job !== jobId || destination !== 'job')) return;
      out.push({ purchaseOrderId: po.id, number: po.number || '', index, jobId: job, destination, description: l.description || '', qty, unitCents: num(l.unitCents), cents: r(qty * num(l.unitCents)) });
    });
  }
  return out;
}

/**
 * Open and sent PO lines on a job not yet received or billed: (qty − received − billed beyond what was
 * received) × unit price. Shown separately, never added to cost to date.
 */
export function committedCost({ purchaseOrders = [], bills = [], stockMoves = [], jobId = null, asOf = '' } = {}) {
  const rows = [];
  for (const po of purchaseOrders) {
    if (!po || !['open', 'sent'].includes(po.status)) continue;
    if (asOf && po.date && po.date > asOf) continue;
    const billed = billedQtyByLine(po, bills, { asOf });
    (po.lines || []).forEach((l, index) => {
      const job = lineJob(po, l);
      if (jobId && job !== jobId) return;
      const received = receivedQtyAsOf(po, index, { stockMoves, asOf });
      const qty = round2(num(l.qty) - Math.max(received, billed[index]));
      if (!(qty > 0)) return;
      rows.push({ purchaseOrderId: po.id, number: po.number || '', index, jobId: job, description: l.description || '', qty, unitCents: num(l.unitCents), cents: r(qty * num(l.unitCents)) });
    });
  }
  return { cents: rows.reduce((s, x) => s + x.cents, 0), rows };
}

// ---- contract value and budget ---------------------------------------------------------------------

const acceptedAt = (e) => String(e?.signedAt || e?.acceptedAt || e?.issueDate || e?.updatedAt || e?.createdAt || '');
const onJob = (job, e) => e && (e.jobId === job?.id || (job?.estimateId && e.id === job.estimateId));

/**
 * The estimate a job's contract comes from: the latest accepted one that is not superseded (a signed
 * estimate's revision replaces it), or null.
 */
export function contractEstimate(job, estimates = []) {
  const mine = estimates.filter((e) => onJob(job, e));
  const revised = new Set(mine.filter((e) => e.status === 'accepted' && e.revisionOf).map((e) => e.revisionOf));
  const accepted = mine.filter((e) => e.status === 'accepted' && !revised.has(e.id)).sort((a, b) => acceptedAt(b).localeCompare(acceptedAt(a)));
  return accepted[0] || null;
}

/** Approved change orders on or before asOf (by approvedOn; one without a date counts). */
export function approvedChangeOrders(job, { asOf = '' } = {}) {
  return (job?.changeOrders || []).filter((c) => c && c.status === 'approved' && (!asOf || String(c.approvedOn || c.date || '') <= asOf));
}

/**
 * Contract value: contract.valueCents when set, else the latest accepted estimate that is not
 * superseded (before tax, markup in), plus change orders approved on or before asOf.
 */
export function contractValue(job, estimates = [], { asOf = '' } = {}) {
  const co = approvedChangeOrders(job, { asOf }).reduce((s, c) => s + num(c.amountCents), 0);
  if (Number.isInteger(job?.contract?.valueCents)) return job.contract.valueCents + co;
  const est = contractEstimate(job, estimates);
  return (est ? docTotals(est).workSubtotalCents : 0) + co;
}

/** A budget's total cost. */
export const budgetTotal = (b) => (b ? num(b.labourCostCents) + num(b.materialCents) + num(b.subCents) + num(b.equipmentCents) + num(b.otherCents) : 0);

/**
 * The cost budget of an estimate: labour at the burdened cost per productive hour on the acceptance
 * day (breakEven: the same basis as actual labour), material at the item's cost, other and
 * subcontract lines at their cost, else the price over 1 + markup. R1-D stores it on the job when the
 * estimate is accepted (jobs.costing.budget); older jobs compute it on the fly.
 */
export function budgetFromEstimate(estimate, { items = [], employees = [], equipment = [], rules = null, settings = null, on = null, fallbackRateCents = null } = {}) {
  const day = isoDay(on || estimate?.signedAt || estimate?.issueDate) || new Date().toISOString().slice(0, 10);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const be = breakEven({ employees, equipment, rules, settings, on: day });
  const rate = be.rows.length && be.burdenedCostPerProductiveHourCents ? be.burdenedCostPerProductiveHourCents : num(fallbackRateCents);
  const markup = num(estimate?.markupPct ?? settings?.markupPct);
  const byCostCode = {};
  const add = (cc, cents, hours = 0) => {
    const k = codeKey(cc);
    byCostCode[k] = byCostCode[k] || { estCents: 0, hours: 0 };
    byCostCode[k].estCents += cents; byCostCode[k].hours = round2(byCostCode[k].hours + hours);
  };
  let materialCents = 0, subCents = 0, equipmentCents = 0, otherCents = 0, labourHours = 0;
  for (const l of estimate?.lines || []) {
    if (l?.lineType) continue;
    const qty = num(l.qty);
    const perUnit = num(l.labourHours);
    const lh = l.kind === 'labour' ? qty : qty * perUnit;
    labourHours += lh;
    let cost = 0;
    const costOf = () => (l.costCents != null ? r(qty * num(l.costCents)) : r(lineCents(l) / (1 + markup / 100)));
    if (l.kind === 'labour') cost = 0;
    else if (l.kind === 'other') {
      cost = costOf();
      if (l.costType === 'subcontract' || l.subcontract) subCents += cost;
      else if (l.costType === 'equipment') equipmentCents += cost;
      else otherCents += cost;
    } else {
      const it = l.itemId ? itemById.get(l.itemId) : null;
      cost = it ? r(qty * num(it.costCents)) : costOf();
      materialCents += cost;
    }
    add(l.costCodeId, cost + r(lh * rate), lh);
  }
  labourHours = round2(labourHours);
  return { at: day, estimateId: estimate?.id || null, labourHours, labourRateCents: rate, labourCostCents: r(labourHours * rate), materialCents, subCents, equipmentCents, otherCents, byCostCode };
}

/** Average cost rate of the job's crew (else everyone active): the old basis, kept as the fallback. */
export function crewAverageRate(job, employees = []) {
  const empById = new Map(employees.map((e) => [e.id, e]));
  const crew = (job?.crewIds || []).map((id) => empById.get(id)).filter((e) => e && num(e.rateCents) > 0);
  const pool = crew.length ? crew : employees.filter((e) => e.active !== false && num(e.rateCents) > 0);
  return pool.length ? r(pool.reduce((s, e) => s + num(e.rateCents), 0) / pool.length) : 0;
}

/**
 * A job's estimated cost: costing.estCostOverrideCents, else its budget (stored at acceptance, or
 * from the contract estimate) plus each approved change order's budget (its estCostCents, else its
 * amount × the budget's share of the estimate's subtotal).
 */
export function estimatedCost(job, { estimates = [], items = [], employees = [], equipment = [], rules = null, settings = null, asOf = '', estimate = undefined } = {}) {
  const est = estimate === undefined ? contractEstimate(job, estimates) : estimate;
  const stored = job?.costing?.budget;
  const budget = stored && (!est || !stored.estimateId || stored.estimateId === est.id) ? stored
    : est ? budgetFromEstimate(est, { items, employees, equipment, rules, settings, fallbackRateCents: crewAverageRate(job, employees) }) : null;
  const base = budgetTotal(budget);
  const subtotal = est ? docTotals(est).workSubtotalCents : 0;
  const ratio = subtotal ? base / subtotal : 0;
  const coBudgetCents = approvedChangeOrders(job, { asOf }).reduce((s, c) => s + (Number.isInteger(c.estCostCents) ? c.estCostCents : r(num(c.amountCents) * ratio)), 0);
  const override = int(job?.costing?.estCostOverrideCents);
  return { estCostCents: override ?? base + coBudgetCents, budget, coBudgetCents, override: override != null, estimate: est };
}

// ---- actual cost -----------------------------------------------------------------------------------

/**
 * Everything a job has cost (6.1). Sources are full lists (all jobs): overtime and truck intervals are
 * worked out across them. `dayOf` turns a timestamp into the company's day (the PWA passes ui.localDay,
 * the server the company's zone).
 */
export function jobActuals({
  job, timeEntries = [], stockMoves = [], materialRequests = [], items = [], employees = [], bills = [], vendors = [],
  purchaseOrders = [], equipment = [], equipmentUse = [], rules = null, settings = null, from = '', asOf = '', now = Date.now(), dayOf = localDay,
} = {}) {
  const jobId = job?.id;
  const nowMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const billById = new Map(bills.map((b) => [b.id, b]));
  const burden = burdenCache({ rules, settings });
  const province = settings?.company?.province || 'ON';
  const byCostCode = {};
  const code = (cc) => { const k = codeKey(cc); byCostCode[k] = byCostCode[k] || { estCents: 0, actualCents: 0, hours: 0 }; return byCostCode[k]; };
  const entryDayOf = (e) => (isCorrection(e) ? (e.workDay || null) : e?.clockIn ? dayOf(e.clockIn) : null);

  // ---- labour ----
  const prefs = settings?.payroll || {};
  const rule = otRule(prefs.otRule || province);
  const weekStartsOn = Number.isInteger(prefs.weekStartsOn) ? prefs.weekStartsOn : 1;
  const mine = timeEntries.filter((t) => t?.jobId === jobId && (t.clockIn || (isCorrection(t) && t.workDay)) && inRange(entryDayOf(t), from, asOf || '9999-12-31'));
  // Overtime is the person's whole week (every job), so allocate per person and week first.
  const weeks = new Set(mine.map((t) => `${t.employeeId}|${weekOf(entryDayOf(t), weekStartsOn)}`));
  const split = new Map();
  if (weeks.size) {
    const byWeek = new Map();
    for (const t of timeEntries) {
      const d = entryDayOf(t);
      if (!d) continue;
      const k = `${t.employeeId}|${weekOf(d, weekStartsOn)}`;
      if (!weeks.has(k)) continue;
      if (!byWeek.has(k)) byWeek.set(k, []);
      byWeek.get(k).push(t);
    }
    for (const list of byWeek.values()) for (const [id, a] of allocateOvertime(list, rule, { dayOf, now: nowMs })) split.set(id, a);
  }
  let hours = 0, travelHours = 0, wage = 0, burdenPart = 0, otPremium = 0, burdenMissing = false;
  for (const t of mine) {
    const minutes = entryMinutes(t, nowMs);
    const d = entryDayOf(t);
    const emp = empById.get(t.employeeId) || {};
    const b = burden(emp, d);
    if (b.wageCents > 0 && b.costPerPaidHourCents <= b.wageCents) burdenMissing = true;
    const h = minutes / 60;
    if (isTravel(t)) travelHours += h; else hours += h;
    const w = h * b.wageCents;
    const bp = h * (b.costPerPaidHourCents - b.wageCents);
    const a = split.get(t.id) || { ot: 0, dt: 0 };
    const prem = ((a.ot / 60) * 0.5 + (a.dt / 60) * 1) * b.wageCents * (1 + b.statutoryPct / 100);
    wage += w; burdenPart += bp; otPremium += prem;
    const c = code(t.costCodeId);
    c.actualCents += w + bp + prem; c.hours += h;
  }
  const labourWageCents = r(wage), burdenCents = r(burdenPart), otPremiumCents = r(otPremium);
  const labourCents = labourWageCents + burdenCents + otPremiumCents;

  // ---- trucks and equipment ----
  const trucks = truckCharges({ timeEntries, equipment, dayOf, now: nowMs, from, to: asOf });
  const truckDays = new Set(trucks.map((x) => `${x.equipmentId}|${x.day}`));
  let truckCents = 0;
  for (const x of trucks) if (x.jobId === jobId) { truckCents += x.cents; code(x.costCodeId).actualCents += x.cents; }
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  let usageCents = 0;
  for (const u of equipmentUse) {
    if (u?.jobId !== jobId || !inRange(u.date, from, asOf)) continue;
    if (u.source === 'ticket' && truckDays.has(`${u.equipmentId}|${u.date}`)) continue;
    const eq = eqById.get(u.equipmentId);
    if (!eq) continue;
    const c = equipmentCents(u.qty, u.unit, equipmentRateOn(eq, u.date));
    usageCents += c; code(u.costCodeId).actualCents += c;
  }

  // ---- bills and receipts ----
  const byType = { material: 0, subcontract: 0, equipment: 0, other: 0 };
  let billsCents = 0;
  const poById = new Map(purchaseOrders.map((p) => [p.id, p]));
  for (const b of bills) {
    if (!['open', 'paid'].includes(b?.status)) continue;
    const d = b.date || isoDay(b.createdAt);
    if (!inRange(d, from, asOf)) continue;
    const orig = b.reversesId ? billById.get(b.reversesId) : null;
    const costs = billLineCosts(b, { vendor: vendorById.get(b.vendorId) || null });
    (b.lines || []).forEach((l, i) => {
      if (l?.equipmentId) return; // truck cost, never job cost
      const lineJobId = l?.jobId || b.jobId || (orig ? orig.lines?.[i]?.jobId || orig.jobId : null);
      if (lineJobId !== jobId) return;
      const po = l?.poLine?.purchaseOrderId ? poById.get(l.poLine.purchaseOrderId) : null;
      if (po && receiptDestination(po, l.poLine.index, { stockMoves }) === 'stock') return; // inventory: the issue move carries it
      const cents = costs[i].costCents;
      const type = ['subcontract', 'equipment', 'other'].includes(l.costType) ? l.costType : 'material';
      byType[type] += cents; billsCents += cents;
      code(l.costCodeId).actualCents += cents;
    });
  }

  // ---- stock moves and requests ----
  let materialCents = 0, selfAssessedRstCents = 0, returnsCents = 0;
  const own = (rec, cost, d) => {
    if (!moveIsOwnUse(rec, job)) return 0;
    const rst = pctOfCents(cost, provincialRateOn(province, d));
    selfAssessedRstCents += rst;
    return rst;
  };
  for (const m of stockMoves) {
    const use = isJobUse(m, jobId), back = !use && isJobReturn(m, jobId);
    if (!use && !back) continue;
    const d = m.date || dayOf(m.createdAt);
    if (!inRange(d, from, asOf)) continue;
    const cost = r(num(m.qty) * moveUnitCents(m, itemById.get(m.itemId)));
    const cents = back ? -cost : cost + own(m, cost, d);
    if (back) returnsCents += cost;
    materialCents += cents; code(m.costCodeId).actualCents += cents;
  }
  const moveIds = new Set(stockMoves.map((m) => m.id));
  for (const q of materialRequests) {
    if (q?.jobId !== jobId || q.status !== 'fulfilled') continue;
    if (requestCovered(q, { moveIds, bills, purchaseOrders })) continue;
    const d = dayOf(q.fulfilledAt || q.updatedAt || q.createdAt);
    if (!inRange(d, from, asOf)) continue;
    const cost = r(num(q.qty) * num(q.costCents ?? itemById.get(q.itemId)?.costCents));
    const cents = cost + own(q, cost, d);
    materialCents += cents; code(q.costCodeId).actualCents += cents;
  }

  // ---- accrued and committed ----
  const accrued = receivedNotBilled({ purchaseOrders, bills, stockMoves, jobId, asOf });
  const accruedCents = accrued.reduce((s, x) => s + x.cents, 0);
  for (const x of accrued) code(purchaseOrders.find((p) => p.id === x.purchaseOrderId)?.lines?.[x.index]?.costCodeId).actualCents += x.cents;
  const committed = committedCost({ purchaseOrders, bills, stockMoves, jobId, asOf });

  for (const k of Object.keys(byCostCode)) { byCostCode[k].actualCents = r(byCostCode[k].actualCents); byCostCode[k].hours = round2(byCostCode[k].hours); }
  const equipmentUseCents = truckCents + usageCents;
  const costCents = labourCents + materialCents + billsCents + equipmentUseCents + accruedCents;
  return {
    hours: round2(hours), travelHours: round2(travelHours),
    labourCents, labourWageCents, burdenCents, otPremiumCents, burdenMissing,
    materialCents, selfAssessedRstCents, returnsCents,
    billsCents, subcontractCents: byType.subcontract, equipmentCents: equipmentUseCents + byType.equipment, otherCents: byType.other,
    truckCents, equipmentUseCents, accruedCents, accrued, committedCents: committed.cents, committed: committed.rows, costCents,
    byType: { labour: labourCents, material: materialCents + byType.material, subcontract: byType.subcontract, equipment: equipmentUseCents + byType.equipment, other: byType.other, accrued: accruedCents },
    byCostCode,
  };
}

/** Bills on a job with price variances nobody has acknowledged (the job's varianceCount). */
export function jobVarianceCount(jobId, { bills = [], purchaseOrders = [], items = [], tolerancePct = 2 } = {}) {
  return bills.filter((b) => ['open', 'paid'].includes(b?.status) && !b.varianceAck
    && ((b.jobId === jobId) || (b.lines || []).some((l) => l?.jobId === jobId))
    && priceVariances(b, { purchaseOrders, items, tolerancePct }).length).length;
}

// ---- price variances -----------------------------------------------------------------------------

/**
 * Bill lines priced above their reference: the PO line's price (which may be a wholesaler's job
 * quote, quoteRef), else the price book's cost. Bills never change the price book, so the comparison
 * stays meaningful. Flagged when over by more than tolerancePct and more than $1.00 on the line.
 * @returns {Array<{ lineIndex, billUnitCents, refUnitCents, refKind: 'po'|'price-book', quoteRef, overPct, overCents }>}
 */
export function priceVariances(bill, { purchaseOrders = [], items = [], tolerancePct = 2, minCents = 100 } = {}) {
  const out = [];
  const poById = new Map(purchaseOrders.map((p) => [p.id, p]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  (bill?.lines || []).forEach((l, lineIndex) => {
    const qty = num(l?.qty);
    const amount = lineAmount(l);
    if (!(qty > 0) || !(amount > 0)) return;
    const billUnitCents = int(l.unitCents) ?? r(amount / qty);
    let ref = null, refKind = null, quoteRef = null;
    if (l.poLine?.purchaseOrderId) {
      const pl = poById.get(l.poLine.purchaseOrderId)?.lines?.[l.poLine.index];
      if (pl && int(pl.unitCents) > 0) { ref = pl.unitCents; refKind = 'po'; quoteRef = pl.quoteRef || null; }
    }
    if (ref == null && l.itemId) {
      const it = itemById.get(l.itemId);
      if (it && int(it.costCents) > 0) { ref = it.costCents; refKind = 'price-book'; }
    }
    if (ref == null) return;
    const overCents = amount - r(qty * ref);
    const overPct = Math.round(((billUnitCents - ref) / ref) * 10000) / 100;
    if (overPct > num(tolerancePct) && overCents > minCents) out.push({ lineIndex, billUnitCents, refUnitCents: ref, refKind, quoteRef, overPct, overCents });
  });
  return out;
}

// ---- break-even ------------------------------------------------------------------------------------

/**
 * The break-even billing rate (6.5): field roles' cost per paid hour × annual hours, plus the year's
 * overhead, over their productive hours. Equipment recovery is shown beside it, never added. Without
 * overhead the result is "labour cost only, not break-even" (labourOnly). Target = break-even ÷
 * (1 − target margin).
 */
export function breakEven({ employees = [], equipment = [], rules = null, settings = null, year = null, on = null } = {}) {
  const day = isoDay(on) || `${Number(year) || new Date().getFullYear()}-07-01`;
  const costing = settings?.costing || {};
  const burden = burdenCache({ rules, settings });
  const rows = [];
  let annualCost = 0, productive = 0;
  const warnings = new Set();
  for (const e of employees) {
    if (!e || e.active === false || !FIELD_ROLES.includes(e.role)) continue;
    const b = burden(e, day);
    if (!(b.wageCents > 0)) continue;
    const prodHours = b.annualHours * (1 - b.nonProductivePct / 100);
    annualCost += b.costPerPaidHourCents * b.annualHours;
    productive += prodHours;
    b.warnings.forEach((w) => warnings.add(w));
    rows.push({ employeeId: e.id, name: e.name || '', role: e.role, wageCents: b.wageCents, statutoryPct: b.statutoryPct, costPerPaidHourCents: b.costPerPaidHourCents, costPerProductiveHourCents: b.costPerProductiveHourCents, warnings: b.warnings });
  }
  const burdened = productive ? r(annualCost / productive) : 0;
  const overhead = int(costing.overheadAnnualCents);
  const overheadPer = overhead != null && productive ? r(overhead / productive) : null;
  let recovery = 0;
  for (const q of equipment) {
    if (!q || q.active === false) continue;
    const rate = equipmentRateOn(q, day);
    const hoursYear = num(costing.annualHours) || 2000;
    recovery += rate.rateUnit === 'day' ? rate.rateCents * (hoursYear / HOURS_PER_DAY) : rate.rateCents * hoursYear;
  }
  const equipmentRecoveryPerProductiveHourCents = productive ? r(recovery / productive) : 0;
  const breakEvenRateCents = burdened + (overheadPer ?? 0);
  const margin = costing.targetMarginPct == null || costing.targetMarginPct === '' ? null : num(costing.targetMarginPct);
  const targetRateCents = margin != null && margin < 100 && breakEvenRateCents ? r(breakEvenRateCents / (1 - margin / 100)) : null;
  return {
    rows: rows.sort((a, b) => a.name.localeCompare(b.name)), burdenedCostPerProductiveHourCents: burdened, overheadPerProductiveHourCents: overheadPer,
    equipmentRecoveryPerProductiveHourCents, breakEvenRateCents, targetRateCents, labourOnly: overheadPer == null, productiveHours: r(productive), warnings: [...warnings],
  };
}

/**
 * Per truck or piece of equipment for a period: what job charges recovered (truck charges and use
 * records) against what it actually cost (bill lines with its equipmentId: fuel, repairs, lease).
 */
export function equipmentRecovery({ equipment = [], timeEntries = [], equipmentUse = [], bills = [], vendors = [], from = '', to = '', dayOf = localDay, now = Date.now() } = {}) {
  const rows = new Map(equipment.map((e) => [e.id, { equipmentId: e.id, name: e.name || '', kind: e.kind || 'equipment', recoveredCents: 0, actualCents: 0 }]));
  const trucks = truckCharges({ timeEntries, equipment, dayOf, now, from, to });
  const truckDays = new Set(trucks.map((x) => `${x.equipmentId}|${x.day}`));
  for (const x of trucks) if (rows.has(x.equipmentId)) rows.get(x.equipmentId).recoveredCents += x.cents;
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  for (const u of equipmentUse) {
    if (!rows.has(u?.equipmentId) || !inRange(u.date, from, to)) continue;
    if (u.source === 'ticket' && truckDays.has(`${u.equipmentId}|${u.date}`)) continue;
    rows.get(u.equipmentId).recoveredCents += equipmentCents(u.qty, u.unit, equipmentRateOn(eqById.get(u.equipmentId), u.date));
  }
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  for (const b of bills) {
    if (!['open', 'paid'].includes(b?.status) || !inRange(b.date, from, to)) continue;
    const costs = billLineCosts(b, { vendor: vendorById.get(b.vendorId) || null });
    (b.lines || []).forEach((l, i) => { if (rows.has(l?.equipmentId)) rows.get(l.equipmentId).actualCents += costs[i].costCents; });
  }
  return [...rows.values()].map((x) => ({ ...x, differenceCents: x.recoveredCents - x.actualCents }));
}

// ---- revenue, job profit and WIP -----------------------------------------------------------------

/** Revenue billed on a job (money.js revenueCents) for invoices dated in from..asOf. */
export function billedRevenue(jobId, invoices = [], { from = '', asOf = '' } = {}) {
  return invoices.filter((i) => i?.jobId === jobId && inRange(i.issueDate || isoDay(i.createdAt), from, asOf || '9999-12-31'))
    .reduce((s, i) => s + revenueCents(i, { asOf: asOf || null }), 0);
}

/** Is this a job WIP reports on? Fixed price or T&M; never a service call, warranty, callback or unbilled job, never cancelled. */
export const wipEligible = (job) => Boolean(job) && !['service', 'warranty', 'callback'].includes(job.kind) && job.billable !== false && job.status !== 'cancelled' && job.status !== 'lead';
const OPEN_STATUSES = new Set(['scheduled', 'in-progress', 'on-hold']);
const DONE_STATUSES = new Set(['complete', 'invoiced']);

/** The job's profit for a period: revenue, cost by type and cost code (accrued included), margin, budget margin, committed. */
export function jobProfit({ job, estimates = [], invoices = [], from = '', to = '', ...sources } = {}) {
  const a = jobActuals({ job, from, asOf: to, ...sources });
  const revenue = billedRevenue(job.id, invoices, { from, asOf: to });
  const est = estimatedCost(job, { estimates, ...sources, asOf: to });
  const contract = contractValue(job, estimates, { asOf: to });
  for (const [k, v] of Object.entries(est.budget?.byCostCode || {})) {
    a.byCostCode[k] = a.byCostCode[k] || { estCents: 0, actualCents: 0, hours: 0 };
    a.byCostCode[k].estCents = num(v.estCents);
  }
  const gross = revenue - a.costCents;
  return {
    jobId: job.id, number: job.number || '', title: job.title || '', status: job.status || '', mode: jobBillingMode(job),
    revenueCents: revenue, costCents: a.costCents, grossProfitCents: gross, marginPct: revenue ? round2((gross / revenue) * 100) : null,
    contractCents: contract, estCostCents: est.estCostCents, budgetMarginPct: contract && est.estCostCents > 0 ? round2(((contract - est.estCostCents) / contract) * 100) : null,
    committedCents: a.committedCents, accruedCents: a.accruedCents, hours: a.hours, travelHours: a.travelHours,
    byType: a.byType, byCostCode: a.byCostCode, burdenMissing: a.burdenMissing, actuals: a, budget: est.budget,
  };
}

/** Percent complete from a job's override (a fraction or a percentage), else null. */
function pctOverride(job) {
  const v = job?.costing?.pctCompleteOverride;
  if (v == null || v === '' || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
}

/**
 * One job's WIP line as of `asOf` (11). Fixed price: pct = min(1, cost to date ÷ estimated cost) or the
 * override; earned = contract × pct, or, when the projected gross profit is negative, cost to date +
 * projected gross profit (the whole loss now). T&M: earned = billed + unbilled T&M at sell.
 */
export function wipRow(job, { estimates = [], invoices = [], asOf = '', ...sources } = {}) {
  const a = jobActuals({ job, asOf, ...sources });
  const billed = billedRevenue(job.id, invoices, { asOf });
  if (jobBillingMode(job) === 'tm') {
    const u = unbilledTm({ job, settings: sources.settings, timeEntries: sources.timeEntries, stockMoves: sources.stockMoves, materialRequests: sources.materialRequests,
      items: sources.items, employees: sources.employees, invoices, to: asOf, dayOf: sources.dayOf });
    const earned = billed + u.totalCents;
    return { jobId: job.id, number: job.number || '', title: job.title || '', mode: 'tm', contractCents: null, estCostCents: null, costToDateCents: a.costCents,
      pct: null, earnedCents: earned, billedCents: billed, overBilledCents: 0, underBilledCents: u.totalCents, projectedGrossProfitCents: null, lossProvisionCents: 0, accruedCents: a.accruedCents };
  }
  const contract = contractValue(job, estimates, { asOf });
  const est = estimatedCost(job, { estimates, ...sources, asOf });
  const override = pctOverride(job);
  const pct = override ?? (est.estCostCents > 0 ? Math.min(1, a.costCents / est.estCostCents) : 0);
  const projected = contract - est.estCostCents;
  let earned = r(contract * pct);
  let loss = 0;
  if (projected < 0) { const withLoss = a.costCents + projected; loss = earned - withLoss; earned = withLoss; }
  return {
    jobId: job.id, number: job.number || '', title: job.title || '', mode: 'fixed', contractCents: contract, estCostCents: est.estCostCents, costToDateCents: a.costCents,
    pct: Math.round(pct * 10000) / 10000, pctOverridden: override != null, noEstimate: !(est.estCostCents > 0) && override == null,
    earnedCents: earned, billedCents: billed, overBilledCents: Math.max(0, billed - earned), underBilledCents: Math.max(0, earned - billed),
    projectedGrossProfitCents: projected, lossProvisionCents: Math.max(0, loss), accruedCents: a.accruedCents,
  };
}

/** The fiscal year's first day for a day: settings.company.fiscalYearStart ('MM-DD', default '01-01'). */
export function fiscalYearStart(settings, day) {
  const mmdd = /^\d{2}-\d{2}$/.test(String(settings?.company?.fiscalYearStart || '')) ? settings.company.fiscalYearStart : '01-01';
  const y = Number(String(day).slice(0, 4));
  const start = `${y}-${mmdd}`;
  return start <= day ? start : `${y - 1}-${mmdd}`;
}

const completedOn = (job) => isoDay(job?.contract?.completedOn || job?.completedAt || job?.closeout?.checkedAt || job?.updatedAt);

/**
 * WIP as of a day: one row per open job (service calls excluded), totals, and the contracts completed
 * this fiscal year (contract, cost, gross profit) for the bonding company.
 */
export function wipReport({ jobs = [], asOf = '', ...sources } = {}) {
  const day = asOf || new Date().toISOString().slice(0, 10);
  const rows = jobs.filter((j) => wipEligible(j) && (OPEN_STATUSES.has(j.status || 'scheduled') || (j.status === 'complete' && jobBillingMode(j) === 'tm'))).map((j) => wipRow(j, { asOf: day, ...sources }))
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  const sum = (k, list = rows) => list.reduce((s, x) => s + num(x[k]), 0);
  const fy = fiscalYearStart(sources.settings, day);
  const completed = jobs.filter((j) => wipEligible(j) && DONE_STATUSES.has(j.status) && jobBillingMode(j) === 'fixed' && inRange(completedOn(j), fy, day)).map((j) => {
    const contract = contractValue(j, sources.estimates || [], { asOf: day });
    const cost = jobActuals({ job: j, asOf: day, ...sources }).costCents;
    return { jobId: j.id, number: j.number || '', title: j.title || '', completedOn: completedOn(j), contractCents: contract, costCents: cost, grossProfitCents: contract - cost };
  });
  return {
    asOf: day, fiscalYearStart: fy, rows,
    totals: {
      contractCents: sum('contractCents', rows.filter((x) => x.mode === 'fixed')), estCostCents: sum('estCostCents', rows.filter((x) => x.mode === 'fixed')),
      costToDateCents: sum('costToDateCents'), earnedCents: sum('earnedCents'), billedCents: sum('billedCents'),
      overBilledCents: sum('overBilledCents'), underBilledCents: sum('underBilledCents'), lossProvisionCents: sum('lossProvisionCents'),
    },
    completed,
    completedTotals: { contractCents: sum('contractCents', completed), costCents: sum('costCents', completed), grossProfitCents: sum('grossProfitCents', completed) },
  };
}

/** The job-profit list for a period: every job with revenue or cost in it. */
export function jobProfitList({ jobs = [], from = '', to = '', ...sources } = {}) {
  return jobs.filter((j) => j && j.status !== 'lead').map((j) => jobProfit({ job: j, from, to, ...sources }))
    .filter((x) => x.revenueCents || x.costCents || x.committedCents)
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

/** CSV of WIP rows. */
export function wipCsv(report, { money = (c) => (c / 100).toFixed(2) } = {}) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const m = (c) => (c == null ? '' : money(c));
  const head = ['Job', 'Title', 'Mode', 'Contract', 'Estimated cost', 'Cost to date', 'Percent complete', 'Earned', 'Billed', 'Over billed', 'Under billed', 'Loss provision'];
  const lines = [head.join(',')];
  for (const x of report.rows) lines.push([x.number, x.title, x.mode, m(x.contractCents), m(x.estCostCents), m(x.costToDateCents), x.pct == null ? '' : (x.pct * 100).toFixed(1), m(x.earnedCents), m(x.billedCents), m(x.overBilledCents), m(x.underBilledCents), m(x.lossProvisionCents)].map(esc).join(','));
  const t = report.totals;
  lines.push(['Total', '', '', m(t.contractCents), m(t.estCostCents), m(t.costToDateCents), '', m(t.earnedCents), m(t.billedCents), m(t.overBilledCents), m(t.underBilledCents), m(t.lossProvisionCents)].map(esc).join(','));
  lines.push('', ['Completed this fiscal year', 'Title', 'Completed', 'Contract', 'Cost', 'Gross profit'].join(','));
  for (const x of report.completed) lines.push([x.number, x.title, x.completedOn, m(x.contractCents), m(x.costCents), m(x.grossProfitCents)].map(esc).join(','));
  return lines.join('\n');
}

/** CSV of the job-profit list. */
export function jobProfitCsv(list, { money = (c) => (c / 100).toFixed(2) } = {}) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Job', 'Title', 'Revenue', 'Labour', 'Material', 'Subcontract', 'Equipment', 'Other', 'Accrued', 'Cost', 'Gross profit', 'Margin %', 'Budget margin %', 'Committed'].join(',')];
  for (const x of list) {
    lines.push([x.number, x.title, money(x.revenueCents), money(x.byType.labour), money(x.byType.material), money(x.byType.subcontract), money(x.byType.equipment), money(x.byType.other), money(x.byType.accrued),
      money(x.costCents), money(x.grossProfitCents), x.marginPct ?? '', x.budgetMarginPct ?? '', money(x.committedCents)].map(esc).join(','));
  }
  return lines.join('\n');
}

