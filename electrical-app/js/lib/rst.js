// Purchase tax per bill line and the RST self-assessment view (docs/releases/r1-get-paid.md 3.5,
// docs/code/tax.md "Purchases", docs/office/job-costing.md). Pure, no DOM: job costing, the bill
// editor, the RST report, month-end, the server's reports and the QuickBooks bill push (R1-F) use it.
//
// Manitoba (Bulletin 031): material an electrical contractor installs under a contract is bought
// for resale (the contractor gives its RST number and charges RST on the contract), so RST a
// supplier charged on it is recoverable from the supplier, never cost. Material, tools and supplies
// the company uses itself (own use: warranty and no-charge work, the shop, trucks) carry RST as a
// cost; when the seller charged none (out-of-province sellers) the company self-assesses it.
// An electrical or mechanical subcontractor's work that TG resells (`vendors.meSubtrade`) is resale;
// any other subcontract is own use. GST, HST and QST are recoverable and never cost.
// Self-assessment here is a worksheet: QuickBooks files the RST return and does not include it.
import { ratesOn } from './tax.js';
import { pctOfCents } from './money.js';

/** Taxes that are a cost when the purchase is for own use (never recoverable as input tax credits). */
export const PROVINCIAL_TAX_IDS = ['PST', 'RST'];
export const TAX_USES = ['resale', 'own-use'];
export const TAX_USE_LABEL = { resale: 'Resale', 'own-use': 'Own use' };
export const OWN_USE_REASONS = ['warranty', 'no-charge', 'shop', 'truck', 'tools', 'other'];
export const OWN_USE_REASON_LABEL = { warranty: 'Warranty', 'no-charge': 'No charge', shop: 'Shop', truck: 'Truck', tools: 'Tools', other: 'Other' };
export const RESALE_RST_MESSAGE = 'Supplier charged RST on resale materials. Ask them for a credit.';
export const ADD_TO_RETURN = 'Add this to your RST return: QuickBooks does not include self-assessed RST. Suggested entry: Dr expense (or job cost) / Cr RST payable.';

const int = (v) => (Number.isInteger(v) ? v : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = (v) => String(v || '').slice(0, 10);
const inRange = (d, from, to) => Boolean(d) && (!from || d >= from) && (!to || d <= to);

/** A bill line's amount: as typed, else round(qty x unit cost) (lib/purchasing.js lineAmountCents). */
const lineAmount = (l) => int(l?.amountCents) ?? Math.round(num(l?.qty) * num(l?.unitCents));

/**
 * Resale or own use for one bill line. The only place the default lives (R1-F imports it):
 * the line's own `taxUse`; else material is resale, subcontract is resale only from an electrical or
 * mechanical subtrade (`vendor.meSubtrade`), equipment and other are own use.
 */
export function billLineTaxUse(line, { vendor = null } = {}) {
  if (TAX_USES.includes(line?.taxUse)) return line.taxUse;
  const type = line?.costType || 'material';
  if (type === 'material') return 'resale';
  if (type === 'subcontract') return vendor?.meSubtrade ? 'resale' : 'own-use';
  return 'own-use';
}

/** Split `total` over `weights` (largest remainder), so the parts add up to the total exactly. */
export function spread(total, weights) {
  const w = weights.map((x) => Math.abs(Number(x) || 0));
  const sum = w.reduce((s, x) => s + x, 0);
  if (!total || !sum) return w.map(() => 0);
  const exact = w.map((x) => (total * x) / sum);
  const out = exact.map((x) => Math.trunc(x));
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [Math.abs(x - out[i]), i]).sort((a, b) => b[0] - a[0]);
  const step = Math.sign(left);
  for (let k = 0; left !== 0 && k < order.length; k++) { out[order[k][1]] += step; left -= step; }
  return out;
}

/** PST/RST cents printed on a bill. */
export function billProvincialTaxCents(bill) {
  return (bill?.taxes || []).filter((t) => PROVINCIAL_TAX_IDS.includes(String(t?.id || '').toUpperCase())).reduce((s, t) => s + (int(t.cents) ?? 0), 0);
}

/**
 * Each line of a bill with its tax use and cost: [{ index, amountCents, taxUse, rstCents (its pro-rata
 * share of the PST/RST printed on the bill), costCents, flagged }]. Own-use lines carry their share
 * of PST/RST in cost; resale lines carry none unless the resale credit was written off
 * (`resaleCreditWrittenOff`). `flagged`: a resale line the supplier charged RST on, not written off.
 */
