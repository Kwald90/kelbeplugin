// Purchasing: suppliers (vendors), supplier bills and paid receipts (bills), and purchase orders
// (docs/integrations/quickbooks.md 3.5). Office only: the three collections need the `invoices`
// permission, so field crews never receive them and never see a cost. Works with or without
// QuickBooks. Pure, no DOM: the screens (modules/purchasing.js, modules/materials.js) and the
// tests use it.
//
// A bill: { kind: 'bill' (pay later) | 'receipt' (already paid), vendorId, number (the supplier's),
//   date, dueDate (bills), jobId, purchaseOrderId, status: draft | open | paid | void,
//   paidWith (receipts), lines: [{ description, qty, unitCents, amountCents, itemId?, jobId?,
//   costType, poLine? { purchaseOrderId, index } }], taxes: [{ id, label, cents }] as printed,
//   taxProvince, totalCents (as printed), notes, receipt { dataUrl, name, takenAt }, materialRequestIds }.
// A refund or credit from a supplier is a receipt with negative amounts.
//
// A purchase order: { number 'PO-5001', vendorId, jobId, date, expectedDate, status: draft | open |
//   sent | closed | cancelled, lines: [{ itemId?, description, qty, unit, unitCents, jobId?,
//   materialRequestIds[] }], shipTo, notes (shown to the supplier), sentAt, closedAt }.
//
// Release 1 (docs/releases/r1-get-paid.md 2.3, 3.5, 6): bill lines carry taxUse (resale or own use;
// the default is lib/rst.js billLineTaxUse), costCodeId, equipmentId (a truck's fuel, repairs or lease:
// never a job's cost) and resaleCreditWrittenOff; a bill carries varianceAck once the office checked
// its price variances (lib/costing.js priceVariances). PO lines carry costCodeId, quoteRef (a
// wholesaler's job quote), receivedQty and receivedAt (the receiving route, or "Mark received").
import { ratesOn } from './tax.js';
import { pctOfCents } from './money.js';
import { hasFeature, FEATURE_PLAN } from '../plans.js';
import { switchOn } from './modules.js';

export const BILL_KINDS = ['bill', 'receipt'];
export const KIND_LABEL = { bill: 'Bill (pay later)', receipt: 'Receipt (paid)' };
export const BILL_STATUSES = ['draft', 'open', 'paid', 'void'];
export const BILL_STATUS_LABEL = { draft: 'Draft', open: 'To pay', paid: 'Paid', void: 'Void', overdue: 'Overdue' };
export const PO_STATUSES = ['draft', 'open', 'sent', 'closed', 'cancelled'];
export const PO_STATUS_LABEL = { draft: 'Draft', open: 'Open', sent: 'Sent', closed: 'Closed', cancelled: 'Cancelled' };
export const PAID_WITH = ['card', 'cash', 'cheque', 'debit', 'transfer'];
export const PAID_WITH_LABEL = { card: 'Credit card', cash: 'Cash', cheque: 'Cheque', debit: 'Debit', transfer: 'Bank transfer' };
export const COST_TYPES = ['material', 'subcontract', 'equipment', 'other'];
export const COST_TYPE_LABEL = { material: 'Material', subcontract: 'Subcontract', equipment: 'Equipment', other: 'Other' };
/** Taxes a Canadian supplier prints on a bill. */
export const TAX_IDS = ['GST', 'HST', 'PST', 'RST', 'QST'];

/** A bill whose lines and taxes miss the printed total by more than this is "doesn't add up" (and not sent to QuickBooks). */
export const TOTAL_TOLERANCE_CENTS = 2;
export const MAX_LINES = 200;
/** A receipt photo or PDF as a data URL, until object storage: JPEG, PNG or PDF, at most 2.5 MB of text. */
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
export const RECEIPT_MAX_CHARS = Math.floor(2.5 * 1024 * 1024);
/** Receipt photos are downscaled to about this many bytes (still readable at 1600 px). */
export const RECEIPT_PHOTO_BYTES = 900 * 1024;
/** The largest record the server keeps, per collection (server/src/collections.js maxBytes). */
export const RECORD_MAX_BYTES = { vendors: 16 * 1024, bills: 3 * 1024 * 1024, purchaseOrders: 64 * 1024 };

/** settings.nextNumbers.po starts here (store.js DEFAULT_SETTINGS). */
export const PO_START = 5001;
export const PO_PREFIX = 'PO';

const int = (v) => (Number.isInteger(v) ? v : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoDay = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);

// ---- who may use it -------------------------------------------------------------------------

