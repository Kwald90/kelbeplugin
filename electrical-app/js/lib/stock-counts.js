// Inventory cost and count sheets (docs/releases/r1-get-paid.md 8.4, docs/office/month-end.md).
// Pure, no DOM: the Inventory screen, month-end, the receiving route on the server and the tests use it.
//
// Cost method: moving weighted average (items.avgCostCents), updated on each receipt from a supplier by
// the server's receiving route: (on hand x average + qty x unit cost) / (on hand + qty). Issue moves are
// stamped at the average by the server. Items never received through a purchase order use their
// catalogue cost (costCents).
//
// Stock on hand lives on the item (items.stock { [locationId]: qty }, kept by the screens that record
// moves). The quantity at an earlier moment is today's stock with the moves after it rolled back.
// A count sheet lists what should be at a location; posting it makes one adjustment move per
// difference, counted against the quantity at the moment of counting (countedAt), so van moves made
// while people counted do not skew it. Adjustments are never own use.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = (v) => (Number.isInteger(v) ? v : null);
const round3 = (n) => Math.round(n * 1000) / 1000;

export const COUNT_STATUSES = ['draft', 'counted', 'posted', 'void'];
export const COUNT_STATUS_LABEL = { draft: 'Counting', counted: 'Counted', posted: 'Posted', void: 'Void' };
export const MAX_COUNT_LINES = 2000;

/** New moving average after receiving `qty` at `unitCents` onto `onHand` valued at `avgCents`. */
export function movingAverage(onHand, avgCents, qty, unitCents) {
  const have = num(onHand), q = num(qty), unit = num(unitCents);
  if (!(q > 0)) return int(avgCents) ?? Math.round(unit);
  if (!(have > 0) || avgCents == null) return Math.round(unit);
  return Math.round((have * num(avgCents) + q * unit) / (have + q));
}

/** Total on hand of an item across locations. */
export const onHandTotal = (item) => Object.values(item?.stock || {}).reduce((s, n) => s + num(n), 0);

/** The moment of a move for ordering and cut-offs: its createdAt, else the end of its date. */
const moveTime = (m) => String(m?.createdAt || (m?.date ? `${m.date}T23:59:59.999Z` : ''));
const moveDay = (m) => String(m?.date || m?.createdAt || '').slice(0, 10);

/**
 * Is the move after `at`? A day (YYYY-MM-DD) compares with the move's date; a timestamp with its
 * createdAt (a move recorded after the count was taken).
 */
function isAfter(m, at) {
  if (!at) return false;
  return String(at).length > 10 ? moveTime(m) > String(at) : moveDay(m) > String(at).slice(0, 10);
}

/** A move's effect on one location's quantity. */
function deltaAt(m, locationId) {
  let d = 0;
  if (m?.toLocationId === locationId) d += num(m.qty);
  if (m?.fromLocationId === locationId) d -= num(m.qty);
  return d;
}

/** Quantity of an item at a location at `at` (a day or a timestamp): stock now less the moves after it. */
export function qtyAt(item, locationId, stockMoves = [], at = null, { except = null } = {}) {
  let q = num(item?.stock?.[locationId]);
  if (!at) return round3(q);
  for (const m of stockMoves) {
    if (m?.itemId !== item?.id || (except && except(m)) || !isAfter(m, at)) continue;
    q -= deltaAt(m, locationId);
  }
  return round3(q);
}

/**
 * The item's moving average as of a day: receipts into stock (use 'receive' with a unit cost and a
 * location) replayed in order up to `asOf`, starting from the catalogue cost. Without receipts, the
 * server's average or the catalogue cost.
 */
export function avgCostAsOf(item, stockMoves = [], asOf = null) {
  const receipts = stockMoves.filter((m) => m?.itemId === item?.id && m.use === 'receive' && m.toLocationId && int(m.unitCostCents) != null)
    .sort((a, b) => moveTime(a).localeCompare(moveTime(b)));
  if (!receipts.length) return int(item?.avgCostCents) ?? int(item?.costCents) ?? 0;
  const mine = stockMoves.filter((m) => m?.itemId === item?.id).sort((a, b) => moveTime(a).localeCompare(moveTime(b)));
  // Total on hand before every move: today's total less all of them, then forward.
  const net = (m) => (m.toLocationId && !m.fromLocationId ? num(m.qty) : m.fromLocationId && !m.toLocationId ? -num(m.qty) : 0);
  let total = onHandTotal(item) - mine.reduce((s, m) => s + net(m), 0);
  let avg = int(item?.costCents);
  for (const m of mine) {
    if (asOf && isAfter(m, asOf)) break;
    if (m.use === 'receive' && m.toLocationId && int(m.unitCostCents) != null) avg = movingAverage(total, avg, m.qty, m.unitCostCents);
    total += net(m);
  }
  return avg ?? 0;
}