export function billLineCosts(bill, { vendor = null } = {}) {
  const lines = bill?.lines || [];
  const amounts = lines.map(lineAmount);
  const uses = lines.map((l) => billLineTaxUse(l, { vendor }));
  // Charged PST/RST falls only on the lines it could apply to. Resale material is bought RST-exempt
  // (the contractor gives its RST number), so the tax lands on the own-use lines; only when the bill
  // has no own-use line to absorb it does it sit on the resale lines — a supplier that wrongly
  // charged RST on resale (a credit to claim). Spreading it over resale lines by amount would both
  // flag phantom supplier credits and under-cost the own-use line that actually bore the RST.
  const anyOwnUse = uses.includes('own-use');
  const weights = amounts.map((a, i) => (!anyOwnUse || uses[i] === 'own-use' ? a : 0));
  const shares = spread(billProvincialTaxCents(bill), weights);
  return lines.map((l, index) => {
    const taxUse = uses[index];
    const rstCents = shares[index];
    const writtenOff = Boolean(l?.resaleCreditWrittenOff);
    const inCost = taxUse === 'own-use' || writtenOff;
    return {
      index, amountCents: amounts[index], taxUse, rstCents, costCents: amounts[index] + (inCost ? rstCents : 0),
      flagged: taxUse === 'resale' && rstCents > 0 && !writtenOff, writtenOff,
    };
  });
}

/** The provincial sales tax rate (RST or PST) in force in a province on a day, or 0. */
export function provincialRateOn(province, d) {
  const p = ratesOn(String(province || '').toUpperCase(), d || new Date()).find((r) => PROVINCIAL_TAX_IDS.includes(r.id));
  return p ? Number(p.pct) || 0 : 0;
}

/**
 * Is a job one whose material is the company's own use by default (warranty and callback work,
 * or work that is not billed)?
 */
export const ownUseJob = (job) => Boolean(job) && (job.kind === 'warranty' || job.kind === 'callback' || job.billable === false);

/**
 * The use of a stock move or material request onto a job: its own `use` when set to 'own-use' or
 * 'job', else own use when the job defaults to it. Count adjustments are never own use.
 */
export function moveIsOwnUse(rec, job) {
  if (rec?.use === 'adjust' || rec?.use === 'transfer' || rec?.use === 'receive' || rec?.countId) return false;
  if (rec?.use === 'own-use') return true;
  if (rec?.use === 'job') return false;
  return ownUseJob(job);
}

/** Is a material request covered elsewhere (by its stock move, a bill, or a purchase order line)? */
export function requestCovered(r, { moveIds = new Set(), bills = [], purchaseOrders = [] } = {}) {
  if (r?.stockMoveId && moveIds.has(r.stockMoveId)) return true;
  for (const b of bills) {
    if (b?.status === 'void') continue;
    if ((b.materialRequestIds || []).includes(r.id)) return true;
  }
  for (const po of purchaseOrders) {
    if (po?.status === 'cancelled') continue;
    if ((po.lines || []).some((l) => (l?.materialRequestIds || []).includes(r.id))) return true;
  }
  return false;
}

/** A move's cost: the server-stamped unit cost, else the item's moving average, else its catalogue cost. */
export function moveUnitCents(m, item) {
  return int(m?.unitCostCents) ?? int(item?.avgCostCents) ?? int(item?.costCents) ?? 0;
}

/**
 * The RST self-assessment worksheet for a date range (3.5): own-use stock moves and material
 * requests at cost x the rate on that day; own-use bill lines with no PST/RST charged (out-of-province
 * sellers); and resale credits to claim from suppliers (resale lines the supplier charged RST on,
 * not written off). A request covered by a move or a bill counts once; an own-use bill line already
 * charged RST is not self-assessed. Only provinces with a provincial sales tax self-assess.
 */
