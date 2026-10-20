// Canonical form -> QBO request body (docs/integrations/quickbooks.md 4, 5.5). Pure.
//
// canonToQbo builds the body of a create or an update. It never sets Id or SyncToken (the engine
// adds them). Sparse entities (Customer, Invoice, Estimate, Deposit) get only Fishtape's fields;
// the others start from the current QBO object, so fields Fishtape does not manage are kept.
// Whenever Line is sent it is built from the current QBO lines matched by Line.Id: attributes
// Fishtape does not model (ServiceDate, ClassRef, line DepartmentRef, BillableStatus of a billed
// line) are copied onto the line sent. GlobalTaxCalculation of an existing object is sent back as
// read. A payment's lines that Fishtape does not own are never changed (4.9). On a full update,
// PrivateNote keeps what QBO has beyond Fishtape's own text (privateNote).
import {
  str, cut, toCents, toDollars, linkInfo, localDay, lossySuffix, flatSalesLines, qboToCanon, canonEqual, stripMarker,
  T5018_FIELD, CUSTOMER_MEMO_MAX, NOTES_MAX, DOC_NUMBER_MAX, LINE_DESC_MAX,
} from './canon.js';
import { addressToQbo, qboName, stripNameSuffix } from './names.js';

export { markerFor, normMethod } from './canon.js';

/** The QBO entity of each collection (bills depend on kind; fee links are Purchases). */
export const QBO_ENTITY = {
  clients: 'Customer', jobs: 'Customer', items: 'Item', vendors: 'Vendor', estimates: 'Estimate', invoices: 'Invoice',
  payments: 'Payment', bills: 'Bill', purchaseOrders: 'PurchaseOrder', timeEntries: 'TimeActivity', stripePayouts: 'Transfer',
};
/** Entities updated with `sparse: true` (5.5; VERIFY whether the others accept it, 11.4 item 5). */
export const SPARSE_ENTITIES = new Set(['Customer', 'Invoice', 'Estimate', 'Deposit']);
/**
 * QBO may refuse a line whose Amount differs from its own Qty × UnitPrice (fault 6000; VERIFY 11.4
 * item 3). While true, such a line goes out as Qty 1 at its amount with " (2.6667 h × $95.00)" in
 * the description, and its index is returned in `lossyLines`.
 */
export const STRICT_LINE_AMOUNTS = true;
/** Whether QBO accepts negative sales lines (VERIFY 11.4 item 3). False uses a discount line when it can. */
export const NEGATIVE_SALES_LINES = true;

const READ_ONLY = ['Id', 'SyncToken', 'MetaData', 'domain', 'sparse'];
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
function fromExisting(existing) {
  const b = clone(existing) || {};
  for (const k of READ_ONLY) delete b[k];
  return b;
}
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
const refOf = (id) => (id ? { value: String(id) } : undefined);
const maps = (ctx, kind) => ctx?.mappings?.[kind] || {};
const option = (ctx, key, dflt) => (ctx?.mappings?.option && ctx.mappings.option[key] !== undefined ? ctx.mappings.option[key] : dflt);
const feat = (ctx, key) => Boolean(ctx?.features?.[key]);
const sum = (arr) => arr.reduce((s, x) => s + x, 0);

/** The QBO entity a canonical form goes to. */
export function entityFor(collection, canon, role = 'main') {
  if (role === 'fee') return 'Purchase';
  if (collection === 'payments' && role === 'deposit') return 'Invoice';
  if (collection === 'bills') return canon?.kind === 'receipt' ? 'Purchase' : 'Bill';
  const e = QBO_ENTITY[collection];
  if (!e) throw new Error(`no QBO entity for ${collection}`);
  return e;
}

/** The name to send: the exact suffixed name sent before (meta.displayName) while the base name is unchanged. */
function sendName(name, meta, override) {
  if (override) return qboName(override);
  if (meta?.displayName && stripNameSuffix(qboName(meta.displayName)) === name) return qboName(meta.displayName);
  return qboName(name);
}
/** A value to set, or '' to clear one QBO has, or nothing. */
const setOrClear = (value, had) => (value != null && value !== '' ? value : (had ? '' : undefined));

function addressOrClear(address, had) {
  const a = addressToQbo(address);
  if (a) return had?.Id ? { Id: had.Id, ...a } : a;
  return had ? { ...(had.Id ? { Id: had.Id } : {}), Line1: '', City: '', CountrySubDivisionCode: '', PostalCode: '' } : undefined;
}
/**
 * PrivateNote of a full update (5.5): the marker and Fishtape's own text in front, then whatever
 * else QBO has there (a bookkeeper's memo is never dropped). An object pulled from QBO (no marker
 * on the link) keeps its note exactly as it is.
 */
