// Shared document maths. Everything is integer cents; each tax is rounded once per document.
//
// A line is { description, qty, unitCents, labourHours, kind: material|labour|other }.
// - line amount = qty * unitCents (price-book prices are sell prices, labour included)
// - markupPct (estimates only, default 0) is an extra uplift on material lines
// - labourHours is crew time per unit, used for scheduling and job costing,
//   not added to the price (add a 'labour' line to charge hours separately)
//
// Tax: a document carries `taxes`, a snapshot of its tax components
// ([{ id, label, pct, applies: { material, labour, other } }], see tax.js), so a
// later rate or settings change never rewrites an old invoice. Records from
// before Canadian tax support only have `taxPct`: that becomes one component
// called "Tax" on every line, exactly as the old maths did.

export const KINDS = ['material', 'labour', 'other'];

export function lineCents(l) {
  return Math.round((Number(l.qty) || 0) * (Number(l.unitCents) || 0));
}

/** pct% of cents, rounded half up to the cent. pct is taken to 1/1000 % (QST is 9.975%). */
export function pctOfCents(cents, pct) {
  const milli = Math.round((Number(pct) || 0) * 1000);
  const v = (Number(cents) || 0) * milli; // integer, exact
  return Math.sign(v) * Math.round(Math.abs(v) / 100000);
}

/** The tax components of a document, old or new. */
export function docTaxes(doc) {
  if (Array.isArray(doc.taxes)) return doc.taxes;
  const pct = Number(doc.taxPct) || 0;
  return pct ? [{ id: 'tax', label: 'Tax', pct, applies: { material: true, labour: true, other: true } }] : [];
}

/** Sum of the component rates, kept on documents as `taxPct` for older readers. */
export function combinedPct(taxes) {
  return Math.round((taxes || []).reduce((s, t) => s + (Number(t.pct) || 0), 0) * 1000) / 1000;
}

const ALL_KINDS = { material: true, labour: true, other: true };
const kindOf = (l) => (l?.kind === 'labour' || l?.kind === 'other' ? l.kind : 'material');
const hasTaxOff = (l) => Array.isArray(l?.taxOff) && l.taxOff.length > 0;

/** Line types that are not work (they are left out of the work subtotal, the holdback base and revenue). */
export const LINE_TYPES = ['deposit', 'holdback', 'interest'];

/**
 * Whether one tax is charged on one line: the tax's `applies` for the line's kind, less the line's
 * `taxOff` (['GST'|'HST'|'PST'|'RST'|'QST'|'*'], honoured only on labour and other lines).
 */
export function lineTaxed(line, tax) {
  const kind = kindOf(line);
  if (!(tax?.applies || ALL_KINDS)[kind]) return false;
  if (kind !== 'material' && hasTaxOff(line) && (line.taxOff.includes('*') || line.taxOff.includes(tax.id))) return false;
  return true;
}

/** A work line: no lineType (deposits, holdback releases and interest are not work). */
const isWork = (l) => !l?.lineType;
/** An out-of-pocket disbursement billed at cost (tax.js TAX_OFF_PRESETS); only 'other' lines qualify. */
export const isPassThrough = (l) => Boolean(l?.passThrough) && kindOf(l) === 'other' && isWork(l);

/** The holdback snapshot leaves pass-through lines out of its base unless it says otherwise. */
const excludesPassThrough = (doc) => doc?.holdback?.excludePassThrough !== false;

/** The kinds of invoice (r1-get-paid.md 2.3); a record without `kind` is standard. */
export const INVOICE_KINDS = ['standard', 'deposit', 'progress', 'holdback-release', 'credit', 'interest'];
export function invoiceKind(inv) {
  return INVOICE_KINDS.includes(inv?.kind) ? inv.kind : 'standard';
}

