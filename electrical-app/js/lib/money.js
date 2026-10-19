// Shared document maths. Everything is integer cents; tax is rounded once per document.
//
// A line is { description, qty, unitCents, labourHours, kind: material|labour|other }.
// - line amount = qty * unitCents (price-book prices are sell prices, labour included)
// - markupPct (estimates only, default 0) is an extra uplift on material lines
// - labourHours is crew time per unit, used for scheduling and job costing,
//   not added to the price (add a 'labour' line to charge hours separately)

export function lineCents(l) {
  return Math.round((Number(l.qty) || 0) * (Number(l.unitCents) || 0));
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
  const taxCents = Math.round(subtotalCents * (Number(doc.taxPct) || 0) / 100);
  return { materialCents, labourCents, otherCents, markupCents, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, hours };
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