function privateNote(meta, ownParts, existing) {
  const marker = str(meta?.marker);
  if (!marker && existing) return existing.PrivateNote;
  const own = [marker, ...ownParts.map(str)].filter(Boolean);
  let rest = stripMarker(existing?.PrivateNote) || '';
  for (const part of own.slice(marker ? 1 : 0)) {
    if (rest === part) rest = '';
    else if (rest.startsWith(`${part} · `)) rest = rest.slice(part.length + 3);
  }
  return [...own, str(rest)].filter(Boolean).join(' · ').slice(0, NOTES_MAX) || undefined;
}

const emailOf = (v, had) => (v ? { Address: v } : (had?.Address ? { Address: '' } : undefined));
const phoneOf = (v, had) => (v ? { FreeFormNumber: String(v).slice(0, 30) } : (had?.FreeFormNumber ? { FreeFormNumber: '' } : undefined));

/**
 * The QBO body for a canonical form.
 * @param {string} collection
 * @param {object} canon the merged canonical form (L for a create)
 * @param {object} ctx mapper context (canon.js)
 * @param {object} [opts]
 * @param {object} [opts.existing] the current QBO object (updates); null for a create
 * @param {string[]} [opts.fields] fields to write on an update (merge toRemote); all when absent
 * @param {string} [opts.displayName] the name to send instead (a " (2)" suffix after 6240, names.nextDisplayName)
 * @param {string} [opts.billEmail] the client's email for invoices and estimates
 * @param {string} [opts.invoiceCustomerRef] payments: the linked QBO invoice's own CustomerRef
 * @param {number} [opts.invoiceBalanceCents] payments: the QBO invoice's current Balance (applied amount cap)
 * @param {string} [opts.previousInvoiceRef] payments: the invoice this payment applied to before (a moved payment)
 * @param {string} [opts.today] YYYY-MM-DD in the company zone (AcceptedDate); defaults from ctx.now
 * @returns {{ entity, body, sparse: boolean, lossyLines?: number[], totalChanged?: boolean, ownExcessCents?: number, warnings: string[], error?: string }}
 *   error 'number_too_long': an estimate or invoice number over 21 characters (4.7); body is null.
 *   ownExcessCents (payments, money pushes): the amount this push left unapplied as credit. Keep it in
 *   link meta (linkMetaFromQbo with `pushed`) so the next push does not count it twice.
 */
