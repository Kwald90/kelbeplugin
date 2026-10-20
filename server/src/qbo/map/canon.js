// Canonical forms of linked records (docs/integrations/quickbooks.md 4, 5.5). A Fishtape record
// and its QuickBooks object are both turned into the same shape, field by field, so the three-way
// merge can compare them. Pure: no database, no network.
//
// Every canonical value is writable (the mappers in to-qbo.js and to-fishtape.js build from it),
// and compareKey() gives the part that is compared: cuts and normalisers apply to both sides alike
// (addresses by addressKey, e-mail lower case, phone by its last 10 digits, SKU upper case, payment
// methods and accounts by the QBO id they map to, lines by { itemRef, description, amountCents, taxCodeId }).
//
// ctx for every mapper: { collection, mappings, features, company: { province, zone }, refs, link, now }
//   mappings: { item: {}, taxCode: {}, purchaseTaxCode: {}, account: {}, paymentMethod: {}, depositTo: {},
//               paidFrom: {}, class: {}, department: {}, term: {}, option: {} }   (7.6)
//   refs: { qboIdFor(collection, fishtapeId), fishtapeIdFor(collection, qboId), itemKind(qboItemId),
//           itemType(qboItemId), and optionally clientOfJob(jobId) -> clientId,
//           employeeEntity(employeeId) -> 'Employee'|'Vendor', poLineId(purchaseOrderId, index) -> QBO line id }
//     fishtapeIdFor is called with Fishtape collection names ('clients', 'jobs', 'items', ...), which tell
//     a client's customer from a job's sub-customer.
//   link: the qbo_links row (snake_case or camelCase): { role, qbo_line, meta }
//   optional: rates ({ codes, rates, agencies } from qbo_reference, for bill taxes), related ({ job } for
//   time entry descriptions).
import { lineCents, docTotals, entryHours, KINDS } from '../../../../electrical-app/js/lib/money.js';
import { ratesOn, fmtPct } from '../../../../electrical-app/js/lib/tax.js';
import { qboName, stripNameSuffix, jobDisplayName, addressFromQbo, addressToQbo, addressKey } from './names.js';
import { lineTaxKey, purchaseTaxKey, spreadPurchaseTax, taxIdForRate, taxInclusiveToNet, RECOVERABLE } from './tax.js';

/** QBO CustomerMemo is cut to this length on push; both sides are compared cut (VERIFY, 11.4). */
export const CUSTOMER_MEMO_MAX = 1000;
export const DOC_NUMBER_MAX = 21;
export const PAYMENT_REF_MAX = 21;
export const NOTES_MAX = 4000;

// ---------------------------------------------------------------------------------------------
// Small helpers shared by the mappers

/** Trimmed string, or null when empty. */
export function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
export const cut = (v, n) => { const s = str(v); return s == null ? null : s.slice(0, n).trimEnd() || null; };

/** QBO dollars to integer cents, half away from zero, robust to binary fractions (10.115 -> 1012). */
export function toCents(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n)) return 0;
  const c = parseFloat((Math.abs(n) * 100).toPrecision(12));
  return Math.sign(n) * Math.round(c) || 0;
}
/** Integer cents to QBO dollars (a number with at most 2 decimals). */
export const toDollars = (cents) => Number(((Number(cents) || 0) / 100).toFixed(2));

/** The local calendar day of a time in the company zone (never the UTC date, 4.7). */
export function localDay(when, zone = 'America/Toronto') {
  if (when == null || when === '') return null;
  const s = String(when);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: zone || 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
}
const day = (v) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const ref = (r) => str(r && typeof r === 'object' ? r.value : r);

/** The link row's fields whatever their case. */
export function linkInfo(ctx) {
  const l = ctx?.link || {};
  return { role: l.role || 'main', qboLine: str(l.qboLine ?? l.qbo_line), meta: l.meta || {}, qboId: str(l.qboId ?? l.qbo_id) };
}
const maps = (ctx, kind) => ctx?.mappings?.[kind] || {};
const option = (ctx, key, dflt) => (ctx?.mappings?.option && ctx.mappings.option[key] !== undefined ? ctx.mappings.option[key] : dflt);
const refs = (ctx) => ctx?.refs || {};
const qboIdFor = (ctx, coll, id) => (id ? str(refs(ctx).qboIdFor?.(coll, id)) : null);
const zoneOf = (ctx) => ctx?.company?.zone || 'America/Toronto';

/** Marker stamped on every QBO object Fishtape creates: 'Fishtape ref <first 12 hex of link id>'. */
export function markerFor(linkId) {
  const hex = String(linkId ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 12);
  if (hex.length < 12) throw new TypeError('markerFor needs a link id with at least 12 hex digits');
  return `Fishtape ref ${hex}`;
}
const MARKER_RE = /^Fishtape ref [0-9a-f]{12}(?:\s*·\s*)?/;
/** PrivateNote text without the marker in front. */
export const stripMarker = (s) => str(String(s ?? '').replace(MARKER_RE, ''));

