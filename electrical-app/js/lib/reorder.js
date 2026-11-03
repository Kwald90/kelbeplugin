// Min/max auto-reorder: turn low stock into draft purchase orders. Pure logic, shared by the
// inventory module and tested on its own. An item is low when its total on hand is below its
// reorderPoint (the minimum); the suggested order quantity brings it back up to maxStock (the
// restock-to level), or to the reorderPoint if no max is set. Suggestions are grouped by the item's
// preferred supplier into one draft PO per supplier; the module gives each PO its number and saves.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Items that need restocking, with how many to order.
 * @param {object[]} items price-book items (with reorderPoint, maxStock, costCents, unit, preferredVendorId)
 * @param {{ onHandTotal: (item)=>number }} o how to total an item's on-hand across locations
 * @returns {{ item, onHand, min, target, need, unitCents, vendorId }[]}
 */
export function reorderSuggestions(items, { onHandTotal }) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const min = num(item.reorderPoint);
    if (min <= 0) continue;                 // no reorder point = not tracked for reorder
    const onHand = num(onHandTotal(item));
    if (onHand >= min) continue;            // at or above the minimum: fine
    const max = num(item.maxStock);
    const target = max > min ? max : min;   // restock to the max, or just back to the minimum
    const need = Math.max(1, Math.round(target - onHand));
    out.push({ item, onHand, min, target, need, unitCents: num(item.costCents), vendorId: item.preferredVendorId || null });
  }
  return out;
}

/** PO lines for a set of suggestions (one line per item). */
export function reorderLines(suggestions) {
  return (suggestions || []).map((s) => ({
    itemId: s.item.id,
    description: s.item.name || 'Item',
    qty: s.need,
    unit: s.item.unit || 'ea',
    unitCents: num(s.unitCents),
    materialRequestIds: [],
  }));
}

/**
 * Group suggestions into one draft order per preferred supplier.
 * @returns {{ vendorId: string|null, lines: object[] }[]} in the order suppliers first appear
 */
export function ordersFromReorder(suggestions) {
  const groups = new Map();
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    const v = s.vendorId || null;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(s);
  }
  return [...groups.entries()].map(([vendorId, list]) => ({ vendorId, lines: reorderLines(list) }));
}