/**
 * Can this person use purchasing right now? Office roles (the `invoices` permission), the
 * Purchasing switch on (Settings → Modules), and the plan (`purchasing`, Pro) when signed in.
 * `entitlements` is /api/v1/me's (null in the demo, where every plan feature is open).
 */
export function purchasingAllowed({ canInvoices, settings, entitlements = null }) {
  if (!canInvoices || !switchOn(settings, 'purchasing')) return false;
  if (!entitlements || !Object.hasOwn(FEATURE_PLAN, 'purchasing')) return true;
  const overrides = Object.fromEntries(Object.keys(FEATURE_PLAN).map((f) => [f, (entitlements.features || []).includes(f)]));
  return hasFeature(entitlements.plan, 'purchasing', overrides);
}

// ---- numbers ----------------------------------------------------------------------------------

/** 5001 -> 'PO-5001'. */
export const formatPoNumber = (n) => `${PO_PREFIX}-${n}`;

/** 'PO-5001' -> 5001; anything else -> null. */
export function parsePoNumber(s) {
  const m = /^PO-(\d{1,9})$/i.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * The next PO number to hand out: the settings counter, but never one already used by a PO this
 * device has (two offline devices, or a counter set back by hand). Returns { number, next }:
 * store `next` in settings.nextNumbers.po.
 */
export function nextPoNumber(settings, orders = []) {
  const counter = Number.isInteger(settings?.nextNumbers?.po) ? settings.nextNumbers.po : PO_START;
  const used = orders.map((o) => parsePoNumber(o.number)).filter((n) => n != null);
  const n = Math.max(counter, used.length ? Math.max(...used) + 1 : 0);
  return { number: formatPoNumber(n), next: n + 1 };
}

// ---- vendors ----------------------------------------------------------------------------------

export const vendorActive = (v) => Boolean(v) && v.active !== false;
export const vendorName = (v) => (v ? v.name || v.companyName || 'Unnamed supplier' : 'No supplier');

/** Active suppliers by name (plus `keepId`, so a document keeps showing its own inactive supplier). */
export function vendorChoices(vendors, keepId = null) {
  return vendors.filter((v) => vendorActive(v) || v.id === keepId).sort((a, b) => vendorName(a).localeCompare(vendorName(b)));
}

/** A bill's due date from the supplier's terms ("Net 30", "net 15 days"), or null when they name no days. */
export function dueFromTerms(terms, date) {
  const m = /\bnet\s*(\d{1,3})\b/i.exec(String(terms || ''));
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + Number(m[1]))).toISOString().slice(0, 10);
}

/** What is wrong with a supplier before it can be saved: [message]. */
export function vendorProblems(v, vendors = []) {
  const out = [];
  const name = String(v?.name || '').trim();
  if (!name) out.push('Give the supplier a name.');
  else if (vendors.some((o) => o.id !== v.id && vendorActive(o) && String(o.name || '').trim().toLowerCase() === name.toLowerCase())) out.push(`There is already a supplier called ${name}.`);
  if (name.length > 100) out.push('Keep the name under 100 characters.');
  if (v?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v.email).trim())) out.push('That email address does not look right.');
  return out;
}

// ---- bills and receipts -----------------------------------------------------------------------

/** A line's amount: as typed, else round(qty × unit cost). */
export function lineAmountCents(l) {
  const typed = int(l?.amountCents);
  if (typed != null) return typed;
  return Math.round(num(l?.qty) * num(l?.unitCents));
}

/**
 * The bill's numbers: lines, taxes, what they add up to (computedCents), the printed total
 * (totalCents, or the computed one when none was typed), the difference and whether it is out by
 * more than TOTAL_TOLERANCE_CENTS.
 */
export function billTotals(bill) {
  const linesCents = (bill?.lines || []).reduce((s, l) => s + lineAmountCents(l), 0);
  const taxCents = (bill?.taxes || []).reduce((s, t) => s + (int(t?.cents) ?? 0), 0);
  const computedCents = linesCents + taxCents;
  const printed = int(bill?.totalCents);
  const diffCents = printed == null ? 0 : printed - computedCents;
  return { linesCents, taxCents, computedCents, totalCents: printed ?? computedCents, diffCents, typed: printed != null, mismatch: Math.abs(diffCents) > TOTAL_TOLERANCE_CENTS };
}

/** Does the bill add up (lines + taxes within 2 cents of the printed total)? */
export const billAddsUp = (bill) => !billTotals(bill).mismatch;