/**
 * Totals of an estimate or invoice. Integer cents; each tax rounded once per document.
 *  - materialCents, labourCents, otherCents: every line by kind (special lines included);
 *    markupCents: markupPct of material; subtotalCents: all of them.
 *  - workSubtotalCents: lines with no lineType, markup included.
 *  - holdbackBaseCents: the work lines, less pass-through lines while the snapshot's
 *    excludePassThrough holds (rule holdback.excludePassThrough).
 *  - holdbackCents = holdback.cents ?? pctOfCents(holdbackBaseCents, holdback.pct). For each tax
 *    in holdback.deferTaxIds that applies to the base lines, the tax base is reduced by the
 *    holdback (it is charged on the release invoice): taxes[].deferredCents.
 *  - netSubtotalCents = subtotalCents - holdbackCents; totalCents = netSubtotalCents + taxCents.
 *  - depositCents, holdbackLineCents, interestCents, passThroughCents: the special lines.
 */
export function docTotals(doc) {
  const lines = doc?.lines || [];
  let materialCents = 0, labourCents = 0, otherCents = 0, hours = 0;
  let workLineCents = 0, passThroughCents = 0, depositCents = 0, holdbackLineCents = 0, interestCents = 0;
  for (const l of lines) {
    const c = lineCents(l);
    const k = kindOf(l);
    if (k === 'labour') labourCents += c;
    else if (k === 'other') otherCents += c;
    else materialCents += c;
    hours += (Number(l.qty) || 0) * (Number(l.labourHours) || 0);
    if (isWork(l)) { workLineCents += c; if (isPassThrough(l)) passThroughCents += c; }
    else if (l.lineType === 'deposit') depositCents += c;
    else if (l.lineType === 'holdback') holdbackLineCents += c;
    else if (l.lineType === 'interest') interestCents += c;
  }
  const markupCents = Math.round(materialCents * (Number(doc?.markupPct) || 0) / 100);
  const subtotalCents = materialCents + labourCents + otherCents + markupCents;
  const workSubtotalCents = workLineCents + markupCents;
  const exclude = excludesPassThrough(doc);
  const holdbackBaseCents = workSubtotalCents - (exclude ? passThroughCents : 0);
  const hb = doc?.holdback;
  let holdbackCents = 0;
  if (hb) holdbackCents = Number.isInteger(hb.cents) ? hb.cents : (Number(hb.pct) ? pctOfCents(holdbackBaseCents, hb.pct) : 0);
  const deferIds = new Set(holdbackCents && Array.isArray(hb?.deferTaxIds) ? hb.deferTaxIds : []);
  const inBase = (l) => isWork(l) && !(exclude && isPassThrough(l));
  const taxes = docTaxes(doc || {}).map((t) => {
    const applies = t.applies || ALL_KINDS;
    let baseCents = applies.material ? markupCents : 0; // markup is part of the material price
    let baseTaxedCents = baseCents; // the part of this tax's base that is in the holdback base
    for (const l of lines) {
      if (!lineTaxed(l, t)) continue;
      const c = lineCents(l);
      baseCents += c;
      if (inBase(l)) baseTaxedCents += c;
    }
    let deferredCents = 0;
    if (deferIds.has(t.id) && baseTaxedCents) {
      // Applies to the whole base alike: the holdback comes off this tax's base. A tax on only part of
      // the base is refused by holdbackProblem; here it is deferred in proportion so totals still add up.
      deferredCents = baseTaxedCents === holdbackBaseCents ? holdbackCents
        : Math.round(holdbackCents * baseTaxedCents / (holdbackBaseCents || 1));
      baseCents -= deferredCents;
    }
    return { id: t.id, label: t.label, pct: Number(t.pct) || 0, baseCents, cents: pctOfCents(baseCents, t.pct), note: t.note || '', deferredCents };
  });
  const taxCents = taxes.reduce((s, t) => s + t.cents, 0);
  const netSubtotalCents = subtotalCents - holdbackCents;
  return {
    materialCents, labourCents, otherCents, markupCents, subtotalCents, taxes, taxCents,
    totalCents: netSubtotalCents + taxCents, hours,
    workSubtotalCents, holdbackBaseCents, holdbackCents, netSubtotalCents,
    passThroughCents, depositCents, holdbackLineCents, interestCents,
  };
}

