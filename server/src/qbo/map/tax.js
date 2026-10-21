// Canadian sales tax between Fishtape and QuickBooks (docs/integrations/quickbooks.md 4.8). Pure.
//
// Fishtape taxes a document per line kind with `taxes[]` components (electrical-app/js/lib/tax.js),
// less each line's taxOff (money.js lineTaxed); QuickBooks puts a TaxCode on each line and rounds per
// rate. A line's tax key is the taxes charged on that line (r1-get-paid.md 9.1; the CSV export's
// qbo-export.js taxKey: 'GST+RST|MB', 'GST', 'HST|ON', the legacy 'TAX'), or a no-tax key from the
// document's taxNoneReason ('NONE|ZERO', 'NONE|EXEMPT', 'NONE|OOS', 'NONE|RELIEF') or the line's type.
// Mapping taxCode.<key> holds the QBO TaxCode id; lines are compared by that id, never by key.
//
// `ref` arguments are the qbo_reference lists: { codes: [TaxCode], rates: [TaxRate], agencies: [TaxAgency] }
// with the allow-listed fields of 3.8 (a code's rate lists may be QBO's { TaxRateDetail: [...] } or
// plain arrays of rate ids).
import { pctOfCents, docTotals, docTaxes, combinedPct, lineTaxed, lineCents, KINDS } from '../../../../electrical-app/js/lib/money.js';
import { ratesOn, taxComponents, treatmentsFor, TREATMENTS } from '../../../../electrical-app/js/lib/tax.js';
import { lineTaxIds, taxKey, DEFAULT_TAX_CODES } from '../../../../electrical-app/js/lib/qbo-export.js';

/** taxNoneReason -> key suffix. */
export const NONE_REASON_KEYS = { zero: 'ZERO', exempt: 'EXEMPT', out_of_scope: 'OOS', relief: 'RELIEF' };
const REASON_OF_KEY = Object.fromEntries(Object.entries(NONE_REASON_KEYS).map(([r, k]) => [k, r]));
export const NONE_KEYS = Object.values(NONE_REASON_KEYS).map((k) => `NONE|${k}`);
/** Taxes paid on purchases that come back as input tax credits or refunds; PST and RST do not (4.8). */
export const RECOVERABLE = ['GST', 'HST', 'QST'];

const cents = (d) => { const n = Number(d); return Number.isFinite(n) ? Math.sign(n) * Math.round(parseFloat((Math.abs(n) * 100).toPrecision(12))) || 0 : 0; };
const dollars = (c) => Number(((Number(c) || 0) / 100).toFixed(2));
const idOf = (r) => (r && typeof r === 'object' ? String(r.value ?? r.Id ?? '') : String(r ?? ''));
const ISO = (d) => (d instanceof Date ? d.toISOString() : String(d || new Date().toISOString())).slice(0, 10);

const kindOfLine = (l) => (KINDS.includes(l?.kind) ? l.kind : 'material');

/**
 * The taxes charged on one line (r1-get-paid.md 9.1): the document's taxes that apply to the line's
 * kind, less the line's taxOff (money.js lineTaxed, the rule docTotals uses). Sorted upper-case ids.
 */
export function lineTaxIdsOf(doc, line) {
  return docTaxes(doc || {}).filter((t) => (Number(t.pct) || 0) > 0 && lineTaxed(line || {}, t)).map((t) => String(t.id).toUpperCase()).sort();
}

/**
 * The no-tax key of a line: the document's reason, else what the line is. An interest line is an
 * exempt supply (NONE|EXEMPT); a security-deposit line (taxOff '*') and a holdback release with
 * nothing deferred are out of scope (NONE|OOS). A work line with no reason stays 'NONE' (tax_reason).
 */
function noneKeyOf(doc, line) {
  const r = NONE_REASON_KEYS[doc?.taxNoneReason];
  if (r) return `NONE|${r}`;
  if (line?.lineType === 'interest') return 'NONE|EXEMPT';
  if (line?.lineType === 'deposit' || line?.lineType === 'holdback') return 'NONE|OOS';
  return 'NONE';
}

/**
 * The tax key of one line (r1-get-paid.md 9.1): the taxes charged on it ('GST+RST|MB', 'GST', the
 * legacy 'TAX'), or a no-tax key. A pass-through line on a Manitoba invoice gets 'GST'; a
 * security-deposit line 'NONE|OOS'. Given a kind name instead of a line, the key of a plain line of
 * that kind (the per-kind key of 4.8, still used for the markup line and by older callers).
 */
