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
//           employeeEntity(employeeId) -> 'Employee'|'Vendor', poLineId(purchaseOrderId, index) -> QBO line id,
//           parentOf(qboCustomerId) -> the ParentRef of a QBO sub-customer or project, else null }
//     fishtapeIdFor is called with Fishtape collection names ('clients', 'jobs', 'items', ...), which tell
//     a client's customer from a job's sub-customer. Without parentOf, a pulled document on a sub-customer
//     that is not a linked job keeps the sub-customer as its client (customerFromQbo).
//   link: the qbo_links row (snake_case or camelCase): { role, qbo_line, meta }
//   optional: rates ({ codes, rates, agencies } from qbo_reference, for bill taxes), related ({ job } for
//   time entry descriptions), taxUse(line, { vendor }) (rst.js billLineTaxUse, r1-get-paid.md 9.3) and
//   refs.vendor(vendorId) -> { meSubtrade } for a bill line's resale or own use.
//
// Release 1 (r1-get-paid.md 9): per-line tax codes (a line's taxOff), the holdback as a negative line
// on item.holdback, deposit and interest lines on item.deposit and item.interest, credit notes as a
// CreditMemo (canonical amounts keep Fishtape's sign: a credit note's lines are negative on both
// sides), supplier credits as a VendorCredit, and RST on resale bill lines as one line on
// account.rstRecoverable.
import { lineCents, docTotals, entryHours, invoiceKind, KINDS } from '../../../../electrical-app/js/lib/money.js';
import { ratesOn, fmtPct } from '../../../../electrical-app/js/lib/tax.js';
import { qboName, stripNameSuffix, jobDisplayName, addressFromQbo, addressToQbo, addressKey } from './names.js';
import { lineTaxKey, holdbackTaxKey, purchaseTaxKey, spreadPurchaseTax, taxIdForRate, taxInclusiveToNet, fallbackBillLineTaxUse, RECOVERABLE } from './tax.js';

/** QBO CustomerMemo is cut to this length on push; both sides are compared cut (VERIFY, 11.4). */
export const CUSTOMER_MEMO_MAX = 1000;
export const DOC_NUMBER_MAX = 21;
export const PAYMENT_REF_MAX = 21;
export const NOTES_MAX = 4000;
/** Fishtape's limit on an estimate or invoice line description (schema lines[].description); QBO allows 4000. */
export const LINE_DESC_MAX = 1000;
/** Room kept for a lossy suffix: lossy lines are compared, and written to Fishtape, cut to LINE_DESC_MAX − this. */
export const LOSSY_ROOM = 60;
/** Fishtape's limit on an item SKU (schema items.sku); QBO allows 100. */
export const SKU_MAX = 80;

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

const GENERIC_KIND = { material: 'material', labour: 'labour', other: 'other', markup: 'material', travel: 'labour', deposit: 'other', holdback: 'other', interest: 'other' };
/** The generic item of each special line type (r1-get-paid.md 9.2). */
export const LINE_TYPE_ITEM = { deposit: 'deposit', holdback: 'holdback', interest: 'interest' };
/** The text of the holdback line and of the RST recoverable bill line (QuickBooks shows them). */
export const holdbackLineText = (doc) => {
  const pct = Number(doc?.holdback?.pct);
  return pct ? `Holdback retained (${fmtPct(pct)}%)` : 'Holdback retained';
};
export const RST_RECOVERABLE_TEXT = 'RST on resale materials, recoverable from the supplier';

/** The generic item for a line kind (4.4): deposit for negative lines, then the kind, then material. */
export function genericItem(ctx, kind, { negative = false } = {}) {
  const items = maps(ctx, 'item');
  if (negative) return str(items.deposit) || str(items.other) || null;
  return str(items[kind]) || (kind === 'travel' ? str(items.labour) : null) || (kind === 'markup' ? str(items.material) : null) || null;
}

/**
 * The Fishtape kind of a QBO item: generic item by name, else refs.itemKind, else Service = labour.
 * refs.itemKind answers for an item linked to a Fishtape item ('material', the 4.7 rule) before the
 * QBO type is looked at.
 */