/** A receipt for money coming back: a supplier refund or a card credit (negative amounts). */
export const isRefund = (bill) => bill?.kind === 'receipt' && billTotals(bill).totalCents < 0;

/**
 * Every amount of the bill made positive (sign 1) or negative (sign -1): lines, unit costs,
 * taxes and the printed total. Ticking "refund" on a receipt uses -1. Returns a patch.
 */
export function withSign(bill, sign) {
  const s = sign < 0 ? -1 : 1;
  const fix = (v) => (int(v) == null ? v : s * Math.abs(v));
  return {
    lines: (bill.lines || []).map((l) => ({ ...l, unitCents: fix(l.unitCents), amountCents: fix(l.amountCents) })),
    taxes: (bill.taxes || []).map((t) => ({ ...t, cents: fix(t.cents) })),
    totalCents: fix(bill.totalCents),
  };
}

/** Bills that are still to pay and past their due date show as overdue. */
export function billStatusOf(bill, today = isoDay(new Date())) {
  const st = bill?.status || 'draft';
  if (bill?.kind !== 'receipt' && st === 'open' && bill.dueDate && bill.dueDate < today) return 'overdue';
  return st;
}

/** What still owes money: open bills (not receipts, not drafts, not void). */
export const billOutstanding = (bill) => bill?.kind !== 'receipt' && bill?.status === 'open';

/**
 * What is wrong with a bill before it can be entered: [{ code, message, block }]. `block` stops
 * "Enter bill"/"Save receipt"; the rest are warnings (a total that doesn't add up can be saved,
 * but QuickBooks only gets it once it does).
 */
export function billProblems(bill, { money = (c) => (c / 100).toFixed(2), po = null } = {}) {
  const out = [];
  const add = (code, message, block = false) => out.push({ code, message, block });
  if (!bill?.vendorId) add('no_vendor', 'Pick the supplier.', true);
  if (!(bill?.lines || []).length) add('no_lines', 'Add at least one line.', true);
  if ((bill?.lines || []).length > MAX_LINES) add('too_many_lines', `A bill holds at most ${MAX_LINES} lines.`, true);
  if (!bill?.date) add('no_date', 'Give the date on the bill.', true);
  if (bill?.kind === 'receipt' && !PAID_WITH.includes(bill.paidWith)) add('no_paid_with', 'Say how it was paid.', true);
  const t = billTotals(bill || {});
  if (t.mismatch) add('totals_mismatch', `Bill total doesn't add up: the lines and taxes come to ${money(t.computedCents)}, the bill says ${money(t.totalCents)}.`);
  // A supplier credit against a bill (reversesId, r1-get-paid.md 2.6) is a bill with negative lines.
  if (bill?.kind !== 'receipt' && t.totalCents < 0 && !bill?.reversesId) add('negative_bill', 'A bill cannot be negative. Enter a supplier refund or credit as a receipt and tick Refund.', true);
  const signs = new Set((bill?.lines || []).map(lineAmountCents).filter((c) => c !== 0).map(Math.sign));
  if (signs.size > 1) add('mixed_signs', 'Some lines are negative and some positive. A refund has every amount negative; enter the rest as its own receipt.', true);
  if (bill?.kind === 'bill' && bill.dueDate && bill.date && bill.dueDate < bill.date) add('due_before_date', 'The due date is before the bill date.');
  // QuickBooks links a bill to a PO only when both are from the same supplier.
  if (po && bill?.vendorId && po.vendorId && po.vendorId !== bill.vendorId) add('po_vendor', `${po.number || 'The purchase order'} is from another supplier. Pick that supplier, or another order.`, true);
  return out;
}

/**
 * The taxes a supplier in `province` charges on `linesCents` on `date`, as a bill prints them
 * ([{ id, label, cents }]). A starting point: what is printed on the bill wins.
 */
export function suggestTaxes(province, date, linesCents) {
  return ratesOn(province, date).filter((p) => TAX_IDS.includes(p.id)).map((p) => ({ id: p.id, label: p.label || p.id, cents: pctOfCents(linesCents, p.pct) }));
}

/** A new bill or receipt, as a draft. */
export function newBill({ kind = 'bill', settings = {}, today = isoDay(new Date()), vendorId = null, jobId = null } = {}) {
  return {
    kind: BILL_KINDS.includes(kind) ? kind : 'bill', vendorId, number: '', date: today, dueDate: kind === 'receipt' ? null : today,
    jobId, purchaseOrderId: null, status: 'draft', paidWith: kind === 'receipt' ? 'card' : null,
    lines: [], taxes: [], taxProvince: settings?.company?.province || 'ON', totalCents: null, notes: '', materialRequestIds: [],
  };
}