/**
 * Why a holdback can't stand on this document, or null. Refused when it is larger than its base
 * (or of the other sign), when its percentage is outside 0-100, on deposit, interest and release
 * invoices, and when a deferred tax applies to some lines of the holdback base but not others
 * (QuickBooks can't express that; bill those lines separately).
 */
export function holdbackProblem(doc) {
  const hb = doc?.holdback;
  if (!hb || (!Number(hb.cents) && !Number(hb.pct))) return null;
  if (['deposit', 'interest', 'holdback-release'].includes(invoiceKind(doc))) {
    return { code: 'holdback_kind', message: 'A holdback can only be taken on a progress, standard or credit invoice.' };
  }
  if (hb.pct != null && (Number(hb.pct) < 0 || Number(hb.pct) > 100)) {
    return { code: 'holdback_pct', message: 'The holdback percentage must be between 0 and 100.' };
  }
  const t = docTotals(doc);
  if (t.holdbackCents && (Math.sign(t.holdbackCents) !== Math.sign(t.holdbackBaseCents) || Math.abs(t.holdbackCents) > Math.abs(t.holdbackBaseCents))) {
    return { code: 'holdback_exceeds_base', message: 'The holdback is more than the work it is held on.' };
  }
  const exclude = excludesPassThrough(doc);
  const base = (doc.lines || []).filter((l) => isWork(l) && lineCents(l) !== 0 && !(exclude && isPassThrough(l)));
  for (const id of (Array.isArray(hb.deferTaxIds) ? hb.deferTaxIds : [])) {
    const tax = docTaxes(doc).find((x) => x.id === id);
    if (!tax) continue;
    const flags = base.map((l) => lineTaxed(l, tax));
    if (t.markupCents) flags.push(Boolean((tax.applies || ALL_KINDS).material));
    if (flags.some(Boolean) && !flags.every(Boolean)) {
      return { code: 'holdback_tax_mixed', taxId: id, message: `${tax.label || id} applies to some of the lines in the holdback and not others, so the tax held back can't be worked out. Bill those lines on a separate invoice.` };
    }
  }
  return null;
}

/** Defaults of the policy rules the money maths reads (the 0160 seed values; r1-get-paid.md 2.7). */
export const MONEY_POLICY_DEFAULTS = {
  'tax.CA.gstHoldbackAtRelease': true,
  'tax.MB.rstHoldbackAtRelease': true,
  'tax.SK.pstHoldbackAtRelease': true,
  'tax.BC.pstHoldbackAtRelease': true,
  'holdback.excludePassThrough': true,
  'tax.MB.passThroughAllowed': true,
};

/**
 * A policy rule's value. `rules` is what the caller has: the Map from rules.js resolveRules, the
 * rows of GET /api/v1/rules ([{ key, province, value, status, origin, effectiveFrom }]), or a
 * plain { key: value } object. A policy applies on any status while its value is set (rules.js
 * ruleValue); unset -> MONEY_POLICY_DEFAULTS. Returns { value, status } (status null: the default).
 */
export function policyRule(rules, key, { province = null } = {}) {
  let row = null;
  if (rules instanceof Map) row = rules.get(key) || null;
  else if (Array.isArray(rules)) {
    const rows = rules.filter((r) => r?.key === key && (!r.province || !province || r.province === province));
    rows.sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')) || (a.origin === 'company' ? -1 : b.origin === 'company' ? 1 : 0));
    row = rows[0] || null;
  } else if (rules && typeof rules === 'object' && key in rules) {
    const v = rules[key];
    row = v && typeof v === 'object' && 'value' in v ? v : { value: v, status: 'verified' };
  }
  if (row && row.value != null) return { value: row.value, status: row.status || null };
  return { value: MONEY_POLICY_DEFAULTS[key] ?? null, status: null };
}

const HOLDBACK_TAX_RULE = { MB: { RST: 'tax.MB.rstHoldbackAtRelease' }, SK: { PST: 'tax.SK.pstHoldbackAtRelease' }, BC: { PST: 'tax.BC.pstHoldbackAtRelease' } };

