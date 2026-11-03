// Supplier price-list import. Distributors (EECOL, Westburne, …) give account holders a price file
// — your negotiated costs — as CSV/Excel-exported CSV. This parses it, maps its columns, matches
// rows to price-book items by part number, and plans cost updates (and optional new items). Pure
// logic, shared by the module and tests; the module applies the plan to the `items` collection.
//
// This is the buildable-today path. Live ordering (PunchOut/cXML, EDI) needs the distributor to
// enable it for the account — a connector can sit on top of this later.

/** Parse CSV text into { headers, rows } (handles quotes, commas, CRLF). rows are string[]. */
export function parseCsv(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const all = [];
  let field = '';
  let row = [];
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); all.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); all.push(row); }
  const clean = all.filter((r) => r.some((c) => String(c).trim() !== ''));
  const headers = clean.length ? clean[0].map((h) => String(h).trim()) : [];
  return { headers, rows: clean.slice(1) };
}

/** $1,234.56 / "1234.56" -> 123456 cents. Null for blank/unparseable. */
export function parseMoneyCents(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Guess which column is which from the header names. Returns indices (or -1). */
export function guessMapping(headers) {
  const find = (re, avoid) => headers.findIndex((h) => re.test(h) && !(avoid && avoid.test(h)));
  const sku = find(/sku|part\s*(no|#|number)?|cat(alog)?\.?\s*(no|#)?|item\s*(no|#)/i);
  const description = find(/desc|name|product/i);
  // Prefer a "cost"/"net" column over a "list"/"sell"/"MSRP" one.
  let cost = find(/\b(net|cost)\b/i);
  if (cost < 0) cost = find(/price/i, /list|sell|msrp|retail/i);
  const price = find(/list|sell|msrp|retail/i);
  return { sku, description, cost, price };
}

/**
 * Plan the update: match each row to a price-book item by part number (its sku or a stored
 * supplierSku), and work out the new cost. Returns matched updates and unmatched rows.
 * @param {{ rows: string[][], mapping: {sku:number,description:number,cost:number,price:number}, items: object[] }} args
 */
export function planUpdate({ rows, mapping, items }) {
  const bySku = new Map();
  for (const it of items || []) {
    if (it.sku) bySku.set(norm(it.sku), it);
    if (it.supplierSku) bySku.set(norm(it.supplierSku), it);
  }
  const at = (r, i) => (i >= 0 ? r[i] : undefined);
  const matched = [];
  const unmatched = [];
  let skipped = 0;
  for (const r of rows) {
    const sku = String(at(r, mapping.sku) ?? '').trim();
    const costCents = parseMoneyCents(at(r, mapping.cost));
    const description = String(at(r, mapping.description) ?? '').trim();
    const priceCents = mapping.price >= 0 ? parseMoneyCents(at(r, mapping.price)) : null;
    if (!sku || costCents == null) { skipped++; continue; }
    const item = bySku.get(norm(sku));
    if (item) matched.push({ id: item.id, name: item.name, sku, oldCostCents: item.costCents ?? null, costCents, priceCents, changed: (item.costCents ?? null) !== costCents });
    else unmatched.push({ sku, description, costCents, priceCents });
  }
  return { matched, unmatched, skipped, changedCount: matched.filter((m) => m.changed).length };
}

export const summarize = (plan) => `${plan.matched.length} matched (${plan.changedCount} price changes), ${plan.unmatched.length} new, ${plan.skipped} skipped`;
