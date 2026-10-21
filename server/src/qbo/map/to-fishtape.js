// Canonical form -> Fishtape record patch (docs/integrations/quickbooks.md 4, 5.5). Pure.
//
// canonToFishtape returns only Fishtape fields, never QBO ids (3.1). With `existing` it is a patch
// of the fields asked for; without, the body of a new record (the engine adds the id). Lines that
// did not change keep everything Fishtape has on them (qty, unit price, kind, labour hours, change
// order) through their QBO Line.Id pairing (meta.lineIds). Push-only collections return {}.
//
// Release 1 (r1-get-paid.md 9): a changed line keeps Fishtape's own line fields (cost code,
// pass-through, line type, deposit invoice); lines of one kind whose tax key is the kind's key less
// some taxes get `taxOff` instead of a tax_shape review; the holdback line becomes the invoice's
// `holdback` (its Fishtape-only parts kept); a bill line on account.rstRecoverable becomes RST on the bill.
import { lineCents, docTotals, KINDS } from '../../../../electrical-app/js/lib/money.js';
import {
  fishtapeToCanon, qboToCanon, linkInfo, normMethod, toCents, str, cut, lossySuffix, isGenericItem, canonEqual, LINE_DESC_MAX, LOSSY_ROOM,
} from './canon.js';
import { FIELD_RULES } from './merge.js';
import { lineTaxKey, holdbackTaxKey, reverseTaxKey, taxesFromCodes, parseTaxKey } from './tax.js';

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
  // A CreditMemo pulled from QuickBooks is a Fishtape credit note (r1-get-paid.md 9.2).
  if (inv && !existing && c.extra?.kind === 'credit') {
    Object.assign(p, { kind: 'credit', creditReason: c.extra.badDebt ? 'bad_debt' : 'other' });
    if (has('dueDate')) p.dueDate = c.date || null;
  }
  return p;
}

/** A line's own Fishtape fields that QuickBooks never holds: a changed line keeps them through its pairing. */
const LINE_OWN_FIELDS = ['labourHours', 'changeOrderId', 'costCodeId', 'passThrough', 'lineType', 'depositInvoiceId'];