/**
 * Payment method keys (4.9): cheque and check are 'check'; etransfer, e-transfer and interac are
 * 'e-transfer'; cash, card, transfer and credit stay; anything else is 'other'. Empty is null.
 */
export function normMethod(method) {
  const m = String(method ?? '').trim().toLowerCase();
  if (!m) return null;
  if (m === 'cheque' || m === 'check' || m === 'chq') return 'check';
  if (/^(e-?transfer|interac|interac e-?transfer|e transfer|emt)$/.test(m)) return 'e-transfer';
  if (['cash', 'card', 'transfer', 'credit'].includes(m)) return m;
  if (m === 'credit card' || m === 'debit card' || m === 'visa' || m === 'mastercard') return 'card';
  return 'other';
}

/** The first key of a mapping kind whose value is `id`, in the order given (else any key). */
function keyFor(mapKind, id, order = []) {
  if (!id) return null;
  for (const k of order) if (mapKind[k] === id) return k;
  for (const [k, v] of Object.entries(mapKind)) if (v === id) return k;
  return null;
}

const GENERIC_KIND = { material: 'material', labour: 'labour', other: 'other', markup: 'material', travel: 'labour', deposit: 'other' };

/** The generic item for a line kind (4.4): deposit for negative lines, then the kind, then material. */
export function genericItem(ctx, kind, { negative = false } = {}) {
  const items = maps(ctx, 'item');
  if (negative) return str(items.deposit) || str(items.other) || null;
  return str(items[kind]) || (kind === 'travel' ? str(items.labour) : null) || (kind === 'markup' ? str(items.material) : null) || null;
}

/** The Fishtape kind of a QBO item: generic item by name, else refs.itemKind, else Service = labour. */
export function kindOfItem(ctx, itemRef) {
  if (!itemRef) return 'other';
  const g = keyFor(maps(ctx, 'item'), itemRef, ['material', 'labour', 'other', 'markup', 'travel', 'deposit']);
  if (g) return GENERIC_KIND[g];
  const k = refs(ctx).itemKind?.(itemRef);
  if (KINDS.includes(k)) return k;
  return refs(ctx).itemType?.(itemRef) === 'Service' ? 'labour' : 'material';
}
export function isGenericItem(ctx, itemRef) {
  return Boolean(itemRef && keyFor(maps(ctx, 'item'), itemRef));
}

// Lossy lines (4.7): " (2.6667 h × $95.00)" on push, " (3 × $12.3333)" on pull.
const LOSSY_SUFFIX = /\s\((?:-?[\d.,]+)(?:\s?h)?\s×\s-?\$[\d.,]+\)$/;
export const stripLossySuffix = (s) => str(String(s ?? '').replace(LOSSY_SUFFIX, ''));
const fmtQty = (q) => String(Math.round((Number(q) || 0) * 100000) / 100000);
export function lossySuffix(qty, unitDollars, { hours = false } = {}) {
  const price = Number(unitDollars) || 0;
  const p = Math.round(price * 100) === price * 100 ? price.toFixed(2) : String(Math.round(price * 100000) / 100000);
  return ` (${fmtQty(qty)}${hours ? ' h' : ''} × $${p})`;
}

function lineIdsOf(meta) {
  const ids = meta?.lineIds;
  if (!ids || typeof ids !== 'object') return {};
  return Array.isArray(ids) ? Object.fromEntries(ids.map((v, i) => [String(i), v])) : ids;
}
const lossySet = (meta) => new Set((Array.isArray(meta?.lossyLines) ? meta.lossyLines : []).map(Number));

/** One of a job's documents or costs: the job's sub-customer when there is one, else the client's customer. */
function customerRefForJob(ctx, jobId, clientId) {
  const subCustomers = option(ctx, 'jobsAsSubCustomers', true) !== false;
  if (jobId && subCustomers) {
    const j = qboIdFor(ctx, 'jobs', jobId);
    if (j) return { clientRef: null, jobRef: j };
  }
  const client = clientId || (jobId ? refs(ctx).clientOfJob?.(jobId) : null);
  return { clientRef: qboIdFor(ctx, 'clients', client), jobRef: null };
}

const isBusiness = (type) => type === 'commercial' || type === 'industrial';

// ---------------------------------------------------------------------------------------------
// Fishtape record -> canonical

