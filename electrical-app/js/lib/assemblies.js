// Assembly-based estimating. An assembly is a reusable kit an estimator counts: e.g. "duplex
// receptacle" = box + device + plate + cover + wire + connectors, plus a labour value (hours per
// unit, the electrical "labour unit"). Counting 40 receptacles explodes into priced material lines
// and a labour line, so bids are fast and defensible.
//
// Money model (see lib/money.js): a line's price is qty x unitCents; labourHours on a line is for
// scheduling/costing only and is NOT priced. So component prices here are MATERIAL ONLY, and the
// labour is charged by a separate 'labour' line at the estimate's labour rate. Material markup
// (estimates) still uplifts the material line. Pure logic, shared by the module and its tests.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const MAX_COMPONENTS = 60;

/** A blank assembly. */
export function newAssembly({ name = '', category = '', by = null } = {}) {
  return {
    id: newId('asm'),
    name: String(name || '').slice(0, 200),
    category: String(category || '').slice(0, 80),
    description: '',
    unit: 'each',
    components: [],
    labourHours: 0,
    archived: false,
    createdBy: by || null,
  };
}

/** A component line from a price-book item (material cost per unit), or blank. */
export function newComponent(item = null) {
  return {
    id: newId('cmp'),
    itemId: item?.id || null,
    sku: item?.sku || '',
    description: item?.name || '',
    qty: 1,
    // Material cost per unit. Prefer the item's cost; fall back to its sell price.
    unitCents: item ? (item.costCents ?? item.priceCents ?? 0) : 0,
  };
}

/** Total material cost for one unit of the assembly (sum of its components). */
export function materialUnitCents(a) {
  return (a?.components || []).reduce((sum, c) => sum + Math.round((Number(c.qty) || 0) * (Number(c.unitCents) || 0)), 0);
}

/** Labour hours for one unit. */
export const labourUnitHours = (a) => Number(a?.labourHours) || 0;

/**
 * Explode an assembly at a count into estimate/invoice lines: one material line (priced,
 * carrying labour hours for scheduling) and, when the assembly has labour and a rate is given,
 * one labour line priced at that rate. Lines carry assemblyId so they can be traced back.
 */
export function explodeAssembly(a, count = 1, { labourRateCents = 0 } = {}) {
  const n = Math.max(0, Number(count) || 0);
  const matUnit = materialUnitCents(a);
  const hours = labourUnitHours(a);
  const name = a?.name || 'Assembly';
  const lines = [{ itemId: null, description: name, qty: n, unitCents: matUnit, labourHours: hours, kind: 'material', assemblyId: a?.id || null }];
  if (hours > 0 && labourRateCents > 0) {
    lines.push({ itemId: null, description: `${name} — labour`, qty: round2(hours * n), unitCents: Math.round(labourRateCents), labourHours: 0, kind: 'labour', assemblyId: a?.id || null });
  }
  return lines;
}

/** Sell estimate for one unit at a labour rate and material markup, for the library preview. */
export function unitSellCents(a, { labourRateCents = 0, markupPct = 0 } = {}) {
  const mat = materialUnitCents(a);
  const material = Math.round(mat * (1 + (Number(markupPct) || 0) / 100));
  const labour = Math.round(labourUnitHours(a) * (Number(labourRateCents) || 0));
  return { materialCents: material, labourCents: labour, totalCents: material + labour };
}

/** Assemblies in the library, newest first, optionally including archived ones. */
export function activeAssemblies(list, { includeArchived = false } = {}) {
  return (list || []).filter((a) => includeArchived || !a.archived);
}

export const assemblyLabel = (a) => a?.name || 'Assembly';
