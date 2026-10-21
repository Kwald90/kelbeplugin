// Field receiving (docs/releases/r1-get-paid.md 6.6, 8.4; docs/office/job-costing.md): the crew or the
// office record what arrived against a purchase order, without seeing a price. The server writes as
// the system actor `receiving`, the only writer allowed to set stockMoves.unitCostCents and
// items.avgCostCents (access.js restoreServerFields): it raises the PO line's receivedQty, records a
// receive move per line at the PO price, and for material received into a location adds it to that
// location's stock and moves the item's moving average (lib/stock-counts.js movingAverage). Material
// received straight to a job never sits in stock: its cost reaches the job through received-not-billed
// until the supplier's bill arrives (lib/costing.js).
import { ApiError, notFound } from '../errors.js';
import { appendAudit } from './audit.js';
import { systemPrincipal } from '../integrations/state.js';
import { openReceiptLines, receiveLines, poOpen } from '../../../electrical-app/js/lib/purchasing.js';
import { movingAverage, onHandTotal } from '../../../electrical-app/js/lib/stock-counts.js';
import { dayIn, zoneFor } from '../../../electrical-app/js/lib/closing.js';

const MAX_QTY = 1_000_000;
const row = async (tx, table, id, { lock = false } = {}) => {
  const { rows } = await tx.query(`SELECT id, data FROM ${table} WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [tx.tenantId, id]);
  return rows[0] ? { ...rows[0].data, id: rows[0].id } : null;
};

/** Open PO lines to receive (quantities only), for a job, a location's stock orders, or everything. */
export async function receivingLines(tx, { jobId = null, locationId = null } = {}) {
  const { rows } = await tx.query("SELECT id, data FROM purchase_orders WHERE tenant_id = $1 AND deleted_at IS NULL AND status IN ('open', 'sent') LIMIT 2000", [tx.tenantId]);
  const pos = rows.map((r) => ({ ...r.data, id: r.id }));
  const lines = openReceiptLines(pos, { jobId, stockOnly: Boolean(locationId) && !jobId });
  const vendorIds = [...new Set(lines.map((l) => l.vendorId).filter(Boolean))];
  const names = new Map();
  if (vendorIds.length) {
    const v = await tx.query("SELECT id, data->>'name' AS name FROM vendors WHERE tenant_id = $1 AND id = ANY($2)", [tx.tenantId, vendorIds]);
    for (const r of v.rows) names.set(r.id, r.name);
  }
  return lines.map(({ vendorId, ...l }) => ({ ...l, supplier: names.get(vendorId) || null }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }) || a.index - b.index);
}

/**
 * Receive lines of a purchase order: { lines: [{ index, qty }], toLocationId?, jobId? }. Without a
 * location the material goes to the line's job (or the given job). Returns quantities only.
 * @param {object} p the person receiving (their name goes on the moves and the audit)
 */
export async function receive(tx, records, p, poId, body, { request = {} } = {}) {
  const po = await row(tx, 'purchase_orders', poId, { lock: true });
  if (!po) throw notFound('No such purchase order.');
  if (!poOpen(po)) throw new ApiError(409, 'po_not_open', `${po.number || 'This order'} is ${po.status || 'a draft'}: only placed orders are received.`);
  const toLocationId = body.toLocationId || null;
  if (toLocationId && body.jobId) throw new ApiError(422, 'one_destination', 'Receive into a location or onto a job, not both.');
  const location = toLocationId ? await row(tx, 'locations', toLocationId) : null;
  if (toLocationId && !location) throw new ApiError(422, 'no_location', 'That location does not exist.');
  if (body.jobId && !(await row(tx, 'jobs', body.jobId))) throw new ApiError(422, 'no_job', 'That job does not exist.');
  const seen = new Set();
  for (const l of body.lines) {
    if (seen.has(l.index)) throw new ApiError(422, 'duplicate_line', `Line ${l.index + 1} is listed twice.`);
    seen.add(l.index);
    const pl = po.lines?.[l.index];
    if (!pl) throw new ApiError(422, 'no_line', `There is no line ${l.index + 1} on ${po.number || 'this order'}.`);
    if (!(l.qty > 0) || l.qty > MAX_QTY) throw new ApiError(422, 'bad_qty', 'Receive a quantity above zero.');
    if (toLocationId && !pl.itemId) throw new ApiError(422, 'no_item', `Line ${l.index + 1} (${pl.description || 'no description'}) is not a price-book item, so it can't go into stock. Receive it onto the job.`);
    if (!toLocationId && !body.jobId && !(pl.jobId || po.jobId)) throw new ApiError(422, 'no_destination', `Line ${l.index + 1} has no job: pick the location it goes into.`);
  }

  const zone = zoneFor((await tx.query("SELECT data->'company'->>'province' AS p FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId])).rows[0]?.p);
  const now = new Date().toISOString();
  const today = dayIn(now, zone);
  const who = p.actor?.label || 'the crew';
  const sys = systemPrincipal(tx.tenantId, 'receiving', 'Field receiving');
  const sysWho = { actor: { type: 'system', id: 'receiving', label: `Received by ${who}` }, request };
  const { lines: newLines, error } = receiveLines(po, body.lines, now);
  if (error) throw new ApiError(422, 'bad_line', error);

  const moveIds = [];
  const items = new Map();
  for (const l of body.lines) {
    const pl = po.lines[l.index];
    const jobId = toLocationId ? null : body.jobId || pl.jobId || po.jobId;
    const move = await records.createRecord(tx, sys, 'stockMoves', {
      itemId: pl.itemId || null, fromLocationId: null, toLocationId, jobId, qty: l.qty, use: 'receive', date: today,
      poId: po.id, poLineIndex: l.index, unitCostCents: Number.isInteger(pl.unitCents) ? pl.unitCents : 0, costCodeId: pl.costCodeId || null,
      note: `${po.number || 'PO'} line ${l.index + 1}, received by ${who}`,
    }, sysWho);
    moveIds.push(move.id);
    if (toLocationId) {
      const it = items.get(pl.itemId) || await row(tx, 'items', pl.itemId, { lock: true });
      if (!it) throw new ApiError(422, 'no_item', `The price-book item on line ${l.index + 1} no longer exists.`);
      const avg = movingAverage(onHandTotal(it), it.avgCostCents ?? it.costCents ?? null, l.qty, pl.unitCents ?? 0);
      const stock = { ...(it.stock || {}) };
      stock[toLocationId] = Math.round(((Number(stock[toLocationId]) || 0) + l.qty) * 1000) / 1000;
      items.set(pl.itemId, { ...it, stock, avgCostCents: avg });
    }
  }
  for (const it of items.values()) {
    await records.patchRecord(tx, sys, 'items', it.id, { stock: it.stock, avgCostCents: it.avgCostCents }, null, sysWho);
  }
  await records.patchRecord(tx, sys, 'purchaseOrders', po.id, { lines: newLines }, null, sysWho);
  await appendAudit(tx, tx.tenantId, {
    actor: p.actor, action: 'receiving.receive', collection: 'purchaseOrders', recordId: po.id,
    summary: `${po.number || 'PO'}: ${body.lines.map((l) => `line ${l.index + 1} x ${l.qty}`).join(', ')}${location ? ` into ${location.name || 'a location'}` : ' onto the job'}`.slice(0, 300),
    request,
  });
  return {
    poId: po.id, number: po.number || '', moveIds,
    lines: newLines.map((l, index) => ({ index, description: l.description || '', ordered: Number(l.qty) || 0, received: Number(l.receivedQty) || 0, over: (Number(l.receivedQty) || 0) > (Number(l.qty) || 0) })),
  };
}