/** The status a draft takes when it is entered: bills are to pay, receipts are paid. */
export const enteredStatus = (bill) => (bill?.kind === 'receipt' ? 'paid' : 'open');

/** The patch that turns a bill into the other kind (a bill paid on the spot, or the other way). */
export function switchKind(bill, kind) {
  if (kind === bill.kind) return {};
  if (kind === 'receipt') return { kind, paidWith: bill.paidWith || 'card', dueDate: null, status: bill.status === 'draft' || bill.status === 'void' ? bill.status : 'paid' };
  return { kind, paidWith: null, dueDate: bill.dueDate || bill.date || null, status: bill.status === 'draft' || bill.status === 'void' ? bill.status : 'open', ...(isRefund(bill) ? withSign(bill, 1) : {}) };
}

/** A blank bill line. */
export const newBillLine = (o = {}) => ({ description: '', qty: 1, unitCents: 0, amountCents: 0, itemId: null, jobId: null, costType: 'material', ...o });

/**
 * Change a bill line: a new qty or unit cost works the amount out again; a typed amount stays
 * as typed until qty or unit cost change.
 */
export function editLine(line, patch) {
  const next = { ...line, ...patch };
  if ('qty' in patch || 'unitCents' in patch) next.amountCents = Math.round(num(next.qty) * num(next.unitCents));
  return next;
}

// ---- receipts (photo or PDF) ------------------------------------------------------------------