/** The canonical form of a Fishtape record (L). */
export function fishtapeToCanon(collection, record, ctx = {}) {
  const r = record || {};
  const { role, meta } = linkInfo(ctx);
  switch (collection) {
    case 'clients':
      return {
        name: str(qboName(r.name)), type: isBusiness(r.type) ? 'business' : 'residential',
        email: str(r.email), phone: str(r.phone), address: str(r.address), active: r.active !== false,
        notes: cut(r.notes, NOTES_MAX),
      };
    case 'vendors':
      return {
        name: str(qboName(r.name)), companyName: cut(r.companyName, 100), email: str(r.email), phone: str(r.phone),
        address: str(r.address), accountNumber: cut(r.accountNumber, 100), t5018: r.t5018 === true,
        notes: cut(r.notes, NOTES_MAX), active: r.active !== false,
      };
    case 'items':
      return {
        name: str(qboName(r.name)), sku: cut(r.sku, 100), description: cut(r.description, NOTES_MAX),
        priceCents: Math.round(Number(r.priceCents) || 0), costCents: Math.round(Number(r.costCents) || 0), active: r.active !== false,
      };
    case 'jobs':
      return {
        name: jobDisplayName(r), parentRef: qboIdFor(ctx, 'clients', r.clientId),
        address: str(r.address), active: r.active !== false,
      };
    case 'estimates':
    case 'invoices':
      return docToCanon(collection, r, ctx, meta);
    case 'payments':
      if (role === 'fee') return paymentFeeCanon(r);
      return {
        invoiceRef: qboIdFor(ctx, 'invoices', r.invoiceId), amountCents: Math.round(Number(r.amountCents) || 0),
        date: day(r.date), method: methodValue(ctx, r.source === 'stripe' ? 'card' : r.method),
        reference: cut(r.reference, PAYMENT_REF_MAX),
        extra: { source: str(r.source), feeCents: Number.isInteger(r.stripe?.feeCents) ? r.stripe.feeCents : null, paymentIntentId: str(r.stripe?.paymentIntentId) },
      };
    case 'bills':
      return billToCanon(r, ctx, meta);
    case 'purchaseOrders':
      return poToCanon(r, ctx);
    case 'timeEntries':
      return timeToCanon(r, ctx);
    case 'stripePayouts':
      if (role === 'fee') return payoutFeeCanon(r);
      return {
        amountCents: Math.round(Number(r.amount_cents ?? r.amountCents) || 0), date: day(r.arrival_date ?? r.arrivalDate),
        fromRef: str(maps(ctx, 'account').stripeClearing), toRef: str(maps(ctx, 'account').stripePayoutBank),
        extra: { payoutId: str(r.payout_id ?? r.payoutId) },
      };
    default:
      throw new Error(`no canonical form for ${collection}`);
  }
}

function methodValue(ctx, method) {
  const key = normMethod(method);
  const pm = maps(ctx, 'paymentMethod');
  return { ref: key ? str(pm[key]) || str(pm.other) : null, key };
}

function paymentFeeCanon(r) {
  return {
    amountCents: Math.round(Number(r.stripe?.feeCents) || 0), date: day(r.date),
    extra: { chargeId: str(r.stripe?.chargeId), paymentIntentId: str(r.stripe?.paymentIntentId) },
  };
}

/** Payout-level Stripe fee items (4.9): fees that belong to no charge, one line each. */
export function payoutFeeItems(balanceTxns) {
  const out = [];
  for (const t of Array.isArray(balanceTxns) ? balanceTxns : []) {
    if (t.type === 'stripe_fee' || t.type === 'tax') out.push({ id: t.id, description: t.type === 'tax' ? 'Stripe fee tax' : 'Stripe fee', amountCents: Math.abs(Number(t.amountCents) || 0) });
    else if ((t.type === 'payout' || t.type === 'adjustment') && Number(t.feeCents) > 0) {
      out.push({ id: t.id, description: t.type === 'payout' ? 'Stripe payout fee' : 'Stripe dispute fee', amountCents: Number(t.feeCents) });
    }
  }
  return out;
}

function payoutFeeCanon(r) {
  const lines = payoutFeeItems(r.balance_txns ?? r.balanceTxns).map((x) => ({ description: x.description, amountCents: x.amountCents }));
  return {
    amountCents: lines.reduce((s, l) => s + l.amountCents, 0), date: day(r.arrival_date ?? r.arrivalDate), lines,
    extra: { payoutId: str(r.payout_id ?? r.payoutId) },
  };
}

const EST_STATUS = { draft: 'pending', sent: 'pending', accepted: 'accepted', declined: 'rejected' };

function docToCanon(collection, r, ctx, meta) {
  const inv = collection === 'invoices';
  const { clientRef, jobRef } = customerRefForJob(ctx, r.jobId, r.clientId);
  const totals = docTotals(r);
  const out = {
    number: cut(r.number, DOC_NUMBER_MAX), clientRef, jobRef,
    date: inv ? day(r.issueDate) : (day(r.issueDate) || localDay(r.createdAt, zoneOf(ctx))),
    lines: docLines(r, ctx, meta, totals),
    status: inv ? (r.status === 'void' ? 'void' : 'open') : (EST_STATUS[r.status] || 'pending'),
    notes: cut(r.notes, CUSTOMER_MEMO_MAX), title: cut(r.title, NOTES_MAX),
  };
  if (inv) { out.dueDate = day(r.dueDate); out.estimateRef = qboIdFor(ctx, 'estimates', r.estimateId); }
  else out.validUntil = day(r.validUntil);
  out.extra = { totalCents: totals.totalCents, taxes: totals.taxes.map((t) => ({ id: t.id, pct: t.pct, cents: t.cents, baseCents: t.baseCents })) };
  return out;
}