export function canonToQbo(collection, canon, ctx = {}, opts = {}) {
  const { role } = linkInfo(ctx);
  const entity = entityFor(collection, canon, role);
  const existing = opts.existing || null;
  const want = (f) => !existing || !Array.isArray(opts.fields) || opts.fields.includes(f);
  const out = { entity, body: null, sparse: Boolean(existing && SPARSE_ENTITIES.has(entity)), warnings: [] };
  if (role === 'fee' && collection === 'payments') out.body = paymentFeeBody(canon, ctx, existing);
  else if (role === 'fee' && collection === 'stripePayouts') out.body = payoutFeeBody(canon, ctx, existing);
  else if (role === 'deposit') { out.body = { Deposit: toDollars(canon.amountCents) }; out.sparse = Boolean(existing); }
  else {
    switch (collection) {
      case 'clients': out.body = customerBody(canon, ctx, existing, want, opts); break;
      case 'jobs': out.body = jobBody(canon, ctx, existing, opts); break;
      case 'items': out.body = itemBody(canon, ctx, existing, opts); break;
      case 'vendors': out.body = vendorBody(canon, ctx, existing, opts); break;
      case 'estimates':
      case 'invoices': docBody(collection, canon, ctx, existing, want, opts, out); break;
      case 'payments': paymentBody(canon, ctx, existing, want, opts, out); break;
      case 'bills': out.body = billBody(canon, ctx, existing); break;
      case 'purchaseOrders': out.body = poBody(canon, ctx, existing); break;
      case 'timeEntries': out.body = timeBody(canon, existing); break;
      case 'stripePayouts': out.body = transferBody(canon, ctx, existing); break;
      default: throw new Error(`no QBO mapping for ${collection}`);
    }
  }
  if (out.body) clean(out.body);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Names

function customerBody(c, ctx, existing, want, opts) {
  const { meta } = linkInfo(ctx);
  const body = {};
  if (want('name')) body.DisplayName = sendName(c.name, meta, opts.displayName);
  if (want('name') || want('type')) {
    body.CompanyName = c.type === 'business' ? qboName(c.name) : (existing?.CompanyName ? '' : undefined);
  }
  if (want('email')) body.PrimaryEmailAddr = emailOf(c.email, existing?.PrimaryEmailAddr);
  if (want('phone')) body.PrimaryPhone = phoneOf(c.phone, existing?.PrimaryPhone);
  if (want('address')) body.BillAddr = addressOrClear(c.address, existing?.BillAddr);
  if (want('notes')) body.Notes = setOrClear(cut(c.notes, NOTES_MAX), existing?.Notes);
  if (want('active')) body.Active = c.active !== false;
  if (!existing && feat(ctx, 'multicurrency')) body.CurrencyRef = { value: 'CAD' };
  return body;
}

function jobBody(c, ctx, existing, opts) {
  const { meta } = linkInfo(ctx);
  return {
    DisplayName: sendName(c.name, meta, opts.displayName), Job: true, ParentRef: refOf(c.parentRef), BillWithParent: true,
    BillAddr: addressOrClear(c.address, existing?.BillAddr), ShipAddr: addressOrClear(c.address, existing?.ShipAddr),
    Active: c.active !== false, CurrencyRef: !existing && feat(ctx, 'multicurrency') ? { value: 'CAD' } : undefined,
  };
}

function itemBody(c, ctx, existing, opts) {
  const { meta } = linkInfo(ctx);
  const body = existing ? fromExisting(existing) : {};
  Object.assign(body, {
    Name: sendName(c.name, meta, opts.displayName), Sku: setOrClear(c.sku, existing?.Sku), Description: setOrClear(c.description, existing?.Description),
    UnitPrice: toDollars(c.priceCents), PurchaseCost: toDollars(c.costCents), Active: c.active !== false,
  });
  if (!existing) {
    const acc = maps(ctx, 'account');
    Object.assign(body, { Type: 'NonInventory', IncomeAccountRef: refOf(acc['income.default']), ExpenseAccountRef: refOf(acc['expense.default']) });
  }
  return body;
}

function vendorBody(c, ctx, existing, opts) {
  const { meta } = linkInfo(ctx);
  const body = existing ? fromExisting(existing) : {};
  Object.assign(body, {
    DisplayName: sendName(c.name, meta, opts.displayName), CompanyName: setOrClear(c.companyName, existing?.CompanyName),
    PrimaryEmailAddr: emailOf(c.email, existing?.PrimaryEmailAddr), PrimaryPhone: phoneOf(c.phone, existing?.PrimaryPhone),
    BillAddr: addressOrClear(c.address, existing?.BillAddr), AcctNum: setOrClear(c.accountNumber, existing?.AcctNum),
    [T5018_FIELD]: c.t5018 === true, Notes: setOrClear(c.notes, existing?.Notes), Active: c.active !== false,
  });
  if (!existing && feat(ctx, 'multicurrency')) body.CurrencyRef = { value: 'CAD' };
  return body;
}

// ---------------------------------------------------------------------------------------------
// Estimates and invoices

const EST_TXN = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected' };

function docBody(collection, c, ctx, existing, want, opts, out) {
  const inv = collection === 'invoices';
  const { meta } = linkInfo(ctx);
  const body = {};
  const numbering = option(ctx, 'numbering', feat(ctx, 'customTxnNumbers') === false ? 'quickbooks' : 'fishtape');
  if (want('number') && numbering !== 'quickbooks' && c.number) {
    // QBO would cut a longer number: it is refused instead (4.7).
    if (String(c.extra?.numberFull || c.number).length > DOC_NUMBER_MAX) { out.error = 'number_too_long'; out.body = null; return; }
    body.DocNumber = c.number;
  }
  if (want('clientRef') || want('jobRef')) body.CustomerRef = refOf(c.jobRef || c.clientRef);
  if (want('date')) body.TxnDate = c.date || undefined;
  if (inv && want('dueDate')) body.DueDate = c.dueDate || undefined;
  if (!inv && want('validUntil')) body.ExpirationDate = c.validUntil || undefined;
  if (want('notes')) body.CustomerMemo = c.notes ? { value: c.notes.slice(0, CUSTOMER_MEMO_MAX) } : (existing?.CustomerMemo?.value ? { value: '' } : undefined);
  // The marker is put back on every write (QBO edits to PrivateNote are ignored, 4.7).
  body.PrivateNote = [str(meta.marker), c.title].filter(Boolean).join(' · ').slice(0, NOTES_MAX) || undefined;
  if (want('lines')) {
    const built = salesLines(collection, c, ctx, existing);
    if (built.error) { out.error = built.error; out.body = null; return; }
    body.Line = built.lines;
    out.lossyLines = built.lossy;
    body.GlobalTaxCalculation = existing ? (str(meta.globalTax) || existing.GlobalTaxCalculation || undefined) : (feat(ctx, 'salesTax') ? 'TaxExcluded' : 'NotApplicable');
  }
  if (inv && want('estimateRef') && c.estimateRef) {
    const linked = (existing?.LinkedTxn || []).some((t) => t.TxnType === 'Estimate' && String(t.TxnId) === String(c.estimateRef));
    if (!linked) body.LinkedTxn = [{ TxnId: String(c.estimateRef), TxnType: 'Estimate' }];
  }
  if (!inv && want('status') && EST_TXN[c.status] && !['Closed', 'Converted'].includes(existing?.TxnStatus)) {
    body.TxnStatus = EST_TXN[c.status];
    if (c.status === 'accepted') body.AcceptedDate = opts.today || localDay(ctx.now || new Date(), ctx?.company?.zone);
  }
  if (!existing) {
    Object.assign(body, { EmailStatus: 'NotSet', PrintStatus: 'NotSet' });
    if (inv) Object.assign(body, { AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false });
    if (opts.billEmail) body.BillEmail = { Address: String(opts.billEmail) };
    if (feat(ctx, 'classes') && maps(ctx, 'class').default) body.ClassRef = refOf(maps(ctx, 'class').default);
    if (feat(ctx, 'locations') && maps(ctx, 'department').default) body.DepartmentRef = refOf(maps(ctx, 'department').default);
    if (inv && maps(ctx, 'term').default) body.SalesTermRef = refOf(maps(ctx, 'term').default);
    if (feat(ctx, 'multicurrency')) body.CurrencyRef = { value: 'CAD' };
    if (!body.GlobalTaxCalculation) body.GlobalTaxCalculation = feat(ctx, 'salesTax') ? 'TaxExcluded' : 'NotApplicable';
  }
  out.body = body;
}

const LINE_OWN = new Set(['Id', 'LineNum', 'Amount', 'Description', 'DetailType', 'SalesItemLineDetail', 'DescriptionLineDetail', 'DiscountLineDetail']);
const DETAIL_OWN = new Set(['ItemRef', 'Qty', 'UnitPrice', 'TaxCodeRef', 'TaxInclusiveAmt']);
const unmodelledLine = (ex) => (ex ? Object.fromEntries(Object.entries(ex).filter(([k]) => !LINE_OWN.has(k))) : {});
const unmodelledDetail = (ex, key) => (ex && ex[key] ? Object.fromEntries(Object.entries(ex[key]).filter(([k]) => !DETAIL_OWN.has(k))) : {});
const qty5 = (q) => Math.round((Number(q) || 0) * 100000) / 100000;
/** A line's text: QBO's own longer text while its first 1,000 characters (all Fishtape keeps) are unchanged. */
function lineText(description, ex) {
  const had = str(ex?.Description);
  if (had && had.length > LINE_DESC_MAX && cut(had, LINE_DESC_MAX) === str(description)) return had;
  return description;
}

function salesLines(collection, c, ctx, existing) {
  const entity = collection === 'invoices' ? 'Invoice' : 'Estimate';
  const exLines = new Map(flatSalesLines(existing).filter((l) => l.Id != null).map((l) => [String(l.Id), l]));
  const exCanon = existing ? new Map(qboToCanon(entity, existing, { ...ctx, collection }).lines.filter((l) => l.lineId).map((l) => [l.lineId, l])) : new Map();
  const lines = c.lines || [];
  const negatives = lines.some((l) => l.amountCents < 0);
  if (negatives && !NEGATIVE_SALES_LINES) {
    const taxCodes = new Set(lines.filter((l) => l.amountCents > 0).map((l) => l.taxCodeId));
    if (!feat(ctx, 'discounts') || taxCodes.size > 1) return { error: 'negative_line' };
  }
  const out = [], lossy = [];
  lines.forEach((l, i) => {
    const ex = l.lineId ? exLines.get(l.lineId) : null;
    const exC = l.lineId ? exCanon.get(l.lineId) : null;
    if (l.lossy && !l.markup) lossy.push(i);
    // An unchanged lossy line goes back exactly as QBO has it (4.7).
    if (l.lossy && ex && exC && canonEqual(collection, 'lines', [l], [exC])) { out.push(clone(ex)); return; }
    const id = ex ? { Id: ex.Id } : {};
    if (l.itemRef == null && !l.amountCents) {
      out.push({ ...id, DetailType: 'DescriptionOnly', Description: (lineText(l.description, ex) || '').slice(0, NOTES_MAX), DescriptionLineDetail: {} });
      return;
    }
    if (l.amountCents < 0 && !NEGATIVE_SALES_LINES) {
      out.push({ ...id, DetailType: 'DiscountLineDetail', Amount: toDollars(-l.amountCents), Description: l.description || 'Discount', DiscountLineDetail: { PercentBased: false } });
      return;
    }
    const q = qty5(l.qty);
    const exact = !l.lossy && q !== 0 && Math.round(q * l.unitCents) === l.amountCents;
    const asIs = exact || (!STRICT_LINE_AMOUNTS && !l.lossy && q !== 0);
    let description = lineText(l.description, ex) || '';
    if (!asIs && !l.lossy && !l.markup && q !== 0) {
      description = `${description}${lossySuffix(l.qty, l.unitCents / 100, { hours: l.kind === 'labour' })}`.trim();
      lossy.push(i);
    }
    const detail = { ...unmodelledDetail(ex, 'SalesItemLineDetail'), ItemRef: refOf(l.itemRef), Qty: asIs ? q : 1, UnitPrice: asIs ? l.unitCents / 100 : toDollars(l.amountCents) };
    if (l.taxCodeId) detail.TaxCodeRef = { value: String(l.taxCodeId) };
    out.push({
      ...unmodelledLine(ex), ...id, DetailType: 'SalesItemLineDetail', Amount: toDollars(l.amountCents),
      Description: description.slice(0, NOTES_MAX), SalesItemLineDetail: detail,
    });
  });
  return { lines: out, lossy: [...new Set(lossy)].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------------------------
// Payments

const invoiceOf = (line) => str((line?.LinkedTxn || []).find((t) => t.TxnType === 'Invoice')?.TxnId);
const unappliedOf = (p) => (p ? (p.UnappliedAmt != null ? toCents(p.UnappliedAmt) : toCents(p.TotalAmt) - sum((p.Line || []).map((l) => toCents(l.Amount)))) : 0);

/**
 * A QBO Payment's Line array with Fishtape's own lines replaced (4.9). `ownedLines` are the lines
 * this push owns, by QBO invoice id; an amount of 0 removes that line. Every other line (credit
 * memos, journals, unlinked invoices, other Fishtape payments) is kept as it is, and TotalAmt moves
 * by exactly the change in the owned lines (+ extraUnappliedCents), so the foreign lines and the
 * unapplied amount stay as they were whatever sign QBO gives credit lines. extraUnappliedCents may
 * be negative (an excess of this payment's own that is no longer needed), never below minus the
 * current unapplied amount. With keepTotal (a Fishtape delete of one part), TotalAmt stays and the
 * removed amount becomes unapplied.
 *
 * TotalAmt is the current TotalAmt moved by the change rather than Σ owned + Σ foreign + unapplied
 * (the 4.9 wording), because QBO subtracts credit-memo lines from TotalAmt; otherwise they agree.
 */
export function rebuildPaymentLines(currentPayment, ownedLines, { extraUnappliedCents = 0, keepTotal = false } = {}) {
  const lines = currentPayment?.Line || [];
  const owned = new Map((ownedLines || []).filter((o) => o && o.invoiceQboId).map((o) => [String(o.invoiceQboId), Math.round(Number(o.amountCents) || 0)]));
  const seen = new Set();
  const out = [];
  let before = 0;
  for (const line of lines) {
    const inv = invoiceOf(line);
    if (inv && owned.has(inv)) {
      before += toCents(line.Amount);
      if (seen.has(inv)) continue;
      seen.add(inv);
      if (owned.get(inv) > 0) out.push({ ...clone(line), Amount: toDollars(owned.get(inv)) });
      continue;
    }
    out.push(clone(line));
  }
  for (const [inv, amount] of owned) {
    if (!seen.has(inv) && amount > 0) out.push({ Amount: toDollars(amount), LinkedTxn: [{ TxnId: inv, TxnType: 'Invoice' }] });
  }
  const after = sum([...owned.values()].filter((a) => a > 0));
  const current = currentPayment ? toCents(currentPayment.TotalAmt) : 0;
  const extra = Math.max(-Math.max(0, unappliedOf(currentPayment)), Math.round(Number(extraUnappliedCents) || 0));
  const total = keepTotal && currentPayment ? current : current + after - before + extra;
  return { Line: out, TotalAmt: toDollars(total) };
}

/** What a QBO Payment holds besides the given owned invoices (4.9: void or only remove our line). */
export function paymentLineSummary(payment, ownedInvoiceIds = []) {
  const own = new Set((ownedInvoiceIds || []).map(String));
  const foreign = [], ownedLines = [];
  for (const l of payment?.Line || []) {
    const inv = invoiceOf(l);
    const row = { invoiceQboId: inv, txnType: (l.LinkedTxn || [])[0]?.TxnType || null, txnId: str((l.LinkedTxn || [])[0]?.TxnId), amountCents: toCents(l.Amount) };
    (inv && own.has(inv) ? ownedLines : foreign).push(row);
  }
  return { ownedLines, foreignLines: foreign, unappliedCents: unappliedOf(payment) };
}

function paymentBody(c, ctx, existing, want, opts, out) {
  const { meta } = linkInfo(ctx);
  const body = existing ? fromExisting(existing) : {};
  const stripe = c.extra?.source === 'stripe';
  body.CustomerRef = refOf(opts.invoiceCustomerRef || existing?.CustomerRef?.value);
  body.TxnDate = c.date || undefined;
  if (c.method?.ref) body.PaymentMethodRef = { value: String(c.method.ref) }; else delete body.PaymentMethodRef;
  body.PaymentRefNum = setOrClear(c.reference, existing?.PaymentRefNum);
  body.PrivateNote = privateNote(meta, [stripe ? c.extra?.paymentIntentId : null], existing);
  if (!existing) {
    const acc = stripe ? maps(ctx, 'account').stripeClearing : maps(ctx, 'depositTo')[c.method?.key];
    if (acc) body.DepositToAccountRef = { value: String(acc) };
    if (feat(ctx, 'multicurrency')) body.CurrencyRef = { value: 'CAD' };
  }
  const money = !existing || want('amountCents') || want('invoiceRef');
  if (money && c.invoiceRef) {
    const owned = [];
    if (opts.previousInvoiceRef && String(opts.previousInvoiceRef) !== String(c.invoiceRef)) owned.push({ invoiceQboId: opts.previousInvoiceRef, amountCents: 0 });
    const current = (existing?.Line || []).filter((l) => invoiceOf(l) === String(c.invoiceRef)).reduce((s, l) => s + toCents(l.Amount), 0);
    const cap = opts.invoiceBalanceCents == null ? Infinity : Math.max(0, Number(opts.invoiceBalanceCents) + current);
    const applied = Math.max(0, Math.min(c.amountCents, cap));
    const excess = Math.max(0, c.amountCents - applied);
    owned.push({ invoiceQboId: c.invoiceRef, amountCents: applied });
    // The excess an earlier push left is already in TotalAmt: only its change counts (4.9).
    const prevExcess = existing ? Math.max(0, Math.round(Number(meta.ownExcessCents) || 0)) : 0;
    const rebuilt = rebuildPaymentLines(existing, owned, { extraUnappliedCents: excess - prevExcess });
    body.Line = rebuilt.Line;
    body.TotalAmt = rebuilt.TotalAmt;
    out.ownExcessCents = excess;
    if (excess > 0) out.warnings.push(`$${(excess / 100).toFixed(2)} left as credit in QuickBooks`);
  }
  out.totalChanged = Boolean(existing) && toCents(body.TotalAmt) !== toCents(existing.TotalAmt);
  out.body = body;
}

function paymentFeeBody(c, ctx, existing) {
  const { meta } = linkInfo(ctx);
  const acc = maps(ctx, 'account');
  const ptc = maps(ctx, 'purchaseTaxCode');
  const body = existing ? fromExisting(existing) : {};
  const ex = existing?.Line?.[0];
  return Object.assign(body, {
    PaymentType: 'Cash', AccountRef: refOf(acc.stripeClearing), EntityRef: option(ctx, 'stripeVendorId', null) ? { value: String(option(ctx, 'stripeVendorId')), type: 'Vendor' } : undefined,
    TxnDate: c.date || undefined, PrivateNote: privateNote(meta, [c.extra?.chargeId ? `Stripe fee ${c.extra.chargeId}` : 'Stripe fee'], existing),
    Line: [{
      ...(ex?.Id ? { Id: ex.Id } : {}), DetailType: 'AccountBasedExpenseLineDetail', Amount: toDollars(c.amountCents), Description: 'Stripe fee',
      AccountBasedExpenseLineDetail: clean({ ...unmodelledDetail(ex, 'AccountBasedExpenseLineDetail'), AccountRef: refOf(acc.stripeFees), TaxCodeRef: refOf(ptc.stripeFee || ptc.NONE) }),
    }],
    GlobalTaxCalculation: existing ? existing.GlobalTaxCalculation : (feat(ctx, 'salesTax') ? 'TaxExcluded' : undefined),
  });
}

// ---------------------------------------------------------------------------------------------
// Bills, receipts, purchase orders, time, Stripe payouts

const PAYMENT_TYPE = { card: 'CreditCard', cash: 'Cash', debit: 'Cash', cheque: 'Check', transfer: 'Check' };
const EXPENSE_OWN = new Set(['ItemRef', 'Qty', 'UnitPrice', 'TaxCodeRef', 'TaxInclusiveAmt', 'AccountRef', 'CustomerRef', 'BillableStatus']);
const expenseExtras = (ex, key) => (ex && ex[key] ? Object.fromEntries(Object.entries(ex[key]).filter(([k]) => !EXPENSE_OWN.has(k))) : {});

/**
 * A receipt whose lines add up below zero is a supplier refund: a QuickBooks Purchase with Credit true
 * and every amount positive (4.10). -1 for those, else 1; the tax override uses the same sign (4.8).
 */
export function purchaseSign(c) {
  return c?.kind === 'receipt' && sum((c.lines || []).map((l) => Number(l.amountCents) || 0)) < 0 ? -1 : 1;
}

function billBody(c, ctx, existing) {
  const { meta } = linkInfo(ctx);
  const bill = c.kind !== 'receipt';
  const body = existing ? fromExisting(existing) : {};
  const sign = purchaseSign(c);
  const credit = sign < 0;
  if (bill) body.VendorRef = refOf(c.vendorRef);
  else {
    body.EntityRef = c.vendorRef ? { value: String(c.vendorRef), type: 'Vendor' } : undefined;
    body.PaymentType = PAYMENT_TYPE[c.paidWith?.key] || body.PaymentType || 'Cash';
    body.AccountRef = refOf(c.paidWith?.ref) || body.AccountRef;
    if (credit) body.Credit = true; else delete body.Credit;
  }
  body.DocNumber = setOrClear(c.number, existing?.DocNumber);
  body.TxnDate = c.date || undefined;
  if (bill) body.DueDate = c.dueDate || undefined;
  const full = str(c.extra?.numberFull);
  const longNumber = full && full.length > DOC_NUMBER_MAX ? `Supplier no. ${full}` : null;
  body.PrivateNote = [str(meta.marker), longNumber, c.notes].filter(Boolean).join(' · ').slice(0, NOTES_MAX) || undefined;
  const exLines = new Map((existing?.Line || []).filter((l) => l.Id != null).map((l) => [String(l.Id), l]));
  body.Line = (c.lines || []).map((l) => {
    const ex = l.lineId ? exLines.get(l.lineId) : null;
    const key = l.itemRef ? 'ItemBasedExpenseLineDetail' : 'AccountBasedExpenseLineDetail';
    const exKey = ex?.ItemBasedExpenseLineDetail ? 'ItemBasedExpenseLineDetail' : 'AccountBasedExpenseLineDetail';
    const exDetail = ex?.[exKey] || {};
    const amount = sign * l.amountCents;
    const detail = {
      ...expenseExtras(ex, exKey),
      CustomerRef: refOf(l.customerRef) || exDetail.CustomerRef,
      BillableStatus: exDetail.BillableStatus === 'HasBeenBilled' ? 'HasBeenBilled' : 'NotBillable',
      TaxCodeRef: refOf(l.taxCodeId),
    };
    if (l.itemRef) {
      // Qty × UnitPrice must give Amount (fault 6000, STRICT_LINE_AMOUNTS); else Qty 1 at the amount.
      let q = qty5(l.qty) || 1;
      let unit = Math.round((amount / 100 / q) * 100000) / 100000;
      if (STRICT_LINE_AMOUNTS && toCents(q * unit) !== amount) { q = 1; unit = toDollars(amount); }
      Object.assign(detail, { ItemRef: refOf(l.itemRef), Qty: q, UnitPrice: unit });
    } else detail.AccountRef = refOf(l.accountRef);
    const line = { ...(ex ? { Id: ex.Id } : {}), DetailType: key, Amount: toDollars(amount), Description: l.description ? l.description.slice(0, NOTES_MAX) : undefined, [key]: clean(detail) };
    if (bill && l.poLine?.poRef) line.LinkedTxn = [clean({ TxnId: String(l.poLine.poRef), TxnType: 'PurchaseOrder', TxnLineId: l.poLine.poLineId || undefined })];
    return clean(line);
  });
  body.GlobalTaxCalculation = existing ? (str(meta.globalTax) || existing.GlobalTaxCalculation || undefined) : (feat(ctx, 'salesTax') ? 'TaxExcluded' : 'NotApplicable');
  if (!existing && feat(ctx, 'multicurrency')) body.CurrencyRef = { value: 'CAD' };
  return body;
}

function poBody(c, ctx, existing) {
  const { meta } = linkInfo(ctx);
  const body = existing ? fromExisting(existing) : {};
  Object.assign(body, {
    VendorRef: refOf(c.vendorRef), TxnDate: c.date || undefined, DueDate: c.dueDate || undefined,
    ShipAddr: addressOrClear(c.shipTo, existing?.ShipAddr), Memo: setOrClear(c.notes, existing?.Memo),
    POStatus: c.status === 'closed' ? 'Closed' : 'Open', PrivateNote: privateNote(meta, [], existing),
  });
  if (feat(ctx, 'purchaseCustomTxnNumbers') && c.number) body.DocNumber = c.number;
  const exLines = (existing?.Line || []).filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail');
  body.Line = (c.lines || []).map((l, i) => {
    const ex = exLines[i];
    const q = qty5(l.qty) || 1;
    return clean({
      ...(ex ? { Id: ex.Id } : {}), DetailType: 'ItemBasedExpenseLineDetail', Amount: toDollars(l.amountCents), Description: l.description || undefined,
      ItemBasedExpenseLineDetail: clean({ ...expenseExtras(ex, 'ItemBasedExpenseLineDetail'), ItemRef: refOf(l.itemRef), Qty: q, UnitPrice: l.unitCents / 100, CustomerRef: refOf(l.customerRef), BillableStatus: 'NotBillable' }),
    });
  });
  return body;
}

function timeBody(c, existing) {
  const body = existing ? fromExisting(existing) : {};
  delete body.EmployeeRef; delete body.VendorRef;
  const vendor = c.employeeRef?.nameOf === 'Vendor';
  const minutes = Math.max(0, Math.round(Number(c.minutes) || 0));
  return Object.assign(body, {
    NameOf: vendor ? 'Vendor' : 'Employee', [vendor ? 'VendorRef' : 'EmployeeRef']: refOf(c.employeeRef?.ref),
    CustomerRef: refOf(c.customerRef), ItemRef: refOf(c.itemRef), TxnDate: c.date || undefined,
    Hours: Math.floor(minutes / 60), Minutes: minutes % 60, Description: c.description || undefined,
    BillableStatus: existing ? existing.BillableStatus : 'NotBillable',
  });
}

function transferBody(c, ctx, existing) {
  const { meta } = linkInfo(ctx);
  const body = existing ? fromExisting(existing) : {};
  return Object.assign(body, {
    FromAccountRef: refOf(c.fromRef), ToAccountRef: refOf(c.toRef), Amount: toDollars(c.amountCents), TxnDate: c.date || undefined,
    PrivateNote: privateNote(meta, [c.extra?.payoutId ? `Stripe payout ${c.extra.payoutId}` : null], existing),
  });
}

function payoutFeeBody(c, ctx, existing) {
  const { meta } = linkInfo(ctx);
  const acc = maps(ctx, 'account');
  const ptc = maps(ctx, 'purchaseTaxCode');
  const body = existing ? fromExisting(existing) : {};
  return Object.assign(body, {
    PaymentType: 'Cash', AccountRef: refOf(acc.stripeClearing),
    EntityRef: option(ctx, 'stripeVendorId', null) ? { value: String(option(ctx, 'stripeVendorId')), type: 'Vendor' } : undefined,
    TxnDate: c.date || undefined,
    PrivateNote: privateNote(meta, [c.extra?.payoutId ? `Stripe payout fees ${c.extra.payoutId}` : 'Stripe payout fees'], existing),
    Line: (c.lines || []).map((l) => ({
      DetailType: 'AccountBasedExpenseLineDetail', Amount: toDollars(l.amountCents), Description: l.description || 'Stripe fee',
      AccountBasedExpenseLineDetail: clean({ AccountRef: refOf(acc.stripeFees), TaxCodeRef: refOf(ptc.stripeFee || ptc.NONE) }),
    })),
    GlobalTaxCalculation: existing ? existing.GlobalTaxCalculation : (feat(ctx, 'salesTax') ? 'TaxExcluded' : undefined),
  });
}