/** The type of a receipt data URL, or null when it is not one we keep. */
export function receiptType(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i.exec(String(dataUrl || ''));
  return m && RECEIPT_TYPES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

/** Why a receipt cannot be kept, or null. */
export function receiptProblem(receipt) {
  if (!receipt) return null;
  if (!receiptType(receipt.dataUrl)) return 'Attach a photo (JPEG or PNG) or a PDF.';
  if (receipt.dataUrl.length > RECEIPT_MAX_CHARS) return 'That file is too big. Attach a PDF under about 1.8 MB, or a photo.';
  return null;
}

/** Bytes of a base64 data URL. */
export const dataUrlBytes = (u) => (typeof u === 'string' && u.includes(',') ? Math.floor(((u.length - u.indexOf(',') - 1) * 3) / 4) : 0);

/** Bytes of a record as the server measures it (its JSON, UTF-8). */
export const recordBytes = (rec) => new TextEncoder().encode(JSON.stringify(rec ?? null)).length;

/** Is the record over what the server keeps for `coll` (it would be refused with too_large)? */
export const recordTooBig = (coll, rec) => recordBytes(rec) > (RECORD_MAX_BYTES[coll] ?? Infinity);

/** What the screens say when a record would be refused for its size. */
export function tooBigMessage(coll) {
  const max = RECORD_MAX_BYTES[coll];
  const limit = max >= 1024 * 1024 ? `${Math.round(max / (1024 * 1024))} MB` : `${Math.round(max / 1024)} KB`;
  return coll === 'bills'
    ? `This bill would be over the ${limit} a record can hold, so it would not sync. Attach a smaller photo or PDF, or split the lines over two bills.`
    : `This record would be over the ${limit} it can hold, so it would not sync. Shorten it, or split it in two.`;
}

// ---- purchase orders --------------------------------------------------------------------------

export const poLineCents = (l) => Math.round(num(l?.qty) * num(l?.unitCents));
export const poTotalCents = (po) => (po?.lines || []).reduce((s, l) => s + poLineCents(l), 0);
/** POs that can still be billed against. */
export const poOpen = (po) => ['open', 'sent'].includes(po?.status);

/** A new purchase order (a draft): the number comes from nextPoNumber. */
export function newPurchaseOrder({ number, vendorId = null, jobId = null, today = isoDay(new Date()), shipTo = '' } = {}) {
  return { number, vendorId, jobId, date: today, expectedDate: null, status: 'draft', lines: [], shipTo, notes: '', sentAt: null, closedAt: null };
}

/**
 * Material requests rolled into purchase-order lines: the same item (or typed description), unit
 * and job added up, each line listing the requests it covers. The order's job is the requests'
 * job when they share one. `items` is a Map of price-book items (costs fill unitCents).
 */
export function poLinesFromRequests(requests, { items = new Map() } = {}) {
  const rows = new Map();
  for (const r of requests) {
    const it = r.itemId ? items.get(r.itemId) : null;
    const description = (it?.name || r.description || 'Material').trim();
    const unit = r.unit || it?.unit || 'ea';
    const key = `${r.itemId || description.toLowerCase()}|${unit}|${r.jobId || ''}`;
    if (!rows.has(key)) {
      rows.set(key, { itemId: r.itemId || null, description, qty: 0, unit, unitCents: int(it?.costCents) ?? int(r.costCents) ?? 0, jobId: r.jobId || null, materialRequestIds: [] });
    }
    const row = rows.get(key);
    row.qty = Math.round((row.qty + num(r.qty)) * 100) / 100;
    row.materialRequestIds.push(r.id);
  }
  return [...rows.values()];
}

/** The PO's own job: the one job every line is for, else null. */
export function commonJob(lines) {
  const jobs = new Set(lines.map((l) => l.jobId || ''));
  return jobs.size === 1 ? [...jobs][0] || null : null;
}

/**
 * Purchase orders for material requests, one per chosen supplier: `vendorFor(request)` names the
 * supplier of each request. Returns [{ vendorId, order (without a number), requestIds }] in the
 * order suppliers were first chosen.
 */
export function ordersFromRequests(requests, vendorFor, { items = new Map(), today = isoDay(new Date()), shipTo = '' } = {}) {
  const groups = new Map();
  for (const r of requests) {
    const v = vendorFor(r) || null;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(r);
  }
  return [...groups.entries()].map(([vendorId, rs]) => {
    const lines = poLinesFromRequests(rs, { items });
    return { vendorId, requestIds: rs.map((r) => r.id), order: { ...newPurchaseOrder({ vendorId, jobId: commonJob(lines), today, shipTo }), status: 'open', lines } };
  });
}

/**
 * Why line `index` of a PO cannot be removed, or null when it can. A bill line points at its PO
 * line by position (poLine.index), so once the order has left draft its lines are only added to,
 * and even a draft keeps a line that a bill (a void one too: it can be restored) points at, or any
 * line before one.
 */
export function poLineLocked(po, bills = [], index = 0) {
  if ((po?.status || 'draft') !== 'draft') return 'Lines on a placed order stay: bills point at them. Set the quantity to what you still want instead.';
  const used = bills.some((b) => (b?.lines || []).some((l) => l?.poLine?.purchaseOrderId === po.id && Number.isInteger(l.poLine.index) && l.poLine.index >= index));
  return used ? 'A bill points at this line or one after it. Set the quantity instead of removing the line.' : null;
}

/** The PO's lines without line `index`: { lines, error } (error set and lines unchanged when it is locked). */
export function removePoLine(po, index, bills = []) {
  const error = poLineLocked(po, bills, index);
  const lines = po?.lines || [];
  return error ? { lines, error } : { lines: lines.filter((_, i) => i !== index), error: null };
}

/** The change to a material request whose purchase order was cancelled: back where it was before it was ordered. */
export const requestAfterPoCancel = (r) => ({ status: r?.sentAt ? 'sent' : 'requested', orderedAt: null });

/** What stops a PO being placed: [message]. */
export function poProblems(po) {
  const out = [];
  if (!po?.vendorId) out.push('Pick the supplier.');
  if (!(po?.lines || []).length) out.push('Add at least one line.');
  if ((po?.lines || []).length > MAX_LINES) out.push(`An order holds at most ${MAX_LINES} lines.`);
  if ((po?.lines || []).some((l) => !(num(l.qty) > 0))) out.push('Every line needs a quantity above zero.');
  if ((po?.lines || []).some((l) => !String(l.description || '').trim())) out.push('Every line needs a description.');
  return out;
}

/**
 * The order as plain text for an email or the supplier's order form. `money` formats cents;
 * `jobs` is a Map of job records (lines name their job number).
 */
export function poText(po, { vendor = null, company = '', jobs = new Map(), money = (c) => (c / 100).toFixed(2) } = {}) {
  const job = (id) => jobs.get(id);
  const qtyOf = (l) => `${Math.round(num(l.qty) * 100) / 100}${l.unit ? ` ${l.unit}` : ''}`;
  const head = [
    `Purchase order ${po.number || ''}${company ? ` from ${company}` : ''}`.trim(),
    vendor ? `To: ${vendorName(vendor)}${vendor.accountNumber ? ` (account ${vendor.accountNumber})` : ''}` : null,
    po.date ? `Date: ${po.date}` : null,
    po.expectedDate ? `Needed by: ${po.expectedDate}` : null,
    po.jobId && job(po.jobId) ? `Job: ${[job(po.jobId).number, job(po.jobId).title].filter(Boolean).join(' · ')}` : null,
    po.shipTo ? `Ship to: ${po.shipTo}` : null,
  ].filter(Boolean);
  const lines = (po.lines || []).map((l) => {
    const j = l.jobId && l.jobId !== po.jobId ? job(l.jobId)?.number : null;
    const price = num(l.unitCents) ? `  @ ${money(l.unitCents)} = ${money(poLineCents(l))}` : '';
    return `  - ${qtyOf(l)}  ${l.description || ''}${price}${j ? `  (${j})` : ''}`;
  });
  const total = poTotalCents(po);
  return [...head, '', ...lines, total ? `\nTotal before tax: ${money(total)}` : '', po.notes ? `\n${po.notes}` : ''].join('\n').trim();
}

/** Requests the office can still put on a purchase order (not yet ordered, fulfilled or cancelled). */
export const orderableRequest = (r) => ['requested', 'sent'].includes(r?.status || 'requested');

/**
 * What has been billed against a PO so far, from bills whose lines point at it (`poLine`):
 * { billedCents, lineQty: [qty billed per PO line], billIds }. Void and deleted bills don't count.
 */
export function poBilled(po, bills = []) {
  const lineQty = (po?.lines || []).map(() => 0);
  const billIds = new Set();
  let billedCents = 0;
  for (const b of bills) {
    if (b.status === 'void') continue;
    let hit = b.purchaseOrderId === po.id;
    for (const l of b.lines || []) {
      if (l?.poLine?.purchaseOrderId !== po.id) continue;
      hit = true;
      const i = l.poLine.index;
      if (Number.isInteger(i) && i >= 0 && i < lineQty.length) lineQty[i] = Math.round((lineQty[i] + num(l.qty)) * 100) / 100;
      billedCents += lineAmountCents(l);
    }
    if (hit) billIds.add(b.id);
  }
  return { billedCents, lineQty, billIds: [...billIds] };
}

/**
 * A draft bill for what is left on a PO: each line not yet fully billed, at the PO's cost,
 * pointing back at its PO line (QuickBooks links the bill to the PO through it).
 */
export function billFromPo(po, { bills = [], settings = {}, today = isoDay(new Date()) } = {}) {
  const done = poBilled(po, bills).lineQty;
  const lines = [];
  (po.lines || []).forEach((l, index) => {
    const qty = Math.round((num(l.qty) - (done[index] || 0)) * 100) / 100;
    if (qty <= 0) return;
    const unitCents = int(l.unitCents) ?? 0;
    lines.push(newBillLine({ description: l.description || '', qty, unitCents, amountCents: Math.round(qty * unitCents), itemId: l.itemId || null, jobId: l.jobId || null, poLine: { purchaseOrderId: po.id, index } }));
  });
  const requestIds = [...new Set((po.lines || []).flatMap((l) => l.materialRequestIds || []))];
  return { ...newBill({ kind: 'bill', settings, today, vendorId: po.vendorId || null, jobId: po.jobId || null }), purchaseOrderId: po.id, lines, materialRequestIds: requestIds };
}

// ---- the bill and PO editors' saves -----------------------------------------------------------

/**
 * Fields an editor never autosaves. Status and its times change through their own buttons, each
 * as its own small patch, and can change under an open editor (QuickBooks marks a bill paid or
 * closes a PO; another office user voids a bill): an autosave of the whole record would write the
 * old status back. `kind` changes through the kind switch.
 */
export const EDITOR_SKIP = ['id', 'createdAt', 'updatedAt', 'status', 'sentAt', 'closedAt', 'kind'];
/** Fields an open editor takes from the record when they change elsewhere. */
export const EDITOR_PULLED = ['status', 'sentAt', 'closedAt', 'kind'];

/** The autosave patch: the fields the user changed (`touched`), never EDITOR_SKIP; null when none. */
export function editorPatch(doc, touched) {
  const patch = {};
  for (const k of touched) if (!EDITOR_SKIP.includes(k)) patch[k] = doc[k] ?? null;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Keeps an open editor's copy of a record (`doc`, edited in place) and the store in step.
 * `touch(...fields)` marks fields as edited and saves just those after `ms`; `flush()` saves now;
 * `write(patch)` saves a status or kind change at once, on its own; `stop()` flushes and stops
 * listening. When the record's status (or kind) changes elsewhere, `doc` takes it and
 * onPulled(fields) runs; when another device deletes it, onRemoved() runs. onTooBig() runs when a
 * save leaves the record bigger than the server keeps. `store` is store.js's.
 */
export function recordEditor(store, coll, id, doc, { ms = 450, summary = null, onPulled = null, onRemoved = null, onTooBig = null } = {}) {
  const touched = new Set();
  let timer = null, edited = false;
  const save = () => {
    clearTimeout(timer); timer = null;
    const patch = editorPatch(doc, touched);
    touched.clear();
    if (!patch || !store.get(coll, id)) return null;
    const next = store.update(coll, id, patch, { summary: summary?.(doc) });
    if (onTooBig && recordTooBig(coll, next)) onTooBig();
    return next;
  };
  const same = (a, b) => (a ?? null) === (b ?? null);
  const off = store.on(coll, (e) => {
    if (e?.record?.id !== id) return;
    if (e.type === 'remove') {
      clearTimeout(timer); timer = null; touched.clear();
      if (e.remote) onRemoved?.();
      return;
    }
    const fields = EDITOR_PULLED.filter((k) => !same(e.record[k], doc[k]));
    if (!fields.length) return;
    for (const k of fields) doc[k] = e.record[k] ?? null;
    onPulled?.(fields);
  });
  const flush = () => { if (timer || touched.size) save(); };
  return {
    touch(...fields) {
      for (const k of fields) touched.add(k);
      edited = true;
      clearTimeout(timer);
      timer = setTimeout(save, ms);
    },
    flush,
    write(patch, opts = {}) {
      flush();
      Object.assign(doc, patch);
      edited = true;
      return store.get(coll, id) ? store.update(coll, id, patch, opts) : null;
    },
    get edited() { return edited; },
    stop() { flush(); off(); },
  };
}

/** A new bill nobody has filled in yet (backing out of "New bill" deletes it). */
export const blankBill = (b) => Boolean(b) && (b.status || 'draft') === 'draft' && !(b.lines || []).length && !(b.taxes || []).length
  && !String(b.number || '').trim() && !b.receipt && !String(b.notes || '').trim() && b.totalCents == null;

/** A new purchase order nobody has filled in yet (backing out of "New purchase order" deletes it). */
export const blankPurchaseOrder = (p) => Boolean(p) && (p.status || 'draft') === 'draft' && !(p.lines || []).length
  && !String(p.notes || '').trim() && !p.expectedDate;

// ---- lists ------------------------------------------------------------------------------------

/**
 * The money summary on the purchasing page: what is still to pay, what of it is overdue, and
 * what was spent this month (entered bills and receipts, refunds netted off, by bill date).
 */
export function purchasingSummary(bills, today = isoDay(new Date())) {
  let toPayCents = 0, overdueCents = 0, monthCents = 0, toPay = 0, overdue = 0;
  const month = today.slice(0, 7);
  for (const b of bills) {
    const t = billTotals(b).totalCents;
    if (billOutstanding(b)) {
      toPayCents += t; toPay++;
      if (billStatusOf(b, today) === 'overdue') { overdueCents += t; overdue++; }
    }
    if (['open', 'paid'].includes(b.status) && String(b.date || '').startsWith(month)) monthCents += t;
  }
  return { toPayCents, overdueCents, monthCents, toPay, overdue };
}

/** Does a bill match a search ("home depot", "INV-2231", "J-1042")? */
export function billMatches(bill, q, { vendors = new Map(), jobs = new Map() } = {}) {
  const n = String(q || '').trim().toLowerCase();
  if (!n) return true;
  const job = jobs.get(bill.jobId);
  return [bill.number, vendorName(vendors.get(bill.vendorId)), job?.number, job?.title, bill.notes, ...(bill.lines || []).map((l) => l.description)]
    .some((s) => String(s || '').toLowerCase().includes(n));
}

// ---- Release 1: receiving, tax use, cost codes, trucks (docs/releases/r1-get-paid.md 3.5, 6.3, 6.6) ----

/**
 * What a bill line should not carry together: a truck (equipmentId: fuel, repairs, lease) is the
 * truck's cost, never a job's, so a line with both gets a warning and job costing ignores its job.
 */
export function billLineWarnings(line) {
  const out = [];
  if (line?.equipmentId && line?.jobId) out.push('This line is for a truck: truck costs are recovered through its rate, not charged to a job. Clear the job, or the truck.');
  return out;
}

/**
 * Open purchase-order lines still to receive, without prices (the field receiving list, 6.6):
 * [{ poId, number, vendorId, index, itemId, description, unit, ordered, received, remaining, jobId }].
 * `jobId` keeps the lines for one job; `stockOnly` the lines for no job (stock orders).
 */
export function openReceiptLines(purchaseOrders = [], { jobId = null, stockOnly = false } = {}) {
  const out = [];
  for (const po of purchaseOrders) {
    if (!poOpen(po)) continue;
    (po.lines || []).forEach((l, index) => {
      const job = l?.jobId || po.jobId || null;
      if (jobId && job !== jobId) return;
      if (stockOnly && job) return;
      const ordered = num(l?.qty);
      const received = num(l?.receivedQty);
      const remaining = Math.round((ordered - received) * 100) / 100;
      if (!(remaining > 0)) return;
      out.push({ poId: po.id, number: po.number || '', vendorId: po.vendorId || null, index, itemId: l?.itemId || null, description: l?.description || '', unit: l?.unit || 'ea', ordered, received, remaining, jobId: job });
    });
  }
  return out;
}

/**
 * The PO lines after receiving `receipts` ([{ index, qty }]) at `at`: receivedQty goes up and
 * receivedAt is stamped. Returns { lines, error } (error set and lines unchanged when a receipt is bad).
 */
export function receiveLines(po, receipts = [], at = new Date().toISOString()) {
  const lines = (po?.lines || []).map((l) => ({ ...l }));
  for (const r of receipts) {
    const i = r?.index;
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) return { lines: po?.lines || [], error: `There is no line ${Number(i) + 1} on this order.` };
    if (!(num(r.qty) > 0)) return { lines: po?.lines || [], error: 'Receive a quantity above zero.' };
    lines[i].receivedQty = Math.round((num(lines[i].receivedQty) + num(r.qty)) * 1000) / 1000;
    lines[i].receivedAt = at;
  }
  return { lines, error: null };
}

/**
 * A supplier credit for a bill in a closed period (r1-get-paid.md 2.6): a new bill dated today with
 * every line and tax negated, pointing back with reversesId. Lines keep their job, tax use and cost
 * code, so job costing nets the credit on the same job. The office trims it to what was credited.
 */
export function supplierCreditFrom(bill, { settings = {}, today = isoDay(new Date()) } = {}) {
  const neg = (v) => (int(v) == null ? v : -Math.abs(v));
  return {
    ...newBill({ kind: bill.kind === 'receipt' ? 'receipt' : 'bill', settings, today, vendorId: bill.vendorId || null, jobId: bill.jobId || null }),
    reversesId: bill.id, taxProvince: bill.taxProvince || settings?.company?.province || 'ON', dueDate: null,
    // Negative amounts the way a refund receipt has them (withSign): quantity as is, unit cost and amount negative.
    lines: (bill.lines || []).map((l) => ({ ...l, qty: Math.abs(num(l.qty)), amountCents: -Math.abs(lineAmountCents(l)), unitCents: -Math.abs(num(l.unitCents)), poLine: null, resaleCreditWrittenOff: null })),
    taxes: (bill.taxes || []).map((t) => ({ ...t, cents: neg(t.cents) })),
    totalCents: bill.totalCents == null ? null : -Math.abs(bill.totalCents),
    notes: `Supplier credit for ${bill.number || 'a bill'} dated ${bill.date || ''}`.trim(),
    materialRequestIds: [],
  };
}

/** Committed cost per job from open and sent POs (lib/costing.js committedCost per job): Map(jobId -> cents). */
export function committedByJob(purchaseOrders = [], bills = []) {
  const out = new Map();
  for (const po of purchaseOrders) {
    if (!poOpen(po)) continue;
    const billed = poBilled(po, bills.filter((b) => b.status !== 'draft')).lineQty;
    (po.lines || []).forEach((l, i) => {
      const job = l?.jobId || po.jobId;
      if (!job) return;
      const qty = Math.round((num(l.qty) - Math.max(num(l.receivedQty), billed[i] || 0)) * 100) / 100;
      if (qty > 0) out.set(job, (out.get(job) || 0) + Math.round(qty * num(l.unitCents)));
    });
  }
  return out;
}

/** What a job has cost in bills and receipts (entered ones; refunds netted off), by cost type. */
export function jobCostsFromBills(bills, jobId) {
  const out = { material: 0, subcontract: 0, equipment: 0, other: 0, total: 0 };
  for (const b of bills) {
    if (!['open', 'paid'].includes(b.status)) continue;
    for (const l of b.lines || []) {
      if ((l.jobId || b.jobId) !== jobId) continue;
      const c = lineAmountCents(l);
      const k = COST_TYPES.includes(l.costType) ? l.costType : 'material';
      out[k] += c; out.total += c;
    }
  }
  return out;
}
