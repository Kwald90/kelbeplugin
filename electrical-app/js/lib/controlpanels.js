// Control panels (industrial / controls work: panel shops, PLC jobs). One record documents a
// built control panel: a header (tag, enclosure, voltage, SCCR, job), a components list that rolls
// up into a bill of materials, an I/O list (AI/AO/DI/DO points to the field devices and PLC
// addresses), a terminal/wiring schedule, and a nameplate/engraving schedule. The whole thing
// prints as a shop package. Money is in cents, like the rest of the app (lib/money.js).
// Pure logic, shared by the module (js/modules/controlpanels.js) and its tests.

const newId = (p) => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

export const MAX_COMPONENTS = 300;
export const MAX_IO = 1000;
export const MAX_WIRES = 2000;
export const MAX_NAMEPLATES = 300;

/** I/O point kinds. `label` is the long form for print; order is the shop convention (discrete first). */
export const IO_TYPES = [
  { id: 'DI', label: 'Digital input' },
  { id: 'DO', label: 'Digital output' },
  { id: 'AI', label: 'Analog input' },
  { id: 'AO', label: 'Analog output' },
];
export const IO_TYPE_IDS = IO_TYPES.map((t) => t.id);
export const ioTypeOf = (id) => IO_TYPES.find((t) => t.id === id) || null;

/** Common enclosure ratings for the header dropdown (NEMA / type ratings used in Canada). */
export const ENCLOSURE_TYPES = ['NEMA 1', 'NEMA 3R', 'NEMA 4', 'NEMA 4X', 'NEMA 12', 'NEMA 7/9'];

/** A blank control-panel record, optionally tied to a job. */
export function newPanel({ name = '', tag = '', job = null, by = null } = {}) {
  return {
    id: newId('cp'),
    name: String(name || '').slice(0, 200),
    tag: String(tag || '').slice(0, 80),
    enclosureType: '',
    enclosureRating: '',
    systemVoltage: '',
    sccr: '',
    jobId: job?.id || null,
    clientId: job?.clientId || null,
    components: [],
    io: [],
    wiring: [],
    nameplates: [],
    notes: '',
    createdBy: by || null,
  };
}

/** A BOM component line from a price-book item (material cost per unit), or blank. */
export function newComponent(item = null) {
  return {
    id: newId('cmp'),
    itemId: item?.id || null,
    part: item?.sku || '',
    description: item?.name || '',
    manufacturer: item?.manufacturer || '',
    qty: 1,
    // Material cost per unit, cents. Prefer the item's cost; fall back to its sell price.
    unitCents: item ? (item.costCents ?? item.priceCents ?? 0) : 0,
  };
}

/** A blank I/O point. */
export function newIoPoint(type = 'DI') {
  return { id: newId('io'), tag: '', type: IO_TYPE_IDS.includes(type) ? type : 'DI', description: '', device: '', terminal: '', address: '' };
}

/** A blank terminal / wiring-schedule row. */
export function newWire() {
  return { id: newId('w'), wire: '', from: '', to: '', gauge: '', colour: '', terminal: '' };
}

/** A blank nameplate / engraving-schedule row. */
export function newNameplate() {
  return { id: newId('np'), item: '', legend: '', size: '', colour: '' };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Extended material cost of one BOM line, cents (qty x unit). */
export const componentCostCents = (c) => Math.round(Math.max(0, num(c?.qty)) * Math.max(0, num(c?.unitCents)));

/** BOM roll-up: line count, total pieces and total material cost (cents). */
export function bomTotals(panel) {
  const lines = (panel?.components || []);
  return {
    lineCount: lines.length,
    totalQty: lines.reduce((s, c) => s + Math.max(0, num(c.qty)), 0),
    materialCents: lines.reduce((s, c) => s + componentCostCents(c), 0),
  };
}

/** I/O point counts by type, plus the total. */
export function ioCounts(panel) {
  const out = { DI: 0, DO: 0, AI: 0, AO: 0, total: 0 };
  for (const p of panel?.io || []) {
    if (Object.hasOwn(out, p.type)) out[p.type] += 1;
    out.total += 1;
  }
  return out;
}

/** Explode the BOM into estimate/invoice material lines (qty x unit cents), tagging the panel. */
export function estimateLines(panel) {
  return (panel?.components || [])
    .filter((c) => Math.max(0, num(c.qty)) > 0)
    .map((c) => ({
      itemId: c.itemId || null,
      description: [c.part, c.description].filter(Boolean).join(' — ') || 'Panel component',
      qty: Math.max(0, num(c.qty)),
      unitCents: Math.max(0, Math.round(num(c.unitCents))),
      kind: 'material',
      controlPanelId: panel?.id || null,
    }));
}

export const panelLabel = (p) => [p?.tag, p?.name].filter(Boolean).join(' · ') || p?.name || p?.tag || 'Control panel';

export { newId };