export function lineTaxKey(doc, lineOrKind) {
  const line = typeof lineOrKind === 'string' ? { kind: lineOrKind } : (lineOrKind || {});
  const key = taxKey(lineTaxIdsOf(doc, line), doc?.taxProvince);
  return key === 'NONE' ? noneKeyOf(doc, line) : key;
}

/**
 * The tax key of a document's holdback line (9.2): the taxes the holdback is deferred from
 * (docTotals taxes[].deferredCents), else out of scope (nothing deferred: the tax was charged on
 * the progress bill, so the negative line carries none).
 */
export function holdbackTaxKey(doc, totals = docTotals(doc || {})) {
  const ids = totals.taxes.filter((t) => t.deferredCents && (Number(t.pct) || 0) > 0).map((t) => String(t.id).toUpperCase()).sort();
  return ids.length ? taxKey(ids, doc?.taxProvince) : 'NONE|OOS';
}

/** A line with no item, no quantity and no price: text only, never taxed. */
export const descriptionOnly = (l) => !l?.itemId && (Number(l?.qty) || 0) === 0 && Math.round(Number(l?.unitCents) || 0) === 0;

/**
 * Every priced line of a document as QuickBooks gets it, with its tax key (9.1, 9.2): the
 * document's own lines (description-only lines are left out), the markup line and the negative
 * holdback line. [{ key, kind, cents, index?, markup?, holdback? }]
 */
export function docTaxLines(doc) {
  const t = docTotals(doc || {});
  const out = [];
  (doc?.lines || []).forEach((l, index) => {
    if (descriptionOnly(l)) return;
    out.push({ key: lineTaxKey(doc, l), kind: kindOfLine(l), cents: lineCents(l), index });
  });
  if (t.markupCents) out.push({ key: lineTaxKey(doc, 'material'), kind: 'material', cents: t.markupCents, markup: true });
  if (t.holdbackCents) out.push({ key: holdbackTaxKey(doc, t), kind: 'other', cents: -t.holdbackCents, holdback: true });
  return out;
}

/** The tax keys a document uses, each once. */
export const docTaxKeys = (doc) => [...new Set(docTaxLines(doc).map((x) => x.key))];

/** The kinds a document's lines use (a markup only exists on material, so it adds none). */
export function kindsUsed(doc) {
  const used = new Set((doc?.lines || []).map(kindOfLine));
  return KINDS.filter((k) => used.has(k));
}

/** { kind: key } for every kind the document uses (the key of a plain line of that kind). */
export function docKeysByKind(doc) {
  return Object.fromEntries(kindsUsed(doc).map((k) => [k, lineTaxKey(doc, k)]));
}

/** True when a line has no tax and the document no taxNoneReason: it is not pushed (blocked/tax_reason). */
export function needsTaxReason(doc) {
  return docTaxLines(doc).some((x) => x.key === 'NONE');
}

/** 'GST+RST|MB' -> { ids: ['GST', 'RST'], province: 'MB', none: false, reason: null }. */
export function parseTaxKey(key) {
  const k = String(key || '');
  if (k === 'NONE' || k.startsWith('NONE|')) return { ids: [], province: null, none: true, reason: REASON_OF_KEY[k.slice(5)] || null };
  const [ids, province] = k.split('|');
  return { ids: ids ? ids.split('+') : [], province: province || null, none: false, reason: null };
}

/**
 * Every sales tax key a company needs mapped (7.6): the keys its province's treatments produce,
 * plus the four no-tax reasons.
 */
export function companyTaxKeys(province, date = new Date()) {
  const keys = new Set();
  for (const treatment of treatmentsFor(province)) {
    const doc = { taxProvince: province, taxes: taxComponents({ province, treatment, date }) };
    for (const kind of KINDS) {
      const key = taxKey(lineTaxIds(doc, kind), province);
      if (key !== 'NONE') keys.add(key);
    }
  }
  return [...keys, ...NONE_KEYS];
}

// ---------------------------------------------------------------------------------------------
// Reference lists