/** Fishtape lines, markup, holdback and tax fields from canonical lines (4.7, 4.8; r1-get-paid.md 9.1, 9.2). */
function linesPatch(collection, c, ctx, existing, report) {
  const { meta } = linkInfo(ctx);
  const date = c.date || existing?.issueDate || null;
  const exLines = existing?.lines || [];
  const exIds = meta.lineIds && typeof meta.lineIds === 'object' ? meta.lineIds : {};
  const exIndexById = new Map(Object.entries(exIds).filter(([k]) => k !== 'markup' && k !== 'holdback').map(([i, id]) => [String(id), Number(i)]));
  const exCanon = existing ? fishtapeToCanon(collection, existing, ctx).lines : [];
  const plain = (c.lines || []).filter((l) => !l.markup && !l.holdback);
  const markups = (c.lines || []).filter((l) => l.markup);
  const holdbacks = (c.lines || []).filter((l) => l.holdback);
  const lines = [];
  const lossy = [];
  const prevOf = [];
  const kept = [];
  plain.forEach((l, i) => {
    const j = l.lineId != null ? exIndexById.get(String(l.lineId)) : undefined;
    const prev = j != null ? exLines[j] : null;
    const prevCanon = j != null ? exCanon[j] : null;
    prevOf[i] = prev;
    if (prev && prevCanon && canonEqual(collection, 'lines', [l], [prevCanon])) {
      lines.push({ ...prev });
      kept[i] = true;
      if (l.lossy || prevCanon.lossy) lossy.push(i);
      return;
    }
    const kind = prev && prevCanon && prevCanon.itemRef === l.itemRef && KINDS.includes(prev.kind) ? prev.kind : (KINDS.includes(l.kind) ? l.kind : 'material');
    const itemId = l.itemRef && !isGenericItem(ctx, l.itemRef) ? fid(ctx, 'items', l.itemRef) : null;
    let description = l.description || '';
    // The suffix goes inside Fishtape's 1,000 characters: the text before it is cut to leave LOSSY_ROOM.
    if (l.lossy && typeof l.lossy === 'object') {
      description = `${cut(description, LINE_DESC_MAX - LOSSY_ROOM) || ''}${lossySuffix(l.lossy.qty, l.lossy.unitPrice)}`.trim();
      lossy.push(i);
    }
    description = description.slice(0, LINE_DESC_MAX);
    const line = { description, qty: l.qty, unitCents: l.unitCents, kind };
    if (itemId) line.itemId = itemId;
    if (prev) { for (const k of LINE_OWN_FIELDS) if (prev[k] != null) line[k] = prev[k]; }
    else if (l.lineType) line.lineType = l.lineType;
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
  const province = ctx?.company?.province;
  // Each priced line's key, read back from its code (the key the line had in Fishtape first).
  const entries = [];
  plain.forEach((l, i) => {
    if (l.itemRef == null && !l.amountCents) return; // description-only lines carry no tax
    const ln = lines[i];
    const prevKey = existing ? lineTaxKey(existing, prevOf[i] || { kind: ln.kind, lineType: ln.lineType }) : null;
    entries.push({ i, kind: KINDS.includes(ln.kind) ? ln.kind : 'material', lineType: ln.lineType || null, codeId: l.taxCodeId ?? null, prevKey, kept: Boolean(kept[i]) });
  });
  markups.forEach((l) => entries.push({ i: null, kind: 'material', lineType: null, codeId: l.taxCodeId ?? null, prevKey: existing ? lineTaxKey(existing, 'material') : null, kept: false }));
  let shapeOk = true;
  for (const e of entries) {
    e.key = e.codeId == null ? null : reverseTaxKey(e.codeId, codes, { preferred: e.prevKey, province });
    if (!e.key) shapeOk = false;
  }
  // Per kind (9.1): the key of the kind is the document's own when every line of the kind fits
  // under it, else the widest key among the kind's work lines. A line with fewer taxes than its kind
  // gets taxOff for the rest (labour and other lines only); a no-tax deposit, holdback or interest
  // line gets taxOff ['*'].
  const keysByKind = {};
  const widest = (keys) => [...keys].sort((a, b) => parseTaxKey(b).ids.length - parseTaxKey(a).ids.length || a.localeCompare(b));
  for (const kind of KINDS) {
    const of = entries.filter((e) => e.kind === kind && e.key);
    if (!of.length) continue;
    const pool = of.some((e) => !e.lineType) ? of.filter((e) => !e.lineType) : of;
    const candidates = [...new Set([existing ? lineTaxKey(existing, kind) : null, ...widest(new Set(pool.map((e) => e.key)))].filter(Boolean))];
    const chosen = candidates.find((cand) => of.every((e) => keyFits(e, cand, kind)));
    if (!chosen) { shapeOk = false; continue; }
    keysByKind[kind] = chosen;
    for (const e of of) e.off = taxOffFor(e.key, chosen);
  }
  for (const e of entries) {
    if (e.i == null || e.kept || !('off' in e)) continue;
    if (e.off) lines[e.i].taxOff = e.off; else delete lines[e.i].taxOff;
  }
  Object.assign(out, holdbackPatch(holdbacks, existing, codes, province, report));
  const t = taxesFromCodes(keysByKind, { province, date: date || undefined, existingTreatment: existing?.taxTreatment, legacyPct: existing?.taxPct });
  if (!shapeOk || !t.ok) {
    report.taxShape = true;
    if (existing) return out; // keep the record's own tax; the link goes to needs_review (tax_shape)
  }
  return { ...out, taxes: t.taxes, taxPct: t.taxPct, taxProvince: t.taxProvince ?? null, taxTreatment: t.taxTreatment, taxNoneReason: t.taxNoneReason };
}

/** The no-tax key a line of this type gets on a taxed document (tax.js noneKeyOf without a reason). */
const NONE_KEY_OF_TYPE = { interest: 'NONE|EXEMPT', deposit: 'NONE|OOS', holdback: 'NONE|OOS' };

/** Whether a line's key fits under its kind's key: the same, or fewer taxes of the same province. */
function keyFits(e, kindKey, kind) {
  if (e.key === kindKey) return true;
  const k = parseTaxKey(kindKey);
  const p = parseTaxKey(e.key);
  if (k.none) return false; // a taxed line on a kind charged nothing cannot be shown
  if (p.none) return kind !== 'material' && NONE_KEY_OF_TYPE[e.lineType] === e.key;
  if (kind === 'material') return false; // taxOff is honoured on labour and other lines only
  if (p.province && k.province && p.province !== k.province) return false;
  return p.ids.length < k.ids.length && p.ids.every((id) => k.ids.includes(id));
}

/** The taxOff that turns a kind's key into a line's: null when the same; ['*'] for no tax. */
function taxOffFor(lineKey, kindKey) {
  if (lineKey === kindKey) return null;
  const p = parseTaxKey(lineKey);
  if (p.none) return ['*'];
  const off = parseTaxKey(kindKey).ids.filter((id) => !p.ids.includes(id));
  return off.length ? off : null;
}

/**
 * The invoice's holdback from its holdback line (9.2): the amount (cents, against the document's
 * sign) and the taxes it is deferred from (the line's code), keeping the Fishtape-only parts
 * (pct, retainedByCustomerCents, excludePassThrough). Unchanged, nothing is written; a holdback line
 * removed in QuickBooks sets the amount to 0.
 */
function holdbackPatch(holdbacks, existing, codes, province, report) {
  const exHb = existing?.holdback || null;
  const exTotals = existing ? docTotals(existing) : null;
  if (!holdbacks.length) return exTotals?.holdbackCents ? { holdback: { ...exHb, cents: 0 } } : {};
  const cents = -holdbacks.reduce((s, l) => s + (Number(l.amountCents) || 0), 0);
  const codeIds = [...new Set(holdbacks.map((l) => l.taxCodeId ?? null))];
  const exKey = existing && exTotals?.holdbackCents ? holdbackTaxKey(existing, exTotals) : null;
  const key = codeIds.length === 1 && codeIds[0] != null ? reverseTaxKey(codeIds[0], codes, { preferred: exKey, province }) : null;
  if (!key) report.taxShape = true;
  report.holdback = true;
  if (exTotals && exTotals.holdbackCents === cents && key === exKey) return {};
  const deferTaxIds = exHb && key && key === exKey ? (exHb.deferTaxIds || []) : (key ? parseTaxKey(key).ids : []);
  return { holdback: { ...(exHb || { pct: null, excludePassThrough: true }), cents, deferTaxIds } };
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
  // A line on account.rstRecoverable is RST charged on resale lines (r1-get-paid.md 9.3): it comes
  // back as RST on the bill, not as a cost line, so the round trip is stable.
  const rstAcc = str(acc.rstRecoverable);
  const isRst = (l) => Boolean(rstAcc) && !l.itemRef && String(l.accountRef ?? '') === rstAcc;
  const rstCents = (c.lines || []).filter(isRst).reduce((s, l) => s + (Number(l.amountCents) || 0), 0);
  if (has('lines')) {
    const { meta } = linkInfo(ctx);
    const exIds = meta.lineIds && typeof meta.lineIds === 'object' ? meta.lineIds : {};
    const exIndexById = new Map(Object.entries(exIds).map(([i, id]) => [String(id), Number(i)]));
    const exCanon = existing ? fishtapeToCanon('bills', existing, ctx).lines : [];
    p.lines = (c.lines || []).filter((l) => !isRst(l)).map((l) => {
      const j = l.lineId != null ? exIndexById.get(String(l.lineId)) : undefined;
      const prev = j != null ? existing?.lines?.[j] : null;
      const costType = (['material', 'subcontract', 'equipment', 'other'].find((t) => l.accountRef && String(acc[`jobCost.${t}`]) === String(l.accountRef))) || prev?.costType || 'material';
      // A job without a sub-customer goes out as its client: that client coming back keeps the job.
      let jobId = l.customerRef ? fid(ctx, 'jobs', l.customerRef) : null;
      if (!jobId && prev?.jobId && l.customerRef && exCanon[j]?.customerRef === l.customerRef) jobId = prev.jobId;
      const line = { description: l.description || '', qty: l.qty || 1, unitCents: l.qty ? Math.round(l.amountCents / l.qty) : l.amountCents, amountCents: l.amountCents, costType };
      const itemId = l.itemRef ? fid(ctx, 'items', l.itemRef) : null;
      if (itemId) line.itemId = itemId;
      if (jobId) line.jobId = jobId;
      if (prev?.poLine) line.poLine = prev.poLine;
      for (const k of ['taxUse', 'costCodeId', 'equipmentId', 'resaleCreditWrittenOff']) if (prev && prev[k] != null) line[k] = prev[k];
      return line;
    });
  }
  if (has('taxes') || has('lines')) {
    p.taxes = (c.taxes || []).map((t) => ({ id: t.id, label: t.id, cents: t.cents }));
    if (rstCents) {
      const province = existing?.taxProvince || ctx?.company?.province || null;
      const id = province === 'MB' || !province ? 'RST' : 'PST';
      const at = p.taxes.findIndex((t) => String(t.id).toUpperCase() === id);
      if (at >= 0) p.taxes[at] = { ...p.taxes[at], cents: p.taxes[at].cents + rstCents };
      else p.taxes.push({ id, label: id, cents: rstCents });
    }
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
 * invoice's own Deposit (it has its own Fishtape payment, depositRecord) minus the QBO payment lines
 * on this invoice that are linked to Fishtape payments, minus the credit memos applied to it that
 * have a Fishtape credit-note application (link role apply, r1-get-paid.md 9.2), so a memo is never
 * counted twice. Never below 0. Pass payment lines only in `linkedPaymentLineCents`, never the deposit.
 */
export function settlementCents(qboInvoice, linkedPaymentLineCents, appliedMemoCents = []) {
  const settled = toCents(qboInvoice?.TotalAmt) - toCents(qboInvoice?.Balance) - toCents(qboInvoice?.Deposit ?? 0);
  const sumOf = (list) => (Array.isArray(list) ? list : [list]).reduce((s, x) => s + (Math.round(Number(x)) || 0), 0);
  return Math.max(0, settled - sumOf(linkedPaymentLineCents || []) - sumOf(appliedMemoCents || []));
}

/** The pull-only settlement payment for an invoice (method credit, source quickbooks, 4.9). */
export function settlementRecord({ invoiceId, cents, date }) {
  return { invoiceId, amountCents: Math.round(Number(cents) || 0), date, method: 'credit', source: 'quickbooks', reference: 'Credited or paid in QuickBooks' };
}

/** The Fishtape payment for a pulled invoice's Deposit field (link role deposit, 4.7). */
export function depositRecord(qboInvoice, invoiceId) {
  const cents = toCents(qboInvoice?.Deposit);
  if (!cents) return null;
  return { invoiceId, amountCents: cents, date: str(qboInvoice?.TxnDate), method: 'transfer', source: 'quickbooks', reference: 'Deposit in QuickBooks' };
}

/**
 * Link meta from a QBO object just read or written (3.4): line pairing, lossy lines, the kept
 * GlobalTaxCalculation, balances, the exact name and type, and a payment's lines Fishtape does not own.
 * Pass `pushed` (canonToQbo's result) after a write so lines sent lossy stay listed and a payment's
 * own excess (ownExcessCents) is known to the next push; without it the link's value is kept.
 *
 * lineIds and lossyLines are keyed by line position, and Fishtape lines have no ids: the engine must
 * store this meta after every write and every pull of the pair, so a line inserted or removed in
 * Fishtape is paired again before the next merge.
 */
export function linkMetaFromQbo(entity, object, ctx = {}, { pushed = null } = {}) {
  const o = object || {};
  const meta = {};
  if (entity === 'Customer' || entity === 'Vendor') meta.displayName = str(o.DisplayName);
  if (entity === 'Item') { meta.displayName = str(o.Name); meta.qboType = str(o.Type); }
  if (['Invoice', 'Estimate', 'Bill', 'Purchase', 'CreditMemo', 'VendorCredit'].includes(entity)) {
    if (o.GlobalTaxCalculation) meta.globalTax = o.GlobalTaxCalculation;
    if (o.TotalAmt != null) meta.qboTotalCents = toCents(o.TotalAmt);
    if (o.Balance != null) meta.qboBalanceCents = toCents(o.Balance);
    else if (entity === 'CreditMemo' && o.RemainingCredit != null) meta.qboBalanceCents = toCents(o.RemainingCredit);
  }
  if (entity === 'Invoice' || entity === 'Estimate' || entity === 'CreditMemo') {
    const coll = entity === 'Estimate' ? 'estimates' : 'invoices';
    const lines = qboToCanon(entity, o, { ...ctx, collection: coll }).lines;
    const ids = {};
    const lossy = new Set(pushed?.lossyLines || []);
    lines.filter((l) => !l.markup && !l.holdback).forEach((l, i) => { if (l.lineId) ids[String(i)] = l.lineId; if (l.lossy) lossy.add(i); });
    const mk = lines.find((l) => l.markup);
    if (mk?.lineId) ids.markup = mk.lineId;
    const hb = lines.find((l) => l.holdback);
    if (hb?.lineId) ids.holdback = hb.lineId;
    meta.lineIds = ids;
    meta.lossyLines = [...lossy].sort((a, b) => a - b);
  }
  if (entity === 'Bill' || entity === 'VendorCredit' || (entity === 'Purchase' && linkInfo(ctx).role !== 'fee')) {
    const ids = {};
    (o.Line || []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail' || l.DetailType === 'ItemBasedExpenseLineDetail')
      .forEach((l, i) => { if (l.Id != null) ids[String(i)] = String(l.Id); });
    meta.lineIds = ids;
  }
  if (entity === 'Payment' && linkInfo(ctx).role === 'apply') {
    meta.applyTotalCents = toCents(o.TotalAmt);
  } else if (entity === 'Payment') {
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
    // Where the money went: a Stripe payment's fee and payout are booked only from the clearing account (4.9).
    meta.depositTo = str(o.DepositToAccountRef?.value ?? o.DepositToAccountRef);
    const excess = pushed && pushed.ownExcessCents != null ? pushed.ownExcessCents : linkInfo(ctx).meta.ownExcessCents;
    meta.ownExcessCents = Math.min(Math.max(0, meta.unappliedCents), Math.max(0, Math.round(Number(excess) || 0)));
  }
  if (entity === 'Estimate' || entity === 'Invoice' || entity === 'CreditMemo') meta.docNumber = str(o.DocNumber);
  return meta;
}