export function kindOfItem(ctx, itemRef) {
  if (!itemRef) return 'other';
  const g = keyFor(maps(ctx, 'item'), itemRef, ['material', 'labour', 'other', 'markup', 'travel', 'deposit', 'holdback', 'interest']);
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

/**
 * A QBO CustomerRef in Fishtape terms (4.7): a linked job's sub-customer is that job, a linked
 * customer is that client, and any other sub-customer or project counts as its nearest linked
 * ancestor (a job, else a client), else its top-level customer. Walks refs.parentOf (QBO nests
 * sub-customers at most 5 levels deep).
 * @returns {{ clientRef: string|null, jobRef: string|null }}
 */
export function customerFromQbo(ctx, qboCustomerId) {
  const id = str(qboCustomerId);
  if (!id) return { clientRef: null, jobRef: null };
  const r = refs(ctx);
  const isJob = (q) => Boolean(r.fishtapeIdFor?.('jobs', q));
  const isClient = (q) => Boolean(r.fishtapeIdFor?.('clients', q));
  if (isJob(id)) return { clientRef: null, jobRef: id };
  if (isClient(id)) return { clientRef: id, jobRef: null };
  let cur = id;
  for (let depth = 0; depth < 5; depth += 1) {
    const parent = str(r.parentOf?.(cur));
    if (!parent || parent === cur) break;
    if (isJob(parent)) return { clientRef: null, jobRef: parent };
    if (isClient(parent)) return { clientRef: parent, jobRef: null };
    cur = parent;
  }
  return { clientRef: cur, jobRef: null };
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
        name: str(qboName(r.name)), sku: cut(r.sku, SKU_MAX), description: cut(r.description, NOTES_MAX),
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
      if (role === 'apply') {
        // A credit note applied to an invoice (9.2): a $0 QuickBooks payment linking the two.
        return {
          invoiceRef: qboIdFor(ctx, 'invoices', r.invoiceId), memoRef: qboIdFor(ctx, 'invoices', r.creditNoteId),
          amountCents: Math.round(Number(r.amountCents) || 0), date: day(r.date),
        };
      }
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

// A superseded estimate (a revision replaced it, r1-get-paid.md 9.5) compares as accepted, as QuickBooks'
// Closed does; extra.superseded makes the push send TxnStatus Closed.
const EST_STATUS = { draft: 'pending', sent: 'pending', accepted: 'accepted', declined: 'rejected', superseded: 'accepted' };

function docToCanon(collection, r, ctx, meta) {
  const inv = collection === 'invoices';
  const credit = inv && invoiceKind(r) === 'credit';
  const { clientRef, jobRef } = customerRefForJob(ctx, r.jobId, r.clientId);
  const totals = docTotals(r);
  const out = {
    number: cut(r.number, DOC_NUMBER_MAX), clientRef, jobRef,
    date: inv ? day(r.issueDate) : (day(r.issueDate) || localDay(r.createdAt, zoneOf(ctx))),
    lines: docLines(r, ctx, meta, totals),
    status: inv ? (r.status === 'void' ? 'void' : 'open') : (EST_STATUS[r.status] || 'pending'),
    notes: cut(r.notes, CUSTOMER_MEMO_MAX), title: cut(r.title, NOTES_MAX),
  };
  // A CreditMemo has no due date and no estimate (9.2): both sides compare as empty.
  if (inv) { out.dueDate = credit ? null : day(r.dueDate); out.estimateRef = credit ? null : qboIdFor(ctx, 'estimates', r.estimateId); }
  else out.validUntil = day(r.validUntil);
  // The whole number, so a push can refuse one QBO would cut (error/number_too_long, 4.7). The kind
  // picks the QuickBooks entity (a credit note is a CreditMemo); the credit reason its memo.
  out.extra = {
    numberFull: str(r.number), totalCents: totals.totalCents, taxes: totals.taxes.map((t) => ({ id: t.id, pct: t.pct, cents: t.cents, baseCents: t.baseCents })),
    ...(inv ? { kind: invoiceKind(r) } : {}), ...(credit && r.creditReason ? { creditReason: str(r.creditReason) } : {}),
    ...(!inv && r.status === 'superseded' ? { superseded: true } : {}),
  };
  return out;
}

function docLines(r, ctx, meta, totals = docTotals(r)) {
  const codes = maps(ctx, 'taxCode');
  const items = maps(ctx, 'item');
  const code = (key) => str(codes[key]);
  const ids = lineIdsOf(meta);
  const lossy = lossySet(meta);
  const out = (r.lines || []).map((l, i) => {
    const kind = KINDS.includes(l.kind) ? l.kind : 'material';
    const amountCents = lineCents(l);
    const qty = Number(l.qty) || 0, unitCents = Math.round(Number(l.unitCents) || 0);
    const descOnly = !l.itemId && qty === 0 && unitCents === 0;
    const isLossy = lossy.has(i);
    // Deposit, holdback release and interest lines go on their own generic items (9.2); a deposit
    // line waits for item.deposit to be mapped (its old fallback, the `other` item, is income).
    const special = LINE_TYPE_ITEM[l.lineType];
    const itemRef = descOnly ? null : (l.itemId ? qboIdFor(ctx, 'items', l.itemId) : special ? str(items[special]) : genericItem(ctx, kind, { negative: amountCents < 0 }));
    const line = {
      itemRef, kind, description: cut(isLossy ? stripLossySuffix(l.description) : l.description, LINE_DESC_MAX), amountCents,
      taxCodeId: descOnly ? null : code(lineTaxKey(r, l)), qty, unitCents, lineId: str(ids[String(i)]),
    };
    if (special) line.lineType = l.lineType;
    if (isLossy) line.lossy = true;
    return line;
  });
  if (totals.markupCents) {
    out.push({
      itemRef: genericItem(ctx, 'markup'), kind: 'material', description: `Materials markup (${fmtPct(r.markupPct)}%)`,
      amountCents: totals.markupCents, taxCodeId: code(lineTaxKey(r, 'material')), qty: 1, unitCents: totals.markupCents, lineId: str(ids.markup), markup: true,
    });
  }
  // The holdback (9.2): a negative line on item.holdback with the code of the taxes deferred to the
  // release. Holdback the customer kept on its own (retainedByCustomerCents) is Fishtape-only.
  if (totals.holdbackCents) {
    out.push({
      itemRef: str(items.holdback), kind: 'other', description: holdbackLineText(r), amountCents: -totals.holdbackCents,
      taxCodeId: code(holdbackTaxKey(r, totals)), qty: 1, unitCents: -totals.holdbackCents, lineId: str(ids.holdback), holdback: true,
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
  // Resale or own use per line (r1-get-paid.md 3.5, 9.3): rst.js billLineTaxUse through ctx.taxUse.
  const vendor = r.vendorId ? refs(ctx).vendor?.(r.vendorId) || null : null;
  const useOf = typeof ctx?.taxUse === 'function' ? ctx.taxUse : fallbackBillLineTaxUse;
  const spread = spreadPurchaseTax(raw, printed, RECOVERABLE, { taxUse: (l) => useOf(l, { vendor }) });
  const pctOf = (id) => ratesOn(province, date || undefined).find((p) => p.id === id)?.pct ?? (id === 'GST' ? 5 : null);
  const number = str(r.number);
  // A bill whose lines add up below zero is a supplier credit: a QuickBooks VendorCredit, no due date (9.2).
  const vendorCredit = !receipt && raw.reduce((s, l) => s + l.amountCents, 0) < 0;
  return {
    kind: receipt ? 'receipt' : 'bill',
    vendorRef: qboIdFor(ctx, 'vendors', r.vendorId),
    number: cut(number, DOC_NUMBER_MAX),
    date,
    dueDate: receipt || vendorCredit ? null : day(r.dueDate),
    notes: cut(r.notes, NOTES_MAX),
    paidWith: receipt ? { ref: str(maps(ctx, 'paidFrom')[r.paidWith]), key: str(r.paidWith) } : null,
    lines: [...spread.lines.map((l, i) => {
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
    // RST on resale lines (9.3): one line on account.rstRecoverable for its cents, never job cost.
    ...(spread.resaleCents ? [{
      itemRef: null, accountRef: str(accounts.rstRecoverable), description: RST_RECOVERABLE_TEXT, amountCents: spread.resaleCents,
      taxCodeId: str(maps(ctx, 'purchaseTaxCode').NONE), customerRef: null, qty: 1, unitCents: spread.resaleCents,
      lineId: str(ids[String(spread.lines.length)]), costType: 'other', rstRecoverable: true,
    }] : [])],
    taxes: spread.taxes.filter((t) => t.cents).map((t) => ({ id: t.id, pct: pctOf(t.id), cents: t.cents })).sort((a, b) => a.id.localeCompare(b.id)),
    extra: { numberFull: number, taxKey: key, province, resaleRstCents: spread.resaleCents || 0, ...(vendorCredit ? { vendorCredit: true } : {}) },
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
        name: nameBack(o.Name, meta), sku: cut(o.Sku, SKU_MAX), description: cut(o.Description, NOTES_MAX),
        priceCents: toCents(o.UnitPrice ?? 0), costCents: toCents(o.PurchaseCost ?? 0), active: o.Active !== false,
      };
    case 'Estimate':
    case 'Invoice':
    case 'CreditMemo':
      if (coll === 'payments' && role === 'deposit') {
        return { invoiceRef: str(o.Id), amountCents: toCents(o.Deposit), date: day(o.TxnDate), method: methodValue(ctx, 'transfer'), reference: 'Deposit in QuickBooks' };
      }
      return docFromQbo(entity, o, ctx, meta);
    case 'Payment':
      if (role === 'apply') return applyFromQbo(o, qboLine);
      return paymentFromQbo(o, ctx, qboLine);
    case 'Bill':
      return billFromQbo('bill', o, ctx);
    case 'VendorCredit':
      return billFromQbo('bill', o, ctx, { sign: -1 });
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
 * Its canonical lines are all zero: the engine must apply the void (status) before any merge of
 * lines, or the zero lines would be written to Fishtape.
 */
export function isVoidedInvoice(o) {
  if (!o) return false;
  if (toCents(o.TotalAmt) !== 0) return false;
  const lines = (o.Line || []).filter((l) => l.DetailType !== 'SubTotalLineDetail');
  return lines.every((l) => toCents(l.Amount) === 0) && /^Voided/i.test(String(o.PrivateNote || ''));
}

/** The memo a bad-debt credit note carries in QuickBooks (9.2; VERIFY with the accountant). */
export const BAD_DEBT_MEMO = 'Bad debt write-off';

function docFromQbo(entity, o, ctx, meta) {
  const credit = entity === 'CreditMemo';
  const inv = entity === 'Invoice' || credit;
  const { clientRef, jobRef } = customerFromQbo(ctx, ref(o.CustomerRef));
  const out = {
    number: cut(o.DocNumber, DOC_NUMBER_MAX), clientRef, jobRef,
    date: day(o.TxnDate), lines: salesLinesFromQbo(o, ctx, meta, { credit }),
    status: inv ? (isVoidedInvoice(o) ? 'void' : 'open') : (QBO_EST_STATUS[o.TxnStatus] || 'pending'),
    notes: cut(o.CustomerMemo?.value, CUSTOMER_MEMO_MAX),
    // The bad-debt memo Fishtape adds (9.2) is not part of the title.
    title: credit ? str(String(stripMarker(o.PrivateNote) || '').replace(new RegExp(`(?:\\s*·\\s*)?${BAD_DEBT_MEMO}$`), '')) : stripMarker(o.PrivateNote),
  };
  if (inv) {
    out.dueDate = credit ? null : day(o.DueDate);
    out.estimateRef = credit ? null : str((o.LinkedTxn || []).find((t) => t.TxnType === 'Estimate')?.TxnId);
  } else out.validUntil = day(o.ExpirationDate);
  // A CreditMemo's amounts are positive in QuickBooks and negative in Fishtape (9.2).
  const sign = credit ? -1 : 1;
  out.extra = {
    totalCents: sign * toCents(o.TotalAmt), balanceCents: o.Balance == null ? (credit && o.RemainingCredit != null ? -toCents(o.RemainingCredit) : null) : sign * toCents(o.Balance), globalTax: str(o.GlobalTaxCalculation),
    taxInclusive: o.GlobalTaxCalculation === 'TaxInclusive', txnStatus: str(o.TxnStatus),
    taxLines: taxLinesOf(o.TxnTaxDetail), totalTaxCents: sign * toCents(o.TxnTaxDetail?.TotalTax ?? 0),
    ...(credit ? { kind: 'credit', badDebt: new RegExp(`${BAD_DEBT_MEMO}$`).test(String(o.PrivateNote || '')) } : {}),
  };
  return out;
}

/**
 * A credit-note application (link role apply, 9.2): the QuickBooks payment of $0 that applies a
 * CreditMemo to an invoice. Its canonical form is the invoice line it owns and the amount applied.
 */
function applyFromQbo(o, qboLine) {
  const lines = (o?.Line || []).map((l) => ({ amount: toCents(l.Amount), t: (l.LinkedTxn || [])[0] || {} }));
  const inv = lines.find((x) => x.t.TxnType === 'Invoice' && (!qboLine || String(x.t.TxnId) === String(qboLine)));
  const memo = lines.find((x) => x.t.TxnType === 'CreditMemo');
  return { invoiceRef: inv ? str(inv.t.TxnId) : null, memoRef: memo ? str(memo.t.TxnId) : null, amountCents: inv ? inv.amount : 0, date: day(o?.TxnDate) };
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

/**
 * A sales object's lines in Fishtape's terms. A CreditMemo (credit) has its amounts negated, so a
 * credit note compares with its Fishtape lines (negative on both sides). Lines on item.deposit,
 * item.holdback and item.interest carry their lineType (9.2); a line on item.holdback against the
 * document's sign (negative on an invoice, positive on a credit memo once negated) is the
 * document's holdback, listed last like Fishtape's own holdback line. A positive holdback line on
 * an invoice is a release.
 */
function salesLinesFromQbo(o, ctx, meta, { credit = false } = {}) {
  const inclusive = o.GlobalTaxCalculation === 'TaxInclusive';
  const lossyListed = lossySet(meta);
  const markupItem = genericItem(ctx, 'markup');
  const items = maps(ctx, 'item');
  const sign = credit ? -1 : 1;
  const typeOf = (itemRef) => (itemRef ? Object.keys(LINE_TYPE_ITEM).find((t) => str(items[LINE_TYPE_ITEM[t]]) === itemRef) || null : null);
  const plain = [], markups = [], holdbacks = [];
  for (const l of flatSalesLines(o)) {
    if (l.DetailType === 'DescriptionOnly') {
      plain.push({ itemRef: null, kind: 'other', description: cut(l.Description, LINE_DESC_MAX), amountCents: 0, taxCodeId: null, qty: 0, unitCents: 0, lineId: str(l.Id) });
      continue;
    }
    if (l.DetailType === 'DiscountLineDetail') {
      const amount = -sign * Math.abs(toCents(l.Amount));
      plain.push({
        itemRef: genericItem(ctx, 'other', { negative: true }), kind: 'other', description: cut(l.Description, LINE_DESC_MAX) || 'Discount', amountCents: amount,
        taxCodeId: ref(l.DiscountLineDetail?.TaxCodeRef), qty: 1, unitCents: amount, lineId: str(l.Id), discount: true,
      });
      continue;
    }
    if (l.DetailType !== 'SalesItemLineDetail') continue;
    const d = l.SalesItemLineDetail || {};
    const itemRef = ref(d.ItemRef);
    const amountCents = sign * toCents(inclusive && d.TaxInclusiveAmt != null ? d.TaxInclusiveAmt : l.Amount);
    const qty = d.Qty == null ? 1 : Number(d.Qty) || 0;
    const unitCents = d.UnitPrice == null ? amountCents : sign * toCents(d.UnitPrice);
    const exact = Math.round(qty * unitCents) === amountCents || (d.Qty == null && d.UnitPrice == null);
    const description = str(l.Description);
    if (markupItem && itemRef === markupItem && MARKUP_RE.test(description || '')) {
      markups.push({ itemRef, kind: 'material', description, amountCents, taxCodeId: ref(d.TaxCodeRef), qty: 1, unitCents: amountCents, lineId: str(l.Id), markup: true });
      continue;
    }
    const lineType = typeOf(itemRef);
    if (lineType === 'holdback' && amountCents * sign < 0) {
      holdbacks.push({ itemRef, kind: 'other', description, amountCents, taxCodeId: ref(d.TaxCodeRef), qty: 1, unitCents: amountCents, lineId: str(l.Id), holdback: true });
      continue;
    }
    const index = plain.length;
    const line = {
      itemRef, kind: kindOfItem(ctx, itemRef), description: cut(lossyListed.has(index) ? stripLossySuffix(description) : description, LINE_DESC_MAX),
      amountCents, taxCodeId: ref(d.TaxCodeRef), qty: exact ? qty : 1, unitCents: exact ? unitCents : amountCents, lineId: str(l.Id),
    };
    if (lineType) line.lineType = lineType;
    if (!exact) line.lossy = { qty: d.Qty, unitPrice: d.UnitPrice };
    else if (lossyListed.has(index)) line.lossy = true;
    plain.push(line);
  }
  return [...plain, ...markups, ...holdbacks];
}

/**
 * A Fishtape payment's amount in QuickBooks is its own line plus the excess its push left unapplied
 * (4.9, meta.ownExcessCents, never more than the payment's unapplied amount): a payment of $1,200 on a
 * $1,120 balance is $1,200 on both sides, so a later QuickBooks edit never writes $1,120 back.
 */
function ownExcessOf(o, ctx) {
  const own = Math.max(0, Math.round(Number(linkInfo(ctx).meta.ownExcessCents) || 0));
  if (!own) return 0;
  const unapplied = o.UnappliedAmt != null ? toCents(o.UnappliedAmt) : toCents(o.TotalAmt) - (o.Line || []).reduce((s, l) => s + toCents(l.Amount), 0);
  return Math.min(Math.max(0, unapplied), own);
}

function paymentFromQbo(o, ctx, qboLine) {
  const invoiceLines = (o.Line || []).map((l) => ({ l, inv: str((l.LinkedTxn || []).find((t) => t.TxnType === 'Invoice')?.TxnId) })).filter((x) => x.inv);
  let hit = qboLine ? invoiceLines.find((x) => x.inv === qboLine) : invoiceLines[0];
  if (!hit && qboLine && invoiceLines.length === 1) hit = invoiceLines[0]; // the line moved to another invoice
  const pmRef = ref(o.PaymentMethodRef);
  const pm = maps(ctx, 'paymentMethod');
  const excess = hit && qboLine && hit.inv === qboLine ? ownExcessOf(o, ctx) : 0;
  return {
    invoiceRef: hit ? hit.inv : null, amountCents: hit ? toCents(hit.l.Amount) + excess : 0, date: day(o.TxnDate),
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
function billFromQbo(kind, o, ctx, { sign: forced = null } = {}) {
  // A refund Purchase (Credit: true) and a VendorCredit (a supplier credit, 9.2) are negative in Fishtape.
  const sign = forced ?? (o.Credit === true ? -1 : 1);
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
        amountCents: sign * amount, taxCodeId: ref(d.TaxCodeRef), customerRef: customerOfLine(ctx, ref(d.CustomerRef)),
        qty: item ? Number(d.Qty ?? 1) || 0 : 1, unitCents: item ? sign * toCents(d.UnitPrice ?? 0) : sign * amount, lineId: str(l.Id),
      };
    }), taxLinesOf(o.TxnTaxDetail).filter((t) => t.cents).map((t) => {
      const rate = rates.find((x) => String(x.Id) === t.rateId);
      return { id: taxIdForRate(rate, province, t.pct), pct: t.pct ?? (rate ? Number(rate.RateValue) : null), cents: sign * t.cents, rateId: t.rateId };
    }).sort((a, b) => String(a.id).localeCompare(String(b.id))), RECOVERABLE),
    extra: { totalCents: sign * toCents(o.TotalAmt), balanceCents: o.Balance == null ? null : toCents(o.Balance), globalTax: str(o.GlobalTaxCalculation), taxInclusive: o.GlobalTaxCalculation === 'TaxInclusive' },
  };
}

/** A cost line's CustomerRef read back: a linked job, else the linked client it belongs to (customerFromQbo). */
function customerOfLine(ctx, qboId) {
  const c = customerFromQbo(ctx, qboId);
  return c.jobRef || c.clientRef;
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
 * Lines compare { itemRef, description, amountCents, taxCodeId } (4.7), descriptions cut to
 * Fishtape's 1,000 characters (LINE_DESC_MAX) on both sides; qty, unit price, kind and
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
  // Bill taxes by id and amount, so GST changed to HST with the same cents is still a change.
  if (field === 'taxes' && Array.isArray(value)) {
    const pairs = value.filter((t) => Number(t.cents)).map((t) => [String(t.id ?? '').toUpperCase(), Math.round(Number(t.cents))]);
    return pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  }
  if (field === 'lines' && Array.isArray(value)) {
    // A bill's tax is its own money field (`taxes`, the printed recoverable amounts); its lines
    // carry the purchase code for writing only, since PST/RST is already in their amounts.
    if (collection === 'bills') return value.map((l) => [l.itemRef ?? null, l.accountRef ?? null, str(l.description), l.amountCents, l.customerRef ?? null]);
    if (collection === 'purchaseOrders') return value.map((l) => [l.itemRef ?? null, str(l.description), Math.round((Number(l.qty) || 0) * 100000), l.unitCents, l.customerRef ?? null]);
    if (collection === 'payoutFee') return value.map((l) => [str(l.description), l.amountCents]);
    // A lossy line's text is compared without the room its suffix takes in Fishtape (LOSSY_ROOM).
    return value.map((l) => [l.itemRef ?? null, l.lossy ? cut(l.description, LINE_DESC_MAX - LOSSY_ROOM) : str(l.description), l.amountCents, l.taxCodeId ?? null]);
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