function rateIds(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : (list.TaxRateDetail || []);
  return arr.map((x) => (x && typeof x === 'object' ? idOf(x.TaxRateRef ?? x) : String(x))).filter(Boolean);
}
export const salesRateIds = (code) => rateIds(code?.SalesTaxRateList);
export const purchaseRateIds = (code) => rateIds(code?.PurchaseTaxRateList);
const findCode = (ref, id) => (ref?.codes || []).find((c) => String(c.Id) === String(id)) || null;
const findRate = (ref, id) => (ref?.rates || []).find((r) => String(r.Id) === String(id)) || null;

/** A TaxRate's percentage in force on a day (EffectiveTaxRate history first, else RateValue). */
export function ratePct(rate, date = new Date()) {
  if (!rate) return null;
  const d = ISO(date);
  const hist = Array.isArray(rate.EffectiveTaxRate) ? rate.EffectiveTaxRate : [];
  const row = hist.find((h) => String(h.EffectiveDate || '').slice(0, 10) <= d && (!h.EndDate || d <= String(h.EndDate).slice(0, 10)));
  const v = row ? row.RateValue : rate.RateValue;
  return v == null ? null : Number(v);
}

const samePcts = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p - b[i]) < 0.0005);
const sortNum = (a) => [...a].sort((x, y) => x - y);

/**
 * The Fishtape tax id of a QBO rate: from its name (GST, HST, QST, PST, RST), Manitoba PST being
 * Fishtape's RST. Without a name, the percentage decides (5 GST; 13, 14, 15 HST; 9.975 QST; 6, 7, 8 PST).
 */
export function taxIdForRate(rate, province, pct) {
  const name = String(rate?.Name || '');
  const m = /\b(GST|HST|QST|TVQ|PST|RST|TVH|TPS)\b/i.exec(name);
  let id = m ? m[1].toUpperCase() : null;
  if (id === 'TPS') id = 'GST';
  if (id === 'TVH') id = 'HST';
  if (id === 'TVQ') id = 'QST';
  const p = Number(pct ?? rate?.RateValue);
  if (!id) id = p === 5 ? 'GST' : [13, 14, 15].includes(p) ? 'HST' : p === 9.975 ? 'QST' : [6, 7, 8].includes(p) ? 'PST' : null;
  if (id === 'PST' && (province === 'MB' || /\bMB\b|Manitoba/i.test(name))) id = 'RST';
  return id || 'TAX';
}

// ---------------------------------------------------------------------------------------------
// Pull: QBO codes back to Fishtape taxes

/**
 * The key a pulled line takes for its QBO code (4.8): the key the Fishtape document already uses
 * for that kind when it maps to the code, else the first non-legacy key mapped to it (keys for the
 * company province first). Null when no key maps to the code.
 */
