// Canonical form -> Fishtape record patch (docs/integrations/quickbooks.md 4, 5.5). Pure.
//
// canonToFishtape returns only Fishtape fields, never QBO ids (3.1). With `existing` it is a patch
// of the fields asked for; without, the body of a new record (the engine adds the id). Lines that
// did not change keep everything Fishtape has on them (qty, unit price, kind, labour hours, change
// order) through their QBO Line.Id pairing (meta.lineIds). Push-only collections return {}.
import { lineCents, KINDS } from '../../../../electrical-app/js/lib/money.js';
import { fishtapeToCanon, qboToCanon, linkInfo, normMethod, toCents, str, lossySuffix, isGenericItem, canonEqual } from './canon.js';
import { FIELD_RULES } from './merge.js';
import { lineTaxKey, reverseTaxKey, taxesFromCodes } from './tax.js';

export { taxInclusiveToNet } from './tax.js';

const maps = (ctx, kind) => ctx?.mappings?.[kind] || {};
const option = (ctx, key, dflt) => (ctx?.mappings?.option && ctx.mappings.option[key] !== undefined ? ctx.mappings.option[key] : dflt);
const fid = (ctx, coll, qboId) => (qboId ? str(ctx?.refs?.fishtapeIdFor?.(coll, qboId)) : null);

/**
 * A Fishtape record patch from a canonical form.
 * @param {string} collection
 * @param {object} canon the merged canonical form (R for a pulled record)
 * @param {object} ctx mapper context (canon.js)
 * @param {object} [opts]
 * @param {object} [opts.existing] the current Fishtape record (null: build a new record)
 * @param {string[]} [opts.fields] fields to write (merge toLocal); all two-way fields when absent
 * @param {object} [opts.report] filled in: { lossyLines: number[], taxShape: boolean, taxInclusive: boolean, markup: 'kept'|'dropped'|null }
 * @returns {object} record patch
 */
export function canonToFishtape(collection, canon, ctx = {}, { existing = null, fields = null, report = {} } = {}) {
  const rules = FIELD_RULES[collection];
  if (!rules) throw new Error(`no Fishtape mapping for ${collection}`);
  const all = [...rules.money, ...rules.auto];
  const want = new Set((Array.isArray(fields) ? fields : all).filter((f) => all.includes(f)));
  const c = canon || {};
  Object.assign(report, { lossyLines: [], taxShape: false, taxInclusive: false, markup: null });
  const has = (f) => want.has(f);
  const p = {};
  switch (collection) {
    case 'clients':
      if (has('name')) p.name = c.name || '';
      if (has('type')) p.type = c.type === 'business' ? (existing?.type === 'industrial' ? 'industrial' : 'commercial') : 'residential';
      if (has('email')) p.email = c.email || '';
      if (has('phone')) p.phone = c.phone || '';
      if (has('address')) p.address = c.address || '';
      return p;
    case 'vendors':
      for (const f of ['name', 'companyName', 'email', 'phone', 'address', 'accountNumber', 'notes']) if (has(f)) p[f] = c[f] || '';
      if (has('t5018')) p.t5018 = c.t5018 === true;
      if (has('active')) p.active = c.active !== false;
      return p;
    case 'items':
      for (const f of ['name', 'sku', 'description']) if (has(f)) p[f] = c[f] || '';
      if (has('priceCents')) p.priceCents = Math.round(Number(c.priceCents) || 0);
      if (has('costCents')) p.costCents = Math.round(Number(c.costCents) || 0);
      return p;
    case 'estimates':
    case 'invoices':
      return docPatch(collection, c, ctx, existing, has, report);
    case 'payments':
      if (has('invoiceRef')) p.invoiceId = fid(ctx, 'invoices', c.invoiceRef);
      if (has('amountCents')) p.amountCents = Math.round(Number(c.amountCents) || 0);
      if (has('date')) p.date = c.date || null;
      if (has('method')) {
        const mine = existing ? normMethod(existing.method) : null;
        const pm = maps(ctx, 'paymentMethod');
        const mineRef = mine ? (pm[mine] || pm.other || null) : null;
        if (!(existing && mineRef && c.method?.ref && String(mineRef) === String(c.method.ref))) p.method = c.method?.key || (c.method?.ref ? 'other' : null);
      }
      if (has('reference')) {
        const full = str(existing?.reference);
        // A reference cut to 21 in QBO never replaces the full one (4.9).
        if (!(full && c.reference && full.startsWith(c.reference))) p.reference = c.reference || '';
      }
      return p;
    case 'bills':
      return billPatch(c, ctx, existing, has);
    case 'purchaseOrders':
      if (has('status') && c.status === 'closed' && existing?.status !== 'closed') { p.status = 'closed'; p.closedAt = new Date(ctx.now || Date.now()).toISOString(); }
      return p;
    default:
      return p;
  }
}