/**
 * The holdback to store on an invoice when the office sets one (r1-get-paid.md 7.3): the taxes
 * charged at release (deferTaxIds: GST/HST while tax.CA.gstHoldbackAtRelease holds, plus the
 * province's PST/RST while its own rule holds) and excludePassThrough, snapshotted so a later rule
 * change never re-rates a sent invoice. Only taxes that apply to some line kind are deferred.
 */
export function holdbackSnapshot(doc, { pct = null, cents = null, rules = null } = {}) {
  const province = doc?.taxProvince || null;
  const pol = (key) => policyRule(rules, key, { province }).value === true;
  const charged = docTaxes(doc || {}).filter((t) => { const a = t.applies || ALL_KINDS; return a.material || a.labour || a.other; });
  const deferTaxIds = charged.filter((t) => {
    if (t.id === 'GST' || t.id === 'HST') return pol('tax.CA.gstHoldbackAtRelease');
    const key = HOLDBACK_TAX_RULE[province]?.[t.id];
    return key ? pol(key) : false;
  }).map((t) => t.id);
  return {
    pct: pct == null || pct === '' ? null : Number(pct),
    ...(Number.isInteger(cents) ? { cents } : {}),
    deferTaxIds,
    excludePassThrough: pol('holdback.excludePassThrough'),
  };
}

/**
 * The one line of a holdback release invoice: the outstanding holdback, taxed by the deferred
 * taxes only (the others were charged on the progress invoices), so every other tax is in taxOff.
 */
export function holdbackReleaseLine(cents, { taxes = [], deferTaxIds = [], description = 'Holdback release' } = {}) {
  const off = (taxes || []).map((t) => t.id).filter((id) => !deferTaxIds.includes(id));
  return {
    itemId: null, kind: 'other', lineType: 'holdback', description, qty: 1,
    unitCents: Math.round(Number(cents) || 0), labourHours: 0, ...(off.length ? { taxOff: off } : {}),
  };
}

// ---- deposits (r1-get-paid.md 4.3) ----------------------------------------------------

export const DEPOSIT_MODELS = ['prepayment', 'security'];
export const DEPOSIT_NOTES = {
  prepayment: 'Prepayment: GST/RST charged now and credited on the final invoice.',
  security: 'Security deposit: no tax until it is applied (Excise Tax Act s.168(9)).',
};

/** The one line of a deposit invoice. A security deposit carries no tax (taxOff ['*']). */
export function depositInvoiceLine({ cents, model = 'prepayment', ref = '' } = {}) {
  return {
    itemId: null, kind: 'other', lineType: 'deposit', description: ref ? `Deposit on ${ref}` : 'Deposit',
    qty: 1, unitCents: Math.abs(Math.round(Number(cents) || 0)), labourHours: 0,
    ...(model === 'security' ? { taxOff: ['*'] } : {}),
  };
}

/** Fields of a new deposit invoice besides its line: kind, model and (security) why there is no tax. */
export function depositInvoiceFields(model = 'prepayment') {
  const m = DEPOSIT_MODELS.includes(model) ? model : 'prepayment';
  return { kind: 'deposit', depositModel: m, ...(m === 'security' ? { taxNoneReason: 'out_of_scope' } : {}) };
}

/**
 * Applying a paid deposit on a later invoice: a negative deposit line. A prepayment line is taxed
 * like the deposit was, so tax is not charged twice; a security deposit line carries no tax, so
 * tax is charged on the full final amount.
 */
export function depositApplicationLine(depositInvoice, cents) {
  const security = depositInvoice?.depositModel === 'security';
  return {
    itemId: null, kind: 'other', lineType: 'deposit', depositInvoiceId: depositInvoice?.id || null,
    description: `Less deposit ${depositInvoice?.number || ''}`.trim(), qty: 1,
    unitCents: -Math.abs(Math.round(Number(cents) || 0)), labourHours: 0,
    ...(security ? { taxOff: ['*'] } : {}),
  };
}