function docLines(r, ctx, meta, totals = docTotals(r)) {
  const codes = maps(ctx, 'taxCode');
  const code = (kind) => str(codes[lineTaxKey(r, kind)]);
  const ids = lineIdsOf(meta);
  const lossy = lossySet(meta);
  const out = (r.lines || []).map((l, i) => {
    const kind = KINDS.includes(l.kind) ? l.kind : 'material';
    const amountCents = lineCents(l);
    const qty = Number(l.qty) || 0, unitCents = Math.round(Number(l.unitCents) || 0);
    const descOnly = !l.itemId && qty === 0 && unitCents === 0;
    const isLossy = lossy.has(i);
    const line = {
      itemRef: descOnly ? null : (l.itemId ? qboIdFor(ctx, 'items', l.itemId) : genericItem(ctx, kind, { negative: amountCents < 0 })),
      kind, description: isLossy ? stripLossySuffix(l.description) : str(l.description), amountCents,
      taxCodeId: descOnly ? null : code(kind), qty, unitCents, lineId: str(ids[String(i)]),
    };
    if (isLossy) line.lossy = true;
    return line;
  });
  if (totals.markupCents) {
    out.push({
      itemRef: genericItem(ctx, 'markup'), kind: 'material', description: `Materials markup (${fmtPct(r.markupPct)}%)`,
      amountCents: totals.markupCents, taxCodeId: code('material'), qty: 1, unitCents: totals.markupCents, lineId: str(ids.markup), markup: true,
    });
  }
  return out;
}

function billToCanon(r, ctx, meta) {
  const receipt = r.kind === 'receipt';
  const province = r.taxProvince || ctx?.company?.province || null;
  const date = day(r.date);
  const key = purchaseTaxKey(r, province);
  const taxCodeId = str(maps(ctx, 'purchaseTaxCode')[key]);
  const accounts = maps(ctx, 'account');
  const ids = lineIdsOf(meta);
  const raw = (r.lines || []).map((l) => ({ ...l, amountCents: Number.isInteger(l.amountCents) ? l.amountCents : lineCents(l) }));
  const printed = (r.taxes || []).map((t) => ({ id: String(t.id || '').toUpperCase(), cents: Math.round(Number(t.cents) || 0) }));
  const spread = spreadPurchaseTax(raw, printed, RECOVERABLE);
  const pctOf = (id) => ratesOn(province, date || undefined).find((p) => p.id === id)?.pct ?? (id === 'GST' ? 5 : null);
  const number = str(r.number);
  return {
    kind: receipt ? 'receipt' : 'bill',
    vendorRef: qboIdFor(ctx, 'vendors', r.vendorId),
    number: cut(number, DOC_NUMBER_MAX),
    date,
    dueDate: receipt ? null : day(r.dueDate),
    notes: cut(r.notes, NOTES_MAX),
    paidWith: receipt ? { ref: str(maps(ctx, 'paidFrom')[r.paidWith]), key: str(r.paidWith) } : null,
    lines: spread.lines.map((l, i) => {
      const linked = l.itemId ? qboIdFor(ctx, 'items', l.itemId) : null;
      const inventory = linked && refs(ctx).itemType?.(linked) === 'Inventory';
      const itemRef = linked && !inventory ? linked : null;
      const costType = ['material', 'subcontract', 'equipment', 'other'].includes(l.costType) ? l.costType : 'material';
      const c = customerRefForJob(ctx, l.jobId || r.jobId, null);
      const po = l.poLine && l.poLine.purchaseOrderId
        ? { poRef: qboIdFor(ctx, 'purchaseOrders', l.poLine.purchaseOrderId), poLineId: str(refs(ctx).poLineId?.(l.poLine.purchaseOrderId, l.poLine.index)) } : null;
      return {
        itemRef, accountRef: itemRef ? null : (str(accounts[`jobCost.${costType}`]) || str(accounts['jobCost.material'])),
        description: cut(l.description, NOTES_MAX), amountCents: l.amountCents, taxCodeId, customerRef: c.jobRef || c.clientRef,
        qty: Number(l.qty) || 0, unitCents: Math.round(Number(l.unitCents) || 0), lineId: str(ids[String(i)]), costType,
        ...(po && po.poRef ? { poLine: po } : {}),
      };
    }),
    taxes: spread.taxes.filter((t) => t.cents).map((t) => ({ id: t.id, pct: pctOf(t.id), cents: t.cents })).sort((a, b) => a.id.localeCompare(b.id)),
    extra: { numberFull: number, taxKey: key, province },
  };
}

const PO_STATUS = { draft: 'draft', open: 'open', sent: 'open', closed: 'closed', cancelled: 'cancelled' };