export function rstSelfAssessment({ stockMoves = [], materialRequests = [], bills = [], vendors = [], items = [], jobs = [], purchaseOrders = [], from = '', to = '', province = 'MB', dayOf = day } = {}) {
  const prov = String(province || '').toUpperCase();
  const itemById = new Map(items.map((i) => [i.id, i]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const selfAssess = [];
  const resaleCredits = [];
  const rateOf = (d) => provincialRateOn(prov, d);
  const hasProvTax = (d) => rateOf(d) > 0;

  // Own-use stock moves: material leaving stock for the company's own use (a job defaulting to own use,
  // or tagged own use, with or without a job).
  const moveIds = new Set(stockMoves.map((m) => m.id));
  for (const m of stockMoves) {
    if (!m?.fromLocationId || m.toLocationId || !(num(m.qty) > 0)) continue;
    const job = m.jobId ? jobById.get(m.jobId) : null;
    if (!moveIsOwnUse(m, job)) continue;
    const d = m.date || dayOf(m.createdAt);
    if (!inRange(d, from, to) || !hasProvTax(d)) continue;
    const it = itemById.get(m.itemId);
    const costCents = Math.round(num(m.qty) * moveUnitCents(m, it));
    selfAssess.push({ source: 'move', id: m.id, date: d, jobId: m.jobId || null, description: it?.name || 'Material', costCents,
      rstCents: pctOfCents(costCents, rateOf(d)), reason: m.ownUseReason || (job ? (job.kind === 'warranty' || job.kind === 'callback' ? 'warranty' : 'no-charge') : 'other') });
  }
  for (const r of materialRequests) {
    if (r?.status !== 'fulfilled') continue;
    const job = r.jobId ? jobById.get(r.jobId) : null;
    if (!moveIsOwnUse(r, job)) continue;
    if (requestCovered(r, { moveIds, bills, purchaseOrders })) continue;
    const d = dayOf(r.fulfilledAt || r.updatedAt || r.createdAt);
    if (!inRange(d, from, to) || !hasProvTax(d)) continue;
    const it = r.itemId ? itemById.get(r.itemId) : null;
    const costCents = Math.round(num(r.qty) * num(r.costCents ?? it?.costCents));
    selfAssess.push({ source: 'request', id: r.id, date: d, jobId: r.jobId || null, description: it?.name || r.description || 'Material', costCents,
      rstCents: pctOfCents(costCents, rateOf(d)), reason: r.ownUseReason || 'warranty' });
  }
  for (const b of bills) {
    if (!['open', 'paid'].includes(b?.status)) continue;
    const d = b.date || dayOf(b.createdAt);
    if (!inRange(d, from, to)) continue;
    const vendor = vendorById.get(b.vendorId) || null;
    const costs = billLineCosts(b, { vendor });
    for (const c of costs) {
      const l = b.lines[c.index];
      if (c.flagged) resaleCredits.push({ billId: b.id, lineIndex: c.index, vendorId: b.vendorId || null, date: d, description: l?.description || '', rstCents: c.rstCents });
      // Self-assess an own-use line only when it bore no RST of its own (the seller charged none,
      // e.g. out of province); a line that already took an RST share carries it in cost.
      if (c.taxUse !== 'own-use' || c.rstCents > 0 || !hasProvTax(d) || !c.amountCents) continue;
      selfAssess.push({ source: 'bill', id: b.id, lineIndex: c.index, date: d, jobId: l?.jobId || b.jobId || null, description: l?.description || 'Bill line',
        costCents: c.amountCents, rstCents: pctOfCents(c.amountCents, rateOf(d)), reason: l?.equipmentId ? 'truck' : 'other' });
    }
  }
  selfAssess.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  resaleCredits.sort((a, b) => a.date.localeCompare(b.date));
  return {
    selfAssess, resaleCredits,
    totals: {
      selfAssessCents: selfAssess.reduce((s, x) => s + x.rstCents, 0),
      costCents: selfAssess.reduce((s, x) => s + x.costCents, 0),
      creditCents: resaleCredits.reduce((s, x) => s + x.rstCents, 0),
    },
  };
}

/** The worksheet as CSV for the accountant: one section per list. `money` formats cents. */
export function rstCsv(report, { money = (c) => (c / 100).toFixed(2), jobs = new Map(), vendors = new Map() } = {}) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const row = (...cells) => cells.map(esc).join(',');
  const out = [row('Section', 'Date', 'Source', 'Job', 'Description', 'Reason', 'Cost', 'RST')];
  for (const x of report.selfAssess) out.push(row('Self-assess', x.date, x.source, jobs.get(x.jobId)?.number || '', x.description, x.reason, money(x.costCents), money(x.rstCents)));
  out.push(row('Self-assess total', '', '', '', '', '', money(report.totals.costCents), money(report.totals.selfAssessCents)));
  for (const x of report.resaleCredits) out.push(row('Supplier credit to claim', x.date, 'bill', '', `${vendors.get(x.vendorId)?.name || 'Supplier'}: ${x.description}`, '', '', money(x.rstCents)));
  out.push(row('Supplier credits total', '', '', '', '', '', '', money(report.totals.creditCents)));
  return out.join('\n');
}
