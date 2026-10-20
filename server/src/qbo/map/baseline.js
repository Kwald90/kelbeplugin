// The first snapshot of a pair the wizard links (docs/integrations/quickbooks.md 6.4). Pure.
//
// A wizard link has no history, so the snapshot is built field by field from L and R and the
// first reconcile never overwrites anything silently:
//   - equal: that value;
//   - one side empty: B = the empty side, so the first reconcile copies the value to it (a QBO
//     customer with no phone gets Fishtape's phone, never the reverse);
//   - both set and different, customers, vendors, items and jobs: the person picks a side in the
//     Review step; B = the value not chosen, so the first reconcile writes the chosen one;
//   - estimates and invoices: lines that agree in amounts and tax codes (as multisets) with totals
//     and per-rate tax within 2 cents count as equal (B = L, remoteAlias = R's hash); anything else
//     that differs links the document in needs_review (wizard_differs) with B = R, so nothing is
//     written until a person resolves it;
//   - payments: as documents, plus a net-of-fee amount and the date (payments are paired with
//     dates ignored) kept apart through remoteAlias.
import { canonEqual, compareKey } from './canon.js';
import { fieldsOf, fieldClass, aliasHash, displayValue } from './merge.js';

const DOCS = new Set(['estimates', 'invoices', 'bills']);

function isEmpty(collection, field, v) {
  const k = compareKey(collection, field, v);
  return k === null || (Array.isArray(k) && k.length === 0);
}

/** Lines that agree as multisets of { amountCents, taxCodeId }, with totals and per-rate tax within 2 cents. */
export function linesEquivalent(L, R) {
  const a = (L?.lines || []).map((l) => `${l.amountCents}|${l.taxCodeId ?? ''}`).sort();
  const b = (R?.lines || []).map((l) => `${l.amountCents}|${l.taxCodeId ?? ''}`).sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
  const lt = L?.extra?.totalCents, rt = R?.extra?.totalCents;
  if (lt != null && rt != null && Math.abs(lt - rt) > 2) return false;
  const lTax = (L?.extra?.taxes || []).filter((t) => t.cents);
  const rTax = (R?.extra?.taxLines || []).filter((t) => t.cents);
  for (const t of lTax) {
    const q = rTax.find((x) => x.pct != null && Math.abs(Number(x.pct) - Number(t.pct)) < 0.0005);
    if (!q || Math.abs(q.cents - t.cents) > 2) return false;
  }
  return true;
}

/**
 * @param {string} collection
 * @param {object} L Fishtape canonical form
 * @param {object} R QBO canonical form
 * @param {{ [field]: 'fishtape'|'quickbooks' }} [fieldChoices]
 * @returns {{ snapshot, remoteAlias, needsChoice: string[], differs: boolean, diffs: { field, fishtape, quickbooks }[] }}
 *   differs: the document or payment must be linked in needs_review (wizard_differs), owner quickbooks.
 *   needsChoice: fields of a customer, supplier, item or job still waiting for a side (apply is refused).
 */
export function wizardBaseline(collection, L, R, fieldChoices = {}) {
  const snapshot = {};
  const remoteAlias = {};
  const needsChoice = [];
  const diffs = [];
  let differs = false;
  const doc = DOCS.has(collection);
  const pay = collection === 'payments';
  for (const f of fieldsOf(collection)) {
    const lv = L?.[f] ?? null, rv = R?.[f] ?? null;
    if (canonEqual(collection, f, lv, rv)) { snapshot[f] = lv; continue; }
    diffs.push({ field: f, fishtape: displayValue(collection, f, lv), quickbooks: displayValue(collection, f, rv) });
    const cls = fieldClass(collection, f);
    if (cls === 'pushOnly') { snapshot[f] = isEmpty(collection, f, rv) ? rv : lv; continue; }
    const lEmpty = isEmpty(collection, f, lv), rEmpty = isEmpty(collection, f, rv);
    if (lEmpty !== rEmpty) { snapshot[f] = lEmpty ? lv : rv; continue; }
    if (doc) {
      if (f === 'lines' && linesEquivalent(L, R)) { snapshot[f] = lv; remoteAlias[f] = aliasHash(collection, f, rv); continue; }
      differs = true; snapshot[f] = rv; continue;
    }
    if (pay) {
      const fee = Number(L?.extra?.feeCents) || 0;
      const net = f === 'amountCents' && L?.extra?.source === 'stripe' && fee > 0 && lv - fee === rv;
      if (net || f === 'date' || cls === 'auto') { snapshot[f] = lv; remoteAlias[f] = aliasHash(collection, f, rv); continue; }
      differs = true; snapshot[f] = rv; continue;
    }
    const choice = fieldChoices?.[f];
    if (choice === 'fishtape') snapshot[f] = rv;
    else if (choice === 'quickbooks') snapshot[f] = lv;
    else { needsChoice.push(f); snapshot[f] = lv; }
  }
  if (L?.extra !== undefined) snapshot.extra = L.extra;
  return { snapshot, remoteAlias, needsChoice, differs, diffs };
}