export function reverseTaxKey(codeId, taxCodeMap, { preferred = null, province = null } = {}) {
  if (!codeId) return null;
  const keys = Object.keys(taxCodeMap || {}).filter((k) => String(taxCodeMap[k]) === String(codeId));
  if (!keys.length) return null;
  if (preferred && keys.includes(preferred)) return preferred;
  const rank = (k) => (k === 'TAX' || k === 'NONE' ? 2 : 0) + (parseTaxKey(k).province && parseTaxKey(k).province !== province ? 1 : 0);
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

const idsForKind = (comps, kind) => comps.filter((t) => (Number(t.pct) || 0) > 0 && (t.applies || {})[kind]).map((t) => String(t.id).toUpperCase()).sort();

/**
 * Fishtape tax fields for a pulled document from the key each line kind maps back to (4.8):
 * { taxes, taxPct, taxTreatment, taxNoneReason, taxProvince, ok }. `ok` is false when Fishtape
 * cannot represent it exactly (mixed provinces or reasons, unknown ids, legacy TAX without a rate):
 * the document then goes to needs_review (tax_shape).
 * @param {{ [kind]: string }} keysByKind
 * @param {{ province?, date?, existingTreatment?, legacyPct? }} opts  existingTreatment is tried first, so
 *   a document keeps its treatment when it still fits (BC real-property and gst-only give the same keys);
 *   the document's own keys are kept per line by reverseTaxKey's `preferred`.
 */
export function taxesFromCodes(keysByKind, { province = null, date = new Date(), existingTreatment = null, legacyPct = null } = {}) {
  const kinds = KINDS.filter((k) => keysByKind?.[k]);
  const fail = (extra = {}) => ({ taxes: [], taxPct: 0, taxTreatment: 'custom', taxNoneReason: null, taxProvince: province, ok: false, ...extra });
  const parsed = Object.fromEntries(kinds.map((k) => [k, parseTaxKey(keysByKind[k])]));
  const provinces = new Set(kinds.map((k) => parsed[k].province).filter(Boolean));
  if (provinces.size > 1) return fail();
  const prov = [...provinces][0] || province;
  const reasons = new Set(kinds.filter((k) => parsed[k].none).map((k) => parsed[k].reason));
  if (reasons.size > 1) return fail({ taxProvince: prov });
  const taxNoneReason = reasons.size ? [...reasons][0] : null;
  const taxed = kinds.filter((k) => !parsed[k].none);
  if (!taxed.length) return { taxes: [], taxPct: 0, taxTreatment: 'none', taxNoneReason, taxProvince: prov, ok: true };

  if (taxed.some((k) => parsed[k].ids.includes('TAX'))) {
    if (!taxed.every((k) => parsed[k].ids.join() === 'TAX') || !(Number(legacyPct) > 0)) return fail({ taxProvince: prov });
    const applies = Object.fromEntries(KINDS.map((k) => [k, taxed.includes(k)]));
    const taxes = [{ id: 'tax', label: 'Tax', pct: Number(legacyPct), applies, note: '' }];
    return { taxes, taxPct: Number(legacyPct), taxTreatment: 'custom', taxNoneReason, taxProvince: null, ok: true };
  }

  const parts = ratesOn(prov, date);
  const gstPart = ratesOn('AB', date).find((p) => p.id === 'GST');
  const partFor = (id) => parts.find((p) => p.id === id) || (id === 'GST' ? gstPart : null);
  if (taxed.some((k) => parsed[k].ids.some((id) => !partFor(id)))) return fail({ taxProvince: prov });

  // A treatment of the province that gives exactly these keys, the document's own first. A new BC
  // document with GST only is 'real-property' (BC's default, ahead of 'gst-only'): both charge the same
  // taxes; only the label and note differ, and real-property contracts are the usual case for electricians.
  const order = [...new Set([existingTreatment, ...treatmentsFor(prov)].filter((t) => t && TREATMENTS[t] && t !== 'none'))];
  for (const t of order) {
    const comps = taxComponents({ province: prov, treatment: t, date });
    if (kinds.every((k) => idsForKind(comps, k).join('+') === parsed[k].ids.join('+'))) {
      return { taxes: comps, taxPct: combinedPct(comps.filter((c) => c.applies.material || c.applies.labour || c.applies.other)), taxTreatment: t, taxNoneReason, taxProvince: prov, ok: true };
    }
  }
  // Otherwise the exact components, per kind.
  const ids = [...new Set(taxed.flatMap((k) => parsed[k].ids))];
  const taxes = ids.map((id) => {
    const p = partFor(id);
    return { id, label: p.label, pct: p.pct, applies: Object.fromEntries(KINDS.map((k) => [k, Boolean(parsed[k] && parsed[k].ids.includes(id))])), note: '' };
  });
  return { taxes, taxPct: combinedPct(taxes), taxTreatment: 'custom', taxNoneReason, taxProvince: prov, ok: true };
}

// ---------------------------------------------------------------------------------------------
// Push: the pre-push check, the totals check and the override

/**
 * QBO's expected tax per rate for a document (4.8, before a create or a tax-changing update):
 * from the mapped codes' TaxRate percentages in force on `date`, line by line (r1-get-paid.md 9.1).
 * `codes` maps a tax key to its QBO code id (the taxCode mappings); a map by line kind
 * ({ material, labour, other }) is still read for lines whose key it does not hold. `mismatch` is
 * set when a code's rates differ from what the document charges on its lines (an old 8% PST code).
 * @returns {{ ok, perRate: [{ rateId, name, pct, baseCents, cents }], mismatch: { codeName, codePcts, docPcts } | null }}
 */
export function expectedTax(doc, codes, ref, date = doc?.issueDate || new Date()) {
  const groups = new Map();
  for (const x of docTaxLines(doc)) {
    const codeId = codes?.[x.key] ?? codes?.[x.kind] ?? null;
    const k = `${x.key}\u0000${codeId ?? ''}`;
    const g = groups.get(k) || { key: x.key, codeId, baseCents: 0 };
    g.baseCents += x.cents;
    groups.set(k, g);
  }
  const per = new Map();
  let mismatch = null;
  let ok = true;
  for (const g of groups.values()) {
    const code = findCode(ref, g.codeId);
    const docPcts = docPctsFor(doc, g.key);
    if (!code) { ok = false; mismatch = mismatch || { codeName: null, codePcts: [], docPcts }; continue; }
    const rates = salesRateIds(code).map((id) => ({ id, rate: findRate(ref, id) }));
    const codePcts = sortNum(rates.map((r) => ratePct(r.rate, date)).filter((p) => p != null && p > 0));
    if (!samePcts(codePcts, docPcts) || rates.some((r) => !r.rate)) { ok = false; mismatch = mismatch || { codeName: code.Name, codePcts, docPcts }; }
    for (const r of rates) {
      const pct = ratePct(r.rate, date) ?? 0;
      const row = per.get(r.id) || { rateId: r.id, name: r.rate?.Name || null, pct, baseCents: 0, cents: 0 };
      row.baseCents += g.baseCents;
      per.set(r.id, row);
    }
  }
  const perRate = [...per.values()].map((r) => ({ ...r, cents: pctOfCents(r.baseCents, r.pct) }));
  return { ok: ok && !mismatch, perRate, mismatch };
}

/** The percentages the document charges for a key's taxes (none for a no-tax key). */
function docPctsFor(doc, key) {
  const ids = new Set(parseTaxKey(key).ids);
  if (ids.has('TAX')) return sortNum(docTaxes(doc || {}).filter((t) => (Number(t.pct) || 0) > 0).map((t) => Number(t.pct)));
  return sortNum(docTaxes(doc || {}).filter((t) => (Number(t.pct) || 0) > 0 && ids.has(String(t.id).toUpperCase())).map((t) => Number(t.pct)));
}

const pctLabel = (pcts) => (pcts.length ? pcts.map((p) => `${Math.round(p * 1000) / 1000}%`).join(' + ') : 'no tax');
/** "QuickBooks code GST/PST MB charges 5% + 8%; this invoice charges 5% + 7%". */
export function taxMismatchMessage(mismatch, docWord = 'document') {
  if (!mismatch) return '';
  if (!mismatch.codeName) return `A tax code for this ${docWord} is not mapped in QuickBooks settings.`;
  return `QuickBooks code ${mismatch.codeName} charges ${pctLabel(mismatch.codePcts)}; this ${docWord} charges ${pctLabel(mismatch.docPcts)}`;
}

/** Fishtape components with tax, paired with QBO rates by percentage (then by name). */
function pairByRate(fishtapeTaxes, qboRows) {
  const used = new Set();
  const pairs = [];
  for (const q of qboRows) {
    let idx = -1;
    for (let i = 0; i < fishtapeTaxes.length; i++) {
      if (used.has(i) || q.pct == null || Math.abs((Number(fishtapeTaxes[i].pct) || 0) - q.pct) >= 0.0005) continue;
      if (idx === -1 || (q.name && new RegExp(`\\b${fishtapeTaxes[i].id}\\b`, 'i').test(q.name))) idx = i;
    }
    if (idx >= 0) used.add(idx);
    pairs.push({ q, f: idx >= 0 ? fishtapeTaxes[idx] : null });
  }
  const left = fishtapeTaxes.filter((t, i) => !used.has(i));
  return { pairs, left };
}

/**
 * Fishtape's per-component cents (docTotals) against QBO's TxnTaxDetail, matched by rate.
 * Within tolerance means every rate differs by 2 cents or less (4.8).
 */
export function compareTax(fishtapeTotals, txnTaxDetail, ref, date = new Date()) {
  const rows = new Map();
  for (const l of txnTaxDetail?.TaxLine || []) {
    if (l.DetailType && l.DetailType !== 'TaxLineDetail') continue;
    const id = idOf(l.TaxLineDetail?.TaxRateRef);
    const rate = findRate(ref, id);
    const pct = l.TaxLineDetail?.TaxPercent != null ? Number(l.TaxLineDetail.TaxPercent) : ratePct(rate, date);
    const row = rows.get(id) || { rateId: id, pct, name: rate?.Name || null, cents: 0 };
    row.cents += cents(l.Amount);
    rows.set(id, row);
  }
  const fishtape = (fishtapeTotals?.taxes || []).filter((t) => (Number(t.pct) || 0) > 0 && (t.cents || t.baseCents));
  const { pairs, left } = pairByRate(fishtape, [...rows.values()]);
  const perRate = [
    ...pairs.map(({ q, f }) => ({ rateId: q.rateId, fishtapeCents: f ? f.cents : 0, qboCents: q.cents })),
    ...left.map((f) => ({ rateId: null, fishtapeCents: f.cents, qboCents: 0 })),
  ];
  return {
    equal: perRate.every((r) => r.fishtapeCents === r.qboCents),
    withinTolerance: perRate.every((r) => Math.abs(r.fishtapeCents - r.qboCents) <= 2),
    perRate,
  };
}

/**
 * The TxnTaxDetail that makes QBO hold Fishtape's tax (4.8): a TaxLine for every rate of the
 * codes used, with Fishtape's amounts, and TotalTax = Fishtape's tax. Null when a Fishtape
 * component with tax has no matching QBO rate (nothing sensible to send).
 * @param {{ taxes: [{ id, pct, cents, baseCents }], taxCents? }} fishtapeTotals docTotals() or a bill's taxes
 * @param {string[]} codeIds
 * @param {{ date?, purchase? }} [opts] purchase: use the codes' purchase rates
 */
export function taxOverride(fishtapeTotals, codeIds, ref, { date = new Date(), purchase = false } = {}) {
  const ids = [];
  for (const cid of new Set((codeIds || []).filter(Boolean).map(String))) {
    const code = findCode(ref, cid);
    if (!code) return null;
    for (const r of purchase ? purchaseRateIds(code) : salesRateIds(code)) if (!ids.includes(r)) ids.push(r);
  }
  if (!ids.length) return null;
  const rows = ids.map((id) => { const rate = findRate(ref, id); return { rateId: id, pct: ratePct(rate, date), name: rate?.Name || null }; });
  const fishtape = (fishtapeTotals?.taxes || []).filter((t) => (Number(t.pct) || 0) > 0 && t.cents);
  const { pairs, left } = pairByRate(fishtape, rows);
  if (left.length) return null;
  const total = fishtape.reduce((s, t) => s + t.cents, 0);
  return {
    TotalTax: dollars(fishtapeTotals?.taxCents ?? total),
    TaxLine: pairs.map(({ q, f }) => ({
      Amount: dollars(f ? f.cents : 0), DetailType: 'TaxLineDetail',
      TaxLineDetail: { TaxRateRef: { value: q.rateId }, PercentBased: true, TaxPercent: q.pct ?? 0, NetAmountTaxable: dollars(f?.baseCents ?? 0) },
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Purchases

/** The purchase tax key of a bill: its taxes' ids (with cents) and province: 'GST+RST|MB', 'GST', 'NONE'. */
export function purchaseTaxKey(bill, province = bill?.taxProvince) {
  const ids = [...new Set((bill?.taxes || []).filter((t) => Number(t.cents)).map((t) => String(t.id).toUpperCase()))].sort();
  return taxKey(ids, province || '');
}

/** Pro-rata shares of `total` over `amounts` (by value), rounding remainder on the largest. */
function share(total, amounts) {
  const base = amounts.reduce((s, a) => s + a, 0);
  if (!amounts.length || !total) return amounts.map(() => 0);
  let largest = 0;
  amounts.forEach((a, i) => { if (Math.abs(a) > Math.abs(amounts[largest])) largest = i; });
  const out = amounts.map((a) => (base ? Math.round((total * a) / base) : 0));
  out[largest] += total - out.reduce((s, x) => s + x, 0);
  return out;
}

/**
 * PST/RST paid on a purchase is not an input credit (4.8). Its printed cents are shared over the
 * lines pro rata by amount (rounding remainder on the largest line). Without `taxUse` every share
 * goes into its line's cost. With it (r1-get-paid.md 9.3; rst.js billLineTaxUse, 'resale' or
 * 'own-use' per line), only own-use lines take their share into cost; the shares of resale lines
 * (RST charged on materials TG resells, which the supplier credits back) are returned as
 * `resaleCents` for one line on account.rstRecoverable, never cost, unless the line's resale credit
 * was written off (resaleCreditWrittenOff: then it is cost after all). Returns the new lines, only
 * the recoverable taxes, and resaleCents.
 * @param {{ amountCents }[]} lines
 * @param {{ id, cents }[]} taxes
 * @param {string[]} [recoverableIds]
 * @param {{ taxUse?: (line: object, index: number) => 'resale'|'own-use' }} [opts]
 */
export function spreadPurchaseTax(lines, taxes, recoverableIds = RECOVERABLE, { taxUse = null } = {}) {
  const rec = new Set((recoverableIds || []).map((x) => String(x).toUpperCase()));
  const keep = (taxes || []).filter((t) => rec.has(String(t.id).toUpperCase()));
  const spread = (taxes || []).filter((t) => !rec.has(String(t.id).toUpperCase())).reduce((s, t) => s + (Math.round(Number(t.cents)) || 0), 0);
  const amounts = (lines || []).map((l) => Math.round(Number(l.amountCents)) || 0);
  const shares = share(spread, amounts);
  let resaleCents = 0;
  const out = (lines || []).map((l, i) => {
    const resale = typeof taxUse === 'function' && taxUse(l, i) === 'resale' && !l.resaleCreditWrittenOff;
    if (resale) { resaleCents += shares[i]; return { ...l, amountCents: amounts[i] }; }
    return { ...l, amountCents: amounts[i] + shares[i] };
  });
  return { lines: out, taxes: keep.map((t) => ({ ...t })), resaleCents };
}

/**
 * Resale or own use for a bill line when rst.js (R1-E, r1-get-paid.md 3.5) is not loaded: the
 * line's own taxUse, else material is resale, a subcontract is resale only from a vendor marked
 * meSubtrade, and equipment and other lines are own use. The engine uses rst.js billLineTaxUse
 * when it is present; this mirrors its stated default and is used only without it.
 */
export function fallbackBillLineTaxUse(line, { vendor = null } = {}) {
  if (line?.taxUse === 'resale' || line?.taxUse === 'own-use') return line.taxUse;
  const costType = ['material', 'subcontract', 'equipment', 'other'].includes(line?.costType) ? line.costType : 'material';
  if (costType === 'material') return 'resale';
  if (costType === 'subcontract') return vendor?.meSubtrade === true ? 'resale' : 'own-use';
  return 'own-use';
}

/**
 * A tax-inclusive QBO Bill or Purchase to net amounts (4.8): each line's net is its gross minus
 * its share of TotalTax, shared pro rata among the lines whose code carries tax, remainder on the
 * largest. Gross is the line's TaxInclusiveAmt when QBO gives one, else its Amount (VERIFY 11.4).
 * `ref` may carry `province` (Manitoba PST rates become Fishtape's RST).
 * @returns {{ lines: [{ lineId, grossCents, netCents }], taxes: [{ rateId, id, pct, cents }] }}
 */
export function taxInclusiveToNet(qboTxn, ref) {
  const expense = (qboTxn?.Line || []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail' || l.DetailType === 'ItemBasedExpenseLineDetail');
  const detail = (l) => l.AccountBasedExpenseLineDetail || l.ItemBasedExpenseLineDetail || {};
  const gross = expense.map((l) => cents(detail(l).TaxInclusiveAmt ?? l.Amount));
  const carriesTax = (l) => {
    const cid = idOf(detail(l).TaxCodeRef);
    if (!cid) return false;
    const code = findCode(ref, cid);
    if (!code) return !/^(NON|EXEMPT|ZERO|OOS)/i.test(cid) && cid !== '0';
    return purchaseRateIds(code).some((id) => (ratePct(findRate(ref, id), qboTxn?.TxnDate) || 0) > 0);
  };
  const taxedIdx = expense.map((l, i) => (carriesTax(l) ? i : -1)).filter((i) => i >= 0);
  const total = cents(qboTxn?.TxnTaxDetail?.TotalTax ?? 0);
  const shares = share(total, taxedIdx.map((i) => gross[i]));
  const net = gross.slice();
  taxedIdx.forEach((i, j) => { net[i] = gross[i] - shares[j]; });
  const province = ref?.province || null;
  const taxes = (qboTxn?.TxnTaxDetail?.TaxLine || []).filter((l) => !l.DetailType || l.DetailType === 'TaxLineDetail').map((l) => {
    const rateId = idOf(l.TaxLineDetail?.TaxRateRef);
    const rate = findRate(ref, rateId);
    const pct = l.TaxLineDetail?.TaxPercent != null ? Number(l.TaxLineDetail.TaxPercent) : ratePct(rate, qboTxn?.TxnDate);
    return { rateId, id: taxIdForRate(rate, province, pct), pct, cents: cents(l.Amount) };
  }).filter((t) => t.cents);
  return { lines: expense.map((l, i) => ({ lineId: l.Id == null ? null : String(l.Id), grossCents: gross[i], netCents: net[i] })), taxes };
}

const FEDERAL_AGENCY = /canada revenue|receiver general|revenu qu|revenue quebec|\bCRA\b|\bARC\b/i;
const PROVINCIAL_AGENCY = /\b(PST|RST)\b|retail sales|provincial|minist(er|ry) of finance|manitoba|british columbia|saskatchewan/i;

/**
 * True when a purchase code would claim PST/RST as an input credit (4.8): one of its purchase
 * rates is a provincial PST/RST (by the rate's name or its agency). The mappings PUT refuses such
 * a code for a key containing PST or RST.
 */
export function purchaseCodeClaimsPst(code, rates, agencies) {
  for (const id of purchaseRateIds(code)) {
    const rate = (rates || []).find((r) => String(r.Id) === String(id));
    if (!rate || !((Number(rate.RateValue) || 0) > 0)) continue;
    if (/\b(PST|RST)\b/i.test(String(rate.Name || ''))) return true;
    const agency = (agencies || []).find((a) => String(a.Id) === idOf(rate.AgencyRef));
    const name = String(agency?.DisplayName || '');
    if (name && !FEDERAL_AGENCY.test(name) && PROVINCIAL_AGENCY.test(name)) return true;
  }
  return false;
}

/** The percentages a key's components have on a day ('GST' is federal everywhere). */
export function keyPcts(key, { province = null, date = new Date(), purchase = false } = {}) {
  const p = parseTaxKey(key);
  if (p.none) return [];
  const prov = p.province || province;
  const parts = ratesOn(prov, date);
  const gst = ratesOn('AB', date).find((x) => x.id === 'GST');
  const ids = purchase ? p.ids.filter((id) => RECOVERABLE.includes(id)) : p.ids;
  const pcts = ids.map((id) => (parts.find((x) => x.id === id) || (id === 'GST' ? gst : null))?.pct);
  return pcts.some((x) => x == null) ? null : sortNum(pcts);
}

/** True when a QBO code's active rates equal a key's components on a day (mappings PUT, 7.6). */
export function codeMatchesKey(key, code, ref, { province = null, date = new Date(), purchase = false } = {}) {
  if (!code || code.Active === false) return false;
  const want = keyPcts(key, { province, date, purchase });
  if (!want || String(key) === 'TAX') return false;
  const rates = (purchase ? purchaseRateIds(code) : salesRateIds(code)).map((id) => findRate(ref, id));
  if (rates.some((r) => !r || r.Active === false)) return false;
  const have = sortNum(rates.map((r) => ratePct(r, date)).filter((x) => x != null && x > 0));
  if (!samePcts(have, want)) return false;
  return !(purchase && /PST|RST/.test(String(key)) && purchaseCodeClaimsPst(code, ref?.rates, ref?.agencies));
}

const NONE_NAMES = { 'NONE|ZERO': /zero/i, 'NONE|EXEMPT': /exempt/i, 'NONE|OOS': /out of scope/i };

/**
 * Suggested QBO code per key (4.8), by rates and never by name alone: for 'GST+RST|MB' an active
 * code whose rates are exactly an active 5% and an active 7% (so a legacy 8% PST MB code is never
 * picked). No-tax reasons by name ("Zero-rated", "Exempt", "Out of Scope"); NONE|RELIEF and the
 * legacy TAX get no suggestion. With `purchase`, purchase rates and the recoverable part only.
 */
export function suggestTaxCodes(keys, taxCodes, taxRates, { province = null, date = new Date(), purchase = false, agencies = [] } = {}) {
  const ref = { codes: taxCodes || [], rates: taxRates || [], agencies };
  const active = (taxCodes || []).filter((c) => c.Active !== false).sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
  const out = {};
  for (const key of keys || []) {
    const name = NONE_NAMES[key] || (purchase && (key === 'NONE' || key === 'stripeFee') ? /exempt|out of scope|zero/i : null);
    if (name) { out[key] = active.find((c) => name.test(String(c.Name)))?.Id ?? null; continue; }
    if (parseTaxKey(key).none || key === 'TAX' || key === 'stripeFee') { out[key] = null; continue; }
    const fits = active.filter((c) => codeMatchesKey(key, c, ref, { province, date, purchase }));
    const wanted = String(DEFAULT_TAX_CODES[key] || '').toLowerCase();
    out[key] = (fits.find((c) => String(c.Name).toLowerCase() === wanted) || fits[0])?.Id ?? null;
  }
  return out;
}