const EST_STATUS = { pending: 'sent', accepted: 'accepted', rejected: 'declined' };

function docPatch(collection, c, ctx, existing, has, report) {
  const inv = collection === 'invoices';
  const p = {};
  if (has('number')) {
    const full = str(existing?.number);
    if (!(full && c.number && full.startsWith(c.number) && full.length > c.number.length)) p.number = c.number || '';
  }
  if (has('clientRef') || has('jobRef')) {
    if (c.jobRef) {
      p.jobId = fid(ctx, 'jobs', c.jobRef);
      p.clientId = (p.jobId && ctx?.refs?.clientOfJob?.(p.jobId)) || existing?.clientId || null;
    } else {
      p.clientId = fid(ctx, 'clients', c.clientRef);
      // Moved off a job sub-customer in QBO: the job no longer applies.
      const subCustomers = option(ctx, 'jobsAsSubCustomers', true) !== false;
      if (existing?.jobId && subCustomers && ctx?.refs?.qboIdFor?.('jobs', existing.jobId)) p.jobId = null;
    }
  }
  if (has('date')) p.issueDate = c.date || null;
  if (inv && has('dueDate')) p.dueDate = c.dueDate || null;
  if (!inv && has('validUntil')) p.validUntil = c.validUntil || null;
  if (has('notes')) {
    const full = str(existing?.notes);
    if (!(full && c.notes && full.startsWith(c.notes) && full.length > c.notes.length)) p.notes = c.notes || '';
  }
  if (inv && has('estimateRef')) p.estimateId = fid(ctx, 'estimates', c.estimateRef);
  if (has('status')) {
    if (inv) {
      if (c.status === 'void' && existing?.status !== 'void') p.status = 'void';
      else if (!existing) p.status = c.status === 'void' ? 'void' : 'sent';
    } else if (EST_STATUS[c.status] && existing?.status !== EST_STATUS[c.status]) p.status = EST_STATUS[c.status];
  }
  if (has('lines')) Object.assign(p, linesPatch(collection, c, ctx, existing, report));
  return p;
}

/** Fishtape lines, markup and tax fields from canonical lines (4.7, 4.8). */
function linesPatch(collection, c, ctx, existing, report) {
  const { meta } = linkInfo(ctx);
  const date = c.date || existing?.issueDate || null;
  const exLines = existing?.lines || [];
  const exIds = meta.lineIds && typeof meta.lineIds === 'object' ? meta.lineIds : {};
  const exIndexById = new Map(Object.entries(exIds).filter(([k]) => k !== 'markup').map(([i, id]) => [String(id), Number(i)]));
  const exCanon = existing ? fishtapeToCanon(collection, existing, ctx).lines : [];
  const plain = (c.lines || []).filter((l) => !l.markup);
  const markups = (c.lines || []).filter((l) => l.markup);
  const lines = [];
  const lossy = [];
  plain.forEach((l, i) => {
    const j = l.lineId != null ? exIndexById.get(String(l.lineId)) : undefined;
    const prev = j != null ? exLines[j] : null;
    const prevCanon = j != null ? exCanon[j] : null;
    if (prev && prevCanon && canonEqual(collection, 'lines', [l], [prevCanon])) {
      lines.push({ ...prev });
      if (l.lossy || prevCanon.lossy) lossy.push(i);
      return;
    }
    const kind = prev && prevCanon && prevCanon.itemRef === l.itemRef && KINDS.includes(prev.kind) ? prev.kind : (KINDS.includes(l.kind) ? l.kind : 'material');
    const itemId = l.itemRef && !isGenericItem(ctx, l.itemRef) ? fid(ctx, 'items', l.itemRef) : null;
    let description = l.description || '';
    if (l.lossy && typeof l.lossy === 'object') { description = `${description}${lossySuffix(l.lossy.qty, l.lossy.unitPrice)}`.trim(); lossy.push(i); }
    const line = { description, qty: l.qty, unitCents: l.unitCents, kind };
    if (itemId) line.itemId = itemId;
    if (prev) for (const k of ['labourHours', 'changeOrderId']) if (prev[k] != null) line[k] = prev[k];
    lines.push(line);
  });
  const out = { lines };

  // Markup line (4.7): kept as markupPct when it still equals the record's own markup.
  if (markups.length) {
    const pct = Number(existing?.markupPct) || 0;
    const materialCents = lines.filter((l) => (l.kind || 'material') === 'material').reduce((s, l) => s + lineCents(l), 0);
    const amount = markups.reduce((s, l) => s + l.amountCents, 0);
    if (markups.length === 1 && pct && Math.round((materialCents * pct) / 100) === amount) { out.markupPct = pct; report.markup = 'kept'; }
    else {
      out.markupPct = 0;
      for (const l of markups) lines.push({ description: l.description || 'Materials markup', qty: 1, unitCents: l.amountCents, kind: 'material' });
      report.markup = 'dropped';
    }
  } else if (Number(existing?.markupPct)) out.markupPct = 0;
  report.lossyLines = lossy;

  // Tax (4.8): QBO codes back to keys, then to Fishtape components.
  if (c.extra?.taxInclusive) {
    report.taxInclusive = true;
    return { ...out, taxes: [], taxPct: 0, taxTreatment: 'none', taxNoneReason: null };
  }
  const codes = maps(ctx, 'taxCode');
  const keysByKind = {};
  const codesByKind = {};
  const add = (kind, l) => { if (l.itemRef != null || l.amountCents) (codesByKind[kind] ||= new Set()).add(l.taxCodeId ?? null); };
  plain.forEach((l, i) => add(lines[i].kind || 'material', l)); // description-only lines carry no tax
  markups.forEach((l) => add('material', l));
  let shapeOk = true;
  for (const [kind, set] of Object.entries(codesByKind)) {
    const ids = [...set].filter((x) => x != null);
    if (ids.length !== 1 || set.size !== 1) { shapeOk = false; continue; }
    const key = reverseTaxKey(ids[0], codes, { preferred: existing ? lineTaxKey(existing, kind) : null, province: ctx?.company?.province });
    if (!key) { shapeOk = false; continue; }
    keysByKind[kind] = key;
  }
  const t = taxesFromCodes(keysByKind, { province: ctx?.company?.province, date: date || undefined, existingTreatment: existing?.taxTreatment, legacyPct: existing?.taxPct });
  if (!shapeOk || !t.ok) {
    report.taxShape = true;
    if (existing) return out; // keep the record's own tax; the link goes to needs_review (tax_shape)
  }
  return { ...out, taxes: t.taxes, taxPct: t.taxPct, taxProvince: t.taxProvince ?? null, taxTreatment: t.taxTreatment, taxNoneReason: t.taxNoneReason };
}