/** A key for a document's tax set: province, treatment, taxes and exemption. */
export function taxSetKey(doc) {
  const taxes = docTaxes(doc || {}).map((t) => [t.id, Number(t.pct) || 0, ...['material', 'labour', 'other'].map((k) => Boolean((t.applies || ALL_KINDS)[k]))]);
  return JSON.stringify([doc?.taxProvince || null, doc?.taxTreatment || null, taxes, doc?.taxExemptBasis || null, String(doc?.taxExemptNumber || '').trim() || null]);
}
/** A prepayment can be applied only on an invoice with the same tax set as the deposit. */
export const sameTaxSet = (a, b) => taxSetKey(a) === taxSetKey(b);

// ---- credit notes (r1-get-paid.md 2.6) ----------------------------------------------------

export const CREDIT_REASONS = ['error', 'price', 'dispute', 'backcharge', 'bad_debt', 'deposit-refund', 'other'];
const TAX_SNAPSHOT_KEYS = ['taxProvince', 'taxTreatment', 'taxes', 'taxPct', 'taxNoneReason', 'taxExemptNumber', 'taxExemptBasis', 'taxExemptDetails'];
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/**
 * A credit note against an invoice: kind 'credit', number CR-1001 on (settings.nextNumbers.credit),
 * dated today, with the given lines (as they read on the invoice) negated. It keeps the original's
 * tax snapshot and exemption (creditTaxSnapshot records them, with the original's number and date
 * for the printed note), so it is never re-rated by today's rates. An invoice with a holdback
 * gives a negative holdback in proportion to the credited base. The caller adds the id and bumps
 * nextNumbers.credit.
 */
export function creditNoteFrom(invoice, { lines = null, reason = 'other', today, number = null, settings = null } = {}) {
  const src = (lines || invoice?.lines || []).map((l) => clone(l));
  const neg = src.map((l) => { const c = { ...l, unitCents: -(Math.round(Number(l.unitCents) || 0)) }; delete c.id; return c; });
  const day = today || new Date().toISOString().slice(0, 10);
  const snap = {};
  for (const k of TAX_SNAPSHOT_KEYS) if (invoice?.[k] !== undefined) snap[k] = clone(invoice[k]);
  const note = {
    kind: 'credit', status: 'draft',
    number: number || `CR-${settings?.nextNumbers?.credit ?? 1001}`,
    issueDate: day, dueDate: day,
    clientId: invoice?.clientId ?? null, jobId: invoice?.jobId ?? null,
    title: `Credit note for ${invoice?.number || 'invoice'}`,
    creditsInvoiceId: invoice?.id ?? null,
    creditReason: CREDIT_REASONS.includes(reason) ? reason : 'other',
    lines: neg,
    ...(invoice?.markupPct ? { markupPct: invoice.markupPct } : {}),
    ...snap,
    ...(invoice?.exemptionConfirmed ? { exemptionConfirmed: clone(invoice.exemptionConfirmed) } : {}),
    creditTaxSnapshot: { ...clone(snap), invoiceNumber: invoice?.number || null, invoiceDate: invoice?.issueDate || null },
    notes: '',
  };
  const orig = docTotals(invoice || {});
  if (orig.holdbackCents && orig.holdbackBaseCents) {
    const credited = docTotals({ ...invoice, lines: src, holdback: { ...invoice.holdback, cents: 0 } }).holdbackBaseCents;
    const share = Math.round(Math.abs(orig.holdbackCents * credited / orig.holdbackBaseCents));
    const hb = clone(invoice.holdback);
    delete hb.retainedByCustomerCents; delete hb.retainedRecordedAt; delete hb.retainedRecordedBy;
    note.holdback = { ...hb, cents: -Math.sign(orig.holdbackCents * credited) * share };
  }
  return note;
}

/**
 * What is left of a credit note to apply: its total (negative) plus the payments that applied it
 * ({ method: 'credit-note', creditNoteId }). Zero when fully applied; negative while open.
 */