function poToCanon(r, ctx) {
  const items = maps(ctx, 'item');
  return {
    vendorRef: qboIdFor(ctx, 'vendors', r.vendorId), number: cut(r.number, DOC_NUMBER_MAX), date: day(r.date), dueDate: day(r.expectedDate),
    lines: (r.lines || []).map((l) => {
      const c = customerRefForJob(ctx, l.jobId || r.jobId, null);
      return {
        itemRef: (l.itemId ? qboIdFor(ctx, 'items', l.itemId) : null) || str(items.material), description: cut(l.description, NOTES_MAX),
        qty: Number(l.qty) || 0, unitCents: Math.round(Number(l.unitCents) || 0), amountCents: lineCents(l), customerRef: c.jobRef || c.clientRef,
      };
    }),
    shipTo: str(r.shipTo), notes: cut(r.notes, NOTES_MAX), status: PO_STATUS[r.status] || 'open',
  };
}

function timeToCanon(e, ctx) {
  const items = maps(ctx, 'item');
  const travel = e.kind === 'travel' || (e.kind == null && e.travel === true);
  const c = customerRefForJob(ctx, e.jobId, null);
  const { meta } = linkInfo(ctx);
  const job = ctx?.related?.job;
  const head = job ? [job.number, job.title].filter(Boolean).join(' ') : '';
  const desc = [[head, str(e.note)].filter(Boolean).join(' - '), str(meta.marker)].filter(Boolean).join(' · ');
  const minutes = Math.round(entryMinutes(e));
  return {
    employeeRef: { nameOf: refs(ctx).employeeEntity?.(e.employeeId) === 'Vendor' ? 'Vendor' : 'Employee', ref: qboIdFor(ctx, 'employees', e.employeeId) },
    customerRef: c.jobRef || c.clientRef, itemRef: str(travel ? (items.travel || items.labour) : items.labour),
    date: localDay(e.clockIn, zoneOf(ctx)), minutes, description: cut(desc, NOTES_MAX),
  };
}

/** Net worked minutes of a closed entry (money.js entryHours already deducts breakMins; 4.11). */
const entryMinutes = (e) => (e.clockIn && e.clockOut ? entryHours(e) * 60 : 0);

// ---------------------------------------------------------------------------------------------
// QBO object -> canonical

/** The canonical form of a QBO object (R). */
export function qboToCanon(entity, object, ctx = {}) {
  const o = object || {};
  const { role, meta, qboLine } = linkInfo(ctx);
  const coll = ctx.collection;
  switch (entity) {
    case 'Customer': {
      const name = nameBack(o.DisplayName, meta);
      if (coll === 'jobs' || (o.Job === true && coll !== 'clients')) {
        return { name, parentRef: ref(o.ParentRef), address: str(addressFromQbo(o.BillAddr)), active: o.Active !== false };
      }
      return {
        name, type: str(o.CompanyName) ? 'business' : 'residential', email: str(o.PrimaryEmailAddr?.Address),
        phone: str(o.PrimaryPhone?.FreeFormNumber), address: str(addressFromQbo(o.BillAddr)), active: o.Active !== false,
        notes: cut(o.Notes, NOTES_MAX),
      };
    }
    case 'Vendor':
      return {
        name: nameBack(o.DisplayName, meta), companyName: cut(o.CompanyName, 100), email: str(o.PrimaryEmailAddr?.Address),
        phone: str(o.PrimaryPhone?.FreeFormNumber), address: str(addressFromQbo(o.BillAddr)), accountNumber: cut(o.AcctNum, 100),
        t5018: o[T5018_FIELD] === true, notes: cut(o.Notes, NOTES_MAX), active: o.Active !== false,
      };
    case 'Item':
      return {
        name: nameBack(o.Name, meta), sku: cut(o.Sku, 100), description: cut(o.Description, NOTES_MAX),
        priceCents: toCents(o.UnitPrice ?? 0), costCents: toCents(o.PurchaseCost ?? 0), active: o.Active !== false,
      };
    case 'Estimate':
    case 'Invoice':
      if (coll === 'payments' && role === 'deposit') {
        return { invoiceRef: str(o.Id), amountCents: toCents(o.Deposit), date: day(o.TxnDate), method: methodValue(ctx, 'transfer'), reference: 'Deposit in QuickBooks' };
      }
      return docFromQbo(entity, o, ctx, meta);
    case 'Payment':
      return paymentFromQbo(o, ctx, qboLine);
    case 'Bill':
      return billFromQbo('bill', o, ctx);
    case 'Purchase':
      if (role === 'fee' && coll === 'stripePayouts') {
        return {
          amountCents: o.TotalAmt != null ? toCents(o.TotalAmt) : (o.Line || []).reduce((s, l) => s + toCents(l.Amount), 0), date: day(o.TxnDate),
          lines: (o.Line || []).map((l) => ({ description: str(l.Description), amountCents: toCents(l.Amount) })),
        };
      }
      if (role === 'fee') return { amountCents: o.TotalAmt != null ? toCents(o.TotalAmt) : (o.Line || []).reduce((s, l) => s + toCents(l.Amount), 0), date: day(o.TxnDate) };
      return billFromQbo('receipt', o, ctx);
    case 'PurchaseOrder':
      return {
        vendorRef: ref(o.VendorRef), number: cut(o.DocNumber, DOC_NUMBER_MAX), date: day(o.TxnDate), dueDate: day(o.DueDate),
        lines: (o.Line || []).filter((l) => l.DetailType === 'ItemBasedExpenseLineDetail').map((l) => {
          const d = l.ItemBasedExpenseLineDetail || {};
          return {
            itemRef: ref(d.ItemRef), description: cut(l.Description, NOTES_MAX), qty: Number(d.Qty ?? 1) || 0, unitCents: toCents(d.UnitPrice ?? 0),
            amountCents: toCents(l.Amount), customerRef: ref(d.CustomerRef),
          };
        }),
        shipTo: str(addressFromQbo(o.ShipAddr)), notes: cut(o.Memo, NOTES_MAX), status: o.POStatus === 'Closed' ? 'closed' : 'open',
      };
    case 'TimeActivity':
      return {
        employeeRef: { nameOf: o.NameOf === 'Vendor' ? 'Vendor' : 'Employee', ref: ref(o.NameOf === 'Vendor' ? o.VendorRef : o.EmployeeRef) },
        customerRef: ref(o.CustomerRef), itemRef: ref(o.ItemRef), date: day(o.TxnDate),
        minutes: (Number(o.Hours) || 0) * 60 + (Number(o.Minutes) || 0), description: cut(o.Description, NOTES_MAX),
      };
    case 'Transfer':
      return { amountCents: toCents(o.Amount), date: day(o.TxnDate), fromRef: ref(o.FromAccountRef), toRef: ref(o.ToAccountRef) };
    default:
      throw new Error(`no canonical form for QBO ${entity}`);
  }
}