function billPatch(c, ctx, existing, has) {
  const p = {};
  if (has('kind')) p.kind = c.kind === 'receipt' ? 'receipt' : 'bill';
  if (has('vendorRef')) p.vendorId = fid(ctx, 'vendors', c.vendorRef);
  if (has('number')) {
    const full = str(existing?.number);
    if (!(full && c.number && full.startsWith(c.number))) p.number = c.number || '';
  }
  if (has('date')) p.date = c.date || null;
  if (has('dueDate')) p.dueDate = c.dueDate || null;
  if (has('notes')) p.notes = c.notes || '';
  if (has('paidWith') && c.kind === 'receipt') {
    const mine = existing?.paidWith;
    const mineRef = mine ? maps(ctx, 'paidFrom')[mine] : null;
    if (!(mineRef && c.paidWith?.ref && String(mineRef) === String(c.paidWith.ref))) p.paidWith = c.paidWith?.key || (c.paidWith?.paymentType === 'CreditCard' ? 'card' : c.paidWith?.paymentType === 'Check' ? 'cheque' : 'cash');
  }
  const acc = maps(ctx, 'account');
  if (has('lines')) {
    const { meta } = linkInfo(ctx);
    const exIds = meta.lineIds && typeof meta.lineIds === 'object' ? meta.lineIds : {};
    const exIndexById = new Map(Object.entries(exIds).map(([i, id]) => [String(id), Number(i)]));
    p.lines = (c.lines || []).map((l) => {
      const j = l.lineId != null ? exIndexById.get(String(l.lineId)) : undefined;
      const prev = j != null ? existing?.lines?.[j] : null;
      const costType = (['material', 'subcontract', 'equipment', 'other'].find((t) => l.accountRef && String(acc[`jobCost.${t}`]) === String(l.accountRef))) || prev?.costType || 'material';
      const jobId = l.customerRef ? fid(ctx, 'jobs', l.customerRef) : null;
      const line = { description: l.description || '', qty: l.qty || 1, unitCents: l.qty ? Math.round(l.amountCents / l.qty) : l.amountCents, amountCents: l.amountCents, costType };
      const itemId = l.itemRef ? fid(ctx, 'items', l.itemRef) : null;
      if (itemId) line.itemId = itemId;
      if (jobId) line.jobId = jobId;
      if (prev?.poLine) line.poLine = prev.poLine;
      return line;
    });
  }
  if (has('taxes') || has('lines')) {
    p.taxes = (c.taxes || []).map((t) => ({ id: t.id, label: t.id, cents: t.cents }));
    if (p.lines) p.totalCents = p.lines.reduce((s, l) => s + l.amountCents, 0) + p.taxes.reduce((s, t) => s + t.cents, 0);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Pull helpers

/** A pulled Bill's status: Balance 0 means paid, a later balance means open again (4.10). */
export function billStatusFromQbo(qboBill, existingStatus) {
  if (!qboBill || qboBill.Balance == null) return null;
  if (existingStatus === 'void' || existingStatus === 'draft') return null;
  const status = toCents(qboBill.Balance) === 0 ? 'paid' : 'open';
  return status === existingStatus ? null : status;
}

/**
 * What QBO settled on an invoice outside Fishtape's payments (4.9): (TotalAmt − Balance) minus the
 * QBO payment lines on this invoice that are linked to Fishtape payments. Never below 0.
 */
export function settlementCents(qboInvoice, linkedPaymentLineCents) {
  const settled = toCents(qboInvoice?.TotalAmt) - toCents(qboInvoice?.Balance);
  const linked = (linkedPaymentLineCents || []).reduce((s, x) => s + (Math.round(Number(x)) || 0), 0);
  return Math.max(0, settled - linked);
}

/** The pull-only settlement payment for an invoice (method credit, source quickbooks, 4.9). */
export function settlementRecord({ invoiceId, cents, date }) {
  return { invoiceId, amountCents: Math.round(Number(cents) || 0), date, method: 'credit', source: 'quickbooks', reference: 'Credited or paid in QuickBooks' };
}

/** The Fishtape payment for a pulled invoice's Deposit field (link role deposit, 4.7). */
export function depositRecord(qboInvoice, invoiceId) {
  const cents = toCents(qboInvoice?.Deposit);
  if (!cents) return null;
  return { invoiceId, amountCents: cents, date: str(qboInvoice?.TxnDate), method: 'transfer', reference: 'Deposit in QuickBooks' };
}

/**
 * Link meta from a QBO object just read or written (3.4): line pairing, lossy lines, the kept
 * GlobalTaxCalculation, balances, the exact name and type, and a payment's lines Fishtape does not own.
 * Pass `pushed` (canonToQbo's result) after a write so lines sent lossy stay listed.
 */
export function linkMetaFromQbo(entity, object, ctx = {}, { pushed = null } = {}) {
  const o = object || {};
  const meta = {};
  if (entity === 'Customer' || entity === 'Vendor') meta.displayName = str(o.DisplayName);
  if (entity === 'Item') { meta.displayName = str(o.Name); meta.qboType = str(o.Type); }
  if (['Invoice', 'Estimate', 'Bill', 'Purchase'].includes(entity)) {
    if (o.GlobalTaxCalculation) meta.globalTax = o.GlobalTaxCalculation;
    if (o.TotalAmt != null) meta.qboTotalCents = toCents(o.TotalAmt);
    if (o.Balance != null) meta.qboBalanceCents = toCents(o.Balance);
  }
  if (entity === 'Invoice' || entity === 'Estimate') {
    const coll = entity === 'Invoice' ? 'invoices' : 'estimates';
    const lines = qboToCanon(entity, o, { ...ctx, collection: coll }).lines;
    const ids = {};
    const lossy = new Set(pushed?.lossyLines || []);
    lines.filter((l) => !l.markup).forEach((l, i) => { if (l.lineId) ids[String(i)] = l.lineId; if (l.lossy) lossy.add(i); });
    const mk = lines.find((l) => l.markup);
    if (mk?.lineId) ids.markup = mk.lineId;
    meta.lineIds = ids;
    meta.lossyLines = [...lossy].sort((a, b) => a - b);
  }
  if (entity === 'Bill' || (entity === 'Purchase' && linkInfo(ctx).role !== 'fee')) {
    const ids = {};
    (o.Line || []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail' || l.DetailType === 'ItemBasedExpenseLineDetail')
      .forEach((l, i) => { if (l.Id != null) ids[String(i)] = String(l.Id); });
    meta.lineIds = ids;
  }
  if (entity === 'Payment') {
    const own = (inv) => Boolean(ctx?.refs?.fishtapeIdFor?.('invoices', inv));
    const foreign = [];
    let unapplied = toCents(o.TotalAmt);
    for (const l of o.Line || []) {
      unapplied -= toCents(l.Amount);
      const t = (l.LinkedTxn || [])[0] || {};
      if (!(t.TxnType === 'Invoice' && own(String(t.TxnId)))) foreign.push({ txnType: t.TxnType || null, txnId: str(t.TxnId), amountCents: toCents(l.Amount) });
    }
    meta.unappliedCents = o.UnappliedAmt != null ? toCents(o.UnappliedAmt) : unapplied;
    meta.foreignLines = foreign;
  }
  if (entity === 'Estimate' || entity === 'Invoice') meta.docNumber = str(o.DocNumber);
  return meta;
}