export function creditNoteBalance(note, payments = []) {
  const applied = (payments || []).filter((p) => p?.creditNoteId === note?.id).reduce((s, p) => s + (Number(p.amountCents) || 0), 0);
  return docTotals(note || {}).totalCents + applied;
}

// ---- revenue and the progress summary (r1-get-paid.md 11, 7.3) ----------------------------

/**
 * Revenue of one invoice for job profit, WIP and month-end: the work lines (markup and pass-through
 * included), gross of holdback, on standard, progress and credit invoices (credit notes and
 * back-charges are negative). Never deposit, release or interest lines. A forfeited prepayment
 * deposit counts from its forfeitedOn (with asOf: once that day is reached). Draft and void
 * invoices count zero. Never netSubtotalCents.
 */
export function revenueCents(inv, { asOf = null } = {}) {
  if (!inv || inv.status === 'void' || inv.status === 'draft') return 0;
  const kind = invoiceKind(inv);
  if (kind === 'deposit') {
    if (!inv.forfeitedOn || inv.depositModel === 'security' || (asOf && inv.forfeitedOn > asOf)) return 0;
    return docTotals(inv).depositCents;
  }
  if (kind !== 'standard' && kind !== 'progress' && kind !== 'credit') return 0;
  return docTotals(inv).workSubtotalCents;
}

const billedBefore = (a, b) => {
  const da = String(a?.issueDate || ''), db = String(b?.issueDate || '');
  if (da !== db) return da < db;
  return String(a?.number || a?.id || '') < String(b?.number || b?.id || '');
};

/**
 * The contract summary printed on progress invoices (and any invoice with a holdback on a job with
 * a contract value), or null without a contract value: contract plus approved change orders,
 * previously billed (gross of holdback), this invoice, holdback retained to date (less releases,
 * plus holdback the customer kept on its own), balance to finish.
 */
export function progressSummary(invoice, { job = null, invoices = [] } = {}) {
  const value = job?.contract?.valueCents;
  if (!Number.isInteger(value)) return null;
  const on = String(invoice?.issueDate || '9999-12-31');
  const changeOrdersCents = (job.changeOrders || [])
    .filter((c) => c && c.status === 'approved' && String(c.approvedOn || c.date || '') <= on)
    .reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
  const others = (invoices || []).filter((i) => i && i.id !== invoice?.id && i.jobId === job.id && i.status !== 'void' && i.status !== 'draft' && billedBefore(i, invoice));
  const previousCents = others.reduce((s, i) => s + revenueCents(i), 0);
  const counts = ['standard', 'progress', 'credit'].includes(invoiceKind(invoice)) && invoice?.status !== 'void';
  const thisCents = counts ? docTotals(invoice).workSubtotalCents : 0;
  const held = (i) => (['standard', 'progress', 'credit'].includes(invoiceKind(i)) ? docTotals(i).holdbackCents : 0) + (Number(i.holdback?.retainedByCustomerCents) || 0);
  const retained = [...others, ...(counts ? [invoice] : [])].reduce((s, i) => s + held(i), 0);
  const releasedCents = others.filter((i) => invoiceKind(i) === 'holdback-release').reduce((s, i) => s + docTotals(i).holdbackLineCents, 0);
  const contractCents = value + changeOrdersCents;
  const billedToDateCents = previousCents + thisCents;
  return {
    originalContractCents: value, changeOrdersCents, contractCents,
    previousCents, thisCents, billedToDateCents,
    holdbackRetainedCents: retained - releasedCents, holdbackReleasedCents: releasedCents,
    balanceToFinishCents: contractCents - billedToDateCents,
    pctBilled: contractCents ? Math.round(billedToDateCents * 1000 / contractCents) / 10 : null,
  };
}

/**
 * Money for display, Canadian English by default: 1234.5 CAD -> "$1,234.50",
 * USD in en-CA -> "US$1,234.50". Pure, so documents print the same everywhere.
 */