/** QBO's vendor field for T5018 reporting (VERIFY the name, 11.4 item 9). */
export const T5018_FIELD = 'T5018Eligible';

/** A name read back: the exact name Fishtape sent (meta.displayName) counts as the name without its " (n)" suffix. */
function nameBack(name, meta) {
  const n = str(qboName(name));
  if (n && meta?.displayName && n === qboName(meta.displayName)) return str(stripNameSuffix(n));
  return n;
}

const QBO_EST_STATUS = { Pending: 'pending', Accepted: 'accepted', Closed: 'accepted', Converted: 'accepted', Rejected: 'rejected' };

/**
 * A QBO invoice voided in QBO (4.7): TotalAmt 0, every line amount 0 and PrivateNote starting
 * "Voided" (VERIFY a more reliable marker; a confirmed `voided` webhook also counts, W3).
 */
export function isVoidedInvoice(o) {
  if (!o) return false;
  if (toCents(o.TotalAmt) !== 0) return false;
  const lines = (o.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail');
  return lines.every((l) => toCents(l.Amount) === 0) && /^Voided/i.test(String(o.PrivateNote || ''));
}

function docFromQbo(entity, o, ctx, meta) {
  const inv = entity === 'Invoice';
  const cust = ref(o.CustomerRef);
  const isJob = cust && refs(ctx).fishtapeIdFor?.('jobs', cust);
  const out = {
    number: cut(o.DocNumber, DOC_NUMBER_MAX), clientRef: isJob ? null : cust, jobRef: isJob ? cust : null,
    date: day(o.TxnDate), lines: salesLinesFromQbo(o, ctx, meta),
    status: inv ? (isVoidedInvoice(o) ? 'void' : 'open') : (QBO_EST_STATUS[o.TxnStatus] || 'pending'),
    notes: cut(o.CustomerMemo?.value, CUSTOMER_MEMO_MAX), title: stripMarker(o.PrivateNote),
  };
  if (inv) {
    out.dueDate = day(o.DueDate);
    out.estimateRef = str((o.LinkedTxn || []).find((t) => t.TxnType === 'Estimate')?.TxnId);
  } else out.validUntil = day(o.ExpirationDate);
  out.extra = {
    totalCents: toCents(o.TotalAmt), balanceCents: o.Balance == null ? null : toCents(o.Balance), globalTax: str(o.GlobalTaxCalculation),
    taxInclusive: o.GlobalTaxCalculation === 'TaxInclusive', txnStatus: str(o.TxnStatus),
    taxLines: taxLinesOf(o.TxnTaxDetail), totalTaxCents: toCents(o.TxnTaxDetail?.TotalTax ?? 0),
  };
  return out;
}

/** TxnTaxDetail.TaxLine as [{ rateId, pct, cents, netCents }]. */
export function taxLinesOf(detail) {
  return (detail?.TaxLine || []).filter((l) => !l.DetailType || l.DetailType === 'TaxLineDetail').map((l) => ({
    rateId: ref(l.TaxLineDetail?.TaxRateRef), pct: l.TaxLineDetail?.TaxPercent == null ? null : Number(l.TaxLineDetail.TaxPercent),
    cents: toCents(l.Amount), netCents: l.TaxLineDetail?.NetAmountTaxable == null ? null : toCents(l.TaxLineDetail.NetAmountTaxable),
  }));
}

/** QBO sales lines flattened (groups opened, subtotals dropped), each with its QBO Line.Id. */
export function flatSalesLines(o) {
  const out = [];
  for (const l of o?.Line || []) {
    if (l.DetailType === 'SubTotalLineDetail') continue;
    if (l.DetailType === 'GroupLineDetail') { for (const g of l.GroupLineDetail?.Line || []) out.push(g); continue; }
    out.push(l);
  }
  return out;
}

const MARKUP_RE = /^Materials markup/i;

function salesLinesFromQbo(o, ctx, meta) {
  const inclusive = o.GlobalTaxCalculation === 'TaxInclusive';
  const lossyListed = lossySet(meta);
  const markupItem = genericItem(ctx, 'markup');
  const plain = [], markups = [];
  for (const l of flatSalesLines(o)) {
    if (l.DetailType === 'DescriptionOnly') {
      plain.push({ itemRef: null, kind: 'other', description: str(l.Description), amountCents: 0, taxCodeId: null, qty: 0, unitCents: 0, lineId: str(l.Id) });
      continue;
    }
    if (l.DetailType === 'DiscountLineDetail') {
      const amount = -Math.abs(toCents(l.Amount));
      plain.push({
        itemRef: genericItem(ctx, 'other', { negative: true }), kind: 'other', description: str(l.Description) || 'Discount', amountCents: amount,
        taxCodeId: ref(l.DiscountLineDetail?.TaxCodeRef), qty: 1, unitCents: amount, lineId: str(l.Id), discount: true,
      });
      continue;
    }
    if (l.DetailType !== 'SalesItemLineDetail') continue;
    const d = l.SalesItemLineDetail || {};
    const itemRef = ref(d.ItemRef);
    const amountCents = toCents(inclusive && d.TaxInclusiveAmt != null ? d.TaxInclusiveAmt : l.Amount);
    const qty = d.Qty == null ? 1 : Number(d.Qty) || 0;
    const unitCents = d.UnitPrice == null ? amountCents : toCents(d.UnitPrice);
    const exact = Math.round(qty * unitCents) === amountCents || (d.Qty == null && d.UnitPrice == null);
    const description = str(l.Description);
    if (markupItem && itemRef === markupItem && MARKUP_RE.test(description || '')) {
      markups.push({ itemRef, kind: 'material', description, amountCents, taxCodeId: ref(d.TaxCodeRef), qty: 1, unitCents: amountCents, lineId: str(l.Id), markup: true });
      continue;
    }
    const index = plain.length;
    const line = {
      itemRef, kind: kindOfItem(ctx, itemRef), description: lossyListed.has(index) ? stripLossySuffix(description) : description,
      amountCents, taxCodeId: ref(d.TaxCodeRef), qty: exact ? qty : 1, unitCents: exact ? unitCents : amountCents, lineId: str(l.Id),
    };
    if (!exact) line.lossy = { qty: d.Qty, unitPrice: d.UnitPrice };
    else if (lossyListed.has(index)) line.lossy = true;
    plain.push(line);
  }
  return [...plain, ...markups];
}

function paymentFromQbo(o, ctx, qboLine) {
  const invoiceLines = (o.Line || []).map((l) => ({ l, inv: str((l.LinkedTxn || []).find((t) => t.TxnType === 'Invoice')?.TxnId) })).filter((x) => x.inv);
  let hit = qboLine ? invoiceLines.find((x) => x.inv === qboLine) : invoiceLines[0];
  if (!hit && qboLine && invoiceLines.length === 1) hit = invoiceLines[0]; // the line moved to another invoice
  const pmRef = ref(o.PaymentMethodRef);
  const pm = maps(ctx, 'paymentMethod');
  return {
    invoiceRef: hit ? hit.inv : null, amountCents: hit ? toCents(hit.l.Amount) : 0, date: day(o.TxnDate),
    method: { ref: pmRef, key: keyFor(pm, pmRef, ['check', 'cash', 'card', 'e-transfer', 'transfer', 'other']) || (pmRef ? 'other' : null) },
    reference: cut(o.PaymentRefNum, PAYMENT_REF_MAX),
    extra: { totalCents: toCents(o.TotalAmt), unappliedCents: o.UnappliedAmt == null ? null : toCents(o.UnappliedAmt), depositTo: ref(o.DepositToAccountRef) },
  };
}

/**
 * QBO Bill or Purchase -> canonical bill. Tax-inclusive objects are converted to net (4.8); PST/RST
 * tax lines are spread into the line amounts exactly as on the Fishtape side, so a pulled bill
 * compares equal to what Fishtape stores; a Purchase with Credit: true becomes negative amounts.
 */
function billFromQbo(kind, o, ctx) {
  const sign = o.Credit === true ? -1 : 1;
  const expense = (o.Line || []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail' || l.DetailType === 'ItemBasedExpenseLineDetail');
  const net = o.GlobalTaxCalculation === 'TaxInclusive' ? taxInclusiveToNet(o, { ...(ctx.rates || {}), province: ctx?.company?.province }).lines.map((l) => l.netCents) : null;
  const province = ctx?.company?.province || null;
  const rates = ctx?.rates?.rates || [];
  const paidFrom = maps(ctx, 'paidFrom');
  const accRef = kind === 'receipt' ? ref(o.AccountRef) : null;
  const note = stripMarker(o.PrivateNote);
  const numberNote = /^Supplier no\. [^·]*(?:\s*·\s*)?/;
  return {
    kind,
    vendorRef: ref(kind === 'bill' ? o.VendorRef : o.EntityRef),
    number: cut(o.DocNumber, DOC_NUMBER_MAX),
    date: day(o.TxnDate),
    dueDate: kind === 'bill' ? day(o.DueDate) : null,
    notes: str(String(note || '').replace(numberNote, '')),
    paidWith: kind === 'receipt' ? { ref: accRef, key: keyFor(paidFrom, accRef, ['card', 'cash', 'debit', 'cheque', 'transfer']), paymentType: str(o.PaymentType) } : null,
    ...spreadPurchaseTax(expense.map((l, i) => {
      const item = l.DetailType === 'ItemBasedExpenseLineDetail';
      const d = (item ? l.ItemBasedExpenseLineDetail : l.AccountBasedExpenseLineDetail) || {};
      const amount = net ? net[i] : toCents(l.Amount);
      return {
        itemRef: item ? ref(d.ItemRef) : null, accountRef: item ? null : ref(d.AccountRef), description: cut(l.Description, NOTES_MAX),
        amountCents: sign * amount, taxCodeId: ref(d.TaxCodeRef), customerRef: ref(d.CustomerRef),
        qty: item ? Number(d.Qty ?? 1) || 0 : 1, unitCents: item ? sign * toCents(d.UnitPrice ?? 0) : sign * amount, lineId: str(l.Id),
      };
    }), taxLinesOf(o.TxnTaxDetail).filter((t) => t.cents).map((t) => {
      const rate = rates.find((x) => String(x.Id) === t.rateId);
      return { id: taxIdForRate(rate, province, t.pct), pct: t.pct ?? (rate ? Number(rate.RateValue) : null), cents: sign * t.cents, rateId: t.rateId };
    }).sort((a, b) => String(a.id).localeCompare(String(b.id))), RECOVERABLE),
    extra: { totalCents: sign * toCents(o.TotalAmt), balanceCents: o.Balance == null ? null : toCents(o.Balance), globalTax: str(o.GlobalTaxCalculation), taxInclusive: o.GlobalTaxCalculation === 'TaxInclusive' },
  };
}


// ---------------------------------------------------------------------------------------------
// Comparison

const ADDRESS_FIELDS = new Set(['address', 'shipTo']);

function phoneCompare(v) {
  const digits = String(v).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : String(v).trim().toLowerCase();
}

/**
 * The part of a canonical value that is compared. Equal keys mean "the same in both systems".
 * Lines compare { itemRef, description, amountCents, taxCodeId } (4.7); qty, unit price, kind and
 * QBO line ids are carried for writing but never compared (QBO knows a line's kind only through
 * its item and tax code).
 */
export function compareKey(collection, field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (ADDRESS_FIELDS.has(field)) return addressKey(addressFromQbo(addressToQbo(value))) || null;
  if (field === 'email') return String(value).trim().toLowerCase().replace(/^mailto:/, '') || null;
  if (field === 'phone') return phoneCompare(value) || null;
  if (field === 'sku') return String(value).trim().toUpperCase().replace(/\s+/g, '') || null;
  if (field === 'method' || field === 'paidWith') return value && typeof value === 'object' ? (value.ref ?? null) : value;
  if (field === 'employeeRef') return value && typeof value === 'object' ? `${value.nameOf}:${value.ref ?? ''}` : value;
  if (field === 'taxes' && Array.isArray(value)) return value.reduce((s, t) => s + (Number(t.cents) || 0), 0);
  if (field === 'lines' && Array.isArray(value)) {
    // A bill's tax is its own money field (`taxes`, the printed recoverable amounts); its lines
    // carry the purchase code for writing only, since PST/RST is already in their amounts.
    if (collection === 'bills') return value.map((l) => [l.itemRef ?? null, l.accountRef ?? null, str(l.description), l.amountCents, l.customerRef ?? null]);
    if (collection === 'purchaseOrders') return value.map((l) => [l.itemRef ?? null, str(l.description), Math.round((Number(l.qty) || 0) * 100000), l.unitCents, l.customerRef ?? null]);
    if (collection === 'payoutFee') return value.map((l) => [str(l.description), l.amountCents]);
    return value.map((l) => [l.itemRef ?? null, str(l.description), l.amountCents, l.taxCodeId ?? null]);
  }
  if (typeof value === 'string') return value.trim() || null;
  return value;
}

/** True when two canonical values of a field are the same in both systems. */
export function canonEqual(collection, field, a, b) {
  return stableStringify(compareKey(collection, field, a)) === stableStringify(compareKey(collection, field, b));
}

/** JSON with sorted object keys, so equal values always give equal text. */
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