/**
 * Inventory value by location as of a day: quantity there then (today's stock with later moves rolled
 * back) × the average as of then. Month-end uses it.
 * @returns {Array<{ locationId, name, kind, valueCents, lines: Array<{ itemId, name, qty, avgCents, valueCents }> }>}
 */
export function valuationByLocation({ items = [], stockMoves = [], locations = [], asOf = null } = {}) {
  return locations.map((loc) => {
    const lines = [];
    for (const it of items) {
      const qty = qtyAt(it, loc.id, stockMoves, asOf);
      if (!qty) continue;
      const avgCents = avgCostAsOf(it, stockMoves, asOf);
      lines.push({ itemId: it.id, name: it.name || '', qty, avgCents, valueCents: Math.round(qty * avgCents) });
    }
    lines.sort((a, b) => a.name.localeCompare(b.name));
    return { locationId: loc.id, name: loc.name || '', kind: loc.kind || '', valueCents: lines.reduce((s, l) => s + l.valueCents, 0), lines };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A new count sheet for a location: every item with stock there (all items with `all`), with the
 * quantity expected now. People fill countedQty on the phone (offline).
 */
export function countSheet({ items = [], locationId, date, all = false, note = '' } = {}) {
  const lines = items.filter((it) => all || num(it?.stock?.[locationId]) !== 0)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, MAX_COUNT_LINES)
    .map((it) => ({ itemId: it.id, expectedQty: round3(num(it?.stock?.[locationId])), countedQty: null }));
  return { locationId, date, status: 'draft', lines, countedBy: null, countedAt: null, postedAt: null, postedBy: null, moveIds: [], note };
}

/** Lines counted so far, and how many differ from what was expected. */
export function countProgress(count) {
  const lines = count?.lines || [];
  const counted = lines.filter((l) => l.countedQty != null && l.countedQty !== '');
  return { lines: lines.length, counted: counted.length, differ: counted.filter((l) => round3(num(l.countedQty)) !== round3(num(l.expectedQty))).length };
}

/**
 * The adjustment moves posting a count makes: counted minus the location's quantity at countedAt
 * (stock now minus moves recorded after it, leaving out this count's own adjustments). One move per
 * difference, use 'adjust', dated the count date. Lines not counted are left alone.
 * @returns {Array<{ itemId, diff, move }>}
 */
export function countAdjustments(count, { items = [], stockMoves = [] } = {}) {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const loc = count?.locationId;
  const out = [];
  for (const l of count?.lines || []) {
    if (l.countedQty == null || l.countedQty === '') continue;
    const it = itemById.get(l.itemId);
    if (!it) continue;
    const have = qtyAt(it, loc, stockMoves, count.countedAt || null, { except: (m) => m.countId === count.id });
    const diff = round3(num(l.countedQty) - have);
    if (!diff) continue;
    out.push({
      itemId: it.id, diff,
      move: {
        itemId: it.id, qty: Math.abs(diff), use: 'adjust', countId: count.id || null, date: count.date || null, jobId: null,
        fromLocationId: diff < 0 ? loc : null, toLocationId: diff > 0 ? loc : null,
        note: `Count ${count.date || ''}: counted ${round3(num(l.countedQty))}, expected ${have}`.trim(),
      },
    });
  }
  return out;
}

/** What stops a count being posted: [message]. */
export function countProblems(count) {
  const out = [];
  if (!count?.locationId) out.push('Pick the location.');
  if (!(count?.lines || []).length) out.push('The sheet has no lines.');
  if (count?.status === 'posted') out.push('This count is already posted.');
  if (count?.status === 'void') out.push('This count is void.');
  if (!countProgress(count).counted) out.push('Nothing has been counted yet.');
  if ((count?.lines || []).some((l) => l.countedQty != null && l.countedQty !== '' && !(num(l.countedQty) >= 0))) out.push('A counted quantity is negative.');
  return out;
}