export function formatMoney(cents, { currency = 'CAD', locale = 'en-CA', whole = false } = {}) {
  const v = (Number(cents) || 0) / 100;
  try {
    return v.toLocaleString(locale, { style: 'currency', currency, maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 });
  } catch {
    return `${currency} ${v.toFixed(whole ? 0 : 2)}`;
  }
}

/** A formatter bound to the company's currency: const money = moneyFormatter(store.settings()). */
export function moneyFormatter(settings) {
  const currency = settings?.currency || 'CAD';
  return (cents, opts = {}) => formatMoney(cents, { currency, ...opts });
}

export function invoicePaidCents(store, invoiceId) {
  return store.list('payments', (p) => p.invoiceId === invoiceId).reduce((s, p) => s + (Number(p.amountCents) || 0), 0);
}

export function invoiceBalanceCents(store, inv) {
  return docTotals(inv).totalCents - invoicePaidCents(store, inv.id);
}

/** Status for display: stored status, but 'overdue' when sent/partial and past due. A credit note is 'applied' or 'open', never 'paid'. */
export function invoiceStatus(store, inv) {
  if (inv.status === 'void' || inv.status === 'draft') return inv.status;
  if (invoiceKind(inv) === 'credit') return creditNoteBalance(inv, store.list('payments', (p) => p.creditNoteId === inv.id)) >= 0 ? 'applied' : 'open';
  const bal = invoiceBalanceCents(store, inv);
  if (bal <= 0) return 'paid';
  const due = inv.dueDate && new Date(inv.dueDate + 'T23:59:59') < new Date();
  if (due) return 'overdue';
  return invoicePaidCents(store, inv.id) > 0 ? 'partial' : inv.status;
}

/**
 * Cents of QuickBooks' own tax rounding a 'paid' set by the server may leave on this device (4.8):
 * 2 per charged rate, the sync's tolerance. The server marks such an invoice paid at the
 * QuickBooks total (meta.taxDeltaCents, which devices never see).
 */
export function taxRoundingCents(inv) {
  const n = (Array.isArray(inv?.taxes) ? inv.taxes : []).filter((t) => (Number(t.pct) || 0) > 0).length;
  return 2 * Math.max(1, n);
}

/**
 * A stored 'paid' this device keeps although a cent or two is left: only the QuickBooks tax
 * rounding remains. Never promotes another status, and never counts an overpayment.
 */
export function keepsServerPaid(inv, paidCents, totalCents) {
  if (inv?.status !== 'paid' || !(paidCents > 0)) return false;
  const left = totalCents - paidCents;
  return left > 0 && left <= taxRoundingCents(inv);
}

/**
 * Status and balance as every screen shows them (invoice list and detail, client and job tabs,
 * dashboard). A 'paid' the server set at the QuickBooks total (its own tax rounding,
 * docs/integrations/quickbooks.md 4.8) stays paid with a balance of 0, although a cent or two is
 * left by Fishtape's arithmetic. Use this, not invoiceStatus / invoiceBalanceCents, for display.
 */
export function invoiceShown(store, inv) {
  if (inv.status === 'void') return { status: 'void', balanceCents: 0 };
  // A credit note: its unapplied part (negative while open), never "paid".
  if (invoiceKind(inv) === 'credit') {
    return { status: invoiceStatus(store, inv), balanceCents: creditNoteBalance(inv, store.list('payments', (p) => p.creditNoteId === inv.id)) };
  }
  const paid = invoicePaidCents(store, inv.id);
  const total = docTotals(inv).totalCents;
  if (keepsServerPaid(inv, paid, total)) return { status: 'paid', balanceCents: 0 };
  return { status: invoiceStatus(store, inv), balanceCents: total - paid };
}

/** Hours worked on a time entry (open entries count up to now). */
export function entryHours(e, now = new Date()) {
  if (!e.clockIn) return 0;
  const end = e.clockOut ? new Date(e.clockOut) : now;
  const mins = (end - new Date(e.clockIn)) / 60000 - (Number(e.breakMins) || 0);
  return Math.max(0, mins / 60);
}
