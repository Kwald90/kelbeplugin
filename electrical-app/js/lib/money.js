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

export function docTotals(doc) {
  const lines = doc.lines || [];
  let materialCents = 0, labourCents = 0, otherCents = 0, hours = 0;
  for (const l of lines) {
    const c = lineCents(l);
    if (l.kind === 'labour') labourCents += c;
    else if (l.kind === 'other') otherCents += c;
    else materialCents += c;
    hours += (Number(l.qty) || 0) * (Number(l.labourHours) || 0);
  }
  const markupCents = Math.round(materialCents * (Number(doc.markupPct) || 0) / 100);
  const subtotalCents = materialCents + labourCents + otherCents + markupCents;
  // Markup is part of the material price, so it is taxed like materials.
  const base = { material: materialCents + markupCents, labour: labourCents, other: otherCents };
  const taxes = docTaxes(doc).map((t) => {
    const applies = t.applies || { material: true, labour: true, other: true };
    const baseCents = KINDS.reduce((s, k) => s + (applies[k] ? base[k] : 0), 0);
    return { id: t.id, label: t.label, pct: Number(t.pct) || 0, baseCents, cents: pctOfCents(baseCents, t.pct), note: t.note || '' };
  });
  const taxCents = taxes.reduce((s, t) => s + t.cents, 0);
  return { materialCents, labourCents, otherCents, markupCents, subtotalCents, taxes, taxCents, totalCents: subtotalCents + taxCents, hours };
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

/** Status for display: stored status, but 'overdue' when sent/partial and past due. */
export function invoiceStatus(store, inv) {
  if (inv.status === 'void' || inv.status === 'draft') return inv.status;
  const bal = invoiceBalanceCents(store, inv);
  if (bal <= 0) return 'paid';
  const due = inv.dueDate && new Date(inv.dueDate + 'T23:59:59') < new Date();
  if (due) return 'overdue';
  return invoicePaidCents(store, inv.id) > 0 ? 'partial' : inv.status;
}

/** Hours worked on a time entry (open entries count up to now). */
export function entryHours(e, now = new Date()) {
  if (!e.clockIn) return 0;
  const end = e.clockOut ? new Date(e.clockOut) : now;
  const mins = (end - new Date(e.clockIn)) / 60000 - (Number(e.breakMins) || 0);
  return Math.max(0, mins / 60);
}
